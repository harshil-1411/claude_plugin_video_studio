import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { readFile } from "node:fs/promises";
import { hashFile, projectPaths, resolveInsideProject, writeJsonAtomic } from "@video-studio/core";
import { type TimedWord, applyGlossary, ffprobe, glossaryPrompt, groupSentences, runFfmpeg, whisperTranscribe } from "@video-studio/media";
import { ContentIR, FormatGrammar, type IrAsset } from "@video-studio/schema";
import { loadProjectGlossary } from "./glossary.js";
import { type SpeechPacing, measureSpeechPacing, pacingLimits } from "./speech-pacing.js";
import { applyTranscript, findMediaAsset, loadContentIr, loadTranscriptWords, planWhisperModel } from "./transcribe.js";

/**
 * tighten: transcript-driven cleanup of talking-head footage. Long pauses are shortened, filler
 * words (um, uh, …) are cut, and false starts / retakes are dropped (a sentence whose opening
 * words are said again right after, or an explicit "let me start again"). A dry run returns the
 * edit list for review; `apply` writes a tightened copy as a NEW asset (the original is never
 * changed) with its transcript re-timed and its own evidence refs, ready for shorts or a
 * talking-head spec. Conservative by design: when in doubt, keep.
 */

export const FILLERS: ReadonlySet<string> = new Set(["um", "umm", "uh", "uhh", "uhm", "erm", "er", "ah", "hmm", "mm", "mhm"]);
/** Explicit retake phrases: the sentence containing one is dropped. */
const RETAKE_MARKERS = /\b(?:let me (?:start|try|say|do) (?:that |this |it )?(?:again|over)|let me rephrase|scratch that|start (?:that )?over|one more time|sorry,? (?:let me|i mean))\b/i;
/** Audio fade at every join, so cuts do not click. */
const JOIN_FADE_MS = 15;
/** Kept segments shorter than this are dropped (they would flash). */
const MIN_KEEP_MS = 120;

export interface TightenOptions {
  /** Shorten pauses longer than max_pause_ms (default true). */
  silences?: boolean;
  /** Cut filler words (default true). */
  fillers?: boolean;
  /** Drop false starts and explicit retakes (default true). */
  retakes?: boolean;
  /** Pauses longer than this are shortened to keep_pause_ms (default 700). */
  max_pause_ms?: number;
  /** What a shortened pause keeps (default 300). */
  keep_pause_ms?: number;
  /** Write the tightened asset; without it, only the edit list is returned (dry run). */
  apply?: boolean;
  /**
   * Learn the pause limits from the user's own pacing: a project-relative `analysis.json`
   * (analyze output with `speech_pacing`) or a ContentIR video/audio asset id (measured now).
   * See {@link pacingLimits}; explicit max_pause_ms / keep_pause_ms still win.
   */
  pacing_from?: string;
  /** Apply even though a join cuts inside a word (`partial_word`). */
  force?: boolean;
}

/** Injected for tests: the whisper run used to re-check joins, and the environment for model lookup. */
export interface TightenDeps {
  env?: Record<string, string | undefined>;
  whisperBin?: string;
  /** Transcribe `range` of `mediaPath` (words on the file's timeline). Default: whisper.cpp with the project's model. */
  whisper?: (mediaPath: string, range: { start_ms: number; end_ms: number }) => Promise<TimedWord[]>;
}

export type CutReason = "silence" | "filler" | "retake";

export interface EditCut {
  start_ms: number;
  end_ms: number;
  reason: CutReason;
  text?: string;
}

export interface EditPlan {
  cuts: EditCut[];
  keep: Array<{ start_ms: number; end_ms: number }>;
  source_ms: number;
  result_ms: number;
}

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");

/** Pure: the cuts and kept ranges for a transcript over a media file of `durationMs`. */
export function planTighten(words: readonly TimedWord[], durationMs: number, opts: TightenOptions = {}): EditPlan {
  const maxPause = opts.max_pause_ms ?? 700;
  const keepPause = Math.min(opts.keep_pause_ms ?? 300, maxPause);
  const cuts: EditCut[] = [];
  const dropped = new Set<number>();

  if (opts.retakes !== false) {
    const sentences = groupSentences(words);
    sentences.forEach((s, i) => {
      // Fillers do not count when comparing openings ("So um the…" restarts as "So the…").
      const content = (a: number, b: number) => words.slice(a, b + 1).map((w) => norm(w.word)).filter((w) => w && !FILLERS.has(w));
      const own = content(s.first, s.last);
      const next = sentences[i + 1];
      const nextWords = next ? content(next.first, next.last) : [];
      // A false start: the next sentence opens with the same first three words (or all of a shorter one).
      const n = Math.min(3, own.length);
      const falseStart = next !== undefined && n >= 2 && own.slice(0, n).join(" ") === nextWords.slice(0, n).join(" ");
      if (falseStart || RETAKE_MARKERS.test(s.text)) {
        for (let k = s.first; k <= s.last; k++) dropped.add(k);
        cuts.push({ start_ms: s.start_ms, end_ms: s.end_ms, reason: "retake", text: s.text });
      }
    });
  }
  if (opts.fillers !== false) {
    words.forEach((w, i) => {
      if (!dropped.has(i) && FILLERS.has(norm(w.word))) {
        dropped.add(i);
        cuts.push({ start_ms: w.start_ms, end_ms: w.end_ms, reason: "filler", text: w.word });
      }
    });
  }
  // Pauses between the words that remain (and before the first / after the last).
  if (opts.silences !== false) {
    const kept = words.filter((_, i) => !dropped.has(i));
    const bounds = [{ end_ms: 0 }, ...kept, { start_ms: durationMs }] as Array<Partial<TimedWord>>;
    for (let i = 0; i + 1 < bounds.length; i++) {
      const a = bounds[i]!.end_ms ?? 0;
      const b = bounds[i + 1]!.start_ms ?? durationMs;
      const edge = i === 0 || i + 1 === bounds.length - 1;
      const allowed = edge ? keepPause / 2 : maxPause;
      if (b - a > allowed + 1) {
        // Keep half the kept pause on each side of a join (none past the file's start or end).
        const start = i === 0 ? a : a + keepPause / 2;
        const end = i + 1 === bounds.length - 1 ? b : b - keepPause / 2;
        if (end - start > 30) cuts.push({ start_ms: Math.round(start), end_ms: Math.round(end), reason: "silence" });
      }
    }
  }

  // Merge overlapping cuts; kept ranges are the complement.
  const sorted = [...cuts].sort((x, y) => x.start_ms - y.start_ms);
  const merged: Array<{ start_ms: number; end_ms: number }> = [];
  for (const c of sorted) {
    const last = merged[merged.length - 1];
    if (last && c.start_ms <= last.end_ms) last.end_ms = Math.max(last.end_ms, c.end_ms);
    else merged.push({ start_ms: Math.max(0, c.start_ms), end_ms: Math.min(durationMs, c.end_ms) });
  }
  const keep: EditPlan["keep"] = [];
  let t = 0;
  for (const m of merged) {
    if (m.start_ms - t >= MIN_KEEP_MS) keep.push({ start_ms: t, end_ms: m.start_ms });
    t = Math.max(t, m.end_ms);
  }
  if (durationMs - t >= MIN_KEEP_MS) keep.push({ start_ms: t, end_ms: durationMs });
  const result_ms = keep.reduce((s, k) => s + (k.end_ms - k.start_ms), 0);
  return { cuts: sorted, keep, source_ms: durationMs, result_ms };
}

/** Pure: words that survive the plan, moved onto the tightened timeline. */
export function retimeWords(words: readonly TimedWord[], keep: EditPlan["keep"]): TimedWord[] {
  const out: TimedWord[] = [];
  let offset = 0;
  for (const k of keep) {
    for (const w of words) {
      if (w.start_ms >= k.start_ms && w.end_ms <= k.end_ms) out.push({ ...w, start_ms: w.start_ms - k.start_ms + offset, end_ms: w.end_ms - k.start_ms + offset });
    }
    offset += k.end_ms - k.start_ms;
  }
  return out;
}

// ---------------------------------------------------------------------------------- joins

export type JoinFindingKind = "partial_word" | "repeated_word" | "join_mismatch";

export interface JoinFinding {
  kind: JoinFindingKind;
  /** The words involved (original spelling). */
  words: string[];
  /** Which side of the join to move: "out" ends the left kept part, "in" starts the right one. */
  boundary?: "out" | "in";
  /** Where to move that boundary (source ms): the nearest word gap. */
  suggested_ms?: number;
  fix: string;
  /** join_mismatch: what the transcript says around the join, and what whisper heard. */
  expected?: string;
  heard?: string;
}

export interface JoinCheck {
  /** Join i sits between kept range i and i+1. */
  index: number;
  /** Source time where the left kept range ends and the right one starts. */
  out_ms: number;
  in_ms: number;
  /** Time of the join in the tightened file. */
  at_ms: number;
  /** Last word before and first word after the join (original timings). */
  left?: string;
  right?: string;
  findings: JoinFinding[];
}

const isContent = (w: string) => {
  const n = norm(w);
  return n !== "" && !FILLERS.has(n);
};

/**
 * Pure: check every join of a plan against the ORIGINAL word timings. `partial_word`: a
 * boundary falls strictly inside a word (the fix moves it to the nearer edge of that word, i.e.
 * the adjacent gap). `repeated_word`: the same content word (case, punctuation and fillers
 * ignored) ends the left side and starts the right side (the fix ends the left side before the
 * first one).
 */
export function checkJoins(words: readonly TimedWord[], keep: EditPlan["keep"]): JoinCheck[] {
  const joins: JoinCheck[] = [];
  let at = 0;
  for (let i = 0; i + 1 < keep.length; i++) {
    const L = keep[i]!;
    const R = keep[i + 1]!;
    at += L.end_ms - L.start_ms;
    const findings: JoinFinding[] = [];
    const partial = (b: number, boundary: "out" | "in") => {
      for (const w of words) {
        if (w.start_ms < b && b < w.end_ms) {
          const suggested = b - w.start_ms <= w.end_ms - b ? w.start_ms : w.end_ms;
          findings.push({
            kind: "partial_word",
            words: [w.word],
            boundary,
            suggested_ms: suggested,
            fix: `the cut at ${b} ms is inside "${w.word}" (${w.start_ms}–${w.end_ms} ms): move the ${boundary === "out" ? "end of the left part" : "start of the right part"} to ${suggested} ms (${suggested === w.start_ms ? "before" : "after"} the word)`,
          });
        }
      }
    };
    partial(L.end_ms, "out");
    partial(R.start_ms, "in");
    let left: TimedWord | undefined;
    for (const w of words) if (w.start_ms < L.end_ms && w.end_ms > L.start_ms && isContent(w.word)) left = w;
    const right = words.find((w) => w.end_ms > R.start_ms && w.start_ms < R.end_ms && isContent(w.word));
    if (left && right && left !== right && norm(left.word) === norm(right.word)) {
      findings.push({
        kind: "repeated_word",
        words: [left.word, right.word],
        boundary: "out",
        suggested_ms: left.start_ms,
        fix: `"${norm(left.word)}" is said on both sides of the join: end the left part at ${left.start_ms} ms (before the first one), or start the right part after the second`,
      });
    }
    joins.push({ index: i, out_ms: L.end_ms, in_ms: R.start_ms, at_ms: at, ...(left ? { left: left.word } : {}), ...(right ? { right: right.word } : {}), findings });
  }
  return joins;
}

/** Longest common subsequence length (word lists). */
function lcs(a: readonly string[], b: readonly string[]): number {
  const dp = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = x === b[j - 1] ? prev + 1 : Math.max(dp[j]!, dp[j - 1]!);
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/** Seconds of audio re-transcribed on each side of a join. */
export const JOIN_ASR_WINDOW_MS = 2000;
/** Most joins re-transcribed per apply (each is one whisper run). */
export const JOIN_ASR_MAX = 40;
/** Share of the expected words whisper must hear, in order, around a join. */
const JOIN_ASR_MIN_MATCH = 0.6;

/**
 * Pure: compare what whisper heard around a join with the re-timed transcript. Expected words
 * are those whose middle lies inside the window minus 300 ms at each edge (edge words may be
 * clipped); a mismatch is fewer than 60% of them heard in order, or a content word heard twice
 * in a row where the transcript has it once.
 */
export function compareJoinAsr(expectedWords: readonly TimedWord[], heardWords: readonly TimedWord[], window: { start_ms: number; end_ms: number }): JoinFinding | undefined {
  const inner = expectedWords.filter((w) => {
    const mid = (w.start_ms + w.end_ms) / 2;
    return mid >= window.start_ms + 300 && mid <= window.end_ms - 300;
  });
  const exp = inner.map((w) => norm(w.word)).filter((w) => w && !FILLERS.has(w));
  const heard = heardWords.map((w) => norm(w.word)).filter((w) => w && !FILLERS.has(w));
  const repeats = (xs: string[]) => xs.filter((x, i) => i > 0 && xs[i - 1] === x).length;
  const score = exp.length ? lcs(exp, heard) / exp.length : 1;
  const doubled = repeats(heard) > repeats(exp);
  if ((exp.length >= 2 && score < JOIN_ASR_MIN_MATCH) || doubled) {
    return {
      kind: "join_mismatch",
      words: heardWords.map((w) => w.word),
      expected: inner.map((w) => w.word).join(" "),
      heard: heardWords.map((w) => w.word).join(" "),
      fix: doubled ? "a word is heard twice across the join: move the join to remove one" : `whisper heard ${Math.round(score * 100)}% of the expected words: listen to the join and move the cut to the nearest pause`,
    };
  }
  return undefined;
}

export interface AsrCheck {
  status: "ok" | "mismatch" | "not_run";
  reason?: string;
  /** Joins re-transcribed. */
  checked?: number;
}

export interface TightenResult {
  asset: string;
  dry_run: boolean;
  plan: EditPlan;
  counts: Record<CutReason, number>;
  removed_ms: number;
  edl_path: string;
  /** Every join, checked against the original word timings (and, after apply, by whisper). */
  joins: JoinCheck[];
  /** Re-transcription of ±2 s around each join after apply. */
  asr_check: AsrCheck;
  /** pacing_from: the measured pacing and the limits it gave. */
  pacing?: { from: string; pacing: SpeechPacing; max_pause_ms: number; keep_pause_ms: number };
  /** With apply: the new asset. */
  new_asset?: string;
  path?: string;
}

/**
 * pacing_from → speech pacing: a project-relative JSON file (analyze's qa/analysis.json, a
 * FormatGrammar with `speech_pacing`) or a video/audio asset id of this project, measured now.
 */
export async function resolvePacing(projectDir: string, ir: ContentIR, from: string): Promise<SpeechPacing> {
  if (/\.json$/i.test(from)) {
    let abs: string;
    try {
      abs = await resolveInsideProject(projectPaths(projectDir), from);
    } catch {
      throw new Error(`pacing_from must be a path inside the project (e.g. qa/analysis.json) or an asset id: ${from}`);
    }
    const g = FormatGrammar.safeParse(JSON.parse(await readFile(abs, "utf8")));
    if (!g.success) throw new Error(`${from} is not an analyze result (FormatGrammar)`);
    if (!g.data.speech_pacing) throw new Error(`${from} has no speech_pacing: run analyze again on a video with speech (it measures pauses since 0.4)`);
    return g.data.speech_pacing;
  }
  const a = ir.assets.find((x) => x.id === from);
  if (!a || a.kind === "image") throw new Error(`pacing_from "${from}" is neither a .json analysis file nor a video/audio asset of this project`);
  return measureSpeechPacing(join(projectDir, a.path));
}

export async function tightenAsset(projectDir: string, assetId: string, opts: TightenOptions = {}, deps: TightenDeps = {}): Promise<TightenResult> {
  const { path: irPath, ir } = await loadContentIr(projectDir);
  const asset = findMediaAsset(ir, assetId);
  const words = await loadTranscriptWords(projectDir, asset);
  const src = join(projectDir, asset.path);
  const durationMs = Math.round((asset.media?.duration_sec ?? (await ffprobe(src)).duration_s) * 1000);
  let pacing: TightenResult["pacing"];
  const planOpts: TightenOptions = { ...opts };
  if (opts.pacing_from) {
    const measured = await resolvePacing(projectDir, ir, opts.pacing_from);
    const limits = pacingLimits(measured);
    planOpts.max_pause_ms = opts.max_pause_ms ?? limits.max_pause_ms;
    planOpts.keep_pause_ms = opts.keep_pause_ms ?? limits.keep_pause_ms;
    pacing = { from: opts.pacing_from, pacing: measured, max_pause_ms: planOpts.max_pause_ms, keep_pause_ms: Math.min(planOpts.keep_pause_ms, planOpts.max_pause_ms) };
  }
  const plan = planTighten(words, durationMs, planOpts);
  const counts: Record<CutReason, number> = { silence: 0, filler: 0, retake: 0 };
  for (const c of plan.cuts) counts[c.reason]++;
  const joins = checkJoins(words, plan.keep);
  const partials = joins.flatMap((j) => j.findings.filter((f) => f.kind === "partial_word").map((f) => ({ j, f })));
  const edlRel = `qa/tighten-${asset.id}.json`;
  await mkdir(join(projectDir, "qa"), { recursive: true });
  const writeEdl = (asr: AsrCheck, js: JoinCheck[]) => writeJsonAtomic(join(projectDir, edlRel), { asset: asset.id, ...plan, counts, ...(pacing ? { pacing } : {}), joins: js, asr_check: asr });
  const dryAsr: AsrCheck = { status: "not_run", reason: opts.apply ? "not run yet" : "dry run: joins are re-transcribed after apply" };
  await writeEdl(dryAsr, joins);
  const result: TightenResult = { asset: asset.id, dry_run: !opts.apply, plan, counts, removed_ms: plan.source_ms - plan.result_ms, edl_path: edlRel, joins, asr_check: dryAsr, ...(pacing ? { pacing } : {}) };
  if (!opts.apply) return result;
  if (plan.keep.length === 0) throw new Error("nothing would be left after tightening; loosen the options (e.g. silences: false)");
  if (partials.length && opts.force !== true) {
    throw new Error(
      `refusing to apply: ${partials.length} join(s) cut inside a word (see ${edlRel}):\n${partials.map(({ j, f }) => `- join ${j.index} at ${(j.at_ms / 1000).toFixed(2)} s: ${f.fix}`).join("\n")}\nFix the transcript timings or the options, or pass force: true to apply anyway`,
    );
  }

  const newId = `${asset.id}-tight`;
  const isVideo = asset.kind === "video" && asset.media?.has_video !== false;
  const ext = isVideo ? ".mp4" : ".m4a";
  const rel = `source/assets/${newId}${ext}`;
  const out = join(projectDir, rel);
  await mkdir(join(projectDir, "source", "assets"), { recursive: true });
  const s = (ms: number) => (ms / 1000).toFixed(3);
  const fade = JOIN_FADE_MS / 1000;
  const chains: string[] = [];
  plan.keep.forEach((k, i) => {
    const d = (k.end_ms - k.start_ms) / 1000;
    if (isVideo) chains.push(`[0:v]trim=start=${s(k.start_ms)}:end=${s(k.end_ms)},setpts=PTS-STARTPTS[v${i}]`);
    chains.push(
      `[0:a]atrim=start=${s(k.start_ms)}:end=${s(k.end_ms)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fade},afade=t=out:st=${Math.max(0, d - fade).toFixed(3)}:d=${fade}[a${i}]`,
    );
  });
  const inputs = plan.keep.map((_, i) => (isVideo ? `[v${i}][a${i}]` : `[a${i}]`)).join("");
  chains.push(`${inputs}concat=n=${plan.keep.length}:v=${isVideo ? 1 : 0}:a=1${isVideo ? "[vo][ao]" : "[ao]"}`);
  const codec = isVideo ? ["-map", "[vo]", "-map", "[ao]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"] : ["-map", "[ao]"];
  await runFfmpeg(["-y", "-i", src, "-filter_complex", chains.join(";"), ...codec, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out]);

  const probe = await ffprobe(out);
  const sha256 = await hashFile(out);
  const newWords = retimeWords(words, plan.keep);
  const tPath = `source/transcripts/${newId}.json`;
  await mkdir(join(projectDir, "source", "transcripts"), { recursive: true });
  await writeFile(join(projectDir, tPath), `${JSON.stringify(newWords)}\n`);

  const origSource = ir.sources.find((x) => x.sha256 === asset.sha256);
  const next: ContentIR = structuredClone(ir);
  next.sources = next.sources.filter((x) => x.id !== `${newId}-src`);
  next.sources.push({
    id: `${newId}-src`,
    kind: isVideo ? "video" : "audio",
    uri: `${origSource?.uri ?? asset.path} (tightened)`,
    sha256,
    title: `${origSource?.title ?? basename(asset.path)} (tightened)`,
  });
  const newAsset: IrAsset = {
    id: newId,
    kind: asset.kind,
    path: rel,
    sha256,
    source_ref: `${isVideo ? "video" : "audio"}:${newId}${ext}`,
    media: {
      duration_sec: probe.duration_s,
      ...(probe.width ? { width: probe.width } : {}),
      ...(probe.height ? { height: probe.height } : {}),
      ...(probe.fps ? { fps: probe.fps } : {}),
      has_video: probe.has_video,
      has_audio: probe.has_audio,
      ...(asset.media?.content_box ? { content_box: asset.media.content_box } : {}),
    },
  };
  next.assets = [...next.assets.filter((a) => a.id !== newId), newAsset];
  next.classification = {
    ...next.classification,
    notes: [...next.classification.notes.filter((n) => !n.startsWith(`${newId}:`)), `${newId}: ${asset.id} with ${plan.cuts.length} cut(s) (${counts.silence} pauses, ${counts.filler} fillers, ${counts.retake} retakes), see ${edlRel}`],
  };
  const t = asset.media?.transcript;
  const applied = applyTranscript(ContentIR.parse(next), newId, newWords, { path: tPath, source: t?.source ?? "whisper", ...(t?.model ? { model: t.model } : {}), ...(t?.language ? { language: t.language } : {}) });
  await writeJsonAtomic(irPath, applied.ir);

  // Re-transcribe ±2 s around each join of the new file (whisper installed) and compare.
  const asr = await asrJoinCheck(projectDir, asset, out, joins, newWords, plan.result_ms, deps);
  await writeEdl(asr, joins);
  return { ...result, joins, asr_check: asr, new_asset: newId, path: rel };
}

/** Whisper check of every join (mutates `joins`: adds join_mismatch findings). Never throws. */
async function asrJoinCheck(
  projectDir: string,
  asset: IrAsset,
  outPath: string,
  joins: JoinCheck[],
  newWords: readonly TimedWord[],
  resultMs: number,
  deps: TightenDeps,
): Promise<AsrCheck> {
  if (!joins.length) return { status: "ok", checked: 0, reason: "no joins" };
  const gl = await loadProjectGlossary(projectDir);
  let run = deps.whisper;
  if (!run) {
    const language = asset.media?.transcript?.language;
    let model: string;
    try {
      const plan = await planWhisperModel(projectDir, language && language !== "en" ? { language } : {}, deps.env ?? process.env);
      if (!plan.model.exists) return { status: "not_run", reason: `no whisper model at ${plan.model.path} (transcribe downloads one with the user's consent)` };
      model = plan.model.path;
    } catch (e) {
      return { status: "not_run", reason: `no whisper model: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` };
    }
    const prompt = glossaryPrompt(gl.glossary);
    run = (mediaPath, range) =>
      whisperTranscribe(mediaPath, { model, range, ...(language && language !== "en" ? { language } : {}), ...(prompt ? { prompt } : {}), ...(deps.whisperBin ? { bin: deps.whisperBin } : {}) });
  }
  const todo = joins.slice(0, JOIN_ASR_MAX);
  let mismatches = 0;
  for (const j of todo) {
    const window = { start_ms: Math.max(0, j.at_ms - JOIN_ASR_WINDOW_MS), end_ms: Math.min(resultMs, j.at_ms + JOIN_ASR_WINDOW_MS) };
    let heard: TimedWord[];
    try {
      heard = applyGlossary(await run(outPath, window), gl.glossary).words;
    } catch (e) {
      const msg = e instanceof Error ? e.message.split("\n")[0]! : String(e);
      return { status: "not_run", reason: /not found/.test(msg) ? msg : `whisper failed: ${msg}`, checked: todo.indexOf(j) };
    }
    const f = compareJoinAsr(newWords, heard, window);
    if (f) {
      j.findings.push(f);
      mismatches++;
    }
  }
  const skipped = joins.length - todo.length;
  return {
    status: mismatches ? "mismatch" : "ok",
    checked: todo.length,
    ...(skipped > 0 ? { reason: `only the first ${JOIN_ASR_MAX} of ${joins.length} joins were re-transcribed` } : {}),
  };
}

export function formatTighten(r: TightenResult): string {
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const lines = [
    `${r.dry_run ? "dry run" : "applied"}: ${r.asset} ${sec(r.plan.source_ms)} → ${sec(r.plan.result_ms)} (−${sec(r.removed_ms)}): ${r.counts.silence} pause(s) shortened, ${r.counts.filler} filler(s), ${r.counts.retake} retake(s); edit list ${r.edl_path}`,
    ...r.plan.cuts.filter((c) => c.reason !== "silence").map((c) => `- ${c.reason} ${sec(c.start_ms)}–${sec(c.end_ms)}: "${c.text ?? ""}"`),
  ];
  if (r.pacing) lines.push(`pacing from ${r.pacing.from}: median pause ${r.pacing.pacing.pause_median_ms} ms, p95 ${r.pacing.pacing.pause_p95_ms} ms → max_pause_ms ${r.pacing.max_pause_ms}, keep_pause_ms ${r.pacing.keep_pause_ms}`);
  const issues = r.joins.flatMap((j) => j.findings.map((f) => `- join ${j.index} at ${sec(j.at_ms)} ${f.kind}: ${f.fix}${f.heard !== undefined ? ` (expected "${f.expected}", heard "${f.heard}")` : ""}`));
  lines.push(`joins: ${r.joins.length} checked, ${issues.length} issue(s); whisper check: ${r.asr_check.status}${r.asr_check.reason ? ` (${r.asr_check.reason})` : ""}`, ...issues);
  if (r.new_asset) lines.push(`new asset ${r.new_asset} → ${r.path} (transcript re-timed; use it in shorts or footage scenes)`);
  else lines.push("review the cuts above, then call tighten again with apply: true");
  return lines.join("\n");
}

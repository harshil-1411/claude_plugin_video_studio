import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { hashFile, writeJsonAtomic } from "@video-studio/core";
import { type TimedWord, ffprobe, groupSentences, runFfmpeg } from "@video-studio/media";
import { ContentIR, type IrAsset } from "@video-studio/schema";
import { applyTranscript, findMediaAsset, loadContentIr, loadTranscriptWords } from "./transcribe.js";

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

export interface TightenResult {
  asset: string;
  dry_run: boolean;
  plan: EditPlan;
  counts: Record<CutReason, number>;
  removed_ms: number;
  edl_path: string;
  /** With apply: the new asset. */
  new_asset?: string;
  path?: string;
}

export async function tightenAsset(projectDir: string, assetId: string, opts: TightenOptions = {}): Promise<TightenResult> {
  const { path: irPath, ir } = await loadContentIr(projectDir);
  const asset = findMediaAsset(ir, assetId);
  const words = await loadTranscriptWords(projectDir, asset);
  const src = join(projectDir, asset.path);
  const durationMs = Math.round((asset.media?.duration_sec ?? (await ffprobe(src)).duration_s) * 1000);
  const plan = planTighten(words, durationMs, opts);
  const counts: Record<CutReason, number> = { silence: 0, filler: 0, retake: 0 };
  for (const c of plan.cuts) counts[c.reason]++;
  const edlRel = `qa/tighten-${asset.id}.json`;
  await mkdir(join(projectDir, "qa"), { recursive: true });
  await writeJsonAtomic(join(projectDir, edlRel), { asset: asset.id, ...plan, counts });
  const result: TightenResult = { asset: asset.id, dry_run: !opts.apply, plan, counts, removed_ms: plan.source_ms - plan.result_ms, edl_path: edlRel };
  if (!opts.apply) return result;
  if (plan.keep.length === 0) throw new Error("nothing would be left after tightening; loosen the options (e.g. silences: false)");

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
  return { ...result, new_asset: newId, path: rel };
}

export function formatTighten(r: TightenResult): string {
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const lines = [
    `${r.dry_run ? "dry run" : "applied"}: ${r.asset} ${sec(r.plan.source_ms)} → ${sec(r.plan.result_ms)} (−${sec(r.removed_ms)}): ${r.counts.silence} pause(s) shortened, ${r.counts.filler} filler(s), ${r.counts.retake} retake(s); edit list ${r.edl_path}`,
    ...r.plan.cuts.filter((c) => c.reason !== "silence").map((c) => `- ${c.reason} ${sec(c.start_ms)}–${sec(c.end_ms)}: "${c.text ?? ""}"`),
  ];
  if (r.new_asset) lines.push(`new asset ${r.new_asset} → ${r.path} (transcript re-timed; use it in shorts or footage scenes)`);
  else lines.push("review the cuts above, then call tighten again with apply: true");
  return lines.join("\n");
}

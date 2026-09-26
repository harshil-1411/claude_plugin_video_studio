import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PROJECT_SCHEMA_VERSION, hashFile, writeJsonAtomic } from "@video-studio/core";
import { type TimedSentence, type TimedWord, ffprobe, groupSentences, runFfmpeg } from "@video-studio/media";
import { type AspectRatio, ContentIR, type IrAsset, SCHEMA_VERSION, type Scene, type ShortCandidate, ShortCandidates, type VideoSpec, defaultMaster } from "@video-studio/schema";
import { projectSpecPaths, validateSpecFile } from "./spec-validate.js";
import { findMediaAsset, loadContentIr, loadTranscriptWords, mediaRefBase } from "./transcribe.js";

/**
 * shorts: a long recording's transcript × shots → scored standalone spans. Candidates start
 * and end on sentence boundaries, snap to nearby shot cuts, and are ranked on hook strength,
 * speech density, completeness and dead air; the best non-overlapping ones are kept.
 */

export interface ShortsOptions {
  min_sec?: number;
  max_sec?: number;
  count?: number;
  /** Only spans spoken entirely by this speaker label (S1, S2; needs a transcript made with speakers: true). */
  speaker?: string;
}

/** Extra, non-schema detail returned with the candidates (not written to qa/shorts.json). */
export interface ShortsResult extends ShortCandidates {
  /** Transcript evidence refs covered by each candidate, keyed by candidate id (use as claim_refs). */
  evidence_refs: Record<string, string[]>;
  path: string;
}

/** Max distance a boundary moves to meet a shot cut. */
const SNAP_SEC = 1.0;
/** Silence inside a span beyond this per gap counts as dead air. */
const DEAD_GAP_MS = 700;
/** Words per second that counts as fully dense speech. */
const DENSE_WPS = 2.5;

const CONJUNCTION_START = /^(?:and|but|so|or|because|which|then|also|plus|that|yeah|um|uh|like)\b/i;
const STRONG_WORDS = /\b(?:never|always|most|best|worst|biggest|secret|mistake|mistakes|nobody|everyone|stop|don't|wrong|truth|actually|here's|the one|why|how|what if|imagine|you)\b/i;

/** 0–1: how well a first sentence works as a hook, with the reason. */
export function hookScore(sentence: string): { score: number; reason: string } {
  const s = sentence.trim();
  const words = s.split(/\s+/).length;
  if (CONJUNCTION_START.test(s)) return { score: 0.2, reason: "starts mid-thought" };
  let score = 0.4;
  let reason = "plain opening";
  if (/\?["'”’)]*$/.test(s)) {
    score = 1;
    reason = "opens with a question";
  } else if (/\d/.test(s) || /\b(?:one|two|three|four|five|ten|hundred|thousand|million|billion|percent)\b/i.test(s)) {
    score = 0.9;
    reason = "opens with a number";
  } else if (STRONG_WORDS.test(s)) {
    score = 0.75;
    reason = "opens with a strong claim";
  }
  if (words > 25) score -= 0.15;
  return { score: Math.max(0, Math.min(1, score)), reason };
}

interface Span {
  first: number;
  last: number;
  start_sec: number;
  end_sec: number;
  score: number;
  reasons: string[];
  /** Speaker labels in the span, in order of first appearance (only with speaker data). */
  speakers?: string[];
}

function snap(t: number, cuts: readonly number[], lo: number, hi: number): number | undefined {
  let best: number | undefined;
  for (const c of cuts) {
    if (c < lo || c > hi) continue;
    if (best === undefined || Math.abs(c - t) < Math.abs(best - t)) best = c;
  }
  return best;
}

/** Penalty for a span in which more than one speaker talks (only with speaker data). */
const MULTI_SPEAKER_PENALTY = 0.05;

/**
 * Score every sentence-aligned span of min–max seconds, then greedily keep the best
 * non-overlapping ones. `cuts` are shot-boundary times in seconds (0 and the end excluded).
 * With speaker labels on the words, single-speaker spans are preferred and `speaker` keeps only
 * spans spoken entirely by that label.
 */
export function scoreShorts(
  words: readonly TimedWord[],
  cuts: readonly number[],
  opts: { min_sec: number; max_sec: number; count: number; duration_sec?: number; speaker?: string },
): Array<Span & { sentences: TimedSentence[] }> {
  const hasSpeakers = words.some((w) => w.speaker !== undefined);
  const sentences = groupSentences(words);
  const total = opts.duration_sec ?? (words.length ? words[words.length - 1]!.end_ms / 1000 : 0);
  const spans: Span[] = [];
  for (let i = 0; i < sentences.length; i++) {
    const hook = hookScore(sentences[i]!.text);
    for (let j = i; j < sentences.length; j++) {
      const a = sentences[i]!;
      const b = sentences[j]!;
      const speechDur = (b.end_ms - a.start_ms) / 1000;
      if (speechDur > opts.max_sec) break;
      // Pad into the surrounding silence, or snap to a shot cut there.
      const prevEnd = i > 0 ? sentences[i - 1]!.end_ms / 1000 : 0;
      const nextStart = j + 1 < sentences.length ? sentences[j + 1]!.start_ms / 1000 : total;
      const s0 = a.start_ms / 1000;
      const e0 = b.end_ms / 1000;
      const sCut = snap(s0, cuts, Math.max(prevEnd, s0 - SNAP_SEC), s0);
      const eCut = snap(e0, cuts, e0, Math.min(nextStart, e0 + SNAP_SEC));
      const start = sCut ?? Math.max(prevEnd, s0 - 0.15, 0);
      const end = eCut ?? Math.min(nextStart, e0 + 0.3, total || e0 + 0.3);
      const dur = end - start;
      if (dur < opts.min_sec || dur > opts.max_sec) continue;

      const spanWords = words.slice(a.first, b.last + 1);
      const speakers = hasSpeakers ? [...new Set(spanWords.map((w) => w.speaker).filter((x): x is string => x !== undefined))] : undefined;
      if (opts.speaker !== undefined && (speakers?.length !== 1 || speakers[0] !== opts.speaker)) continue;
      const density = Math.min(1, spanWords.length / dur / DENSE_WPS);
      let dead = 0;
      for (let k = 1; k < spanWords.length; k++) dead += Math.max(0, spanWords[k]!.start_ms - spanWords[k - 1]!.end_ms - DEAD_GAP_MS);
      const deadScore = Math.max(0, 1 - dead / 1000 / (0.1 * dur));
      const endsClean = /[.?!…]["'”’)]*$/.test(b.text);
      const pauseBefore = i === 0 || a.start_ms - sentences[i - 1]!.end_ms >= 400;
      const completeness = (endsClean ? 0.7 : 0.35) + (pauseBefore ? 0.3 : 0.1);
      const snapped = (sCut !== undefined ? 0.5 : 0) + (eCut !== undefined ? 0.5 : 0);
      const multi = speakers !== undefined && speakers.length > 1;
      const score = Math.max(0, Math.min(1, 0.35 * hook.score + 0.25 * density + 0.2 * completeness + 0.2 * deadScore + 0.05 * snapped) - (multi ? MULTI_SPEAKER_PENALTY : 0));

      const reasons = [
        `hook: ${hook.reason}`,
        `speech density ${(spanWords.length / dur).toFixed(1)} words/s`,
        endsClean ? "ends on a complete sentence" : "ends without closing punctuation",
        dead > 0 ? `${(dead / 1000).toFixed(1)} s of dead air` : "no dead air",
      ];
      if (sCut !== undefined || eCut !== undefined) reasons.push(`snapped to shot cut${sCut !== undefined && eCut !== undefined ? "s" : ""}`);
      if (speakers?.length) reasons.push(multi ? `${speakers.length} speakers (${speakers.join(", ")})` : `single speaker (${speakers[0]})`);
      spans.push({ first: i, last: j, start_sec: start, end_sec: end, score, reasons, ...(speakers?.length ? { speakers } : {}) });
    }
  }
  spans.sort((x, y) => y.score - x.score || x.start_sec - y.start_sec);
  const picked: Span[] = [];
  for (const s of spans) {
    if (picked.length >= opts.count) break;
    if (picked.some((p) => s.start_sec < p.end_sec && p.start_sec < s.end_sec)) continue;
    picked.push(s);
  }
  return picked.map((s) => ({ ...s, sentences: sentences.slice(s.first, s.last + 1) }));
}

export async function findShorts(projectDir: string, assetId: string, opts: ShortsOptions = {}): Promise<ShortsResult> {
  const root = resolve(projectDir);
  const min = opts.min_sec ?? 20;
  const max = opts.max_sec ?? 60;
  if (max <= min) throw new Error(`max_sec (${max}) must be greater than min_sec (${min})`);
  const count = Math.max(1, Math.min(10, Math.floor(opts.count ?? 3)));
  const { ir } = await loadContentIr(root);
  const asset = findMediaAsset(ir, assetId);
  const words = await loadTranscriptWords(root, asset);
  const duration = asset.media?.duration_sec;
  const cuts = (asset.media?.shots ?? []).map((s) => s.start_sec).filter((t) => t > 0);
  if (opts.speaker !== undefined) {
    const labels = [...new Set(words.map((w) => w.speaker).filter((x): x is string => typeof x === "string"))];
    if (!labels.length) throw new Error(`the transcript of ${asset.id} has no speaker labels; run transcribe with speakers: true first (English conversations)`);
    if (!labels.includes(opts.speaker)) throw new Error(`no speaker "${opts.speaker}" in the transcript of ${asset.id}; speakers: ${labels.join(", ")}`);
  }

  const picked = scoreShorts(words, cuts, { min_sec: min, max_sec: max, count, ...(duration ? { duration_sec: duration } : {}), ...(opts.speaker !== undefined ? { speaker: opts.speaker } : {}) });
  const base = mediaRefBase(asset);
  const spans = ir.evidence.filter((e) => e.ref.startsWith(`${base}#t=`) && e.locator.time_start_sec !== undefined);
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const evidence_refs: Record<string, string[]> = {};
  const candidates: ShortCandidate[] = picked
    .sort((a, b) => b.score - a.score)
    .map((p, i) => {
      const id = `short-${i + 1}`;
      evidence_refs[id] = spans
        .filter((e) => e.locator.time_start_sec! >= p.start_sec - 0.05 && (e.locator.time_end_sec ?? e.locator.time_start_sec!) <= p.end_sec + 0.05)
        .map((e) => e.ref);
      return {
        id,
        asset: asset.id,
        start_sec: r3(p.start_sec),
        end_sec: r3(p.end_sec),
        score: Math.round(p.score * 1000) / 1000,
        reasons: p.reasons,
        transcript: p.sentences.map((s) => s.text).join(" "),
        hook: p.sentences[0]!.text,
        ...(p.speakers ? { speakers: p.speakers } : {}),
      };
    });
  const doc = ShortCandidates.parse({ schema_version: SCHEMA_VERSION, asset: asset.id, target_sec: { min, max }, candidates });
  const rel = "qa/shorts.json";
  await writeJsonAtomic(join(root, rel), doc);
  return { ...doc, evidence_refs, path: rel };
}

export function formatShorts(s: ShortCandidates & { evidence_refs?: Record<string, string[]>; path?: string }): string {
  if (s.candidates.length === 0) {
    return `No ${s.target_sec.min}–${s.target_sec.max} s span of ${s.asset} starts and ends on sentence boundaries; try a wider min_sec/max_sec.`;
  }
  const lines = [`${s.candidates.length} short candidate(s) from ${s.asset}${s.path ? ` → ${s.path}` : ""}:`];
  for (const c of s.candidates) {
    lines.push(`- ${c.id} ${c.start_sec.toFixed(1)}–${c.end_sec.toFixed(1)} s (${(c.end_sec - c.start_sec).toFixed(1)} s), score ${c.score.toFixed(2)}${c.speakers?.length ? `, speakers ${c.speakers.join("+")}` : ""}`);
    lines.push(`  hook: "${c.hook}"`);
    lines.push(`  why: ${c.reasons.join("; ")}`);
    const refs = s.evidence_refs?.[c.id];
    if (refs?.length) lines.push(`  claim_refs: ${refs.join(", ")}`);
  }
  return lines.join("\n");
}

// ------------------------------------------------------------------------------------ short projects

/** Seconds kept before and after a short's span in its trimmed copy (room to adjust the cut). */
const SHORT_TRIM_MARGIN_SEC = 1;

/**
 * Write shorts/<id>/source/: the candidate's span (± margin) re-encoded from the base asset, its
 * transcript words shifted to the new timeline, and a ContentIR holding only that asset (same id,
 * same evidence refs, so claim_refs keep working) plus the base's sources and evidence.
 */
async function trimShortSource(root: string, dir: string, ir: ContentIR, c: ShortCandidate): Promise<{ offset_sec: number }> {
  const asset = findMediaAsset(ir, c.asset);
  const duration = asset.media?.duration_sec ?? c.end_sec + SHORT_TRIM_MARGIN_SEC;
  const start = Math.max(0, c.start_sec - SHORT_TRIM_MARGIN_SEC);
  const end = Math.min(duration, c.end_sec + SHORT_TRIM_MARGIN_SEC);
  const ext = asset.kind === "audio" ? ".m4a" : ".mp4";
  const rel = `source/assets/${asset.id}-${c.id}${ext}`;
  const out = join(dir, rel);
  await mkdir(join(dir, "source", "assets"), { recursive: true });
  const codec = asset.kind === "audio" ? ["-vn", "-c:a", "aac", "-b:a", "192k"] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"];
  await runFfmpeg(["-y", "-ss", String(start), "-to", String(end), "-i", join(root, asset.path), ...codec, out]);
  const probe = await ffprobe(out);
  const words = (await loadTranscriptWords(root, asset))
    .filter((w) => w.start_ms >= start * 1000 && w.end_ms <= end * 1000)
    .map((w) => ({ ...w, start_ms: w.start_ms - Math.round(start * 1000), end_ms: w.end_ms - Math.round(start * 1000) }));
  const tPath = `source/transcripts/${asset.id}.json`;
  await mkdir(join(dir, "source", "transcripts"), { recursive: true });
  await writeFile(join(dir, tPath), `${JSON.stringify(words)}\n`);
  const shots = (asset.media?.shots ?? [])
    .filter((sh) => sh.end_sec > start && sh.start_sec < end)
    .map((sh) => ({ start_sec: Math.max(0, sh.start_sec - start), end_sec: Math.min(end, sh.end_sec) - start }));
  const trimmedAsset: IrAsset = {
    id: asset.id,
    kind: asset.kind,
    path: rel,
    sha256: await hashFile(out),
    ...(asset.source_ref ? { source_ref: asset.source_ref } : {}),
    media: {
      duration_sec: probe.duration_s,
      ...(probe.width ? { width: probe.width } : {}),
      ...(probe.height ? { height: probe.height } : {}),
      ...(probe.fps ? { fps: probe.fps } : {}),
      has_video: probe.has_video,
      has_audio: probe.has_audio,
      ...(shots.length ? { shots } : {}),
      ...(asset.media?.transcript ? { transcript: { ...asset.media.transcript, path: tPath, words: words.length } } : {}),
    },
  };
  const shortIr: ContentIR = ContentIR.parse({
    ...ir,
    assets: [trimmedAsset],
    classification: {
      ...ir.classification,
      notes: [...ir.classification.notes, `short ${c.id}: only ${start.toFixed(1)}–${end.toFixed(1)} s of ${asset.id} was copied`],
    },
  });
  await writeJsonAtomic(join(dir, "source", "content-ir.json"), shortIr);
  if (existsSync(join(root, "source", "provenance.json"))) await cp(join(root, "source", "provenance.json"), join(dir, "source", "provenance.json"));
  return { offset_sec: start };
}

/** Longest scene a short is split into (at sentence boundaries). */
const SHORT_SCENE_MAX_SEC = 12;

export interface ShortProject {
  id: string;
  project_dir: string;
  scenes: number;
  duration_sec: number;
  valid: boolean;
  errors: string[];
}

/**
 * Turn chosen candidates into ready talking-head projects under shorts/<id>/: the base's
 * source/, input/, assets/ and brand are copied, and project/video-spec.json holds footage scenes
 * (native sound, voice.mode native, captions from the transcript) split at sentence boundaries,
 * each citing its transcript evidence. Claude refines the hook text, cover and post copy.
 */
export async function makeShortProjects(
  projectDir: string,
  result: ShortsResult,
  opts: { ids?: string[]; aspect_ratio?: AspectRatio; targets?: string[] } = {},
): Promise<ShortProject[]> {
  const root = resolve(projectDir);
  const { ir } = await loadContentIr(root);
  const base = mediaRefBase(findMediaAsset(ir, result.asset));
  const spans = ir.evidence
    .filter((e) => e.ref.startsWith(`${base}#t=`) && e.locator.time_start_sec !== undefined)
    .sort((a, b) => a.locator.time_start_sec! - b.locator.time_start_sec!);
  const aspect = opts.aspect_ratio ?? "9:16";
  const out: ShortProject[] = [];
  for (const c of result.candidates.filter((x) => !opts.ids || opts.ids.includes(x.id))) {
    const dir = join(root, "shorts", c.id);
    await mkdir(join(dir, "project"), { recursive: true });
    // Only this clip leaves the base project: never copy the full recording (it can hold private
    // material outside the span). The short gets a trimmed copy and a ContentIR for it alone.
    for (const part of ["source", "input", "assets"]) await rm(join(dir, part), { recursive: true, force: true });
    if (existsSync(join(root, "brand.yaml"))) await cp(join(root, "brand.yaml"), join(dir, "brand.yaml"));
    const trimmed = await trimShortSource(root, dir, ir, c);
    const offset = trimmed.offset_sec;
    // Sentences inside the span become scene chunks of at most SHORT_SCENE_MAX_SEC.
    const inside = spans.filter((e) => e.locator.time_start_sec! >= c.start_sec - 0.05 && (e.locator.time_end_sec ?? e.locator.time_start_sec!) <= c.end_sec + 0.05);
    const chunks: Array<{ start: number; end: number; refs: string[] }> = [];
    for (const e of inside) {
      const last = chunks[chunks.length - 1];
      const end = e.locator.time_end_sec ?? e.locator.time_start_sec!;
      if (last && end - last.start <= SHORT_SCENE_MAX_SEC) {
        last.end = end;
        last.refs.push(e.ref);
      } else {
        chunks.push({ start: last ? last.end : c.start_sec, end, refs: [e.ref] });
      }
    }
    if (chunks.length === 0) chunks.push({ start: c.start_sec, end: c.end_sec, refs: [] });
    chunks[0]!.start = c.start_sec;
    chunks[chunks.length - 1]!.end = c.end_sec;
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const scenes: Scene[] = chunks.map((ch, i) => ({
      id: `s${String(i + 1).padStart(2, "0")}`,
      duration_sec: r2(ch.end - ch.start),
      purpose: i === 0 ? "hook" : i === chunks.length - 1 && chunks.length > 1 ? "payoff" : "point",
      voiceover: "",
      visual_strategy: "user_asset",
      footage: { asset: c.asset, in_sec: r2(ch.start - offset), out_sec: r2(ch.end - offset), fit: "cover" },
      audio: { mode: "native" },
      visual_requirements: { continuity_refs: [] },
      claim_refs: ch.refs,
    }));
    const spec: VideoSpec = {
      schema_version: "1.0",
      id: `${c.asset}-${c.id}`.replace(/[^A-Za-z0-9_.@:-]/g, "-"),
      title: c.hook.slice(0, 80),
      goal: "educate",
      audience: "viewers of the original recording",
      platform: "tiktok",
      aspect_ratio: aspect,
      master: defaultMaster(aspect),
      targets: opts.targets ?? ["tiktok", "instagram", "youtube-shorts"],
      target_duration_sec: r2(scenes.reduce((a, s) => a + s.duration_sec, 0)),
      language: "en-US",
      grounding: "strict",
      voice: { mode: "native" },
      captions: { preset: "bold", burn_in: true },
      scenes,
    };
    const { spec: specPath, contentIr } = projectSpecPaths(dir);
    await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);
    await writeFile(
      join(dir, "project", "project.json"),
      `${JSON.stringify({ id: randomUUID(), name: `${c.id} of ${c.asset}`, created_at: new Date().toISOString(), schema_version: PROJECT_SCHEMA_VERSION }, null, 2)}\n`,
    );
    const check = await validateSpecFile(specPath, existsSync(contentIr) ? contentIr : null);
    out.push({
      id: c.id,
      project_dir: `shorts/${c.id}`,
      scenes: scenes.length,
      duration_sec: spec.target_duration_sec,
      valid: check.ok,
      errors: check.errors.map((e) => `${e.path}: ${e.message} (fix: ${e.fix})`),
    });
  }
  return out;
}

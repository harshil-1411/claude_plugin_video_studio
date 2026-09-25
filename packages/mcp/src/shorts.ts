import { join, resolve } from "node:path";
import { writeJsonAtomic } from "@video-studio/core";
import { type TimedSentence, type TimedWord, groupSentences } from "@video-studio/media";
import { SCHEMA_VERSION, type ShortCandidate, ShortCandidates } from "@video-studio/schema";
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
}

function snap(t: number, cuts: readonly number[], lo: number, hi: number): number | undefined {
  let best: number | undefined;
  for (const c of cuts) {
    if (c < lo || c > hi) continue;
    if (best === undefined || Math.abs(c - t) < Math.abs(best - t)) best = c;
  }
  return best;
}

/**
 * Score every sentence-aligned span of min–max seconds, then greedily keep the best
 * non-overlapping ones. `cuts` are shot-boundary times in seconds (0 and the end excluded).
 */
export function scoreShorts(
  words: readonly TimedWord[],
  cuts: readonly number[],
  opts: { min_sec: number; max_sec: number; count: number; duration_sec?: number },
): Array<Span & { sentences: TimedSentence[] }> {
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
      const density = Math.min(1, spanWords.length / dur / DENSE_WPS);
      let dead = 0;
      for (let k = 1; k < spanWords.length; k++) dead += Math.max(0, spanWords[k]!.start_ms - spanWords[k - 1]!.end_ms - DEAD_GAP_MS);
      const deadScore = Math.max(0, 1 - dead / 1000 / (0.1 * dur));
      const endsClean = /[.?!…]["'”’)]*$/.test(b.text);
      const pauseBefore = i === 0 || a.start_ms - sentences[i - 1]!.end_ms >= 400;
      const completeness = (endsClean ? 0.7 : 0.35) + (pauseBefore ? 0.3 : 0.1);
      const snapped = (sCut !== undefined ? 0.5 : 0) + (eCut !== undefined ? 0.5 : 0);
      const score = Math.min(1, 0.35 * hook.score + 0.25 * density + 0.2 * completeness + 0.2 * deadScore + 0.05 * snapped);

      const reasons = [
        `hook: ${hook.reason}`,
        `speech density ${(spanWords.length / dur).toFixed(1)} words/s`,
        endsClean ? "ends on a complete sentence" : "ends without closing punctuation",
        dead > 0 ? `${(dead / 1000).toFixed(1)} s of dead air` : "no dead air",
      ];
      if (sCut !== undefined || eCut !== undefined) reasons.push(`snapped to shot cut${sCut !== undefined && eCut !== undefined ? "s" : ""}`);
      spans.push({ first: i, last: j, start_sec: start, end_sec: end, score, reasons });
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

  const picked = scoreShorts(words, cuts, { min_sec: min, max_sec: max, count, ...(duration ? { duration_sec: duration } : {}) });
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
    lines.push(`- ${c.id} ${c.start_sec.toFixed(1)}–${c.end_sec.toFixed(1)} s (${(c.end_sec - c.start_sec).toFixed(1)} s), score ${c.score.toFixed(2)}`);
    lines.push(`  hook: "${c.hook}"`);
    lines.push(`  why: ${c.reasons.join("; ")}`);
    const refs = s.evidence_refs?.[c.id];
    if (refs?.length) lines.push(`  claim_refs: ${refs.join(", ")}`);
  }
  return lines.join("\n");
}

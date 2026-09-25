import type { WordTiming } from "@video-studio/schema";

const WORDLIKE = /[\p{L}\p{N}]/u;

/**
 * Split text into caption/speech words on whitespace. Punctuation-only tokens ("—", "-", "…")
 * are attached to the preceding word (or the following one when there is none).
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  let pending = "";
  for (const t of text.split(/\s+/)) {
    if (!t) continue;
    if (!WORDLIKE.test(t)) {
      if (out.length) out[out.length - 1] += t;
      else pending += t;
      continue;
    }
    out.push(pending + t);
    pending = "";
  }
  return out;
}

const VOWEL_GROUP = /[aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýÿœ]+/g;

/**
 * Rough syllable count (vowel-group heuristic), minimum 1:
 * - vowel groups, minus a silent trailing "e" (but not "-le");
 * - short all-caps tokens (acronyms like "API", "CI/CD") count one per letter (spelled out);
 * - words with no Latin vowels (e.g. CJK, "HTTP") count one per letter;
 * - each digit adds one.
 */
export function estimateSyllables(word: string): number {
  const digits = (word.match(/\p{N}/gu) ?? []).length;
  const lettersRaw = word.replace(/[^\p{L}]/gu, "");
  let n = 0;
  if (lettersRaw) {
    const isAcronym = lettersRaw.length >= 2 && lettersRaw.length <= 5 && lettersRaw === lettersRaw.toUpperCase() && lettersRaw !== lettersRaw.toLowerCase();
    const letters = lettersRaw.toLowerCase();
    if (isAcronym) {
      n = letters.length;
    } else {
      n = (letters.match(VOWEL_GROUP) ?? []).length;
      if (n > 1 && /[^aeiouy]e$/.test(letters) && !/[^aeiouy]le$/.test(letters)) n--;
      if (n === 0) n = letters.length;
    }
  }
  return Math.max(1, n + digits);
}

const TRAIL_CLOSERS = `["')\\]}»”’]*$`;
const SENTENCE_END = new RegExp(`[.!?…]${TRAIL_CLOSERS}`, "u");
const CLAUSE_END = new RegExp(`[,;:—–-]${TRAIL_CLOSERS}`, "u");

/** Extra pause weight after a word: sentence end 1.2, clause punctuation 0.6, else 0. */
export function pauseWeight(word: string): number {
  if (SENTENCE_END.test(word)) return 1.2;
  if (CLAUSE_END.test(word)) return 0.6;
  return 0;
}

export interface EstimateOptions {
  /** Leading silence to skip before the first word. */
  leadMs?: number;
  /** Trailing silence after the last word. */
  trailMs?: number;
  /** Weight each word equally and add no pauses (silent mode). */
  even?: boolean;
}

/**
 * Distribute `durationMs` (minus edge silence) across `words`, weighted by estimated syllables,
 * with pauses after punctuation (not after the last word). Timings are integer ms, monotonic
 * and non-overlapping; the first word starts at `leadMs`, the last ends at `durationMs - trailMs`.
 */
export function estimateWordTimings(words: string[], durationMs: number, opts: EstimateOptions = {}): WordTiming[] {
  if (words.length === 0) return [];
  const total = Math.max(0, Math.round(durationMs));
  let lead = Math.max(0, Math.round(opts.leadMs ?? 0));
  let trail = Math.max(0, Math.round(opts.trailMs ?? 0));
  if (lead + trail >= total) {
    lead = 0;
    trail = 0;
  }
  const spanStart = lead;
  const spanEnd = total - trail;
  const weights = words.map((w) => (opts.even ? 1 : estimateSyllables(w)));
  const pauses = words.map((w, i) => (opts.even || i === words.length - 1 ? 0 : pauseWeight(w)));
  const units = weights.reduce((a, b) => a + b, 0) + pauses.reduce((a, b) => a + b, 0);
  const perUnit = (spanEnd - spanStart) / units;
  const out: WordTiming[] = [];
  let cursor = 0;
  let prevEnd = spanStart;
  words.forEach((word, i) => {
    const startF = spanStart + cursor * perUnit;
    cursor += weights[i]!;
    const endF = i === words.length - 1 ? spanEnd : spanStart + cursor * perUnit;
    cursor += pauses[i]!;
    const start = Math.max(prevEnd, Math.round(startF));
    const end = Math.max(start, Math.round(endF));
    out.push({ word, start_ms: start, end_ms: end });
    prevEnd = end;
  });
  return out;
}

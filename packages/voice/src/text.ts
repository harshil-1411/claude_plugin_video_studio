import type { Brand, WordTiming } from "@video-studio/schema";
import { estimateSyllables, tokenize } from "./estimate.js";

/** A run of caption words and the speech words they were turned into. End indices are exclusive. */
export interface TokenSpan {
  captionStart: number;
  captionEnd: number;
  speechStart: number;
  speechEnd: number;
}

export interface PreparedText {
  /** Text sent to the TTS engine (pronunciation replacements applied). */
  speech: string;
  /** Tokens of `speech` (what backend timings refer to). */
  speechWords: string[];
  /** Original words, shown in captions. */
  captionWords: string[];
  /** Ordered, contiguous mapping between caption and speech tokens. */
  spans: TokenSpan[];
}

const LEADING_PUNCT = /^["'(\[{«“‘¿¡]+/u;
const TRAILING_PUNCT = /["')\]}»”’.,;:!?…]+$/u;

function core(token: string): string {
  return token.replace(LEADING_PUNCT, "").replace(TRAILING_PUNCT, "");
}

interface Rule {
  from: string[];
  to: string[];
}

function rulesFrom(terms: Record<string, string>): Rule[] {
  return Object.entries(terms)
    .map(([from, to]) => ({ from: tokenize(from).map(core), to: tokenize(to) }))
    .filter((r) => r.from.length > 0 && r.from.every(Boolean))
    .sort((a, b) => b.from.length - a.from.length || b.from.join(" ").length - a.from.join(" ").length);
}

/**
 * Apply brand pronunciation/terminology overrides (`brand.language.terminology`, e.g.
 * {"CI/CD": "C I C D"}) to produce the speech text, while keeping the original words for captions.
 *
 * Matching is token-based and case-sensitive on the token with surrounding punctuation stripped, so
 * "CI/CD," matches "CI/CD" and the trailing comma is carried onto the last speech token (preserving
 * the pause). Longer terms win. Terms embedded inside a larger token (e.g. "CI/CD-based") are not
 * replaced.
 */
export function prepareSpeechText(voiceover: string, brand?: Pick<Brand, "language"> | null, extra?: Record<string, string>): PreparedText {
  const captionWords = tokenize(voiceover);
  const rules = rulesFrom({ ...(brand?.language?.terminology ?? {}), ...(extra ?? {}) });
  const speechWords: string[] = [];
  const spans: TokenSpan[] = [];
  let i = 0;
  while (i < captionWords.length) {
    const rule = rules.find((r) => r.from.every((f, k) => i + k < captionWords.length && core(captionWords[i + k]!) === f));
    if (rule) {
      const n = rule.from.length;
      const first = captionWords[i]!;
      const last = captionWords[i + n - 1]!;
      const lead = LEADING_PUNCT.exec(first)?.[0] ?? "";
      const trail = TRAILING_PUNCT.exec(last)?.[0] ?? "";
      const to = [...rule.to];
      if (to.length) {
        to[0] = lead + to[0];
        to[to.length - 1] = to[to.length - 1] + trail;
      }
      spans.push({ captionStart: i, captionEnd: i + n, speechStart: speechWords.length, speechEnd: speechWords.length + to.length });
      speechWords.push(...to);
      i += n;
    } else {
      spans.push({ captionStart: i, captionEnd: i + 1, speechStart: speechWords.length, speechEnd: speechWords.length + 1 });
      speechWords.push(captionWords[i]!);
      i += 1;
    }
  }
  return { speech: speechWords.join(" "), speechWords, captionWords, spans };
}

/** Split [start, end] across words weighted by syllables; monotonic integer ms. */
function spread(words: string[], start: number, end: number): WordTiming[] {
  const weights = words.map(estimateSyllables);
  const total = weights.reduce((a, b) => a + b, 0);
  const out: WordTiming[] = [];
  let acc = 0;
  let prev = start;
  words.forEach((word, k) => {
    const s = prev;
    acc += weights[k]!;
    const e = k === words.length - 1 ? end : Math.max(s, Math.round(start + ((end - start) * acc) / total));
    out.push({ word, start_ms: s, end_ms: e });
    prev = e;
  });
  return out;
}

/**
 * Map timings of speech tokens back onto the original caption words.
 *
 * - 1:1 spans copy the timing (with the caption spelling).
 * - A replaced span (e.g. "CI/CD" → "C I C D") takes the time range from its first to its last
 *   speech token and spreads it across its caption words by syllable weight.
 * - A span whose replacement is empty gets zero-width timings at the previous word's end.
 * - Fallback when `timings` does not have one entry per speech token (e.g. a provider normalized
 *   the text differently): the whole range [first start, last end] is spread across all caption
 *   words by syllable weight.
 */
export function mapTimingsToCaptions(prepared: PreparedText, timings: WordTiming[]): WordTiming[] {
  const { captionWords, spans, speechWords } = prepared;
  if (captionWords.length === 0) return [];
  if (timings.length === 0) return spread(captionWords, 0, 0);
  if (timings.length !== speechWords.length) {
    return spread(captionWords, timings[0]!.start_ms, timings[timings.length - 1]!.end_ms);
  }
  const out: WordTiming[] = [];
  let prevEnd = timings[0]!.start_ms;
  for (const span of spans) {
    const words = captionWords.slice(span.captionStart, span.captionEnd);
    if (span.speechEnd === span.speechStart) {
      for (const word of words) out.push({ word, start_ms: prevEnd, end_ms: prevEnd });
      continue;
    }
    const first = timings[span.speechStart]!;
    const last = timings[span.speechEnd - 1]!;
    if (words.length === span.speechEnd - span.speechStart) {
      words.forEach((word, k) => {
        const t = timings[span.speechStart + k]!;
        out.push({ word, start_ms: t.start_ms, end_ms: t.end_ms });
      });
    } else {
      out.push(...spread(words, first.start_ms, last.end_ms));
    }
    prevEnd = last.end_ms;
  }
  return out;
}

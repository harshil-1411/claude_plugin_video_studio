import type { WordTiming } from "@video-studio/schema";

const WORDLIKE = /[\p{L}\p{N}]/u;

// ---------------------------------------------------------------------------------- scripts
// Small copies of packages/renderer/src/script.ts (voice cannot depend on the renderer).

/** CJK characters that are each a caption/speech unit: ideographs, kana, full-width letters and digits. */
const CJK_UNIT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}０-９Ａ-Ｚａ-ｚｦ-ﾟ]/u;
/** Any CJK character, punctuation included. */
const CJK_ANY = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}　-〿！-｠・ー]/u;
/** Kinsoku: never at the start of a unit (glued to the unit before): closing punctuation, small kana, ー. */
const NO_START = new Set(Array.from("、。，．,.!?！？)）]］}｝〕〉》」』】〙〗〟’”»ー―‐〜～…‥・:;：；々〻ゝゞヽヾぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ%％"));
/** Kinsoku: never at the end of a unit (glued to the unit after): opening brackets. */
const NO_END = new Set(Array.from("(（[［{｛〔〈《「『【〘〖〝‘“«"));

/** True for a character that is a speech/caption unit of its own (ideograph, kana, full-width letter). */
export function isCjkUnitChar(ch: string): boolean {
  return CJK_UNIT.test(ch);
}

/** True for a character that joins the unit before it (closing punctuation, small kana, ー). */
export function isNoStartChar(ch: string): boolean {
  return NO_START.has(ch);
}

export type SpeechScript = "latin" | "cjk" | "devanagari" | "arabic" | "hebrew" | "other";

/** The script with the most letters in `text` (Latin when there are none). */
export function speechScript(text: string): SpeechScript {
  const n: Record<SpeechScript, number> = { latin: 0, cjk: 0, devanagari: 0, arabic: 0, hebrew: 0, other: 0 };
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    if (/[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/u.test(ch)) n.latin++;
    else if (CJK_ANY.test(ch)) n.cjk++;
    else if (/\p{Script=Devanagari}/u.test(ch)) n.devanagari++;
    else if (/\p{Script=Arabic}/u.test(ch)) n.arabic++;
    else if (/\p{Script=Hebrew}/u.test(ch)) n.hebrew++;
    else n.other++;
  }
  let best: SpeechScript = "latin";
  for (const k of Object.keys(n) as SpeechScript[]) if (n[k] > n[best] || (n[k] === n[best] && n[k] > 0 && best === "latin")) best = k;
  return best;
}

/**
 * Split a whitespace-free token that contains CJK into units: each CJK character is a unit,
 * runs of other characters (Latin words, ASCII digits) stay whole, closing punctuation and
 * small kana join the unit before, opening brackets the unit after.
 */
function splitCjk(token: string): string[] {
  const units: string[] = [];
  let buf = "";
  let prefix = "";
  const flush = () => {
    if (!buf) return;
    units.push(prefix + buf);
    prefix = "";
    buf = "";
  };
  for (const ch of token) {
    if (NO_START.has(ch)) {
      if (buf) buf += ch;
      else if (units.length && !prefix) units[units.length - 1] += ch;
      else prefix += ch;
      continue;
    }
    if (NO_END.has(ch)) {
      flush();
      prefix += ch;
      continue;
    }
    if (CJK_UNIT.test(ch)) {
      flush();
      units.push(prefix + ch);
      prefix = "";
      continue;
    }
    buf += ch;
  }
  flush();
  if (prefix) {
    if (units.length) units[units.length - 1] += prefix;
    else units.push(prefix);
  }
  return units;
}

/**
 * Split text into caption/speech words on whitespace. Punctuation-only tokens ("—", "-", "…")
 * are attached to the preceding word (or the following one when there is none). CJK text has
 * no spaces: each ideograph or kana is its own word (with kinsoku-glued punctuation), so
 * captions can break between characters and karaoke sweeps per character.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  let pending = "";
  for (const t of text.split(/\s+/).flatMap((tok) => (CJK_ANY.test(tok) ? splitCjk(tok) : [tok]))) {
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
  const script = speechScript(word);
  if (script === "cjk") return cjkMorae(word);
  if (script === "devanagari") return devanagariSyllables(word);
  if (script === "arabic" || script === "hebrew") {
    // Short vowels are not written: about one syllable per two letters.
    const letters = (word.match(/\p{L}/gu) ?? []).length;
    return Math.max(1, Math.round(letters / 2) + (word.match(/\p{N}/gu) ?? []).length);
  }
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

/** Morae weight of a CJK unit: kana 1 each (small kana 0), ー 1, an ideograph KANJI_MORAE, other characters as Latin. */
export const KANJI_MORAE = 1.6;
function cjkMorae(word: string): number {
  let n = 0;
  let rest = "";
  for (const ch of word) {
    if (/[ぁぃぅぇぉっゃゅょゎァィゥェォャュョヮ]/u.test(ch)) n += ch === "っ" || ch === "ッ" ? 1 : 0;
    else if (/[\p{Script=Hiragana}\p{Script=Katakana}ー]/u.test(ch)) n += 1;
    else if (/\p{Script=Han}/u.test(ch)) n += KANJI_MORAE;
    else if (/[\p{L}\p{N}]/u.test(ch)) rest += ch;
  }
  return Math.max(1, n + (rest ? estimateSyllables(rest) : 0));
}

/** Devanagari: one syllable per consonant or independent vowel, minus the consonants a virama joins into a conjunct. */
function devanagariSyllables(word: string): number {
  const letters = (word.match(/[ऄ-हक़-ॡॲ-ॿ]/gu) ?? []).length;
  const viramas = (word.match(/्/gu) ?? []).length;
  const digits = (word.match(/\p{N}/gu) ?? []).length;
  return Math.max(1, letters - viramas + digits);
}

// ---------------------------------------------------------------------------------- speaking rates

/**
 * Speaking rates for duration estimates (design rules, not measurements of any one voice):
 * - Latin-script languages: words per second at the system voice's 180 wpm (3 words/s).
 * - Japanese / Chinese: characters per second (CJK_CHARS_PER_SEC, about 7.5; natural Japanese
 *   narration runs 7–8 characters/s of mixed kanji and kana).
 * - Hindi (Devanagari): 2.5 words/s; Arabic 2.2 words/s (clitics make words longer); Hebrew 2.5.
 */
export const SPEECH_RATES = Object.freeze({
  latin_words_per_sec: 3,
  cjk_chars_per_sec: 7.5,
  devanagari_words_per_sec: 2.5,
  arabic_words_per_sec: 2.2,
  hebrew_words_per_sec: 2.5,
  other_words_per_sec: 2.5,
});

/** Count what the rate counts: CJK characters (letters and digits, not punctuation) or whitespace words. */
export function speechUnits(text: string): { script: SpeechScript; unit: "chars" | "words"; count: number } {
  const script = speechScript(text);
  if (script === "cjk") {
    let count = 0;
    for (const ch of text) if (CJK_UNIT.test(ch) || /[\p{L}\p{N}]/u.test(ch)) count++;
    return { script, unit: "chars", count };
  }
  return { script, unit: "words", count: text.split(/\s+/).filter((w) => WORDLIKE.test(w)).length };
}

/** Estimated narration time of `text` in seconds (see SPEECH_RATES), without pauses. */
export function estimateSpeechSec(text: string): number {
  const { script, count } = speechUnits(text);
  const rate =
    script === "cjk"
      ? SPEECH_RATES.cjk_chars_per_sec
      : script === "devanagari"
        ? SPEECH_RATES.devanagari_words_per_sec
        : script === "arabic"
          ? SPEECH_RATES.arabic_words_per_sec
          : script === "hebrew"
            ? SPEECH_RATES.hebrew_words_per_sec
            : script === "other"
              ? SPEECH_RATES.other_words_per_sec
              : SPEECH_RATES.latin_words_per_sec;
  return Math.round((count / rate) * 100) / 100;
}

const TRAIL_CLOSERS = `["')\\]}»”’」』）]*$`;
const SENTENCE_END = new RegExp(`[.!?…。！？]${TRAIL_CLOSERS}`, "u");
const CLAUSE_END = new RegExp(`[,;:—–\\-、，；：]${TRAIL_CLOSERS}`, "u");

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

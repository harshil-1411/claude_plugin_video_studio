/**
 * Writing-system detection for layout, fonts, direction and timing.
 *
 * Scripts are grouped by what the renderers must do differently, not by Unicode's full list:
 * - `latin`: Latin, Greek and Cyrillic (the bundled Inter / Noto Sans cover them; spaces separate words)
 * - `cjk`: Han, Hiragana, Katakana, Bopomofo and full-width forms (no spaces; ~1 em per character)
 * - `hangul`: Korean (full-width syllables, but words are separated by spaces)
 * - `devanagari`: Hindi, Marathi, Nepali, Sanskrit (needs shaping: conjuncts, reordered vowel signs)
 * - `arabic`, `hebrew`: right-to-left (Arabic also joins letters)
 * - `other`: any other letters (Thai, Bengali, Tamil, …): shaped by libass/Chrome with host fonts
 *
 * Digits, punctuation, symbols and spaces are neutral: they take the script of the text around them.
 * `packages/media/src/captions.ts` and `packages/voice/src/estimate.ts` keep small copies of the
 * CJK and RTL tests below (those packages cannot depend on the renderer); keep them in step.
 */

export type Script = "latin" | "cjk" | "hangul" | "devanagari" | "arabic" | "hebrew" | "other";

export const SCRIPTS: readonly Script[] = ["latin", "cjk", "hangul", "devanagari", "arabic", "hebrew", "other"];

const RE = {
  latin: /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/u,
  cjk: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}]/u,
  hangul: /\p{Script=Hangul}/u,
  devanagari: /\p{Script=Devanagari}/u,
  arabic: /\p{Script=Arabic}/u,
  hebrew: /\p{Script=Hebrew}/u,
} as const;
const LETTER = /[\p{L}\p{M}]/u;
/** CJK punctuation, full-width forms and the prolonged sound mark: neutral, but 1 em wide. */
const WIDE_NEUTRAL = /[　-〿！-｠￠-￦・ー]/u;

/** Script of one character (a code point), or null for neutral characters (digits, punctuation, spaces). */
export function charScript(ch: string): Script | null {
  if (!LETTER.test(ch)) return null;
  if (RE.latin.test(ch)) return "latin";
  if (RE.cjk.test(ch)) return "cjk";
  if (RE.hangul.test(ch)) return "hangul";
  if (RE.devanagari.test(ch)) return "devanagari";
  if (RE.arabic.test(ch)) return "arabic";
  if (RE.hebrew.test(ch)) return "hebrew";
  // Combining marks of common scripts (e.g. U+0301) are neutral; other letters and marks are "other".
  if (/\p{Script=Inherited}|\p{Script=Common}/u.test(ch)) return null;
  return "other";
}

/** Letters per script in `text`. */
export function scriptCounts(text: string): Record<Script, number> {
  const out: Record<Script, number> = { latin: 0, cjk: 0, hangul: 0, devanagari: 0, arabic: 0, hebrew: 0, other: 0 };
  for (const ch of text) {
    const s = charScript(ch);
    if (s) out[s]++;
  }
  return out;
}

/** Scripts with at least one letter in `text`. */
export function scriptsIn(text: string): Script[] {
  const c = scriptCounts(text);
  return SCRIPTS.filter((s) => c[s] > 0);
}

/**
 * The script with the most letters (ties go to the non-Latin script, so "API का उपयोग" is
 * Devanagari). Text without letters is `latin`.
 */
export function dominantScript(text: string): Script {
  const c = scriptCounts(text);
  let best: Script = "latin";
  for (const s of SCRIPTS) if (c[s] > c[best] || (c[s] === c[best] && c[s] > 0 && best === "latin")) best = s;
  return best;
}

/** True for characters drawn about 1 em wide: CJK ideographs, kana, Hangul, full-width forms and CJK punctuation. */
export function isWideChar(ch: string): boolean {
  if (WIDE_NEUTRAL.test(ch)) return true;
  const s = charScript(ch);
  if (s === "cjk") return !/[ｦ-ﾟ]/u.test(ch); // half-width katakana are half width
  return s === "hangul";
}

/** True when `text` contains CJK characters (ideographs, kana or CJK punctuation), which break between characters. */
export function hasCjk(text: string): boolean {
  for (const ch of text) if (charScript(ch) === "cjk" || WIDE_NEUTRAL.test(ch)) return true;
  return false;
}

export const RTL_SCRIPTS: ReadonlySet<Script> = new Set(["arabic", "hebrew"]);
/** Scripts FFmpeg drawtext cannot shape without FriBidi (reordering, joining, conjuncts). */
export const COMPLEX_SCRIPTS: ReadonlySet<Script> = new Set(["devanagari", "arabic", "hebrew", "other"]);

export function isRtlScript(s: Script): boolean {
  return RTL_SCRIPTS.has(s);
}

/** True when `text` has letters of a script that needs shaping or bidi (Devanagari, Arabic, Hebrew, other). */
export function needsShaping(text: string): boolean {
  return scriptsIn(text).some((s) => COMPLEX_SCRIPTS.has(s));
}

/**
 * Direction of a line from its strong letters: `rtl` when all are Arabic/Hebrew, `ltr` when none
 * are, `mixed` when both occur. Lines without letters are `ltr`.
 */
export function textDirection(text: string): "ltr" | "rtl" | "mixed" {
  let rtl = 0;
  let ltr = 0;
  for (const ch of text) {
    const s = charScript(ch);
    if (!s) continue;
    if (isRtlScript(s)) rtl++;
    else ltr++;
  }
  return rtl === 0 ? "ltr" : ltr === 0 ? "rtl" : "mixed";
}

/**
 * Base direction of a paragraph, as the Unicode bidi algorithm (rules P2–P3) and libass /
 * `unicode-bidi: plaintext` pick it: the direction of the first strong letter; the language's
 * direction when there is none.
 */
export function baseDirection(text: string, language?: string): "ltr" | "rtl" {
  for (const ch of text) {
    const s = charScript(ch);
    if (s) return isRtlScript(s) ? "rtl" : "ltr";
  }
  const langScript = languageScript(language);
  return langScript && isRtlScript(langScript) ? "rtl" : "ltr";
}

// ---------------------------------------------------------------------------------- languages

const LANGUAGE_SCRIPTS: Record<string, Script> = {
  ja: "cjk",
  zh: "cjk",
  yue: "cjk",
  ko: "hangul",
  hi: "devanagari",
  mr: "devanagari",
  ne: "devanagari",
  sa: "devanagari",
  kok: "devanagari",
  mai: "devanagari",
  ar: "arabic",
  fa: "arabic",
  ur: "arabic",
  ps: "arabic",
  ckb: "arabic",
  he: "hebrew",
  iw: "hebrew",
  yi: "hebrew",
  th: "other",
  lo: "other",
  km: "other",
  my: "other",
  bn: "other",
  pa: "other",
  gu: "other",
  or: "other",
  ta: "other",
  te: "other",
  kn: "other",
  ml: "other",
  si: "other",
  am: "other",
  ka: "other",
  hy: "other",
};

/** Primary subtag of a BCP-47 tag, lower case (`pt-BR` → `pt`). */
export function baseLanguage(language: string | undefined): string | undefined {
  const base = language?.trim().split(/[-_]/)[0]?.toLowerCase();
  return base || undefined;
}

/** The script a language is normally written in (Latin for unknown or Latin-script languages); undefined without a language. */
export function languageScript(language: string | undefined): Script | undefined {
  const base = baseLanguage(language);
  if (!base) return undefined;
  // Script subtags win: sr-Latn, uz-Cyrl, pa-Arab, zh-Hant.
  const sub = language!.split(/[-_]/).slice(1).find((p) => p.length === 4)?.toLowerCase();
  if (sub) {
    const bySub: Record<string, Script> = { latn: "latin", cyrl: "latin", grek: "latin", hans: "cjk", hant: "cjk", jpan: "cjk", hani: "cjk", kore: "hangul", hang: "hangul", deva: "devanagari", arab: "arabic", hebr: "hebrew" };
    if (bySub[sub]) return bySub[sub];
  }
  return LANGUAGE_SCRIPTS[base] ?? "latin";
}

export function isRtlLanguage(language: string | undefined): boolean {
  const s = languageScript(language);
  return s !== undefined && isRtlScript(s);
}

/** A `lang` attribute for HTML: the spec language, else a guess from the script (undefined for Latin). */
export function htmlLang(language: string | undefined, script: Script): string | undefined {
  if (language && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) return language;
  const guess: Partial<Record<Script, string>> = { cjk: "ja", hangul: "ko", devanagari: "hi", arabic: "ar", hebrew: "he" };
  return guess[script];
}

// ---------------------------------------------------------------------------------- fonts per script

/**
 * Font families that cover a script, best first. Bundled families (fonts/) come first; the host
 * families after them are only reached when the bundled files are missing. Latin needs none
 * (the token chains already cover it); `other` has no bundled font and relies on host fonts.
 */
export function scriptFontFamilies(script: Script, language?: string): string[] {
  const base = baseLanguage(language);
  switch (script) {
    case "cjk":
      if (base === "zh") return /hant|tw|hk|mo/i.test(language ?? "") ? ["Noto Sans TC", "PingFang TC", "Noto Sans JP"] : ["Noto Sans SC", "PingFang SC", "Noto Sans JP"];
      if (base === "ko") return ["Noto Sans KR", "Apple SD Gothic Neo", "Noto Sans JP"];
      return ["Noto Sans JP", "Hiragino Sans", "Yu Gothic"];
    case "hangul":
      return ["Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic"];
    case "devanagari":
      return ["Noto Sans Devanagari", "Kohinoor Devanagari", "Nirmala UI"];
    case "arabic":
      return ["Noto Sans Arabic", "Geeza Pro", "Segoe UI"];
    case "hebrew":
      return ["Noto Sans Hebrew", "Arial Hebrew", "Arial"];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------------- line breaking

/**
 * Kinsoku shori (Japanese line-breaking rules, JIS X 4051 basic set): characters that may not
 * start a line (closing brackets, small kana, prolonged sound mark, sentence and clause
 * punctuation) and characters that may not end one (opening brackets).
 */
export const KINSOKU_NO_START = new Set(
  Array.from("、。，．,.!?！？)）]］}｝〕〉》」』】〙〗〟’”»ー―‐〜～…‥・:;：；/々〻ゝゞヽヾぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ%％"),
);
export const KINSOKU_NO_END = new Set(Array.from("(（[［{｛〔〈《「『【〘〖〝‘“«"));

/** A breakable unit of text: a word (spaced scripts) or a character with its glued punctuation (CJK). */
export interface BreakUnit {
  text: string;
  /** A space separates this unit from the previous one (dropped at line starts). */
  space: boolean;
}

/**
 * Split text into line-break units. Spaced scripts break at spaces only; CJK characters are
 * each a unit, with kinsoku applied (no-start characters glue to the unit before them, no-end
 * characters to the unit after them). Latin words inside CJK text stay whole.
 */
export function breakUnits(text: string): BreakUnit[] {
  const units: BreakUnit[] = [];
  let word = "";
  let space = false;
  let prefix = ""; // pending no-end characters (opening brackets)
  const flushWord = () => {
    if (!word) return;
    units.push({ text: prefix + word, space });
    prefix = "";
    word = "";
    space = false;
  };
  for (const ch of text) {
    if (/\s/u.test(ch)) {
      flushWord();
      if (units.length || prefix) space = true;
      continue;
    }
    const wide = charScript(ch) === "cjk" || WIDE_NEUTRAL.test(ch);
    if (KINSOKU_NO_START.has(ch) && !word && !prefix && units.length && !space) {
      units[units.length - 1]!.text += ch; // glue to the previous unit (never start a line with it)
      continue;
    }
    if (KINSOKU_NO_START.has(ch) && word) {
      word += ch;
      continue;
    }
    if (KINSOKU_NO_END.has(ch)) {
      if (word && !wide) {
        // "(" inside a Latin word, e.g. f(x): keep it in the word
        word += ch;
        continue;
      }
      flushWord();
      prefix += ch;
      continue;
    }
    if (wide) {
      flushWord();
      units.push({ text: prefix + ch, space });
      prefix = "";
      space = false;
      continue;
    }
    word += ch;
  }
  flushWord();
  if (prefix) {
    if (units.length && !space) units[units.length - 1]!.text += prefix;
    else units.push({ text: prefix, space });
  }
  return units;
}

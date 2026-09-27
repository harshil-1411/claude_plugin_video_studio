/**
 * Channel glossary: the correct spelling of names and terms, and the ways speech recognition
 * mishears them. It corrects transcript and caption words (timings kept) and seeds the whisper
 * prompt. TTS pronunciation (brand `terminology`) is separate and never changed here.
 */

/** Mirrors `GlossaryEntry` in @video-studio/schema (media does not depend on the schema's zod types at runtime). */
export interface GlossaryTerm {
  term: string;
  variants?: readonly string[] | undefined;
  case_sensitive?: boolean | undefined;
}

/** A word with timings; extra fields (speaker, scene_id, …) are carried over from the first matched word. */
export interface GlossaryWord {
  word: string;
  start_ms: number;
  end_ms: number;
  scene_id?: string | undefined;
}

export interface GlossaryCorrection {
  /** What the words said, joined with spaces (punctuation included). */
  from: string;
  /** What they say now. */
  to: string;
  term: string;
  start_ms: number;
  end_ms: number;
  /** Index of the first replaced word in the input list. */
  index: number;
  /** How many input words were replaced. */
  words: number;
}

/**
 * Brand glossary added to the series glossary: one entry per term (compared ignoring case);
 * when both define a term, the brand's spelling and case rule win and the variants are merged.
 */
export function mergeGlossary(...lists: ReadonlyArray<readonly GlossaryTerm[] | undefined>): GlossaryTerm[] {
  const byTerm = new Map<string, GlossaryTerm>();
  for (const list of lists) {
    for (const e of list ?? []) {
      const term = e.term.trim();
      if (!term) continue;
      const key = term.toLowerCase();
      const prev = byTerm.get(key);
      const variants = [...new Set([...(prev?.variants ?? []), ...(e.variants ?? [])].map((v) => v.trim()).filter(Boolean))];
      const cs = e.case_sensitive ?? prev?.case_sensitive;
      byTerm.set(key, { term, ...(variants.length ? { variants } : {}), ...(cs !== undefined ? { case_sensitive: cs } : {}) });
    }
  }
  return [...byTerm.values()];
}

const EDGE_PUNCT = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su;

function splitPunct(word: string): { lead: string; core: string; trail: string } {
  const m = EDGE_PUNCT.exec(word)!;
  return { lead: m[1] ?? "", core: m[2] ?? "", trail: m[3] ?? "" };
}

interface Pattern {
  tokens: string[];
  caseSensitive: boolean;
  entry: GlossaryTerm;
}

function patterns(glossary: readonly GlossaryTerm[]): Pattern[] {
  const out: Pattern[] = [];
  for (const entry of glossary) {
    const cs = entry.case_sensitive === true;
    for (const v of entry.variants ?? []) {
      const tokens = v
        .trim()
        .split(/\s+/)
        .map((t) => splitPunct(t).core)
        .filter(Boolean)
        .map((t) => (cs ? t : t.toLowerCase()));
      if (tokens.length) out.push({ tokens, caseSensitive: cs, entry });
    }
  }
  // Longest variant first, so "M S B docks" wins over "docks".
  return out.sort((a, b) => b.tokens.length - a.tokens.length);
}

/**
 * Replace mishearings (`variants`) with the glossary `term`. Matching compares words without
 * their leading/trailing punctuation, ignores case unless `case_sensitive`, and may span
 * consecutive words ("M S B docks" → "MSB Docs"); the first word's leading and the last word's
 * trailing punctuation are kept. Only variants are matched, never the term itself (a term like
 * "RAG" would otherwise rewrite the everyday word "rag"); list a casing mishearing as a variant.
 *
 * Timings: when the term has as many words as the match, each word keeps its own timing;
 * otherwise the term's words are spread evenly over the matched span (first start to last end),
 * so the span, and every word outside it, keep their timings exactly. Words from different
 * scenes (`scene_id`) are never joined into one match.
 */
export function applyGlossary<W extends GlossaryWord>(words: readonly W[], glossary: readonly GlossaryTerm[] | undefined): { words: W[]; corrections: GlossaryCorrection[] } {
  const pats = patterns(glossary ?? []);
  if (!pats.length) return { words: [...words], corrections: [] };
  const cores = words.map((w) => splitPunct(w.word).core);
  const lower = cores.map((c) => c.toLowerCase());
  const out: W[] = [];
  const corrections: GlossaryCorrection[] = [];
  let i = 0;
  while (i < words.length) {
    const hit = pats.find((p) => {
      if (i + p.tokens.length > words.length) return false;
      const scene = words[i]!.scene_id;
      return p.tokens.every((t, k) => (p.caseSensitive ? cores[i + k] : lower[i + k]) === t && words[i + k]!.scene_id === scene);
    });
    if (!hit) {
      out.push(words[i]!);
      i++;
      continue;
    }
    const n = hit.tokens.length;
    const first = words[i]!;
    const last = words[i + n - 1]!;
    const lead = splitPunct(first.word).lead;
    const trail = splitPunct(last.word).trail;
    const termWords = hit.entry.term.trim().split(/\s+/);
    const k = termWords.length;
    const from = words.slice(i, i + n).map((w) => w.word).join(" ");
    const replaced: W[] = termWords.map((tw, j) => {
      const src = k === n ? words[i + j]! : first;
      const start = k === n ? src.start_ms : Math.round(first.start_ms + ((last.end_ms - first.start_ms) * j) / k);
      const end = k === n ? src.end_ms : j === k - 1 ? last.end_ms : Math.round(first.start_ms + ((last.end_ms - first.start_ms) * (j + 1)) / k);
      const text = `${j === 0 ? lead : ""}${tw}${j === k - 1 ? trail : ""}`;
      return { ...src, word: text, start_ms: start, end_ms: end };
    });
    const to = replaced.map((w) => w.word).join(" ");
    if (to !== from) corrections.push({ from, to, term: hit.entry.term, start_ms: first.start_ms, end_ms: last.end_ms, index: i, words: n });
    out.push(...(to !== from ? replaced : words.slice(i, i + n)));
    i += n;
  }
  return { words: out, corrections };
}

/** Longest whisper `--prompt` built from a glossary (whisper keeps about 224 prompt tokens). */
export const GLOSSARY_PROMPT_MAX_CHARS = 400;

/**
 * A whisper `--prompt` from glossary terms: deduplicated ignoring case, in glossary order,
 * joined with commas and cut at the last whole term that fits `maxChars`. Undefined when empty.
 * The prompt nudges spelling; it is a hint, the glossary pass still corrects what whisper writes.
 */
export function glossaryPrompt(glossary: readonly GlossaryTerm[] | undefined, maxChars = GLOSSARY_PROMPT_MAX_CHARS): string | undefined {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const e of glossary ?? []) {
    const t = e.term.trim().replace(/\s+/g, " ");
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    terms.push(t);
  }
  let prompt = "";
  for (const t of terms) {
    const next = prompt ? `${prompt}, ${t}` : t;
    if (next.length + 1 > maxChars) break;
    prompt = next;
  }
  return prompt ? `${prompt}.` : undefined;
}

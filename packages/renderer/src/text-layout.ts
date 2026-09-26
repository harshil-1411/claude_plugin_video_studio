import { type LayoutZones, layoutZones } from "@video-studio/platforms";
import { breakUnits, charScript, isWideChar } from "./script.js";
import type { RenderTarget } from "./types.js";

/**
 * Pure text layout for renderers that cannot measure text (FFmpeg drawtext). Widths are
 * estimated from an average glyph advance per font size (0.55 em proportional, 0.6 em mono),
 * which is deliberately a little generous for typical sans fonts so wrapped lines fit.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const CHAR_EM = { proportional: 0.55, mono: 0.6 } as const;
export const DEFAULT_LINE_HEIGHT = 1.25;

export interface MeasureOptions {
  mono?: boolean;
  /** Average advance per character in em, overriding CHAR_EM (e.g. CHAR_EM_UPPER for capitals). */
  em?: number;
}

/** Average advance for upper-case text (capitals are wider than the mixed-case average). */
export const CHAR_EM_UPPER = 0.68;

function charEm(opts: MeasureOptions): number {
  return opts.em ?? (opts.mono ? CHAR_EM.mono : CHAR_EM.proportional);
}

/**
 * Average advances of non-Latin characters in em (design estimates, a little generous so wrapped
 * lines fit): CJK ideographs, kana, Hangul and full-width punctuation are square (1 em);
 * Devanagari consonants and vowels 0.6 em, spacing vowel signs 0.28 em, marks above/below 0;
 * joined Arabic letters 0.48 em, harakat 0; Hebrew letters 0.55 em, points 0.
 */
export const SCRIPT_EM = { wide: 1, devanagari: 0.6, devanagari_sign: 0.28, arabic: 0.48, hebrew: 0.55, other: 0.6 } as const;

/** Text made only of Latin-1/Latin Extended letters, general punctuation and ASCII: the original estimates apply unchanged. */
const SIMPLE = /^[\u0000-\u024F\u2000-\u206F\u20A0-\u20CF\u2100-\u214F]*$/u;

/** True when `text` needs the script-aware estimates (CJK, Hangul, Devanagari, Arabic, Hebrew, other scripts). */
export function isComplexText(text: string): boolean {
  if (SIMPLE.test(text)) return false;
  for (const ch of text) if (scriptEm(ch) !== null) return true;
  return false;
}

/** Advance of one character in em, or null when it takes the base (Latin/neutral) estimate. */
export function scriptEm(ch: string): number | null {
  if (isWideChar(ch)) return SCRIPT_EM.wide;
  const s = charScript(ch);
  if (s === null || s === "latin") return null;
  if (/\p{Mn}|\p{Me}/u.test(ch)) return 0;
  if (s === "devanagari") return /\p{Mc}/u.test(ch) ? SCRIPT_EM.devanagari_sign : SCRIPT_EM.devanagari;
  if (s === "arabic") return SCRIPT_EM.arabic;
  if (s === "hebrew") return SCRIPT_EM.hebrew;
  return /\p{Mc}/u.test(ch) ? SCRIPT_EM.devanagari_sign : SCRIPT_EM.other;
}

/**
 * Estimated rendered width in px. Latin and neutral characters use the base advance (`em`, or
 * CHAR_EM); CJK, Devanagari, Arabic and Hebrew characters use SCRIPT_EM.
 */
export function estimateTextWidth(text: string, fontSize: number, opts: MeasureOptions = {}): number {
  const em = charEm(opts);
  if (SIMPLE.test(text)) return Array.from(text).length * fontSize * em;
  let n = 0;
  let extra = 0;
  for (const ch of text) {
    const e = scriptEm(ch);
    if (e === null) n++;
    else extra += e;
  }
  return n * fontSize * em + extra * fontSize;
}

/** Break a unit wider than `maxWidth` into character pieces that each fit (at least one character each). */
function hardBreakWidth(unit: string, fontSize: number, maxWidth: number, opts: MeasureOptions): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of unit) {
    if (cur && estimateTextWidth(cur + ch, fontSize, opts) > maxWidth + 0.01) {
      out.push(cur);
      cur = ch;
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Width-based wrap for script-aware text: spaced scripts break at spaces, CJK between
 * characters with kinsoku (see `breakUnits`). Units wider than the line are hard-broken.
 */
function wrapComplex(para: string, fontSize: number, maxWidth: number, opts: MeasureOptions): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const u of breakUnits(para)) {
    const pieces = estimateTextWidth(u.text, fontSize, opts) > maxWidth + 0.01 ? hardBreakWidth(u.text, fontSize, maxWidth, opts) : [u.text];
    pieces.forEach((piece, k) => {
      const cand = cur ? `${cur}${u.space && k === 0 ? " " : ""}${piece}` : piece;
      if (!cur || estimateTextWidth(cand, fontSize, opts) <= maxWidth + 0.01) cur = cand;
      else {
        lines.push(cur);
        cur = piece;
      }
    });
  }
  if (cur) lines.push(cur);
  return lines;
}

/** The units that must stay whole on a line: words for spaced scripts, characters (with glued punctuation) for CJK. */
export function lineUnits(text: string): string[] {
  if (!isComplexText(text)) return text.split(/\s+/).filter(Boolean);
  return breakUnits(text).map((u) => u.text);
}

/** Break a single word that is wider than `maxWidth` into pieces that fit. */
function hardBreak(word: string, maxChars: number): string[] {
  const chars = Array.from(word);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += maxChars) out.push(chars.slice(i, i + maxChars).join(""));
  return out;
}

/** Greedy word wrap to `maxWidth` px. Explicit newlines are kept; over-long words are hard-broken. */
export function wrapText(text: string, fontSize: number, maxWidth: number, opts: MeasureOptions = {}): string[] {
  const em = charEm(opts);
  const maxChars = Math.max(1, Math.floor(maxWidth / (fontSize * em)));
  const lines: string[] = [];
  for (const para of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (isComplexText(para)) {
      const wrapped = wrapComplex(para, fontSize, maxWidth, opts);
      lines.push(...(wrapped.length ? wrapped : [""]));
      continue;
    }
    const words = para.split(/[ \t]+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let cur = "";
    for (const w of words) {
      const pieces = Array.from(w).length > maxChars ? hardBreak(w, maxChars) : [w];
      for (const piece of pieces) {
        const cand = cur ? `${cur} ${piece}` : piece;
        if (Array.from(cand).length <= maxChars) cur = cand;
        else {
          if (cur) lines.push(cur);
          cur = piece;
        }
      }
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

export interface FitOptions extends MeasureOptions {
  maxSize: number;
  minSize: number;
  lineHeight?: number;
  /** Do not wrap: each input line stays one line (code). */
  noWrap?: boolean;
  maxLines?: number;
}

export interface FitResult {
  fontSize: number;
  lines: string[];
  /** Line advance in px. */
  lineAdvance: number;
  /** Estimated block size in px. */
  width: number;
  height: number;
  /** True if the text did not fit at `minSize` and was truncated. */
  truncated: boolean;
}

function blockSize(lines: string[], size: number, lh: number, opts: MeasureOptions): { width: number; height: number } {
  return {
    width: Math.max(0, ...lines.map((l) => estimateTextWidth(l, size, opts))),
    height: lines.length ? size + (lines.length - 1) * size * lh : 0,
  };
}

function ellipsize(line: string, maxChars: number): string {
  const chars = Array.from(line);
  if (chars.length <= maxChars) return line;
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("").trimEnd()}…`;
}

/**
 * Largest font size in [minSize, maxSize] at which `text` (wrapped to the box width) fits the
 * box. At `minSize` any overflow is truncated (last line ellipsized) and `truncated` is set.
 */
export function fitText(text: string | readonly string[], box: { w: number; h: number }, opts: FitOptions): FitResult {
  const lh = opts.lineHeight ?? DEFAULT_LINE_HEIGHT;
  const paras = typeof text === "string" ? [text] : [...text];
  const layout = (size: number): string[] =>
    opts.noWrap ? paras.flatMap((p) => p.split("\n")) : paras.flatMap((p) => wrapText(p, size, box.w, opts));
  // Whole words must fit on a line: hard-breaking inside a word ("Thumbnai/l") is a last resort at the minimum size.
  // CJK text has no spaces: there the units are characters (with kinsoku-glued punctuation).
  const words = opts.noWrap ? [] : [...new Set(paras.flatMap((p) => lineUnits(p)))];
  const wordsFit = (size: number) => words.every((w) => blockSize([w], size, lh, opts).width <= box.w + 0.01);
  const fits = (lines: string[], size: number) => {
    const b = blockSize(lines, size, lh, opts);
    return b.width <= box.w + 0.01 && b.height <= box.h + 0.01 && (opts.maxLines === undefined || lines.length <= opts.maxLines) && (size <= min || wordsFit(size));
  };
  const max = Math.max(1, Math.floor(opts.maxSize));
  const min = Math.max(1, Math.min(max, Math.floor(opts.minSize)));
  let size = max;
  for (;;) {
    const lines = layout(size);
    if (fits(lines, size)) return { fontSize: size, lines, lineAdvance: size * lh, ...blockSize(lines, size, lh, opts), truncated: false };
    if (size <= min) break;
    size = Math.max(min, size > 40 ? Math.floor(size * 0.95) : size - 1);
  }
  // Truncate at the minimum size.
  const em = charEm(opts);
  const maxChars = Math.max(1, Math.floor(box.w / (size * em)));
  const maxLines = Math.max(1, Math.min(opts.maxLines ?? Infinity, Math.floor((box.h - size) / (size * lh)) + 1));
  let lines: string[];
  if (paras.some((p) => isComplexText(p))) {
    // Script-aware: cut by estimated width rather than character count.
    const fitW = (l: string) => {
      if (estimateTextWidth(l, size, opts) <= box.w + 0.01) return l;
      const chars = Array.from(l);
      while (chars.length > 1 && estimateTextWidth(`${chars.join("").trimEnd()}…`, size, opts) > box.w + 0.01) chars.pop();
      return `${chars.join("").trimEnd()}…`;
    };
    lines = layout(size).map(fitW);
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      const last = lines[maxLines - 1]!;
      lines[maxLines - 1] = last.endsWith("…") ? last : fitW(`${last}…`);
    }
  } else {
    lines = layout(size).map((l) => ellipsize(l, maxChars));
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      const last = lines[maxLines - 1]!;
      lines[maxLines - 1] = Array.from(last).length >= maxChars ? ellipsize(`${last}…`, maxChars) : `${last}…`;
    }
  }
  return { fontSize: size, lines, lineAdvance: size * lh, ...blockSize(lines, size, lh, opts), truncated: true };
}

export interface PlacedLine {
  text: string;
  /** Left edge (estimated for centred lines; renderers may centre exactly on `cx`). */
  x: number;
  /** Top of the line box (font ascent line). */
  y: number;
  /** Horizontal centre of the box the line is centred in. */
  cx: number;
  width: number;
  fontSize: number;
}

/** Position fitted lines in `box`: `align` horizontal, `valign` vertical. */
export function placeLines(
  fit: FitResult,
  box: Rect,
  align: "left" | "center" = "center",
  valign: "top" | "middle" | "bottom" = "middle",
  opts: MeasureOptions = {},
): PlacedLine[] {
  const top = valign === "top" ? box.y : valign === "bottom" ? box.y + box.h - fit.height : box.y + (box.h - fit.height) / 2;
  const cx = box.x + box.w / 2;
  return fit.lines.map((text, i) => {
    const width = estimateTextWidth(text, fit.fontSize, opts);
    return {
      text,
      width,
      fontSize: fit.fontSize,
      cx,
      x: Math.round(align === "left" ? box.x : cx - width / 2),
      y: Math.round(top + i * fit.lineAdvance),
    };
  });
}

// ---------------------------------------------------------------------------------- text treatment

const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "per", "the", "to", "vs", "via", "with"]);

/**
 * Heading case transform (style `text.case`). `title` capitalises words that are all lower case
 * (so API, gRPC and iOS keep their spelling), leaving short function words lower case except at
 * the start and end. `as_is` and undefined return the text unchanged.
 */
export function applyTextCase(text: string, mode: "as_is" | "upper" | "title" | undefined): string {
  if (mode === "upper") return text.toLocaleUpperCase("en");
  if (mode !== "title") return text;
  return text
    .split("\n")
    .map((line) => {
      const words = line.split(" ");
      const last = words.length - 1;
      return words
        .map((w, i) => {
          const m = /^([^\p{L}]*)(\p{L}[\p{L}\p{N}'’-]*)(.*)$/u.exec(w);
          if (!m) return w;
          const [, lead, word, tail] = m as unknown as [string, string, string, string];
          if (word !== word.toLowerCase()) return w;
          if (i !== 0 && i !== last && SMALL_WORDS.has(word)) return w;
          return `${lead}${word.charAt(0).toLocaleUpperCase("en")}${word.slice(1)}${tail}`;
        })
        .join(" ");
    })
    .join("\n");
}

// ---------------------------------------------------------------------------------- safe areas

/**
 * Bump whenever layout rules change the pixels of an existing scene (safe
 * areas, wrapping); it is part of every scene cache key so stale clips re-render.
 * v3: the safe area is the platform zones' content rect (design grid minus UI masks).
 * v4: code panels show no language label for plain text (`text`, `txt`, `plaintext`).
 * v5: text shrinks until every whole word fits a line; words are only hard-broken at the minimum size.
 * v6: script-aware widths and breaking (CJK per character with kinsoku, Devanagari/Arabic widths),
 *     right-aligned RTL lines, script fonts.
 * v7: no exit fade when the style blends scenes (crossfade/slide/zoom/whip); the assembly transition replaces it.
 */
export const LAYOUT_VERSION = 7;

/**
 * The content-safe rectangle of a target, in px (integers): `zones.content` when the pipeline
 * passes layout zones for the enabled platform targets, else the design-grid content rect with
 * no masks (`layoutZones(target)`), which already keeps clear of the caption zone. Zones computed
 * for another frame size are scaled to this one.
 */
export function safeArea(target: Pick<RenderTarget, "width" | "height" | "aspect_ratio">, zones?: LayoutZones): Rect {
  const z = zones ?? layoutZones(target);
  const c = z.content;
  if (z.width === target.width && z.height === target.height) return { x: c.x, y: c.y, w: c.w, h: c.h };
  const kx = target.width / z.width;
  const ky = target.height / z.height;
  const x = Math.round(c.x * kx);
  const y = Math.round(c.y * ky);
  return { x, y, w: Math.round((c.x + c.w) * kx) - x, h: Math.round((c.y + c.h) * ky) - y };
}

/** Split a rect vertically by weights with `gap` px between parts. */
export function splitV(r: Rect, weights: readonly number[], gap = 0): Rect[] {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const avail = r.h - gap * (weights.length - 1);
  let y = r.y;
  return weights.map((wt) => {
    const h = Math.round((avail * wt) / total);
    const out = { x: r.x, y, w: r.w, h };
    y += h + gap;
    return out;
  });
}

/** Split a rect horizontally by weights with `gap` px between parts. */
export function splitH(r: Rect, weights: readonly number[], gap = 0): Rect[] {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const avail = r.w - gap * (weights.length - 1);
  let x = r.x;
  return weights.map((wt) => {
    const w = Math.round((avail * wt) / total);
    const out = { x, y: r.y, w, h: r.h };
    x += w + gap;
    return out;
  });
}

export function inset(r: Rect, dx: number, dy = dx): Rect {
  return { x: r.x + dx, y: r.y + dy, w: Math.max(0, r.w - 2 * dx), h: Math.max(0, r.h - 2 * dy) };
}

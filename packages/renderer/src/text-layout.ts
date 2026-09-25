import type { AspectRatio } from "@video-studio/schema";
import type { RenderTarget } from "./types.js";
import { captionReserveFraction } from "@video-studio/media";

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
}

/** Estimated rendered width in px. */
export function estimateTextWidth(text: string, fontSize: number, opts: MeasureOptions = {}): number {
  const em = opts.mono ? CHAR_EM.mono : CHAR_EM.proportional;
  return Array.from(text).length * fontSize * em;
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
  const em = opts.mono ? CHAR_EM.mono : CHAR_EM.proportional;
  const maxChars = Math.max(1, Math.floor(maxWidth / (fontSize * em)));
  const lines: string[] = [];
  for (const para of text.replace(/\r\n?/g, "\n").split("\n")) {
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
  const fits = (lines: string[], size: number) => {
    const b = blockSize(lines, size, lh, opts);
    return b.width <= box.w + 0.01 && b.height <= box.h + 0.01 && (opts.maxLines === undefined || lines.length <= opts.maxLines);
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
  const em = opts.mono ? CHAR_EM.mono : CHAR_EM.proportional;
  const maxChars = Math.max(1, Math.floor(box.w / (size * em)));
  const maxLines = Math.max(1, Math.min(opts.maxLines ?? Infinity, Math.floor((box.h - size) / (size * lh)) + 1));
  let lines = layout(size).map((l) => ellipsize(l, maxChars));
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    const last = lines[maxLines - 1]!;
    lines[maxLines - 1] = Array.from(last).length >= maxChars ? ellipsize(`${last}…`, maxChars) : `${last}…`;
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

// ---------------------------------------------------------------------------------- safe areas

/** Fractions of the frame reserved on each side. */
export interface SafeMargins {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Reserved margins per aspect. 9:16 keeps the top 10% (platform UI) and bottom 20%
 * (captions, platform UI) clear; all aspects keep 7% side margins.
 */
/**
 * Bump whenever layout rules change the pixels of an existing scene (safe
 * areas, wrapping); it is part of every scene cache key so stale clips re-render.
 */
export const LAYOUT_VERSION = 2;

export const SAFE_MARGINS: Record<AspectRatio, SafeMargins> = {
  "9:16": { top: 0.1, bottom: 0.2, left: 0.07, right: 0.07 },
  "4:5": { top: 0.07, bottom: 0.15, left: 0.07, right: 0.07 },
  "1:1": { top: 0.07, bottom: 0.15, left: 0.07, right: 0.07 },
  "16:9": { top: 0.08, bottom: 0.17, left: 0.07, right: 0.07 },
};

/** The content-safe rectangle of a target, in px (integers). */
export function safeArea(target: Pick<RenderTarget, "width" | "height" | "aspect_ratio">): Rect {
  const m = SAFE_MARGINS[target.aspect_ratio] ?? SAFE_MARGINS["16:9"];
  // Keep content clear of the burned-in caption band as well as platform UI.
  const bottom = Math.max(m.bottom, captionReserveFraction(target.width, target.height));
  const x = Math.round(target.width * m.left);
  const y = Math.round(target.height * m.top);
  return { x, y, w: Math.round(target.width * (1 - m.left - m.right)), h: Math.round(target.height * (1 - m.top - bottom)) };
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

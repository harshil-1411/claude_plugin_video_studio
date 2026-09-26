import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join } from "node:path";
import { codeLabel } from "./hyperframes-highlight.js";
import { projectPaths, resolveInsideProject } from "@video-studio/core";
import {
  type FfmpegTools,
  escapeFilterOption,
  escapeFiltergraph,
  ffmpegFeatures,
  ffprobe,
  getTools,
  h264Args,
  FASTSTART,
  resolveFfmpeg,
  runFfmpeg,
  runProcess,
} from "@video-studio/media";
import { type DeterministicKind, type Scene, type SceneMotion, type TextBox, type TextRole, kineticUnits } from "@video-studio/schema";
import {
  CHAR_EM_UPPER,
  type FitOptions,
  type FitResult,
  type Rect,
  applyTextCase,
  estimateTextWidth,
  fitText,
  inset,
  placeLines,
  safeArea,
  scriptEm,
  splitH,
  splitV,
  wrapText,
} from "./text-layout.js";
import { type Script, baseDirection, charScript, dominantScript, hasCjk, needsShaping, scriptFontFamilies, scriptsIn, textDirection } from "./script.js";
import { BUNDLED_FONTS, type FontResolver, assFontSize, createFontResolver, findFontsDir, parseFontChain, prepareLibassFontsDir, readFontMetrics, scriptFirstChain } from "./tokens.js";
import type { Availability, LayoutZones, MotionTokens, RenderTarget, ResolvedCue, SceneRenderRequest, SceneRenderResult, SceneRenderer, VisualTokens } from "./types.js";
import { COUNT_UP_ENTRANCE_LEAD_S, countUpSpan, countUpSteps, countUpTiming, withEarlyFirstStep } from "./count-up.js";
import { countUpWindow, cueItemStarts } from "./cue-timing.js";
import { openingStart, sameTime } from "./entrance.js";
import { exitFadeMs } from "./tokens.js";

/**
 * Chrome-free fallback renderer for deterministic scenes: one `-f lavfi color=` source at the
 * target size/fps plus a filtergraph of drawbox / drawtext / overlay, encoded to H.264 yuv420p
 * with no audio and exactly round(duration × fps) frames.
 *
 * Text is passed through `textfile=` temp files with `expansion=none`, so scene text is never
 * parsed as filter syntax or drawtext expansions. Colours come from the tokens exactly.
 *
 * Determinism: the argv is a pure function of (scene, tokens, target, resolved font files,
 * encode settings). With `-fflags +bitexact -flags:v +bitexact`, no metadata and a fixed x264
 * thread count (default 1), the same inputs give byte-identical MP4s on the same FFmpeg/x264
 * build and font files. Different FFmpeg, x264, FreeType/HarfBuzz builds or fonts can change
 * the bytes (and glyph rasterisation), so the cache key includes the renderer version and the
 * tokens, not the host toolchain.
 */

export const FFMPEG_RENDERER_ID = "ffmpeg-drawtext";
/**
 * 0.4.0: script fonts for CJK lines; Devanagari/Arabic/Hebrew lines drawn through libass (shaping + bidi).
 * 0.4.1: `scene.motion` (push_in, pull_out, punch, reveal, drift, hold) moves the whole frame.
 * 0.4.2: word cues (`req.cues`) land each reveal item on its spoken word.
 * 0.5.0: stat values count up (count-up.ts, as in HyperFrames); the first reveal opens the scene half-in (entrance.ts).
 */
export const FFMPEG_RENDERER_VERSION = "0.5.0";

export const FFMPEG_RENDERER_KINDS = [
  "typography",
  "code",
  "chart",
  "diagram",
  "screenshot",
  "comparison",
  "cta",
  "end_card",
  "quote",
  "stat",
  "timeline",
  "split_screen",
  "lower_third",
  "kinetic_text",
  "map",
] as const satisfies readonly DeterministicKind[];

export interface FfmpegEncodeSettings {
  /** x264 preset. Default `veryfast` (scene clips are re-encoded at assembly). Tests use `ultrafast`. */
  preset?: string;
  /** Default 18. */
  crf?: number;
  /** x264 threads; fixed so output bytes are reproducible. Default 1. */
  threads?: number;
}

/** Resolve a ContentIR asset id to an absolute file path (null if unknown). */
export type AssetResolver = (assetId: string, projectDir: string) => Promise<string | null>;

export interface FfmpegRendererOptions {
  /** Font family chain → font file. Default: fontconfig + platform fallbacks (memoised). */
  fontResolver?: FontResolver;
  encodePreset?: string;
  encode?: FfmpegEncodeSettings;
  tools?: FfmpegTools;
  resolveAsset?: AssetResolver;
  /** Keep the temp dir (text files) for debugging. */
  keepTemp?: boolean;
  /** Bundled fonts directory (for libass); undefined: `findFontsDir()`, null: host fonts only. */
  fontsDir?: string | null;
}

// ---------------------------------------------------------------------------------- composition model

type FontRole = "heading" | "body" | "mono";

interface TextEl {
  type: "text";
  text: string;
  font: FontRole;
  size: number;
  color: string;
  /** Left edge in px, or centred on `cx` using the measured text width, or right-aligned to `rx` (RTL lines). */
  x: number;
  cx?: number;
  rx?: number;
  y: number;
  beat: number;
  /** `cueItems` index this element reveals with (absent: part of the card, never cued). */
  item?: number;
  slide?: boolean;
  box?: { color: string; border: number };
  /**
   * The final value of a count-up (a stat's numeric value; `text` is its formatted digits): the
   * intermediate values (count-up.ts) are drawn first, each in its own time slot, and `text` from
   * the end of the count. Positioned by `cx` (no unit: every string centred there) or `rx` (the
   * unit starts at `rx`: every string ends at or before it, see `countX`).
   */
  count?: number;
}

interface BoxEl {
  type: "box";
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  /** Omitted = filled. */
  thickness?: number;
  beat: number;
  item?: number;
}

interface ImageEl {
  type: "image";
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
  beat: number;
  item?: number;
}

type El = TextEl | BoxEl | ImageEl;

export interface Composition {
  elements: El[];
  warnings: string[];
  /** Every text block laid out, for lint (overflow, mask collisions, contrast). */
  text_boxes: TextBox[];
  /** Item whose entrance finishes on its cue instead of starting there (a stat's value). */
  count_item?: number;
}

/** What a per-kind layout returns; composeScene adds the recorded text boxes. */
type Layout = Omit<Composition, "text_boxes">;

interface Ctx {
  target: RenderTarget;
  tokens: VisualTokens;
  safe: Rect;
  /** Short side in px. */
  u: number;
  colors: Palette;
  /** Role of the scene's main text: `hook` in the hook scene, else `headline`. */
  main: TextRole;
  /** Text boxes recorded while laying out. */
  boxes: TextBox[];
  /** Alignment of heading-like text blocks (style `text.align`; default centred). */
  align: "left" | "center";
}

interface Palette {
  bg: string;
  text: string;
  primary: string;
  secondary: string;
  panel: string;
  panelEdge: string;
  muted: string;
}

// ---------------------------------------------------------------------------------- colours

function rgb(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, "");
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** Linear mix a→b by t (0..1). */
export function mixColor(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return toHex([0, 1, 2].map((i) => x[i]! + (y[i]! - x[i]!) * t) as [number, number, number]);
}

/** `#RRGGBB` → FFmpeg `0xRRGGBB[@a]`. */
export function ffColor(hex: string, alpha?: number): string {
  const c = `0x${toHex(rgb(hex)).slice(1)}`;
  return alpha === undefined || alpha >= 1 ? c : `${c}@${alpha.toFixed(2)}`;
}

function palette(t: VisualTokens): Palette {
  return {
    bg: t.color_background,
    text: t.color_text,
    primary: t.color_primary,
    secondary: t.color_secondary,
    panel: mixColor(t.color_background, t.color_text, 0.08),
    panelEdge: mixColor(t.color_background, t.color_text, 0.2),
    muted: mixColor(t.color_text, t.color_background, 0.35),
  };
}

// ---------------------------------------------------------------------------------- helpers

const r = Math.round;

function textLines(
  fit: FitResult,
  box: Rect,
  o: {
    font: FontRole;
    color: string | ((line: string, i: number) => string);
    beat: number | ((i: number) => number);
    item?: number | ((i: number) => number);
    align?: "left" | "center";
    valign?: "top" | "middle" | "bottom";
    slide?: boolean;
  },
): TextEl[] {
  const mono = o.font === "mono";
  // Right-to-left paragraphs mirror a left alignment: their lines hang from the box's right edge.
  const rtl = o.align === "left" && !mono && baseDirection(fit.lines.join(" ")) === "rtl";
  return placeLines(fit, box, o.align ?? "center", o.valign ?? "middle", { mono })
    .filter((l) => l.text.trim().length > 0)
    .map((l, i) => ({
      type: "text" as const,
      text: l.text,
      font: o.font,
      size: l.fontSize,
      color: typeof o.color === "function" ? o.color(l.text, i) : o.color,
      x: rtl ? r(box.x + box.w - l.width) : l.x,
      ...(rtl ? { rx: r(box.x + box.w) } : o.align === "left" ? {} : { cx: r(l.cx) }),
      y: l.y,
      beat: typeof o.beat === "function" ? o.beat(i) : o.beat,
      ...(o.item === undefined ? {} : { item: typeof o.item === "function" ? o.item(i) : o.item }),
      slide: o.slide ?? true,
    }));
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/**
 * Paragraph index of each fitted line (paragraphs wrap onto several lines), by consuming each
 * paragraph's non-space characters; a truncated fit attributes what remains to the last one.
 */
function lineParagraphs(fit: FitResult, paras: readonly string[]): number[] {
  const len = (t: string) => Array.from(t.replace(/\s+/g, "")).length;
  let j = 0;
  let left = len(paras[0] ?? "");
  return fit.lines.map((line) => {
    while (left <= 0 && j < paras.length - 1) left = len(paras[++j]!);
    left -= len(line);
    return j;
  });
}

/** Record a text block for lint: the box it was fitted into, its size, truncation and colours. */
function note(
  c: Ctx,
  role: TextRole,
  text: string,
  box: { x?: number; y?: number; w: number; h: number },
  fit: Pick<FitResult, "fontSize" | "truncated">,
  color: string,
  background: string = c.colors.bg,
): void {
  if (!text.trim()) return;
  const x = r(box.x ?? 0);
  const y = r(box.y ?? 0);
  c.boxes.push({
    role,
    text,
    rect: { x, y, w: Math.max(0, r((box.x ?? 0) + box.w) - x), h: Math.max(0, r((box.y ?? 0) + box.h) - y) },
    font_px: fit.fontSize,
    truncated: fit.truncated,
    color: toHex(rgb(color)),
    background: toHex(rgb(background)),
  });
}

/** Heading text with the style's case transform (hook/headline roles). */
function headCase(c: Ctx, text: string): string {
  return applyTextCase(text, c.tokens.text_case);
}

/**
 * fitText for a heading: a wider glyph estimate for upper case, then the style's heading scale
 * applied to the fitted size (re-fitted downwards when the scaled size no longer fits).
 * Without style tokens this is exactly `fitText(text, box, opts)`.
 */
function fitHeading(c: Ctx, text: string | readonly string[], box: { w: number; h: number }, opts: FitOptions): FitResult {
  const o: FitOptions = c.tokens.text_case === "upper" && !opts.mono ? { ...opts, em: CHAR_EM_UPPER } : opts;
  const fit = fitText(text, box, o);
  const k = c.tokens.heading_scale;
  if (k === undefined || k === 1 || (k > 1 && fit.truncated)) return fit;
  const size = fit.fontSize * k;
  return fitText(text, box, { ...o, maxSize: size, minSize: Math.min(o.minSize, size) });
}

// ---------------------------------------------------------------------------------- per-kind layouts

function typography(p: Record<string, unknown>, c: Ctx): Layout {
  const warnings: string[] = [];
  // Each drawn line keeps the index of its `lines` entry: that entry's cue item.
  const src = Array.isArray(p.lines) ? p.lines.flatMap((l, i) => (typeof l === "string" && l.trim() !== "" ? [{ text: headCase(c, l), item: i }] : [])) : [];
  const lines = src.map((l) => l.text);
  if (lines.length === 0) warnings.push("typography: no lines to draw");
  const emphasis = asStr(p.emphasis)?.trim();
  const box = inset(c.safe, r(c.u * 0.02));
  const fit = fitHeading(c, lines, box, { maxSize: c.u * 0.12, minSize: c.u * 0.04 });
  if (fit.truncated) warnings.push("typography: text did not fit at the minimum size and was truncated");
  const em = emphasis?.toLowerCase();
  const emWords = em ? em.split(/\s+/).filter((w) => w.length >= 3) : [];
  let hit = false;
  const color = (line: string) => {
    const l = line.toLowerCase();
    if (em && (l.includes(em) || emWords.some((w) => l.includes(w)))) {
      hit = true;
      return c.colors.primary;
    }
    return c.colors.text;
  };
  const para = lineParagraphs({ ...fit, lines: fit.lines.filter((l) => l.trim().length > 0) }, lines);
  const els = textLines(fit, box, { font: "heading", color, beat: (i) => i, item: (i) => src[para[i] ?? 0]?.item ?? 0, align: c.align });
  note(c, c.main, lines.join("\n"), box, fit, c.colors.text);
  if (em && !hit) warnings.push(`typography: emphasis "${emphasis}" not found in lines`);
  if (em && hit) warnings.push("typography: emphasis colours the whole line containing it (no per-word styling in ffmpeg-drawtext)");
  return { elements: els, warnings };
}

function code(p: Record<string, unknown>, c: Ctx): Layout {
  const warnings: string[] = [];
  const src = (asStr(p.code) ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(/\s+$/, "");
  const lang = codeLabel(asStr(p.language)) ?? "";
  const highlights = Array.isArray(p.highlight_lines) ? p.highlight_lines.filter((n): n is number => Number.isInteger(n) && n > 0) : [];
  const codeLines = src.split("\n");
  const pad = r(c.u * 0.04);
  const header = lang ? r(c.u * 0.06) : 0;
  const inner = { x: c.safe.x + pad, y: c.safe.y + pad + header, w: c.safe.w - 2 * pad, h: c.safe.h - 2 * pad - header };
  const fit = fitText(codeLines, inner, { mono: true, noWrap: true, maxSize: c.u * 0.05, minSize: c.u * 0.022, lineHeight: 1.4 });
  if (fit.truncated) warnings.push("code: code did not fit at the minimum size; long lines were cut and/or trailing lines dropped");
  note(c, "code", src, inner, fit, c.colors.text, c.colors.panel);
  const panelH = Math.min(c.safe.h, r(fit.height + 2 * pad + header + fit.fontSize * 0.4));
  const panel: Rect = { x: c.safe.x, y: r(c.safe.y + (c.safe.h - panelH) / 2), w: c.safe.w, h: panelH };
  const body: Rect = { x: inner.x, y: panel.y + pad + header, w: inner.w, h: panel.h - 2 * pad - header };
  const els: El[] = [
    { type: "box", ...panel, color: c.colors.panel, beat: 0 },
    { type: "box", x: panel.x, y: panel.y, w: panel.w, h: Math.max(2, r(c.u * 0.006)), color: c.colors.primary, beat: 0 },
  ];
  if (lang) {
    const size = Math.max(6, r(c.u * 0.03));
    els.push({ type: "text", text: lang, font: "mono", size, color: c.colors.muted, x: inner.x, y: panel.y + r(pad * 0.7), beat: 0, slide: false });
    note(c, "decorative", lang, { x: inner.x, y: panel.y + r(pad * 0.7), w: inner.w, h: size }, { fontSize: size, truncated: false }, c.colors.muted, c.colors.panel);
  }
  const placed = placeLines(fit, body, "left", "top", { mono: true });
  for (const n of highlights) {
    const line = placed[n - 1];
    if (!line) {
      warnings.push(`code: highlight line ${n} is outside the ${placed.length} drawn line(s)`);
      continue;
    }
    els.push({
      type: "box",
      x: panel.x + r(pad / 3),
      y: r(line.y - fit.fontSize * 0.2),
      w: panel.w - 2 * r(pad / 3),
      h: r(fit.lineAdvance),
      color: ffColor(c.colors.primary, 0.22),
      beat: 2,
      item: 1,
    });
  }
  for (const l of placed) {
    if (!l.text.trim()) continue;
    els.push({ type: "text", text: l.text, font: "mono", size: fit.fontSize, color: c.colors.text, x: l.x, y: l.y, beat: 1, item: 0, slide: false });
  }
  return { elements: els, warnings };
}

function comparison(p: Record<string, unknown>, c: Ctx): Layout {
  const warnings: string[] = [];
  const side = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const left = side(p.left);
  const right = side(p.right);
  const verdictRaw = asStr(p.verdict);
  const verdict = verdictRaw ? headCase(c, verdictRaw) : undefined;
  const gap = r(c.u * 0.04);
  const [mainR, verdictR] = verdict ? splitV(c.safe, [5, 1], gap) : [c.safe, undefined];
  const portrait = c.target.height > c.target.width;
  const panels = portrait ? splitV(mainR!, [1, 1], gap) : splitH(mainR!, [1, 1], gap);
  const els: El[] = [];
  const pad = r(c.u * 0.035);
  const labelH = r(c.u * 0.09);
  const items: [Record<string, unknown>, string][] = [
    [left, c.colors.primary],
    [right, c.colors.secondary],
  ];
  // One text size for both sides so they read as a pair.
  const bodyBoxes = panels.map((pr) => ({ x: pr.x + pad, y: pr.y + pad + labelH, w: pr.w - 2 * pad, h: pr.h - 2 * pad - labelH }));
  const bodyFits = items.map(([s], i) => fitText(asStr(s.text) ?? "", bodyBoxes[i]!, { maxSize: c.u * 0.065, minSize: c.u * 0.03 }));
  const bodySize = Math.min(...bodyFits.map((f) => f.fontSize));
  items.forEach(([s, accent], i) => {
    const pr = panels[i]!;
    const beat = i * 2;
    const item = i;
    els.push({ type: "box", ...pr, color: c.colors.panel, beat, item });
    els.push({ type: "box", x: pr.x, y: pr.y, w: pr.w, h: Math.max(2, r(c.u * 0.008)), color: accent, beat, item });
    const lf = fitText(asStr(s.label) ?? "", { w: pr.w - 2 * pad, h: labelH - pad / 2 }, { maxSize: c.u * 0.06, minSize: c.u * 0.03, maxLines: 1 });
    const labelBox = { x: pr.x + pad, y: pr.y + pad, w: pr.w - 2 * pad, h: labelH - pad / 2 };
    els.push(...textLines(lf, labelBox, { font: "heading", color: accent, beat, item, valign: "top" }));
    note(c, "label", asStr(s.label) ?? "", labelBox, lf, accent, c.colors.panel);
    const bf = fitText(asStr(s.text) ?? "", bodyBoxes[i]!, { maxSize: bodySize, minSize: Math.min(bodySize, c.u * 0.03) });
    if (bf.truncated) warnings.push(`comparison: ${i === 0 ? "left" : "right"} text truncated to fit`);
    els.push(...textLines(bf, bodyBoxes[i]!, { font: "body", color: c.colors.text, beat: beat + 1, item, valign: "top" }));
    note(c, "body", asStr(s.text) ?? "", bodyBoxes[i]!, bf, c.colors.text, c.colors.panel);
  });
  if (verdict && verdictR) {
    const vf = fitHeading(c, verdict, verdictR, { maxSize: c.u * 0.06, minSize: c.u * 0.03 });
    if (vf.truncated) warnings.push("comparison: verdict truncated to fit");
    els.push(...textLines(vf, verdictR, { font: "heading", color: c.colors.text, beat: 4, item: 2, align: c.align }));
    note(c, "headline", verdict, verdictR, vf, c.colors.text);
  }
  return { elements: els, warnings };
}

function cta(p: Record<string, unknown>, c: Ctx): Layout {
  const warnings: string[] = [];
  const headline = headCase(c, asStr(p.headline) ?? "");
  const action = asStr(p.action);
  const command = asStr(p.command);
  const url = asStr(p.url);
  const parts: { key: string; weight: number }[] = [{ key: "headline", weight: 3 }];
  if (action) parts.push({ key: "action", weight: 1.3 });
  if (command) parts.push({ key: "command", weight: 1.2 });
  if (url) parts.push({ key: "url", weight: 0.8 });
  const gap = r(c.u * 0.04);
  const rects = splitV(c.safe, parts.map((x) => x.weight), gap);
  const els: El[] = [];
  parts.forEach(({ key }, i) => {
    const rect = rects[i]!;
    if (key === "headline") {
      const f = fitHeading(c, headline, rect, { maxSize: c.u * 0.11, minSize: c.u * 0.04 });
      if (f.truncated) warnings.push("cta: headline truncated to fit");
      els.push(...textLines(f, rect, { font: "heading", color: c.colors.text, beat: 0, item: 0, valign: "bottom", align: c.align }));
      note(c, c.main === "hook" ? "hook" : "cta", headline, rect, f, c.colors.text);
    } else if (key === "action") {
      const maxW = r(rect.w * 0.9);
      const f = fitText(action!, { w: maxW - r(c.u * 0.08), h: rect.h * 0.6 }, { maxSize: c.u * 0.06, minSize: c.u * 0.03, maxLines: 1 });
      if (f.truncated) warnings.push("cta: action truncated to fit");
      const pillW = Math.min(maxW, r(f.width + c.u * 0.1));
      const pillH = r(f.fontSize * 2.1);
      const pill: Rect = { x: r(rect.x + (rect.w - pillW) / 2), y: r(rect.y + (rect.h - pillH) / 2), w: pillW, h: pillH };
      els.push({ type: "box", ...pill, color: c.colors.primary, beat: 1, item: 1 });
      els.push(...textLines(f, pill, { font: "heading", color: c.colors.bg, beat: 1, item: 1, slide: false }));
      note(c, "cta", action!, pill, f, c.colors.bg, c.colors.primary);
    } else if (key === "command") {
      const pad = r(c.u * 0.03);
      const text = `$ ${command}`;
      const f = fitText([text], { w: rect.w - 2 * pad, h: rect.h - 2 * pad }, { mono: true, noWrap: true, maxSize: c.u * 0.045, minSize: c.u * 0.02 });
      if (f.truncated) warnings.push("cta: command truncated to fit");
      const boxH = Math.min(rect.h, r(f.height + 2 * pad));
      const bw = Math.min(rect.w, r(f.width + 2 * pad));
      const panel: Rect = { x: r(rect.x + (rect.w - bw) / 2), y: r(rect.y + (rect.h - boxH) / 2), w: bw, h: boxH };
      // The command and url reveal with the action (one cue item).
      els.push({ type: "box", ...panel, color: c.colors.panel, beat: 2, item: 1 });
      els.push({ type: "box", ...panel, color: c.colors.panelEdge, thickness: Math.max(1, r(c.u * 0.003)), beat: 2, item: 1 });
      els.push(...textLines(f, inset(panel, pad), { font: "mono", color: c.colors.secondary, beat: 2, item: 1, slide: false }));
      note(c, "code", text, inset(panel, pad), f, c.colors.secondary, c.colors.panel);
    } else {
      const f = fitText(url!, rect, { maxSize: c.u * 0.04, minSize: c.u * 0.02, maxLines: 2 });
      els.push(...textLines(f, rect, { font: "body", color: c.colors.muted, beat: 3, item: 1, valign: "top" }));
      note(c, "label", url!, rect, f, c.colors.muted);
    }
  });
  return { elements: els, warnings };
}

function endCard(p: Record<string, unknown>, c: Ctx, logo: { path: string; width: number; height: number } | null): Layout {
  const warnings: string[] = [];
  const titleRaw = asStr(p.title);
  const title = titleRaw ? headCase(c, titleRaw) : undefined;
  const subtitle = asStr(p.subtitle);
  const parts: { key: string; weight: number }[] = [];
  if (logo) parts.push({ key: "logo", weight: 1.4 });
  if (title) parts.push({ key: "title", weight: 2 });
  if (subtitle) parts.push({ key: "subtitle", weight: 1 });
  if (parts.length === 0) {
    warnings.push("end_card: no title, subtitle or logo; drew an empty card");
    return { elements: [], warnings };
  }
  // Centre the stack in the safe area with a height proportional to its content.
  const total = parts.reduce((a, b) => a + b.weight, 0);
  const stackH = Math.min(c.safe.h, r((c.safe.h * total) / 5));
  const stack: Rect = { x: c.safe.x, y: r(c.safe.y + (c.safe.h - stackH) / 2), w: c.safe.w, h: stackH };
  const rects = splitV(stack, parts.map((x) => x.weight), r(c.u * 0.03));
  const els: El[] = [];
  parts.forEach(({ key }, i) => {
    const rect = rects[i]!;
    if (key === "logo" && logo) {
      const s = Math.min(rect.w / logo.width, rect.h / logo.height);
      const w = Math.max(2, Math.floor((logo.width * s) / 2) * 2);
      const h = Math.max(2, Math.floor((logo.height * s) / 2) * 2);
      // A logo-only card is the single "card" item; otherwise the logo is part of the card.
      els.push({ type: "image", path: logo.path, x: r(rect.x + (rect.w - w) / 2), y: r(rect.y + (rect.h - h) / 2), w, h, beat: 0, ...(title || subtitle ? {} : { item: 0 }) });
    } else if (key === "title") {
      const f = fitHeading(c, title!, rect, { maxSize: c.u * 0.12, minSize: c.u * 0.04 });
      if (f.truncated) warnings.push("end_card: title truncated to fit");
      els.push(...textLines(f, rect, { font: "heading", color: c.colors.text, beat: 1, item: 0, valign: parts.length === 1 ? "middle" : "bottom", align: c.align }));
      note(c, c.main, title!, rect, f, c.colors.text);
    } else {
      const f = fitText(subtitle!, rect, { maxSize: c.u * 0.055, minSize: c.u * 0.025 });
      if (f.truncated) warnings.push("end_card: subtitle truncated to fit");
      els.push(...textLines(f, rect, { font: "body", color: c.colors.primary, beat: 2, item: title ? 1 : 0, valign: "top", align: c.align }));
      note(c, "body", subtitle!, rect, f, c.colors.primary);
    }
  });
  return { elements: els, warnings };
}

function formatNumber(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 100) / 100);
}

/** A single chart value; `item` is its cue item (the label reveals with it). */
function statLayout(value: string, label: string | undefined, c: Ctx, warnings: string[], item: number): Layout {
  const [numR, labelR] = label ? splitV(c.safe, [3, 2], r(c.u * 0.03)) : [c.safe, undefined];
  const els: El[] = [];
  const nf = fitHeading({ ...c, tokens: { ...c.tokens, text_case: "as_is" } }, value, numR!, { maxSize: c.u * 0.32, minSize: c.u * 0.06, maxLines: 1, lineHeight: 1.1 });
  if (nf.truncated) warnings.push("chart: value truncated to fit");
  els.push(...textLines(nf, numR!, { font: "heading", color: c.colors.primary, beat: 0, item, valign: label ? "bottom" : "middle" }));
  note(c, c.main, value, numR!, nf, c.colors.primary);
  if (label && labelR) {
    const lf = fitText(label, labelR, { maxSize: c.u * 0.065, minSize: c.u * 0.03 });
    if (lf.truncated) warnings.push("chart: label truncated to fit");
    els.push(...textLines(lf, labelR, { font: "body", color: c.colors.text, beat: 1, item, valign: "top" }));
    note(c, "label", label, labelR, lf, c.colors.text);
  }
  return { elements: els, warnings, count_item: item };
}

const MAX_BARS = 12;

function chart(p: Record<string, unknown>, c: Ctx): Layout {
  const warnings: string[] = [];
  const type = asStr(p.type) ?? "stat";
  const unit = spacedUnit(typeof p.unit === "string" ? p.unit : "");
  const label = asStr(p.label);
  // `item` is the entry's index in `props.series`: its cue item.
  const rawSeries: unknown[] = Array.isArray(p.series) ? p.series : [];
  const series = rawSeries.flatMap((s, item) =>
    !!s && typeof s === "object" && typeof (s as { value?: unknown }).value === "number" ? [{ ...(s as { label: string; value: number }), item }] : [],
  );
  const fmt = (v: number | string) => `${typeof v === "number" ? formatNumber(v) : v}${unit}`;

  if (type === "bar" && series.length > 0) {
    let rows = series;
    if (rows.length > MAX_BARS) {
      warnings.push(`chart: ${rows.length} bars exceed ${MAX_BARS}; only the first ${MAX_BARS} are drawn`);
      rows = rows.slice(0, MAX_BARS);
    }
    if (rows.some((s) => s.value < 0)) warnings.push("chart: negative bar values are drawn as zero-length bars");
    const max = Math.max(0, ...rows.map((s) => s.value));
    const els: El[] = [];
    const gap = r(c.u * 0.03);
    const [titleR, barsR] = label ? splitV(c.safe, [1, 5], gap) : [undefined, c.safe];
    if (label && titleR) {
      const title = headCase(c, label);
      const tf = fitHeading(c, title, titleR, { maxSize: c.u * 0.065, minSize: c.u * 0.03, maxLines: 2 });
      els.push(...textLines(tf, titleR, { font: "heading", color: c.colors.text, beat: 0, valign: "bottom", align: c.align }));
      note(c, c.main, title, titleR, tf, c.colors.text);
    }
    // Compact rows (label + bar of at most 7% of the short side), centred in the chart area.
    const rowGap = r(c.u * 0.03);
    const rowH = Math.min((barsR!.h - rowGap * (rows.length - 1)) / rows.length, c.u * 0.07 + c.u * 0.045 * 1.35);
    const stackH = r(rowH * rows.length + rowGap * (rows.length - 1));
    const stack: Rect = { ...barsR!, y: label ? barsR!.y : r(barsR!.y + (barsR!.h - stackH) / 2), h: stackH };
    const rowRects = splitV(stack, rows.map(() => 1), rowGap);
    const labelSize = Math.max(6, r(Math.min(c.u * 0.045, (rowRects[0]?.h ?? 40) * 0.32)));
    const valueW = r(Math.max(...rows.map((s) => estimateTextWidth(fmt(s.value), labelSize))) + c.u * 0.03);
    rows.forEach((s, i) => {
      const rr = rowRects[i]!;
      const beat = 1 + i * 0.5;
      const item = s.item;
      const labelLines = wrapText(s.label || " ", labelSize, rr.w);
      const text = labelLines.length > 1 ? `${labelLines[0]}…` : (labelLines[0] ?? "");
      if (text.trim()) els.push({ type: "text", text, font: "body", size: labelSize, color: c.colors.text, x: rr.x, y: rr.y, beat, item, slide: false });
      note(c, "label", s.label, { x: rr.x, y: rr.y, w: rr.w, h: labelSize * 1.35 }, { fontSize: labelSize, truncated: labelLines.length > 1 }, c.colors.text);
      const barY = r(rr.y + labelSize * 1.35);
      const barH = Math.max(2, r(Math.min(rr.h - labelSize * 1.35, c.u * 0.07)));
      const trackW = Math.max(2, rr.w - valueW);
      els.push({ type: "box", x: rr.x, y: barY, w: trackW, h: barH, color: c.colors.panel, beat, item });
      const bw = max > 0 ? r((Math.max(0, s.value) / max) * trackW) : 0;
      if (bw >= 1) els.push({ type: "box", x: rr.x, y: barY, w: bw, h: barH, color: c.colors.primary, beat: beat + 0.25, item });
      els.push({
        type: "text",
        text: fmt(s.value),
        font: "body",
        size: labelSize,
        color: c.colors.primary,
        x: rr.x + trackW + r(c.u * 0.02),
        y: r(barY + (barH - labelSize) / 2),
        beat: beat + 0.25,
        item,
        slide: false,
      });
    });
    return { elements: els, warnings };
  }

  if (type !== "stat" && type !== "bar") warnings.push(`chart: type "${type}" is not supported by ${FFMPEG_RENDERER_ID}; drawn as a stat`);
  if (type === "bar" && series.length === 0) warnings.push("chart: bar chart without series; drawn as a stat");
  let value: number | string | undefined = typeof p.value === "number" || typeof p.value === "string" ? p.value : undefined;
  let statLabel = label;
  if (value === undefined && series.length > 0) {
    const last = series[series.length - 1]!;
    value = last.value;
    statLabel = label ?? (last.label || undefined);
    warnings.push("chart: no `value`; showing the last series value");
  }
  if (value === undefined) {
    warnings.push("chart: nothing to draw (no value or series)");
    return { elements: [], warnings };
  }
  // With series but an unsupported type, `cueItems` lists the entries; the drawn stat is the last one.
  return statLayout(fmt(value), statLabel, c, warnings, type !== "stat" && rawSeries.length ? rawSeries.length - 1 : 0);
}

function diagram(p: Record<string, unknown>, c: Ctx): Layout {
  const warnings = ["diagram: basic grid layout with orthogonal edges and square arrowheads (ffmpeg-drawtext)"];
  const nodes = Array.isArray(p.nodes) ? [...new Set(p.nodes.filter((n): n is string => typeof n === "string" && n.trim() !== ""))] : [];
  const edges = Array.isArray(p.edges)
    ? p.edges.filter((e): e is [string, string] => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string")
    : [];
  const n = nodes.length;
  if (n === 0) return { elements: [], warnings: [...warnings, "diagram: no nodes"] };
  // Cue item of each node: its first index in `props.nodes` (drawn nodes are de-duplicated).
  const rawNodes: unknown[] = p.nodes as unknown[];
  const itemOf = (name: string) => rawNodes.indexOf(name);
  const landscape = c.target.width > c.target.height;
  const cols = landscape ? Math.min(n, 4) : n <= 4 ? 1 : 2;
  const rows = Math.ceil(n / cols);
  const gx = r(c.u * 0.08);
  const gy = r(c.u * 0.07);
  const area = c.safe;
  const cellW = (area.w - gx * (cols - 1)) / cols;
  const cellH = Math.min((area.h - gy * (rows - 1)) / rows, c.u * 0.3);
  const boxW = r(cols === 1 ? cellW * 0.7 : cellW);
  const boxH = r(cellH);
  const gridH = rows * boxH + (rows - 1) * gy;
  const top = area.y + (area.h - gridH) / 2;
  const pos = new Map<string, { rect: Rect; row: number; col: number; i: number }>();
  nodes.forEach((name, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    // Rows stay column-aligned (a short last row is not re-centred) so vertical edges line up.
    const x0 = area.x + col * (cellW + gx) + (cellW - boxW) / 2;
    pos.set(name, { rect: { x: r(x0), y: r(top + row * (boxH + gy)), w: boxW, h: boxH }, row, col, i });
  });

  const th = Math.max(2, r(c.u * 0.006));
  const head = th * 3;
  const els: El[] = [];
  let item = 0;
  const line = (x1: number, y1: number, x2: number, y2: number, beat: number) => {
    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    els.push({ type: "box", x: r(x - (x1 === x2 ? th / 2 : 0)), y: r(y - (y1 === y2 ? th / 2 : 0)), w: Math.max(th, r(Math.abs(x2 - x1))), h: Math.max(th, r(Math.abs(y2 - y1))), color: c.colors.muted, beat, item });
  };
  const arrow = (x: number, y: number, beat: number) => els.push({ type: "box", x: r(x - head / 2), y: r(y - head / 2), w: head, h: head, color: c.colors.primary, beat, item });
  edges.forEach(([a, b], k) => {
    const A = pos.get(a);
    const B = pos.get(b);
    if (!A || !B) {
      warnings.push(`diagram: edge ${a} → ${b} references an unknown node; skipped`);
      return;
    }
    if (a === b) {
      warnings.push(`diagram: self-loop on ${a} skipped`);
      return;
    }
    const beat = Math.max(A.i, B.i) + 0.5;
    // An edge draws with its later node.
    item = itemOf(A.i > B.i ? a : b);
    const ra = A.rect;
    const rb = B.rect;
    const acx = ra.x + ra.w / 2;
    const acy = ra.y + ra.h / 2;
    const bcx = rb.x + rb.w / 2;
    const bcy = rb.y + rb.h / 2;
    const lane = (k % 3) * th * 2;
    if (A.row === B.row && Math.abs(A.col - B.col) === 1) {
      const fwd = B.col > A.col;
      const x1 = fwd ? ra.x + ra.w : ra.x;
      const x2 = fwd ? rb.x : rb.x + rb.w;
      line(x1, acy, x2, bcy, beat);
      arrow(x2 + (fwd ? -head / 2 : head / 2), bcy, beat);
    } else if (A.col === B.col && Math.abs(A.row - B.row) === 1 && ra.x === rb.x) {
      const down = B.row > A.row;
      const y1 = down ? ra.y + ra.h : ra.y;
      const y2 = down ? rb.y : rb.y + rb.h;
      line(acx, y1, bcx, y2, beat);
      arrow(bcx, y2 + (down ? -head / 2 : head / 2), beat);
    } else if (A.row === B.row) {
      // Route below the row so the line does not pass behind intermediate boxes.
      const ly = ra.y + ra.h + gy / 2 + lane;
      line(acx, ra.y + ra.h, acx, ly, beat);
      line(acx, ly, bcx, ly, beat);
      line(bcx, ly, bcx, rb.y + rb.h, beat);
      arrow(bcx, rb.y + rb.h + head / 2, beat);
    } else if (A.col === B.col) {
      // Route along the right-hand lane.
      const lx = Math.min(c.target.width - th, Math.max(ra.x + ra.w, rb.x + rb.w) + gx / 2 + lane);
      line(ra.x + ra.w, acy, lx, acy, beat);
      line(lx, acy, lx, bcy, beat);
      line(lx, bcy, rb.x + rb.w, bcy, beat);
      arrow(rb.x + rb.w + head / 2, bcy, beat);
    } else {
      // Elbow: horizontal at the source row, then vertical into the target.
      const down = B.row > A.row;
      const y2 = down ? rb.y : rb.y + rb.h;
      line(acx, acy, bcx, acy, beat);
      line(bcx, acy, bcx, y2, beat);
      arrow(bcx, y2 + (down ? -head / 2 : head / 2), beat);
    }
  });

  // Boxes on top of edges; one label size for all nodes.
  const pad = r(c.u * 0.02);
  const labelBox = { w: boxW - 2 * pad, h: boxH - 2 * pad };
  const size = Math.min(...nodes.map((name) => fitText(name, labelBox, { maxSize: c.u * 0.055, minSize: c.u * 0.022 }).fontSize));
  for (const name of nodes) {
    const { rect, i } = pos.get(name)!;
    const item = itemOf(name);
    els.push({ type: "box", ...rect, color: c.colors.panel, beat: i, item });
    els.push({ type: "box", ...rect, color: c.colors.primary, thickness: th, beat: i, item });
    const f = fitText(name, labelBox, { maxSize: size, minSize: size });
    if (f.truncated) warnings.push(`diagram: label "${name}" truncated to fit`);
    els.push(...textLines(f, inset(rect, pad), { font: "body", color: c.colors.text, beat: i, item, slide: false }));
    note(c, "label", name, inset(rect, pad), f, c.colors.text, c.colors.panel);
  }
  return { elements: els, warnings };
}

/** `item`: index in `props.callouts` (its cue item). */
type Callout = { text: string; x?: number; y?: number; item: number };

function screenshot(p: Record<string, unknown>, c: Ctx, image: { path: string; width: number; height: number } | null): Layout {
  const warnings: string[] = [];
  const callouts: Callout[] = Array.isArray(p.callouts)
    ? p.callouts.flatMap((co, item): Callout[] => {
        if (typeof co === "string" && co.trim()) return [{ text: co, item }];
        if (co && typeof co === "object" && typeof (co as Callout).text === "string") {
          const o = co as Callout;
          return [{ text: o.text, ...(typeof o.x === "number" ? { x: o.x } : {}), ...(typeof o.y === "number" ? { y: o.y } : {}), item }];
        }
        return [];
      })
    : [];
  const listed = callouts.filter((co) => co.x === undefined || co.y === undefined);
  const pinned = callouts.filter((co) => co.x !== undefined && co.y !== undefined);
  const gap = r(c.u * 0.03);
  const [imgR, listR] = listed.length ? splitV(c.safe, [4, Math.min(listed.length, 3)], gap) : [c.safe, undefined];
  const els: El[] = [];
  let frame: Rect;
  if (image) {
    const s = Math.min(imgR!.w / image.width, imgR!.h / image.height);
    const w = Math.max(2, Math.floor((image.width * s) / 2) * 2);
    const h = Math.max(2, Math.floor((image.height * s) / 2) * 2);
    frame = { x: r(imgR!.x + (imgR!.w - w) / 2), y: r(imgR!.y + (imgR!.h - h) / 2), w, h };
    els.push({ type: "image", path: image.path, ...frame, beat: 0 });
  } else {
    frame = inset(imgR!, r(c.u * 0.02));
    els.push({ type: "box", ...frame, color: c.colors.panel, beat: 0 });
    const f = fitText(`screenshot "${asStr(p.asset) ?? "?"}" unavailable`, inset(frame, gap), { maxSize: c.u * 0.045, minSize: c.u * 0.02 });
    els.push(...textLines(f, inset(frame, gap), { font: "body", color: c.colors.muted, beat: 0, slide: false }));
    note(c, "decorative", `screenshot "${asStr(p.asset) ?? "?"}" unavailable`, inset(frame, gap), f, c.colors.muted, c.colors.panel);
  }
  els.push({ type: "box", ...frame, color: c.colors.panelEdge, thickness: Math.max(1, r(c.u * 0.004)), beat: 0 });

  const size = Math.max(6, r(c.u * 0.04));
  pinned.forEach((co, i) => {
    const fx = co.x! <= 1 && co.x! >= 0 ? co.x! * frame.w : co.x! * (image ? frame.w / image.width : 1);
    const fy = co.y! <= 1 && co.y! >= 0 ? co.y! * frame.h : co.y! * (image ? frame.h / image.height : 1);
    const mx = r(frame.x + Math.min(frame.w, Math.max(0, fx)));
    const my = r(frame.y + Math.min(frame.h, Math.max(0, fy)));
    const m = Math.max(4, r(c.u * 0.03));
    const beat = 1 + i;
    const item = co.item;
    els.push({ type: "box", x: mx - r(m / 2), y: my - r(m / 2), w: m, h: m, color: c.colors.primary, beat, item });
    const text = wrapText(co.text, size, c.safe.w * 0.6)[0] ?? co.text;
    const tw = estimateTextWidth(text, size);
    const border = r(size * 0.35);
    const rightX = mx + m;
    const x = rightX + tw + border * 2 > c.target.width - c.safe.x ? r(Math.max(border, mx - m - tw - border)) : rightX + border;
    els.push({ type: "text", text, font: "body", size, color: c.colors.text, x, y: my - r(size / 2), beat, item, slide: false, box: { color: ffColor(c.colors.bg, 0.85), border } });
    note(c, "label", co.text, { x: x - border, y: my - r(size / 2) - border, w: tw + 2 * border, h: size + 2 * border }, { fontSize: size, truncated: text !== co.text }, c.colors.text);
  });
  if (listed.length && listR) {
    const rowsR = splitV(listR, listed.map(() => 1), r(c.u * 0.015));
    listed.forEach((co, i) => {
      const rr = rowsR[i]!;
      const beat = 1 + pinned.length + i;
      const item = co.item;
      const bar = Math.max(2, r(c.u * 0.008));
      els.push({ type: "box", x: rr.x, y: rr.y, w: bar, h: rr.h, color: c.colors.primary, beat, item });
      const tr: Rect = { x: rr.x + bar * 3, y: rr.y, w: rr.w - bar * 3, h: rr.h };
      const f = fitText(co.text, tr, { maxSize: c.u * 0.05, minSize: c.u * 0.022, maxLines: 2 });
      if (f.truncated) warnings.push(`screenshot: callout "${co.text.slice(0, 30)}" truncated`);
      els.push(...textLines(f, tr, { font: "body", color: c.colors.text, beat, item, align: "left" }));
      note(c, "body", co.text, tr, f, c.colors.text);
    });
  }
  return { elements: els, warnings };
}

// ---------------------------------------------------------------------------------- reel grammar kinds

type Img = { path: string; width: number; height: number };

/** Top y of each block when `heights` (with `gaps` between them) are centred vertically in `area`. */
function vstack(area: Rect, heights: readonly number[], gap: number): number[] {
  const total = heights.reduce((a, b) => a + b, 0) + gap * Math.max(0, heights.length - 1);
  let y = area.y + Math.max(0, (area.h - total) / 2);
  return heights.map((h) => {
    const top = r(y);
    y += h + gap;
    return top;
  });
}

/** A filled rect with stepped corners (drawbox has no radius); reads as rounded at phone size. */
function roundedBox(rect: Rect, radius: number, color: string, beat: number): BoxEl[] {
  const k = r(Math.max(0, Math.min(radius, rect.w / 2, rect.h / 2)));
  if (k < 2) return [{ type: "box", ...rect, color, beat }];
  const a = r(k * 0.3);
  return [
    { type: "box", x: rect.x + k, y: rect.y, w: rect.w - 2 * k, h: rect.h, color, beat },
    { type: "box", x: rect.x, y: rect.y + k, w: rect.w, h: rect.h - 2 * k, color, beat },
    { type: "box", x: rect.x + a, y: rect.y + a, w: rect.w - 2 * a, h: rect.h - 2 * a, color, beat },
  ];
}

/** Bold-heading glyph advance estimate for placing single words on a line (wider than CHAR_EM for caps). */
function glyphWidth(text: string, size: number): number {
  let em = 0;
  for (const ch of Array.from(text)) {
    if (ch === " ") em += 0.3;
    else if (/[ijlI.,;:!'’|]/.test(ch)) em += 0.3;
    else if (/[frt()]/.test(ch)) em += 0.44;
    else if (/[MWmw@%]/.test(ch)) em += 0.9;
    else if (/[A-Z0-9]/.test(ch)) em += 0.7;
    else em += scriptEm(ch) ?? 0.6;
  }
  return em * size;
}

function imageIn(image: Img, box: Rect, beat: number): ImageEl {
  const s = Math.min(box.w / image.width, box.h / image.height);
  const w = Math.max(2, Math.floor((image.width * s) / 2) * 2);
  const h = Math.max(2, Math.floor((image.height * s) / 2) * 2);
  return { type: "image", path: image.path, x: r(box.x + (box.w - w) / 2), y: r(box.y + (box.h - h) / 2), w, h, beat };
}

function quote(p: Record<string, unknown>, c: Ctx): Layout {
  const warnings: string[] = [];
  const text = asStr(p.text) ?? "";
  const attribution = asStr(p.attribution);
  const source = asStr(p.source);
  const gap = r(c.u * 0.035);
  const w = c.safe.w - 2 * r(c.u * 0.02);
  const markSize = r(c.u * 0.22);
  // The opening mark glyph sits high in its em box: reserve only its visible part.
  const markH = r(markSize * 0.4);
  const af = attribution ? fitText(`— ${attribution}`, { w, h: c.u * 0.08 }, { maxSize: c.u * 0.048, minSize: c.u * 0.025, maxLines: 1 }) : undefined;
  const sf = source ? fitText(source, { w, h: c.u * 0.07 }, { maxSize: c.u * 0.038, minSize: c.u * 0.022, maxLines: 1 }) : undefined;
  const foot = [af, sf].filter((x): x is FitResult => !!x);
  const footH = foot.reduce((a, f) => a + f.height, 0) + (foot.length > 1 ? r(gap / 2) : 0);
  const qBox = { w, h: c.safe.h - markH - gap - (footH ? footH + gap : 0) };
  // A quotation keeps its wording and case; only the heading scale and alignment apply.
  const qf = fitHeading({ ...c, tokens: { ...c.tokens, text_case: "as_is" } }, text, qBox, { maxSize: c.u * 0.1, minSize: c.u * 0.035 });
  if (qf.truncated) warnings.push("quote: text truncated to fit");
  const [markY, textY, footY] = vstack(c.safe, [markH, qf.height, ...(footH ? [footH] : [])], gap);
  const cx = r(c.safe.x + c.safe.w / 2);
  const els: El[] = [{ type: "text", text: "“", font: "heading", size: markSize, color: c.colors.primary, x: cx, cx, y: r(markY! - markSize * 0.12), beat: 0, slide: false }];
  note(c, "decorative", "“", { x: cx - markSize / 2, y: markY!, w: markSize, h: markH }, { fontSize: markSize, truncated: false }, c.colors.primary);
  const qRect: Rect = { x: r(c.safe.x + (c.safe.w - w) / 2), y: textY!, w, h: r(qf.height) };
  els.push(...textLines(qf, qRect, { font: "heading", color: c.colors.text, beat: (i) => 0.5 + i * 0.5, item: 0, align: c.align }));
  note(c, c.main, text, qRect, qf, c.colors.text);
  let y = footY ?? 0;
  const beat = 1 + qf.lines.length * 0.5;
  if (af) {
    const rect: Rect = { x: qRect.x, y, w, h: r(af.height) };
    els.push(...textLines(af, rect, { font: "body", color: c.colors.text, beat, item: 1, align: c.align }));
    note(c, "label", `— ${attribution}`, rect, af, c.colors.text);
    y += r(af.height + gap / 2);
  }
  if (sf) {
    const rect: Rect = { x: qRect.x, y, w, h: r(sf.height) };
    // The source reveals with the attribution (the text's when there is none).
    els.push(...textLines(sf, rect, { font: "body", color: c.colors.muted, beat: beat + 0.5, item: af ? 1 : 0, align: c.align }));
    note(c, "label", source!, rect, sf, c.colors.muted);
  }
  return { elements: els, warnings };
}

/**
 * A unit as written after its number: symbols and short abbreviations attach ("40%", "3x", "10ms"),
 * word units get a space ("1 package", "5 users").
 */
export function spacedUnit(unit: string): string {
  if (!unit || /^\s/.test(unit)) return unit;
  return /\s/.test(unit.trim()) || /^\p{L}{3,}/u.test(unit) ? ` ${unit}` : unit;
}

function stat(p: Record<string, unknown>, c: Ctx): Layout {
  const warnings: string[] = [];
  const raw = p.value;
  const unit = spacedUnit(typeof p.unit === "string" ? p.unit : "");
  const value = `${typeof raw === "number" ? formatNumber(raw) : (asStr(raw) ?? "")}${unit}`;
  const label = asStr(p.label);
  const context = asStr(p.context);
  const gap = r(c.u * 0.035);
  const w = c.safe.w;
  const vf = fitHeading({ ...c, tokens: { ...c.tokens, text_case: "as_is" } }, value, { w, h: c.safe.h * 0.45 }, { maxSize: c.u * 0.3, minSize: c.u * 0.06, maxLines: 1, lineHeight: 1.1 });
  if (vf.truncated) warnings.push("stat: value truncated to fit");
  const lf = label ? fitText(label, { w, h: c.safe.h * 0.25 }, { maxSize: c.u * 0.07, minSize: c.u * 0.03, maxLines: 3 }) : undefined;
  if (lf?.truncated) warnings.push("stat: label truncated to fit");
  const cf = context ? fitText(context, { w, h: c.safe.h * 0.15 }, { maxSize: c.u * 0.045, minSize: c.u * 0.024, maxLines: 2 }) : undefined;
  if (cf?.truncated) warnings.push("stat: context truncated to fit");
  const barH = Math.max(2, r(c.u * 0.012));
  const heights = [vf.height, barH, ...(lf ? [lf.height] : []), ...(cf ? [cf.height] : [])];
  const ys = vstack(c.safe, heights, gap);
  const els: El[] = [];
  const vRect: Rect = { x: c.safe.x, y: ys[0]!, w, h: r(vf.height) };
  const valueEls = textLines(vf, vRect, { font: "heading", color: c.colors.primary, beat: 0, item: 0 });
  const counted = typeof raw === "number" && Number.isFinite(raw) && raw !== 0 && valueEls.length === 1 ? countUpEls(valueEls[0]!, raw, unit) : undefined;
  els.push(...(counted ?? valueEls));
  note(c, c.main, value, vRect, vf, c.colors.primary);
  const barW = r(c.u * 0.14);
  els.push({ type: "box", x: r(c.safe.x + (w - barW) / 2), y: ys[1]!, w: barW, h: barH, color: c.colors.primary, beat: 0.5, item: 0 });
  let k = 2;
  if (lf) {
    const rect: Rect = { x: c.safe.x, y: ys[k++]!, w, h: r(lf.height) };
    els.push(...textLines(lf, rect, { font: "heading", color: c.colors.text, beat: 1, item: 1 }));
    note(c, "label", label!, rect, lf, c.colors.text);
  }
  if (cf) {
    const rect: Rect = { x: c.safe.x, y: ys[k++]!, w, h: r(cf.height) };
    els.push(...textLines(cf, rect, { font: "body", color: c.colors.muted, beat: 2, item: 1 }));
    note(c, "body", context!, rect, cf, c.colors.muted);
  }
  return { elements: els, warnings, count_item: 0 };
}

/**
 * A stat value that counts up: its digits (with `count`) and its unit as separate elements, so the
 * unit stays put while the digits change. Without a unit the digits stay centred on the line's
 * centre. With one, the unit's left edge is a fixed anchor (placed so the estimated whole value is
 * centred) and the digits end there; undefined when the line cannot be split (it needs libass or a
 * script font, or is right-aligned).
 */
function countUpEls(line: TextEl, value: number, unit: string): TextEl[] | undefined {
  const digits = formatNumber(value);
  if (line.cx === undefined || line.text !== digits + unit || textRoute(digits).kind !== "drawtext" || textRoute(digits).script) return undefined;
  if (!unit) return [{ ...line, count: value }];
  const anchor = r(line.cx + (estimateTextWidth(digits, line.size) - estimateTextWidth(unit, line.size)) / 2);
  const { cx: _cx, ...rest } = line;
  return [
    { ...rest, text: digits, x: r(anchor - estimateTextWidth(digits, line.size)), rx: anchor, count: value },
    { ...rest, text: unit, x: anchor },
  ];
}

/**
 * drawtext `x` of a count-up string `text` whose final digits are `final`, for the element's
 * anchor: centred on `cx`; or, before a unit at `rx`, centred in the final digits' box (its width
 * estimated from the string's own measured width per character) but never ending past `rx`, so a
 * wider intermediate ("0" before a narrow "1") cannot reach the unit. A string as long as the
 * final one ends exactly at `rx`, like the final value.
 */
export function countX(el: Pick<TextEl, "cx" | "rx" | "x">, text: string, final: string): string {
  if (el.cx !== undefined) return `${el.cx}-text_w/2`;
  if (el.rx === undefined) return String(el.x);
  const n = Math.max(1, Array.from(text).length);
  const k = Math.max(1, Math.round(((Array.from(final).length + n) / (2 * n)) * 10000) / 10000);
  return k === 1 ? `${el.rx}-text_w` : `${el.rx}-text_w*${k}`;
}

const MAX_TIMELINE_EVENTS = 6;

function timeline(p: Record<string, unknown>, c: Ctx): Layout {
  const warnings: string[] = [];
  let events = Array.isArray(p.events)
    ? p.events.flatMap((e, item): { label: string; text?: string; item: number }[] => {
        if (!e || typeof e !== "object") return [];
        const o = e as Record<string, unknown>;
        const label = asStr(o.label);
        const text = asStr(o.text);
        return label ? [{ label, ...(text ? { text } : {}), item }] : [];
      })
    : [];
  if (events.length === 0) return { elements: [], warnings: ["timeline: no events"] };
  if (events.length > MAX_TIMELINE_EVENTS) {
    warnings.push(`timeline: ${events.length} events exceed ${MAX_TIMELINE_EVENTS}; only the first ${MAX_TIMELINE_EVENTS} are drawn`);
    events = events.slice(0, MAX_TIMELINE_EVENTS);
  }
  const n = events.length;
  let cur = typeof p.current === "number" && Number.isInteger(p.current) ? p.current : undefined;
  if (cur !== undefined && (cur < 0 || cur >= n)) {
    warnings.push(`timeline: current ${cur} is outside the ${n} event(s); nothing highlighted`);
    cur = undefined;
  }
  const hasText = events.some((e) => e.text);
  const th = Math.max(2, r(c.u * 0.008));
  const dot = Math.max(6, r(c.u * 0.04));
  const big = Math.max(dot + 4, r(dot * 1.5));
  const gap = r(c.u * 0.025);
  const dotColor = (i: number) => (cur === undefined || i <= cur ? c.colors.primary : c.colors.panelEdge);
  const labelColor = (i: number) => (i === cur ? c.colors.primary : c.colors.text);
  const els: El[] = [];
  const pushDot = (cx: number, cy: number, i: number) => {
    const s = i === cur ? big : dot;
    const item = events[i]!.item;
    if (i === cur) els.push({ type: "box", x: r(cx - s / 2 - th), y: r(cy - s / 2 - th), w: s + 2 * th, h: s + 2 * th, color: c.colors.bg, beat: i, item });
    els.push({ type: "box", x: r(cx - s / 2), y: r(cy - s / 2), w: s, h: s, color: dotColor(i), beat: i, item });
  };
  // Text blocks are collected first so labels share one size (and texts another).
  const drawText = (labelBoxes: Rect[], textBoxes: Rect[], align: "left" | "center") => {
    const lSize = Math.min(...events.map((e, i) => fitText(e.label, labelBoxes[i]!, { maxSize: c.u * 0.065, minSize: c.u * 0.028, maxLines: 2 }).fontSize));
    const tSize = hasText ? Math.min(...events.map((e, i) => (e.text ? fitText(e.text, textBoxes[i]!, { maxSize: c.u * 0.042, minSize: c.u * 0.022, maxLines: 3 }).fontSize : Infinity))) : 0;
    events.forEach((e, i) => {
      const lb = labelBoxes[i]!;
      const lf = fitText(e.label, lb, { maxSize: lSize, minSize: lSize, maxLines: 2 });
      if (lf.truncated) warnings.push(`timeline: label "${e.label}" truncated to fit`);
      els.push(...textLines(lf, lb, { font: "heading", color: labelColor(i), beat: i, item: e.item, align, valign: "top" }));
      note(c, "label", e.label, lb, lf, labelColor(i));
      if (e.text) {
        const tb = { ...textBoxes[i]!, y: r(lb.y + lf.height + gap / 2) };
        const tf = fitText(e.text, tb, { maxSize: tSize, minSize: tSize, maxLines: 3 });
        if (tf.truncated) warnings.push(`timeline: text of "${e.label}" truncated to fit`);
        els.push(...textLines(tf, tb, { font: "body", color: c.colors.muted, beat: i + 0.3, item: e.item, align, valign: "top" }));
        note(c, "body", e.text, tb, tf, c.colors.muted);
      }
    });
  };
  const portrait = c.target.height >= c.target.width;
  if (portrait) {
    const rowH = Math.min(c.safe.h / n, c.u * (hasText ? 0.36 : 0.22));
    const top = c.safe.y + (c.safe.h - rowH * n) / 2;
    const lineX = r(c.safe.x + big / 2 + th);
    const textX = r(lineX + big / 2 + c.u * 0.05);
    const textW = c.safe.x + c.safe.w - textX;
    const labelH = r(rowH * (hasText ? 0.42 : 0.85));
    const labelBoxes = events.map((_, i) => ({ x: textX, y: r(top + i * rowH), w: textW, h: labelH }));
    const textBoxes = labelBoxes.map((b) => ({ ...b, h: r(rowH - labelH - gap) }));
    // Dots centred on the first label line (cap middle ≈ 0.6 em below the line top).
    const probe = Math.min(...events.map((e, i) => fitText(e.label, labelBoxes[i]!, { maxSize: c.u * 0.065, minSize: c.u * 0.028, maxLines: 2 }).fontSize));
    const cy = (i: number) => labelBoxes[i]!.y + probe * 0.6;
    els.push({ type: "box", x: r(lineX - th / 2), y: r(cy(0)), w: th, h: Math.max(th, r(cy(n - 1) - cy(0))), color: c.colors.panelEdge, beat: 0 });
    // The progress line reaches the current event as it appears.
    if (cur !== undefined && cur > 0) els.push({ type: "box", x: r(lineX - th / 2), y: r(cy(0)), w: th, h: r(cy(cur) - cy(0)), color: c.colors.primary, beat: cur, item: events[cur]!.item });
    events.forEach((_, i) => pushDot(lineX, cy(i), i));
    drawText(labelBoxes, textBoxes, "left");
  } else {
    const cols = splitH(c.safe, events.map(() => 1), gap);
    const labelH = r(c.u * 0.15);
    const textH = hasText ? r(c.u * 0.2) : 0;
    const blockH = big + gap + labelH + (hasText ? textH : 0);
    const top = c.safe.y + Math.max(0, (c.safe.h - blockH) / 2);
    const lineY = r(top + big / 2);
    const cx = (i: number) => cols[i]!.x + cols[i]!.w / 2;
    els.push({ type: "box", x: r(cx(0)), y: r(lineY - th / 2), w: Math.max(th, r(cx(n - 1) - cx(0))), h: th, color: c.colors.panelEdge, beat: 0 });
    if (cur !== undefined && cur > 0) els.push({ type: "box", x: r(cx(0)), y: r(lineY - th / 2), w: r(cx(cur) - cx(0)), h: th, color: c.colors.primary, beat: cur, item: events[cur]!.item });
    events.forEach((_, i) => pushDot(cx(i), lineY, i));
    const labelBoxes = cols.map((col) => ({ x: col.x, y: r(top + big + gap), w: col.w, h: labelH }));
    drawText(labelBoxes, labelBoxes.map((b) => ({ ...b, h: textH })), "center");
  }
  return { elements: els, warnings };
}

function splitScreen(p: Record<string, unknown>, c: Ctx, images: { left?: Img | null; right?: Img | null }): Layout {
  const warnings: string[] = [];
  const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const beforeAfter = p.mode === "before_after";
  const sides = [obj(p.left), obj(p.right)];
  const labels = sides.map((s, i) => asStr(s.label) ?? (beforeAfter ? (i === 0 ? "Before" : "After") : undefined));
  const accents = beforeAfter ? [c.colors.muted, c.colors.primary] : [c.colors.primary, c.colors.secondary];
  const labelColors = beforeAfter ? [c.colors.text, c.colors.primary] : accents;
  const gap = r(c.u * 0.04);
  const portrait = c.target.height > c.target.width;
  const panels = portrait ? splitV(c.safe, [1, 1], gap) : splitH(c.safe, [1, 1], gap);
  const pad = r(c.u * 0.035);
  const labelH = labels.some(Boolean) ? r(c.u * 0.09) : 0;
  const content = panels.map((pr) => ({ x: pr.x + pad, y: pr.y + pad + labelH, w: pr.w - 2 * pad, h: pr.h - 2 * pad - labelH }));
  // Text shares the panel with an image (bottom quarter) or fills it.
  const areas = sides.map((s, i) => {
    const hasImg = !!asStr(s.asset);
    const hasText = !!asStr(s.text);
    const [imgR, txtR] = hasImg && hasText ? splitV(content[i]!, [3, 1], r(gap / 2)) : hasImg ? [content[i]!, undefined] : [undefined, content[i]!];
    return { imgR, txtR };
  });
  const fits = sides.map((s, i) => (asStr(s.text) && areas[i]!.txtR ? fitText(asStr(s.text)!, areas[i]!.txtR!, { maxSize: c.u * 0.07, minSize: c.u * 0.03 }).fontSize : Infinity));
  const size = Math.min(...fits);
  const th = Math.max(2, r(c.u * 0.006));
  const els: El[] = [];
  sides.forEach((s, i) => {
    const pr = panels[i]!;
    const beat = i * 2;
    const name = i === 0 ? "left" : "right";
    const from = els.length;
    els.push({ type: "box", ...pr, color: c.colors.panel, beat });
    els.push({ type: "box", x: pr.x, y: pr.y, w: pr.w, h: Math.max(2, r(c.u * 0.01)), color: accents[i]!, beat });
    if (beforeAfter && i === 1) els.push({ type: "box", ...pr, color: c.colors.primary, thickness: th, beat });
    const label = labels[i];
    if (label) {
      const lb = { x: pr.x + pad, y: pr.y + pad, w: pr.w - 2 * pad, h: labelH - r(pad / 2) };
      const lf = fitText(label, lb, { maxSize: c.u * 0.06, minSize: c.u * 0.03, maxLines: 1 });
      els.push(...textLines(lf, lb, { font: "heading", color: labelColors[i]!, beat, valign: "top" }));
      note(c, "label", label, lb, lf, labelColors[i]!, c.colors.panel);
    }
    const { imgR, txtR } = areas[i]!;
    if (imgR) {
      const img = images[name];
      if (img) {
        const el = imageIn(img, imgR, beat + 0.5);
        els.push(el, { type: "box", x: el.x, y: el.y, w: el.w, h: el.h, color: c.colors.panelEdge, thickness: Math.max(1, r(c.u * 0.004)), beat: beat + 0.5 });
      } else {
        const msg = `image "${asStr(s.asset)}" unavailable`;
        const f = fitText(msg, inset(imgR, pad), { maxSize: c.u * 0.04, minSize: c.u * 0.02 });
        els.push({ type: "box", ...imgR, color: c.colors.panelEdge, thickness: Math.max(1, r(c.u * 0.004)), beat });
        els.push(...textLines(f, inset(imgR, pad), { font: "body", color: c.colors.muted, beat, slide: false }));
        note(c, "decorative", msg, inset(imgR, pad), f, c.colors.muted, c.colors.panel);
      }
    }
    const text = asStr(s.text);
    if (text && txtR) {
      const tf = fitText(text, txtR, { maxSize: size, minSize: Math.min(size, c.u * 0.03) });
      if (tf.truncated) warnings.push(`split_screen: ${name} text truncated to fit`);
      els.push(...textLines(tf, txtR, { font: "heading", color: c.colors.text, beat: beat + 1, valign: imgR ? "top" : "middle" }));
      note(c, "body", text, txtR, tf, c.colors.text, c.colors.panel);
    }
    if (!text && !imgR) warnings.push(`split_screen: ${name} panel has no text or asset`);
    // Everything in a panel is its side's cue item.
    for (let k = from; k < els.length; k++) els[k]!.item = i;
  });
  return { elements: els, warnings };
}

function lowerThird(p: Record<string, unknown>, c: Ctx): Layout {
  const warnings: string[] = [];
  const name = asStr(p.name) ?? "";
  const title = asStr(p.title);
  const headlineRaw = asStr(p.headline);
  const headline = headlineRaw ? headCase(c, headlineRaw) : undefined;
  const pad = r(c.u * 0.035);
  const accentW = Math.max(3, r(c.u * 0.015));
  const maxW = r(c.safe.w * 0.92) - 2 * pad - accentW;
  const nf = fitText(name, { w: maxW, h: c.u * 0.12 }, { maxSize: c.u * 0.07, minSize: c.u * 0.03, maxLines: 1 });
  if (nf.truncated) warnings.push("lower_third: name truncated to fit");
  const tf = title ? fitText(title, { w: maxW, h: c.u * 0.08 }, { maxSize: c.u * 0.045, minSize: c.u * 0.022, maxLines: 1 }) : undefined;
  if (tf?.truncated) warnings.push("lower_third: title truncated to fit");
  const inner = r(c.u * 0.015);
  const barH = r(2 * pad + nf.height + (tf ? inner + tf.height : 0));
  const barW = Math.min(c.safe.w, r(Math.max(nf.width, tf?.width ?? 0) + 2 * pad + accentW + c.u * 0.04));
  // Low in the content area, which already excludes the platform UI masks.
  const bar: Rect = { x: c.safe.x, y: c.safe.y + c.safe.h - barH, w: barW, h: barH };
  const els: El[] = [];
  if (headline) {
    const gap = r(c.u * 0.06);
    const hr: Rect = { x: c.safe.x, y: c.safe.y, w: c.safe.w, h: Math.max(0, bar.y - gap - c.safe.y) };
    const hf = fitHeading(c, headline, hr, { maxSize: c.u * 0.1, minSize: c.u * 0.04 });
    if (hf.truncated) warnings.push("lower_third: headline truncated to fit");
    els.push(...textLines(hf, hr, { font: "heading", color: c.colors.text, beat: 0, item: 1, align: c.align }));
    note(c, c.main, headline, hr, hf, c.colors.text);
  }
  // Cue items: the name card (bar, name, title) is item 0, the headline item 1.
  els.push({ type: "box", ...bar, color: c.colors.panel, beat: 1, item: 0 });
  els.push({ type: "box", x: bar.x, y: bar.y, w: accentW, h: bar.h, color: c.colors.primary, beat: 1, item: 0 });
  const tx = bar.x + accentW + pad;
  const nr: Rect = { x: tx, y: bar.y + pad, w: maxW, h: r(nf.height) };
  els.push(...textLines(nf, nr, { font: "heading", color: c.colors.text, beat: 1, item: 0, align: "left", valign: "top" }));
  note(c, headline ? "label" : c.main, name, nr, nf, c.colors.text, c.colors.panel);
  if (tf) {
    const trr: Rect = { x: tx, y: r(nr.y + nf.height + inner), w: maxW, h: r(tf.height) };
    els.push(...textLines(tf, trr, { font: "body", color: c.colors.muted, beat: 1.5, item: 0, align: "left", valign: "top" }));
    note(c, "label", title!, trr, tf, c.colors.muted, c.colors.panel);
  }
  return { elements: els, warnings };
}

/** Kinetic-text chunks: exactly the cue items `kineticUnits` (exported for tests). */
export function kineticChunks(text: string, rhythm: "word" | "phrase"): string[] {
  return kineticUnits(text, rhythm);
}

function kineticText(p: Record<string, unknown>, c: Ctx): Layout {
  const warnings: string[] = [];
  const text = headCase(c, asStr(p.text) ?? "");
  const rhythm = p.rhythm === "phrase" ? "phrase" : "word";
  const chunks = kineticChunks(text, rhythm);
  const words = chunks.flatMap((ch) => ch.split(" "));
  const chunkOf = chunks.flatMap((ch, i) => ch.split(" ").map(() => i));
  const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const emphasis = asStr(p.emphasis);
  const emSet = new Set((emphasis ?? "").split(/\s+/).map(norm).filter(Boolean));
  const box = inset(c.safe, r(c.u * 0.03));
  // Fit narrower than the box: words are placed one by one with a wider (bold) glyph estimate.
  const fit = fitHeading(c, rhythm === "phrase" ? chunks : [words.join(" ")], { w: box.w * 0.85, h: box.h }, { maxSize: c.u * 0.14, minSize: c.u * 0.045 });
  if (fit.truncated) warnings.push("kinetic_text: text truncated to fit");
  const els: El[] = [];
  let k = 0;
  let acc = "";
  let hit = false;
  // Right-to-left text: words enter in reading order from the right edge of the line.
  const rtl = baseDirection(text) === "rtl";
  for (const line of placeLines(fit, box, "center", "middle")) {
    const parts = line.text.split(" ").filter(Boolean);
    const space = glyphWidth(" ", fit.fontSize);
    const widths = parts.map((w) => glyphWidth(w, fit.fontSize));
    const lineW = widths.reduce((a, b) => a + b, 0) + space * Math.max(0, parts.length - 1);
    const scale = lineW > box.w ? box.w / lineW : 1;
    let x = c.align === "left" ? (rtl ? box.x + box.w - lineW * scale : box.x) : box.x + (box.w - lineW * scale) / 2;
    if (rtl) x += lineW * scale;
    parts.forEach((w, j) => {
      const beat = chunkOf[Math.min(k, chunkOf.length - 1)] ?? 0;
      const em = emSet.has(norm(w)) && norm(w) !== "";
      if (em) hit = true;
      if (rtl) x -= widths[j]! * scale;
      // RTL words hang from their right edge (libass measures Arabic ink wider than its advances).
      // A chunk is a cue item, and its index is also its beat.
      els.push({ type: "text", text: w, font: "heading", size: fit.fontSize, color: em ? c.colors.primary : c.colors.text, x: r(x), ...(rtl ? { rx: r(x + widths[j]! * scale) } : {}), y: line.y, beat, item: beat, slide: true });
      x += rtl ? -space * scale : (widths[j]! + space) * scale;
      // A hard-broken word spans several pieces: advance once the whole word is consumed.
      acc += w;
      if (acc.length >= (words[k]?.length ?? 0)) {
        k++;
        acc = "";
      }
    });
  }
  note(c, c.main, text, box, fit, c.colors.text);
  if (emphasis && !hit) warnings.push(`kinetic_text: emphasis "${emphasis}" not found in text`);
  return { elements: els, warnings };
}

function map(p: Record<string, unknown>, c: Ctx): Layout {
  const warnings: string[] = [];
  const titleRaw = asStr(p.title);
  const title = titleRaw ? headCase(c, titleRaw) : undefined;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  // `item`: the point's index in `props.points` (its cue item).
  let points = Array.isArray(p.points)
    ? p.points.flatMap((pt, item): { label: string; x: number; y: number; item: number }[] => {
        if (!pt || typeof pt !== "object") return [];
        const o = pt as Record<string, unknown>;
        return typeof o.x === "number" && typeof o.y === "number" ? [{ label: asStr(o.label) ?? "", x: clamp(o.x), y: clamp(o.y), item }] : [];
      })
    : [];
  if (points.length > 8) {
    warnings.push(`map: ${points.length} points exceed 8; only the first 8 are drawn`);
    points = points.slice(0, 8);
  }
  if (points.length === 0) warnings.push("map: no points");
  const gap = r(c.u * 0.035);
  const els: El[] = [];
  const tf = title ? fitHeading(c, title, { w: c.safe.w, h: c.u * 0.18 }, { maxSize: c.u * 0.075, minSize: c.u * 0.03, maxLines: 2 }) : undefined;
  if (tf?.truncated) warnings.push("map: title truncated to fit");
  const titleH = tf ? r(tf.height) : 0;
  const panelH = r(Math.min(c.safe.h - (tf ? titleH + gap : 0), c.safe.w * 1.25));
  const [titleY, panelY] = tf ? vstack(c.safe, [titleH, panelH], gap) : [undefined, ...vstack(c.safe, [panelH], 0)];
  const panel: Rect = { x: c.safe.x, y: panelY!, w: c.safe.w, h: panelH };
  if (tf && title) {
    const tr: Rect = { x: c.safe.x, y: titleY!, w: c.safe.w, h: titleH };
    els.push(...textLines(tf, tr, { font: "heading", color: c.colors.text, beat: 0, align: c.align }));
    note(c, c.main, title, tr, tf, c.colors.text);
  }
  els.push(...roundedBox(panel, c.u * 0.04, c.colors.panel, 0));
  // A faint grid suggests a map without claiming any geography.
  const grid = mixColor(c.colors.panel, c.colors.panelEdge, 0.6);
  const gt = Math.max(1, r(c.u * 0.003));
  for (let i = 1; i < 4; i++) {
    els.push({ type: "box", x: r(panel.x + (panel.w * i) / 4), y: panel.y + r(c.u * 0.02), w: gt, h: panel.h - 2 * r(c.u * 0.02), color: grid, beat: 0 });
    els.push({ type: "box", x: panel.x + r(c.u * 0.02), y: r(panel.y + (panel.h * i) / 4), w: panel.w - 2 * r(c.u * 0.02), h: gt, color: grid, beat: 0 });
  }
  const inner = inset(panel, r(c.u * 0.08));
  const pos = points.map((pt) => ({ ...pt, px: r(inner.x + pt.x * inner.w), py: r(inner.y + pt.y * inner.h) }));
  if (p.route === true && pos.length > 1) {
    const d = Math.max(2, r(c.u * 0.012));
    const step = c.u * 0.03;
    for (let i = 0; i + 1 < pos.length; i++) {
      const a = pos[i]!;
      const b = pos[i + 1]!;
      const n = Math.max(1, Math.min(60, Math.round(Math.hypot(b.px - a.px, b.py - a.py) / step)));
      for (let j = 1; j < n; j++) {
        const t = j / n;
        // The route into a point draws with it (half a beat ahead).
        els.push({ type: "box", x: r(a.px + (b.px - a.px) * t - d / 2), y: r(a.py + (b.py - a.py) * t - d / 2), w: d, h: d, color: c.colors.secondary, beat: i + 1.5, item: b.item });
      }
    }
  } else if (p.route === true) warnings.push("map: route needs at least 2 points");
  const pin = Math.max(6, r(c.u * 0.04));
  const ring = Math.max(1, r(c.u * 0.006));
  const size = Math.max(6, r(c.u * 0.04));
  const border = r(size * 0.35);
  pos.forEach((pt, i) => {
    const beat = 1 + i;
    const item = pt.item;
    els.push({ type: "box", x: pt.px - r(pin / 2) - ring, y: pt.py - r(pin / 2) - ring, w: pin + 2 * ring, h: pin + 2 * ring, color: c.colors.bg, beat, item });
    els.push({ type: "box", x: pt.px - r(pin / 2), y: pt.py - r(pin / 2), w: pin, h: pin, color: c.colors.primary, beat, item });
    if (!pt.label) return;
    const lines = wrapText(pt.label, size, c.safe.w * 0.5);
    const text = lines.length > 1 ? `${lines[0]}…` : (lines[0] ?? pt.label);
    const tw = estimateTextWidth(text, size);
    const right = pt.px + pin / 2 + ring + border * 2;
    const x = right + tw + border <= c.safe.x + c.safe.w ? r(right) : r(Math.max(c.safe.x + border, pt.px - pin / 2 - ring - border * 2 - tw));
    const y = r(Math.min(c.safe.y + c.safe.h - size - border, Math.max(c.safe.y + border, pt.py - size / 2)));
    els.push({ type: "text", text, font: "body", size, color: c.colors.text, x, y, beat, item, slide: false, box: { color: ffColor(c.colors.bg, 0.85), border } });
    note(c, "label", pt.label, { x: x - border, y: y - border, w: tw + 2 * border, h: size + 2 * border }, { fontSize: size, truncated: text !== pt.label }, c.colors.text);
  });
  return { elements: els, warnings };
}

// ---------------------------------------------------------------------------------- public composition

export interface ComposeInputs {
  /** Probed image for screenshot scenes / logo for end cards. */
  image?: { path: string; width: number; height: number } | null;
  /** Probed panel images for split_screen scenes (null = asset given but unreadable). */
  images?: { left?: { path: string; width: number; height: number } | null; right?: { path: string; width: number; height: number } | null };
  /** Layout zones for the enabled platform targets (the safe area is `zones.content`). */
  zones?: LayoutZones;
}

/** Pure layout of a deterministic scene into draw elements (exported for tests and previews). */
export function composeScene(scene: Scene, target: RenderTarget, tokens: VisualTokens, inputs: ComposeInputs = {}): Composition {
  const det = scene.deterministic;
  if (!det) throw new Error(`scene ${scene.id} has no deterministic content`);
  const c: Ctx = {
    target,
    tokens,
    safe: safeArea(target, inputs.zones),
    u: Math.min(target.width, target.height),
    colors: palette(tokens),
    main: scene.purpose === "hook" ? "hook" : "headline",
    boxes: [],
    align: tokens.text_align ?? "center",
  };
  const comp = layoutKind(det, c, inputs);
  return { ...comp, text_boxes: c.boxes };
}

function layoutKind(det: NonNullable<Scene["deterministic"]>, c: Ctx, inputs: ComposeInputs): Layout {
  const p = det.props;
  switch (det.kind) {
    case "typography":
      return typography(p, c);
    case "code":
      return code(p, c);
    case "comparison":
      return comparison(p, c);
    case "cta":
      return cta(p, c);
    case "end_card":
      return endCard(p, c, inputs.image ?? null);
    case "chart":
      return chart(p, c);
    case "diagram":
      return diagram(p, c);
    case "screenshot":
      return screenshot(p, c, inputs.image ?? null);
    case "quote":
      return quote(p, c);
    case "stat":
      return stat(p, c);
    case "timeline":
      return timeline(p, c);
    case "split_screen":
      return splitScreen(p, c, inputs.images ?? {});
    case "lower_third":
      return lowerThird(p, c);
    case "kinetic_text":
      return kineticText(p, c);
    case "map":
      return map(p, c);
    default:
      throw new Error(`${FFMPEG_RENDERER_ID} cannot draw kind "${String((det as { kind: unknown }).kind)}"`);
  }
}

// ---------------------------------------------------------------------------------- filtergraph

/** `name=k=v:...` with both escaping levels applied per value (the result is graph-safe). */
function f(name: string, opts: Record<string, string | number | undefined>): string {
  const parts = Object.entries(opts)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${escapeFiltergraph(escapeFilterOption(String(v)))}`);
  return `${name}=${parts.join(":")}`;
}

export interface MotionTiming {
  step: number;
  fade: number;
}

/**
 * Stagger step and fade length for a clip: every element is fully visible by 60% of the clip.
 * With motion tokens, the fade is the style's `enter_ms` and the step its `stagger_ms`, both
 * capped so the same 60% rule holds.
 */
export function motionTiming(durationS: number, maxBeat: number, motion?: MotionTokens): MotionTiming {
  if (motion) {
    const fade = Math.max(0.04, Math.min(motion.enter_ms / 1000, durationS * 0.3));
    const step = maxBeat > 0 ? Math.min(motion.stagger_ms / 1000, Math.max(0, durationS * 0.6 - fade) / maxBeat) : 0;
    return { step: round3(step), fade: round3(fade) };
  }
  const fade = Math.min(0.4, durationS * 0.2);
  const step = maxBeat > 0 ? Math.min(0.15, (durationS * 0.4) / maxBeat) : 0;
  return { step: round3(step), fade: round3(fade) };
}

/**
 * Entrance curves as FFmpeg expressions of the progress `p` (0..1): the alpha, and the remaining
 * fraction of the slide-up offset. Undefined easing: the renderer's original curves (linear alpha,
 * quadratic slide). spring overshoots (the offset swings past zero, damped); snap is a sharp
 * ease-out with a fast alpha.
 */
export function easingExpr(easing: MotionTokens["easing"] | undefined, p: string): { alpha: string; offset: string } {
  switch (easing) {
    case undefined:
      return { alpha: p, offset: `pow(1-${p},2)` };
    case "linear":
      return { alpha: p, offset: `(1-${p})` };
    case "ease_out":
      return { alpha: `(1-pow(1-${p},2))`, offset: `pow(1-${p},3)` };
    case "ease_in_out":
      return { alpha: `(${p}*${p}*(3-2*${p}))`, offset: `(1-${p}*${p}*(3-2*${p}))` };
    case "spring":
      return { alpha: `min(1,2*${p})`, offset: `(1.6*pow(1-${p},2)*cos(3*PI*${p}))` };
    case "snap":
      return { alpha: `min(1,2*${p})`, offset: `pow(1-${p},4)` };
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** FFmpeg expression for the time since `start` (which may be negative: an opening entrance). */
function since(start: number): string {
  return start < 0 ? `t+${-start}` : `t-${start}`;
}

// ------------------------------------------------------------------------------- scene motion

type Intensity = NonNullable<SceneMotion["intensity"]>;

/**
 * How far each scene motion pattern goes, per intensity: the zoom added for push_in / pull_out,
 * the peak of the punch pop, and the drift pan as a fraction of the frame width. Shared by the
 * FFmpeg, footage and HyperFrames renderers so every renderer moves the frame the same way.
 */
export const SCENE_MOTION_AMOUNT: Readonly<Record<"push_in" | "pull_out" | "punch" | "drift", Readonly<Record<Intensity, number>>>> = Object.freeze({
  push_in: { subtle: 0.03, normal: 0.06, strong: 0.12 },
  pull_out: { subtle: 0.03, normal: 0.06, strong: 0.12 },
  punch: { subtle: 0.04, normal: 0.08, strong: 0.14 },
  drift: { subtle: 0.015, normal: 0.03, strong: 0.06 },
});
/** Length of the punch pop (capped at half the scene). */
export const PUNCH_SEC = 0.25;
/** Length of the reveal wipe (capped at half the scene). */
export const REVEAL_SEC = 0.4;
/** Drift's constant zoom (at least pan + 1% of slack, so the pan never shows an edge). */
export const DRIFT_MIN_ZOOM = 1.04;

/** Resolved numbers of a scene motion (pure; exported for the other renderers and tests). */
export interface SceneMotionParams {
  pattern: SceneMotion["pattern"];
  /** push_in / pull_out: zoom added over the scene; punch: peak zoom added. */
  amount: number;
  /** drift: constant zoom. */
  zoom: number;
  /** drift: total pan as a fraction of the frame width. */
  pan: number;
  /** punch / reveal: seconds of the move (then the frame holds). */
  sec: number;
}

export function sceneMotionParams(motion: SceneMotion, durationS: number): SceneMotionParams {
  const i: Intensity = motion.intensity ?? "normal";
  const p = motion.pattern;
  const amount = p === "push_in" || p === "pull_out" || p === "punch" ? SCENE_MOTION_AMOUNT[p][i] : 0;
  const pan = p === "drift" ? SCENE_MOTION_AMOUNT.drift[i] : 0;
  const zoom = p === "drift" ? round3(Math.max(DRIFT_MIN_ZOOM, 1 + pan + 0.01)) : 1;
  const sec = p === "punch" ? Math.min(PUNCH_SEC, durationS / 2) : p === "reveal" ? Math.min(REVEAL_SEC, durationS / 2) : 0;
  return { pattern: p, amount, zoom, pan, sec: round3(sec) };
}

/**
 * Camera curves as FFmpeg expressions of the progress `p` (0..1). Camera moves never overshoot
 * (a spring would expose an edge on pull_out), so spring uses the ease-out curve. Undefined
 * easing (no style motion tokens): ease-in-out. These match the CSS curves of the HyperFrames
 * renderer closely, not exactly.
 */
export function cameraEaseExpr(easing: MotionTokens["easing"] | undefined, p: string): string {
  switch (easing) {
    case "linear":
      return p;
    case "ease_out":
    case "spring":
      return `(1-pow(1-${p},3))`;
    case "snap":
      return `(1-pow(1-${p},4))`;
    default:
      return `(${p}*${p}*(3-2*${p}))`;
  }
}

/** zoompan expressions (`on` = output frame index) for a zooming or panning pattern. */
export interface ZoomPanExprs {
  z: string;
  x: string;
  y: string;
}

const CENTRE_X = "iw/2-iw/zoom/2";
const CENTRE_Y = "ih/2-ih/zoom/2";

/**
 * zoompan expressions for a scene of `frames` frames: push_in, pull_out, punch and drift; `hold`
 * and `reveal` do not zoom (z = 1). Zoom never drops below 1, so no edge is ever exposed.
 * Expressions contain commas but never colons, so they are safe inside single quotes.
 */
export function zoomPanExprs(motion: SceneMotion, frames: number, fps: number, easing?: MotionTokens["easing"]): ZoomPanExprs {
  const m = sceneMotionParams(motion, frames / fps);
  const last = Math.max(1, frames - 1);
  const e = cameraEaseExpr(easing, `min(1,on/${last})`);
  switch (m.pattern) {
    case "push_in":
      return { z: `1+${m.amount}*${e}`, x: CENTRE_X, y: CENTRE_Y };
    case "pull_out":
      return { z: `1+${m.amount}*(1-${e})`, x: CENTRE_X, y: CENTRE_Y };
    case "punch": {
      const pf = Math.max(1, Math.round(m.sec * fps));
      return { z: `1+${m.amount}*sin(PI*min(1,on/${pf}))`, x: CENTRE_X, y: CENTRE_Y };
    }
    case "drift":
      // The view slides right across the zoomed frame (the picture moves left) by pan × width.
      return { z: String(m.zoom), x: `${CENTRE_X}+iw/zoom*${m.pan}*(${e}-0.5)`, y: CENTRE_Y };
    default:
      return { z: "1", x: CENTRE_X, y: CENTRE_Y };
  }
}

/** `zoompan` for the given expressions; `d` frames per input frame (1 for video, all for a still). */
export function zoomPanFilter(ex: ZoomPanExprs, target: RenderTarget, d: number): string {
  return `zoompan=z='${ex.z}':x='${ex.x}':y='${ex.y}':d=${d}:s=${target.width}x${target.height}:fps=${target.fps}`;
}

/**
 * Chains wiping `inLabel` in from the left over `sec` (a background-coloured plate slides off
 * to the right, uncovering the picture), then holding; timestamps must start at 0.
 */
export function revealChains(target: RenderTarget, durationS: number, sec: number, background: string, easing: MotionTokens["easing"] | undefined, inLabel: string, outLabel: string, tag = "rv"): string[] {
  const e = cameraEaseExpr(easing, `min(1,t/${sec})`);
  return [
    `color=c=${ffColor(background)}:s=${target.width}x${target.height}:r=${target.fps}:d=${(durationS + 1).toFixed(3)}[${tag}bg]`,
    `${inLabel}[${tag}bg]overlay=x='W*${e}':y=0:enable='lt(t,${sec})':eof_action=pass${outLabel}`,
  ];
}

/**
 * Chains applying `motion` to a whole composed frame stream (one frame in, one out, at the
 * target size and fps; timestamps from 0), from `inLabel` to `outLabel`. Zooms and pans run
 * zoompan on a 2x upscale, so steps stay at half an output pixel. Empty for `hold`.
 */
export function sceneMotionChains(motion: SceneMotion, target: RenderTarget, frames: number, background: string, easing: MotionTokens["easing"] | undefined, inLabel: string, outLabel: string): string[] {
  const D = frames / target.fps;
  if (motion.pattern === "hold") return [];
  if (motion.pattern === "reveal") return revealChains(target, D, sceneMotionParams(motion, D).sec, background, easing, inLabel, outLabel);
  const ex = zoomPanExprs(motion, frames, target.fps, easing);
  const zoom = `scale=${target.width * 2}:${target.height * 2}:flags=bicubic,${zoomPanFilter(ex, target, 1)},setsar=1`;
  if (motion.pattern !== "punch") return [`${inLabel}${zoom}${outLabel}`];
  // The pop is over after `sec`: from then on the untouched frame passes through (no resampling blur).
  const sec = sceneMotionParams(motion, D).sec;
  return [`${inLabel}split=2[pca][pcb]`, `[pcb]${zoom}[pcz]`, `[pca][pcz]overlay=x=0:y=0:enable='lt(t,${sec})'${outLabel}`];
}

export interface BuiltGraph {
  /** Extra `-i` inputs (images) after the colour source. */
  inputs: string[][];
  filtergraph: string;
  /** Text payloads to write: file name → contents (drawtext text files and `.ass` scripts). */
  textFiles: Map<string, string>;
  /** Text the graph could not draw faithfully (e.g. Arabic without libass). */
  warnings: string[];
}

/** A font as libass sees it: family name, weight, and the ASS size per px of em (see `assFontSize`). */
export interface AssFont {
  family: string;
  bold: boolean;
  /** ASS font size = em px × `scale` (win height / units per em). */
  scale: number;
  /** Where libass puts the baseline below the line top (OS/2 win ascent), in em. */
  winAscent: number;
  /** Where drawtext puts it (hhea ascender), in em: the layout's baseline. */
  ascent: number;
}

/**
 * libass drawing for lines drawtext cannot shape (Devanagari conjuncts, Arabic joining,
 * right-to-left and mixed-direction lines): libass shapes with HarfBuzz and reorders with FriBidi.
 */
export interface AssTextFonts {
  /** Flat directory holding the font files (libass does not search sub-directories). */
  fontsDir: string;
  /** Latin runs inside those lines, per role. */
  latin: Record<FontRole, AssFont>;
  /** The script's font per role. */
  scripts: Partial<Record<Script, Record<FontRole, AssFont>>>;
}

export interface FontFiles {
  heading: string;
  body: string;
  mono: string;
  /** Font files for lines in a script the role fonts do not cover but drawtext can draw (CJK, Hangul). */
  scripts?: Partial<Record<Script, Partial<Record<FontRole, string>>>>;
  /** libass drawing for lines that need shaping or bidi; absent: drawtext with a warning. */
  ass?: AssTextFonts;
}

/** How one text element is drawn. */
export type TextRoute = { kind: "drawtext"; script?: Script } | { kind: "ass"; script: Script };

/**
 * Route a line: lines with Devanagari, Arabic, Hebrew or other complex-script letters go through
 * libass; CJK and Hangul lines use drawtext with the script's font (which also covers Latin);
 * everything else keeps the role font.
 */
export function textRoute(text: string): TextRoute {
  if (needsShaping(text)) {
    const counts: Script[] = scriptsIn(text).filter((s) => s !== "latin" && s !== "cjk" && s !== "hangul");
    const dom = dominantScript(text);
    return { kind: "ass", script: counts.includes(dom) ? dom : (counts[0] ?? "other") };
  }
  if (hasCjk(text)) return { kind: "drawtext", script: "cjk" };
  if (scriptsIn(text).includes("hangul")) return { kind: "drawtext", script: "hangul" };
  return { kind: "drawtext" };
}

export interface GraphMotion {
  /** Style motion tokens (entrance timing, easing, exit). Absent: the original motion. */
  motion?: MotionTokens;
  /** Colour the exit fades to (the scene background). */
  background?: string;
  /** Stream label the elements are drawn over (default `[0:v]`, the colour source); footage passes its own. */
  base?: string;
  /** Skip the style's exit fade (footage keeps playing to the cut). */
  noExit?: boolean;
  /**
   * `scene.motion`: moves the whole composed frame (before the exit fade). Text boxes stay the
   * unmoved layout: lint checks the rest pose.
   */
  camera?: SceneMotion;
  /** Word cues (`SceneRenderRequest.cues`): each lands its item's elements on the word. */
  cues?: readonly ResolvedCue[];
}

/**
 * Entrance start (seconds) of each element. Without cues: beat × step. With cues, each cue item
 * starts where `cueItemStarts` puts it (its default is its earliest element), and all its
 * elements move with it, keeping their offsets; the count item (a stat's value) instead ends its
 * fade on the word (`countUpWindow` with the fade length), or, when it counts up (`countSpan`, the
 * count's default length), starts just before a count that finishes on the word, as in HyperFrames.
 * Elements outside any item keep beat × step. Then the opening (entrance.ts): the elements of the
 * first default reveal that no cue moved start at `openingStart(fade)`, before frame 0.
 */
export function elementStarts(comp: Pick<Composition, "elements" | "count_item">, step: number, fade: number, cues?: readonly ResolvedCue[], countSpan?: number): number[] {
  const base = comp.elements.map((el) => round3(el.beat * step));
  return openingStarts(comp.elements, base, cuedStarts(comp, base, step, fade, cues, countSpan), cues, fade);
}

/** The first default reveal (earliest `base`) opens the scene, unless a cue placed or moved it. */
function openingStarts(elements: readonly El[], base: readonly number[], starts: number[], cues: readonly ResolvedCue[] | undefined, fade: number): number[] {
  if (!elements.length) return starts;
  const first = Math.min(...base);
  const cued = new Set((cues ?? []).map((c) => c.item));
  const open = openingStart(fade);
  return starts.map((s, k) => {
    const el = elements[k]!;
    const moved = !sameTime(s, base[k]!) || (el.item !== undefined && cued.has(el.item));
    return !moved && sameTime(base[k]!, first) ? Math.min(s, open) : s;
  });
}

function cuedStarts(comp: Pick<Composition, "elements" | "count_item">, base: number[], step: number, fade: number, cues: readonly ResolvedCue[] | undefined, countSpan: number | undefined): number[] {
  if (!cues?.length) return base;
  const n = Math.max(0, ...comp.elements.map((el) => (el.item === undefined ? 0 : el.item + 1)));
  const first: (number | undefined)[] = Array.from({ length: n }, () => undefined);
  comp.elements.forEach((el, k) => {
    if (el.item !== undefined) first[el.item] = Math.min(first[el.item] ?? Infinity, base[k]!);
  });
  // An item with nothing drawn (e.g. an entry past a kind's cap) holds its predecessor's time.
  const defaults: number[] = [];
  first.forEach((d, i) => defaults.push(d ?? (i > 0 ? defaults[i - 1]! : 0)));
  const starts = cueItemStarts(defaults, cues, step);
  const ci = comp.count_item;
  const countCue = ci === undefined ? undefined : cues.find((cue) => cue.item === ci);
  const counts = countSpan !== undefined && comp.elements.some((el) => el.type === "text" && el.count !== undefined && el.item === ci);
  if (countCue && ci! < n)
    starts[ci!] = counts ? round3(Math.max(0, countUpTiming(countSpan, countCue.at_s).at - COUNT_UP_ENTRANCE_LEAD_S)) : countUpWindow(countCue.at_s, fade).start;
  return comp.elements.map((el, k) => (el.item === undefined || el.item >= n ? base[k]! : round3(base[k]! + starts[el.item]! - defaults[el.item]!)));
}

/** Build the filtergraph for a composition. `textDir` is where text files will be written. */
export function buildFilterGraph(comp: Pick<Composition, "elements" | "count_item">, target: RenderTarget, durationS: number, fonts: FontFiles, textDir: string, gm: GraphMotion = {}): BuiltGraph {
  const maxBeat = Math.max(0, ...comp.elements.map((e) => e.beat));
  const { motion } = gm;
  const { step, fade } = motionTiming(durationS, maxBeat, motion);
  const countSpan = countUpSpan(durationS);
  const starts = elementStarts(comp, step, fade, gm.cues, countSpan);
  const slide = Math.max(2, r(Math.min(target.width, target.height) * 0.025));
  const inputs: string[][] = [];
  const textFiles = new Map<string, string>();
  const warnings: string[] = [];
  const chains: string[] = [];
  let chain: string[] = [];
  let cur = gm.base ?? "[0:v]";
  let label = 0;
  const flush = () => {
    flushAss();
    if (!chain.length) return;
    const out = `[b${label++}]`;
    chains.push(`${cur}${chain.join(",")}${out}`);
    cur = out;
    chain = [];
  };
  // Consecutive libass lines share one script; any other element closes it, keeping draw order.
  let assEvents: string[] = [];
  let assFiles = 0;
  const flushAss = () => {
    if (!assEvents.length || !fonts.ass) return;
    const name = `a${assFiles++}.ass`;
    textFiles.set(name, assScript(target, assEvents));
    chain.push(f("ass", { filename: join(textDir, name), fontsdir: fonts.ass.fontsDir }));
    assEvents = [];
  };
  const noted = new Set<string>();
  const warnOnce = (w: string) => {
    if (noted.has(w)) return;
    noted.add(w);
    warnings.push(w);
  };

  for (const [k, el] of comp.elements.entries()) {
    const start = starts[k]!;
    const progress = `min(1,max(0,(${since(start)})/${fade}))`;
    const ease = easingExpr(motion?.easing, progress);
    const route = el.type === "text" ? textRoute(el.text) : undefined;
    if (route?.kind === "ass" && el.type === "text") {
      const a = fonts.ass;
      if (a) {
        assEvents.push(assEvent(el, a, a.scripts[route.script]?.[el.font], { start, fade, end: durationS + 1, slide: el.slide ? slide : 0 }));
        continue;
      }
      warnOnce(
        textDirection(el.text) === "ltr"
          ? `text: "${el.text.slice(0, 24)}" needs complex shaping (${route.script}), but this FFmpeg has no libass \`ass\` filter and drawtext has no FriBidi/script shaping; conjuncts and vowel signs may be wrong. Use the HyperFrames renderer or an FFmpeg built with libass.`
          : `text: "${el.text.slice(0, 24)}" is right-to-left${textDirection(el.text) === "mixed" ? " mixed with left-to-right runs" : ""}; FFmpeg drawtext has no FriBidi here and this FFmpeg has no libass \`ass\` filter, so letters are not joined or reordered. Use the HyperFrames renderer or an FFmpeg built with libass.`,
      );
    }
    if (el.type === "box") {
      flushAss();
      chain.push(
        f("drawbox", {
          x: el.x,
          y: el.y,
          w: Math.max(1, el.w),
          h: Math.max(1, el.h),
          color: el.color.startsWith("0x") ? el.color : ffColor(el.color),
          t: el.thickness ?? "fill",
          enable: start > 0 ? `gte(t,${start})` : undefined,
        }),
      );
    } else if (el.type === "text") {
      flushAss();
      const scriptFile = route?.kind === "drawtext" && route.script ? fonts.scripts?.[route.script]?.[el.font] : undefined;
      const draw = (text: string, x: string | number, enable?: string) => {
        const name = `t${textFiles.size}.txt`;
        textFiles.set(name, text);
        chain.push(
          f("drawtext", {
            fontfile: scriptFile ?? fonts[el.font],
            textfile: join(textDir, name),
            expansion: "none",
            fontsize: el.size,
            fontcolor: ffColor(el.color),
            x,
            y: el.slide ? `${el.y}+${slide}*${ease.offset}` : el.y,
            y_align: "font",
            alpha: fade > 0 ? ease.alpha : undefined,
            ...(el.box ? { box: 1, boxcolor: el.box.color, boxborderw: el.box.border } : {}),
            enable,
          }),
        );
      };
      const x = el.cx !== undefined ? `${el.cx}-text_w/2` : el.rx !== undefined ? `${el.rx}-text_w` : el.x;
      if (el.count === undefined) draw(el.text, x);
      else {
        // Count-up (count-up.ts, the same values and slots as HyperFrames): each value only in its
        // slot [start, start + len), then the final value; all share the element's entrance.
        const cue = el.item === comp.count_item ? gm.cues?.find((cu) => cu.item === el.item) : undefined;
        const timing = countUpTiming(countSpan, cue?.at_s);
        const count = withEarlyFirstStep(countUpSteps(el.count, timing.at, timing.span), start);
        for (const st of count.steps) {
          const text = formatNumber(st.value);
          draw(text, countX(el, text, el.text), `gte(t,${round3(st.start)})*lt(t,${round3(st.start + st.len)})`);
        }
        draw(el.text, x, `gte(t,${round3(count.done)})`);
      }
    } else {
      flush();
      const idx = inputs.length + 1;
      // An opening image (start < 0) is fed `early` s longer and fades from its first frame, then
      // trimmed back to frame 0: the fade filter cannot start before the stream does.
      const early = start < 0 && fade > 0 ? -start : 0;
      inputs.push(["-loop", "1", "-framerate", String(target.fps), "-t", (durationS + early).toFixed(3), "-i", el.path]);
      const img = `[i${idx}]`;
      const fadeF =
        fade > 0
          ? `,${f("fade", { t: "in", st: Math.max(0, start), d: fade, alpha: 1 })}${early ? `,${f("trim", { start: early })},setpts=PTS-STARTPTS` : ""}`
          : "";
      chains.push(`[${idx}:v]${f("scale", { w: el.w, h: el.h, flags: "bicubic" })},format=rgba${fadeF}${img}`);
      const out = `[b${label++}]`;
      chains.push(`${cur}${img}${f("overlay", { x: el.x, y: el.y, format: "auto", eof_action: "repeat" })}${out}`);
      cur = out;
    }
  }
  // Exit: the whole frame fades back to the background over the style's exit_ms, ending on the last frame.
  flushAss();
  // Scene motion moves the composed frame (text boxes stay the unmoved rest pose).
  if (gm.camera && gm.camera.pattern !== "hold") {
    flush();
    chains.push(...sceneMotionChains(gm.camera, target, frameCount(durationS, target.fps), gm.background ?? "#000000", motion?.easing, cur, "[cam]"));
    cur = "[cam]";
  }
  const exit = motion && !gm.noExit ? round3(Math.min(exitFadeMs(motion) / 1000, durationS * 0.2)) : 0;
  if (exit >= 0.02) chain.push(f("fade", { t: "out", st: round3(Math.max(0, durationS - 1 / target.fps - exit)), d: exit, color: ffColor(gm.background ?? "#000000") }));
  chain.push("format=yuv420p");
  const out = "[vout]";
  chains.push(`${cur}${chain.join(",")}${out}`);
  return { inputs, filtergraph: chains.join(";"), textFiles, warnings };
}

// ---------------------------------------------------------------------------------- libass text

/** `#RRGGBB` → ASS `&HBBGGRR&`. */
function assTagColour(hex: string): string {
  const h = toHex(rgb(hex)).slice(1);
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`;
}

/** ASS alpha (`&H00&` opaque … `&HFF&` clear) for an opacity 0..1. */
function assAlpha(opacity: number): string {
  return `&H${Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255).toString(16).padStart(2, "0").toUpperCase()}&`;
}

function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${Math.floor(cs / 360_000)}:${p(Math.floor(cs / 6000) % 60)}:${p(Math.floor(cs / 100) % 60)}.${p(cs % 100)}`;
}

/** Scene text inside an ASS event: override braces and backslashes cannot appear literally. */
function assLiteral(text: string): string {
  return text.replace(/\\/g, "∖").replace(/\{/g, "(").replace(/\}/g, ")").replace(/[\r\n]+/g, " ");
}

/** ASCII punctuation and digits the bundled script fonts have (Noto Sans Arabic has few; Devanagari most). */
const SCRIPT_ASCII: Partial<Record<Script, RegExp>> = {
  arabic: /[ !,\-.0-9:]/,
  devanagari: /[^$&@`A-Za-z]/,
};
/** The Unicode blocks of each script (their neutral punctuation, e.g. ، ؟ ।, belongs with the script font). */
const SCRIPT_BLOCK: Partial<Record<Script, RegExp>> = {
  arabic: /[\u0600-\u06FF\u0750-\u077F\u0870-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/u,
  devanagari: /[\u0900-\u097F\uA8E0-\uA8FF\u1CD0-\u1CFF]/u,
  hebrew: /[\u0590-\u05FF\uFB1D-\uFB4F]/u,
};

/**
 * Split a line into font runs: Latin letters use the role's Latin font; letters of the line's
 * script use the script font; neutral characters stay with the script font when it has them
 * (its own block, or ASCII it covers), else the Latin font.
 */
export function assFontRuns(text: string, script: Script): { latin: boolean; text: string }[] {
  const runs: { latin: boolean; text: string }[] = [];
  const ascii = SCRIPT_ASCII[script];
  const block = SCRIPT_BLOCK[script];
  for (const ch of text) {
    const s = charScript(ch);
    let latin: boolean;
    if (s === "latin") latin = true;
    else if (s !== null) latin = false;
    else if (block?.test(ch)) latin = false;
    else if (/\s/u.test(ch)) latin = runs.at(-1)?.latin ?? false;
    else if (ch.charCodeAt(0) < 0x80) latin = ascii ? !ascii.test(ch) : false;
    else latin = ascii !== undefined; // other neutrals (…, —, “ ”): the Latin font has them
    const last = runs.at(-1);
    if (last && last.latin === latin) last.text += ch;
    else runs.push({ latin, text: ch });
  }
  return runs;
}

/**
 * One ASS event for a text element: positioned like drawtext (top of the line at `y`, left edge,
 * centre or right edge), faded in from `start` over `fade` and slid up by `slide` px. libass
 * picks the base direction per line (Encoding -1) and shapes each font run.
 */
function assEvent(el: TextEl, fonts: AssTextFonts, scriptFont: AssFont | undefined, t: { start: number; fade: number; end: number; slide: number }): string {
  const an = el.cx !== undefined ? 8 : el.rx !== undefined ? 9 : 7;
  const x = el.cx ?? el.rx ?? el.x;
  const latin = fonts.latin[el.font];
  const script = scriptFont ?? latin;
  const route = textRoute(el.text);
  const runs = route.kind === "ass" ? assFontRuns(el.text, route.script) : [{ latin: true, text: el.text }];
  const fontTag = (fnt: AssFont) => `\\fn${fnt.family}\\fs${Math.round(el.size * fnt.scale * 100) / 100}\\b${fnt.bold ? 1 : 0}`;
  const fadeMs = Math.round(t.fade * 1000);
  // An opening entrance (start < 0) is already `done` of the way in at the event's start (0).
  const doneMs = t.start < 0 ? Math.min(fadeMs, Math.round(-t.start * 1000)) : 0;
  const p0 = fadeMs > 0 ? doneMs / fadeMs : 1;
  // libass hangs the baseline at the tallest run's win ascent below the top; drawtext (and the
  // layout) at the font's hhea ascender. Lift the line so the baselines agree.
  const winAsc = Math.max(...runs.map((run) => (run.latin ? latin : script).winAscent));
  const y = Math.round(el.y - (winAsc - script.ascent) * el.size);
  const restMs = fadeMs - doneMs;
  const move = t.slide > 0 && restMs > 0 ? `\\move(${x},${Math.round(y + t.slide * (1 - p0))},${x},${y},0,${restMs})` : `\\pos(${x},${y})`;
  const fadeTag = restMs <= 0 ? "" : doneMs > 0 ? `\\fade(${Math.round(255 * (1 - p0))},0,0,0,${restMs},${restMs},${restMs})` : `\\fad(${fadeMs},0)`;
  const head = `{\\an${an}${move}${fadeTag}\\1c${assTagColour(el.color)}\\bord${el.box ? el.box.border : 0}${el.box ? assBoxTags(el.box.color) : ""}}`;
  const body = runs.map((run) => `{${fontTag(run.latin ? latin : script)}}${assLiteral(run.text)}`).join("");
  return `Dialogue: 0,${assTime(t.start)},${assTime(t.end)},${el.box ? "Box" : "Text"},,0,0,0,,${head}${body}`;
}

/** Plate colour tags for a label box (`0xRRGGBB[@a]` from ffColor). */
function assBoxTags(color: string): string {
  const m = /^0x([0-9A-Fa-f]{6})(?:@([0-9.]+))?$/.exec(color);
  if (!m) return "";
  return `\\3c${assTagColour(`#${m[1]}`)}\\3a${assAlpha(m[2] ? Number(m[2]) : 1)}`;
}

/** A complete ASS script at the target size: `Text` (no border) and `Box` (opaque box behind each line). */
function assScript(target: RenderTarget, events: readonly string[]): string {
  const style = (name: string, borderStyle: number) =>
    `Style: ${name},sans-serif,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,${borderStyle},0,0,7,0,0,0,-1`;
  return [
    "[Script Info]",
    "; video-studio ffmpeg renderer: complex-script text",
    "ScriptType: v4.00+",
    `PlayResX: ${target.width}`,
    `PlayResY: ${target.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    style("Text", 1),
    style("Box", 3),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------- renderer

async function readContentIrAsset(assetId: string, projectDir: string): Promise<string | null> {
  try {
    const ir = JSON.parse(await readFile(join(projectDir, "source", "content-ir.json"), "utf8")) as { assets?: { id: string; path: string }[] };
    const a = ir.assets?.find((x) => x.id === assetId);
    if (!a) return null;
    return await resolveInsideProject(projectPaths(projectDir), a.path);
  } catch {
    return null;
  }
}

async function probeImage(path: string, tools?: FfmpegTools): Promise<{ path: string; width: number; height: number } | null> {
  try {
    const p = await ffprobe(path, { tools });
    return p.width && p.height ? { path, width: p.width, height: p.height } : null;
  } catch {
    return null;
  }
}

export function frameCount(durationSec: number, fps: number): number {
  return Math.max(1, Math.round(durationSec * fps));
}

/** Args for one render (exported for tests); `-y` overwrites `out`. */
export function ffmpegRenderArgs(built: BuiltGraph, target: RenderTarget, tokens: VisualTokens, frames: number, encode: FfmpegEncodeSettings, out: string): string[] {
  const durationS = frames / target.fps;
  const bg = f("color", { c: ffColor(tokens.color_background), s: `${target.width}x${target.height}`, r: target.fps, d: (durationS + 1 / target.fps).toFixed(4) });
  return [
    "-y",
    "-f",
    "lavfi",
    "-i",
    bg,
    ...built.inputs.flat(),
    "-filter_complex",
    built.filtergraph,
    "-map",
    "[vout]",
    "-frames:v",
    String(frames),
    "-r",
    String(target.fps),
    ...h264Args({ preset: encode.preset ?? "veryfast", crf: encode.crf ?? 18 }),
    "-threads",
    String(encode.threads ?? 1),
    "-an",
    "-sn",
    "-dn",
    "-map_metadata",
    "-1",
    "-fflags",
    "+bitexact",
    "-flags:v",
    "+bitexact",
    ...FASTSTART,
    out,
  ];
}

/** Whether an FFmpeg has the libass `ass` filter (memoised per binary). */
const assFilterCache = new Map<string, Promise<boolean>>();
function hasAssFilter(tools: FfmpegTools): Promise<boolean> {
  let p = assFilterCache.get(tools.ffmpeg);
  if (!p) {
    p = runProcess(tools.ffmpeg, ["-hide_banner", "-filters"], { captureStdout: true, timeoutMs: 15_000 })
      .then(({ stdout }) => /\sass\s/.test(stdout))
      .catch(() => false);
    assFilterCache.set(tools.ffmpeg, p);
  }
  return p;
}

const ROLES: readonly FontRole[] = ["heading", "body", "mono"];

/** Family name libass should ask for: the bundled family of a bundled file, else the chain's first named family. */
function assFamily(file: string, chain: string, fontsDir: string | null): string {
  const hit = fontsDir ? BUNDLED_FONTS.find((b) => join(fontsDir, b.file) === file) : undefined;
  if (hit) return hit.family;
  return parseFontChain(chain).find((n) => !/^(sans-serif|serif|monospace|system-ui|ui-monospace|ui-sans-serif)$/i.test(n)) ?? "sans-serif";
}

/**
 * Resolve the fonts a composition's text needs beyond the three role fonts: a script font per
 * role for CJK/Hangul drawtext lines, and libass fonts (flat fonts dir, Latin + script
 * families, size scales) for lines that need shaping. Returns warnings for scripts without a
 * bundled font.
 */
async function scriptFonts(
  comp: Pick<Composition, "elements">,
  tokens: VisualTokens,
  resolve: FontResolver,
  weights: Record<FontRole, number | undefined>,
  o: { fontsDir: string | null; libassDir: string; libass: boolean },
): Promise<{ scripts?: FontFiles["scripts"]; ass?: AssTextFonts; warnings: string[] }> {
  const warnings: string[] = [];
  const chains: Record<FontRole, string> = { heading: tokens.font_heading, body: tokens.font_body, mono: tokens.font_mono };
  const draw = new Map<Script, Set<FontRole>>();
  const shaped = new Map<Script, Set<FontRole>>();
  for (const el of comp.elements) {
    if (el.type !== "text") continue;
    const route = textRoute(el.text);
    if (!route.script) continue;
    const m = route.kind === "ass" ? shaped : draw;
    if (!m.has(route.script)) m.set(route.script, new Set());
    m.get(route.script)!.add(el.font);
  }
  const out: { scripts?: FontFiles["scripts"]; ass?: AssTextFonts; warnings: string[] } = { warnings };
  for (const [script, roles] of draw) {
    for (const role of roles) {
      const file = await resolve(scriptFirstChain(chains[role], script, tokens.language), weights[role]);
      (out.scripts ??= {})[script] = { ...out.scripts?.[script], [role]: file };
    }
  }
  if (shaped.size === 0 || !o.libass) return out;
  const files = new Set<string>();
  const assFont = async (chain: string, role: FontRole): Promise<AssFont> => {
    const file = await resolve(chain, weights[role]);
    files.add(file);
    const family = assFamily(file, chain, o.fontsDir);
    // Both weights of a bundled family, so libass can switch with \b.
    for (const b of BUNDLED_FONTS) if (b.family === family && o.fontsDir) files.add(join(o.fontsDir, b.file));
    const metrics = readFontMetrics(file);
    return {
      family,
      bold: (weights[role] ?? 400) >= 600,
      scale: assFontSize(1, metrics),
      winAscent: metrics ? metrics.winAscent / metrics.unitsPerEm : 1,
      ascent: metrics ? metrics.hheaAscent / metrics.unitsPerEm : 1,
    };
  };
  const latin = {} as Record<FontRole, AssFont>;
  for (const role of ROLES) latin[role] = await assFont(chains[role], role);
  const scripts: AssTextFonts["scripts"] = {};
  for (const [script, roles] of shaped) {
    if (scriptFontFamilies(script, tokens.language).length === 0) {
      warnings.push(`text: ${script === "other" ? "this script" : script} has no bundled font; libass falls back to a host font`);
    }
    const perRole = {} as Record<FontRole, AssFont>;
    for (const role of ROLES) perRole[role] = roles.has(role) || role === "heading" ? await assFont(scriptFirstChain(chains[role], script, tokens.language), role) : latin[role];
    scripts[script] = perRole;
  }
  await prepareLibassFontsDir(o.libassDir, [...files].sort(), o.fontsDir);
  out.ass = { fontsDir: o.libassDir, latin, scripts };
  return out;
}

export function createFfmpegRenderer(opts: FfmpegRendererOptions = {}): SceneRenderer {
  const fontResolver = opts.fontResolver ?? createFontResolver();
  const resolveAsset = opts.resolveAsset ?? readContentIrAsset;
  const encode: FfmpegEncodeSettings = { ...opts.encode, ...(opts.encodePreset ? { preset: opts.encodePreset } : {}) };
  const availability = new Map<string, Promise<Availability>>();

  const checkAvailable = async (env: NodeJS.ProcessEnv): Promise<Availability> => {
    try {
      const tools = opts.tools ?? (await resolveFfmpeg(env));
      const { stdout } = await runProcess(tools.ffmpeg, ["-hide_banner", "-filters"], { captureStdout: true, timeoutMs: 15_000 });
      const missing = ["drawtext", "drawbox", "overlay", "color"].filter((name) => !new RegExp(`\\s${name}\\s`).test(stdout));
      if (missing.length) return { ok: false, reason: `ffmpeg lacks filter(s) ${missing.join(", ")} (drawtext needs a build with libfreetype)` };
      const feats = await ffmpegFeatures({ tools });
      if (!feats.libx264) return { ok: false, reason: "ffmpeg was built without libx264" };
      await fontResolver("sans-serif");
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  };

  return {
    id: FFMPEG_RENDERER_ID,
    version: FFMPEG_RENDERER_VERSION,
    kinds: FFMPEG_RENDERER_KINDS,
    available(env) {
      const key = `${env.FFMPEG_PATH ?? ""}\0${env.FFPROBE_PATH ?? ""}\0${env.PATH ?? ""}`;
      let p = availability.get(key);
      if (!p) {
        p = checkAvailable(env);
        availability.set(key, p);
      }
      return p;
    },
    async render(req: SceneRenderRequest, ropts: { signal?: AbortSignal } = {}): Promise<SceneRenderResult> {
      const { scene, target, tokens } = req;
      const det = scene.deterministic;
      if (!det) throw new Error(`scene ${scene.id} has no deterministic content`);
      if (!(FFMPEG_RENDERER_KINDS as readonly string[]).includes(det.kind)) throw new Error(`${FFMPEG_RENDERER_ID} cannot draw kind "${det.kind}"`);
      const tools = await getTools(opts.tools);
      const warnings: string[] = [];

      let image: ComposeInputs["image"] = null;
      if (det.kind === "screenshot") {
        const id = typeof det.props.asset === "string" ? det.props.asset : "";
        const path = id ? await resolveAsset(id, req.project_dir) : null;
        image = path ? await probeImage(path, tools) : null;
        if (!image) warnings.push(`screenshot: asset "${id}" could not be resolved or read; drew a placeholder panel`);
      } else if (det.kind === "end_card" && tokens.logo_path) {
        const lp = tokens.logo_path;
        // Project-relative only (symlinks resolved): a brand logo can never pull in a file from elsewhere on disk.
        let path: string | null = null;
        try {
          path = await resolveInsideProject(projectPaths(req.project_dir), lp);
        } catch {
          path = null;
          warnings.push(`end_card: logo "${lp}" must be a path inside the project (copy it into assets/); skipped`);
        }
        if (path && extname(path).toLowerCase() === ".svg") {
          warnings.push("end_card: SVG logos are not supported by ffmpeg-drawtext; logo skipped");
        } else {
          image = path ? await probeImage(path, tools) : null;
          if (!image) warnings.push(`end_card: logo "${lp}" could not be read; skipped`);
        }
      }

      const images: NonNullable<ComposeInputs["images"]> = {};
      if (det.kind === "split_screen") {
        for (const side of ["left", "right"] as const) {
          const panel = det.props[side];
          const id = panel && typeof panel === "object" && typeof (panel as { asset?: unknown }).asset === "string" ? (panel as { asset: string }).asset : "";
          if (!id) continue;
          const path = await resolveAsset(id, req.project_dir);
          images[side] = path ? await probeImage(path, tools) : null;
          if (!images[side]) warnings.push(`split_screen: ${side} asset "${id}" could not be resolved or read; drew a placeholder`);
        }
      }

      const comp = composeScene(scene, target, tokens, { image, images, ...(req.zones ? { zones: req.zones } : {}) });
      warnings.push(...comp.warnings);
      // Bold headings by default, matching the HTML renderer (bundled Inter has a real Bold);
      // style/brand weights pick the nearest bundled file (600+ Bold, lighter Regular).
      const weights: Record<FontRole, number | undefined> = { heading: tokens.weight_heading ?? 700, body: tokens.weight_body, mono: undefined };
      const fonts: FontFiles = {
        heading: await fontResolver(tokens.font_heading, weights.heading),
        body: await fontResolver(tokens.font_body, weights.body),
        mono: await fontResolver(tokens.font_mono),
      };
      const frames = frameCount(scene.duration_sec, target.fps);
      const tmp = await mkdtemp(join(tmpdir(), "vs-ffr-"));
      try {
        const needsAss = comp.elements.some((e) => e.type === "text" && textRoute(e.text).kind === "ass");
        const extra = await scriptFonts(comp, tokens, fontResolver, weights, {
          fontsDir: opts.fontsDir === undefined ? findFontsDir() : opts.fontsDir,
          libassDir: join(tmp, "fonts"),
          libass: needsAss && (await hasAssFilter(tools)),
        });
        warnings.push(...extra.warnings);
        if (extra.scripts) fonts.scripts = extra.scripts;
        if (extra.ass) fonts.ass = extra.ass;
        const built = buildFilterGraph(comp, target, frames / target.fps, fonts, tmp, {
          ...(tokens.motion ? { motion: tokens.motion } : {}),
          background: tokens.color_background,
          ...(scene.motion ? { camera: scene.motion } : {}),
          ...(req.cues?.length ? { cues: req.cues } : {}),
        });
        warnings.push(...built.warnings);
        for (const [name, text] of built.textFiles) await writeFile(join(tmp, name), text, "utf8");
        await mkdir(dirname(req.out_path), { recursive: true });
        await runFfmpeg(ffmpegRenderArgs(built, target, tokens, frames, encode, req.out_path), { tools, signal: ropts.signal, timeoutMs: 10 * 60_000 });
      } finally {
        if (!opts.keepTemp) await rm(tmp, { recursive: true, force: true });
      }
      return {
        scene_id: scene.id,
        out_path: req.out_path,
        duration_ms: Math.round((frames * 1000) / target.fps),
        renderer: FFMPEG_RENDERER_ID,
        renderer_version: FFMPEG_RENDERER_VERSION,
        warnings,
        text_boxes: comp.text_boxes,
      };
    },
  };
}

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join } from "node:path";
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
import type { DeterministicKind, Scene, TextBox, TextRole } from "@video-studio/schema";
import {
  type FitResult,
  type Rect,
  estimateTextWidth,
  fitText,
  inset,
  placeLines,
  safeArea,
  splitH,
  splitV,
  wrapText,
} from "./text-layout.js";
import { type FontResolver, createFontResolver } from "./tokens.js";
import type { Availability, LayoutZones, RenderTarget, SceneRenderRequest, SceneRenderResult, SceneRenderer, VisualTokens } from "./types.js";

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
export const FFMPEG_RENDERER_VERSION = "0.2.0";

export const FFMPEG_RENDERER_KINDS = [
  "typography",
  "code",
  "chart",
  "diagram",
  "screenshot",
  "comparison",
  "cta",
  "end_card",
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
}

// ---------------------------------------------------------------------------------- composition model

type FontRole = "heading" | "body" | "mono";

interface TextEl {
  type: "text";
  text: string;
  font: FontRole;
  size: number;
  color: string;
  /** Left edge in px, or centred on `cx` using the measured text width. */
  x: number;
  cx?: number;
  y: number;
  beat: number;
  slide?: boolean;
  box?: { color: string; border: number };
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
}

interface ImageEl {
  type: "image";
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
  beat: number;
}

type El = TextEl | BoxEl | ImageEl;

export interface Composition {
  elements: El[];
  warnings: string[];
  /** Every text block laid out, for lint (overflow, mask collisions, contrast). */
  text_boxes: TextBox[];
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
  o: { font: FontRole; color: string | ((line: string, i: number) => string); beat: number | ((i: number) => number); align?: "left" | "center"; valign?: "top" | "middle" | "bottom"; slide?: boolean },
): TextEl[] {
  const mono = o.font === "mono";
  return placeLines(fit, box, o.align ?? "center", o.valign ?? "middle", { mono })
    .filter((l) => l.text.trim().length > 0)
    .map((l, i) => ({
      type: "text" as const,
      text: l.text,
      font: o.font,
      size: l.fontSize,
      color: typeof o.color === "function" ? o.color(l.text, i) : o.color,
      x: l.x,
      ...(o.align === "left" ? {} : { cx: r(l.cx) }),
      y: l.y,
      beat: typeof o.beat === "function" ? o.beat(i) : o.beat,
      slide: o.slide ?? true,
    }));
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
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

// ---------------------------------------------------------------------------------- per-kind layouts

function typography(p: Record<string, unknown>, c: Ctx): Layout {
  const warnings: string[] = [];
  const lines = Array.isArray(p.lines) ? p.lines.filter((l): l is string => typeof l === "string" && l.trim() !== "") : [];
  if (lines.length === 0) warnings.push("typography: no lines to draw");
  const emphasis = asStr(p.emphasis)?.trim();
  const box = inset(c.safe, r(c.u * 0.02));
  const fit = fitText(lines, box, { maxSize: c.u * 0.12, minSize: c.u * 0.04 });
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
  const els = textLines(fit, box, { font: "heading", color, beat: (i) => i });
  note(c, c.main, lines.join("\n"), box, fit, c.colors.text);
  if (em && !hit) warnings.push(`typography: emphasis "${emphasis}" not found in lines`);
  if (em && hit) warnings.push("typography: emphasis colours the whole line containing it (no per-word styling in ffmpeg-drawtext)");
  return { elements: els, warnings };
}

function code(p: Record<string, unknown>, c: Ctx): Layout {
  const warnings: string[] = [];
  const src = (asStr(p.code) ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(/\s+$/, "");
  const lang = asStr(p.language) ?? "";
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
    });
  }
  for (const l of placed) {
    if (!l.text.trim()) continue;
    els.push({ type: "text", text: l.text, font: "mono", size: fit.fontSize, color: c.colors.text, x: l.x, y: l.y, beat: 1, slide: false });
  }
  return { elements: els, warnings };
}

function comparison(p: Record<string, unknown>, c: Ctx): Layout {
  const warnings: string[] = [];
  const side = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const left = side(p.left);
  const right = side(p.right);
  const verdict = asStr(p.verdict);
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
    els.push({ type: "box", ...pr, color: c.colors.panel, beat });
    els.push({ type: "box", x: pr.x, y: pr.y, w: pr.w, h: Math.max(2, r(c.u * 0.008)), color: accent, beat });
    const lf = fitText(asStr(s.label) ?? "", { w: pr.w - 2 * pad, h: labelH - pad / 2 }, { maxSize: c.u * 0.06, minSize: c.u * 0.03, maxLines: 1 });
    const labelBox = { x: pr.x + pad, y: pr.y + pad, w: pr.w - 2 * pad, h: labelH - pad / 2 };
    els.push(...textLines(lf, labelBox, { font: "heading", color: accent, beat, valign: "top" }));
    note(c, "label", asStr(s.label) ?? "", labelBox, lf, accent, c.colors.panel);
    const bf = fitText(asStr(s.text) ?? "", bodyBoxes[i]!, { maxSize: bodySize, minSize: Math.min(bodySize, c.u * 0.03) });
    if (bf.truncated) warnings.push(`comparison: ${i === 0 ? "left" : "right"} text truncated to fit`);
    els.push(...textLines(bf, bodyBoxes[i]!, { font: "body", color: c.colors.text, beat: beat + 1, valign: "top" }));
    note(c, "body", asStr(s.text) ?? "", bodyBoxes[i]!, bf, c.colors.text, c.colors.panel);
  });
  if (verdict && verdictR) {
    const vf = fitText(verdict, verdictR, { maxSize: c.u * 0.06, minSize: c.u * 0.03 });
    if (vf.truncated) warnings.push("comparison: verdict truncated to fit");
    els.push(...textLines(vf, verdictR, { font: "heading", color: c.colors.text, beat: 4 }));
    note(c, "headline", verdict, verdictR, vf, c.colors.text);
  }
  return { elements: els, warnings };
}

function cta(p: Record<string, unknown>, c: Ctx): Layout {
  const warnings: string[] = [];
  const headline = asStr(p.headline) ?? "";
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
      const f = fitText(headline, rect, { maxSize: c.u * 0.11, minSize: c.u * 0.04 });
      if (f.truncated) warnings.push("cta: headline truncated to fit");
      els.push(...textLines(f, rect, { font: "heading", color: c.colors.text, beat: 0, valign: "bottom" }));
      note(c, c.main === "hook" ? "hook" : "cta", headline, rect, f, c.colors.text);
    } else if (key === "action") {
      const maxW = r(rect.w * 0.9);
      const f = fitText(action!, { w: maxW - r(c.u * 0.08), h: rect.h * 0.6 }, { maxSize: c.u * 0.06, minSize: c.u * 0.03, maxLines: 1 });
      if (f.truncated) warnings.push("cta: action truncated to fit");
      const pillW = Math.min(maxW, r(f.width + c.u * 0.1));
      const pillH = r(f.fontSize * 2.1);
      const pill: Rect = { x: r(rect.x + (rect.w - pillW) / 2), y: r(rect.y + (rect.h - pillH) / 2), w: pillW, h: pillH };
      els.push({ type: "box", ...pill, color: c.colors.primary, beat: 1 });
      els.push(...textLines(f, pill, { font: "heading", color: c.colors.bg, beat: 1, slide: false }));
      note(c, "cta", action!, pill, f, c.colors.bg, c.colors.primary);
    } else if (key === "command") {
      const pad = r(c.u * 0.03);
      const text = `$ ${command}`;
      const f = fitText([text], { w: rect.w - 2 * pad, h: rect.h - 2 * pad }, { mono: true, noWrap: true, maxSize: c.u * 0.045, minSize: c.u * 0.02 });
      if (f.truncated) warnings.push("cta: command truncated to fit");
      const boxH = Math.min(rect.h, r(f.height + 2 * pad));
      const bw = Math.min(rect.w, r(f.width + 2 * pad));
      const panel: Rect = { x: r(rect.x + (rect.w - bw) / 2), y: r(rect.y + (rect.h - boxH) / 2), w: bw, h: boxH };
      els.push({ type: "box", ...panel, color: c.colors.panel, beat: 2 });
      els.push({ type: "box", ...panel, color: c.colors.panelEdge, thickness: Math.max(1, r(c.u * 0.003)), beat: 2 });
      els.push(...textLines(f, inset(panel, pad), { font: "mono", color: c.colors.secondary, beat: 2, slide: false }));
      note(c, "code", text, inset(panel, pad), f, c.colors.secondary, c.colors.panel);
    } else {
      const f = fitText(url!, rect, { maxSize: c.u * 0.04, minSize: c.u * 0.02, maxLines: 2 });
      els.push(...textLines(f, rect, { font: "body", color: c.colors.muted, beat: 3, valign: "top" }));
      note(c, "label", url!, rect, f, c.colors.muted);
    }
  });
  return { elements: els, warnings };
}

function endCard(p: Record<string, unknown>, c: Ctx, logo: { path: string; width: number; height: number } | null): Layout {
  const warnings: string[] = [];
  const title = asStr(p.title);
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
      els.push({ type: "image", path: logo.path, x: r(rect.x + (rect.w - w) / 2), y: r(rect.y + (rect.h - h) / 2), w, h, beat: 0 });
    } else if (key === "title") {
      const f = fitText(title!, rect, { maxSize: c.u * 0.12, minSize: c.u * 0.04 });
      if (f.truncated) warnings.push("end_card: title truncated to fit");
      els.push(...textLines(f, rect, { font: "heading", color: c.colors.text, beat: 1, valign: parts.length === 1 ? "middle" : "bottom" }));
      note(c, c.main, title!, rect, f, c.colors.text);
    } else {
      const f = fitText(subtitle!, rect, { maxSize: c.u * 0.055, minSize: c.u * 0.025 });
      if (f.truncated) warnings.push("end_card: subtitle truncated to fit");
      els.push(...textLines(f, rect, { font: "body", color: c.colors.primary, beat: 2, valign: "top" }));
      note(c, "body", subtitle!, rect, f, c.colors.primary);
    }
  });
  return { elements: els, warnings };
}

function formatNumber(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 100) / 100);
}

function statLayout(value: string, label: string | undefined, c: Ctx, warnings: string[]): Layout {
  const [numR, labelR] = label ? splitV(c.safe, [3, 2], r(c.u * 0.03)) : [c.safe, undefined];
  const els: El[] = [];
  const nf = fitText(value, numR!, { maxSize: c.u * 0.32, minSize: c.u * 0.06, maxLines: 1, lineHeight: 1.1 });
  if (nf.truncated) warnings.push("chart: value truncated to fit");
  els.push(...textLines(nf, numR!, { font: "heading", color: c.colors.primary, beat: 0, valign: label ? "bottom" : "middle" }));
  note(c, c.main, value, numR!, nf, c.colors.primary);
  if (label && labelR) {
    const lf = fitText(label, labelR, { maxSize: c.u * 0.065, minSize: c.u * 0.03 });
    if (lf.truncated) warnings.push("chart: label truncated to fit");
    els.push(...textLines(lf, labelR, { font: "body", color: c.colors.text, beat: 1, valign: "top" }));
    note(c, "label", label, labelR, lf, c.colors.text);
  }
  return { elements: els, warnings };
}

const MAX_BARS = 12;

function chart(p: Record<string, unknown>, c: Ctx): Layout {
  const warnings: string[] = [];
  const type = asStr(p.type) ?? "stat";
  const unit = typeof p.unit === "string" ? p.unit : "";
  const label = asStr(p.label);
  const series = Array.isArray(p.series)
    ? p.series.filter((s): s is { label: string; value: number } => !!s && typeof s === "object" && typeof (s as { value?: unknown }).value === "number")
    : [];
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
      const tf = fitText(label, titleR, { maxSize: c.u * 0.065, minSize: c.u * 0.03, maxLines: 2 });
      els.push(...textLines(tf, titleR, { font: "heading", color: c.colors.text, beat: 0, valign: "bottom" }));
      note(c, c.main, label, titleR, tf, c.colors.text);
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
      const labelLines = wrapText(s.label || " ", labelSize, rr.w);
      const text = labelLines.length > 1 ? `${labelLines[0]}…` : (labelLines[0] ?? "");
      if (text.trim()) els.push({ type: "text", text, font: "body", size: labelSize, color: c.colors.text, x: rr.x, y: rr.y, beat, slide: false });
      note(c, "label", s.label, { x: rr.x, y: rr.y, w: rr.w, h: labelSize * 1.35 }, { fontSize: labelSize, truncated: labelLines.length > 1 }, c.colors.text);
      const barY = r(rr.y + labelSize * 1.35);
      const barH = Math.max(2, r(Math.min(rr.h - labelSize * 1.35, c.u * 0.07)));
      const trackW = Math.max(2, rr.w - valueW);
      els.push({ type: "box", x: rr.x, y: barY, w: trackW, h: barH, color: c.colors.panel, beat });
      const bw = max > 0 ? r((Math.max(0, s.value) / max) * trackW) : 0;
      if (bw >= 1) els.push({ type: "box", x: rr.x, y: barY, w: bw, h: barH, color: c.colors.primary, beat: beat + 0.25 });
      els.push({
        type: "text",
        text: fmt(s.value),
        font: "body",
        size: labelSize,
        color: c.colors.primary,
        x: rr.x + trackW + r(c.u * 0.02),
        y: r(barY + (barH - labelSize) / 2),
        beat: beat + 0.25,
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
  return statLayout(fmt(value), statLabel, c, warnings);
}

function diagram(p: Record<string, unknown>, c: Ctx): Layout {
  const warnings = ["diagram: basic grid layout with orthogonal edges and square arrowheads (ffmpeg-drawtext)"];
  const nodes = Array.isArray(p.nodes) ? [...new Set(p.nodes.filter((n): n is string => typeof n === "string" && n.trim() !== ""))] : [];
  const edges = Array.isArray(p.edges)
    ? p.edges.filter((e): e is [string, string] => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string")
    : [];
  const n = nodes.length;
  if (n === 0) return { elements: [], warnings: [...warnings, "diagram: no nodes"] };
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
  const line = (x1: number, y1: number, x2: number, y2: number, beat: number) => {
    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    els.push({ type: "box", x: r(x - (x1 === x2 ? th / 2 : 0)), y: r(y - (y1 === y2 ? th / 2 : 0)), w: Math.max(th, r(Math.abs(x2 - x1))), h: Math.max(th, r(Math.abs(y2 - y1))), color: c.colors.muted, beat });
  };
  const arrow = (x: number, y: number, beat: number) => els.push({ type: "box", x: r(x - head / 2), y: r(y - head / 2), w: head, h: head, color: c.colors.primary, beat });
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
    els.push({ type: "box", ...rect, color: c.colors.panel, beat: i });
    els.push({ type: "box", ...rect, color: c.colors.primary, thickness: th, beat: i });
    const f = fitText(name, labelBox, { maxSize: size, minSize: size });
    if (f.truncated) warnings.push(`diagram: label "${name}" truncated to fit`);
    els.push(...textLines(f, inset(rect, pad), { font: "body", color: c.colors.text, beat: i, slide: false }));
    note(c, "label", name, inset(rect, pad), f, c.colors.text, c.colors.panel);
  }
  return { elements: els, warnings };
}

type Callout = { text: string; x?: number; y?: number };

function screenshot(p: Record<string, unknown>, c: Ctx, image: { path: string; width: number; height: number } | null): Layout {
  const warnings: string[] = [];
  const callouts: Callout[] = Array.isArray(p.callouts)
    ? p.callouts.flatMap((co): Callout[] => {
        if (typeof co === "string" && co.trim()) return [{ text: co }];
        if (co && typeof co === "object" && typeof (co as Callout).text === "string") {
          const o = co as Callout;
          return [{ text: o.text, ...(typeof o.x === "number" ? { x: o.x } : {}), ...(typeof o.y === "number" ? { y: o.y } : {}) }];
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
    els.push({ type: "box", x: mx - r(m / 2), y: my - r(m / 2), w: m, h: m, color: c.colors.primary, beat });
    const text = wrapText(co.text, size, c.safe.w * 0.6)[0] ?? co.text;
    const tw = estimateTextWidth(text, size);
    const border = r(size * 0.35);
    const rightX = mx + m;
    const x = rightX + tw + border * 2 > c.target.width - c.safe.x ? r(Math.max(border, mx - m - tw - border)) : rightX + border;
    els.push({ type: "text", text, font: "body", size, color: c.colors.text, x, y: my - r(size / 2), beat, slide: false, box: { color: ffColor(c.colors.bg, 0.85), border } });
    note(c, "label", co.text, { x: x - border, y: my - r(size / 2) - border, w: tw + 2 * border, h: size + 2 * border }, { fontSize: size, truncated: text !== co.text }, c.colors.text);
  });
  if (listed.length && listR) {
    const rowsR = splitV(listR, listed.map(() => 1), r(c.u * 0.015));
    listed.forEach((co, i) => {
      const rr = rowsR[i]!;
      const beat = 1 + pinned.length + i;
      const bar = Math.max(2, r(c.u * 0.008));
      els.push({ type: "box", x: rr.x, y: rr.y, w: bar, h: rr.h, color: c.colors.primary, beat });
      const tr: Rect = { x: rr.x + bar * 3, y: rr.y, w: rr.w - bar * 3, h: rr.h };
      const f = fitText(co.text, tr, { maxSize: c.u * 0.05, minSize: c.u * 0.022, maxLines: 2 });
      if (f.truncated) warnings.push(`screenshot: callout "${co.text.slice(0, 30)}" truncated`);
      els.push(...textLines(f, tr, { font: "body", color: c.colors.text, beat, align: "left" }));
      note(c, "body", co.text, tr, f, c.colors.text);
    });
  }
  return { elements: els, warnings };
}

// ---------------------------------------------------------------------------------- public composition

export interface ComposeInputs {
  /** Probed image for screenshot scenes / logo for end cards. */
  image?: { path: string; width: number; height: number } | null;
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

/** Stagger step and fade length for a clip: every element is fully visible by 60% of the clip. */
export function motionTiming(durationS: number, maxBeat: number): MotionTiming {
  const fade = Math.min(0.4, durationS * 0.2);
  const step = maxBeat > 0 ? Math.min(0.15, (durationS * 0.4) / maxBeat) : 0;
  return { step: round3(step), fade: round3(fade) };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface BuiltGraph {
  /** Extra `-i` inputs (images) after the colour source. */
  inputs: string[][];
  filtergraph: string;
  /** Text payloads to write: file name → contents. */
  textFiles: Map<string, string>;
}

export interface FontFiles {
  heading: string;
  body: string;
  mono: string;
}

/** Build the filtergraph for a composition. `textDir` is where text files will be written. */
export function buildFilterGraph(comp: Pick<Composition, "elements">, target: RenderTarget, durationS: number, fonts: FontFiles, textDir: string): BuiltGraph {
  const maxBeat = Math.max(0, ...comp.elements.map((e) => e.beat));
  const { step, fade } = motionTiming(durationS, maxBeat);
  const slide = Math.max(2, r(Math.min(target.width, target.height) * 0.025));
  const inputs: string[][] = [];
  const textFiles = new Map<string, string>();
  const chains: string[] = [];
  let chain: string[] = [];
  let cur = "[0:v]";
  let label = 0;
  const flush = () => {
    if (!chain.length) return;
    const out = `[b${label++}]`;
    chains.push(`${cur}${chain.join(",")}${out}`);
    cur = out;
    chain = [];
  };

  for (const el of comp.elements) {
    const start = round3(el.beat * step);
    const progress = `min(1,max(0,(t-${start})/${fade}))`;
    if (el.type === "box") {
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
      const name = `t${textFiles.size}.txt`;
      textFiles.set(name, el.text);
      chain.push(
        f("drawtext", {
          fontfile: fonts[el.font],
          textfile: join(textDir, name),
          expansion: "none",
          fontsize: el.size,
          fontcolor: ffColor(el.color),
          x: el.cx !== undefined ? `${el.cx}-text_w/2` : el.x,
          y: el.slide ? `${el.y}+${slide}*pow(1-${progress},2)` : el.y,
          y_align: "font",
          alpha: fade > 0 ? progress : undefined,
          ...(el.box ? { box: 1, boxcolor: el.box.color, boxborderw: el.box.border } : {}),
        }),
      );
    } else {
      flush();
      const idx = inputs.length + 1;
      inputs.push(["-loop", "1", "-framerate", String(target.fps), "-t", durationS.toFixed(3), "-i", el.path]);
      const img = `[i${idx}]`;
      const fadeF = fade > 0 ? `,${f("fade", { t: "in", st: start, d: fade, alpha: 1 })}` : "";
      chains.push(`[${idx}:v]${f("scale", { w: el.w, h: el.h, flags: "bicubic" })},format=rgba${fadeF}${img}`);
      const out = `[b${label++}]`;
      chains.push(`${cur}${img}${f("overlay", { x: el.x, y: el.y, format: "auto", eof_action: "repeat" })}${out}`);
      cur = out;
    }
  }
  chain.push("format=yuv420p");
  const out = "[vout]";
  chains.push(`${cur}${chain.join(",")}${out}`);
  return { inputs, filtergraph: chains.join(";"), textFiles };
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
        let path: string | null = null;
        try {
          path = isAbsolute(lp) ? lp : await resolveInsideProject(projectPaths(req.project_dir), lp);
        } catch {
          path = null;
        }
        if (path && extname(path).toLowerCase() === ".svg") {
          warnings.push("end_card: SVG logos are not supported by ffmpeg-drawtext; logo skipped");
        } else {
          image = path ? await probeImage(path, tools) : null;
          if (!image) warnings.push(`end_card: logo "${lp}" could not be read; skipped`);
        }
      }

      const comp = composeScene(scene, target, tokens, { image, ...(req.zones ? { zones: req.zones } : {}) });
      warnings.push(...comp.warnings);
      const fonts: FontFiles = {
        // Bold headings, matching the HTML renderer (bundled Inter has a real Bold).
        heading: await fontResolver(tokens.font_heading, 700),
        body: await fontResolver(tokens.font_body),
        mono: await fontResolver(tokens.font_mono),
      };
      const frames = frameCount(scene.duration_sec, target.fps);
      const tmp = await mkdtemp(join(tmpdir(), "vs-ffr-"));
      try {
        const built = buildFilterGraph(comp, target, frames / target.fps, fonts, tmp);
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

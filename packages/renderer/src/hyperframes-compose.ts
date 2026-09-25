import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeterministicKind, TextBox, TextRole } from "@video-studio/schema";
import { codeLabel, escapeHtml, highlightLines, languageFamily } from "./hyperframes-highlight.js";
import { applyTextCase, safeArea, wrapText } from "./text-layout.js";
import { fontFaceCss } from "./tokens.js";
import type { MotionTokens, SceneRenderRequest, VisualTokens } from "./types.js";

/**
 * Pure HTML composition builder for the HyperFrames renderer (pinned @hyperframes/producer 0.8.75).
 *
 * Authoring contract (verified against the 0.8.75 runtime, lint and docs shipped in node_modules):
 * - root `<div data-composition-id data-start="0" data-duration data-width data-height>`;
 * - one timed clip (`class="clip"`, `id`, `data-start`, `data-duration`, `data-track-index`);
 * - a paused timeline registered on `window.__timelines[<composition id>]`.
 *
 * GSAP is NOT bundled by the producer (its docs load it from a CDN, which we must not do), so
 * motion is authored as CSS keyframe animations, which the runtime's built-in `css` frame
 * adapter seeks per frame (`animation.currentTime`, paused). The registered timeline is a small
 * GSAP-shaped object (`duration/seek/totalTime/pause/play/...`) whose `seek(t)` applies the same
 * deterministic state, so either seek path yields identical frames. No wall clock, timers,
 * randomness or network: the page is a pure function of time.
 *
 * All scene text is untrusted and HTML-escaped; tokens are validated (hex colours, sanitized font
 * names) before they reach CSS. Fonts are local only (`@font-face { src: local(...) }`), which
 * also stops the producer's compiler from fetching Google Fonts for named families.
 */

export interface CompositionAsset {
  /** Absolute source path on disk. */
  src: string;
  /** Path relative to the composition directory (what the HTML references). */
  dest: string;
}

export interface Composition {
  composition_id: string;
  html: string;
  assets: CompositionAsset[];
  /** Props that could not be honoured (surfaced to QA). */
  warnings: string[];
  /**
   * Text blocks, for lint. Rects are the boxes the text was fitted into (the browser places the
   * text inside them); `truncated` means the estimate did not fit at the minimum size, so the
   * browser clips or overflows it.
   */
  text_boxes: TextBox[];
}

export interface BuildCompositionOptions {
  /**
   * Resolve a ContentIR asset id (screenshot `asset`) to an absolute path. When omitted, or when it
   * returns undefined, ids that look like project-relative paths are resolved against project_dir.
   */
  resolveAsset?: (id: string) => string | undefined;
}

export const HYPERFRAMES_KINDS: readonly DeterministicKind[] = [
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
];

const IMAGE_EXT = /^\.(png|jpe?g|webp|gif|avif|svg)$/i;
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const GENERIC_FONTS = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
]);
/** The string tokens (fonts and colours) the stylesheet always needs. */
type CoreTokens = Pick<VisualTokens, "font_heading" | "font_body" | "font_mono" | "color_background" | "color_text" | "color_primary" | "color_secondary">;
const FALLBACK_TOKENS: CoreTokens = {
  font_heading: "Helvetica, Arial, sans-serif",
  font_body: "Helvetica, Arial, sans-serif",
  font_mono: "Menlo, monospace",
  color_background: "#0B0F19",
  color_text: "#F5F7FA",
  color_primary: "#4F8CFF",
  color_secondary: "#22C55E",
};

// ------------------------------------------------------------------------------------ helpers

const esc = escapeHtml;

/** Seconds as a short deterministic decimal string ("0.15", "3"). */
export function fmtSec(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function px(n: number): string {
  return `${Math.round(n * 100) / 100}px`;
}

/** Locale-independent number formatting (thousands separators, max 2 decimals). */
export function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const fixed = Number.isInteger(abs) ? String(abs) : String(Math.round(abs * 100) / 100);
  const [int, frac] = fixed.split(".");
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return sign + grouped + (frac ? `.${frac}` : "");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined;
}

/** Sanitize a CSS font-family chain: named families are re-quoted, anything odd is dropped. */
export function sanitizeFontChain(chain: string, fallback: string): { css: string; names: string[] } {
  const out: string[] = [];
  const names: string[] = [];
  for (const raw of chain.split(",")) {
    const name = raw.trim().replace(/^["']|["']$/g, "").trim();
    if (!name) continue;
    const lower = name.toLowerCase();
    if (GENERIC_FONTS.has(lower)) out.push(lower);
    else if (/^[\p{L}\p{N} _.-]{1,64}$/u.test(name) && !name.startsWith("-")) {
      out.push(`"${name}"`);
      names.push(name);
    }
  }
  if (out.length === 0) return sanitizeFontChain(fallback, "sans-serif");
  if (!out.some((f) => GENERIC_FONTS.has(f))) out.push(/mono|menlo|courier|consol/i.test(chain) ? "monospace" : "sans-serif");
  return { css: out.join(", "), names };
}

interface Stage {
  W: number;
  H: number;
  /** 1% of the short side, in px. */
  u: number;
  safe: { x: number; y: number; w: number; h: number };
  portrait: boolean;
  dur: number;
}

/**
 * Easing names → CSS timing functions (the runtime seeks CSS animations; GSAP is not bundled).
 * ease_out is the renderer's original curve; spring overshoots (y > 1); snap is a sharp ease-out.
 */
export const EASING_CSS: Readonly<Record<MotionTokens["easing"], string>> = Object.freeze({
  linear: "linear",
  ease_out: "cubic-bezier(0.22, 1, 0.36, 1)",
  ease_in_out: "cubic-bezier(0.65, 0, 0.35, 1)",
  spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  snap: "cubic-bezier(0.2, 0.9, 0.1, 1)",
});

/** Effects that are element entrances (their length follows the style's `enter_ms`). */
const ENTRANCES = new Set(["fade", "fade-up", "scale-in", "pop", "pop-center", "slide-right", "slide-left", "grow-x", "grow-x-rev", "grow-x-center", "grow-y", "kin"]);

/**
 * Motion tokens of the composition being built. buildComposition is synchronous and sets this for
 * the duration of one build (and always resets it), so anim()/stagger() stay plain functions.
 */
let activeMotion: MotionTokens | undefined;

/** Entrance timing: `n` staggered items, all finished by ~60% of the scene. */
function stagger(n: number, dur: number, first = 0.1): { at: (i: number) => number; len: number } {
  if (activeMotion) {
    const len = Math.max(0.05, Math.min(activeMotion.enter_ms / 1000, dur * 0.3));
    const budget = Math.max(0, dur * 0.6 - first - len);
    const step = n > 1 ? Math.min(activeMotion.stagger_ms / 1000, budget / (n - 1)) : 0;
    return { at: (i) => first + i * step, len };
  }
  const len = Math.max(0.2, Math.min(0.6, dur * 0.25));
  const budget = Math.max(0, dur * 0.6 - first - len);
  const step = n > 1 ? Math.min(0.18, budget / (n - 1)) : 0;
  return { at: (i) => first + i * step, len };
}

/** Attributes for an animated element. Only computed numbers reach the style attribute. */
function anim(effect: string, at: number, len: number, cls = "", style = ""): string {
  if (activeMotion && ENTRANCES.has(effect)) len = Math.max(0.05, activeMotion.enter_ms / 1000);
  const c = `${cls ? `${cls} ` : ""}vs-a vs-${effect}`;
  return `class="${c}" style="--t:${fmtSec(at)}s;--d:${fmtSec(len)}s${style ? `;${style}` : ""}"`;
}

interface FontFit {
  fs: number;
  /** False when the text does not fit even at `minFs` (the browser will clip or overflow it). */
  fits: boolean;
}

/**
 * Largest font size (px) at which `texts` fit a box when the browser wraps them at `boxW`,
 * estimated from an average advance of `em` × size per character.
 */
function fitFontInfo(texts: readonly string[], boxW: number, boxH: number, maxFs: number, minFs: number, lineHeight = 1.2, em = 0.56): FontFit {
  const longestWord = Math.max(0, ...texts.flatMap((t) => t.split(/\s+/).map((w) => Array.from(w).length)));
  const ok = (size: number) => {
    const perLine = Math.max(1, Math.floor(boxW / (size * em)));
    const lines = texts.reduce((acc, t) => acc + Math.max(1, Math.ceil(Array.from(t).length / perLine)), 0);
    return lines * size * lineHeight <= boxH && longestWord <= perLine;
  };
  let fs = maxFs;
  for (let guard = 0; guard < 60 && fs > minFs; guard++) {
    if (ok(fs)) break;
    fs *= 0.92;
  }
  const size = Math.max(minFs, Math.round(fs * 100) / 100);
  return { fs: size, fits: ok(size) };
}

function fitFont(texts: readonly string[], boxW: number, boxH: number, maxFs: number, minFs: number, lineHeight = 1.2, em = 0.56): number {
  return fitFontInfo(texts, boxW, boxH, maxFs, minFs, lineHeight, em).fs;
}

/** `#RRGGBB` mix of a→b by t, matching CSS `color-mix(in srgb, b t, a)`. */
function mixHex(a: string, b: string, t: number): string {
  const ch = (h: string) => {
    const x = h.replace(/^#/, "");
    const full = x.length === 3 || x.length === 4 ? x.slice(0, 3).replace(/./g, (c) => c + c) : x.slice(0, 6);
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  };
  const [p, q] = [ch(a), ch(b)];
  return `#${p.map((v, i) => Math.round(v + (q[i]! - v) * t).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

// ---------------------------------------------------------------------------------- per kind

interface KindCtx {
  stage: Stage;
  props: Record<string, unknown>;
  warnings: string[];
  asset: (absPath: string, name: string) => string;
  resolveAsset: (id: string) => string | undefined;
  logo?: string;
  /** Role of the scene's main text: `hook` in the hook scene, else `headline`. */
  main: TextRole;
  /** Resolved colours (#RRGGBB) for text-box contrast. */
  colors: { bg: string; text: string; primary: string; secondary: string; panel: string };
  boxes: TextBox[];
  /** Style heading treatment: case transform and size multiplier (absent: as authored, 1). */
  head: { case?: VisualTokens["text_case"]; scale?: number };
}

/** Heading text with the style's case transform (hook/headline roles). */
function hc(ctx: KindCtx, text: string): string {
  return applyTextCase(text, ctx.head.case);
}

/** Glyph advance for heading fits: capitals are wider than the mixed-case estimate. */
function headEm(ctx: KindCtx, em: number): number {
  return ctx.head.case === "upper" ? Math.max(em, 0.7) : em;
}

/**
 * fitFontInfo for a heading: the style's heading scale multiplies the fitted size, which is
 * re-fitted downwards when it no longer fits. Without style tokens this is exactly fitFontInfo.
 */
function headFit(ctx: KindCtx, texts: readonly string[], boxW: number, boxH: number, maxFs: number, minFs: number, lineHeight = 1.2, em = 0.56, caseAware = true): FontFit {
  const e = caseAware ? headEm(ctx, em) : em;
  const fit = fitFontInfo(texts, boxW, boxH, maxFs, minFs, lineHeight, e);
  const k = ctx.head.scale;
  if (k === undefined || k === 1 || (k > 1 && !fit.fits)) return fit;
  const size = fit.fs * k;
  return fitFontInfo(texts, boxW, boxH, size, Math.min(minFs, size), lineHeight, e);
}

/** textBlock for a heading (see headFit). */
function headBlock(ctx: KindCtx, text: string, w: number, maxH: number, maxFs: number, minFs: number, lineHeight = 1.2, em = 0.56, caseAware = true): { fit: FontFit; h: number } {
  const e = caseAware ? headEm(ctx, em) : em;
  const fit = headFit(ctx, [text], w, maxH, maxFs, minFs, lineHeight, em, caseAware);
  const lines = wrapText(text, fit.fs, w, e === em ? {} : { em: e }).length;
  return { fit, h: fit.fits ? Math.min(maxH, lines * fit.fs * lineHeight) : maxH };
}

/** Record a text block drawn in `box` (stage px relative to the safe area unless `abs`). */
function rec(
  ctx: KindCtx,
  role: TextRole,
  text: string,
  box: { x?: number; y?: number; w: number; h: number },
  fit: FontFit,
  color: string,
  background: string = ctx.colors.bg,
  abs = false,
): void {
  if (!text.trim()) return;
  const { safe } = ctx.stage;
  const x0 = (abs ? 0 : safe.x) + (box.x ?? 0);
  const y0 = (abs ? 0 : safe.y) + (box.y ?? 0);
  const x = Math.round(x0);
  const y = Math.round(y0);
  ctx.boxes.push({
    role,
    text,
    rect: { x, y, w: Math.max(0, Math.round(x0 + box.w) - x), h: Math.max(0, Math.round(y0 + box.h) - y) },
    font_px: fit.fs,
    truncated: !fit.fits,
    color: mixHex(color, color, 0),
    background: mixHex(background, background, 0),
  });
}

function renderTypography(ctx: KindCtx): string {
  const { stage, props, warnings } = ctx;
  const lines = Array.isArray(props.lines) ? props.lines.map(str).filter((l): l is string => Boolean(l)).map((l) => hc(ctx, l)) : [];
  if (lines.length === 0) warnings.push("typography: no `lines` to show");
  const emphasis = str(props.emphasis);
  const { u, safe } = stage;
  const fit = headFit(ctx, lines, safe.w, safe.h * 0.9, u * 11, u * 3.2, 1.15, 0.58);
  const fs = fit.fs;
  rec(ctx, ctx.main, lines.join("\n"), { y: safe.h * 0.05, w: safe.w, h: safe.h * 0.9 }, fit, ctx.colors.text);
  const st = stagger(lines.length, stage.dur);
  let found = false;
  const body = lines
    .map((line, i) => {
      let html = esc(line);
      if (emphasis) {
        const idx = line.toLowerCase().indexOf(emphasis.toLowerCase());
        if (idx >= 0) {
          found = true;
          html =
            esc(line.slice(0, idx)) +
            `<span class="vs-em">${esc(line.slice(idx, idx + emphasis.length))}</span>` +
            esc(line.slice(idx + emphasis.length));
        }
      }
      return `<div ${anim("fade-up", st.at(i), st.len)}><span class="vs-line">${html}</span></div>`;
    })
    .join("\n");
  if (emphasis && !found) warnings.push(`typography: emphasis "${emphasis}" does not occur in any line`);
  return `<div class="vs-stack vs-typography" style="font-size:${px(fs)}">\n${body}\n</div>`;
}

function renderCode(ctx: KindCtx): string {
  const { stage, props, warnings } = ctx;
  const language = str(props.language) ?? "text";
  const raw = (str(props.code) ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(/\n+$/, "");
  const highlight = new Set(Array.isArray(props.highlight_lines) ? props.highlight_lines.filter((n): n is number => Number.isInteger(n)) : []);
  const { u, safe } = stage;
  const allLines = highlightLines(raw, language);
  const rawLines = raw.split("\n");
  const panelH = safe.h * 0.9;
  const minFs = Math.max(8, u * 1.6);
  const maxLines = Math.max(1, Math.floor(panelH / (minFs * 1.45)) - 1);
  let shown = allLines;
  if (allLines.length > maxLines) {
    shown = allLines.slice(0, maxLines);
    warnings.push(`code: ${allLines.length} lines do not fit; showing the first ${maxLines}`);
  }
  const gutterChars = String(shown.length).length + 1;
  const maxLen = Math.max(1, ...rawLines.slice(0, shown.length).map((l) => Array.from(l).length));
  const innerW = safe.w - u * 6;
  let fs = Math.min(u * 4.2, innerW / ((maxLen + gutterChars + 1) * 0.6), panelH / ((shown.length + 1) * 1.45));
  if (fs < minFs) {
    fs = minFs;
    warnings.push("code: long lines are clipped at the panel edge");
  }
  for (const n of highlight) if (n > shown.length) warnings.push(`code: highlight_lines ${n} is outside the shown code`);
  const clipped = shown.length < allLines.length || maxLen * fs * 0.6 > innerW + 0.01;
  rec(ctx, "code", raw, { x: u * 3, y: (safe.h - panelH) / 2 + u * 3, w: innerW, h: panelH - u * 6 }, { fs: Math.round(fs * 100) / 100, fits: !clipped }, ctx.colors.text, ctx.colors.panel);
  const st = stagger(shown.length, stage.dur, 0.25);
  const rows = shown
    .map((html, i) => {
      const n = i + 1;
      const hl = highlight.has(n);
      return `<div ${anim("fade", st.at(i), st.len)}><div class="vs-code-line${hl ? " vs-hl" : ""}"><span class="vs-ln">${n}</span><span class="vs-src">${html || " "}</span></div></div>`;
    })
    .join("\n");
  return [
    `<div ${anim("scale-in", 0, 0.4, `vs-code-panel`)} data-language="${esc(language)}" data-family="${languageFamily(language)}">`,
    `<div class="vs-code-bar"><span></span><span></span><span></span>${codeLabel(language) ? `<em>${esc(codeLabel(language)!)}</em>` : ""}</div>`,
    `<div class="vs-code" style="font-size:${px(fs)}">`,
    rows,
    `</div>`,
    `</div>`,
  ].join("\n");
}

interface SeriesPoint {
  label: string;
  value: number;
}

function renderChart(ctx: KindCtx): string {
  const { stage, props, warnings } = ctx;
  const type = str(props.type) ?? "stat";
  const series: SeriesPoint[] = Array.isArray(props.series)
    ? props.series
        .map((p) => (p && typeof p === "object" ? (p as Record<string, unknown>) : {}))
        .filter((p) => typeof p.value === "number" && Number.isFinite(p.value))
        .map((p) => ({ label: typeof p.label === "string" ? p.label : "", value: p.value as number }))
    : [];
  const unit = str(props.unit) ?? "";
  const label = str(props.label);
  const { u, safe } = stage;
  const title = label ? `<div ${anim("fade-up", 0.05, 0.5, `vs-chart-title`)}>${esc(hc(ctx, label))}</div>` : "";
  const titleFs = u * 5.5;

  if (type === "stat" || series.length === 0) {
    if (type !== "stat") warnings.push(`chart: type "${type}" needs \`series\`; showing the value as a stat`);
    const raw = props.value ?? series[0]?.value;
    const value = typeof raw === "number" ? fmtNumber(raw) : (str(raw) ?? "");
    const vfit = headFit(ctx, [value + unit], safe.w, safe.h * 0.45, u * 30, u * 6, 1, 0.6, false);
    const fs = vfit.fs;
    const lfit = label ? fitFontInfo([label], safe.w, safe.h * 0.25, u * 7, u * 3) : undefined;
    rec(ctx, ctx.main, value + unit, { y: safe.h * 0.05, w: safe.w, h: safe.h * 0.45 }, vfit, ctx.colors.primary);
    if (label && lfit) rec(ctx, "label", label, { y: safe.h * 0.55, w: safe.w, h: safe.h * 0.25 }, lfit, ctx.colors.text);
    return [
      `<div class="vs-stack vs-stat">`,
      `<div ${anim("scale-in", 0.1, 0.6, `vs-stat-value`, `font-size:${px(fs)}`)}><span>${esc(value)}</span><span class="vs-stat-unit">${esc(unit)}</span></div>`,
      label && lfit ? `<div ${anim("fade-up", 0.45, 0.5, `vs-stat-label`, `font-size:${px(lfit.fs)}`)}>${esc(label)}</div>` : "",
      `</div>`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  const chartW = safe.w;
  const chartH = safe.h * (label ? 0.78 : 0.9);
  if (label) {
    const perLine = Math.max(1, Math.floor(safe.w / (titleFs * 0.56)));
    rec(ctx, ctx.main, hc(ctx, label), { w: safe.w, h: safe.h - chartH }, { fs: r2(titleFs), fits: Math.ceil(Array.from(label).length / perLine) * titleFs * 1.2 <= safe.h - chartH }, ctx.colors.text);
  }
  const fs = Math.max(8, u * 3);
  const max = Math.max(0, ...series.map((s) => s.value));
  const min = Math.min(0, ...series.map((s) => s.value));
  const span = max - min || 1;
  const st = stagger(series.length, stage.dur, 0.3);
  const colour = (i: number) => (i % 2 === 0 ? "var(--vs-primary)" : "var(--vs-secondary)");
  let svg: string;

  if (type === "bar") {
    const rowH = chartH / series.length;
    const barH = Math.min(rowH * 0.6, u * 10);
    const labelW = chartW * 0.34;
    const valueW = chartW * 0.2;
    const trackW = chartW - labelW - valueW;
    const zeroX = labelW + ((0 - min) / span) * trackW;
    const bars = series.map((s, i) => {
      const y = i * rowH + (rowH - barH) / 2;
      const w = (Math.abs(s.value) / span) * trackW;
      const x = s.value >= 0 ? zeroX : zeroX - w;
      const cy = y + barH / 2;
      return [
        `<text x="${r2(labelW - u * 2)}" y="${r2(cy)}" text-anchor="end" dominant-baseline="middle" ${anim("fade", st.at(i), st.len, `vs-axis`)}>${esc(s.label)}</text>`,
        `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(Math.max(1, w))}" height="${r2(barH)}" rx="${r2(Math.min(barH / 4, u))}" fill="${colour(i)}" ${anim(s.value >= 0 ? "grow-x" : "grow-x-rev", st.at(i), st.len)}/>`,
        `<text x="${r2(labelW + trackW + u * 2)}" y="${r2(cy)}" dominant-baseline="middle" ${anim("fade", st.at(i) + st.len * 0.6, st.len, `vs-value`)}>${esc(fmtNumber(s.value) + unit)}</text>`,
      ].join("");
    });
    svg = bars.join("\n");
  } else if (type === "line") {
    const padL = u * 2;
    const padB = fs * 2.2;
    const padT = fs * 2;
    const innerW = chartW - padL * 2;
    const innerH = chartH - padB - padT;
    const pts = series.map((s, i) => ({
      x: padL + (series.length === 1 ? innerW / 2 : (i / (series.length - 1)) * innerW),
      y: padT + (1 - (s.value - min) / span) * innerH,
      s,
    }));
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${r2(p.x)} ${r2(p.y)}`).join(" ");
    const lineLen = Math.max(0.6, Math.min(stage.dur * 0.5, 1.6));
    const baseline = `<line x1="${r2(padL)}" y1="${r2(padT + innerH)}" x2="${r2(padL + innerW)}" y2="${r2(padT + innerH)}" class="vs-gridline"/>`;
    const path = `<path d="${d}" pathLength="1" fill="none" stroke="var(--vs-primary)" stroke-width="${r2(u * 1.1)}" stroke-linecap="round" stroke-linejoin="round" ${anim("draw", 0.3, lineLen)}/>`;
    const dots = pts.map((p, i) => {
      const at = 0.3 + (series.length === 1 ? 0 : (i / (series.length - 1)) * lineLen);
      return [
        `<circle cx="${r2(p.x)}" cy="${r2(p.y)}" r="${r2(u * 1.6)}" fill="var(--vs-secondary)" ${anim("pop", at, 0.3)}/>`,
        `<text x="${r2(p.x)}" y="${r2(p.y - fs * 0.9)}" text-anchor="middle" ${anim("fade", at, 0.3, `vs-value`)}>${esc(fmtNumber(p.s.value) + unit)}</text>`,
        `<text x="${r2(p.x)}" y="${r2(padT + innerH + fs * 1.5)}" text-anchor="middle" ${anim("fade", 0.2, 0.4, `vs-axis`)}>${esc(p.s.label)}</text>`,
      ].join("");
    });
    svg = [baseline, path, ...dots].join("\n");
  } else {
    if (type !== "pie") warnings.push(`chart: unknown type "${type}"; drawn as pie`);
    const positive = series.filter((s) => s.value > 0);
    if (positive.length < series.length) warnings.push("chart: pie ignores zero and negative values");
    const total = positive.reduce((a, s) => a + s.value, 0) || 1;
    const legendH = positive.length * fs * 1.6;
    const size = Math.min(chartW, chartH - legendH - u * 4);
    const cx = chartW / 2;
    const cy = size / 2;
    const rad = size / 2 - u;
    let angle = -Math.PI / 2;
    const slices = positive.map((s, i) => {
      const sweep = (s.value / total) * Math.PI * 2;
      const a0 = angle;
      const a1 = angle + sweep;
      angle = a1;
      const fill = colour(i);
      const opacity = r2(1 - Math.floor(i / 2) * 0.22 > 0.3 ? 1 - Math.floor(i / 2) * 0.22 : 0.3);
      const shape =
        positive.length === 1
          ? `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(rad)}"`
          : `<path d="M${r2(cx)} ${r2(cy)} L${r2(cx + rad * Math.cos(a0))} ${r2(cy + rad * Math.sin(a0))} A${r2(rad)} ${r2(rad)} 0 ${sweep > Math.PI ? 1 : 0} 1 ${r2(cx + rad * Math.cos(a1))} ${r2(cy + rad * Math.sin(a1))} Z"`;
      const ly = size + u * 4 + i * fs * 1.6;
      return [
        `${shape} fill="${fill}" fill-opacity="${opacity}" stroke="var(--vs-bg)" stroke-width="${r2(u * 0.5)}" ${anim("pop-center", st.at(i), st.len)}/>`,
        `<rect x="${r2(chartW * 0.2)}" y="${r2(ly - fs * 0.5)}" width="${r2(fs)}" height="${r2(fs)}" fill="${fill}" fill-opacity="${opacity}" ${anim("fade", st.at(i), st.len)}/>`,
        `<text x="${r2(chartW * 0.2 + fs * 1.6)}" y="${r2(ly)}" dominant-baseline="middle" ${anim("fade", st.at(i), st.len, `vs-axis`)}>${esc(`${s.label} · ${fmtNumber(Math.round((s.value / total) * 1000) / 10)}%`)}</text>`,
      ].join("");
    });
    svg = slices.join("\n");
  }
  return [
    `<div class="vs-stack vs-chart">`,
    title,
    `<svg class="vs-chart-svg" width="${r2(chartW)}" height="${r2(chartH)}" viewBox="0 0 ${r2(chartW)} ${r2(chartH)}" style="font-size:${px(fs)}">`,
    svg,
    `</svg>`,
    `</div>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Point where the segment from the centre of `b` towards (tx,ty) leaves the box. */
function boxExit(b: Box, tx: number, ty: number): { x: number; y: number } {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx === 0 ? Infinity : b.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : b.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

/** Longest-path layering (cycle-safe: bounded relaxation). Exported for tests. */
export function layerNodes(n: number, edges: ReadonlyArray<readonly [number, number]>): number[] {
  const layer = new Array<number>(n).fill(0);
  for (let iter = 0; iter < n; iter++) {
    let changed = false;
    for (const [a, b] of edges) {
      if (a === b) continue;
      if (layer[b]! < layer[a]! + 1 && layer[a]! + 1 < n) {
        layer[b] = layer[a]! + 1;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const used = [...new Set(layer)].sort((x, y) => x - y);
  return layer.map((l) => used.indexOf(l));
}

function renderDiagram(ctx: KindCtx): string {
  const { stage, props, warnings } = ctx;
  const labels = Array.isArray(props.nodes) ? props.nodes.map(str).filter((s): s is string => Boolean(s)) : [];
  const index = new Map<string, number>();
  const nodes: string[] = [];
  for (const l of labels) {
    if (index.has(l)) {
      warnings.push(`diagram: duplicate node "${l}" drawn once`);
      continue;
    }
    index.set(l, nodes.length);
    nodes.push(l);
  }
  const edges: Array<[number, number]> = [];
  for (const e of Array.isArray(props.edges) ? props.edges : []) {
    const [a, b] = Array.isArray(e) ? e : [];
    const ia = typeof a === "string" ? index.get(a) : undefined;
    const ib = typeof b === "string" ? index.get(b) : undefined;
    if (ia === undefined || ib === undefined) {
      warnings.push(`diagram: edge ${JSON.stringify(e)} references an unknown node; skipped`);
      continue;
    }
    if (ia === ib) {
      warnings.push(`diagram: self-loop on "${nodes[ia]}" not drawn`);
      continue;
    }
    edges.push([ia, ib]);
  }
  if (nodes.length === 0) {
    warnings.push("diagram: no nodes");
    return `<div class="vs-stack"></div>`;
  }
  const layers = layerNodes(nodes.length, edges);
  const layerCount = Math.max(...layers) + 1;
  const byLayer: number[][] = Array.from({ length: layerCount }, () => []);
  layers.forEach((l, i) => byLayer[l]!.push(i));
  const { u, safe } = stage;
  const vertical = stage.portrait || stage.H >= stage.W;
  const along = vertical ? safe.h : safe.w;
  const across = vertical ? safe.w : safe.h;
  const cellAlong = along / layerCount;
  const boxes: Box[] = new Array(nodes.length);
  let fs = u * 5;
  for (let l = 0; l < layerCount; l++) {
    const members = byLayer[l]!;
    const cellAcross = across / members.length;
    members.forEach((nodeIdx, k) => {
      const bAlong = Math.min(cellAlong * 0.55, u * (vertical ? 14 : 30));
      const bAcross = Math.min(cellAcross * 0.86, u * (vertical ? 70 : 22));
      const cAlong = l * cellAlong + cellAlong / 2;
      const cAcross = k * cellAcross + cellAcross / 2;
      const w = vertical ? bAcross : bAlong;
      const h = vertical ? bAlong : bAcross;
      const cx = vertical ? cAcross : cAlong;
      const cy = vertical ? cAlong : cAcross;
      boxes[nodeIdx] = { x: cx - w / 2, y: cy - h / 2, w, h };
      fs = Math.min(fs, fitFont([nodes[nodeIdx]!], w - u * 2, h - u, u * 5, u * 1.8));
    });
  }
  const nodeBg = mixHex(ctx.colors.bg, ctx.colors.primary, 0.14);
  nodes.forEach((label, i) => {
    const b = boxes[i]!;
    const fit = fitFontInfo([label], b.w - u * 2, b.h - u, fs, fs);
    rec(ctx, "label", label, { x: b.x + u, y: b.y + u / 2, w: b.w - u * 2, h: b.h - u }, { fs, fits: fit.fits }, ctx.colors.text, nodeBg);
  });
  const layerTime = (l: number) => 0.15 + l * Math.min(0.45, Math.max(0.1, (stage.dur * 0.6 - 0.6) / Math.max(1, layerCount)));
  const nodeHtml = nodes
    .map((label, i) => {
      const b = boxes[i]!;
      return `<div class="vs-node" style="left:${px(b.x)};top:${px(b.y)};width:${px(b.w)};height:${px(b.h)};font-size:${px(fs)}"><div ${anim("scale-in", layerTime(layers[i]!), 0.45)}>${esc(label)}</div></div>`;
    })
    .join("\n");
  const stroke = Math.max(1.5, u * 0.45);
  const head = Math.max(6, u * 2);
  const edgeSvg = edges
    .map(([a, b]) => {
      const A = boxes[a]!;
      const B = boxes[b]!;
      const p0 = boxExit(A, B.x + B.w / 2, B.y + B.h / 2);
      const p1 = boxExit(B, A.x + A.w / 2, A.y + A.h / 2);
      const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
      const ux = (p1.x - p0.x) / len;
      const uy = (p1.y - p0.y) / len;
      const gap = u * 0.8;
      const sx = p0.x + ux * gap;
      const sy = p0.y + uy * gap;
      const ex = p1.x - ux * gap;
      const ey = p1.y - uy * gap;
      const bx = ex - ux * head;
      const by = ey - uy * head;
      const at = layerTime(Math.max(layers[a]!, layers[b]!)) + 0.1;
      return [
        `<path d="M${r2(sx)} ${r2(sy)} L${r2(bx)} ${r2(by)}" pathLength="1" stroke="var(--vs-text)" stroke-opacity="0.7" stroke-width="${r2(stroke)}" fill="none" ${anim("draw", at, 0.4)}/>`,
        `<polygon points="${r2(ex)},${r2(ey)} ${r2(bx - uy * head * 0.55)},${r2(by + ux * head * 0.55)} ${r2(bx + uy * head * 0.55)},${r2(by - ux * head * 0.55)}" fill="var(--vs-text)" fill-opacity="0.7" ${anim("fade", at + 0.3, 0.2)}/>`,
      ].join("");
    })
    .join("\n");
  return [
    `<svg class="vs-edges" width="${safe.w}" height="${safe.h}" viewBox="0 0 ${safe.w} ${safe.h}">`,
    edgeSvg,
    `</svg>`,
    nodeHtml,
  ].join("\n");
}

function side(v: unknown): { label: string; text: string } {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return { label: str(o.label) ?? "", text: str(o.text) ?? "" };
}

function renderComparison(ctx: KindCtx): string {
  const { stage, props } = ctx;
  const left = side(props.left);
  const right = side(props.right);
  const verdictRaw = str(props.verdict);
  const verdict = verdictRaw ? hc(ctx, verdictRaw) : undefined;
  const { u, safe } = stage;
  const columns = !stage.portrait && stage.W > stage.H;
  const cardW = columns ? (safe.w - u * 4) / 2 : safe.w;
  const cardH = (columns ? safe.h * 0.7 : (safe.h * (verdict ? 0.78 : 0.92) - u * 4) / 2) - u * 6;
  const labelFit = fitFontInfo([left.label, right.label], cardW - u * 6, cardH * 0.3, u * 6.5, u * 2.5);
  const textFit = fitFontInfo([left.text, right.text], cardW - u * 6, cardH * 0.62, u * 5, u * 2.2, 1.3);
  const labelFs = labelFit.fs;
  const textFs = textFit.fs;
  const cardAt = (i: number) => ({ x: columns ? i * (cardW + u * 4) + u * 3 : u * 3, y: columns ? u * 3 : i * (cardH + u * 10) + u * 3 });
  [left, right].forEach((sd, i) => {
    const at = cardAt(i);
    const accent = i === 0 ? ctx.colors.primary : ctx.colors.secondary;
    rec(ctx, "label", sd.label, { ...at, w: cardW - u * 6, h: cardH * 0.3 }, labelFit, accent, ctx.colors.panel);
    rec(ctx, "body", sd.text, { x: at.x, y: at.y + cardH * 0.34, w: cardW - u * 6, h: cardH * 0.62 }, textFit, ctx.colors.text, ctx.colors.panel);
  });
  const verdictFit = verdict ? headFit(ctx, [verdict], safe.w - u * 6, safe.h * 0.14, u * 5.5, u * 2.4) : undefined;
  if (verdict && verdictFit) {
    rec(ctx, "headline", verdict, { x: u * 3, y: safe.h * 0.84, w: safe.w - u * 6, h: safe.h * 0.14 }, verdictFit, ctx.colors.text, mixHex(ctx.colors.bg, ctx.colors.primary, 0.18));
  }
  const card = (s: { label: string; text: string }, cls: string, effect: string, at: number) =>
    `<div ${anim(effect, at, 0.5, `vs-card ${cls}`)}><div class="vs-card-label" style="font-size:${px(labelFs)}">${esc(s.label)}</div><div class="vs-card-text" style="font-size:${px(textFs)}">${esc(s.text)}</div></div>`;
  return [
    `<div class="vs-stack vs-comparison">`,
    `<div class="vs-compare ${columns ? "vs-columns" : "vs-rows"}">`,
    card(left, "vs-left", columns ? "slide-right" : "fade-up", 0.15),
    card(right, "vs-right", columns ? "slide-left" : "fade-up", 0.4),
    `</div>`,
    verdict && verdictFit
      ? `<div ${anim("fade-up", Math.min(0.9, stage.dur * 0.45), 0.5, `vs-verdict`, `font-size:${px(verdictFit.fs)}`)}>${esc(verdict)}</div>`
      : "",
    `</div>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function logoHtml(ctx: KindCtx, at: number): string {
  return ctx.logo ? `<img src="${esc(ctx.logo)}" alt="" ${anim("fade", at, 0.5, `vs-logo`)}>` : "";
}

function renderCta(ctx: KindCtx): string {
  const { stage, props } = ctx;
  const headline = hc(ctx, str(props.headline) ?? "");
  const action = str(props.action) ?? "";
  const command = str(props.command);
  const url = str(props.url);
  const { u, safe } = stage;
  const st = stagger(2 + (command ? 1 : 0) + (url ? 1 : 0), stage.dur);
  let i = 0;
  const hf = headFit(ctx, [headline], safe.w, safe.h * 0.35, u * 10, u * 3.5, 1.1);
  const af = fitFontInfo([action], safe.w * 0.8, safe.h * 0.12, u * 6, u * 2.5);
  const cf = command ? fitFontInfo([command], safe.w - u * 8, safe.h * 0.12, u * 4.5, u * 1.8, 1.2, 0.62) : undefined;
  const uf = url ? fitFontInfo([url], safe.w, safe.h * 0.08, u * 4, u * 2) : undefined;
  // Boxes follow the vertical stack order (headline, action, command, url), centred in the safe area.
  let y = safe.h * 0.1;
  rec(ctx, ctx.main === "hook" ? "hook" : "cta", headline, { y, w: safe.w, h: safe.h * 0.35 }, hf, ctx.colors.text);
  y += safe.h * 0.37;
  rec(ctx, "cta", action, { x: safe.w * 0.1, y, w: safe.w * 0.8, h: safe.h * 0.12 }, af, ctx.colors.bg, ctx.colors.primary);
  y += safe.h * 0.14;
  if (command && cf) {
    rec(ctx, "code", `$ ${command}`, { x: u * 4, y, w: safe.w - u * 8, h: safe.h * 0.12 }, cf, ctx.colors.text, ctx.colors.panel);
    y += safe.h * 0.14;
  }
  if (url && uf) rec(ctx, "label", url, { y, w: safe.w, h: safe.h * 0.08 }, uf, ctx.colors.secondary);
  return [
    `<div class="vs-stack vs-cta">`,
    logoHtml(ctx, 0),
    `<div ${anim("fade-up", st.at(i++), st.len, `vs-headline`, `font-size:${px(hf.fs)}`)}>${esc(headline)}</div>`,
    `<div class="vs-action-wrap"><div ${anim("pop", st.at(i++), st.len, `vs-action`, `font-size:${px(af.fs)}`)}>${esc(action)}</div></div>`,
    command && cf
      ? `<div ${anim("fade-up", st.at(i++), st.len, `vs-command`, `font-size:${px(cf.fs)}`)}><span class="vs-prompt">$</span> ${esc(command)}</div>`
      : "",
    url && uf ? `<div ${anim("fade", st.at(i++), st.len, `vs-url`, `font-size:${px(uf.fs)}`)}>${esc(url)}</div>` : "",
    `</div>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderEndCard(ctx: KindCtx): string {
  const { stage, props, warnings } = ctx;
  const titleRaw = str(props.title);
  const title = titleRaw ? hc(ctx, titleRaw) : undefined;
  const subtitle = str(props.subtitle);
  const { u, safe } = stage;
  if (!title && !subtitle && !ctx.logo) warnings.push("end_card: no title, subtitle or logo; card is empty");
  const tf = title ? headFit(ctx, [title], safe.w, safe.h * 0.3, u * 11, u * 4, 1.1) : undefined;
  const sf = subtitle ? fitFontInfo([subtitle], safe.w, safe.h * 0.15, u * 5, u * 2.2) : undefined;
  if (title && tf) rec(ctx, ctx.main, title, { y: safe.h * 0.25, w: safe.w, h: safe.h * 0.3 }, tf, ctx.colors.text);
  if (subtitle && sf) rec(ctx, "body", subtitle, { y: safe.h * 0.58, w: safe.w, h: safe.h * 0.15 }, sf, ctx.colors.text);
  return [
    `<div class="vs-stack vs-end">`,
    logoHtml(ctx, 0.05),
    title && tf ? `<div ${anim("scale-in", 0.15, 0.6, `vs-headline`, `font-size:${px(tf.fs)}`)}>${esc(title)}</div>` : "",
    subtitle && sf ? `<div ${anim("fade-up", 0.45, 0.5, `vs-subtitle`, `font-size:${px(sf.fs)}`)}>${esc(subtitle)}</div>` : "",
    `<div ${anim("grow-x-center", 0.6, 0.5, `vs-rule`)}></div>`,
    `</div>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function pct(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const p = v <= 1 ? v * 100 : v;
  return Math.min(100, Math.max(0, Math.round(p * 100) / 100));
}

function renderScreenshot(ctx: KindCtx): string {
  const { stage, props, warnings } = ctx;
  const { u, safe } = stage;
  const id = str(props.asset) ?? "";
  const abs = id ? ctx.resolveAsset(id) : undefined;
  let img: string;
  if (abs) {
    const src = ctx.asset(abs, "screenshot");
    img = `<img src="${esc(src)}" alt="" ${anim("zoom", 0, stage.dur, `vs-shot-img`)}>`;
  } else {
    warnings.push(`screenshot: asset "${id}" could not be resolved to an image in the project; drawing a placeholder`);
    img = `<div class="vs-shot-missing">${esc(id || "missing asset")}</div>`;
    rec(ctx, "decorative", id || "missing asset", { w: safe.w, h: safe.h * 0.6 }, { fs: r2(Math.max(9, u * 3.4)), fits: true }, ctx.colors.text, ctx.colors.panel);
  }
  const callouts = Array.isArray(props.callouts) ? props.callouts : [];
  const positioned: string[] = [];
  const listed: string[] = [];
  const st = stagger(callouts.length, stage.dur, 0.5);
  const fs = Math.max(9, u * 3.4);
  callouts.forEach((c, i) => {
    const text = typeof c === "string" ? c : c && typeof c === "object" ? str((c as Record<string, unknown>).text) : undefined;
    if (!text) return;
    const o = c && typeof c === "object" ? (c as Record<string, unknown>) : {};
    const x = pct(o.x);
    const y = pct(o.y);
    if (x !== undefined && y !== undefined) {
      rec(ctx, "label", text, { x: (x / 100) * safe.w, y: (y / 100) * safe.h - fs, w: Math.min(safe.w, Array.from(text).length * fs * 0.56 + fs * 2.6), h: fs * 2 }, { fs: r2(fs), fits: true }, ctx.colors.bg, ctx.colors.primary);
      positioned.push(
        `<div class="vs-pin" style="left:${x}%;top:${y}%"><div ${anim("pop", st.at(i), st.len)}><span class="vs-pin-dot"></span><span class="vs-callout">${esc(text)}</span></div></div>`,
      );
    } else {
      listed.push(`<div ${anim("fade-up", st.at(i), st.len, `vs-callout`)}>${esc(text)}</div>`);
      rec(ctx, "label", text, { y: safe.h - Math.min(safe.h * 0.35, callouts.length * fs * 2.6) + listed.length * fs * 1.6, w: safe.w, h: fs * 1.4 }, { fs: r2(fs), fits: true }, ctx.colors.bg, ctx.colors.primary);
    }
  });
  const listH = listed.length ? Math.min(safe.h * 0.35, listed.length * fs * 2.6) : 0;
  const frameH = safe.h - listH - (listed.length ? u * 3 : 0);
  return [
    `<div ${anim("scale-in", 0, 0.5, "vs-shot", `height:${px(frameH)};font-size:${px(fs)}`)}>`,
    img,
    ...positioned,
    `</div>`,
    listed.length ? `<div class="vs-callouts" style="font-size:${px(fs)}">\n${listed.join("\n")}\n</div>` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Text colour at `t` of the way from the background to the text colour (`color-mix` twin). */
function mutedHex(ctx: KindCtx, t = 0.72): string {
  return mixHex(ctx.colors.bg, ctx.colors.text, t);
}

/** A fitted text block: font fit plus the height it takes (its box when it does not fit). */
function textBlock(text: string, w: number, maxH: number, maxFs: number, minFs: number, lineHeight = 1.2, em = 0.56): { fit: FontFit; h: number } {
  const fit = fitFontInfo([text], w, maxH, maxFs, minFs, lineHeight, em);
  const lines = wrapText(text, fit.fs, w).length;
  return { fit, h: fit.fits ? Math.min(maxH, lines * fit.fs * lineHeight) : maxH };
}

/** One font size for several separately boxed texts (the smallest that fits each), and which fit. */
function sharedFit(texts: readonly string[], boxW: number, boxH: number, maxFs: number, minFs: number, lineHeight = 1.2): { fs: number; fits: boolean[] } {
  const fs = Math.min(maxFs, ...texts.filter((t) => t.trim()).map((t) => fitFont([t], boxW, boxH, maxFs, minFs, lineHeight)));
  return { fs, fits: texts.map((t) => fitFontInfo([t], boxW, boxH, fs, fs, lineHeight).fits) };
}

/** Top offsets of blocks stacked with `gap` and centred in `H` (what `.vs-stack` does). */
function column(heights: readonly number[], gap: number, H: number): number[] {
  const total = heights.reduce((a, h) => a + h, 0) + gap * Math.max(0, heights.length - 1);
  let y = Math.max(0, (H - total) / 2);
  return heights.map((h) => {
    const at = y;
    y += h + gap;
    return at;
  });
}

function renderQuote(ctx: KindCtx): string {
  const { stage, props, warnings } = ctx;
  const text = str(props.text) ?? "";
  if (!text) warnings.push("quote: no `text` to show");
  const attribution = str(props.attribution);
  const source = str(props.source);
  const { u, safe } = stage;
  const gap = u * 2.5;
  const markFs = u * (stage.portrait ? 24 : 18);
  const markH = markFs * 0.5;
  const attr = attribution ? textBlock(`— ${attribution}`, safe.w, safe.h * 0.12, u * 4.8, u * 2.4) : undefined;
  const src = source ? textBlock(source, safe.w, safe.h * 0.1, u * 3.8, u * 2.2) : undefined;
  const tailH = (attr ? attr.h + gap : 0) + (src ? src.h + gap : 0);
  // A quotation keeps its wording and case; only the heading scale applies.
  const body = headBlock(ctx, text, safe.w, safe.h - markH - gap - tailH, u * 8.5, u * 3.2, 1.25, 0.56, false);
  const heights = [markH, body.h, ...(attr ? [attr.h] : []), ...(src ? [src.h] : [])];
  const ys = column(heights, gap, safe.h);
  rec(ctx, "decorative", "“", { y: ys[0], w: markFs * 0.6, h: markH }, { fs: r2(markFs), fits: true }, ctx.colors.primary);
  rec(ctx, ctx.main, text, { y: ys[1], w: safe.w, h: body.h }, body.fit, ctx.colors.text);
  let k = 2;
  if (attribution && attr) rec(ctx, "label", `— ${attribution}`, { y: ys[k++], w: safe.w, h: attr.h }, attr.fit, ctx.colors.primary);
  if (source && src) rec(ctx, "label", source, { y: ys[k++], w: safe.w, h: src.h }, src.fit, mutedHex(ctx));
  const st = stagger(heights.length, stage.dur);
  let i = 0;
  return [
    `<div class="vs-stack vs-quote" style="gap:${px(gap)}">`,
    `<div ${anim("pop", st.at(i++), st.len, `vs-quote-mark`, `height:${px(markH)};font-size:${px(markFs)}`)}>“</div>`,
    `<div ${anim("fade-up", st.at(i++), st.len, `vs-quote-text`, `min-height:${px(body.h)};font-size:${px(body.fit.fs)}`)}>${esc(text)}</div>`,
    attribution && attr
      ? `<div ${anim("fade-up", st.at(i++), st.len, `vs-quote-attr`, `min-height:${px(attr.h)};font-size:${px(attr.fit.fs)}`)}>— ${esc(attribution)}</div>`
      : "",
    source && src ? `<div ${anim("fade", st.at(i++), st.len, `vs-quote-source vs-muted`, `min-height:${px(src.h)};font-size:${px(src.fit.fs)}`)}>${esc(source)}</div>` : "",
    `</div>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Count-up frames for a numeric value: each shows only inside its own time window. */
function countUp(value: number, at: number, span: number, frames = 8): { frames: string; done: number } {
  const decimals = Number.isInteger(value) ? 0 : Math.min(2, (String(value).split(".")[1] ?? "").length);
  const scale = 10 ** decimals;
  const dt = span / frames;
  const out: string[] = [];
  for (let k = 0; k < frames; k++) {
    const f = 1 - (1 - k / frames) ** 3;
    const v = Math.round(value * f * scale) / scale;
    out.push(`<span ${anim("flash", at + k * dt, dt, "vs-count-frame")}>${esc(fmtNumber(v))}</span>`);
  }
  return { frames: out.join(""), done: at + span };
}

function renderStat(ctx: KindCtx): string {
  const { stage, props } = ctx;
  const raw = props.value;
  const numeric = typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
  const value = numeric !== undefined ? fmtNumber(numeric) : (str(raw) ?? "");
  const unit = str(props.unit) ?? "";
  const label = str(props.label) ?? "";
  const context = str(props.context);
  const { u, safe } = stage;
  const gap = u * 3;
  const vfit = headFit(ctx, [value + unit], safe.w, safe.h * 0.45, u * 30, u * 6, 1, 0.6, false);
  const valueH = vfit.fits ? Math.min(safe.h * 0.45, wrapText(value + unit, vfit.fs, safe.w, { mono: true }).length * vfit.fs) : safe.h * 0.45;
  const lab = label ? textBlock(label, safe.w, safe.h * 0.22, u * 7, u * 3, 1.15) : undefined;
  const con = context ? textBlock(context, safe.w, safe.h * 0.12, u * 4.5, u * 2.2) : undefined;
  const heights = [valueH, ...(lab ? [lab.h] : []), ...(con ? [con.h] : [])];
  const ys = column(heights, gap, safe.h);
  rec(ctx, ctx.main, value + unit, { y: ys[0], w: safe.w, h: valueH }, vfit, ctx.colors.primary);
  if (label && lab) rec(ctx, "body", label, { y: ys[1], w: safe.w, h: lab.h }, lab.fit, ctx.colors.text);
  if (context && con) rec(ctx, "label", context, { y: ys[lab ? 2 : 1], w: safe.w, h: con.h }, con.fit, mutedHex(ctx));
  // Numbers count up to their value (discrete frames, a pure function of time); text values pop in.
  const count = numeric !== undefined && numeric !== 0 ? countUp(numeric, 0.1, Math.max(0.4, Math.min(1.2, stage.dur * 0.35))) : undefined;
  const digits = count
    ? `<span class="vs-count"><span ${anim("fade", count.done, 0.001)}>${esc(value)}</span>${count.frames}</span>`
    : `<span>${esc(value)}</span>`;
  const labelAt = count ? Math.min(count.done, stage.dur * 0.5) : 0.45;
  return [
    `<div class="vs-stack vs-stat" style="gap:${px(gap)}">`,
    `<div ${anim("scale-in", 0.05, 0.5, `vs-stat-value`, `min-height:${px(valueH)};font-size:${px(vfit.fs)}`)}>${digits}${unit ? `<span class="vs-stat-unit">${esc(unit)}</span>` : ""}</div>`,
    label && lab ? `<div ${anim("fade-up", labelAt, 0.5, `vs-stat-label`, `min-height:${px(lab.h)};font-size:${px(lab.fit.fs)}`)}>${esc(label)}</div>` : "",
    context && con ? `<div ${anim("fade", labelAt + 0.25, 0.5, `vs-stat-context vs-muted`, `min-height:${px(con.h)};font-size:${px(con.fit.fs)}`)}>${esc(context)}</div>` : "",
    `</div>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderTimeline(ctx: KindCtx): string {
  const { stage, props, warnings } = ctx;
  let events = (Array.isArray(props.events) ? props.events : [])
    .map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>) : {}))
    .map((e) => ({ label: str(e.label) ?? "", text: str(e.text) ?? "" }))
    .filter((e) => e.label || e.text);
  if (events.length > 6) {
    warnings.push(`timeline: ${events.length} events do not fit; showing the first 6`);
    events = events.slice(0, 6);
  }
  if (events.length === 0) {
    warnings.push("timeline: no events");
    return `<div class="vs-stack"></div>`;
  }
  const n = events.length;
  let current = typeof props.current === "number" && Number.isInteger(props.current) ? props.current : undefined;
  if (current !== undefined && (current < 0 || current >= n)) {
    warnings.push(`timeline: current ${current} is outside the ${n} events; nothing highlighted`);
    current = undefined;
  }
  const { u, safe } = stage;
  const vertical = stage.portrait || stage.H >= stage.W;
  const hasText = events.some((e) => e.text);
  const dotR = u * 1.8;
  const curR = u * 2.8;
  const line = Math.max(2, u * 0.6);
  // Event i: dot centre and the text block beside (vertical) or under (horizontal) it.
  let dots: Array<{ x: number; y: number }>;
  let blocks: Box[];
  let labelH: number;
  let textH: number;
  let lineRect: Box;
  if (vertical) {
    const rowH = safe.h / n;
    const lineX = curR + u;
    const textX = lineX + curR + u * 4;
    const w = safe.w - textX;
    labelH = Math.min(rowH * (hasText ? 0.45 : 0.85), u * 16);
    textH = hasText ? Math.min(rowH * 0.5, u * 20) : 0;
    dots = events.map((_, i) => ({ x: lineX, y: rowH * (i + 0.5) }));
    blocks = dots.map((d) => ({ x: textX, y: d.y - (labelH + textH) / 2, w, h: labelH + textH }));
    lineRect = { x: lineX - line / 2, y: dots[0]!.y, w: line, h: dots[n - 1]!.y - dots[0]!.y };
  } else {
    const colW = safe.w / n;
    const lineY = safe.h * (hasText ? 0.3 : 0.4);
    const w = colW - u * 3;
    labelH = safe.h * 0.18;
    textH = hasText ? safe.h * 0.4 : 0;
    dots = events.map((_, i) => ({ x: colW * (i + 0.5), y: lineY }));
    blocks = dots.map((d) => ({ x: d.x - w / 2, y: lineY + curR + u * 4, w, h: labelH + textH }));
    lineRect = { x: dots[0]!.x, y: lineY - line / 2, w: dots[n - 1]!.x - dots[0]!.x, h: line };
  }
  const lf = sharedFit(events.map((e) => e.label), blocks[0]!.w, labelH, u * (vertical ? 6 : 5), u * 2.6, 1.15);
  const tf = sharedFit(events.map((e) => e.text), blocks[0]!.w, Math.max(1, textH), u * 4.2, u * 2.2, 1.3);
  const st = stagger(n, stage.dur, 0.3);
  const lineDur = Math.max(0.3, st.at(n - 1) - 0.1 + st.len * 0.5);
  const muted = mutedHex(ctx, 0.6);
  const html: string[] = [
    `<div ${anim(vertical ? "grow-y" : "grow-x", 0.1, lineDur, `vs-tl-line`, `left:${px(lineRect.x)};top:${px(lineRect.y)};width:${px(lineRect.w)};height:${px(lineRect.h)}`)}></div>`,
  ];
  events.forEach((e, i) => {
    const state = current === undefined || i < current ? "vs-tl-past" : i === current ? "vs-tl-current" : "vs-tl-future";
    const r = i === current ? curR : dotR;
    const d = dots[i]!;
    const b = blocks[i]!;
    const labelColour = i === current ? ctx.colors.primary : state === "vs-tl-future" ? muted : ctx.colors.text;
    rec(ctx, "label", e.label, { x: b.x, y: b.y, w: b.w, h: labelH }, { fs: lf.fs, fits: lf.fits[i]! }, labelColour);
    if (hasText) rec(ctx, "body", e.text, { x: b.x, y: b.y + labelH, w: b.w, h: textH }, { fs: tf.fs, fits: tf.fits[i]! }, state === "vs-tl-future" ? muted : ctx.colors.text);
    html.push(
      `<div class="vs-tl-pos" style="left:${px(d.x - r)};top:${px(d.y - r)};width:${px(r * 2)};height:${px(r * 2)}"><div ${anim("pop", st.at(i), st.len, `vs-tl-dot ${state}`)}></div></div>`,
      `<div class="vs-tl-event ${state}${vertical ? "" : " vs-tl-under"}" style="left:${px(b.x)};top:${px(b.y)};width:${px(b.w)};height:${px(b.h)}"><div ${anim(vertical ? "slide-left" : "fade-up", st.at(i), st.len)}>` +
        `<div class="vs-tl-label" style="font-size:${px(lf.fs)}">${esc(e.label)}</div>` +
        (e.text ? `<div class="vs-tl-text" style="font-size:${px(tf.fs)}">${esc(e.text)}</div>` : "") +
        `</div></div>`,
    );
  });
  return html.join("\n");
}

function renderSplitScreen(ctx: KindCtx): string {
  const { stage, props, warnings } = ctx;
  const mode = str(props.mode) ?? "side_by_side";
  if (mode !== "side_by_side" && mode !== "before_after") warnings.push(`split_screen: unknown mode "${mode}"; drawn side by side`);
  const beforeAfter = mode === "before_after";
  const panel = (v: unknown, fallbackLabel: string) => {
    const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    return { label: str(o.label) ?? (beforeAfter ? fallbackLabel : ""), text: str(o.text) ?? "", asset: str(o.asset) };
  };
  const panels = [panel(props.left, "Before"), panel(props.right, "After")];
  const { u, safe } = stage;
  const columns = !stage.portrait && stage.W > stage.H;
  const gap = u * (beforeAfter ? 8 : 4);
  const pw = columns ? (safe.w - gap) / 2 : safe.w;
  const ph = columns ? safe.h * 0.86 : (safe.h - gap) / 2;
  const rects: Box[] = [0, 1].map((i) => (columns ? { x: i * (pw + gap), y: (safe.h - ph) / 2, w: pw, h: ph } : { x: 0, y: i * (ph + gap), w: pw, h: ph }));
  const pad = u * 3;
  const innerW = pw - pad * 2;
  const hasLabel = panels.some((p) => p.label);
  const labelH = hasLabel ? Math.min(ph * 0.16, u * 9) : 0;
  const hasMedia = panels.map((p) => Boolean(p.asset));
  const textH = (i: number) => (hasMedia[i] ? (panels[i]!.text ? ph * 0.2 : 0) : ph - pad * 2 - labelH - u * 2);
  const lf = sharedFit(panels.map((p) => p.label), innerW, labelH || 1, u * 5.5, u * 2.4, 1.15);
  const withMedia = panels.filter((_, i) => hasMedia[i]).map((p) => p.text);
  const bare = panels.filter((_, i) => !hasMedia[i]).map((p) => p.text);
  const tfMedia = withMedia.length ? sharedFit(withMedia, innerW, ph * 0.2, u * 4.2, u * 2.2, 1.3) : undefined;
  const tfBare = bare.length ? sharedFit(bare, innerW, textH(hasMedia.indexOf(false)), u * 6, u * 2.4, 1.3) : undefined;
  const accents = beforeAfter ? [mutedHex(ctx), ctx.colors.primary] : [ctx.colors.primary, ctx.colors.secondary];
  const cards = panels.map((p, i) => {
    const r = rects[i]!;
    const tf = hasMedia[i] ? tfMedia! : tfBare!;
    const fs = tf.fs;
    const fits = fitFontInfo([p.text], innerW, Math.max(1, textH(i)), fs, fs, 1.3).fits;
    rec(ctx, "label", p.label, { x: r.x + pad, y: r.y + pad, w: innerW, h: labelH }, { fs: lf.fs, fits: lf.fits[i]! }, accents[i]!, ctx.colors.panel);
    const ty = hasMedia[i] ? r.y + ph - pad - textH(i) : r.y + pad + labelH + u * 2;
    rec(ctx, "body", p.text, { x: r.x + pad, y: ty, w: innerW, h: textH(i) }, { fs, fits }, ctx.colors.text, ctx.colors.panel);
    let media = "";
    if (p.asset) {
      const abs = ctx.resolveAsset(p.asset);
      if (abs) media = `<div class="vs-split-media"><img src="${esc(ctx.asset(abs, `split-${i === 0 ? "left" : "right"}`))}" alt="" ${anim("zoom", 0, stage.dur, `vs-split-img`)}></div>`;
      else {
        warnings.push(`split_screen: ${i === 0 ? "left" : "right"} asset "${p.asset}" could not be resolved to an image in the project; drawing a placeholder`);
        media = `<div class="vs-split-media"><div class="vs-shot-missing">${esc(p.asset)}</div></div>`;
        rec(ctx, "decorative", p.asset, { x: r.x + pad, y: r.y + pad + labelH, w: innerW, h: ph - pad * 2 - labelH - textH(i) }, { fs: r2(Math.max(9, u * 3)), fits: true }, ctx.colors.text, ctx.colors.panel);
      }
    }
    const side = i === 0 ? "vs-left" : "vs-right";
    const effect = columns ? (i === 0 ? "slide-right" : "slide-left") : "fade-up";
    return (
      `<div class="vs-split-pos" style="left:${px(r.x)};top:${px(r.y)};width:${px(r.w)};height:${px(r.h)}"><div ${anim(effect, 0.15 + i * 0.3, 0.5, `vs-split ${side}${beforeAfter ? (i === 0 ? " vs-before" : " vs-after") : ""}`)}>` +
      (p.label ? `<div class="vs-split-label" style="height:${px(labelH)};font-size:${px(lf.fs)}">${esc(p.label)}</div>` : "") +
      media +
      (p.text ? `<div class="vs-split-text${hasMedia[i] ? "" : " vs-split-only"}" style="font-size:${px(fs)}">${esc(p.text)}</div>` : "") +
      `</div></div>`
    );
  });
  // Before → after: an arrow badge on the seam, pointing from the first panel to the second.
  let arrow = "";
  if (beforeAfter) {
    const s = gap * 0.9;
    const cx = columns ? pw + gap / 2 : safe.w / 2;
    const cy = columns ? safe.h / 2 : ph + gap / 2;
    const rot = columns ? 0 : 90;
    arrow = `<svg class="vs-split-arrow" width="${r2(s)}" height="${r2(s)}" viewBox="0 0 24 24" style="left:${px(cx - s / 2)};top:${px(cy - s / 2)}"><g ${anim("pop", 0.6, 0.4)}><circle cx="12" cy="12" r="12" fill="var(--vs-primary)"/><path d="M7 12h9M12.5 7.5L17 12l-4.5 4.5" transform="rotate(${rot} 12 12)" fill="none" stroke="var(--vs-bg)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
  }
  return [...cards, arrow].filter(Boolean).join("\n");
}

function renderLowerThird(ctx: KindCtx): string {
  const { stage, props } = ctx;
  const name = str(props.name) ?? "";
  const title = str(props.title);
  const headlineRaw = str(props.headline);
  const headline = headlineRaw ? hc(ctx, headlineRaw) : undefined;
  const { u, safe } = stage;
  const barW = stage.portrait ? safe.w : Math.min(safe.w, Math.max(safe.w * 0.55, u * 90));
  const stripe = u * 1.4;
  const pad = u * 3;
  const innerW = barW - stripe - pad * 2;
  const nb = textBlock(name, innerW, u * 16, u * 6.5, u * 3, 1.15);
  const tb = title ? textBlock(title, innerW, u * 10, u * 4.2, u * 2.2) : undefined;
  const barH = pad * 2 + nb.h + (tb ? u + tb.h : 0);
  const barY = safe.h - barH - u * 2;
  const textX = stripe + pad;
  rec(ctx, "label", name, { x: textX, y: barY + pad, w: innerW, h: nb.h }, nb.fit, ctx.colors.text, ctx.colors.panel);
  if (title && tb) rec(ctx, "label", title, { x: textX, y: barY + pad + nb.h + u, w: innerW, h: tb.h }, tb.fit, mixHex(ctx.colors.panel, ctx.colors.text, 0.75), ctx.colors.panel);
  let head = "";
  if (headline) {
    const room = barY - u * 6;
    const hb = headBlock(ctx, headline, safe.w, room, u * 10, u * 3.5, 1.1);
    const hy = Math.max(0, (room - hb.h) / 2);
    rec(ctx, ctx.main, headline, { y: hy, w: safe.w, h: hb.h }, hb.fit, ctx.colors.text);
    head = `<div class="vs-lt-headline" style="left:0;top:${px(hy)};width:${px(safe.w)};height:${px(hb.h)}"><div ${anim("fade-up", 0.1, 0.6, `vs-headline`, `font-size:${px(hb.fit.fs)}`)}>${esc(headline)}</div></div>`;
  }
  const at = headline ? Math.min(0.6, stage.dur * 0.25) : 0.1;
  return [
    head,
    `<div class="vs-lt-pos" style="left:0;top:${px(barY)};width:${px(barW)};height:${px(barH)}"><div ${anim("slide-right", at, 0.5, `vs-lt`)}>`,
    `<div ${anim("grow-y", at + 0.1, 0.4, `vs-lt-stripe`, `width:${px(stripe)}`)}></div>`,
    `<div class="vs-lt-text" style="padding:${px(pad)}">`,
    `<div ${anim("fade", at + 0.2, 0.4, `vs-lt-name`, `font-size:${px(nb.fit.fs)}`)}>${esc(name)}</div>`,
    title && tb ? `<div ${anim("fade", at + 0.35, 0.4, `vs-lt-title`, `margin-top:${px(u)};font-size:${px(tb.fit.fs)}`)}>${esc(title)}</div>` : "",
    `</div>`,
    `</div></div>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Chunks of `text` with their [start, end) offsets: words, or phrases split after punctuation. */
export function kineticChunks(text: string, rhythm: "word" | "phrase"): Array<{ text: string; start: number; end: number }> {
  const re = rhythm === "phrase" ? /[^.,;:!?…—–]+[.,;:!?…—–]*|[.,;:!?…—–]+/g : /\S+/g;
  const out: Array<{ text: string; start: number; end: number }> = [];
  for (const m of text.matchAll(re)) {
    const lead = m[0].length - m[0].trimStart().length;
    const t = m[0].trim();
    if (!t) continue;
    const start = m.index + lead;
    out.push({ text: t, start, end: start + t.length });
  }
  return out;
}

function renderKineticText(ctx: KindCtx): string {
  const { stage, props, warnings } = ctx;
  const text = hc(ctx, (str(props.text) ?? "").replace(/\s+/g, " ").trim());
  const rhythmRaw = str(props.rhythm) ?? "word";
  if (rhythmRaw !== "word" && rhythmRaw !== "phrase") warnings.push(`kinetic_text: unknown rhythm "${rhythmRaw}"; revealed word by word`);
  const rhythm = rhythmRaw === "phrase" ? "phrase" : "word";
  const emphasis = str(props.emphasis);
  const { u, safe } = stage;
  const chunks = kineticChunks(text, rhythm);
  if (chunks.length === 0) warnings.push("kinetic_text: no `text` to show");
  let es = -1;
  if (emphasis) {
    es = text.toLowerCase().indexOf(emphasis.toLowerCase());
    if (es < 0) warnings.push(`kinetic_text: emphasis "${emphasis}" does not occur in the text`);
  }
  const ee = es >= 0 && emphasis ? es + emphasis.length : -1;
  const block = headBlock(ctx, text, safe.w, safe.h * 0.85, u * 12, u * 3.5, 1.15, 0.58);
  rec(ctx, ctx.main, text, { y: (safe.h - block.h) / 2, w: safe.w, h: block.h }, block.fit, ctx.colors.text);
  // The reveal spreads over ~65% of the scene, so the full text holds for the rest.
  const first = 0.15;
  const step = chunks.length > 1 ? Math.max(0.3, stage.dur * 0.65 - first) / chunks.length : 0;
  const len = Math.min(0.45, Math.max(0.15, step * 1.6 || 0.45));
  const spans = chunks.map((c, i) => {
    let html = esc(c.text);
    const a = Math.max(c.start, es);
    const b = Math.min(c.end, ee);
    if (es >= 0 && a < b) {
      html = esc(text.slice(c.start, a)) + `<span class="vs-em">${esc(text.slice(a, b))}</span>` + esc(text.slice(b, c.end));
    }
    return `<span ${anim("kin", first + i * step, len, `vs-kin-chunk`)}>${html}</span>`;
  });
  return `<div class="vs-stack vs-kinetic" data-rhythm="${rhythm}" style="font-size:${px(block.fit.fs)}">\n<div class="vs-kin-line">${spans.join(" ")}</div>\n</div>`;
}

function renderMap(ctx: KindCtx): string {
  const { stage, props, warnings } = ctx;
  const titleRaw = str(props.title);
  const title = titleRaw ? hc(ctx, titleRaw) : undefined;
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  let points = (Array.isArray(props.points) ? props.points : [])
    .map((p) => (p && typeof p === "object" ? (p as Record<string, unknown>) : {}))
    .filter((p) => {
      const ok = typeof p.x === "number" && Number.isFinite(p.x) && typeof p.y === "number" && Number.isFinite(p.y);
      if (!ok) warnings.push(`map: point ${JSON.stringify(str(p.label) ?? "")} has no numeric x/y; skipped`);
      return ok;
    })
    .map((p) => ({ label: str(p.label) ?? "", x: clamp01(p.x as number), y: clamp01(p.y as number) }));
  if (points.length > 8) {
    warnings.push(`map: ${points.length} points do not fit; showing the first 8`);
    points = points.slice(0, 8);
  }
  if (points.length === 0) warnings.push("map: no points");
  const route = props.route === true && points.length >= 2;
  if (props.route === true && points.length < 2) warnings.push("map: route needs at least 2 points");
  const { u, safe } = stage;
  const gap = u * 3;
  const tb = title ? headBlock(ctx, title, safe.w, safe.h * 0.16, u * 7, u * 3.2, 1.1) : undefined;
  const titleH = tb ? tb.h + gap : 0;
  if (title && tb) rec(ctx, ctx.main, title, { w: safe.w, h: tb.h }, tb.fit, ctx.colors.text);
  const panel: Box = { x: 0, y: titleH, w: safe.w, h: safe.h - titleH };
  const pad = u * 7;
  const P = points.map((p) => ({ ...p, px: pad + p.x * (panel.w - pad * 2), py: pad + p.y * (panel.h - pad * 2) }));
  // Labels sit beside their pin, on the side with more room, one line each.
  const off = u * 3.4;
  const labelH = u * 6;
  const slots = P.map((p) => {
    const right = p.x <= 0.62;
    const w = Math.max(u * 10, right ? panel.w - u * 2 - (p.px + off) : p.px - off - u * 2);
    return { right, x: right ? p.px + off : p.px - off - w, y: p.py - labelH / 2, w };
  });
  const chipPad = u * 1.4;
  const lfs = Math.min(u * 4, ...P.map((p, i) => (p.label ? fitFont([p.label], slots[i]!.w - chipPad * 2, labelH, u * 4, u * 2.2) : Infinity)));
  P.forEach((p, i) => {
    const s = slots[i]!;
    const fits = fitFontInfo([p.label], s.w - chipPad * 2, labelH, lfs, lfs).fits;
    rec(ctx, "label", p.label, { x: panel.x + s.x, y: panel.y + s.y, w: s.w, h: labelH }, { fs: r2(lfs), fits }, ctx.colors.text, ctx.colors.bg);
  });
  const st = stagger(P.length, stage.dur, 0.3);
  const lineLen = Math.max(0.6, Math.min(stage.dur * 0.5, 1.6));
  let dist = 0;
  const cum = P.map((p, i) => (i === 0 ? 0 : (dist += Math.hypot(p.px - P[i - 1]!.px, p.py - P[i - 1]!.py))));
  const pinAt = (i: number) => (route ? 0.3 + (dist ? (cum[i]! / dist) * lineLen : 0) : st.at(i));
  const grid: string[] = [];
  const cell = u * 12;
  const inset = u * 3;
  for (let x = cell; x < panel.w - 1; x += cell) grid.push(`<line x1="${r2(x)}" y1="${r2(inset)}" x2="${r2(x)}" y2="${r2(panel.h - inset)}" class="vs-map-grid"/>`);
  for (let y = cell; y < panel.h - 1; y += cell) grid.push(`<line x1="${r2(inset)}" y1="${r2(y)}" x2="${r2(panel.w - inset)}" y2="${r2(y)}" class="vs-map-grid"/>`);
  const routeSvg = route
    ? `<polyline points="${P.map((p) => `${r2(p.px)},${r2(p.py)}`).join(" ")}" stroke-width="${r2(u * 0.9)}" ${anim("draw-len", 0.3, lineLen, "vs-map-route", `--len:${r2(dist)}`)}/>`
    : "";
  const pins = P.map(
    (p, i) =>
      `<circle cx="${r2(p.px)}" cy="${r2(p.py)}" r="${r2(u * 3.2)}" ${anim("pop", pinAt(i), 0.35, "vs-map-halo")}/><circle cx="${r2(p.px)}" cy="${r2(p.py)}" r="${r2(u * 1.7)}" ${anim("pop", pinAt(i), 0.35, "vs-map-pin")}/>`,
  );
  const labels = P.map((p, i) => {
    const s = slots[i]!;
    return p.label
      ? `<div class="vs-map-slot${s.right ? "" : " vs-map-left"}" style="left:${px(panel.x + s.x)};top:${px(panel.y + s.y)};width:${px(s.w)};height:${px(labelH)}"><div ${anim("fade", pinAt(i) + 0.15, 0.35, `vs-map-label`, `font-size:${px(lfs)}`)}>${esc(p.label)}</div></div>`
      : "";
  });
  return [
    title && tb ? `<div class="vs-map-title" style="left:0;top:0;width:${px(safe.w)};height:${px(tb.h)}"><div ${anim("fade-up", 0.05, 0.5, `vs-headline`, `font-size:${px(tb.fit.fs)}`)}>${esc(title)}</div></div>` : "",
    `<svg class="vs-map-svg" width="${r2(panel.w)}" height="${r2(panel.h)}" viewBox="0 0 ${r2(panel.w)} ${r2(panel.h)}" style="left:${px(panel.x)};top:${px(panel.y)}">`,
    `<g ${anim("scale-in", 0, 0.5)}><rect x="0" y="0" width="${r2(panel.w)}" height="${r2(panel.h)}" rx="${r2(u * 3)}" class="vs-map-panel"/>`,
    ...grid,
    `</g>`,
    routeSvg,
    ...pins,
    `</svg>`,
    ...labels,
  ]
    .filter(Boolean)
    .join("\n");
}

const RENDERERS: Record<DeterministicKind, (ctx: KindCtx) => string> = {
  typography: renderTypography,
  code: renderCode,
  chart: renderChart,
  diagram: renderDiagram,
  comparison: renderComparison,
  cta: renderCta,
  end_card: renderEndCard,
  screenshot: renderScreenshot,
  quote: renderQuote,
  stat: renderStat,
  timeline: renderTimeline,
  split_screen: renderSplitScreen,
  lower_third: renderLowerThird,
  kinetic_text: renderKineticText,
  map: renderMap,
};

// ---------------------------------------------------------------------------------- document

/** Style-pack look for the stylesheet (all optional: absent keeps the renderer's defaults). */
type Look = Pick<VisualTokens, "weight_heading" | "weight_body" | "text_align" | "motion">;

/** Selectors of heading-weight text (the stylesheet's 700/800 rules). */
const HEADING_SELECTORS = [
  ".vs-typography",
  ".vs-kinetic",
  ".vs-headline",
  ".vs-stat-value",
  ".vs-quote-mark",
  ".vs-quote-text",
  ".vs-chart-title",
  ".vs-verdict",
  ".vs-card-label",
  ".vs-tl-label",
  ".vs-lt-name",
  ".vs-split-label",
  ".vs-split-text.vs-split-only",
  ".vs-node > div",
  ".vs-action",
  ".vs-value",
];

/** CSS appended after the base rules for style tokens; empty without any. */
function lookCss(look: Look): string {
  const rules: string[] = [];
  if (look.weight_heading !== undefined) rules.push(`${HEADING_SELECTORS.join(", ")} { font-weight: ${look.weight_heading}; }`);
  if (look.weight_body !== undefined) rules.push(`#vs-root { font-weight: ${look.weight_body}; }`);
  if (look.text_align === "left") {
    rules.push(
      ".vs-typography, .vs-kinetic, .vs-quote, .vs-verdict, .vs-cta, .vs-end { text-align: left; }",
      ".vs-cta, .vs-end { align-items: flex-start; }",
      ".vs-lt-headline, .vs-map-title { justify-content: flex-start; text-align: left; }",
    );
  } else if (look.text_align === "center") {
    rules.push(".vs-quote { text-align: center; }");
  }
  if (look.motion && look.motion.exit_ms > 0) {
    rules.push(
      ".vs-exit { animation: vs-exit var(--xd) linear var(--xt) both paused; }",
      "@keyframes vs-exit { from { opacity: 1; } to { opacity: 0; } }",
    );
  }
  return rules.length ? `\n/* style pack */\n${rules.join("\n")}` : "";
}

function stylesheet(stage: Stage, tokens: Record<keyof typeof FALLBACK_TOKENS, string>, fontNames: string[], bundledFaces = "", look: Look = {}): string {
  const { W, H, u, safe } = stage;
  const easing = look.motion ? EASING_CSS[look.motion.easing] : EASING_CSS.ease_out;
  const faces = fontNames.map((n) => `@font-face { font-family: "${n}"; src: local("${n}"); }`).join("\n");
  // Bundled fonts (fontFaceCss) come first; the local() rules still cover system families.
  return `${bundledFaces ? `${bundledFaces}\n` : ""}${faces}
:root {
  --vs-bg: ${tokens.color_background};
  --vs-text: ${tokens.color_text};
  --vs-primary: ${tokens.color_primary};
  --vs-secondary: ${tokens.color_secondary};
  --vs-font-heading: ${tokens.font_heading};
  --vs-font-body: ${tokens.font_body};
  --vs-font-mono: ${tokens.font_mono};
  --vs-u: ${px(u)};
  --vs-panel: color-mix(in srgb, var(--vs-text) 7%, var(--vs-bg));
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: var(--vs-bg); }
#vs-root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: var(--vs-bg); color: var(--vs-text); font-family: var(--vs-font-body); -webkit-font-smoothing: antialiased; }
.clip { position: absolute; left: 0; top: 0; width: 100%; height: 100%; visibility: hidden; }
.vs-safe { position: absolute; left: ${safe.x}px; top: ${safe.y}px; width: ${safe.w}px; height: ${safe.h}px; display: flex; flex-direction: column; justify-content: center; align-items: stretch; }
.vs-stack { display: flex; flex-direction: column; justify-content: center; gap: calc(var(--vs-u) * 2.5); width: 100%; }
.vs-a { animation-duration: var(--d); animation-delay: var(--t); animation-fill-mode: both; animation-iteration-count: 1; animation-timing-function: ${easing}; animation-play-state: paused; }
.vs-fade { animation-name: vs-fade; }
.vs-fade-up { animation-name: vs-fade-up; }
.vs-scale-in { animation-name: vs-scale-in; }
.vs-pop { animation-name: vs-pop; transform-box: fill-box; transform-origin: center; }
.vs-pop-center { animation-name: vs-pop; transform-box: view-box; transform-origin: 50% 0; }
.vs-slide-right { animation-name: vs-slide-right; }
.vs-slide-left { animation-name: vs-slide-left; }
.vs-grow-x { animation-name: vs-grow-x; transform-box: fill-box; transform-origin: 0 50%; }
.vs-grow-x-rev { animation-name: vs-grow-x; transform-box: fill-box; transform-origin: 100% 50%; }
.vs-grow-x-center { animation-name: vs-grow-x; transform-origin: 50% 50%; }
.vs-draw { animation-name: vs-draw; stroke-dasharray: 1; animation-timing-function: linear; }
.vs-zoom { animation-name: vs-zoom; animation-timing-function: linear; }
.vs-grow-y { animation-name: vs-grow-y; transform-origin: 50% 0; }
.vs-draw-len { animation-name: vs-draw-len; stroke-dasharray: var(--len); animation-timing-function: linear; }
.vs-kin { animation-name: vs-kin; }
.vs-flash { animation-name: vs-flash; animation-fill-mode: none; animation-timing-function: step-end; opacity: 0; }
@keyframes vs-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes vs-fade-up { from { opacity: 0; transform: translateY(calc(var(--vs-u) * 4)); } to { opacity: 1; transform: none; } }
@keyframes vs-scale-in { from { opacity: 0; transform: scale(0.92); } to { opacity: 1; transform: none; } }
@keyframes vs-pop { 0% { opacity: 0; transform: scale(0.6); } 70% { opacity: 1; transform: scale(1.06); } 100% { opacity: 1; transform: none; } }
@keyframes vs-slide-right { from { opacity: 0; transform: translateX(calc(var(--vs-u) * -8)); } to { opacity: 1; transform: none; } }
@keyframes vs-slide-left { from { opacity: 0; transform: translateX(calc(var(--vs-u) * 8)); } to { opacity: 1; transform: none; } }
@keyframes vs-grow-x { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes vs-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
@keyframes vs-zoom { from { transform: scale(1); } to { transform: scale(1.04); } }
@keyframes vs-grow-y { from { transform: scaleY(0); } to { transform: scaleY(1); } }
@keyframes vs-draw-len { from { stroke-dashoffset: var(--len); } to { stroke-dashoffset: 0; } }
@keyframes vs-kin { from { opacity: 0; transform: translateY(0.3em) scale(1.12); } to { opacity: 1; transform: none; } }
@keyframes vs-flash { from { opacity: 1; } to { opacity: 1; } }
.vs-typography { font-family: var(--vs-font-heading); font-weight: 800; line-height: 1.15; letter-spacing: -0.01em; text-align: center; }
.vs-line { overflow-wrap: anywhere; }
.vs-em { color: var(--vs-primary); }
.vs-code-panel { background: var(--vs-panel); border-radius: calc(var(--vs-u) * 2); padding: calc(var(--vs-u) * 3); max-height: 90%; overflow: hidden; }
.vs-code-bar { display: flex; gap: calc(var(--vs-u) * 1.2); align-items: center; margin-bottom: calc(var(--vs-u) * 2); font-family: var(--vs-font-mono); font-size: calc(var(--vs-u) * 2.4); }
.vs-code-bar span { width: calc(var(--vs-u) * 1.6); height: calc(var(--vs-u) * 1.6); border-radius: 50%; background: var(--vs-text); opacity: 0.25; }
.vs-code-bar em { margin-left: auto; font-style: normal; opacity: 0.6; }
.vs-code { font-family: var(--vs-font-mono); line-height: 1.45; white-space: pre; overflow: hidden; }
.vs-code-line { display: flex; border-left: calc(var(--vs-u) * 0.6) solid transparent; padding-left: calc(var(--vs-u) * 1); }
.vs-code-line.vs-hl { background: color-mix(in srgb, var(--vs-primary) 22%, transparent); border-left-color: var(--vs-primary); }
.vs-ln { opacity: 0.4; min-width: 2.5em; text-align: right; padding-right: 1em; user-select: none; }
.tk-kw { color: var(--vs-primary); font-weight: 700; }
.tk-str { color: var(--vs-secondary); }
.tk-num, .tk-lit { color: var(--vs-secondary); font-weight: 700; }
.tk-com { opacity: 0.55; font-style: italic; }
.tk-fn { font-weight: 700; }
.tk-key { color: var(--vs-primary); }
.vs-chart-title { font-family: var(--vs-font-heading); font-weight: 700; font-size: calc(var(--vs-u) * 5.5); text-align: center; }
.vs-chart-svg { display: block; margin: 0 auto; overflow: visible; }
.vs-axis { fill: var(--vs-text); fill-opacity: 0.8; font-family: var(--vs-font-body); }
.vs-value { fill: var(--vs-text); font-family: var(--vs-font-heading); font-weight: 700; }
.vs-gridline { stroke: var(--vs-text); stroke-opacity: 0.25; stroke-width: 2; }
.vs-stat { align-items: center; text-align: center; }
.vs-stat-value { font-family: var(--vs-font-heading); font-weight: 800; color: var(--vs-primary); line-height: 1; }
.vs-stat-unit { font-size: 0.5em; margin-left: 0.08em; }
.vs-stat-label { font-weight: 600; }
.vs-edges { position: absolute; left: 0; top: 0; overflow: visible; }
.vs-node { position: absolute; display: flex; }
.vs-node > div { flex: 1; display: flex; align-items: center; justify-content: center; text-align: center; padding: 0 calc(var(--vs-u) * 1); border: calc(var(--vs-u) * 0.45) solid var(--vs-primary); border-radius: calc(var(--vs-u) * 1.6); background: color-mix(in srgb, var(--vs-primary) 14%, var(--vs-bg)); font-family: var(--vs-font-heading); font-weight: 700; overflow: hidden; overflow-wrap: anywhere; line-height: 1.15; }
.vs-compare { display: flex; gap: calc(var(--vs-u) * 4); }
.vs-rows { flex-direction: column; }
.vs-columns > * { flex: 1; }
.vs-card { background: var(--vs-panel); border-radius: calc(var(--vs-u) * 2); padding: calc(var(--vs-u) * 3); border-top: calc(var(--vs-u) * 0.8) solid var(--vs-primary); overflow: hidden; overflow-wrap: anywhere; }
.vs-card.vs-right { border-top-color: var(--vs-secondary); }
.vs-card-label { font-family: var(--vs-font-heading); font-weight: 800; color: var(--vs-primary); margin-bottom: 0.4em; }
.vs-card.vs-right .vs-card-label { color: var(--vs-secondary); }
.vs-card-text { line-height: 1.3; }
.vs-verdict { font-family: var(--vs-font-heading); font-weight: 700; text-align: center; padding: calc(var(--vs-u) * 2); border-radius: calc(var(--vs-u) * 1.5); background: color-mix(in srgb, var(--vs-primary) 18%, transparent); overflow-wrap: anywhere; }
.vs-cta, .vs-end { align-items: center; text-align: center; }
.vs-headline { font-family: var(--vs-font-heading); font-weight: 800; line-height: 1.1; overflow-wrap: anywhere; }
.vs-subtitle { opacity: 0.85; overflow-wrap: anywhere; }
.vs-action { display: inline-block; background: var(--vs-primary); color: var(--vs-bg); font-family: var(--vs-font-heading); font-weight: 800; padding: 0.45em 1.2em; border-radius: 999px; overflow-wrap: anywhere; }
.vs-command { font-family: var(--vs-font-mono); background: var(--vs-panel); padding: 0.6em 1em; border-radius: calc(var(--vs-u) * 1.5); max-width: 100%; overflow-wrap: anywhere; text-align: left; }
.vs-prompt { color: var(--vs-secondary); }
.vs-url { color: var(--vs-secondary); font-weight: 600; overflow-wrap: anywhere; }
.vs-logo { max-width: 40%; max-height: calc(var(--vs-u) * 14); object-fit: contain; }
.vs-rule { width: 30%; height: calc(var(--vs-u) * 0.8); border-radius: 999px; background: var(--vs-primary); }
.vs-shot { position: relative; width: 100%; border-radius: calc(var(--vs-u) * 2); overflow: hidden; background: var(--vs-panel); }
.vs-shot-img { width: 100%; height: 100%; object-fit: contain; display: block; }
.vs-shot-missing { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; opacity: 0.5; font-family: var(--vs-font-mono); border: calc(var(--vs-u) * 0.4) dashed var(--vs-text); border-radius: inherit; }
.vs-pin { position: absolute; transform: translate(-50%, -50%); }
.vs-pin > div { display: flex; align-items: center; gap: 0.4em; }
.vs-pin-dot { width: 1em; height: 1em; border-radius: 50%; background: var(--vs-primary); box-shadow: 0 0 0 0.3em color-mix(in srgb, var(--vs-primary) 35%, transparent); flex: none; }
.vs-callouts { display: flex; flex-direction: column; gap: 0.6em; margin-top: calc(var(--vs-u) * 3); }
.vs-callout { background: var(--vs-primary); color: var(--vs-bg); font-weight: 700; padding: 0.35em 0.8em; border-radius: 0.6em; overflow-wrap: anywhere; }
.vs-callouts .vs-callout { align-self: flex-start; }
.vs-muted { color: color-mix(in srgb, var(--vs-text) 72%, var(--vs-bg)); }
.vs-quote { align-items: stretch; text-align: left; }
.vs-quote-mark { font-family: var(--vs-font-heading); font-weight: 800; color: var(--vs-primary); line-height: 1; overflow: visible; }
.vs-quote-text { font-family: var(--vs-font-heading); font-weight: 700; line-height: 1.25; overflow-wrap: anywhere; }
.vs-quote-attr { font-weight: 700; color: var(--vs-primary); overflow-wrap: anywhere; }
.vs-quote-source { overflow-wrap: anywhere; }
.vs-stat-label { line-height: 1.15; overflow-wrap: anywhere; }
.vs-stat-context { overflow-wrap: anywhere; }
.vs-count { position: relative; display: inline-block; }
.vs-count-frame { position: absolute; left: 0; top: 0; width: 100%; text-align: center; }
.vs-tl-line { position: absolute; background: color-mix(in srgb, var(--vs-text) 30%, var(--vs-bg)); border-radius: 999px; }
.vs-tl-pos, .vs-tl-event, .vs-split-pos, .vs-lt-pos, .vs-lt-headline, .vs-map-slot, .vs-map-title { position: absolute; display: flex; }
.vs-tl-dot { flex: 1; border-radius: 50%; background: var(--vs-primary); border: calc(var(--vs-u) * 0.5) solid var(--vs-primary); }
.vs-tl-dot.vs-tl-future { background: var(--vs-bg); border-color: color-mix(in srgb, var(--vs-text) 45%, var(--vs-bg)); }
.vs-tl-dot.vs-tl-current { box-shadow: 0 0 0 calc(var(--vs-u) * 1.2) color-mix(in srgb, var(--vs-primary) 35%, transparent); }
.vs-tl-event { flex-direction: column; justify-content: center; }
.vs-tl-event.vs-tl-under { justify-content: flex-start; text-align: center; }
.vs-tl-label { font-family: var(--vs-font-heading); font-weight: 800; line-height: 1.15; overflow-wrap: anywhere; }
.vs-tl-text { line-height: 1.3; margin-top: 0.3em; overflow-wrap: anywhere; }
.vs-tl-current .vs-tl-label { color: var(--vs-primary); }
.vs-tl-event.vs-tl-future { color: color-mix(in srgb, var(--vs-text) 60%, var(--vs-bg)); }
.vs-split { flex: 1; display: flex; flex-direction: column; min-height: 0; background: var(--vs-panel); border-radius: calc(var(--vs-u) * 2); padding: calc(var(--vs-u) * 3); border-top: calc(var(--vs-u) * 0.8) solid var(--vs-primary); overflow: hidden; }
.vs-split.vs-right { border-top-color: var(--vs-secondary); }
.vs-split-label { font-family: var(--vs-font-heading); font-weight: 800; color: var(--vs-primary); line-height: 1.15; overflow: hidden; overflow-wrap: anywhere; }
.vs-split.vs-right .vs-split-label { color: var(--vs-secondary); }
.vs-split-media { flex: 1; min-height: 0; margin: calc(var(--vs-u) * 1.5) 0; border-radius: calc(var(--vs-u) * 1.2); overflow: hidden; }
.vs-split-img { width: 100%; height: 100%; object-fit: contain; display: block; }
.vs-split-text { line-height: 1.3; overflow-wrap: anywhere; }
.vs-split-text.vs-split-only { flex: 1; display: flex; align-items: center; font-family: var(--vs-font-heading); font-weight: 700; margin-top: calc(var(--vs-u) * 2); }
.vs-split.vs-before { border-top-color: color-mix(in srgb, var(--vs-text) 45%, var(--vs-bg)); }
.vs-split.vs-before .vs-split-label { color: color-mix(in srgb, var(--vs-text) 72%, var(--vs-bg)); }
.vs-split.vs-after { border-top-color: var(--vs-primary); box-shadow: 0 0 0 calc(var(--vs-u) * 0.4) var(--vs-primary); }
.vs-split.vs-after .vs-split-label { color: var(--vs-primary); }
.vs-split-arrow { position: absolute; overflow: visible; }
.vs-lt-headline { align-items: center; justify-content: center; text-align: center; }
.vs-lt { flex: 1; display: flex; background: var(--vs-panel); border-radius: calc(var(--vs-u) * 1.2); overflow: hidden; }
.vs-lt-stripe { flex: none; background: var(--vs-primary); }
.vs-lt-text { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; }
.vs-lt-name { font-family: var(--vs-font-heading); font-weight: 800; line-height: 1.15; overflow-wrap: anywhere; }
.vs-lt-title { line-height: 1.2; color: color-mix(in srgb, var(--vs-text) 75%, var(--vs-panel)); overflow-wrap: anywhere; }
.vs-kinetic { font-family: var(--vs-font-heading); font-weight: 800; line-height: 1.15; letter-spacing: -0.01em; text-align: center; }
.vs-kin-line { overflow-wrap: anywhere; }
.vs-kin-chunk { display: inline-block; }
.vs-map-title { align-items: center; justify-content: center; text-align: center; }
.vs-map-svg { position: absolute; overflow: visible; }
.vs-map-panel { fill: var(--vs-panel); stroke: color-mix(in srgb, var(--vs-text) 18%, var(--vs-bg)); stroke-width: 2; }
.vs-map-grid { stroke: var(--vs-text); stroke-opacity: 0.07; stroke-width: 2; }
.vs-map-route { fill: none; stroke: var(--vs-primary); stroke-linecap: round; stroke-linejoin: round; }
.vs-map-halo { fill: var(--vs-primary); fill-opacity: 0.25; }
.vs-map-pin { fill: var(--vs-primary); stroke: var(--vs-bg); stroke-width: 3; }
.vs-map-slot { align-items: center; }
.vs-map-slot.vs-map-left { justify-content: flex-end; }
.vs-map-label { background: var(--vs-bg); color: var(--vs-text); font-weight: 700; padding: 0.3em 0.7em; border-radius: 0.6em; white-space: nowrap; overflow: hidden; max-width: 100%; }${lookCss(look)}`;
}

/**
 * The registered timeline. It is a GSAP-shaped object (the runtime only requires `duration`,
 * `seek`/`totalTime`, `pause`, `play`) whose seek applies CSS animation state for time `t`.
 * It never advances by itself: rendering always seeks.
 */
function timelineScript(compositionId: string, duration: number): string {
  const id = JSON.stringify(compositionId);
  return `(function () {
  var DURATION = ${fmtSec(duration)};
  var t = 0;
  var playing = false;
  function animations() {
    return typeof document.getAnimations === "function" ? document.getAnimations() : [];
  }
  function apply(seconds) {
    t = Math.min(Math.max(0, Number(seconds) || 0), DURATION);
    var list = animations();
    for (var i = 0; i < list.length; i++) {
      try { list[i].currentTime = t * 1000; list[i].pause(); } catch (e) {}
    }
  }
  var tl = {
    duration: function () { return DURATION; },
    totalDuration: function () { return DURATION; },
    seek: function (s) { apply(s); return tl; },
    totalTime: function (s) { if (s === undefined) return t; apply(s); return tl; },
    time: function (s) { if (s === undefined) return t; apply(s); return tl; },
    progress: function (p) { if (p === undefined) return DURATION ? t / DURATION : 0; apply(p * DURATION); return tl; },
    pause: function () { playing = false; apply(t); return tl; },
    play: function () { playing = true; return tl; },
    paused: function (v) { if (v === undefined) return !playing; playing = !v; return tl; },
    isActive: function () { return false; },
    timeScale: function (v) { return v === undefined ? 1 : tl; },
    getChildren: function () { return []; },
    kill: function () { return tl; }
  };
  window.__timelines = window.__timelines || {};
  window.__timelines[${id}] = tl;
  apply(0);
})();`;
}

function resolveTokens(tokens: VisualTokens, warnings: string[]) {
  const colour = (key: "color_background" | "color_text" | "color_primary" | "color_secondary") => {
    const v = tokens[key]?.trim();
    if (v && HEX.test(v)) return v;
    warnings.push(`tokens: ${key} "${v ?? ""}" is not a hex colour; using ${FALLBACK_TOKENS[key]}`);
    return FALLBACK_TOKENS[key];
  };
  const heading = sanitizeFontChain(tokens.font_heading ?? "", FALLBACK_TOKENS.font_heading);
  const body = sanitizeFontChain(tokens.font_body ?? "", FALLBACK_TOKENS.font_body);
  const mono = sanitizeFontChain(tokens.font_mono ?? "", FALLBACK_TOKENS.font_mono);
  const names = [...new Set([...heading.names, ...body.names, ...mono.names])];
  return {
    values: {
      color_background: colour("color_background"),
      color_text: colour("color_text"),
      color_primary: colour("color_primary"),
      color_secondary: colour("color_secondary"),
      font_heading: heading.css,
      font_body: body.css,
      font_mono: mono.css,
    },
    fontNames: names,
  };
}

/** True when `child` is inside `parent` (both absolute). */
function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Composition id for a scene (`vs-s01`). */
export function compositionIdFor(sceneId: string): string {
  return `vs-${sceneId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/**
 * Build a self-contained HyperFrames HTML composition for one deterministic scene.
 * Pure: no filesystem or network access. Asset files are returned for the caller to copy.
 */
export function buildComposition(req: SceneRenderRequest, opts: BuildCompositionOptions = {}): Composition {
  const { scene, target, project_dir } = req;
  const det = scene.deterministic;
  if (!det) throw new Error(`scene ${scene.id} has no deterministic content`);
  const render = RENDERERS[det.kind];
  if (!render) throw new Error(`scene ${scene.id}: unsupported deterministic kind "${String(det.kind)}"`);
  const W = Math.round(target.width);
  const H = Math.round(target.height);
  if (!(W > 0 && H > 0)) throw new Error(`invalid target size ${target.width}x${target.height}`);
  const dur = scene.duration_sec;
  const warnings: string[] = [];
  const assets: CompositionAsset[] = [];
  const projectRoot = resolve(project_dir);

  const addAsset = (absPath: string, name: string): string => {
    const existing = assets.find((a) => a.src === absPath);
    if (existing) return existing.dest;
    const ext = extname(absPath).toLowerCase();
    const dest = `assets/${name}-${assets.length + 1}${IMAGE_EXT.test(ext) ? ext : ""}`;
    assets.push({ src: absPath, dest });
    return dest;
  };
  /** Project-relative path → absolute, only if it stays inside the project and is an image. */
  const projectImage = (p: string): string | undefined => {
    const abs = resolve(projectRoot, p);
    if (!inside(projectRoot, abs)) return undefined;
    if (!IMAGE_EXT.test(extname(abs))) return undefined;
    return abs;
  };
  const resolveAsset = (id: string): string | undefined => {
    const viaOpt = opts.resolveAsset?.(id);
    if (viaOpt) {
      const abs = resolve(projectRoot, viaOpt);
      if (inside(projectRoot, abs) && IMAGE_EXT.test(extname(abs))) return abs;
      warnings.push(`${det.kind}: asset "${id}" resolves outside the project or is not an image; ignored`);
      return undefined;
    }
    return /[/\\.]/.test(id) ? projectImage(id) : undefined;
  };

  const safe = safeArea({ width: W, height: H, aspect_ratio: target.aspect_ratio }, req.zones);
  const stage: Stage = { W, H, u: Math.min(W, H) / 100, safe, portrait: H > W, dur };
  const tok = resolveTokens(req.tokens, warnings);
  const v = tok.values;
  const colors = { bg: v.color_background, text: v.color_text, primary: v.color_primary, secondary: v.color_secondary, panel: mixHex(v.color_background, v.color_text, 0.07) };
  const boxes: TextBox[] = [];

  let logo: string | undefined;
  if (req.tokens.logo_path && (det.kind === "cta" || det.kind === "end_card")) {
    const abs = projectImage(req.tokens.logo_path);
    if (abs) logo = addAsset(abs, "logo");
    else warnings.push(`tokens: logo_path "${req.tokens.logo_path}" is outside the project or not an image; logo omitted`);
  }

  const main: TextRole = scene.purpose === "hook" ? "hook" : "headline";
  const t = req.tokens;
  const head: KindCtx["head"] = { ...(t.text_case ? { case: t.text_case } : {}), ...(t.heading_scale !== undefined ? { scale: t.heading_scale } : {}) };
  let content: string;
  activeMotion = t.motion;
  try {
    content = render({ stage, props: det.props ?? {}, warnings, asset: addAsset, resolveAsset, logo, main, colors, boxes, head });
  } finally {
    activeMotion = undefined;
  }
  // Exit: the scene content fades out over the style's exit_ms at the end of the clip.
  const exitS = t.motion ? Math.min(t.motion.exit_ms / 1000, dur * 0.2) : 0;
  const exitAt = Math.max(0, dur - 1 / target.fps - exitS);
  const safeOpen = exitS >= 0.02 ? `<div class="vs-safe vs-exit" style="--xt:${fmtSec(exitAt)}s;--xd:${fmtSec(exitS)}s">` : `<div class="vs-safe">`;
  const look: Look = {
    ...(t.weight_heading !== undefined ? { weight_heading: t.weight_heading } : {}),
    ...(t.weight_body !== undefined ? { weight_body: t.weight_body } : {}),
    ...(t.text_align ? { text_align: t.text_align } : {}),
    ...(t.motion ? { motion: t.motion } : {}),
  };
  // Bundled font files are copied next to the composition and referenced relatively, so the
  // page loads nothing from outside its directory and the HTML does not embed host paths.
  const bundledFaces = fontFaceCss(req.tokens).replace(/url\("(file:[^"]+)"\)/g, (_m, href: string) => {
    const src = fileURLToPath(href);
    const dest = `assets/fonts/${basename(src).replace(/[^A-Za-z0-9._-]/g, "_")}`;
    if (!assets.some((a) => a.dest === dest)) assets.push({ src, dest });
    return `url("${dest}")`;
  });
  const compositionId = compositionIdFor(scene.id);
  const d = fmtSec(dur);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${W}, height=${H}">
<title>${esc(`${scene.id} ${det.kind}`)}</title>
<style>
${stylesheet(stage, tok.values, tok.fontNames, bundledFaces, look)}
</style>
</head>
<body>
<div id="vs-root" data-composition-id="${compositionId}" data-start="0" data-duration="${d}" data-width="${W}" data-height="${H}" data-fps="${target.fps}">
<div id="vs-scene" class="clip vs-kind-${det.kind.replace(/_/g, "-")}" data-start="0" data-duration="${d}" data-track-index="0">
${safeOpen}
${content}
</div>
</div>
</div>
<script>
${timelineScript(compositionId, dur)}
</script>
</body>
</html>
`;
  return { composition_id: compositionId, html, assets, warnings, text_boxes: boxes };
}

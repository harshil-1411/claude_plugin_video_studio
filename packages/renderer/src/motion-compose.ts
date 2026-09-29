import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeHtml } from "./hyperframes-highlight.js";
import { cueItemStarts } from "./cue-timing.js";
import { MOTION_KIT_SOURCE } from "./motion-kit.js";
import { parseAttrs } from "./motion-lint.js";
import { revealSchedule } from "./reveal-schedule.js";
import { fontFaceCss } from "./tokens.js";
import type { ResolvedCue, SceneRenderRequest } from "./types.js";
import type { Composition, CompositionAsset } from "./hyperframes-compose.js";

/**
 * Composer for `motion` scenes: a page Claude wrote as code, wrapped into a HyperFrames
 * composition (pinned producer 0.8.78). Pure: no filesystem or network access; the same inputs
 * give byte-identical HTML.
 *
 * Authoring contract (the page, e.g. `motion/s01.html`):
 * - `window.seek(t)` is synchronous and pure: it draws the whole frame from `t` (scene-local
 *   seconds) alone, whatever order it is called in. The renderer seeks every frame.
 * - `window.readyForCapture` is a Promise that resolves once fonts and images have decoded.
 *   Without it the composer waits for `document.fonts.ready`.
 * - No CSS transitions or animations, no timers or `requestAnimationFrame` driving state, no
 *   wall clock (`Date.now`, `performance.now`), no unseeded randomness (use `vs.rng(seed)`), no
 *   network. Physics is closed-form, or pre-simulated and indexed by time; springs are
 *   closed-form step responses (`vs.spring`), and a value whose target changes several times is
 *   the sum of one spring per change (`vs.springs`).
 * - Viewer-facing copy comes from `window.__vs.text` (the scene's `props.text`), so grounding,
 *   verify, localize and word cues see it.
 * - Local files (scripts, styles, images, fonts) sit in the page's folder and are referenced
 *   relatively; they are copied next to the composition with the same relative paths.
 * - The page draws on a canvas of the target size. A page designed for another size declares it
 *   with `<meta name="vs-canvas" content="1080x1920">` and is scaled to fit (contain, centred).
 *
 * Injected before any author code, first thing in `<head>`:
 * - a Content-Security-Policy meta: local scripts, styles, images, fonts and media only, and no
 *   `connect-src` (the runtime backstop for the static lint in motion-lint.ts);
 * - `window.__vs = { fps, duration, width, height, target, text, beats, downbeats, cues, reveals, tokens, loop, audio? }`
 *   (`reveals`: when each `text` item should start entering, from {@link motionReveals}; `audio`:
 *   the music bed's envelope under the scene, only with a bed) (JSON with `<`, `>`, `&`, U+2028/2029 escaped, so no value can close the script tag);
 * - the motion kit (`window.vs`, motion-kit.ts).
 *
 * After the author's markup: the timeline adapter, registered synchronously on
 * `window.__timelines[<composition id>]` (the producer polls for it), whose `seek(t)` calls
 * `window.seek(t)`. Readiness goes through the runtime's `window.__hf.buildReady` registry: the
 * runtime holds render-ready until every promise there settles, so capture starts only after
 * `readyForCapture`. Author scripts in `<body>` are moved after the page's markup (in order), so
 * the producer's composition scoping never sees a script inside the clip.
 */

export const MOTION_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self'";

/** Where the composer's own files (bundled fonts) go in the composition dir; never an author path. */
export const MOTION_INTERNAL_DIR = "__vs";

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export interface MotionComposeOptions {
  /** Word cues (scene-local); defaults to the request's. */
  cues?: readonly ResolvedCue[];
  /** Bundled fonts directory (tests); undefined: the default lookup, null: none. */
  fontsDir?: string | null;
}

/** JSON safe to embed in an inline <script>: nothing in it can end the element or break the parser. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Entrance length (s) the reveal schedule assumes for a motion page's text (a masked line slide). */
export const MOTION_REVEAL_ENTRANCE_S = 0.45;

/**
 * When each `text` item of a motion page should start entering (`window.__vs.reveals`,
 * `vs.revealAt(i)`): the readable schedule on the scene's beat grid (reveal-schedule.ts); items
 * with a word cue start on their cue (`CUE_LEAD_S` before the word) and later ones never before it.
 */
export function motionReveals(texts: readonly string[], duration: number, beats: SceneRenderRequest["beats"], cues: readonly ResolvedCue[]): number[] {
  const { times } = revealSchedule({ texts, beats: beats?.beats_s ?? [], downbeats: beats?.downbeats_s ?? [], duration, entrance: MOTION_REVEAL_ENTRANCE_S });
  return cueItemStarts(times, cues, 0);
}

function ms3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

interface SplitPage {
  head: string;
  body: string;
  scripts: string[];
  canvas?: { width: number; height: number };
}

/** The author's page split into head markup, body markup and body scripts (in order). */
export function splitMotionPage(html: string): SplitPage {
  let src = html.replace(/^﻿/, "").replace(/<!doctype[^>]*>/i, "");
  const headM = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i.exec(src);
  let head = headM?.[1] ?? "";
  if (headM) src = src.slice(0, headM.index) + src.slice(headM.index + headM[0].length);
  const bodyM = /<body\b[^>]*>([\s\S]*?)(?:<\/body\s*>|$)/i.exec(src);
  let body = bodyM ? bodyM[1]! : src.replace(/<\/?html\b[^>]*>/gi, "");
  body = body.replace(/<\/html\s*>\s*$/i, "");
  let canvas: SplitPage["canvas"];
  head = head.replace(/<meta\b([^>]*)>/gi, (whole, attrs: string) => {
    const a = parseAttrs(attrs);
    const name = (a.get("name") ?? "").toLowerCase();
    if (name === "vs-canvas") {
      const m = /^\s*(\d{2,5})\s*x\s*(\d{2,5})\s*$/i.exec(a.get("content") ?? "");
      if (m) canvas = { width: Number(m[1]), height: Number(m[2]) };
      return "";
    }
    if (a.has("charset") || name === "viewport") return "";
    return whole;
  });
  head = head.replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, "");
  const scripts: string[] = [];
  body = body.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (s) => {
    scripts.push(s);
    return "";
  });
  return { head: head.trim(), body: body.trim(), scripts, ...(canvas ? { canvas } : {}) };
}

function timelineAdapter(compositionId: string, duration: number): string {
  const id = JSON.stringify(compositionId);
  return `(function () {
  var DURATION = ${ms3(duration)};
  var t = 0;
  var playing = false;
  function apply(seconds) {
    t = Math.min(Math.max(0, Number(seconds) || 0), DURATION);
    if (typeof window.seek === "function") window.seek(t);
  }
  var ready = Promise.resolve(window.readyForCapture || (document.fonts ? document.fonts.ready : undefined)).then(function () { apply(t); });
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
  window.__hf = window.__hf || {};
  window.__hf.buildReady = window.__hf.buildReady || {};
  window.__hf.buildReady[${id}] = ready;
  try { apply(0); } catch (e) { if (typeof console !== "undefined") console.error(e); }
})();`;
}

/**
 * Wrap a motion page (`pageHtml`, the author's file) into a HyperFrames composition for `req`.
 * Returned assets are the composer's own (bundled fonts under `__vs/`); the caller copies the
 * page's local files (motion-lint.ts `loadMotionPage`) next to it with their relative paths.
 * `text_boxes` is empty: the page lays out its own text, which the composer cannot measure.
 */
export function composeMotion(req: SceneRenderRequest, pageHtml: string, opts: MotionComposeOptions = {}): Composition {
  const { scene, target, tokens } = req;
  const det = scene.deterministic;
  if (!det || det.kind !== "motion") throw new Error(`scene ${scene.id} is not a motion scene`);
  const W = Math.round(target.width);
  const H = Math.round(target.height);
  if (!(W > 0 && H > 0)) throw new Error(`invalid target size ${target.width}x${target.height}`);
  const dur = scene.duration_sec;
  const warnings: string[] = [];
  const assets: CompositionAsset[] = [];
  const props = det.props as { text?: unknown; loop?: unknown };
  const page = splitMotionPage(pageHtml);
  const canvas = page.canvas ?? { width: W, height: H };
  const scale = Math.min(W / canvas.width, H / canvas.height);
  const offX = (W - canvas.width * scale) / 2;
  const offY = (H - canvas.height * scale) / 2;
  const fit =
    canvas.width === W && canvas.height === H
      ? ""
      : ` left: ${ms3(offX)}px; top: ${ms3(offY)}px; transform: scale(${Math.round(scale * 1e6) / 1e6}); transform-origin: 0 0;`;

  const colour = (v: string | undefined, key: string): string | null => {
    if (v && HEX.test(v.trim())) return v.trim();
    warnings.push(`tokens: ${key} "${v ?? ""}" is not a hex colour; window.__vs.tokens.palette.${key} is null`);
    return null;
  };
  const palette = {
    background: colour(tokens.color_background, "background"),
    text: colour(tokens.color_text, "text"),
    primary: colour(tokens.color_primary, "primary"),
    secondary: colour(tokens.color_secondary, "secondary"),
  };
  const cues = opts.cues ?? req.cues ?? [];
  const text = Array.isArray(props.text) ? props.text.filter((x): x is string => typeof x === "string") : [];
  const vsData = {
    fps: target.fps,
    duration: dur,
    width: canvas.width,
    height: canvas.height,
    target: { width: W, height: H, aspect_ratio: target.aspect_ratio },
    text,
    beats: (req.beats?.beats_s ?? []).map(ms3),
    downbeats: (req.beats?.downbeats_s ?? []).map(ms3),
    cues: cues.map((c) => ({ item: c.item, at: ms3(c.at_s) })),
    reveals: motionReveals(text, dur, req.beats, cues).map(ms3),
    loop: props.loop === true,
    tokens: {
      palette,
      fonts: { heading: tokens.font_heading ?? null, body: tokens.font_body ?? null, mono: tokens.font_mono ?? null },
      ...(tokens.weight_heading !== undefined ? { weight_heading: tokens.weight_heading } : {}),
      ...(tokens.weight_body !== undefined ? { weight_body: tokens.weight_body } : {}),
      ...(tokens.text_case ? { text_case: tokens.text_case } : {}),
      ...(tokens.motion ? { motion: tokens.motion } : {}),
      ...(tokens.style ? { style: tokens.style } : {}),
      ...(tokens.language ? { language: tokens.language } : {}),
    },
    ...(req.audio ? { audio: { fps: req.audio.fps, rms: req.audio.rms, low: req.audio.low, onset: req.audio.onset } } : {}),
  };

  // Project and bundled fonts for the tokens' families, copied under __vs/fonts and referenced relatively
  // (a project file named like a bundled one gets its own name, `2-<name>`).
  const faces = fontFaceCss(tokens, { ...(opts.fontsDir === undefined ? {} : { fontsDir: opts.fontsDir }), projectDir: req.project_dir }).replace(/url\("(file:[^"]+)"\)/g, (_m, href: string) => {
    const src = fileURLToPath(href);
    const name = basename(src).replace(/[^A-Za-z0-9._-]/g, "_");
    let dest = `${MOTION_INTERNAL_DIR}/fonts/${name}`;
    for (let n = 2; assets.some((a) => a.dest === dest && a.src !== src); n++) dest = `${MOTION_INTERNAL_DIR}/fonts/${n}-${name}`;
    if (!assets.some((a) => a.dest === dest)) assets.push({ src, dest });
    return `url("${dest}")`;
  });

  const compositionId = `vs-${scene.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const d = String(ms3(dur));
  const bg = palette.background ?? "#000000";
  const html = `<!doctype html>
<html lang="${escapeHtml(tokens.language ?? "en")}">
<head>
<meta http-equiv="Content-Security-Policy" content="${MOTION_CSP}">
<meta charset="utf-8">
<meta name="viewport" content="width=${W}, height=${H}">
<title>${escapeHtml(`${scene.id} motion`)}</title>
<style>
html, body { margin: 0; padding: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: ${bg}; }
#vs-root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; }
#vs-scene { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; overflow: hidden; }
#vs-canvas { position: absolute; left: 0; top: 0; width: ${canvas.width}px; height: ${canvas.height}px; overflow: hidden;${fit} }${faces ? `\n${faces}` : ""}
</style>
<script>window.__vs = ${scriptJson(vsData)};</script>
<script>
${MOTION_KIT_SOURCE}</script>
${page.head}
</head>
<body>
<div id="vs-root" data-composition-id="${compositionId}" data-start="0" data-duration="${d}" data-width="${W}" data-height="${H}" data-fps="${target.fps}">
<div id="vs-scene" class="clip vs-kind-motion" data-start="0" data-duration="${d}" data-track-index="0">
<div id="vs-canvas">
${page.body}
</div>
</div>
</div>
${page.scripts.join("\n")}
<script>
${timelineAdapter(compositionId, dur)}
</script>
</body>
</html>
`;
  return { composition_id: compositionId, html, assets, warnings, text_boxes: [] };
}

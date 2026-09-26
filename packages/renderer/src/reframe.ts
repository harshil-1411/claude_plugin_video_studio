import type { FocusKeyframe, MediaInfo } from "@video-studio/schema";

/**
 * Subject-aware reframing (pure): the crop math shared by the footage renderer and lint, so the
 * `subject_near_edge` rule sees exactly the crop the render will use.
 *
 * A `focus_track` gives the SUBJECT'S CENTRE in the source frame over time (seconds from in_sec,
 * source time). The renderer:
 * 1. moves it into the fitted frame (after the content_box crop) and into play time (÷ speed);
 * 2. smooths it: a 1-2-1 moving average, a dead zone (small moves are ignored, so jitter never
 *    shakes the frame) and a maximum pan speed;
 * 3. eases between keyframes with smoothstep, and crops so the subject sits at the crop centre,
 *    clamped so the crop never leaves the picture: x = clamp(cx·iw − W/2, 0, iw − W).
 */

/** A focus keyframe in play time (seconds from the clip start after speed), fitted-frame fractions. */
export interface FocusPoint {
  t: number;
  x: number;
  y: number;
}

/** Smoothing and size limits (design rules). */
export const REFRAME = {
  /** Moves smaller than this (fraction of the frame) are ignored. */
  dead_zone: 0.02,
  /** Fastest pan, in frame fractions per second of play time. */
  max_speed: 0.3,
  /** Keyframes kept in the ffmpeg expression (more are downsampled, first and last kept). */
  max_keys: 48,
  /** subject_near_edge: the subject centre within this share of the crop's edge. */
  edge_margin: 0.08,
} as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const n4 = (n: number) => String(Math.round(n * 10000) / 10000);

/** Size of the source (w×h) once scaled to cover W×H, before the crop (ffmpeg force_original_aspect_ratio=increase). */
export function coverSize(srcW: number, srcH: number, W: number, H: number): { iw: number; ih: number } {
  const s = Math.max(W / srcW, H / srcH);
  return { iw: Math.max(W, Math.round(srcW * s)), ih: Math.max(H, Math.round(srcH * s)) };
}

/** The frame the fit sees: the source, or its content_box when bars are cropped first. */
export function fittedFrame(media: Pick<MediaInfo, "width" | "height" | "content_box">): { w: number; h: number } | undefined {
  if (media.content_box) return { w: media.content_box.w, h: media.content_box.h };
  return media.width && media.height ? { w: media.width, h: media.height } : undefined;
}

/**
 * Source-frame keyframes → play-time points in the fitted frame. Keyframes past the clip's source
 * span are dropped (one is kept past the end so the move into the last frame stays right).
 */
export function toPlayPoints(
  track: readonly FocusKeyframe[],
  opts: { speed?: number; spanSec?: number; media?: Pick<MediaInfo, "width" | "height" | "content_box"> } = {},
): FocusPoint[] {
  const speed = opts.speed ?? 1;
  const box = opts.media?.content_box;
  const sw = opts.media?.width;
  const sh = opts.media?.height;
  const toBox = (v: number, full: number | undefined, off: number, len: number) => (full ? clamp((v * full - off) / len, 0, 1) : v);
  const pts: FocusPoint[] = [];
  for (const k of track) {
    if (opts.spanSec !== undefined && pts.length && pts[pts.length - 1]!.t * speed >= opts.spanSec) break;
    pts.push({
      t: k.t / speed,
      x: box ? toBox(k.x, sw, box.x, box.w) : k.x,
      y: box ? toBox(k.y, sh, box.y, box.h) : k.y,
    });
  }
  return pts;
}

/** Moving average (1-2-1, ends kept), dead zone, max pan speed, then downsampling to `max_keys`. */
export function smoothFocus(points: readonly FocusPoint[], opts: Partial<Pick<typeof REFRAME, "dead_zone" | "max_speed" | "max_keys">> = {}): FocusPoint[] {
  const dz = opts.dead_zone ?? REFRAME.dead_zone;
  const vmax = opts.max_speed ?? REFRAME.max_speed;
  const maxKeys = Math.max(2, opts.max_keys ?? REFRAME.max_keys);
  const n = points.length;
  if (n === 0) return [];
  const avg = points.map((p, i) => {
    // Ends stay put (averaging them would pull the first and last position inwards).
    if (i === 0 || i === n - 1) return { ...p };
    const a = points[i - 1]!;
    const b = points[i + 1]!;
    return { t: p.t, x: (a.x + 2 * p.x + b.x) / 4, y: (a.y + 2 * p.y + b.y) / 4 };
  });
  // Dead zone: hold the last position until the subject has really moved.
  const held = { x: avg[0]!.x, y: avg[0]!.y };
  const dzd = avg.map((p) => {
    if (Math.abs(p.x - held.x) >= dz) held.x = p.x;
    if (Math.abs(p.y - held.y) >= dz) held.y = p.y;
    return { t: p.t, x: held.x, y: held.y };
  });
  // Max pan speed (forward pass).
  const out: FocusPoint[] = [dzd[0]!];
  for (let i = 1; i < dzd.length; i++) {
    const prev = out[i - 1]!;
    const p = dzd[i]!;
    const step = vmax * Math.max(0, p.t - prev.t);
    out.push({ t: p.t, x: prev.x + clamp(p.x - prev.x, -step, step), y: prev.y + clamp(p.y - prev.y, -step, step) });
  }
  // Drop keyframes that repeat their neighbours (the curve is flat there anyway).
  const lean = out.filter((p, i) => {
    const a = out[i - 1];
    const b = out[i + 1];
    return !(a && b && a.x === p.x && a.y === p.y && b.x === p.x && b.y === p.y);
  });
  if (lean.length <= maxKeys) return lean;
  const picked: FocusPoint[] = [];
  for (let i = 0; i < maxKeys; i++) picked.push(lean[Math.round((i * (lean.length - 1)) / (maxKeys - 1))]!);
  return picked;
}

const smoothstep = (u: number) => u * u * (3 - 2 * u);

/** The subject centre at play time `t` (smoothstep between keyframes, held before the first and after the last). */
export function focusAt(points: readonly FocusPoint[], t: number): { x: number; y: number } {
  const first = points[0];
  if (!first) return { x: 0.5, y: 0.5 };
  if (t < first.t) return { x: first.x, y: first.y };
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (t >= a.t && t < b.t) {
      const s = smoothstep((t - a.t) / (b.t - a.t));
      return { x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s };
    }
  }
  const last = points[points.length - 1]!;
  return { x: last.x, y: last.y };
}

/** Crop offset in pixels (top-left) for a subject centre, on a cover-scaled iw×ih frame cropped to W×H. */
export function coverCropAt(center: { x: number; y: number }, iw: number, ih: number, W: number, H: number): { x: number; y: number } {
  return { x: clamp(center.x * iw - W / 2, 0, Math.max(0, iw - W)), y: clamp(center.y * ih - H / 2, 0, Math.max(0, ih - H)) };
}

/** ffmpeg expression (in `t`) for one axis of the subject centre, mirroring focusAt. */
export function focusExpr(points: readonly FocusPoint[], axis: "x" | "y"): string {
  const v = points.map((p) => p[axis]);
  if (v.length === 0) return "0.5";
  if (v.every((x) => x === v[0])) return n4(v[0]!);
  const terms = [`if(lt(t,${n4(points[0]!.t)}),${n4(v[0]!)},0)`];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const d = v[i + 1]! - v[i]!;
    const u = `((t-${n4(a.t)})*${n4(1 / (b.t - a.t))})`;
    terms.push(d === 0 ? `if(gte(t,${n4(a.t)})*lt(t,${n4(b.t)}),${n4(v[i]!)},0)` : `if(gte(t,${n4(a.t)})*lt(t,${n4(b.t)}),${n4(v[i]!)}+${n4(d)}*${u}*${u}*(3-2*${u}),0)`);
  }
  const last = points[points.length - 1]!;
  terms.push(`if(gte(t,${n4(last.t)}),${n4(v[v.length - 1]!)},0)`);
  return terms.join("+");
}

/** The cover scale + time-varying crop that keeps the subject centred (single-quoted for a filtergraph). */
export function coverTrackFilter(points: readonly FocusPoint[], W: number, H: number): string {
  const cx = `clip((${focusExpr(points, "x")})*iw-${W / 2},0,iw-${W})`;
  const cy = `clip((${focusExpr(points, "y")})*ih-${H / 2},0,ih-${H})`;
  return `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bicubic,crop=${W}:${H}:'${cx}':'${cy}'`;
}

/** Keyframes as the renderer uses them: play time, fitted frame, smoothed. */
export function prepareFocusTrack(
  track: readonly FocusKeyframe[],
  opts: { speed?: number; spanSec?: number; media?: Pick<MediaInfo, "width" | "height" | "content_box"> } = {},
): FocusPoint[] {
  return smoothFocus(toPlayPoints(track, opts));
}

export interface EdgeHit {
  /** Keyframe time (seconds from in_sec, source time). */
  t: number;
  axis: "x" | "y";
  /** Where the subject centre sits in the crop (0 = left/top edge, 1 = right/bottom edge). */
  pos: number;
}

/**
 * Keyframes where the subject centre falls within `margin` of the crop's edge (or outside it),
 * using the renderer's smoothed crop. Only axes that are actually cropped are checked.
 */
export function subjectEdgeHits(
  track: readonly FocusKeyframe[],
  frame: { w: number; h: number },
  target: { width: number; height: number },
  opts: { speed?: number; spanSec?: number; media?: Pick<MediaInfo, "width" | "height" | "content_box">; margin?: number } = {},
): EdgeHit[] {
  const margin = opts.margin ?? REFRAME.edge_margin;
  const { width: W, height: H } = target;
  const { iw, ih } = coverSize(frame.w, frame.h, W, H);
  const raw = toPlayPoints(track, opts);
  const smooth = smoothFocus(raw);
  const hits: EdgeHit[] = [];
  raw.forEach((p, i) => {
    const crop = coverCropAt(focusAt(smooth, p.t), iw, ih, W, H);
    const px = (p.x * iw - crop.x) / W;
    const py = (p.y * ih - crop.y) / H;
    const t = track[i]!.t;
    if (iw > W + 1 && (px < margin || px > 1 - margin)) hits.push({ t, axis: "x", pos: px });
    if (ih > H + 1 && (py < margin || py > 1 - margin)) hits.push({ t, axis: "y", pos: py });
  });
  return hits;
}

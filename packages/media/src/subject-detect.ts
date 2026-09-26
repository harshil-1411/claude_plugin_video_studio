import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { type FfmpegTools, runFfmpeg, runProcess } from "./ffmpeg.js";

/**
 * Subject detection for reframing (macOS only): face rectangles and attention-based salient
 * objects from Apple's Vision framework, run through `osascript -l JavaScript` (JXA). No model
 * download, no network. Requests set `usesCPUOnly = true`: without it `performRequests` fails in
 * sandboxed processes. The NSError out-parameter is never read (reading it crashes osascript).
 *
 * Elsewhere (or without osascript) detection reports `available: false` with a reason; callers
 * fall back to Claude marking the subject by eye.
 */

/** A detected box, normalised to the image (0–1, top-left origin), with Vision's confidence. */
export interface SubjectBox {
  x: number;
  y: number;
  w: number;
  h: number;
  c: number;
}

export interface FrameDetections {
  path: string;
  /** Vision ran on this image (false: unreadable image or a failed request). */
  ok: boolean;
  faces: SubjectBox[];
  salient: SubjectBox[];
}

export type DetectResult = { available: true; frames: FrameDetections[] } | { available: false; reason: string; frames: FrameDetections[] };

export interface DetectOptions {
  signal?: AbortSignal;
  /** Per osascript call; default 20 s + 3 s per frame. */
  timeoutMs?: number;
  /** Tests: pretend to be another platform. */
  platform?: NodeJS.Platform;
  /** osascript binary (default /usr/bin/osascript). */
  osascript?: string;
}

/** Frames per osascript call (each call loads Vision once, ~1 s). */
const BATCH = 24;

/** The JXA detector: argv = absolute image paths; prints a JSON array of FrameDetections. */
export const VISION_JXA = `ObjC.import("Foundation");
ObjC.import("Vision");
function box(o) {
  var b = o.boundingBox;
  return { x: b.origin.x, y: 1 - b.origin.y - b.size.height, w: b.size.width, h: b.size.height, c: o.confidence };
}
function run(argv) {
  var out = [];
  for (var k = 0; k < argv.length; k++) {
    var path = argv[k];
    var rec = { path: path, ok: false, faces: [], salient: [] };
    try {
      var url = $.NSURL.fileURLWithPath(path);
      var handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $({}));
      var face = $.VNDetectFaceRectanglesRequest.alloc.init;
      var sal = $.VNGenerateAttentionBasedSaliencyImageRequest.alloc.init;
      face.usesCPUOnly = true;
      sal.usesCPUOnly = true;
      // The error out-parameter is passed but never read: dereferencing it crashes osascript.
      rec.ok = !!handler.performRequestsError($([face, sal]), Ref());
      var fr = face.results;
      for (var i = 0; i < (fr ? fr.count : 0); i++) rec.faces.push(box(fr.objectAtIndex(i)));
      var sr = sal.results;
      if (sr && sr.count > 0) {
        var objs = sr.objectAtIndex(0).salientObjects;
        for (var j = 0; j < (objs ? objs.count : 0); j++) rec.salient.push(box(objs.objectAtIndex(j)));
      }
    } catch (e) {
      rec.ok = false;
    }
    out.push(rec);
  }
  return JSON.stringify(out);
}
`;

const OSASCRIPT = "/usr/bin/osascript";

/** Whether Vision detection can run here (darwin with osascript), with the reason when not. */
export function visionAvailability(opts: Pick<DetectOptions, "platform" | "osascript"> = {}): { ok: true } | { ok: false; reason: string } {
  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin") return { ok: false, reason: `subject detection uses macOS Vision; this is ${platform}` };
  const bin = opts.osascript ?? OSASCRIPT;
  if (!existsSync(bin)) return { ok: false, reason: `osascript not found at ${bin}` };
  return { ok: true };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const toBox = (b: Partial<SubjectBox>): SubjectBox => ({ x: num(b.x), y: num(b.y), w: num(b.w), h: num(b.h), c: num(b.c) });

/** Parse the JXA output (tolerates junk around the JSON; never throws). */
export function parseVisionOutput(stdout: string, paths: readonly string[]): FrameDetections[] {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  let raw: unknown;
  try {
    raw = start >= 0 && end > start ? JSON.parse(stdout.slice(start, end + 1)) : undefined;
  } catch {
    raw = undefined;
  }
  const arr = Array.isArray(raw) ? (raw as Array<Partial<FrameDetections>>) : [];
  return paths.map((path, i) => {
    const r = arr[i];
    return {
      path,
      ok: !!r?.ok,
      faces: Array.isArray(r?.faces) ? r.faces.map(toBox) : [],
      salient: Array.isArray(r?.salient) ? r.salient.map(toBox) : [],
    };
  });
}

/**
 * Faces and salient objects per image (macOS Vision). Never throws for "nothing found"; a missing
 * platform or a crashed/timed-out osascript gives `available: false` with the reason. Aborts with
 * `signal` (the error propagates).
 */
export async function detectSubjects(frames: readonly string[], opts: DetectOptions = {}): Promise<DetectResult> {
  const avail = visionAvailability(opts);
  if (!avail.ok) return { available: false, reason: avail.reason, frames: [] };
  if (frames.length === 0) return { available: true, frames: [] };
  const paths = frames.map((f) => (isAbsolute(f) ? f : resolve(f)));
  const dir = await mkdtemp(join(tmpdir(), "vs-vision-"));
  const script = join(dir, "detect.js");
  try {
    await writeFile(script, VISION_JXA, "utf8");
    const out: FrameDetections[] = [];
    for (let i = 0; i < paths.length; i += BATCH) {
      const batch = paths.slice(i, i + BATCH);
      try {
        const { stdout } = await runProcess(opts.osascript ?? OSASCRIPT, ["-l", "JavaScript", script, ...batch], {
          captureStdout: true,
          timeoutMs: opts.timeoutMs ?? 20_000 + 3_000 * batch.length,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        out.push(...parseVisionOutput(stdout, batch));
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        const msg = err instanceof Error ? err.message.split("\n").slice(-2).join(" ") : String(err);
        return { available: false, reason: `macOS Vision did not run (${msg.slice(0, 300)})`, frames: out };
      }
    }
    return { available: true, frames: out };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------------------ focus tracks

/** A suggested focus keyframe: subject centre (source-frame fractions) at t seconds from `from`. */
export interface SuggestedKey {
  t: number;
  x: number;
  y: number;
}

export type SubjectDetector = (frames: string[], opts: { signal?: AbortSignal }) => Promise<DetectResult>;

export interface SuggestOptions {
  /** Asset seconds to start at (the clip's in_sec). */
  from: number;
  /** Asset seconds to stop at. */
  to: number;
  /** Samples per second (default 2). Lowered so at most MAX_SAMPLES frames are checked. */
  fps?: number;
  /** Sampled frame width in px (default 640). */
  width?: number;
  tools?: FfmpegTools;
  signal?: AbortSignal;
  /** Detector (default: macOS Vision). Tests inject one. */
  detector?: SubjectDetector;
}

export interface SuggestResult {
  method: "vision" | "unavailable";
  keys: SuggestedKey[];
  frames_checked: number;
  /** Frames where a face (or, failing that, a salient object) was picked. */
  detections: { faces: number; salient: number; missed: number };
  notes: string[];
}

export const MAX_SAMPLES = 180;
/** Smoothing for suggested tracks: moves under this (frame fraction) collapse into a hold. */
export const SUGGEST_DEAD_ZONE = 0.02;

export type SubjectPick = { x: number; y: number; source: "face" | "salient" } | null;

/**
 * The primary subject of one frame: the largest, most confident face, favouring one near the
 * previous subject (so the crop does not jump between two people); else the most prominent
 * salient object near the previous position. Face centres are nudged down a quarter of the face
 * height so head and shoulders stay in frame.
 */
export function pickPrimary(det: Pick<FrameDetections, "faces" | "salient">, prev: { x: number; y: number } | null): SubjectPick {
  const score = (b: SubjectBox, cx: number, cy: number) => {
    const size = b.w * b.h * Math.max(0.05, b.c || 0.5);
    if (!prev) return size;
    const d = Math.hypot(cx - prev.x, cy - prev.y);
    return size / (1 + 6 * d);
  };
  const best = (boxes: SubjectBox[], dy: number) => {
    let top: { x: number; y: number; s: number } | null = null;
    for (const b of boxes) {
      if (b.w <= 0 || b.h <= 0) continue;
      const cx = b.x + b.w / 2;
      const cy = Math.min(1, b.y + b.h / 2 + dy * b.h);
      const s = score(b, cx, cy);
      if (!top || s > top.s) top = { x: cx, y: cy, s };
    }
    return top;
  };
  const face = best(det.faces, 0.25);
  if (face) return { x: clamp01(face.x), y: clamp01(face.y), source: "face" };
  const sal = best(det.salient, 0);
  if (sal) return { x: clamp01(sal.x), y: clamp01(sal.y), source: "salient" };
  return null;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Per-frame picks → keyframes: misses carry the previous subject forward (leading misses take the
 * first detection), a 1-2-1 average removes jitter, and runs that stay inside the dead zone keep
 * only their ends. Times are rounded to ms and strictly increase.
 */
export function picksToTrack(times: readonly number[], picks: readonly SubjectPick[]): SuggestedKey[] {
  const firstHit = picks.find((p) => p);
  if (!firstHit) return [];
  let last = { x: firstHit.x, y: firstHit.y };
  const filled = times.map((t, i) => {
    const p = picks[i];
    if (p) last = { x: p.x, y: p.y };
    return { t, x: last.x, y: last.y };
  });
  const n = filled.length;
  const avg = filled.map((p, i) => {
    if (i === 0 || i === n - 1) return p;
    const a = filled[i - 1]!;
    const b = filled[i + 1]!;
    return { t: p.t, x: (a.x + 2 * p.x + b.x) / 4, y: (a.y + 2 * p.y + b.y) / 4 };
  });
  // Dead zone: hold the position until the subject has really moved.
  const held = { x: avg[0]!.x, y: avg[0]!.y };
  const dz = avg.map((p) => {
    if (Math.abs(p.x - held.x) >= SUGGEST_DEAD_ZONE) held.x = p.x;
    if (Math.abs(p.y - held.y) >= SUGGEST_DEAD_ZONE) held.y = p.y;
    return { t: p.t, x: held.x, y: held.y };
  });
  // A flat run keeps only its ends.
  const same = (a: SuggestedKey | undefined, b: SuggestedKey) => !!a && a.x === b.x && a.y === b.y;
  const out = dz.filter((p, i) => !(same(dz[i - 1], p) && same(dz[i + 1], p)));
  const keys = out.map((k) => ({ t: r3(k.t), x: r3(k.x), y: r3(k.y) }));
  return keys.filter((k, i) => i === 0 || k.t > keys[i - 1]!.t).slice(0, 200);
}

/**
 * Sample `from..to` of a video (ffmpeg, small frames), detect subjects per frame and turn the
 * primary subject's path into focus_track keyframes (t relative to `from`, source-frame
 * fractions). Unavailable detection returns method "unavailable" and no keys.
 */
export async function suggestFocusTrack(video: string, opts: SuggestOptions): Promise<SuggestResult> {
  const span = opts.to - opts.from;
  if (!(span > 0)) throw new Error(`suggestFocusTrack: empty range ${opts.from}..${opts.to}`);
  const detector: SubjectDetector = opts.detector ?? ((frames, o) => detectSubjects(frames, o.signal ? { signal: o.signal } : {}));
  const notes: string[] = [];
  let fps = opts.fps ?? 2;
  if (span * fps > MAX_SAMPLES) {
    fps = MAX_SAMPLES / span;
    notes.push(`sampled ${r3(fps)} frames/s so at most ${MAX_SAMPLES} frames are checked`);
  }
  const dir = await mkdtemp(join(tmpdir(), "vs-focus-"));
  try {
    await runFfmpeg(
      ["-y", "-ss", opts.from.toFixed(3), "-t", span.toFixed(3), "-i", video, "-vf", `fps=${fps},scale=${Math.round(opts.width ?? 640)}:-2:flags=bicubic`, "-an", "-sn", "-dn", join(dir, "f%04d.png")],
      { ...(opts.tools ? { tools: opts.tools } : {}), ...(opts.signal ? { signal: opts.signal } : {}), timeoutMs: 5 * 60_000 },
    );
    const files = (await readdir(dir)).filter((f) => /^f\d+\.png$/.test(f)).sort();
    const frames = files.map((f) => join(dir, f));
    // The fps filter emits frame k at k / fps from the start.
    const times = files.map((_, k) => Math.min(span, k / fps));
    const det = await detector(frames, opts.signal ? { signal: opts.signal } : {});
    if (!det.available) {
      return { method: "unavailable", keys: [], frames_checked: 0, detections: { faces: 0, salient: 0, missed: 0 }, notes: [...notes, det.reason] };
    }
    const byPath = new Map(det.frames.map((d) => [d.path, d]));
    const picks: SubjectPick[] = [];
    let prev: { x: number; y: number } | null = null;
    const counts = { faces: 0, salient: 0, missed: 0 };
    for (const f of frames) {
      const d = byPath.get(f);
      const p: SubjectPick = d ? pickPrimary(d, prev) : null;
      if (p) {
        counts[p.source === "face" ? "faces" : "salient"]++;
        prev = { x: p.x, y: p.y };
      } else counts.missed++;
      picks.push(p);
    }
    const keys = picksToTrack(times, picks);
    if (!keys.length) notes.push("no face or salient subject was found in any sampled frame");
    else {
      if (counts.missed) notes.push(`${counts.missed} frame(s) without a subject kept the previous position`);
      if (!counts.faces) notes.push("no faces found; the track follows the most salient object");
    }
    return { method: "vision", keys, frames_checked: frames.length, detections: counts, notes };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

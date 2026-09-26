import { type RunOptions, runFfmpeg } from "./ffmpeg.js";

/**
 * Baked-in letterbox / pillarbox detection. Stock footage and screen recordings often carry black
 * bars inside the picture; fitting such a clip with `cover` keeps the bars. This finds the real
 * picture so the footage renderer can crop the bars off first.
 *
 * Strict on purpose: dark scenes (night skies, a window seen from a dark room) look like bars to
 * a naive detector, and cropping them would destroy real content. A box is only reported when
 * the borders are near pure black, identical in every sample across the clip, and symmetric
 * (true bars are centred), and trim at least a little of the frame.
 */

export interface ContentBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Luma limit for "black" (0–255): stricter than cropdetect's default 24, so dark scenes stay. */
export const LETTERBOX_BLACK_LIMIT = 16;
/** Samples spread over the clip; every one must agree. */
export const LETTERBOX_SAMPLES = 5;

/** Parse the last `crop=w:h:x:y` cropdetect printed. */
export function parseCropdetect(stderr: string): ContentBox | null {
  const all = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  const m = all[all.length - 1];
  return m ? { w: Number(m[1]), h: Number(m[2]), x: Number(m[3]), y: Number(m[4]) } : null;
}

/**
 * Decide from per-sample detections: a content box when all samples agree (within `tol` px), the
 * box is centred (bars symmetric within tolerance), trims ≥ 2% of the width or height, and keeps
 * ≥ 30% of both; else null.
 */
export function decideLetterbox(samples: readonly (ContentBox | null)[], width: number, height: number): ContentBox | null {
  if (samples.length === 0 || samples.some((s) => !s)) return null;
  const boxes = samples as ContentBox[];
  const tol = Math.max(4, Math.round(Math.min(width, height) * 0.006));
  const first = boxes[0]!;
  if (!boxes.every((b) => Math.abs(b.x - first.x) <= tol && Math.abs(b.y - first.y) <= tol && Math.abs(b.w - first.w) <= tol && Math.abs(b.h - first.h) <= tol)) return null;
  // Union of the samples (the largest picture area seen), clamped to the frame.
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)));
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)));
  const x2 = Math.min(width, Math.max(...boxes.map((b) => b.x + b.w)));
  const y2 = Math.min(height, Math.max(...boxes.map((b) => b.y + b.h)));
  const box = { x, y, w: x2 - x, h: y2 - y };
  const [left, right, top, bottom] = [box.x, width - box.x - box.w, box.y, height - box.y - box.h];
  const trimsW = left + right >= width * 0.02;
  const trimsH = top + bottom >= height * 0.02;
  if (!trimsW && !trimsH) return null;
  const symTolW = Math.max(8, width * 0.02);
  const symTolH = Math.max(8, height * 0.02);
  if (trimsW && Math.abs(left - right) > symTolW) return null;
  if (trimsH && Math.abs(top - bottom) > symTolH) return null;
  if (box.w < width * 0.3 || box.h < height * 0.3) return null;
  // Even dimensions keep the crop codec-friendly.
  return { x: box.x, y: box.y, w: box.w - (box.w % 2), h: box.h - (box.h % 2) };
}

/** Sample the clip and return its real picture area, or null when it has no baked-in bars. */
export async function detectLetterbox(path: string, info: { duration_sec: number; width: number; height: number }, opts: Pick<RunOptions, "tools" | "signal"> = {}): Promise<ContentBox | null> {
  if (!(info.duration_sec > 0 && info.width > 0 && info.height > 0)) return null;
  const samples: (ContentBox | null)[] = [];
  for (let i = 0; i < LETTERBOX_SAMPLES; i++) {
    const at = (info.duration_sec * (i + 0.5)) / LETTERBOX_SAMPLES;
    const len = Math.min(0.5, info.duration_sec / (LETTERBOX_SAMPLES * 2));
    try {
      const r = await runFfmpeg(
        ["-ss", at.toFixed(3), "-t", len.toFixed(3), "-i", path, "-map", "0:v:0", "-vf", `cropdetect=limit=${LETTERBOX_BLACK_LIMIT}:round=2:reset=0`, "-f", "null", "-"],
        { ...opts, keepStderr: true },
      );
      samples.push(parseCropdetect(r.stderr));
    } catch {
      samples.push(null);
    }
  }
  return decideLetterbox(samples, info.width, info.height);
}

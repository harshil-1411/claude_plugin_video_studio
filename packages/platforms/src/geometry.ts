import type { AspectRatio, NormalizedRect, PlatformContract, UiMask } from "@video-studio/schema";

/** A rectangle in pixels from the top-left corner. */
export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A UI mask tagged with the contract it came from. */
export interface TargetMask extends UiMask {
  target: string;
}

/** Normalized rect → pixel rect on a `width`×`height` frame (outer edges rounded outward). */
export function toPx(rect: NormalizedRect, width: number, height: number): PxRect {
  // Snap float noise (0.85 * 1080 = 917.9999…) before rounding outward.
  const snap = (n: number) => Math.round(n * 1e6) / 1e6;
  const x0 = Math.floor(snap(rect.x * width));
  const y0 = Math.floor(snap(rect.y * height));
  const x1 = Math.min(width, Math.ceil(snap((rect.x + rect.w) * width)));
  const y1 = Math.min(height, Math.ceil(snap((rect.y + rect.h) * height)));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Overlap of two rects, or null when they do not intersect. */
export function intersect(a: PxRect, b: PxRect): PxRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** The union of every enabled target's UI masks measured on `aspect` frames. */
export function masksFor(contracts: readonly PlatformContract[], aspect: AspectRatio): TargetMask[] {
  return contracts.flatMap((c) => c.ui_masks.filter((m) => m.aspect_ratio === aspect).map((m) => ({ ...m, target: c.id })));
}

/** Masks (from `masks`) that a pixel rect overlaps on a `width`×`height` frame, with the overlap. */
export function maskCollisions(
  rect: PxRect,
  masks: readonly TargetMask[],
  width: number,
  height: number,
): { mask: TargetMask; overlap: PxRect }[] {
  const out: { mask: TargetMask; overlap: PxRect }[] = [];
  for (const mask of masks) {
    const overlap = intersect(rect, toPx(mask.rect, width, height));
    if (overlap) out.push({ mask, overlap });
  }
  return out;
}

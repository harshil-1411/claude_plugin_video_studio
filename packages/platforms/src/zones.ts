import type { AspectRatio, PlatformContract } from "@video-studio/schema";
import { type PxRect, type TargetMask, masksFor } from "./geometry.js";

/**
 * Where things may go on a frame, for one render target and a set of platform contracts.
 * Renderers lay scene content inside `content`; the caption engine places captions inside
 * `caption`; lint checks placed text against `masks`.
 */
export interface LayoutZones {
  width: number;
  height: number;
  aspect_ratio: AspectRatio;
  /** Content-safe rectangle for scene graphics and text (design grid ∩ outside every error mask and the caption band). */
  content: PxRect;
  /** Region burned-in captions may occupy. */
  caption: PxRect;
  /** Preferred region for the hook headline. */
  hook: PxRect;
  /** UI masks of every enabled target for this aspect ratio, in normalized coords. */
  masks: TargetMask[];
  /** Contract ids the zones were computed from (empty: design grid only). */
  targets: string[];
  /** Bumped when the zone rules change pixels; part of the scene cache key. */
  version: number;
}

export const ZONES_VERSION = 1;

/**
 * Design-grid zones (v2 report §A universal production master), scaled from 1080×1920.
 * v1 ignores masks beyond reporting them; mask-aware shrinking is Phase 4 step 2 (agent A).
 */
export function layoutZones(
  target: { width: number; height: number; aspect_ratio: AspectRatio },
  contracts: readonly PlatformContract[] = [],
): LayoutZones {
  const { width: W, height: H } = target;
  const sx = (px: number) => Math.round((px / 1080) * W);
  const sy = (px: number) => Math.round((px / 1920) * H);
  const portrait = H / W >= 1.5;
  const rect = (x0: number, y0: number, x1: number, y1: number): PxRect => ({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  const content = portrait ? rect(sx(72), sy(180), sx(1008), sy(1240)) : rect(Math.round(W * 0.07), Math.round(H * 0.08), Math.round(W * 0.93), Math.round(H * 0.8));
  const caption = portrait ? rect(sx(90), sy(1260), sx(990), sy(1530)) : rect(Math.round(W * 0.08), Math.round(H * 0.8), Math.round(W * 0.92), Math.round(H * 0.94));
  const hook = portrait ? rect(sx(90), sy(180), sx(990), sy(600)) : rect(content.x, content.y, content.x + content.w, content.y + Math.round(content.h * 0.4));
  return {
    width: W,
    height: H,
    aspect_ratio: target.aspect_ratio,
    content,
    caption,
    hook,
    masks: masksFor(contracts, target.aspect_ratio),
    targets: contracts.map((c) => c.id),
    version: ZONES_VERSION,
  };
}

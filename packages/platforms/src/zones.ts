import type { AspectRatio, PlatformContract } from "@video-studio/schema";
import { type PxRect, type TargetMask, intersect, masksFor, toPx } from "./geometry.js";

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

/**
 * v1: design grid only. v2: content, caption and hook are shrunk away from every
 * `severity: error` mask of the enabled targets; non-portrait content ends at 74% of the height
 * (caption band 76–94%) so it clears a two-row caption at the bottom.
 */
export const ZONES_VERSION = 2;

/**
 * Smallest caption zone still worth using, as fractions of the frame: one caption line of
 * about 4% of the frame height, at half the design caption width. Below this the design caption
 * region is kept and lint reports the collision instead.
 */
const MIN_CAPTION_LINE = 0.04;
const MIN_CAPTION_WIDTH = 0.5;
/** Content smaller than this share of the design content area is not usable either. */
const MIN_CONTENT_SHARE = 0.25;

const rect = (x0: number, y0: number, x1: number, y1: number): PxRect => ({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
const area = (r: PxRect) => Math.max(0, r.w) * Math.max(0, r.h);

/**
 * Shrink `r` until it overlaps none of `blocks`. Each overlapping block is removed by cutting
 * one side of `r` (top, bottom, left or right), choosing the cut that keeps the most area;
 * ties prefer vertical cuts (keep full width for text). Blocks are handled largest overlap
 * first so a big footer is cut before a small rail. Returns null when nothing usable is left.
 */
export function shrinkAway(r: PxRect, blocks: readonly PxRect[]): PxRect | null {
  let cur: PxRect = { ...r };
  const pending = [...blocks];
  while (pending.length) {
    const hits = pending
      .map((b, i) => ({ b, i, o: intersect(cur, b) }))
      .filter((h): h is { b: PxRect; i: number; o: PxRect } => h.o !== null)
      .sort((a, b) => area(b.o) - area(a.o) || a.i - b.i);
    if (hits.length === 0) break;
    const { b, i } = hits[0]!;
    pending.splice(i, 1);
    const x1 = cur.x + cur.w;
    const y1 = cur.y + cur.h;
    const options = [
      rect(cur.x, cur.y, x1, Math.min(y1, b.y)), // keep the part above the block
      rect(cur.x, Math.max(cur.y, b.y + b.h), x1, y1), // below
      rect(cur.x, cur.y, Math.min(x1, b.x), y1), // left of it
      rect(Math.max(cur.x, b.x + b.w), cur.y, x1, y1), // right of it
    ].filter((o) => o.w > 0 && o.h > 0);
    if (options.length === 0) return null;
    cur = options.reduce((best, o) => (area(o) > area(best) ? o : best));
  }
  return cur;
}

/**
 * Layout zones for a target frame. Starts from the design grid (v2 report §A universal
 * production master, scaled from 1080×1920; percentage bands for non-portrait frames), then
 * shrinks each zone away from the enabled targets' `severity: error` UI masks:
 * - caption: the design caption region minus error masks; if that leaves less than one caption
 *   line (or half the width), the design region is kept and lint reports the collision;
 * - content: the design content rect minus error masks, kept above the caption zone;
 * - hook: the design hook region clipped to the content rect.
 * `warning` masks never move zones; lint reports them.
 */
export function layoutZones(
  target: { width: number; height: number; aspect_ratio: AspectRatio },
  contracts: readonly PlatformContract[] = [],
): LayoutZones {
  const { width: W, height: H } = target;
  const sx = (px: number) => Math.round((px / 1080) * W);
  const sy = (px: number) => Math.round((px / 1920) * H);
  const portrait = H / W >= 1.5;
  const designContent = portrait ? rect(sx(72), sy(180), sx(1008), sy(1240)) : rect(Math.round(W * 0.07), Math.round(H * 0.08), Math.round(W * 0.93), Math.round(H * 0.74));
  const designCaption = portrait ? rect(sx(90), sy(1260), sx(990), sy(1530)) : rect(Math.round(W * 0.08), Math.round(H * 0.76), Math.round(W * 0.92), Math.round(H * 0.94));
  const designHook = portrait ? rect(sx(90), sy(180), sx(990), sy(600)) : rect(designContent.x, designContent.y, designContent.x + designContent.w, designContent.y + Math.round(designContent.h * 0.4));

  const masks = masksFor(contracts, target.aspect_ratio);
  const blocks = masks.filter((m) => m.severity === "error").map((m) => toPx(m.rect, W, H));

  const cap = shrinkAway(designCaption, blocks);
  const caption = cap && cap.h >= Math.ceil(H * MIN_CAPTION_LINE) && cap.w >= designCaption.w * MIN_CAPTION_WIDTH ? cap : designCaption;

  // Content stays above the caption zone (the design grid already leaves a gap).
  const gap = Math.max(0, designCaption.y - (designContent.y + designContent.h));
  const contentBottom = Math.min(designContent.y + designContent.h, caption.y - gap);
  const bounded = rect(designContent.x, designContent.y, designContent.x + designContent.w, Math.max(designContent.y + 1, contentBottom));
  const shrunk = shrinkAway(bounded, blocks);
  const content = shrunk && area(shrunk) >= area(designContent) * MIN_CONTENT_SHARE ? shrunk : bounded;

  const hookClip = intersect(designHook, content);
  const hook = hookClip ?? rect(content.x, content.y, content.x + content.w, content.y + Math.round(content.h * 0.4));

  return {
    width: W,
    height: H,
    aspect_ratio: target.aspect_ratio,
    content,
    caption,
    hook,
    masks,
    targets: contracts.map((c) => c.id),
    version: ZONES_VERSION,
  };
}

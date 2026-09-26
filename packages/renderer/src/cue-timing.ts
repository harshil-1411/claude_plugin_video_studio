import type { ResolvedCue } from "./types.js";

/**
 * Word-cue timing shared by every renderer, so a cued item enters at the same moment everywhere.
 *
 * A cued item's entrance starts CUE_LEAD_S before its word: the eye reads a change slightly ahead
 * of the sound, so the item is landing as the word is heard. A stat's count-up instead finishes on
 * its word (`countUpWindow`).
 */
export const CUE_LEAD_S = 0.12;

/** Shortest count-up that still reads as counting. */
export const MIN_COUNT_UP_S = 0.4;

/**
 * Entrance start (scene-local seconds) of each reveal item. `defaults` are the renderer's own
 * stagger times per item (index = `cueItems` index); `step` is its stagger step.
 * - A cued item starts at max(0, at_s − CUE_LEAD_S).
 * - An uncued item keeps its default, but never enters before the last earlier-indexed cued item
 *   plus one step per item in between, so the reveal order holds.
 * Without cues the defaults come back unchanged (same array values).
 */
export function cueItemStarts(defaults: readonly number[], cues: readonly ResolvedCue[] | undefined, step: number): number[] {
  if (!cues?.length) return [...defaults];
  const at = new Map<number, number>();
  for (const c of cues) if (c.item >= 0 && c.item < defaults.length && !at.has(c.item)) at.set(c.item, c.at_s);
  const out: number[] = [];
  let lastCued: { index: number; start: number } | undefined;
  defaults.forEach((d, i) => {
    const cue = at.get(i);
    if (cue !== undefined) {
      const start = round3(Math.max(0, cue - CUE_LEAD_S));
      out.push(start);
      lastCued = { index: i, start };
    } else {
      out.push(lastCued ? round3(Math.max(d, lastCued.start + step * (i - lastCued.index))) : d);
    }
  });
  return out;
}

/**
 * Count-up window for a cued stat value: it finishes on the word. `defaultLen` is the renderer's
 * usual count length; the window starts no earlier than 0 and lasts at least MIN_COUNT_UP_S
 * (ending later than the word only when the word comes too early for that).
 */
export function countUpWindow(atS: number, defaultLen: number): { start: number; end: number } {
  const len = Math.max(MIN_COUNT_UP_S, defaultLen);
  const start = Math.max(0, atS - len);
  return { start: round3(start), end: round3(Math.max(atS, start + MIN_COUNT_UP_S)) };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

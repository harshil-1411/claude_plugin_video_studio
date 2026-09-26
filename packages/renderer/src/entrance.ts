/**
 * Scene opening, shared by the FFmpeg (and footage overlay) and HyperFrames renderers.
 *
 * Every element enters with a fade (and a slide or scale) from its start time, so a scene whose
 * first reveal starts at or after 0 opens on an empty background frame, which reads as a blank
 * flash at every hard cut. The elements of the scene's FIRST default reveal (the earliest default
 * start: typically item 0 plus the chrome drawn with it, like panels and titles) therefore start
 * their entrance before frame 0, at −openingLead(len): on frame 0 they are already about half-way
 * in, and they finish their entrance that much sooner. Everything later keeps its timing, and
 * items placed by a word cue keep exactly their cue timing (never pulled earlier).
 *
 * OPENING_LEAD_MAX_S = 0.2 s: half of the default FFmpeg fade (0.4 s), so with the renderer's
 * linear alpha the opening frame is exactly half-way in; the cap keeps a long entrance (a slow
 * style's enter_ms, HyperFrames' 0.5–0.6 s eased entrances) from looking already finished on the
 * first frame while still showing it clearly (an ease-out entrance is over half its travel at a
 * third of its length).
 */
export const OPENING_LEAD_MAX_S = 0.2;

/** How long before frame 0 an opening entrance of length `len` (s) starts: min(len / 2, 0.2 s). */
export function openingLead(len: number): number {
  return Math.round(Math.min(Math.max(0, len) / 2, OPENING_LEAD_MAX_S) * 1000) / 1000;
}

/** Start (s, ≤ 0) of an opening entrance of length `len`. */
export function openingStart(len: number): number {
  const lead = openingLead(len);
  return lead > 0 ? -lead : 0;
}

/** Two entrance times are the same moment (they come from the same arithmetic, up to rounding). */
export function sameTime(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

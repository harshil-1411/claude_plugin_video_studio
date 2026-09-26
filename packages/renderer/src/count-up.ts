import { countUpWindow } from "./cue-timing.js";

/**
 * Count-up of a numeric stat, shared by the HyperFrames and FFmpeg renderers so both show the same
 * intermediate values in the same time slots: COUNT_UP_FRAMES discrete values on an ease-out
 * (cubic) curve, each shown only inside its own slot, then the final value from `done` on.
 * Pure: formatting is left to the renderer (HyperFrames groups thousands, FFmpeg does not).
 */

/** Intermediate values before the final one. */
export const COUNT_UP_FRAMES = 8;
/** Default start of the count (scene-local seconds) when the value has no word cue. */
export const COUNT_UP_AT_S = 0.1;
/** A cued value's entrance starts this long before its count, so it is in place as the digits roll. */
export const COUNT_UP_ENTRANCE_LEAD_S = 0.05;

export interface CountUpStep {
  /** Value shown in this slot (rounded to the final value's decimals, at most 2). */
  value: number;
  /** Slot start (s). */
  start: number;
  /** Slot length (s); the slot is [start, start + len). */
  len: number;
}

export interface CountUp {
  steps: CountUpStep[];
  /** When the final value replaces the last step. */
  done: number;
}

/** Default length of a count-up in a scene of `durS` seconds. */
export function countUpSpan(durS: number): number {
  return Math.max(0.4, Math.min(1.2, durS * 0.35));
}

/**
 * Start and length of a count-up: by default it starts at COUNT_UP_AT_S and lasts `span`; with
 * a word cue (`cueAt`, scene-local s) it finishes on the word (`countUpWindow`).
 */
export function countUpTiming(span: number, cueAt?: number): { at: number; span: number } {
  if (cueAt === undefined) return { at: COUNT_UP_AT_S, span };
  const w = countUpWindow(cueAt, span);
  return { at: w.start, span: w.end - w.start };
}

/** Decimals a count-up keeps: those of the final value, at most 2. */
export function countUpDecimals(value: number): number {
  return Number.isInteger(value) ? 0 : Math.min(2, (String(value).split(".")[1] ?? "").length);
}

/** The steps of a count-up to `value` starting at `at` over `span` seconds. */
export function countUpSteps(value: number, at: number, span: number, frames = COUNT_UP_FRAMES): CountUp {
  const scale = 10 ** countUpDecimals(value);
  const dt = span / frames;
  const steps: CountUpStep[] = [];
  for (let k = 0; k < frames; k++) {
    const f = 1 - (1 - k / frames) ** 3;
    steps.push({ value: Math.round(value * f * scale) / scale, start: at + k * dt, len: dt });
  }
  return { steps, done: at + span };
}

/**
 * When the value's entrance starts before its count (the scene opening pulls it before frame 0),
 * the first step is shown from the entrance start, so the opening frame shows the first value
 * half-in instead of an empty slot. Otherwise the steps are returned as they are.
 */
export function withEarlyFirstStep(count: CountUp, entranceStart: number): CountUp {
  const first = count.steps[0];
  if (!first || entranceStart >= 0 || entranceStart >= first.start) return count;
  return { ...count, steps: [{ ...first, start: entranceStart, len: first.start + first.len - entranceStart }, ...count.steps.slice(1)] };
}

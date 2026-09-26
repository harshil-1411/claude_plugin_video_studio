import { describe, expect, it } from "vitest";
import { CUE_LEAD_S, countUpWindow, cueItemStarts } from "./cue-timing.js";

describe("cue timing", () => {
  const defaults = [0.1, 0.25, 0.4, 0.55];

  it("leaves defaults alone without cues", () => {
    expect(cueItemStarts(defaults, undefined, 0.15)).toEqual(defaults);
    expect(cueItemStarts(defaults, [], 0.15)).toEqual(defaults);
  });

  it("starts cued items just before their word and keeps later items in order", () => {
    const s = cueItemStarts(defaults, [{ item: 1, at_s: 1.2 }, { item: 3, at_s: 2.5 }], 0.15);
    expect(s[0]).toBe(0.1);
    expect(s[1]).toBeCloseTo(1.2 - CUE_LEAD_S);
    expect(s[2]).toBeCloseTo(1.2 - CUE_LEAD_S + 0.15); // uncued: never before the cue above it
    expect(s[3]).toBeCloseTo(2.5 - CUE_LEAD_S);
  });

  it("clamps at 0 and ignores out-of-range items", () => {
    expect(cueItemStarts(defaults, [{ item: 0, at_s: 0.05 }, { item: 9, at_s: 1 }], 0.15)[0]).toBe(0);
  });

  it("finishes a count-up on its word", () => {
    expect(countUpWindow(2, 0.8)).toEqual({ start: 1.2, end: 2 });
    expect(countUpWindow(0.1, 0.8)).toEqual({ start: 0, end: 0.4 });
  });
});

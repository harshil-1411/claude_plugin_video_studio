import { describe, expect, it } from "vitest";
import { motionBlurCost, motionBlurOptions, subframeOffsets, subframeTimes } from "./motion-blur.js";

describe("motion blur building block (not wired)", () => {
  it("plans centred sub-frame offsets inside a 180° shutter", () => {
    expect(subframeOffsets(3)).toEqual([-1 / 6, 0, 1 / 6].map((x) => Math.round(x * 1e9) / 1e9));
    expect(subframeOffsets(4)).toEqual([-0.1875, -0.0625, 0.0625, 0.1875]);
    for (const n of [3, 4, 5, 6]) {
      const o = subframeOffsets(n);
      expect(o).toHaveLength(n);
      expect(Math.abs(o.reduce((a, b) => a + b, 0))).toBeLessThan(1e-9);
      expect(Math.max(...o.map(Math.abs))).toBeLessThan(0.25);
    }
  });

  it("clamps the count to 3–6", () => {
    expect(subframeOffsets(1)).toHaveLength(3);
    expect(subframeOffsets(12)).toHaveLength(6);
    expect(subframeOffsets(Number.NaN)).toHaveLength(3);
  });

  it("gives seek times around the frame instant, never before 0", () => {
    expect(subframeTimes(30, 30, 3)).toEqual([0.994444444, 1, 1.005555556]);
    expect(subframeTimes(0, 30, 3)[0]).toBe(0);
  });

  it("maps to the producer's native options with a fixed count and a centred window", () => {
    expect(motionBlurOptions(5)).toEqual({ samplesPerFrame: 5, shutterAngle: 180, shutterPhase: -90, blend: "srgb" });
    expect(motionBlurOptions(9, 90)).toEqual({ samplesPerFrame: 6, shutterAngle: 90, shutterPhase: -45, blend: "srgb" });
  });

  it("costs seconds × fps × subframes browser captures", () => {
    expect(motionBlurCost(10, 30, 4)).toEqual({ frames: 300, captures: 1200, factor: 4 });
  });
});

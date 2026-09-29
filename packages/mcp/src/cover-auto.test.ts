import { describe, expect, it } from "vitest";
import { COVER_MIN_HOLD_MS, type CoverScene, autoCoverTime } from "./cover.js";
import { HOLD_MIN_S, holdSpans } from "./motion-timing.js";

/** Difference-energy samples at 10 fps: `moving` intervals at 5, else 0 (still). */
function energy(n: number, moving: (i: number) => boolean) {
  return Array.from({ length: n }, (_, i) => ({ t: Math.round((i + 1) * 100) / 1000, y: moving(i) ? 5 : 0 }));
}

describe("holdSpans", () => {
  it("returns the still stretches on the video clock, at least HOLD_MIN_S long", () => {
    // Intervals 0–2 move, 3–12 still (1 s), 13 moves, 14–15 still (0.2 s: too short), 16–19 move.
    const s = energy(20, (i) => i <= 2 || i === 13 || i >= 16);
    // Interval 3 joins frame 3 (t 0.3) to frame 4; interval 12 ends on frame 13 (t 1.3).
    expect(holdSpans(s)).toEqual([{ start_ms: 300, end_ms: 1300 }]);
    expect(HOLD_MIN_S).toBeLessThanOrEqual(1);
  });

  it("finds a hold that runs to the end, and none between entrances closer than HOLD_MIN_S", () => {
    expect(holdSpans(energy(10, (i) => i < 4))).toEqual([{ start_ms: 400, end_ms: 1000 }]);
    expect(holdSpans(energy(12, (i) => i % 3 === 0))).toEqual([]);
    expect(holdSpans([])).toEqual([]);
  });
});

describe("autoCoverTime", () => {
  const frame = 1000 / 30;
  const scenes: CoverScene[] = [
    { start_ms: 0, duration_ms: 2000, purpose: "hook" },
    { start_ms: 2000, duration_ms: 3000, purpose: "point", transition_ms: 400 },
    { start_ms: 5000, duration_ms: 2000, purpose: "cta", transition_ms: 400 },
  ];

  it("prefers the longest settled hold inside the hook, at its midpoint", () => {
    const holds = [
      { start_ms: 600, end_ms: 1000 },
      { start_ms: 1100, end_ms: 1900 },
      { start_ms: 2600, end_ms: 4900 },
    ];
    expect(autoCoverTime(holds, scenes, frame)).toBe(1500);
  });

  it("falls back to the payoff/cta scene, then to any scene", () => {
    const tail = [
      { start_ms: 2600, end_ms: 4900 },
      { start_ms: 5600, end_ms: 6500 },
    ];
    expect(autoCoverTime(tail, scenes, frame)).toBe(6050);
    expect(autoCoverTime([{ start_ms: 2600, end_ms: 4900 }], scenes, frame)).toBe(3750);
  });

  it("skips each scene's first 0.5 s (or a longer incoming transition) and its last frame", () => {
    // A hold spanning the hook→point join is cut at the point scene's entrance.
    const across = [{ start_ms: 1200, end_ms: 3000 }];
    const t = autoCoverTime(across, scenes, frame)!;
    expect(t).toBe(Math.round((1200 + 2000 - frame) / 2));
    // A 1.2 s transition into the point scene pushes the window to 3.2 s.
    const long: CoverScene[] = [{ start_ms: 0, duration_ms: 2000, purpose: "problem" }, { start_ms: 2000, duration_ms: 3000, purpose: "point", transition_ms: 1200 }];
    expect(autoCoverTime([{ start_ms: 2000, end_ms: 4000 }], long, frame)).toBe(3600);
  });

  it("returns null when no hold keeps COVER_MIN_HOLD_MS after trimming", () => {
    expect(autoCoverTime([], scenes, frame)).toBeNull();
    // Only inside the hook's first 0.5 s.
    expect(autoCoverTime([{ start_ms: 0, end_ms: 450 }], scenes, frame)).toBeNull();
    expect(autoCoverTime([{ start_ms: 600, end_ms: 600 + COVER_MIN_HOLD_MS - 1 }], scenes, frame)).toBeNull();
  });
});

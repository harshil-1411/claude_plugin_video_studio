import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { MOTION_KIT_SOURCE, MOTION_KIT_VERSION } from "./motion-kit.js";

interface Kit {
  version: string;
  spring(t: number, o?: Record<string, number>): number;
  springs(t: number, from: number, steps: Array<{ at: number; to: number }>, o?: Record<string, number>): number;
  easeInOut(p: number): number;
  easeOut(p: number): number;
  tween(t: number, start: number, dur: number, from: number, to: number): number;
  lerp(a: number, b: number, p: number): number;
  clamp(x: number, lo: number, hi: number): number;
  stagger(i: number, step: number, start?: number): number;
  rng(seed: number | string): () => number;
  beatAt(t: number): number | null;
  downbeatAt(t: number): number | null;
  beatIndex(t: number): number;
  energy(t: number): number;
  bass(t: number): number;
  onset(t: number): number;
  revealAt(i: number): number;
}

/** Evaluate the kit in a fresh context, as the page does (`window.vs`). */
function kit(vsData: Record<string, unknown> = {}): Kit {
  const window: Record<string, unknown> = { __vs: vsData };
  runInNewContext(MOTION_KIT_SOURCE, { window });
  return window.vs as Kit;
}

describe("motion kit", () => {
  it("exposes its version", () => {
    expect(kit().version).toBe(MOTION_KIT_VERSION);
    expect(MOTION_KIT_SOURCE).not.toMatch(/Math\.random|Date\.now|performance\.now|setTimeout|setInterval|requestAnimationFrame/);
  });

  it("spring: starts at from, settles to exactly to, for under-, critically and over-damped springs", () => {
    const vs = kit();
    for (const damping of [8, 20, 26, 40]) {
      const o = { from: 10, to: 110, stiffness: 100, damping, mass: 1 };
      expect(vs.spring(0, o)).toBe(10);
      expect(vs.spring(-1, o)).toBe(10);
      expect(vs.spring(20, o), `damping ${damping}`).toBe(110);
      const mid = vs.spring(0.2, o);
      expect(mid).toBeGreaterThan(10);
    }
    // Under-damped: overshoots before settling.
    const wobble = { from: 0, to: 1, stiffness: 200, damping: 8 };
    const peak = Math.max(...Array.from({ length: 100 }, (_, i) => vs.spring(i / 50, wobble)));
    expect(peak).toBeGreaterThan(1);
    // Delay holds `from` until it starts.
    expect(vs.spring(0.5, { from: 3, to: 4, delay: 1 })).toBe(3);
  });

  it("spring: a pure function of t (any seek order gives the same value)", () => {
    const vs = kit();
    const o = { from: 0, to: 1, stiffness: 170, damping: 12 };
    const times = [0.1, 0.7, 0.3, 2, 0.1, 0.7];
    const values = times.map((t) => vs.spring(t, o));
    expect(values[0]).toBe(values[4]);
    expect(values[1]).toBe(values[5]);
    expect(kit().spring(0.3, o)).toBe(values[2]);
  });

  it("springs: sums one spring per target change and ends on the last target", () => {
    const vs = kit();
    const steps = [
      { at: 0, to: 1 },
      { at: 1, to: 3 },
      { at: 2, to: 2 },
    ];
    expect(vs.springs(0, 0, steps)).toBe(0);
    expect(vs.springs(0.99, 0, steps)).toBeCloseTo(1, 2);
    expect(vs.springs(30, 0, steps)).toBe(2);
  });

  it("easings, tween, lerp, clamp and stagger", () => {
    const vs = kit();
    expect(vs.easeInOut(0)).toBe(0);
    expect(vs.easeInOut(1)).toBe(1);
    expect(vs.easeInOut(0.5)).toBeCloseTo(0.5);
    expect(vs.easeOut(2)).toBe(1);
    expect(vs.tween(0.5, 0, 1, 0, 100)).toBeCloseTo(50);
    expect(vs.tween(5, 0, 1, 0, 100)).toBe(100);
    expect(vs.lerp(2, 4, 0.5)).toBe(3);
    expect(vs.clamp(5, 0, 1)).toBe(1);
    expect(vs.stagger(3, 0.1, 0.5)).toBeCloseTo(0.8);
  });

  it("rng: the same seed repeats the same sequence; different seeds differ", () => {
    const vs = kit();
    const seq = (s: number | string) => {
      const r = vs.rng(s);
      return Array.from({ length: 5 }, () => r());
    };
    expect(seq(42)).toEqual(seq(42));
    const fresh = kit().rng("title");
    expect(seq("title")).toEqual(Array.from({ length: 5 }, () => fresh()));
    expect(seq(42)).not.toEqual(seq(43));
    for (const x of seq(7)) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("beat helpers read the scene-local grid from window.__vs", () => {
    const vs = kit({ beats: [0.25, 0.75, 1.25, 1.75], downbeats: [0.25, 1.25] });
    expect(vs.beatAt(0.1)).toBeNull();
    expect(vs.beatIndex(0.1)).toBe(-1);
    expect(vs.beatAt(0.25)).toBe(0.25);
    expect(vs.beatAt(1.3)).toBe(1.25);
    expect(vs.beatIndex(1.3)).toBe(2);
    expect(vs.downbeatAt(1.2)).toBe(0.25);
    expect(vs.downbeatAt(9)).toBe(1.25);
    // No grid: no beats.
    expect(kit().beatAt(5)).toBeNull();
  });

  it("audio helpers: 0..1, linear between frames, pure; 0 without a bed", () => {
    const b64 = (xs: number[]) => Buffer.from(xs).toString("base64");
    const audio = { fps: 10, rms: b64([0, 255, 51, 0]), low: b64([255, 0, 0, 0]), onset: b64([0, 0, 255, 0]) };
    const vs = kit({ audio });
    expect(vs.energy(0)).toBe(0);
    expect(vs.energy(0.1)).toBe(1);
    expect(vs.energy(0.05)).toBeCloseTo(0.5);
    expect(vs.energy(0.15)).toBeCloseTo(0.6);
    expect(vs.bass(0)).toBe(1);
    expect(vs.bass(0.05)).toBeCloseTo(0.5);
    expect(vs.onset(0.2)).toBe(1);
    expect(vs.onset(99)).toBe(0);
    expect(vs.energy(-1)).toBe(0);
    // Any call order gives the same values (the lazy decode is invisible).
    const times = [0.15, 0.05, 0.3, 0.15, 0.05];
    const a = times.map((t) => vs.energy(t));
    expect(a[0]).toBe(a[3]);
    expect(a[1]).toBe(a[4]);
    expect(kit({ audio }).energy(0.05)).toBe(a[1]);
    for (const k of [kit(), kit({ audio: { fps: 0, rms: "", low: "", onset: "" } })]) {
      expect(k.energy(1)).toBe(0);
      expect(k.bass(1)).toBe(0);
      expect(k.onset(1)).toBe(0);
    }
  });

  it("revealAt reads window.__vs.reveals; always a number", () => {
    const vs = kit({ reveals: [0, 1.5, 3] });
    expect(vs.revealAt(0)).toBe(0);
    expect(vs.revealAt(2)).toBe(3);
    expect(vs.revealAt(7)).toBe(3);
    expect(kit().revealAt(1)).toBe(0);
  });
});

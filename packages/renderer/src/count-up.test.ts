import { describe, expect, it } from "vitest";
import type { Scene } from "@video-studio/schema";
import { COUNT_UP_AT_S, COUNT_UP_FRAMES, countUpSpan, countUpSteps, countUpTiming, withEarlyFirstStep } from "./count-up.js";
import { countUpWindow } from "./cue-timing.js";
import { openingStart } from "./entrance.js";
import { buildFilterGraph, composeScene, countX, motionTiming } from "./ffmpeg-renderer.js";
import { buildComposition } from "./hyperframes-compose.js";
import { resolveTokens, targetForAspect } from "./tokens.js";
import type { RenderTarget, ResolvedCue } from "./types.js";

const target: RenderTarget = targetForAspect("9:16", { shortSide: 180, fps: 15 });
const tokens = resolveTokens();
const FONTS = { heading: "/f/h.ttf", body: "/f/b.ttf", mono: "/f/m.ttf" };
const DUR = 3;

function scene(props: Record<string, unknown>, duration = DUR): Scene {
  return {
    id: "s01",
    duration_sec: duration,
    purpose: "point",
    voiceover: "",
    visual_strategy: "motion_graphic",
    deterministic: { kind: "stat", props },
    visual_requirements: { continuity_refs: [] },
    claim_refs: [],
  };
}

/** The count-up drawtexts of an FFmpeg stat: each value (from its text file) and its enable window. */
function ffmpegCount(props: Record<string, unknown>, cues?: ResolvedCue[], duration = DUR) {
  const comp = composeScene(scene(props, duration), target, tokens);
  const g = buildFilterGraph(comp, target, duration, FONTS, "/tmp/x", cues ? { cues } : {});
  const draws = g.filtergraph
    .split(/[,;](?=(?:\[[^\]]*\])?drawtext=)/)
    .map((d) => d.replace(/^\[[^\]]*\]/, ""))
    .filter((d) => d.startsWith("drawtext="));
  const text = (d: string) => g.textFiles.get(/textfile=\/tmp\/x\/(t\d+\.txt)/.exec(d)![1]!)!;
  const slots = draws.flatMap((d) => {
    const m = /enable=gte\(t\\,(-?[\d.]+)\)\*lt\(t\\,(-?[\d.]+)\)/.exec(d);
    return m ? [{ value: text(d), start: Number(m[1]), end: Number(m[2]), x: /:x=([^:]+):/.exec(d)![1]! }] : [];
  });
  const final = draws.map((d) => ({ d, m: /enable=gte\(t\\,(-?[\d.]+)\)(?:[:,\]]|$)/.exec(d) })).find(({ m }) => m);
  return { comp, g, draws, text, slots, done: final ? Number(final.m![1]) : undefined, finalText: final ? text(final.d) : undefined };
}

/** `--t`/`--d` of every HyperFrames count frame. */
function hyperframesCount(props: Record<string, unknown>, cues?: ResolvedCue[], duration = DUR) {
  const html = buildComposition({ scene: scene(props, duration), target, tokens, out_path: "/o.mp4", project_dir: "/p", ...(cues ? { cues } : {}) }).html;
  return [...html.matchAll(/vs-count-frame vs-a vs-flash" style="--t:(-?[\d.]+)s;--d:([\d.]+)s">([^<]*)</g)].map((m) => ({ start: Number(m[1]), len: Number(m[2]), value: m[3]! }));
}

describe("count-up: shared values and slots", () => {
  it("has 8 ease-out steps in equal slots, then the final value", () => {
    const c = countUpSteps(40, 0.1, 0.8);
    expect(c.steps).toHaveLength(COUNT_UP_FRAMES);
    expect(c.steps.map((s) => s.value)).toEqual([0, 13, 23, 30, 35, 38, 39, 40]);
    c.steps.forEach((s, k) => {
      expect(s.start).toBeCloseTo(0.1 + k * 0.1, 9);
      expect(s.len).toBeCloseTo(0.1, 9);
    });
    expect(c.done).toBeCloseTo(0.9, 9);
    // Decimals follow the final value (at most 2).
    expect(countUpSteps(2.5, 0, 1).steps.map((s) => s.value)).toEqual([0, 0.8, 1.4, 1.9, 2.2, 2.4, 2.5, 2.5]);
    expect(countUpSteps(1.234, 0, 1).steps.every((s) => Math.round(s.value * 100) === s.value * 100)).toBe(true);
  });

  it("starts at 0.1 s by default and finishes on a word cue", () => {
    expect(countUpTiming(1.05)).toEqual({ at: COUNT_UP_AT_S, span: 1.05 });
    const w = countUpWindow(2, 1.05);
    const t = countUpTiming(1.05, 2);
    expect(t.at).toBe(w.start);
    expect(t.at + t.span).toBeCloseTo(2, 9);
    expect(countUpSpan(3)).toBeCloseTo(1.05, 9);
    expect(countUpSpan(10)).toBe(1.2);
  });

  it("extends only the first slot back to an early (opening) entrance", () => {
    const c = countUpSteps(40, 0.1, 0.8);
    expect(withEarlyFirstStep(c, 0.05)).toBe(c);
    const e = withEarlyFirstStep(c, -0.2);
    expect(e.steps[0]!.start).toBe(-0.2);
    expect(e.steps[0]!.start + e.steps[0]!.len).toBeCloseTo(0.2, 9);
    expect(e.steps.slice(1)).toEqual(c.steps.slice(1));
  });
});

describe("count-up: FFmpeg renderer", () => {
  it("draws the 8 values in the same slots as HyperFrames, then the final value", () => {
    const props = { value: 40, unit: "%", label: "faster" };
    const ff = ffmpegCount(props);
    const hf = hyperframesCount(props);
    expect(ff.slots.map((s) => s.value)).toEqual(["0", "13", "23", "30", "35", "38", "39", "40"]);
    expect(hf.map((s) => s.value)).toEqual(ff.slots.map((s) => s.value));
    ff.slots.forEach((s, k) => {
      expect(s.start, `slot ${k}`).toBeCloseTo(hf[k]!.start, 3);
      // HyperFrames rounds --t and --d separately: its slot end can be 1 ms off.
      expect(Math.abs(s.end - (hf[k]!.start + hf[k]!.len)), `slot ${k}`).toBeLessThanOrEqual(0.0011);
      if (k > 0) expect(s.start).toBeCloseTo(ff.slots[k - 1]!.end, 3);
    });
    // The value opens the scene: its first slot starts with its early entrance.
    const { fade } = motionTiming(DUR, 2);
    expect(ff.slots[0]!.start).toBe(openingStart(fade));
    expect(ff.slots[1]!.start).toBeCloseTo(COUNT_UP_AT_S + countUpSpan(DUR) / COUNT_UP_FRAMES, 3);
    expect(ff.done).toBeCloseTo(COUNT_UP_AT_S + countUpSpan(DUR), 3);
    expect(ff.finalText).toBe("40");
    // The unit is its own element, drawn from the value's entrance on.
    expect(ff.draws.filter((d) => ff.text(d) === "%")).toHaveLength(1);
    expect(ff.draws.find((d) => ff.text(d) === "%")!.split(/(?<!\\),/)[0]).not.toContain("enable=");
  });

  it("finishes the count on the value's word cue, as HyperFrames does", () => {
    const props = { value: 1234, label: "users" };
    const cues = [{ item: 0, at_s: 2 }];
    const ff = ffmpegCount(props, cues, 6);
    const hf = hyperframesCount(props, cues, 6);
    expect(ff.slots).toHaveLength(8);
    expect(ff.slots.at(-1)!.end).toBeCloseTo(2, 3);
    expect(ff.done).toBeCloseTo(2, 3);
    ff.slots.forEach((s, k) => {
      expect(s.start).toBeCloseTo(hf[k]!.start, 3);
      expect(Math.abs(s.end - (hf[k]!.start + hf[k]!.len))).toBeLessThanOrEqual(0.0011);
    });
    // The cued count keeps its cue timing: nothing is pulled into the opening.
    expect(ff.slots[0]!.start).toBeCloseTo(countUpWindow(2, 1.2).start, 3);
  });

  it("keeps the unit put: the digits end at the unit's left edge, a wider intermediate never reaches it", () => {
    const ff = ffmpegCount({ value: 1, unit: "package" });
    const digits = ff.comp.elements.find((e) => e.type === "text" && e.count !== undefined)!;
    const unit = ff.comp.elements.find((e) => e.type === "text" && e.text === " package")!; // word units carry their space (spacedUnit)
    if (digits.type !== "text" || unit.type !== "text") throw new Error("no count");
    expect(digits.rx).toBe(unit.x);
    expect(digits.cx).toBeUndefined();
    // "0" (wider than "1" in most fonts) ends at the unit's edge, exactly where the final "1" ends.
    expect(ff.slots[0]!.value).toBe("0");
    expect(ff.slots[0]!.x).toBe(`${unit.x}-text_w`);
    expect(ff.draws.find((d) => d.includes(`enable=gte(t\\,${ff.done})`))).toContain(`:x=${unit.x}-text_w:`);
    // Shorter intermediates are centred in the final digits' box (width per character), still before the unit.
    expect(countX({ x: 0, rx: 100 }, "5", "40")).toBe("100-text_w*1.5");
    expect(countX({ x: 0, rx: 100 }, "13", "40")).toBe("100-text_w");
    expect(countX({ x: 0, rx: 100 }, "999", "1000")).toBe("100-text_w*1.1667");
    // Never past the unit: the factor is at least 1 even for a longer intermediate.
    expect(countX({ x: 0, rx: 100 }, "0.8", "2")).toBe("100-text_w");
  });

  it("centres every value on the line without a unit", () => {
    const ff = ffmpegCount({ value: 250 });
    const digits = ff.comp.elements.find((e) => e.type === "text" && e.count !== undefined)!;
    if (digits.type !== "text") throw new Error("no count");
    expect(digits.cx).toBeDefined();
    expect(new Set(ff.slots.map((s) => s.x))).toEqual(new Set([`${digits.cx}-text_w/2`]));
  });

  it("draws non-numeric and zero values as they are", () => {
    for (const value of ["N/A", "3x", 0]) {
      const ff = ffmpegCount({ value, unit: "%" });
      expect(ff.slots, String(value)).toEqual([]);
      expect(ff.comp.elements.some((e) => e.type === "text" && e.count !== undefined)).toBe(false);
      expect(ff.draws.filter((d) => /enable=gte\(t\\,[\d.]+\)\*lt/.test(d))).toEqual([]);
    }
  });
});

describe("units after a number", () => {
  it("attaches symbols and abbreviations, spaces word units", async () => {
    const { spacedUnit } = await import("./ffmpeg-renderer.js");
    expect(["%", "x", "ms", "k", "", " keys", "packages", "users", "per day", "GB"].map((u) => `12${spacedUnit(u)}`)).toEqual([
      "12%",
      "12x",
      "12ms",
      "12k",
      "12",
      "12 keys",
      "12 packages",
      "12 users",
      "12 per day",
      "12GB",
    ]);
  });
});

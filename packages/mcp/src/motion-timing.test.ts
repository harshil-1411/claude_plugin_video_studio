import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findStylesDir, getStyle, resolveTokens, styleRef } from "@video-studio/renderer";
import { FormatGrammar, Style, parseYamlOrJson } from "@video-studio/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeVideo } from "./analyze.js";
import { classifyEasing, measureMotionTiming, motionTimingFrom, splitOverlaps, styleFromMotion, styleYaml } from "./motion-timing.js";

/**
 * Synthetic references (320x180, 30 fps, ≤ 3 s, x264 ultrafast): white boxes on a dark ground that
 * enter with a known curve at known times. Tolerances: one frame interval at 30 fps (±34 ms) on
 * stagger, two (±67 ms) on entrance durations (the last ~2 % of an ease-out tail moves less than
 * a pixel at 160 px analysis width and reads as still).
 */
const FPS = 30;
const FRAME_MS = 1000 / FPS;
let dir: string;

function ff(args: string[]): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

/** Progress 0→1 between t0 and t0+d (ffmpeg expression). */
const p = (t0: number, d: number) => `min(max((t-${t0})/${d}\\,0)\\,1)`;
const easeOut = (t0: number, d: number) => `(1-pow(1-${p(t0, d)}\\,3))`;
const easeInOut = (t0: number, d: number) => `(0.5-0.5*cos(3.14159*${p(t0, d)}))`;
/** Damped spring: overshoots ~40 % and settles back. */
const spring = (t0: number, d: number) => `(1-exp(-5*${p(t0, d)})*cos(7.85*${p(t0, d)}))`;

/** Boxes entering along x: [x-expression, y] each, overlaid in order. */
function clip(name: string, boxes: Array<[string, number] | [string, number, string]>, size = "80x50"): string {
  const inputs = ["-f", "lavfi", "-i", `color=c=0x202020:size=320x180:rate=${FPS}:duration=3`, "-f", "lavfi", "-i", `color=c=white:size=${size}:rate=${FPS}:duration=3`];
  const chain = boxes
    .map(([x, y, enable], i) => `${i === 0 ? "[0]" : `[v${i}]`}[1]overlay=x='${x}':y=${y}${enable ? `:enable='${enable}'` : ""}${i === boxes.length - 1 ? ",format=yuv420p" : `[v${i + 1}]`}`)
    .join(";");
  const out = join(dir, `${name}.mp4`);
  ff([...inputs, "-filter_complex", chain, "-c:v", "libx264", "-preset", "ultrafast", out]);
  return out;
}

const clips: Record<string, string> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vs-motion-"));
  // Three separate 300 ms ease-out entrances, 0.9 s apart (not a burst).
  clips.easeOut = clip("ease-out", [
    [`10+200*${easeOut(0.3, 0.3)}`, 5],
    [`10+200*${easeOut(1.2, 0.3)}`, 65],
    [`10+200*${easeOut(2.1, 0.3)}`, 125],
  ]);
  // Two 600 ms springs.
  clips.spring = clip("spring", [
    [`10+150*${spring(0.3, 0.6)}`, 20],
    [`10+150*${spring(1.6, 0.6)}`, 100],
  ]);
  // Two 500 ms ease-in-out moves.
  clips.inOut = clip("in-out", [
    [`10+150*${easeInOut(0.3, 0.5)}`, 20],
    [`10+150*${easeInOut(1.6, 0.5)}`, 100],
  ]);
  // Hard appearances in one frame.
  clips.snap = clip("snap", [
    ["40", 20, "gte(t,1)"],
    ["200", 100, "gte(t,2)"],
  ]);
  // Four 150 ms ease-out entrances staggered by 250 ms.
  clips.stagger = clip(
    "stagger",
    [0.5, 0.75, 1.0, 1.25].map((t0, i) => [`10+120*${easeOut(t0, 0.15)}`, 5 + i * 44] as [string, number]),
    "60x36",
  );
  // Overlapping: 200 ms ease-out entrances staggered by 150 ms.
  clips.overlap = clip(
    "overlap",
    [0.5, 0.65, 0.8, 0.95].map((t0, i) => [`10+120*${easeOut(t0, 0.2)}`, 5 + i * 44] as [string, number]),
    "60x36",
  );
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("motion timing: pure helpers", () => {
  it("classifies curve shapes", () => {
    expect(classifyEasing([9])).toBe("snap");
    expect(classifyEasing([12, 12, 11, 7.5, 5.6, 3.1, 1.3, 0.6, 0.6])).toBe("ease_out");
    expect(classifyEasing([2.8, 3.8, 4.7, 5.6, 6.6, 7.5, 7.5, 7.5, 6.6, 5.6, 4.7, 3.8, 2.8])).toBe("ease_in_out");
    expect(classifyEasing([21.5, 22.4, 17.8, 12.2, 5.6, 1.9, 1.9, 2.8, 2.8, 2.8, 1.9, 1.0])).toBe("spring");
    expect(classifyEasing([4.7, 3.8, 4.7, 4.7, 4.7, 4.7, 4.7, 4.7, 5.6, 4.7])).toBe("linear");
  });

  it("splits overlapping entrances of similar height, but not a small rebound", () => {
    // Two similar humps with a deep valley between them.
    expect(splitOverlaps([2, 8, 6, 3, 1, 3, 7, 5, 2])).toEqual([
      [0, 4],
      [5, 8],
    ]);
    // A spring rebound: 13 % of the main hump.
    expect(splitOverlaps([21, 22, 18, 12, 6, 2, 2, 3, 3, 2, 1])).toEqual([[0, 10]]);
  });

  it("returns nulls below the minimum number of changes", () => {
    const flat = Array.from({ length: 60 }, (_, i) => ({ t: i / 30, y: 0 }));
    const one = flat.map((s, i) => (i === 30 ? { ...s, y: 20 } : s));
    const m = motionTimingFrom(one).timing;
    expect(m.changes_analyzed).toBe(1);
    expect(m.enter_ms_median).toBeNull();
    expect(m.easing).toBeNull();
    expect(m.easing_share).toBeNull();
    expect(m.stagger_ms_median).toBeNull();
    expect(m.holds.count).toBe(2);
    expect(motionTimingFrom(flat).timing).toMatchObject({ changes_analyzed: 0, holds: { count: 1, longest_ms: 2000 } });
  });
});

describe("motion timing: synthetic references", () => {
  it("ease-out entrances: class, ~300 ms entrances, no stagger, holds between", async () => {
    const m = await measureMotionTiming(clips.easeOut!);
    expect(m.changes.map((c) => c.easing)).toEqual(["ease_out", "ease_out", "ease_out"]);
    expect(m.timing).toMatchObject({ changes_analyzed: 3, easing: "ease_out", easing_share: 1, stagger_ms_median: null });
    expect(Math.abs(m.timing.enter_ms_median! - 300)).toBeLessThanOrEqual(2 * FRAME_MS + 1);
    // Onsets within one frame of 0.3, 1.2, 2.1 s.
    m.changes.forEach((c, i) => expect(Math.abs(c.start_sec - [0.3, 1.2, 2.1][i]!)).toBeLessThanOrEqual(1 / FPS + 0.001));
    // Stills: 0–0.3, 0.6–1.2, 1.5–2.1, 2.4–3.0 s.
    expect(m.timing.holds.count).toBe(4);
    expect(Math.abs(m.timing.holds.longest_ms! - 600)).toBeLessThanOrEqual(2 * FRAME_MS + 1);
  });

  it("an overshooting move reads as spring", async () => {
    const m = await measureMotionTiming(clips.spring!);
    expect(m.timing).toMatchObject({ changes_analyzed: 2, easing: "spring", easing_share: 1 });
    expect(m.timing.enter_ms_median!).toBeGreaterThan(400);
    expect(m.timing.enter_ms_median!).toBeLessThanOrEqual(600 + 2 * FRAME_MS);
  });

  it("a symmetric move reads as ease_in_out", async () => {
    const m = await measureMotionTiming(clips.inOut!);
    expect(m.timing).toMatchObject({ changes_analyzed: 2, easing: "ease_in_out", easing_share: 1 });
    // The slow sub-pixel ends of an ease-in-out read as still: up to one frame short at each end.
    expect(Math.abs(m.timing.enter_ms_median! - 500)).toBeLessThanOrEqual(3 * FRAME_MS + 1);
  });

  it("a one-frame appearance reads as snap", async () => {
    const m = await measureMotionTiming(clips.snap!);
    expect(m.timing).toMatchObject({ changes_analyzed: 2, easing: "snap", easing_share: 1, enter_ms_median: Math.round(FRAME_MS) });
  });

  it("staggered entrances: the median gap between onsets", async () => {
    const m = await measureMotionTiming(clips.stagger!);
    expect(m.timing.changes_analyzed).toBe(4);
    expect(m.timing.easing).toBe("ease_out");
    expect(Math.abs(m.timing.stagger_ms_median! - 250)).toBeLessThanOrEqual(FRAME_MS + 1);
    expect(Math.abs(m.timing.enter_ms_median! - 150)).toBeLessThanOrEqual(2 * FRAME_MS + 1);
  });

  it("overlapping staggered entrances are split at the valleys between them", async () => {
    const m = await measureMotionTiming(clips.overlap!);
    expect(m.timing.changes_analyzed).toBe(4);
    expect(Math.abs(m.timing.stagger_ms_median! - 150)).toBeLessThanOrEqual(FRAME_MS + 1);
    // Each entrance keeps only its own part of the overlap, so durations run short; the class holds.
    expect(m.timing.easing).toBe("ease_out");
  });
});

describe("analyze: motion_timing and write_style", () => {
  it("writes motion_timing into qa/analysis.{json,md} and a style pack that getStyle finds", async () => {
    const project = await mkdtemp(join(tmpdir(), "vs-motion-proj-"));
    try {
      const g = await analyzeVideo(clips.easeOut!, { projectDir: project, writeStyle: "ref-measured" });
      expect(g.motion_timing?.easing).toBe("ease_out");
      const saved = FormatGrammar.parse(JSON.parse(readFileSync(join(project, "qa", "analysis.json"), "utf8")));
      expect(saved.motion_timing).toEqual(g.motion_timing);
      expect(readFileSync(join(project, "qa", "analysis.md"), "utf8")).toMatch(/## Motion timing[\s\S]*\*\*ease_out\*\*/);

      const file = join(project, "styles", "ref-measured.yaml");
      const parsed = parseYamlOrJson(Style, readFileSync(file, "utf8"));
      expect(parsed.ok).toBe(true);
      const style = await getStyle(findStylesDir(), "ref-measured", project);
      expect(style.description).toBe("measured from a reference; structure only");
      expect(style.motion.easing).toBe("ease_out");
      expect(style.motion.enter_ms % 10).toBe(0);
      expect(Math.abs(style.motion.enter_ms - 300)).toBeLessThanOrEqual(70);
      expect(style.motion.exit_ms).toBe(Math.round((style.motion.enter_ms * 0.7) / 10) * 10);
      expect(style.motion.avoid).toEqual([]);

      // Refusals: existing file, bundled id (without overwrite); overwrite shadows with a warning.
      await expect(analyzeVideo(clips.easeOut!, { projectDir: project, writeStyle: "ref-measured" })).rejects.toThrow(/already exists/);
      await expect(analyzeVideo(clips.easeOut!, { projectDir: project, writeStyle: "minimal" })).rejects.toThrow(/bundled style/);
      await expect(analyzeVideo(clips.easeOut!, { projectDir: project, writeStyle: "../x" })).rejects.toThrow(/lowercase/);
      await expect(analyzeVideo(clips.easeOut!, { writeStyle: "x" })).rejects.toThrow(/needs project_dir/);
      expect(existsSync(join(project, "styles", "minimal.yaml"))).toBe(false);

      // A new measurement over the same id (overwrite) changes the ref the render records.
      const before = styleRef(style);
      const g2 = await analyzeVideo(clips.spring!, { projectDir: project, writeStyle: "ref-measured", overwrite: true });
      expect(g2.style_path).toBe(file);
      const after = await getStyle(findStylesDir(), "ref-measured", project);
      expect(after.motion.easing).toBe("spring");
      expect(styleRef(after)).not.toBe(before);
      expect(resolveTokens(undefined, {}, after).style).toBe(styleRef(after));
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  }, 60_000);

  it("maps motion timing to a style pack", () => {
    const mt = (easing: FormatGrammar["motion_timing"] extends infer M ? (M extends { easing: infer E } ? E : never) : never, enter: number | null, stagger: number | null = null) => ({
      changes_analyzed: 4,
      enter_ms_median: enter,
      enter_ms_p75: enter,
      easing,
      easing_share: 1,
      stagger_ms_median: stagger,
      holds: { count: 0, median_ms: null, longest_ms: null },
    });
    const a = styleFromMotion("a", { cuts_per_10s: 1, motion_timing: mt("ease_out", 612, 183) });
    expect(a.motion).toEqual({ personality: "calm", easing: "ease_out", enter_ms: 610, exit_ms: 430, stagger_ms: 180, transition: "crossfade", transition_ms: 490, avoid: [] });
    expect(styleFromMotion("b", { cuts_per_10s: 1, motion_timing: mt("spring", 450) }).motion.personality).toBe("playful");
    const snap = styleFromMotion("c", { cuts_per_10s: 1, motion_timing: mt("snap", 33) });
    expect(snap.motion).toMatchObject({ personality: "energetic", transition: "cut", transition_ms: 0 });
    expect(styleFromMotion("d", { cuts_per_10s: 4, motion_timing: mt("ease_out", 350) }).motion.transition).toBe("cut");
    // Nothing measured: defaults, still a valid pack.
    const none = styleFromMotion("e", { cuts_per_10s: 0 });
    expect(Style.parse(parseYamlOrJson(Style, styleYaml(none)).ok ? none : null).motion.enter_ms).toBe(400);
    const dir2 = join(tmpdir(), `vs-style-${process.pid}.yaml`);
    writeFileSync(dir2, styleYaml(a));
    expect(parseYamlOrJson(Style, readFileSync(dir2, "utf8"))).toMatchObject({ ok: true, data: a });
  });
});

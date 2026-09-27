import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scene } from "@video-studio/schema";
import { describe, expect, it } from "vitest";
import { lintProject } from "./lint.js";
import type { ResolvedMusic } from "./music.js";
import { createRenderRun, hasMotionScenes, musicBeatGrid, sceneBeatGrids, stagePlanTiming } from "./pipeline-stages.js";
import { validateSpecFile } from "./spec-validate.js";

const LINT_FIXTURE = join(import.meta.dirname, "__fixtures__", "lint", "tiktok-low-captions");
const MOTION_FIXTURES = join(import.meta.dirname, "..", "..", "renderer", "src", "__fixtures__", "motion");

/** The lint fixture project with scene s01 as a motion scene drawing `html` (fixture pages under motion/). */
function project(html: string): string {
  const dir = mkdtempSync(join(tmpdir(), "vs-motion-mcp-"));
  cpSync(LINT_FIXTURE, dir, { recursive: true });
  cpSync(MOTION_FIXTURES, join(dir, "motion"), { recursive: true });
  const p = join(dir, "project", "video-spec.json");
  const spec = JSON.parse(readFileSync(p, "utf8"));
  spec.scenes[0].deterministic = { kind: "motion", props: { html, text: ["Docs in.", "Video out."] } };
  writeFileSync(p, JSON.stringify(spec, null, 2));
  return dir;
}
const specOf = (dir: string) => join(dir, "project", "video-spec.json");

describe("spec_validate: motion pages", () => {
  it("accepts the example page", async () => {
    const r = await validateSpecFile(specOf(project("motion/morph.html")), null);
    expect(r.errors.filter((e) => e.stage === "motion")).toEqual([]);
    expect(r.warnings.filter((e) => e.stage === "motion")).toEqual([]);
  });

  it("reports every lint error of an unsafe page, each with a fix", async () => {
    const r = await validateSpecFile(specOf(project("motion/unsafe.html")), null);
    const motion = r.errors.filter((e) => e.stage === "motion");
    expect(r.ok).toBe(false);
    expect(motion.length).toBeGreaterThanOrEqual(3);
    for (const e of motion) {
      expect(e.path).toBe("scenes.0.deterministic.props.html");
      expect(e.message).toMatch(/^s01: motion\/unsafe\.html: motion_/);
      expect(e.fix.length).toBeGreaterThan(10);
    }
    expect(motion.map((e) => e.message).join("\n")).toMatch(/fetch[\s\S]*Date\.now|Date\.now[\s\S]*fetch/);
  });

  it("reports a missing page", async () => {
    const missing = await validateSpecFile(specOf(project("motion/nope.html")), null);
    expect(missing.errors.filter((e) => e.stage === "motion").map((e) => e.message)).toEqual([expect.stringMatching(/motion_page_missing/)]);
  });
});

describe("lint: motion_unsafe", () => {
  it("surfaces the same findings, warnings included", async () => {
    const bad = await lintProject(project("motion/unsafe.html"));
    const f = bad.findings.filter((x) => x.id === "motion_unsafe");
    expect(f.length).toBeGreaterThanOrEqual(3);
    expect(f.every((x) => x.scene_id === "s01" && x.severity === "error")).toBe(true);
    expect(bad.status).toBe("fail");

    const dir = project("motion/noseek.html");
    writeFileSync(join(dir, "motion", "noseek.html"), "<div></div><script>var x = 1;</script>");
    const warn = (await lintProject(dir)).findings.filter((x) => x.id === "motion_unsafe");
    expect(warn).toEqual([expect.objectContaining({ severity: "warning", message: expect.stringMatching(/motion_no_seek/) })]);

    expect((await lintProject(project("motion/morph.html"))).findings.filter((x) => x.id === "motion_unsafe")).toEqual([]);
  });
});

describe("sceneBeatGrids", () => {
  const scene = (id: string, kind: "motion" | "typography", duration: number): Scene => ({
    id,
    duration_sec: duration,
    purpose: "point",
    voiceover: "",
    visual_strategy: "motion_graphic",
    deterministic: kind === "motion" ? { kind, props: { html: "motion/a.html" } } : { kind, props: { lines: ["a"] } },
    visual_requirements: { continuity_refs: [] },
    claim_refs: [],
  });

  it("slices the video-timeline grid into each motion scene's local seconds", () => {
    const scenes = [scene("s01", "typography", 1), scene("s02", "motion", 2), scene("s03", "motion", 1)];
    const grids = sceneBeatGrids(scenes, 30, { bpm: 120, beats: 8, moved_cuts: 0, beat_times_ms: [0, 500, 1000, 1500, 2500, 3000, 3500], downbeat_times_ms: [0, 1000, 3000] });
    expect([...grids.keys()]).toEqual(["s02", "s03"]);
    expect(grids.get("s02")).toEqual({ beats_s: [0, 0.5, 1.5], downbeats_s: [0] });
    expect(grids.get("s03")).toEqual({ beats_s: [0, 0.5], downbeats_s: [0] });
  });

  it("is empty without a beat grid", () => {
    expect(sceneBeatGrids([scene("s01", "motion", 1)], 30, undefined).size).toBe(0);
    expect(sceneBeatGrids([scene("s01", "motion", 1)], 30, { bpm: null, beats: 0, moved_cuts: 0 }).size).toBe(0);
  });
});

describe("beat grid for motion pages without beat sync", () => {
  const scene = (id: string, kind: "motion" | "typography", duration: number): Scene => ({
    id,
    duration_sec: duration,
    purpose: "point",
    voiceover: "",
    visual_strategy: "motion_graphic",
    deterministic: kind === "motion" ? { kind, props: { html: "motion/a.html" } } : { kind, props: { lines: ["a"] } },
    visual_requirements: { continuity_refs: [] },
    claim_refs: [],
  });
  /** A synthesized 120 bpm score (exact grid, no file read). */
  const synth: ResolvedMusic = {
    ref: "synth:pulse",
    path: "/nonexistent.wav",
    sha256: "0".repeat(64),
    bed: { file: "synth:pulse" },
    grid: { bpm: 120, beats_ms: [0, 500, 1000, 1500, 2000, 2500, 3000, 3500], downbeats_ms: [0, 2000], duration_ms: 4000 },
  };
  // Cut at 1.4 s: a beat sync would move it to 1.5 s; the grid alone never does.
  const scenes = [scene("s01", "typography", 1.4), scene("s02", "motion", 2.6)];

  it("reads the grid without moving cuts", async () => {
    const g = await musicBeatGrid(scenes, new Map(), synth);
    expect(g.grid).toMatchObject({ bpm: 120, source: "synth", moved_cuts: 0, grid_only: true, beat_times_ms: [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000] });
    expect(g.grid).not.toHaveProperty("snap");
    expect(hasMotionScenes(scenes)).toBe(true);
    expect(hasMotionScenes([scenes[0]!])).toBe(false);
  });

  it("stagePlanTiming records it for motion specs only, and keeps every duration", async () => {
    const run = createRenderRun(mkdtempSync(join(tmpdir(), "vs-motion-grid-")), { env: { CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "vs-data-")) } });
    const voice = { overruns: [] } as any;
    const spec = { scenes, audio: { music: { file: "synth:pulse" } } } as any;
    const t = await stagePlanTiming(run, spec, voice, synth, new Map());
    expect(t.timing_adjustments).toEqual([]);
    expect(t.planScenes.map((s) => s.duration_sec)).toEqual([1.4, 2.6]);
    expect(t.beatSync).toMatchObject({ grid_only: true, moved_cuts: 0 });
    // s02 starts at frame 42 (1.4 s at 30 fps): beats at 1.5, 2.0, ... are local 0.1, 0.6, ...
    expect(sceneBeatGrids(t.planScenes, 30, t.beatSync).get("s02")).toEqual({ beats_s: [0.1, 0.6, 1.1, 1.6, 2.1], downbeats_s: [0.6] });

    const plain = await stagePlanTiming(run, { ...spec, scenes: [scenes[0]!] }, voice, synth, new Map());
    expect(plain.beatSync).toBeUndefined();
    const noMusic = await stagePlanTiming(run, spec, voice, undefined, new Map());
    expect(noMusic.beatSync).toBeUndefined();
    expect(run.warnings).toEqual([]);
  });
});

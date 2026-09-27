import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffprobe, runFfmpeg } from "@video-studio/media";
import type { CaptureSession } from "@video-studio/renderer";
import type { Scene } from "@video-studio/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { formatStills, planDurations, planStillTimes, stillsProject } from "./stills.js";

const LINT_FIXTURE = join(import.meta.dirname, "__fixtures__", "lint", "tiktok-low-captions");
const MOTION_FIXTURES = join(import.meta.dirname, "..", "..", "renderer", "src", "__fixtures__", "motion");

describe("planStillTimes", () => {
  const scenes = [
    { id: "s01", duration_sec: 2, beats: { beats_s: [0, 0.5, 1, 1.5], downbeats_s: [0, 1.5] } },
    { id: "s02", duration_sec: 1 },
  ];

  it("defaults to in, mid and out on the frame grid", () => {
    const r = planStillTimes(scenes, 30);
    expect(r.tiles).toEqual([
      { scene_id: "s01", time: 0.3, tag: "in" },
      { scene_id: "s01", time: 1, tag: "mid" },
      { scene_id: "s01", time: 1.7, tag: "out" },
      { scene_id: "s02", time: 0.2, tag: "in" },
      { scene_id: "s02", time: 0.5, tag: "mid" },
      { scene_id: "s02", time: 0.866667, tag: "out" },
    ]);
  });

  it("takes every beat or bar start inside each scene, falling back with a note", () => {
    const beats = planStillTimes(scenes, 24, { at: "beats" });
    expect(beats.tiles.filter((t) => t.scene_id === "s01").map((t) => [t.time, t.tag])).toEqual([
      [0, "beat 1"],
      [0.5, "beat 2"],
      [1, "beat 3"],
      [1.5, "beat 4"],
    ]);
    expect(beats.tiles.filter((t) => t.scene_id === "s02").map((t) => t.tag)).toEqual(["in", "mid", "out"]);
    expect(beats.notes).toEqual(["s02: no beats inside the scene; showing in/mid/out"]);
    expect(planStillTimes(scenes, 24, { at: "downbeats" }).tiles.slice(0, 2).map((t) => t.tag)).toEqual(["bar 1", "bar 2"]);
  });

  it("uses explicit scene-local times, dropping those past a scene and duplicate frames", () => {
    const r = planStillTimes(scenes, 30, { times: [0.5, 0.51, 1.5] });
    expect(r.tiles.map((t) => `${t.scene_id}@${t.time}`)).toEqual(["s01@0.5", "s01@1.5", "s02@0.5"]);
    expect(r.notes).toEqual(["s02: 1 time(s) past its 1s dropped"]);
  });

  it("spaces count frames evenly and caps the total", () => {
    expect(planStillTimes([scenes[0]!], 30, { count: 5 }).tiles.map((t) => t.tag)).toEqual(["1/5", "2/5", "3/5", "4/5", "5/5"]);
    expect(planStillTimes([scenes[0]!], 30, { count: 1 }).tiles).toEqual([{ scene_id: "s01", time: 1, tag: "mid" }]);
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, duration_sec: 3 }));
    const r = planStillTimes(many, 30);
    expect(r.tiles).toHaveLength(90);
    expect(r.notes.at(-1)).toMatch(/120 frames requested; showing the first 90/);
  });
});

describe("planDurations", () => {
  const scene = (id: string, d: number) => ({ id, duration_sec: d }) as Scene;
  it("applies the latest render's timing adjustments only when it matches the spec", () => {
    const scenes = [scene("s01", 2), scene("s02", 3)];
    const state = { scenes: [{ scene_id: "s01" }, { scene_id: "s02" }], timing_adjustments: [{ scene_id: "s02", spec_duration_sec: 3, render_duration_sec: 3.5, reason: "" }] } as any;
    const r = planDurations(scenes, state);
    expect(r.from).toBe("render-state");
    expect(r.scenes.map((s) => s.duration_sec)).toEqual([2, 3.5]);
    expect(planDurations([scene("s01", 2)], state)).toEqual({ scenes: [scene("s01", 2)], from: "spec" });
    // The spec's duration changed since that render: the stale adjustment is ignored.
    expect(planDurations([scene("s01", 2), scene("s02", 4)], state).scenes[1]!.duration_sec).toBe(4);
    expect(planDurations(scenes, undefined).from).toBe("spec");
  });
});

describe("stillsProject (fake Chrome)", () => {
  let png: Buffer;
  let chrome: string;
  const data = mkdtempSync(join(tmpdir(), "vs-stills-data-"));

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-stills-png-"));
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=0x4F8CFF:s=270x480", "-frames:v", "1", join(dir, "f.png")]);
    png = readFileSync(join(dir, "f.png"));
    chrome = join(dir, "chrome");
    writeFileSync(chrome, "#!/bin/sh\nexit 0\n");
    chmodSync(chrome, 0o755);
  }, 60_000);

  function project(music = false): string {
    const dir = mkdtempSync(join(tmpdir(), "vs-stills-"));
    cpSync(LINT_FIXTURE, dir, { recursive: true });
    cpSync(MOTION_FIXTURES, join(dir, "motion"), { recursive: true });
    const p = join(dir, "project", "video-spec.json");
    const spec = JSON.parse(readFileSync(p, "utf8"));
    spec.scenes[0].deterministic = { kind: "motion", props: { html: "motion/morph.html", text: ["Docs in.", "Video out."] } };
    if (music) spec.audio = { ...spec.audio, music: { file: "synth:pulse" } };
    writeFileSync(p, JSON.stringify(spec, null, 2));
    return dir;
  }

  function fake() {
    const log = { sizes: [] as string[], opened: [] as Array<{ id: string; html: string; files: string[] }>, seeks: [] as number[], closed: 0 };
    const openCapture = async (o: { width: number; height: number }): Promise<CaptureSession> => {
      log.sizes.push(`${o.width}x${o.height}`);
      return {
        async open(dir, id) {
          log.opened.push({ id, html: readFileSync(join(dir, "index.html"), "utf8"), files: readdirSync(dir, { recursive: true }).map(String).sort() });
          return { errors: [], capture: async (t) => (log.seeks.push(t), png), close: async () => {} };
        },
        async close() {
          log.closed++;
        },
      };
    };
    return { log, openCapture };
  }

  it("draws each HyperFrames scene's composed page and tiles a labelled sheet under review/stills", async () => {
    const dir = project();
    const f = fake();
    const r = await stillsProject(dir, {}, { env: { ...process.env, CLAUDE_PLUGIN_DATA: data }, chromePath: chrome, openCapture: f.openCapture });
    expect(f.log.sizes).toEqual(["540x960"]);
    expect(f.log.closed).toBe(1);
    expect(f.log.opened.map((o) => o.id)).toEqual(["vs-s01", "vs-s02"]);
    // The motion page is composed as the renderer composes it (CSP wrapper, its own files beside it).
    expect(f.log.opened[0]!.html).toContain("Content-Security-Policy");
    expect(f.log.opened[0]!.files).toEqual(expect.arrayContaining(["index.html", "morph.css", "morph.js"]));
    expect(f.log.opened[1]!.html).toContain('data-composition-id="vs-s02"');
    expect(r.tiles.map((t) => t.label)).toEqual(["s01 in 0.29s", "s01 mid 1.50s", "s01 out 2.54s", "s02 in 0.29s", "s02 mid 2.50s", "s02 out 4.54s"]);
    expect(f.log.seeks).toEqual(r.tiles.map((t) => t.time_sec).map((t) => expect.closeTo(t, 3)));
    expect(r.image_rel).toBe(join("review", "stills", "stills-preview.jpg"));
    expect(existsSync(r.image)).toBe(true);
    const p = await ffprobe(r.image);
    expect(p.width).toBe(6 * 240 + 5 * 4 + 2 * 4);
    expect(r.tiles.every((t) => existsSync(join(dir, t.frame)))).toBe(true);
    expect(readdirSync(join(dir, "review", "stills")).sort()).toEqual(["frames", "stills-preview.jpg"]);
    expect(r).toMatchObject({ kind: "stills", quality: "preview", durations: "spec", grid: { source: "none" }, skipped: [] });
    expect(existsSync(join(dir, "renders", "preview", "render-state.json"))).toBe(false);
    const text = formatStills(r);
    expect(text).toMatch(/^stills \(not a render; renders\/ and dist\/ are unchanged\): 6 frame\(s\) of 2 scene\(s\)/);
    expect(text).toMatch(/no preview render yet/);
  }, 120_000);

  it("samples the music's beats, and hands motion pages the same grid the render uses", async () => {
    const dir = project(true);
    const f = fake();
    const r = await stillsProject(dir, { scenes: ["s01"], at: "beats" }, { env: { ...process.env, CLAUDE_PLUGIN_DATA: data }, chromePath: chrome, openCapture: f.openCapture });
    expect(r.grid.source).toBe("music");
    expect(r.tiles.length).toBeGreaterThanOrEqual(3);
    expect(r.tiles.every((t) => t.scene_id === "s01" && /^beat \d+$/.test(t.tag))).toBe(true);
    expect(f.log.opened[0]!.html).toMatch(/"beats":\[0(,[\d.]+)+\]/);
    expect(r.image_rel).toBe(join("review", "stills", "stills-preview-s01.jpg"));
  }, 120_000);

  it("refuses beats without a music bed, unknown scenes, and a live render", async () => {
    const dir = project();
    const deps = { env: { ...process.env, CLAUDE_PLUGIN_DATA: data }, chromePath: chrome, openCapture: fake().openCapture };
    await expect(stillsProject(dir, { at: "downbeats" }, deps)).rejects.toThrow(/no beat grid .*no audio\.music bed/);
    await expect(stillsProject(dir, { scenes: ["nope"] }, deps)).rejects.toThrow(/no scene "nope" in the spec \(scenes: s01, s02\)/);
    mkdirSync(join(dir, "renders"), { recursive: true });
    writeFileSync(join(dir, "renders", ".render.lock"), JSON.stringify({ pid: process.pid, host: (await import("node:os")).hostname(), started_at: new Date().toISOString(), quality: "final" }));
    await expect(stillsProject(dir, {}, deps)).rejects.toMatchObject({ name: "RenderLockedError" });
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// Real Chrome through the producer's puppeteer-core (cannot run inside the Claude Code sandbox):
//   VS_TEST_RENDER=1 npx vitest run packages/mcp/src/stills.test.ts
// ---------------------------------------------------------------------------------------------
describe.skipIf(process.env.VS_TEST_RENDER !== "1")("stills in real Chrome (VS_TEST_RENDER=1)", () => {
  it("draws a motion page and a typography scene at different moments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-stills-real-"));
    cpSync(LINT_FIXTURE, dir, { recursive: true });
    cpSync(MOTION_FIXTURES, join(dir, "motion"), { recursive: true });
    const p = join(dir, "project", "video-spec.json");
    const spec = JSON.parse(readFileSync(p, "utf8"));
    spec.scenes[0].deterministic = { kind: "motion", props: { html: "motion/morph.html", text: ["Docs in.", "Video out."] } };
    writeFileSync(p, JSON.stringify(spec, null, 2));
    const r = await stillsProject(dir, { count: 3 });
    expect(r.tiles).toHaveLength(6);
    const frames = r.tiles.map((t) => readFileSync(join(dir, t.frame)));
    // The motion page moves: its in and out frames differ.
    expect(frames[0]!.equals(frames[2]!)).toBe(false);
    const probe = await ffprobe(join(dir, r.tiles[0]!.frame));
    expect([probe.width, probe.height]).toEqual([r.width, r.height]);
    console.error(`[stills real] ${r.image}`);
  }, 180_000);
});

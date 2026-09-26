import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffprobe } from "@video-studio/media";
import type { DeterministicKind, Scene } from "@video-studio/schema";
import { createFfmpegRenderer } from "./ffmpeg-renderer.js";
import { PENDING_REASON, autoSceneConcurrency, parseVmStat, placeholderScene, renderScenes, sceneCacheKey, selectRenderer } from "./select.js";
import { resolveTokens, targetForAspect } from "./tokens.js";
import type { SceneRenderer } from "./types.js";

const T = 60_000;

function fake(id: string, kinds: DeterministicKind[], ok = true): SceneRenderer & { renders: number } {
  const r = {
    id,
    version: "1",
    kinds,
    renders: 0,
    available: async () => (ok ? { ok: true } : { ok: false, reason: "no chrome" }),
    render: async () => {
      r.renders++;
      throw new Error("not used");
    },
  };
  return r;
}

describe("selectRenderer", () => {
  const all: DeterministicKind[] = ["typography", "code", "chart", "diagram", "cta", "end_card", "comparison", "screenshot"];
  const hf = fake("hyperframes", ["typography", "code", "chart", "diagram", "cta", "end_card"]);
  const hfDown = fake("hyperframes", all, false);
  const ff = fake("ffmpeg-drawtext", all);
  const other = fake("remotion", all);

  const cases: [string, SceneRenderer[], DeterministicKind, "auto" | "hyperframes" | "ffmpeg", string | null, RegExp][] = [
    ["auto prefers hyperframes", [ff, hf], "typography", "auto", "hyperframes", /^auto: hyperframes$/],
    ["auto falls back to ffmpeg when hyperframes lacks the kind", [hf, ff], "screenshot", "auto", "ffmpeg-drawtext", /hyperframes does not draw "screenshot"/],
    ["auto falls back to ffmpeg when hyperframes is unavailable", [hfDown, ff], "code", "auto", "ffmpeg-drawtext", /unavailable \(no chrome\)/],
    ["auto ranks ffmpeg before other renderers", [other, ff], "cta", "auto", "ffmpeg-drawtext", /^auto: ffmpeg-drawtext$/],
    ["ffmpeg preference", [hf, ff], "typography", "ffmpeg", "ffmpeg-drawtext", /^preferred ffmpeg/],
    ["hyperframes preference", [ff, hf], "chart", "hyperframes", "hyperframes", /^preferred hyperframes/],
    ["hyperframes preference falls back", [hfDown, ff], "chart", "hyperframes", "ffmpeg-drawtext", /^fallback from hyperframes/],
    ["nothing available", [hfDown], "chart", "auto", null, /no available renderer draws "chart"/],
    ["no renderers", [], "chart", "auto", null, /no renderers registered/],
  ];
  it.each(cases)("%s", async (_name, renderers, kind, pref, expected, reason) => {
    const sel = await selectRenderer(kind, renderers, {}, pref);
    expect(sel.renderer?.id ?? null).toBe(expected);
    expect(sel.reason).toMatch(reason);
  });

  it("caches availability per pass", async () => {
    let calls = 0;
    const r = { ...fake("ffmpeg-x", ["cta"]), available: async () => (calls++, { ok: true }) };
    const cache = new Map();
    await selectRenderer("cta", [r], {}, "auto", cache);
    await selectRenderer("cta", [r], {}, "auto", cache);
    expect(calls).toBe(1);
  });
});

function mg(id: string, kind: DeterministicKind, props: Record<string, unknown>): Scene {
  return {
    id,
    duration_sec: 1,
    purpose: "point",
    voiceover: "",
    visual_strategy: "motion_graphic",
    deterministic: { kind, props },
    visual_requirements: { continuity_refs: [] },
    claim_refs: [],
  };
}

describe("renderScenes", () => {
  let dir: string;
  const target = targetForAspect("9:16", { shortSide: 180, fps: 12 });
  const tokens = resolveTokens();
  const ffmpeg = createFfmpegRenderer({ encodePreset: "ultrafast" });
  const gen: Scene = {
    id: "s02",
    duration_sec: 1.5,
    purpose: "context",
    voiceover: "A city at night.",
    visual_strategy: "generated_video",
    visual_requirements: { subject: "Neon city skyline at night", continuity_refs: [] },
    claim_refs: [],
  };
  const spec = { scenes: [mg("s01", "typography", { lines: ["Hello"] }), gen] };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vs-rs-test-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("renders motion graphics, reports provider scenes as pending, then hits the cache", async () => {
    const first = await renderScenes(spec, { project_dir: dir, renderers: [ffmpeg], tokens, target });
    const [a, b] = first.scenes;
    expect(a).toMatchObject({ scene_id: "s01", status: "rendered", renderer: "ffmpeg-drawtext" });
    expect(a!.out_path).toBe(join(dir, "renders", "scenes", "s01.mp4"));
    expect(b).toMatchObject({ scene_id: "s02", status: "pending", reason: `generated_video: ${PENDING_REASON}` });
    expect(b!.out_path).toBeUndefined();
    const sidecar = JSON.parse(await readFile(join(dir, "renders", "scenes", "s01.json"), "utf8"));
    expect(sidecar.cache_key).toBe(sceneCacheKey(spec.scenes[0]!, tokens, target, ffmpeg));
    const mtime = (await stat(a!.out_path!)).mtimeMs;

    const second = await renderScenes(spec, { project_dir: dir, renderers: [ffmpeg], tokens, target });
    expect(second.scenes[0]).toMatchObject({ status: "cached", cache_key: sidecar.cache_key, duration_ms: 1000 });
    expect((await stat(a!.out_path!)).mtimeMs).toBe(mtime);

    // A changed scene invalidates the cache.
    const changed = { scenes: [mg("s01", "typography", { lines: ["Hello again"] })] };
    const third = await renderScenes(changed, { project_dir: dir, renderers: [ffmpeg], tokens, target });
    expect(third.scenes[0]!.status).toBe("rendered");
  }, T);

  it("renders a placeholder card for a generated_video scene", async () => {
    const res = await renderScenes({ scenes: [gen] }, { project_dir: dir, renderers: [ffmpeg], tokens, target, placeholder: true });
    const e = res.scenes[0]!;
    expect(e).toMatchObject({ scene_id: "s02", status: "pending", placeholder: true, renderer: "ffmpeg-drawtext", duration_ms: 1500 });
    const p = await ffprobe(e.out_path!);
    expect([p.width, p.height, p.has_audio]).toEqual([180, 320, false]);
    expect(p.duration_s).toBeCloseTo(1.5, 3);
    const again = await renderScenes({ scenes: [gen] }, { project_dir: dir, renderers: [ffmpeg], tokens, target, placeholder: true });
    expect(again.scenes[0]).toMatchObject({ status: "pending", placeholder: true, cache_key: e.cache_key });
    expect(placeholderScene(gen).deterministic).toEqual({
      kind: "end_card",
      props: { title: "Neon city skyline at night", subtitle: "placeholder · generated video" },
    });
  }, T);

  it("renders scenes in parallel with identical clips, results in spec order", async () => {
    const scenes = [mg("p1", "typography", { lines: ["One"] }), mg("p2", "cta", { headline: "Two", action: "Go" }), mg("p3", "typography", { lines: ["Three"] })];
    const hashes = async (concurrency: number) => {
      const seen: string[] = [];
      const res = await renderScenes({ scenes }, { project_dir: dir, dir: join(dir, `par-${concurrency}`), renderers: [ffmpeg], tokens, target, concurrency, onScene: (e) => seen.push(e.scene_id) });
      expect(res.scenes.map((e) => [e.scene_id, e.status])).toEqual(scenes.map((s) => [s.id, "rendered"]));
      expect([...seen].sort()).toEqual(["p1", "p2", "p3"]);
      return Promise.all(res.scenes.map(async (e) => createHash("sha256").update(await readFile(e.out_path!)).digest("hex")));
    };
    expect(await hashes(3)).toEqual(await hashes(1));
  }, T);

  it("never runs two HyperFrames renders at once, even when ffmpeg scenes run in parallel", async () => {
    const counter = (id: string) => {
      const c = { active: 0, max: 0 };
      const r: SceneRenderer = {
        id,
        version: "1",
        kinds: ["typography"],
        available: async () => ({ ok: true }),
        render: async (req) => {
          c.max = Math.max(c.max, ++c.active);
          await new Promise((ok) => setTimeout(ok, 30));
          await writeFile(req.out_path, "x");
          c.active--;
          return { out_path: req.out_path, renderer: id, renderer_version: "1", duration_ms: 1000, warnings: [] };
        },
      };
      return { r, c };
    };
    const hf = counter("hyperframes-fake");
    const ff = counter("ffmpeg-fake");
    const scenes = ["h1", "h2", "h3", "h4"].map((id) => mg(id, "typography", { lines: [id] }));
    await renderScenes({ scenes }, { project_dir: dir, dir: join(dir, "gate-hf"), renderers: [hf.r], tokens, target, concurrency: 3, force: true });
    await renderScenes({ scenes }, { project_dir: dir, dir: join(dir, "gate-ff"), renderers: [ff.r], tokens, target, concurrency: 3, force: true });
    expect(hf.c.max).toBe(1);
    expect(ff.c.max).toBe(3);
  }, T);

  it("reports failures per scene without throwing", async () => {
    const res = await renderScenes({ scenes: [mg("s09", "cta", { headline: "x", action: "y" })] }, { project_dir: dir, renderers: [fake("ffmpeg-broken", ["cta"])], tokens, target });
    expect(res.scenes[0]).toMatchObject({ status: "failed" });
    expect(res.scenes[0]!.reason).toMatch(/render failed: not used/);
  });
});

describe("autoSceneConcurrency", () => {
  const GiB = 1024 ** 3;
  it.each([
    ["plenty of memory and cpus", { freeMemBytes: 16 * GiB, cpus: 8 }, 2],
    ["low memory", { freeMemBytes: 2 * GiB, cpus: 8 }, 1],
    ["3.2 GiB free", { freeMemBytes: 3.2 * GiB, cpus: 8 }, 2],
    ["almost no memory", { freeMemBytes: 0.2 * GiB, cpus: 8 }, 1],
    ["two cpus", { freeMemBytes: 16 * GiB, cpus: 2 }, 1],
    ["hyperframes", { freeMemBytes: 16 * GiB, cpus: 8, family: "hyperframes" as const }, 1],
    ["footage counts like ffmpeg", { freeMemBytes: 16 * GiB, cpus: 8, family: "footage" as const }, 2],
    ["env override", { freeMemBytes: 1 * GiB, cpus: 2, env: { VS_RENDER_CONCURRENCY: "4" } }, 4],
    ["option override beats env", { freeMemBytes: 1 * GiB, cpus: 8, override: 2, env: { VS_RENDER_CONCURRENCY: "4" } }, 2],
    ["override applies to hyperframes too (Chrome is still serialised)", { family: "hyperframes" as const, override: 3 }, 3],
    ["out-of-range override is ignored", { freeMemBytes: 16 * GiB, cpus: 8, env: { VS_RENDER_CONCURRENCY: "9" } }, 2],
    ["non-integer override is ignored", { freeMemBytes: 2 * GiB, cpus: 8, env: { VS_RENDER_CONCURRENCY: "fast" } }, 1],
  ])("%s", (_name, o, expected) => {
    expect(autoSceneConcurrency(o).concurrency).toBe(expected);
  });
});

describe("parseVmStat", () => {
  it("adds free, inactive, speculative and purgeable pages", () => {
    const out = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:      100.\nPages active:    999.\nPages inactive:  200.\nPages speculative: 10.\nPages wired down: 5.\nPages purgeable:  2.\n";
    expect(parseVmStat(out)).toBe(312 * 16384);
    expect(parseVmStat("nonsense")).toBeNull();
  });
});

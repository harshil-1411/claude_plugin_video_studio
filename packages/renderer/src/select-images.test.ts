import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DeterministicKind, Scene } from "@video-studio/schema";
import { renderScenes, sceneCacheKey, sceneImageRefs, sceneImages } from "./select.js";
import { resolveTokens, targetForAspect } from "./tokens.js";
import type { SceneRenderer } from "./types.js";

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

/** A renderer that only writes a stub clip, so cache behavior is tested without ffmpeg. */
function writer(): SceneRenderer & { renders: number } {
  const r = {
    id: "ffmpeg-stub",
    version: "1",
    kinds: ["screenshot", "end_card", "typography", "split_screen"] as DeterministicKind[],
    renders: 0,
    available: async () => ({ ok: true }),
    render: async (req: { out_path: string; scene: Scene }) => {
      r.renders++;
      await writeFile(req.out_path, "clip");
      return { renderer: r.id, renderer_version: r.version, duration_ms: req.scene.duration_sec * 1000, warnings: [] };
    },
  };
  return r as unknown as SceneRenderer & { renders: number };
}

describe("scene cache keys include the bytes of drawn images", () => {
  let dir: string;
  const target = targetForAspect("9:16", { shortSide: 180, fps: 12 });
  const shot = mg("s01", "screenshot", { asset: "img1" });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vs-rs-img-"));
    await mkdir(join(dir, "source", "assets"), { recursive: true });
    await writeFile(join(dir, "source", "content-ir.json"), JSON.stringify({ assets: [{ id: "img1", kind: "image", path: "source/assets/shot.png" }] }));
    await writeFile(join(dir, "source", "assets", "shot.png"), "first image bytes");
    await mkdir(join(dir, "brand"), { recursive: true });
    await writeFile(join(dir, "brand", "logo.png"), "logo v1");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("collects asset ids from props and the logo only for kinds that draw it", () => {
    const tokens = { logo_path: "brand/logo.png" };
    expect(sceneImageRefs(shot, tokens)).toEqual({ assets: ["img1"] });
    expect(sceneImageRefs(mg("s", "split_screen", { left: { asset: "b" }, right: { asset: "a" } }), tokens)).toEqual({ assets: ["a", "b"] });
    expect(sceneImageRefs(mg("s", "end_card", { title: "x" }), tokens)).toEqual({ assets: [], logo: "brand/logo.png" });
    expect(sceneImageRefs(mg("s", "typography", { lines: ["x"] }), tokens)).toEqual({ assets: [] });
  });

  it("a screenshot scene's key changes when the image bytes change under the same name", async () => {
    const tokens = resolveTokens();
    const r = { id: "ffmpeg-drawtext", version: "1" };
    const key = async () => sceneCacheKey(shot, tokens, target, r, false, undefined, undefined, undefined, await sceneImages(shot, tokens, dir));
    const before = await key();
    await writeFile(join(dir, "source", "assets", "shot.png"), "second image bytes");
    const after = await key();
    expect(after).not.toBe(before);
    // Scenes without images keep the key they had before images were keyed.
    const plain = mg("s02", "typography", { lines: ["Hello"] });
    expect(await sceneImages(plain, tokens, dir)).toEqual([]);
    expect(sceneCacheKey(plain, tokens, target, r, false, undefined, undefined, undefined, [])).toBe(sceneCacheKey(plain, tokens, target, r));
  });

  it("renderScenes re-renders a screenshot or end card whose image was replaced", async () => {
    const tokens = { ...resolveTokens(), logo_path: "brand/logo.png" };
    const end = mg("s03", "end_card", { title: "Bye" });
    const plain = mg("s04", "typography", { lines: ["Hi"] });
    const spec = { scenes: [shot, end, plain] };
    const r = writer();
    const o = { project_dir: dir, renderers: [r], tokens, target, preference: "ffmpeg" as const };
    const first = await renderScenes(spec, o);
    expect(first.scenes.map((s) => s.status)).toEqual(["rendered", "rendered", "rendered"]);
    expect(first.scenes[2]!.cache_key).toBe(sceneCacheKey(plain, tokens, target, r));
    const second = await renderScenes(spec, o);
    expect(second.scenes.map((s) => s.status)).toEqual(["cached", "cached", "cached"]);

    await writeFile(join(dir, "source", "assets", "shot.png"), "third image bytes");
    await writeFile(join(dir, "brand", "logo.png"), "logo v2");
    const third = await renderScenes(spec, o);
    expect(third.scenes.map((s) => s.status)).toEqual(["rendered", "rendered", "cached"]);
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findFontsDir } from "@video-studio/renderer";
import type { VideoLock } from "@video-studio/schema";
import { buildLock, diffLocks, formatLockChanges, listFiles, lockAssets, lockFonts, readLock, serializeLock } from "./lock.js";

const h = (c: string) => c.repeat(64);

function base(): VideoLock {
  return {
    schema_version: "1.0",
    project_id: "demo",
    quality: "preview",
    spec_sha256: h("a"),
    content_ir_sha256: h("b"),
    engine: { engine: "0.1.0", assembly: "2", cover: "2", target_package: "1" },
    tools: { ffmpeg: "7.1", "ffmpeg-drawtext": "0.2.0", node: "22.13.0", "voice:silent": "n/a" },
    voice: { backend: "silent", request_hash: h("c") },
    fonts: [
      { family: "Inter", weight: 700, file: "fonts/Inter/Inter-Bold.ttf", sha256: h("d") },
      { family: "Inter", weight: 400, file: "fonts/Inter/Inter-Regular.ttf", sha256: h("e") },
    ],
    targets: [
      { id: "tiktok", contract_version: 1, verified: "2026-09-01" },
      { id: "instagram", contract_version: 2, verified: "2026-09-25" },
    ],
    scenes: [
      { scene_id: "s01", renderer: "ffmpeg-drawtext", renderer_version: "0.2.0", cache_key: h("1"), clip_sha256: h("2") },
      { scene_id: "s02", renderer: "ffmpeg-drawtext", renderer_version: "0.2.0", cache_key: h("3"), clip_sha256: h("4") },
    ],
    assets: [
      { path: "source/content-ir.json", sha256: h("b") },
      { path: "brand.yaml", sha256: h("5") },
    ],
    outputs: [
      { path: "dist/reel.mp4", sha256: h("6") },
      { path: "dist/tiktok/post.json", sha256: h("7"), target: "tiktok" },
      { path: "dist/render-manifest.json", sha256: h("8") },
    ],
  };
}

const clone = (l: VideoLock): VideoLock => structuredClone(l);
const classes = (before: VideoLock, after: VideoLock) => diffLocks(buildLock(before), buildLock(after)).map((c) => [c.class, c.path]);

describe("buildLock", () => {
  it("sorts keyed arrays, keeps scene order, drops the manifest and is byte-stable", () => {
    const l = buildLock(base());
    expect(l.fonts.map((f) => f.weight)).toEqual([400, 700]);
    expect(l.targets.map((t) => t.id)).toEqual(["instagram", "tiktok"]);
    expect(l.assets.map((a) => a.path)).toEqual(["brand.yaml", "source/content-ir.json"]);
    expect(l.outputs.map((o) => o.path)).toEqual(["dist/reel.mp4", "dist/tiktok/post.json"]);
    expect(l.scenes.map((s) => s.scene_id)).toEqual(["s01", "s02"]);
    expect(Object.keys(l.tools)).toEqual(["ffmpeg", "ffmpeg-drawtext", "node", "voice:silent"]);

    const shuffled = clone(base());
    shuffled.fonts.reverse();
    shuffled.assets.reverse();
    shuffled.outputs.reverse();
    shuffled.tools = Object.fromEntries(Object.entries(shuffled.tools).reverse());
    expect(serializeLock(buildLock(shuffled))).toBe(serializeLock(l));
  });

  it("rejects an invalid lock", () => {
    const bad = clone(base());
    bad.spec_sha256 = "nope";
    expect(() => buildLock(bad)).toThrow();
  });
});

describe("diffLocks", () => {
  it("is empty for equal locks", () => {
    expect(diffLocks(buildLock(base()), buildLock(base()))).toEqual([]);
    expect(formatLockChanges([])).toMatch(/identical/);
  });

  it("classifies a spec edit as creative, with its clip and output changes", () => {
    const after = clone(base());
    after.spec_sha256 = h("f");
    after.scenes[1]!.cache_key = h("9");
    after.scenes[1]!.clip_sha256 = h("0");
    after.outputs[0]!.sha256 = h("0");
    const changes = diffLocks(buildLock(base()), buildLock(after));
    expect(changes.map((c) => [c.class, c.path])).toEqual([
      ["creative", "outputs.dist/reel.mp4.sha256"],
      ["creative", "scenes.s02.cache_key"],
      ["creative", "scenes.s02.clip_sha256"],
      ["creative", "spec_sha256"],
    ]);
    expect(changes[0]!.message).toMatch(/follows a creative change/);
  });

  it("classifies engine, tool, font and scene renderer changes as renderer", () => {
    const after = clone(base());
    after.tools.ffmpeg = "7.2";
    after.engine.assembly = "3";
    after.fonts[0]!.sha256 = h("0");
    after.scenes[0]!.renderer = "hyperframes";
    after.scenes[0]!.renderer_version = "0.8.75";
    after.scenes[0]!.cache_key = h("9");
    expect(classes(base(), after)).toEqual([
      ["renderer", "engine.assembly"],
      ["renderer", "fonts.Inter@700.sha256"],
      ["renderer", "scenes.s01.cache_key"],
      ["renderer", "scenes.s01.renderer"],
      ["renderer", "scenes.s01.renderer_version"],
      ["renderer", "tools.ffmpeg"],
    ]);
  });

  it("classifies contract changes as spec, and attributes clip changes to them", () => {
    const after = clone(base());
    after.targets[0]!.contract_version = 2;
    after.targets[0]!.verified = "2026-09-25";
    after.targets.push({ id: "youtube-shorts", contract_version: 1, verified: "2026-09-25" });
    after.scenes[0]!.cache_key = h("9");
    expect(classes(base(), after)).toEqual([
      ["spec", "scenes.s01.cache_key"],
      ["spec", "targets.tiktok.contract_version"],
      ["spec", "targets.tiktok.verified"],
      ["spec", "targets.youtube-shorts"],
    ]);
  });

  it("classifies input changes as asset", () => {
    const after = clone(base());
    after.assets[1]!.sha256 = h("0");
    after.assets.push({ path: "assets/supplied/logo.png", sha256: h("1") });
    after.content_ir_sha256 = h("0");
    after.outputs[0]!.sha256 = h("0");
    expect(classes(base(), after)).toEqual([
      ["asset", "assets.assets/supplied/logo.png"],
      ["asset", "assets.brand.yaml.sha256"],
      ["asset", "content_ir_sha256"],
      ["asset", "outputs.dist/reel.mp4.sha256"],
    ]);
  });

  it("classifies output-only changes (post copy) and quality as metadata", () => {
    const after = clone(base());
    after.outputs[1]!.sha256 = h("0");
    after.outputs.push({ path: "dist/instagram/post.json", sha256: h("1"), target: "instagram" });
    after.quality = "final";
    const changes = diffLocks(buildLock(base()), buildLock(after));
    expect(changes.map((c) => [c.class, c.path])).toEqual([
      ["metadata", "outputs.dist/instagram/post.json"],
      ["metadata", "outputs.dist/tiktok/post.json.sha256"],
      ["metadata", "quality"],
    ]);
    const md = formatLockChanges(changes);
    expect(md).toMatch(/^\*\*metadata\*\* \(3\)/);
    expect(md).toContain("`quality`: preview → final");
  });

  it("voice: backend is renderer, request hash is creative; a clip change with no cause is flagged", () => {
    const after = clone(base());
    after.voice = { backend: "system", voice_id: "Samantha", request_hash: h("0") };
    expect(classes(base(), after)).toEqual([
      ["creative", "voice.request_hash"],
      ["renderer", "voice.backend"],
      ["renderer", "voice.voice_id"],
    ]);
    const flaky = clone(base());
    flaky.scenes[0]!.clip_sha256 = h("0");
    const c = diffLocks(buildLock(base()), buildLock(flaky));
    expect(c.map((x) => [x.class, x.path])).toEqual([["renderer", "scenes.s01.clip_sha256"]]);
    expect(c[0]!.message).toMatch(/non-deterministic/);
  });

  it("reports scene list changes as creative", () => {
    const after = clone(base());
    after.spec_sha256 = h("f");
    after.scenes.reverse();
    after.scenes.push({ scene_id: "s03", renderer: "ffmpeg-drawtext", renderer_version: "0.2.0", cache_key: h("5"), clip_sha256: h("6") });
    expect(classes(base(), after)).toEqual([
      ["creative", "scenes"],
      ["creative", "spec_sha256"],
    ]);
  });

  it("classifies a style pack change as creative, not a tool change", () => {
    const b = clone(base());
    b.tools.style = "minimal@1";
    const after = clone(b);
    after.tools.style = "energetic@1";
    expect(classes(b, after)).toEqual([["creative", "tools.style"]]);
  });
});

describe("lock files and inputs", () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "vs-lock-"));
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("readLock: undefined when missing, validated when present", async () => {
    expect(await readLock(join(tmp, "missing.lock"))).toBeUndefined();
    const p = join(tmp, "video.lock");
    await writeFile(p, serializeLock(buildLock(base())));
    expect(await readLock(p)).toEqual(buildLock(base()));
    await writeFile(p, JSON.stringify({ schema_version: "1.0" }));
    await expect(readLock(p)).rejects.toThrow(/not a valid video.lock/);
    await writeFile(p, "{");
    await expect(readLock(p)).rejects.toThrow(/not valid JSON/);
  });

  it("lockAssets and listFiles: project-relative, sorted, skipping missing files, dotfiles and skipped dirs", async () => {
    await mkdir(join(tmp, "assets", "supplied"), { recursive: true });
    await mkdir(join(tmp, "assets", "voice"), { recursive: true });
    await writeFile(join(tmp, "assets", "supplied", "b.png"), "b");
    await writeFile(join(tmp, "assets", "supplied", "a.png"), "a");
    await writeFile(join(tmp, "assets", "supplied", ".DS_Store"), "x");
    await writeFile(join(tmp, "assets", "voice", "s01.wav"), "v");
    const files = await listFiles(tmp, "assets", ["assets/voice"]);
    expect(files).toEqual(["assets/supplied/a.png", "assets/supplied/b.png"]);
    const assets = await lockAssets(tmp, [...files, "brand.yaml"]);
    expect(assets.map((a) => a.path)).toEqual(files);
    expect(assets[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("lockFonts: bundled fonts are plugin-relative with their README hashes; host fonts carry only a basename", async () => {
    const fontsDir = findFontsDir({});
    expect(fontsDir).toBeTruthy();
    const fonts = await lockFonts(
      [
        { chain: 'Inter, "Noto Sans", sans-serif', weight: 700 },
        { chain: "Inter, sans-serif", weight: 400 },
        { chain: "Inter", weight: 400 },
      ],
      { fontsDir },
    );
    expect(fonts).toEqual([
      { family: "Inter", weight: 700, file: "fonts/Inter/Inter-Bold.ttf", sha256: "288316099b1e0a47a4716d159098005eef7c0066921f34e3200393dbdb01947f" },
      { family: "Inter", weight: 400, file: "fonts/Inter/Inter-Regular.ttf", sha256: "40d692fce188e4471e2b3cba937be967878f631ad3ebbbdcd587687c7ebe0c82" },
    ]);
    const hostFile = join(tmp, "Host.ttf");
    await writeFile(hostFile, "font");
    const host = await lockFonts([{ chain: "Brand Sans, sans-serif", weight: 400 }], { fontsDir, resolver: async () => hostFile });
    expect(host).toEqual([{ family: "Brand Sans", weight: 400, file: "host/Host.ttf", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(await lockFonts([{ chain: "Nope", weight: 400 }], { fontsDir, resolver: async () => Promise.reject(new Error("none")) })).toEqual([]);
  });
});

import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initProject } from "@video-studio/core";
import { ffprobe, runFfmpeg } from "@video-studio/media";
import { layoutZones } from "@video-studio/platforms";
import { FFMPEG_RENDERER_VERSION, createFfmpegRenderer } from "@video-studio/renderer";
import { RenderManifest, VideoLock, type VideoSpec } from "@video-studio/schema";
import { type VoiceBackend, tokenize } from "@video-studio/voice";
import { ASSEMBLY_VERSION, type RenderProjectOptions, SpecInvalidError, bracketCue, exportProject, isSoundCue, loadValidSpec, renderProject, runQa, socialCopy, soundEventCues } from "./pipeline.js";
import { diffLocks, readLock } from "./lock.js";
import { validateSpecFile } from "./spec-validate.js";
import { RenderJobManager } from "./render-jobs.js";
import { createServer } from "./server.js";

// Tiny renders only: 180x320, 3 s, 15 fps, x264 ultrafast, ffmpeg renderer. One render at a time.
const T = 120_000;
let tmp: string;
let env: Record<string, string | undefined>;

const spec: VideoSpec = {
  schema_version: "1.0",
  id: "tiny-vector-db",
  title: "Vector databases, tiny",
  goal: "explain",
  audience: "developers new to AI search",
  platform: "youtube_shorts",
  aspect_ratio: "9:16",
  target_duration_sec: 3,
  language: "en-US",
  grounding: "loose",
  voice: {},
  captions: { preset: "minimal", burn_in: true },
  scenes: [
    {
      id: "s01",
      duration_sec: 1,
      purpose: "hook",
      voiceover: "Search finds words.",
      visual_strategy: "motion_graphic",
      deterministic: { kind: "typography", props: { lines: ["Search finds words"], emphasis: "words" } },
      visual_requirements: { continuity_refs: [] },
      claim_refs: [],
    },
    {
      id: "s02",
      duration_sec: 1,
      purpose: "point",
      voiceover: "Vectors find meaning.",
      visual_strategy: "motion_graphic",
      deterministic: { kind: "diagram", props: { nodes: ["text", "vector"], edges: [["text", "vector"]] } },
      visual_requirements: { continuity_refs: [] },
      claim_refs: [],
    },
    {
      id: "s03",
      duration_sec: 1,
      purpose: "cta",
      voiceover: "Try it.",
      visual_strategy: "motion_graphic",
      deterministic: { kind: "cta", props: { headline: "Try it", action: "Embed your docs" } },
      visual_requirements: { continuity_refs: [] },
      claim_refs: [],
    },
  ],
};

/** A "system" backend that passes the availability check but fails to synthesize (like `say` in a sandbox). */
const failingSystem: VoiceBackend = {
  id: "system",
  available: () => ({ ok: true, reason: "fake say" }),
  synthesize: async () => {
    throw new Error("say exited with code 1");
  },
};

/** A "system" backend whose audio for s01 is longer than the scene. */
const longSystem: VoiceBackend = {
  id: "system",
  available: () => ({ ok: true, reason: "fake say" }),
  cacheOptions: () => ({ fake: "long" }),
  async synthesize(input, ctx) {
    const ms = input.scene_id === "s01" ? 1800 : 600;
    const out = join(ctx.outDir, `${input.scene_id}.wav`);
    await runFfmpeg(["-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${ms / 1000}`, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", out]);
    const words = tokenize(input.text);
    const step = Math.floor(ms / Math.max(1, words.length));
    return {
      scene_id: input.scene_id,
      audio_path: out,
      duration_ms: ms,
      words: words.map((w, i) => ({ word: w, start_ms: i * step, end_ms: (i + 1) * step })),
      timing_source: "estimated",
      provider: "fake-say",
    };
  },
};

const unavailableEleven: VoiceBackend = { id: "elevenlabs", available: () => ({ ok: false, reason: "no key" }), synthesize: async () => Promise.reject(new Error("no")) };

function opts(extra: Partial<RenderProjectOptions> = {}): RenderProjectOptions {
  return {
    quality: "preview",
    renderer: "ffmpeg",
    renderers: [createFfmpegRenderer({ encodePreset: "ultrafast" })],
    target: { shortSide: 180, fps: 15 },
    encodePreset: "ultrafast",
    env,
    voiceCacheDir: join(tmp, "voice-cache"),
    ...extra,
  };
}

async function makeProject(name: string, s: VideoSpec = spec): Promise<string> {
  const dir = join(tmp, name);
  await initProject(dir, { name });
  await writeFile(join(dir, "project", "video-spec.json"), JSON.stringify(s, null, 2));
  await mkdir(join(dir, "source"), { recursive: true });
  await writeFile(join(dir, "source", "provenance.json"), JSON.stringify({ sources: [{ source_id: "src-1", uri: "input/notes.md" }] }));
  return dir;
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-pipeline-"));
  env = { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_PLUGIN_DATA: join(tmp, "data") };
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("renderProject (tiny, silent, ffmpeg)", () => {
  let dir: string;
  let firstLock: VideoLock;
  const stages = new Set<string>();

  it(
    "renders dist/ end to end; auto voice falls back to silent when synthesis fails",
    async () => {
      dir = await makeProject("tiny");
      const r = await renderProject(dir, opts({ voice: "auto", voiceBackends: { system: failingSystem, elevenlabs: unavailableEleven }, onProgress: (p) => stages.add(p.stage) }));
      expect([...stages]).toEqual(expect.arrayContaining(["validate", "voice", "scenes", "captions", "assemble", "thumbnail", "qa", "export", "done"]));
      expect(r.voice.backend).toBe("silent");
      expect(r.voice.reason).toMatch(/system failed at synthesis .*say exited.*falling back to silent/);
      expect(r.renderer.used).toEqual(["ffmpeg-drawtext"]);
      expect(r.cache.scenes_rendered).toEqual(["s01", "s02", "s03"]);
      expect(r.cache.assembly).toBe("assembled");

      for (const f of ["reel.mp4", "clean-master.mp4", "captions.srt", "captions.vtt", "transcript.txt", "thumbnail.png", "social-copy.md", "render-manifest.json", "provenance.json"]) {
        expect((await stat(join(dir, "dist", f))).size, f).toBeGreaterThan(0);
      }
      const reel = await ffprobe(join(dir, "dist", "reel.mp4"));
      expect([reel.width, reel.height]).toEqual([180, 320]);
      expect(Math.abs(reel.duration_s - 3)).toBeLessThan(0.15);
      expect(reel.has_audio).toBe(true);
      const srt = await readFile(join(dir, "dist", "captions.srt"), "utf8");
      expect(srt).toContain("Search finds words.");
      expect(await readFile(join(dir, "dist", "transcript.txt"), "utf8")).toContain("Vectors find meaning.");

      const manifest = RenderManifest.parse(JSON.parse(await readFile(join(dir, "dist", "render-manifest.json"), "utf8")));
      expect(manifest.renders.map((x) => [x.scene_id, x.provider, x.status])).toEqual([
        ["s01", "ffmpeg-drawtext", "succeeded"],
        ["s02", "ffmpeg-drawtext", "succeeded"],
        ["s03", "ffmpeg-drawtext", "succeeded"],
      ]);
      expect(manifest.voice?.provider).toBe("silent");
      expect(manifest.voice?.timing_source).toBe("none");
      expect(manifest.tool_versions.ffmpeg).toBeTruthy();
      expect(manifest.tool_versions["ffmpeg-drawtext"]).toBe(FFMPEG_RENDERER_VERSION);
      expect(manifest.qa?.status).toBe(r.qa.status);
      expect(manifest.outputs.find((o) => o.kind === "final")?.path).toBe("dist/reel.mp4");
      expect(manifest.settings).toMatchObject({ quality: "preview", width: 180, height: 320, fps: 15 });
      // Captions sit inside the caption zone; the manifest records where, for lint.
      const zone = layoutZones({ width: 180, height: 320, aspect_ratio: "9:16" }).caption;
      const box = manifest.captions!.box!;
      expect(manifest.captions?.max_lines).toBe(2);
      expect(box.x).toBeGreaterThanOrEqual(zone.x);
      expect(box.y).toBeGreaterThanOrEqual(zone.y);
      expect(box.x + box.w).toBeLessThanOrEqual(zone.x + zone.w);
      expect(box.y + box.h).toBe(zone.y + zone.h);
      const ass = await readFile(join(dir, "renders", "preview", "captions", "captions.ass"), "utf8");
      expect(ass).toMatch(/,3,\d+,0,2,/); // plate (BorderStyle 3)
      expect(ass).not.toContain("\\kf"); // no karaoke by default
      expect(ass).toMatch(/Style: Default,Inter,/); // bundled font family
      // No spec.cover: no cover files, thumbnail as before.
      expect(manifest.outputs.filter((o) => o.kind === "thumbnail").map((o) => o.path)).toEqual(["dist/thumbnail.png"]);
      // One package for the primary target (youtube_shorts → youtube-shorts), copied, not re-encoded.
      expect(r.dist.targets.map((t) => [t.id, t.transcoded])).toEqual([["youtube-shorts", false]]);
      for (const f of ["video.mp4", "captions.srt", "captions.vtt", "post.json", "qa.json"]) {
        expect((await stat(join(dir, "dist", "youtube-shorts", f))).size, f).toBeGreaterThan(0);
      }
      expect(await readFile(join(dir, "dist", "youtube-shorts", "video.mp4"))).toEqual(await readFile(join(dir, "dist", "reel.mp4")));
      const post = JSON.parse(await readFile(join(dir, "dist", "youtube-shorts", "post.json"), "utf8"));
      expect(post).toMatchObject({ target: "youtube-shorts", source: "generated", captions: { files: ["captions.srt", "captions.vtt"] } });
      expect(post.hashtags).toContain("#Shorts");
      expect(post.full_text).toContain("Vector databases, tiny");
      const tqa = JSON.parse(await readFile(join(dir, "dist", "youtube-shorts", "qa.json"), "utf8"));
      expect(tqa).toMatchObject({ target: "youtube-shorts", quality: "preview", lint_report: "qa/lint.json" });
      expect(tqa.findings.every((f: { target?: string }) => !f.target || f.target === "youtube-shorts")).toBe(true);
      expect(manifest.outputs.filter((o) => o.target === "youtube-shorts").map((o) => [o.kind, o.path])).toEqual([
        ["final", "dist/youtube-shorts/video.mp4"],
        ["captions", "dist/youtube-shorts/captions.srt"],
        ["captions", "dist/youtube-shorts/captions.vtt"],
        ["post", "dist/youtube-shorts/post.json"],
        ["qa", "dist/youtube-shorts/qa.json"],
      ]);
      expect(manifest.outputs.find((o) => o.kind === "spec")?.path).toBe("dist/video-spec.json");

      const qa = JSON.parse(await readFile(join(dir, "qa", "report.json"), "utf8"));
      expect(qa.checks.find((c: { id: string }) => c.id === "resolution").status).toBe("ok");
      expect(qa.checks.find((c: { id: string }) => c.id === "duration").status).toBe("ok");
      expect(r.qa.status).not.toBe("fail");

      const prov = JSON.parse(await readFile(join(dir, "dist", "provenance.json"), "utf8"));
      expect(prov.sources[0].uri).toBe("input/notes.md");
      expect(prov.render.scenes.map((s: { scene_id: string }) => s.scene_id)).toEqual(["s01", "s02", "s03"]);
      expect(await readFile(join(dir, "dist", "social-copy.md"), "utf8")).toMatch(/# Vector databases, tiny[\s\S]*#Shorts/);

      // video.lock: versions and hashes, relative paths only, listed in the manifest.
      const lockText = await readFile(r.dist.lock, "utf8");
      firstLock = (await readLock(r.dist.lock))!;
      expect(firstLock).toMatchObject({ project_id: manifest.project_id, quality: "preview", spec_sha256: manifest.spec_sha256, voice: { backend: "silent" } });
      expect(firstLock.engine).toMatchObject({ engine: "0.1.0", assembly: String(ASSEMBLY_VERSION), target_package: "1" });
      expect(firstLock.tools["ffmpeg-drawtext"]).toBe(FFMPEG_RENDERER_VERSION);
      expect(firstLock.tools["video-studio-engine"]).toBeUndefined();
      expect(firstLock.fonts).toContainEqual({ family: "Inter", weight: 700, file: "fonts/Inter/Inter-Bold.ttf", sha256: "288316099b1e0a47a4716d159098005eef7c0066921f34e3200393dbdb01947f" });
      expect(firstLock.targets).toEqual([{ id: "youtube-shorts", contract_version: expect.any(Number), verified: expect.any(String) }]);
      expect(firstLock.scenes.map((x) => [x.scene_id, x.clip_sha256])).toEqual(manifest.renders.map((x) => [x.scene_id, x.output_sha256]));
      expect(firstLock.assets.map((a) => a.path)).toEqual(["source/provenance.json"]);
      expect(firstLock.outputs.map((o) => o.path)).toContain("dist/youtube-shorts/video.mp4");
      expect(firstLock.outputs.find((o) => o.path === "dist/youtube-shorts/post.json")?.target).toBe("youtube-shorts");
      expect(firstLock.outputs.some((o) => /video\.lock|render-manifest/.test(o.path))).toBe(false);
      expect(lockText).not.toContain(tmp);
      expect(lockText).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(manifest.outputs.find((o) => o.kind === "lock")?.path).toBe("dist/video.lock");
      // A per-quality copy lets diff compare preview and final.
      expect(await readFile(join(dir, "renders", "preview", "video.lock"), "utf8")).toBe(await readFile(join(dir, "dist", "video.lock"), "utf8"));
    },
    T,
  );

  it(
    "second run is a cache hit: no scene re-render, assembly reused",
    async () => {
      const sidecar = join(dir, "renders", "preview", "scenes", "s01.mp4");
      const before = (await stat(sidecar)).mtimeMs;
      const reelBefore = (await stat(join(dir, "renders", "preview", "reel.mp4"))).mtimeMs;
      const r = await renderProject(dir, opts({ voice: "silent" }));
      expect(r.cache.scenes_rendered).toEqual([]);
      expect(r.cache.scenes_cached).toEqual(["s01", "s02", "s03"]);
      expect(r.cache.assembly).toBe("reused");
      expect((await stat(sidecar)).mtimeMs).toBe(before);
      expect((await stat(join(dir, "renders", "preview", "reel.mp4"))).mtimeMs).toBe(reelBefore);
      const manifest = RenderManifest.parse(JSON.parse(await readFile(join(dir, "dist", "render-manifest.json"), "utf8")));
      expect(manifest.renders.every((x) => x.status === "cached")).toBe(true);
      // Same inputs: only the provenance (which carries the render time) differs.
      const changes = diffLocks(firstLock, (await readLock(r.dist.lock))!);
      expect(changes.map((c) => [c.class, c.path])).toEqual([["metadata", "outputs.dist/provenance.json.sha256"]]);
    },
    T,
  );

  it(
    "qa_run and export work from existing renders",
    async () => {
      const q = await runQa(dir);
      expect(q.quality).toBe("preview");
      expect(["pass", "warn"]).toContain(q.qa.status);
      await rm(join(dir, "dist"), { recursive: true, force: true });
      const e = await exportProject(dir);
      expect((await stat(e.dist.reel)).size).toBeGreaterThan(0);
      // Re-exporting an unchanged render writes a byte-identical lock.
      const lockBefore = await readFile(e.dist.lock);
      await exportProject(dir);
      expect(await readFile(e.dist.lock)).toEqual(lockBefore);

      // Retarget and re-export without re-rendering: new packages appear, the old one is removed.
      const specPath = join(dir, "project", "video-spec.json");
      const s = JSON.parse(await readFile(specPath, "utf8"));
      s.targets = ["instagram", "tiktok"];
      s.publish = { tiktok: { post_caption: "Vectors find meaning, not words.", hashtags: ["#vectordb"], ai_disclosure: true } };
      await writeFile(specPath, JSON.stringify(s, null, 2));
      const e2 = await exportProject(dir);
      expect(e2.dist.targets.map((t) => t.id)).toEqual(["instagram", "tiktok"]);
      const retarget = diffLocks(VideoLock.parse(JSON.parse(lockBefore.toString("utf8"))), (await readLock(e2.dist.lock))!);
      expect(retarget.filter((c) => c.path.startsWith("targets.")).map((c) => [c.class, c.path])).toEqual([
        ["spec", "targets.instagram"],
        ["spec", "targets.tiktok"],
        ["spec", "targets.youtube-shorts"],
      ]);
      await expect(stat(join(dir, "dist", "youtube-shorts"))).rejects.toThrow();
      const tk = JSON.parse(await readFile(join(dir, "dist", "tiktok", "post.json"), "utf8"));
      expect(tk).toMatchObject({
        source: "spec",
        full_text: "Vectors find meaning, not words.\n\n#vectordb",
        ai_disclosure: { requested: true, supported: true, field: "is_aigc" },
        cover: { mode: "frame" },
      });
      const ig = JSON.parse(await readFile(join(dir, "dist", "instagram", "post.json"), "utf8"));
      expect(ig.source).toBe("generated");
      expect(ig.hashtags).toContain("#Reels");
      expect(ig.hashtags).not.toContain("#Shorts");
    },
    T,
  );

  it("refuses an invalid spec with its errors", async () => {
    const bad = await makeProject("bad", { ...spec, target_duration_sec: 30 });
    await expect(renderProject(bad, opts({ voice: "silent" }))).rejects.toBeInstanceOf(SpecInvalidError);
    await expect(renderProject(bad, opts({ voice: "silent" }))).rejects.toThrow(/scene durations sum to 3s/);
  });

  it("explicit voice backend failure is an actionable error", async () => {
    const d = await makeProject("explicit-fail");
    await expect(renderProject(d, opts({ voice: "system", voiceBackends: { system: failingSystem } }))).rejects.toThrow(/voice backend "system" failed: say exited.*silent/);
  });
});

describe("cover and caption styling", () => {
  it(
    "composes the cover from spec.cover, applies brand captions and position.y, and caches the cover",
    async () => {
      const dir = await makeProject("cover", { ...spec, cover: { headline: "Search by meaning", focal_time_sec: 0.5 }, captions: { preset: "bold", burn_in: true, position: { y: 0.5 } } });
      await writeFile(join(dir, "brand.yaml"), "version: 2\nbrand:\n  name: Test\ncaptions:\n  active_word: true\n  plate_opacity: 0.7\n  max_lines: 1\n");
      const r = await renderProject(dir, opts({ voice: "silent" }));
      expect(r.dist.cover).toBe(join(dir, "dist", "cover.jpg"));
      const cover = await ffprobe(r.dist.cover!);
      expect([cover.width, cover.height, cover.video_codec]).toEqual([180, 320, "mjpeg"]);
      const sq = await ffprobe(r.dist.cover_square_preview!);
      expect([sq.width, sq.height]).toEqual([180, 180]);
      const manifest = RenderManifest.parse(JSON.parse(await readFile(join(dir, "dist", "render-manifest.json"), "utf8")));
      expect(manifest.outputs.filter((o) => o.kind === "thumbnail" && !o.target).map((o) => o.path)).toEqual(["dist/thumbnail.png", "dist/cover.jpg"]);
      expect(manifest.outputs.find((o) => o.kind === "thumbnail" && o.target === "youtube-shorts")?.path).toBe("dist/youtube-shorts/cover.jpg");
      expect(manifest.outputs.find((o) => o.path === "dist/cover-square-preview.jpg")).toMatchObject({ kind: "other", width: 180, height: 180 });
      expect(manifest.captions?.max_lines).toBe(1);
      const box = manifest.captions!.box!;
      expect(Math.abs(box.y + box.h / 2 - 160)).toBeLessThanOrEqual(1);
      const ass = await readFile(join(dir, "renders", "preview", "captions", "captions.ass"), "utf8");
      expect(ass).toContain("\\kf");
      expect(ass).toMatch(/\{\\an5\\pos\(\d+,160\)\}/); // centred on position.y (x: the caption zone's centre)
      expect(ass).toContain("&H4C000000"); // 70% plate
      const state = JSON.parse(await readFile(join(dir, "renders", "preview", "render-state.json"), "utf8"));
      expect(state.cover.headline_box).toMatchObject({ role: "headline", text: "Search by meaning" });
      expect(state.cover.at_ms).toBe(500);
      expect(state.caption_layout.max_lines).toBe(1);

      const mtime = (await stat(join(dir, "renders", "preview", "cover.jpg"))).mtimeMs;
      const again = await renderProject(dir, opts({ voice: "silent" }));
      expect(again.cache.assembly).toBe("reused");
      expect((await stat(join(dir, "renders", "preview", "cover.jpg"))).mtimeMs).toBe(mtime);

      // Dropping spec.cover goes back to the plain thumbnail and removes the cover files.
      await writeFile(join(dir, "project", "video-spec.json"), JSON.stringify({ ...spec, captions: { preset: "bold", burn_in: true, position: { y: 0.5 } } }, null, 2));
      const plain = await renderProject(dir, opts({ voice: "silent" }));
      expect(plain.dist.cover).toBeUndefined();
      await expect(stat(join(dir, "dist", "cover.jpg"))).rejects.toThrow();
      await expect(stat(join(dir, "renders", "preview", "cover.jpg"))).rejects.toThrow();
    },
    T,
  );
});

describe("style packs", () => {
  it(
    "renders with style: energetic; the look reaches the clips, the state and video.lock",
    async () => {
      const dir = await makeProject("styled", { ...spec, style: "energetic" });
      const r = await renderProject(dir, opts({ voice: "silent" }));
      const state = JSON.parse(await readFile(join(dir, "renders", "preview", "render-state.json"), "utf8"));
      expect(state.style).toBe("energetic@1");
      expect(state.tool_versions.style).toBe("energetic@1");
      expect(state.background).toBe("#160B33");
      const hook = state.scenes[0].text_boxes.find((b: { role: string }) => b.role === "hook");
      expect(hook.text).toBe("SEARCH FINDS WORDS");
      expect(hook.color).toBe("#FFFFFF");
      const lock = (await readLock(r.dist.lock))!;
      expect(lock.tools.style).toBe("energetic@1");
      // Bundled Inter Bold for the 800 heading, Regular for the 500 body (the lock records bundled weights).
      expect(lock.fonts.map((f) => `${f.family}@${f.weight}:${f.file}`)).toEqual(expect.arrayContaining(["Inter@700:fonts/Inter/Inter-Bold.ttf", "Inter@400:fonts/Inter/Inter-Regular.ttf"]));

      // Switching the style changes the scene cache keys (the tokens are part of them).
      await writeFile(join(dir, "project", "video-spec.json"), JSON.stringify({ ...spec, style: "minimal" }, null, 2));
      const m = await renderProject(dir, opts({ voice: "silent" }));
      const lock2 = (await readLock(m.dist.lock))!;
      expect(lock2.tools.style).toBe("minimal@1");
      expect(lock2.scenes.map((x) => x.cache_key)).not.toEqual(lock.scenes.map((x) => x.cache_key));
    },
    T,
  );

  it("refuses an unknown style with the available ids", async () => {
    const bad = await makeProject("bad-style", { ...spec, style: "energtic" });
    const err = await renderProject(bad, opts({ voice: "silent" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpecInvalidError);
    expect(String((err as Error).message)).toMatch(/no style pack "energtic".*available: .*energetic.*minimal/s);
    const v = await validateSpecFile(join(bad, "project", "video-spec.json"), null);
    expect(v.ok).toBe(false);
    expect(v.errors).toContainEqual(expect.objectContaining({ path: "style", stage: "style", fix: expect.stringContaining('"energetic"') }));
  });
});

describe("music bed and voice.mode none", () => {
  it(
    "renders a text-over-music reel: bundled bed, no speech, rights recorded, no silence warnings",
    async () => {
      const s: VideoSpec = structuredClone(spec);
      s.voice = { mode: "none" };
      s.audio = { music: { file: "bundled:minimal", fade_in_ms: 200, fade_out_ms: 300 } };
      for (const sc of s.scenes) {
        sc.on_screen_text = sc.voiceover;
        sc.voiceover = "";
      }
      const dir = await makeProject("music-none", s);
      const r = await renderProject(dir, opts({ voice: "auto", voiceBackends: { system: failingSystem, elevenlabs: unavailableEleven } }));
      expect(r.voice.backend).toBe("silent");
      expect(r.voice.reason).toMatch(/voice\.mode is "none"/);
      expect(r.warnings.join("\n")).not.toMatch(/captions and transcript skipped/);
      const probe = await ffprobe(r.dist.reel);
      expect(probe.has_audio).toBe(true);
      expect(r.qa.findings.map((f) => f.id)).not.toContain("silence");
      const manifest = RenderManifest.parse(JSON.parse(await readFile(join(dir, "dist", "render-manifest.json"), "utf8")));
      expect(manifest.music).toMatchObject({ file: "bundled:minimal", title: "Minimal pulse", license: { id: "CC0-1.0" } });
      const lock = JSON.parse(await readFile(join(dir, "dist", "video.lock"), "utf8"));
      expect(lock.assets.find((a: { path: string }) => a.path === "bundled:minimal")?.sha256).toBe(manifest.music!.sha256);
      const prov = JSON.parse(await readFile(join(dir, "dist", "provenance.json"), "utf8"));
      expect(prov.render.music).toMatchObject({ file: "bundled:minimal", license: { id: "CC0-1.0" } });
      expect(prov.render.voice.mode).toBe("none");
      const post = JSON.parse(await readFile(join(dir, "dist", "youtube-shorts", "post.json"), "utf8"));
      expect(post.sound).toMatchObject({ music: "Minimal pulse", license: "CC0-1.0", note: expect.stringMatching(/Trending sounds/) });
    },
    T,
  );

  it(
    "silent on purpose (voice.mode none, no music) passes silence and loudness QA",
    async () => {
      const s: VideoSpec = structuredClone(spec);
      s.voice = { mode: "none" };
      for (const sc of s.scenes) sc.voiceover = "";
      const dir = await makeProject("silent-on-purpose", s);
      const r = await renderProject(dir, opts());
      const ids = r.qa.findings.map((f) => f.id);
      expect(ids).not.toContain("silence");
      expect(ids).not.toContain("loudness");
    },
    T,
  );

  it(
    "mixes a user music file under narration and changes the assembly when the bed changes",
    async () => {
      const s: VideoSpec = structuredClone(spec);
      s.audio = { music: { file: "assets/bed.wav", license: { id: "user-owned" } } };
      const dir = await makeProject("music-narrated", s);
      await mkdir(join(dir, "assets"), { recursive: true });
      await runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=1", join(dir, "assets", "bed.wav")]);
      const r = await renderProject(dir, opts({ voice: "system", voiceBackends: { system: longSystem } }));
      expect(r.cache.assembly).toBe("assembled");
      const manifest = RenderManifest.parse(JSON.parse(await readFile(join(dir, "dist", "render-manifest.json"), "utf8")));
      expect(manifest.music).toMatchObject({ file: "assets/bed.wav", license: { id: "user-owned" } });
      const again = await renderProject(dir, opts({ voice: "system", voiceBackends: { system: longSystem } }));
      expect(again.cache.assembly).toBe("reused");
      s.audio.music!.volume_db = -24;
      await writeFile(join(dir, "project", "video-spec.json"), JSON.stringify(s, null, 2));
      expect((await renderProject(dir, opts({ voice: "system", voiceBackends: { system: longSystem } }))).cache.assembly).toBe("assembled");
    },
    T,
  );
});

describe("voice overrun", () => {
  it(
    "extends the scene in the render plan only and records it",
    async () => {
      const dir = await makeProject("overrun");
      const specText = await readFile(join(dir, "project", "video-spec.json"), "utf8");
      const r = await renderProject(dir, opts({ voice: "system", voiceBackends: { system: longSystem } }));
      expect(r.voice.backend).toBe("system");
      expect(r.timing_adjustments).toEqual([expect.objectContaining({ scene_id: "s01", spec_duration_sec: 1, render_duration_sec: 2.1 })]);
      expect(Math.abs(r.duration_sec - 4.1)).toBeLessThan(0.07);
      const reel = await ffprobe(join(dir, "dist", "reel.mp4"));
      expect(Math.abs(reel.duration_s - 4.1)).toBeLessThan(0.15);
      expect(r.qa.findings.find((f) => f.id === "duration")).toBeUndefined();
      const clip = await ffprobe(join(dir, "renders", "preview", "scenes", "s01.mp4"));
      expect(Math.abs(clip.duration_s - 2.1)).toBeLessThan(0.1);
      const manifest = RenderManifest.parse(JSON.parse(await readFile(join(dir, "dist", "render-manifest.json"), "utf8")));
      expect(manifest.timing_adjustments?.[0]?.scene_id).toBe("s01");
      expect(manifest.voice?.timing_source).toBe("estimated");
      // The spec on disk is untouched.
      expect(await readFile(join(dir, "project", "video-spec.json"), "utf8")).toBe(specText);
    },
    T,
  );
});

describe("render job tools (in-memory MCP client)", () => {
  it(
    "render_submit returns a job id; job_status polls to success; qa_run and export work",
    async () => {
      let firstJob = "";
      const dir = join(tmp, "job-proj");
      await cp(join(tmp, "tiny"), dir, { recursive: true });
      const jobs = new RenderJobManager({ env, ledgerPath: join(tmp, "ledger.sqlite"), renderDefaults: opts({ voice: "silent" }) });
      const server = createServer({ jobs, cwd: () => tmp, env });
      const client = new Client({ name: "test", version: "0.0.0" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(st), client.connect(ct)]);
      try {
        const sub = (await client.callTool({ name: "render_submit", arguments: { project_dir: "job-proj", voice: "silent", renderer: "ffmpeg" } })) as CallToolResult;
        expect(sub.isError).toBeFalsy();
        const jobId = (sub.structuredContent as { job_id: string }).job_id;
        firstJob = jobId;
        expect(jobId).toMatch(/^render-/);
        const second = (await client.callTool({ name: "render_submit", arguments: { project_dir: dir } })) as CallToolResult;
        const jobId2 = (second.structuredContent as { job_id: string }).job_id;

        let st1: Record<string, unknown> = {};
        for (let i = 0; i < 600; i++) {
          const res = (await client.callTool({ name: "job_status", arguments: { job_id: jobId } })) as CallToolResult;
          st1 = res.structuredContent as Record<string, unknown>;
          if (st1.status === "succeeded" || st1.status === "failed") break;
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(st1.status, JSON.stringify(st1.error)).toBe("succeeded");
        const result = st1.result as { dist: { reel: string }; voice: { backend: string }; renderer: { used: string[] } };
        expect(result.dist.reel).toBe(join(dir, "dist", "reel.mp4"));
        expect(result.voice.backend).toBe("silent");
        await jobs.idle();
        const s2 = (await client.callTool({ name: "job_status", arguments: { job_id: jobId2 } })) as CallToolResult;
        expect((s2.structuredContent as { status: string }).status).toBe("succeeded");

        const qa = (await client.callTool({ name: "qa_run", arguments: { project_dir: dir } })) as CallToolResult;
        expect(qa.isError).toBeFalsy();
        const ex = (await client.callTool({ name: "export", arguments: { project_dir: dir } })) as CallToolResult;
        expect(ex.isError).toBeFalsy();

        const unknown = (await client.callTool({ name: "job_status", arguments: { job_id: "render-nope" } })) as CallToolResult;
        expect(unknown.isError).toBe(true);

        // Invalid spec: refused synchronously with errors.
        const bad = (await client.callTool({ name: "render_submit", arguments: { project_dir: join(tmp, "bad") } })) as CallToolResult;
        expect(bad.isError).toBe(true);
        expect((bad.structuredContent as { errors: unknown[] }).errors.length).toBeGreaterThan(0);
      } finally {
        await client.close();
        await jobs.close();
      }
      // A fresh manager (server restart) still knows the finished job via the ledger.
      const again = new RenderJobManager({ env, ledgerPath: join(tmp, "ledger.sqlite") });
      expect(again.status(firstJob)?.status).toBe("succeeded");
      await again.close();
    },
    T,
  );
});

describe("voice fallback after a synthesis failure", () => {
  const failingEleven: VoiceBackend = {
    id: "elevenlabs",
    available: () => ({ ok: true, reason: "key set" }),
    synthesize: async () => {
      throw new Error("ElevenLabs 401 invalid api key");
    },
  };

  it(
    "auto: a failing ElevenLabs falls back to the system voice, not straight to silent",
    async () => {
      const dir = await makeProject("voice-fallback");
      const r = await renderProject(dir, opts({ voice: "auto", voiceBackends: { system: longSystem, elevenlabs: failingEleven } }));
      expect(r.voice.backend).toBe("system");
      expect(r.voice.has_audio).toBe(true);
      expect(r.voice.reason).toMatch(/using elevenlabs .*elevenlabs failed at synthesis \(ElevenLabs 401 invalid api key\); fell back to the system voice \(fake say\)/);
      expect(r.voice.reason).not.toMatch(/silent/);
    },
    T,
  );

  it(
    "auto: when the system voice fails too, the reason says so before falling back to silent",
    async () => {
      const dir = await makeProject("voice-fallback-silent");
      const r = await renderProject(dir, opts({ voice: "auto", voiceBackends: { system: failingSystem, elevenlabs: failingEleven } }));
      expect(r.voice.backend).toBe("silent");
      expect(r.voice.reason).toMatch(/elevenlabs failed at synthesis .*; system also failed at synthesis \(say exited with code 1\); falling back to silent \(no audio\)/);
    },
    T,
  );
});

describe("examples/text-to-motion-graphic", () => {
  it("is a valid, fully motion-graphic 30 s 9:16 project grounded in its committed ContentIR", async () => {
    const dir = join(import.meta.dirname, "../../../examples/text-to-motion-graphic");
    const { spec: s, warnings } = await loadValidSpec(dir);
    expect(warnings).toEqual([]);
    expect(s.aspect_ratio).toBe("9:16");
    expect(s.scenes.reduce((a, x) => a + x.duration_sec, 0)).toBe(30);
    expect(s.scenes.every((x) => x.visual_strategy === "motion_graphic" && x.claim_refs.length > 0)).toBe(true);
  });
});

describe("socialCopy (pure)", () => {
  it("is deterministic and uses brief fields", () => {
    const brief = {
      schema_version: "1.0",
      goal: "explain",
      audience: "devs",
      platform: "youtube_shorts",
      aspect_ratio: "9:16",
      target_duration_sec: 3,
      language: "en-US",
      tone: [],
      desired_action: "Try semantic search on your docs",
      key_messages: ["Vectors capture meaning."],
      hook_candidates: [{ text: "h", mechanism: "question", scores: {} }],
      chosen_hook: "h",
      assumptions: [],
    } as const;
    const md = socialCopy(spec, { ...brief, tone: [], key_messages: [...brief.key_messages], hook_candidates: [...brief.hook_candidates], assumptions: [] });
    expect(socialCopy(spec, { ...brief, tone: [], key_messages: [...brief.key_messages], hook_candidates: [...brief.hook_candidates], assumptions: [] })).toBe(md);
    expect(md).toContain("# Vector databases, tiny");
    expect(md).toContain("Search finds words.");
    expect(md).toContain("Vectors capture meaning.");
    expect(md).toContain("Try semantic search on your docs");
    expect(md).toMatch(/#Vector #Databases .*#Shorts/);
  });
});

describe("footage scenes, scene audio, native voice and beat sync", () => {
  const TRANSCRIPT = [
    { word: "Hello", start_ms: 600, end_ms: 900 },
    { word: "world.", start_ms: 1000, end_ms: 1300 },
    { word: "Second", start_ms: 2100, end_ms: 2400 },
    { word: "clip.", start_ms: 2500, end_ms: 2800 },
    { word: "Unused", start_ms: 3700, end_ms: 3900 },
  ];

  /** A project with a 4 s 320x240 lavfi clip (testsrc2 + 330 Hz tone), its transcript and a sfx file. */
  async function footageProject(name: string, s: VideoSpec): Promise<string> {
    const dir = await makeProject(name, s);
    const clip = join(dir, "assets", "supplied", "clip.mp4");
    await mkdir(join(dir, "assets", "supplied"), { recursive: true });
    await runFfmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=320x240:r=15:d=4",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=330:sample_rate=48000:duration=4",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      clip,
    ]);
    await writeFile(join(dir, "source", "clip.words.json"), JSON.stringify(TRANSCRIPT));
    await mkdir(join(dir, "assets", "sfx"), { recursive: true });
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=1500:sample_rate=48000:duration=0.08", join(dir, "assets", "sfx", "pop.wav")]);
    const ir = {
      schema_version: "1.0",
      id: "ir-footage",
      created_at: "2026-09-25T00:00:00.000Z",
      sources: [{ id: "src-1", kind: "video", uri: "input/clip.mp4", sha256: "0".repeat(64), title: "clip" }],
      sections: [],
      evidence: [],
      entities: [],
      claims: [],
      assets: [
        {
          id: "v1",
          kind: "video",
          path: "assets/supplied/clip.mp4",
          sha256: "0".repeat(64),
          media: { duration_sec: 4, width: 320, height: 240, fps: 15, has_video: true, has_audio: true, transcript: { path: "source/clip.words.json", source: "whisper", words: 5 } },
        },
      ],
      classification: { contains_secrets: false, contains_pii: false, contains_likeness: false, data_class: "internal", notes: [] },
      warnings: [],
    };
    await writeFile(join(dir, "source", "content-ir.json"), JSON.stringify(ir, null, 2));
    return dir;
  }

  const footageScene = (id: string, extra: Partial<VideoSpec["scenes"][number]>): VideoSpec["scenes"][number] => ({
    id,
    duration_sec: 1.5,
    purpose: "point",
    voiceover: "",
    visual_strategy: "user_asset",
    visual_requirements: { continuity_refs: [] },
    claim_refs: [],
    ...extra,
  });

  const nativeSpec = (): VideoSpec => ({
    ...structuredClone(spec),
    id: "footage-native",
    voice: { mode: "native" },
    audio: { music: { file: "bundled:minimal", fade_in_ms: 100, fade_out_ms: 200 } },
    scenes: [
      footageScene("s01", {
        purpose: "hook",
        footage: { asset: "v1", in_sec: 0.5 },
        audio: { mode: "native" },
        deterministic: { kind: "lower_third", props: { name: "Ada Lovelace", title: "Engineer" } },
        sfx: [{ file: "assets/sfx/pop.wav", at_sec: 0.2, volume_db: -6, license: { id: "CC0-1.0", source: "synthesized" } }],
      }),
      footageScene("s02", { purpose: "cta", footage: { asset: "v1", in_sec: 2, fit: "blur_pad" }, audio: { mode: "mix", crossfade_ms: 200 } }),
    ],
  });

  it(
    "renders footage with native sound under a bed, captions from the transcript, and records the assets",
    async () => {
      const s = nativeSpec();
      const dir = await footageProject("footage-native", s);
      const v = await validateSpecFile(join(dir, "project", "video-spec.json"), join(dir, "source", "content-ir.json"));
      expect(v.errors).toEqual([]);
      const r = await renderProject(dir, opts());
      expect(r.voice.reason).toMatch(/voice\.mode is "native"/);
      expect(r.voice.timing_source).toBe("aligned");
      expect(r.duration_sec).toBe(3);
      expect(r.renderer.used).toContain("ffmpeg-footage");
      expect(r.placeholders).toEqual([]);
      const probe = await ffprobe(r.dist.reel);
      expect(probe.has_audio).toBe(true);
      expect(Math.abs(probe.duration_s - 3)).toBeLessThan(0.1);
      expect(r.qa.findings.map((f) => f.id)).not.toContain("silence");

      // Captions: the transcript words inside each span, shifted onto the reel timeline.
      const cj = JSON.parse(await readFile(join(dir, "renders", "preview", "captions", "captions.json"), "utf8"));
      const flat = JSON.stringify(cj);
      for (const w of ["Hello", "world", "Second", "clip"]) expect(flat).toContain(w);
      expect(flat).not.toContain("Unused");
      const srt = await readFile(r.dist.captions_srt!, "utf8");
      // "Hello" is at 0.6 s in the asset, 0.1 s into s01 (in_sec 0.5); "Second" at 2.1 s → 0.1 s into s02,
      // which starts at 1.533 s (1.5 s = 22.5 frames at 15 fps, rounded on the cumulative timeline).
      expect(srt).toMatch(/00:00:00,100 -->/);
      expect(srt).toMatch(/00:00:01,633 -->/);

      const state = JSON.parse(await readFile(join(dir, "renders", "preview", "render-state.json"), "utf8"));
      expect(state.voice_mode).toBe("native");
      expect(state.scene_audio).toBe(true);
      expect(state.scenes[0].renderer).toBe("ffmpeg-footage");
      expect(state.scenes[0].text_boxes.map((b: { text: string }) => b.text)).toContain("Ada Lovelace");
      const lock = JSON.parse(await readFile(join(dir, "dist", "video.lock"), "utf8"));
      const paths = lock.assets.map((a: { path: string }) => a.path);
      expect(paths).toContain("assets/supplied/clip.mp4");
      expect(paths).toContain("assets/sfx/pop.wav");
      expect(paths.filter((p: string) => p === "assets/supplied/clip.mp4").length).toBe(1);
      const prov = JSON.parse(await readFile(join(dir, "dist", "provenance.json"), "utf8"));
      expect(prov.render.footage).toEqual([expect.objectContaining({ asset: "v1", file: "assets/supplied/clip.mp4", scenes: ["s01", "s02"] })]);
      expect(prov.render.sfx).toEqual([expect.objectContaining({ file: "assets/sfx/pop.wav", license: { id: "CC0-1.0", source: "synthesized" } })]);
      expect(prov.render.voice.mode).toBe("native");

      // Unchanged inputs reuse everything; a new in_sec re-renders that clip and the mix.
      const again = await renderProject(dir, opts());
      expect(again.cache.assembly).toBe("reused");
      expect(again.cache.scenes_cached).toEqual(["s01", "s02"]);
      s.scenes[1]!.footage!.in_sec = 2.2;
      await writeFile(join(dir, "project", "video-spec.json"), JSON.stringify(s, null, 2));
      const moved = await renderProject(dir, opts());
      expect(moved.cache.scenes_rendered).toEqual(["s02"]);
      expect(moved.cache.assembly).toBe("assembled");
    },
    T,
  );

  it(
    "unresolvable footage renders as a placeholder with the reason",
    async () => {
      const s = nativeSpec();
      // s02 points its footage at an audio asset.
      s.scenes[1]!.footage = { asset: "a2", in_sec: 0 };
      const dir = await footageProject("footage-missing", s);
      const irPath = join(dir, "source", "content-ir.json");
      const ir = JSON.parse(await readFile(irPath, "utf8"));
      ir.assets.push({ id: "a2", kind: "audio", path: "assets/sfx/pop.wav", sha256: "0".repeat(64), media: { duration_sec: 0.08, has_video: false, has_audio: true } });
      await writeFile(irPath, JSON.stringify(ir, null, 2));
      await rm(join(dir, "assets", "supplied", "clip.mp4"));
      const r = await renderProject(dir, opts());
      expect(r.placeholders).toEqual(["s01", "s02"]);
      const state = JSON.parse(await readFile(join(dir, "renders", "preview", "render-state.json"), "utf8"));
      expect(state.scenes[0].reason).toMatch(/footage asset "v1": file assets\/supplied\/clip\.mp4 is missing/);
      expect(state.scenes[1].reason).toBe('footage asset "a2": is audio; footage needs a video or image asset');
      // The warnings say exactly why, never that a video provider is coming.
      expect(r.warnings).toContain('s02: placeholder card instead of footage: footage asset "a2": is audio; footage needs a video or image asset');
      expect(r.warnings.some((w) => w.startsWith("s01: placeholder card instead of footage:") && w.includes("is missing"))).toBe(true);
      expect(r.warnings.join("\n")).not.toMatch(/Phase 7|provider/);
    },
    T,
  );

  it(
    "a cutaway draws its graphic over the clip's sound, with word cues from the transcript",
    async () => {
      const s = nativeSpec();
      s.audio = undefined;
      s.scenes[1] = footageScene("s02", {
        purpose: "cta",
        visual_strategy: "motion_graphic",
        footage: { asset: "v1", in_sec: 2, cutaway: true },
        audio: { mode: "native" },
        deterministic: { kind: "kinetic_text", props: { text: "Second clip", rhythm: "word" } },
        cues: [{ word: "second" }, { word: "clip" }],
      });
      const dir = await footageProject("footage-cutaway", s);
      const v = await validateSpecFile(join(dir, "project", "video-spec.json"), join(dir, "source", "content-ir.json"));
      expect(v.errors).toEqual([]);
      const r = await renderProject(dir, opts());
      expect(r.placeholders).toEqual([]);
      expect(r.warnings.filter((w) => w.startsWith("cues:"))).toEqual([]);
      const state = JSON.parse(await readFile(join(dir, "renders", "preview", "render-state.json"), "utf8"));
      expect(state.scenes[0].renderer).toBe("ffmpeg-footage");
      expect(state.scenes[1].renderer).toBe("ffmpeg-drawtext");
      // "Second" is at 2.1 s and "clip." at 2.5 s in the asset: 0.1 s and 0.5 s into the cutaway (in_sec 2).
      expect(state.cues).toEqual([
        { scene_id: "s02", word: "second", item: 0, at_ms: 100, status: "placed" },
        { scene_id: "s02", word: "clip", item: 1, at_ms: 500, status: "placed" },
      ]);
      // The clip's sound and words still play under the graphic.
      expect(state.scene_audio).toBe(true);
      expect((await ffprobe(r.dist.reel)).has_audio).toBe(true);
      const cj = JSON.stringify(JSON.parse(await readFile(join(dir, "renders", "preview", "captions", "captions.json"), "utf8")));
      expect(cj).toContain("Second");
    },
    T,
  );

  it(
    "beat sync moves a cut onto the nearest beat and records a timing adjustment",
    async () => {
      const s: VideoSpec = structuredClone(spec);
      s.voice = { mode: "none" };
      s.scenes = [
        { ...structuredClone(spec.scenes[0]!), voiceover: "", duration_sec: 1.4 },
        { ...structuredClone(spec.scenes[2]!), voiceover: "", duration_sec: 1.6 },
      ];
      s.audio = { music: { file: "assets/click.wav", license: { id: "user-owned" } }, beat_sync: { enabled: true } };
      const dir = await makeProject("beat-sync", s);
      await mkdir(join(dir, "assets"), { recursive: true });
      // 120 bpm clicks from 0.25 s: beats at 0.25, 0.75, 1.25, 1.75 … The 1.4 s cut is 150 ms from 1.25.
      const expr = "if(gte(t\\,0.25)*lt(mod(t-0.25\\,0.5)\\,0.01)\\,0.8*sin(2*PI*1000*t)\\,0)";
      await runFfmpeg(["-y", "-f", "lavfi", "-i", `aevalsrc=${expr}:s=48000:d=4`, "-c:a", "pcm_s16le", join(dir, "assets", "click.wav")]);
      const r = await renderProject(dir, opts());
      expect(r.duration_sec).toBe(3);
      const a = r.timing_adjustments.find((t) => t.scene_id === "s01");
      expect(a).toMatchObject({ spec_duration_sec: 1.4, reason: expect.stringMatching(/beat sync \((119|120|121)(\.\d)? bpm\): end 1\.4s → 1\.2[4-6]\d*s onto the nearest beat/) });
      expect(Math.abs(a!.render_duration_sec - 1.25)).toBeLessThanOrEqual(0.03);
      expect(r.timing_adjustments.find((t) => t.scene_id === "s03")?.render_duration_sec).toBeCloseTo(3 - a!.render_duration_sec, 3);
      const manifest = RenderManifest.parse(JSON.parse(await readFile(join(dir, "dist", "render-manifest.json"), "utf8")));
      expect(manifest.timing_adjustments?.length).toBe(2);
      // The spec itself is unchanged.
      expect(JSON.parse(await readFile(join(dir, "project", "video-spec.json"), "utf8")).scenes[0].duration_sec).toBe(1.4);
    },
    T,
  );
});

describe("sound-event cues (pure)", () => {
  const w = (start_ms: number, end_ms: number) => ({ start_ms, end_ms });
  const scenes = [
    { id: "s01", start_ms: 0, end_ms: 3000 },
    { id: "s02", start_ms: 3000, end_ms: 8000 },
  ];

  it("[music] only where the bed plays alone for 2 s or more, after a settle, capped", () => {
    const cues = soundEventCues({ scenes, speech: [w(0, 1000), w(1000, 2500), w(7000, 7800)], music: true, total_ms: 8000 });
    // gap 2500–7000 (4.5 s): cue from 2800, at most 3 s
    expect(cues).toEqual([{ word: "[music]", start_ms: 2800, end_ms: 5800, scene_id: "sound:s01" }]);
    // no bed, no cue; short gaps, no cue
    expect(soundEventCues({ scenes, speech: [w(0, 2500), w(7000, 7800)], music: false, total_ms: 8000 })).toEqual([]);
    expect(soundEventCues({ scenes, speech: [w(0, 3000), w(4500, 8000)], music: true, total_ms: 8000 })).toEqual([]);
  });

  it("voice.mode none with a bed: [music] from the start", () => {
    const cues = soundEventCues({ scenes, speech: [], music: true, total_ms: 8000 });
    expect(cues).toEqual([{ word: "[music]", start_ms: 0, end_ms: 3000, scene_id: "sound:s01" }]);
  });

  it("sfx captions at their time, never over speech; they split music stretches", () => {
    const warnings: string[] = [];
    const cues = soundEventCues(
      {
        scenes: [
          { id: "s01", start_ms: 0, end_ms: 3000, sfx: [{ at_ms: 500, caption: "applause" }] },
          { id: "s02", start_ms: 3000, end_ms: 8000, sfx: [{ at_ms: 3200, caption: "[whoosh]" }] },
        ],
        speech: [w(3000, 4000)],
        music: true,
        total_ms: 8000,
      },
      warnings,
    );
    expect(cues[0]).toEqual({ word: "[applause]", start_ms: 500, end_ms: 2000, scene_id: "sound:s01" });
    expect(cues.some((c) => c.word === "[whoosh]")).toBe(false);
    expect(warnings[0]).toMatch(/\[whoosh\] in s02 starts during speech/);
    // music after the speech (4000–8000), none in 0–500 or 2000–3000 (under 2 s)
    expect(cues.filter((c) => c.word === "[music]")).toEqual([{ word: "[music]", start_ms: 4300, end_ms: 7300, scene_id: "sound:s02" }]);
    for (const c of cues) expect(c.end_ms <= 3000 || c.start_ms >= 4000).toBe(true);
  });

  it("[ambient sound] for footage with its own sound and no speech; no [music] where the bed is muted", () => {
    const cues = soundEventCues({
      scenes: [
        { id: "s01", start_ms: 0, end_ms: 4000, footage_sound: true, bed_muted: true },
        { id: "s02", start_ms: 4000, end_ms: 8000, footage_sound: true, bed_muted: true },
      ],
      speech: [w(4200, 7000)],
      music: true,
      total_ms: 8000,
    });
    expect(cues).toEqual([{ word: "[ambient sound]", start_ms: 0, end_ms: 3000, scene_id: "sound:s01" }]);
  });

  it("cue helpers", () => {
    expect(bracketCue(" door slams ")).toBe("[door slams]");
    expect(bracketCue("[laughter]")).toBe("[laughter]");
    expect(isSoundCue({ word: "[music]", scene_id: "sound:s01" })).toBe(true);
    expect(isSoundCue({ word: "hello", scene_id: "s01" })).toBe(false);
  });
});

describe("brand logo placement", () => {
  /** The RGB of one pixel of the reel at `atS`. */
  async function pixel(video: string, atS: number, x: number, y: number): Promise<[number, number, number]> {
    const out = join(tmp, `px-${Date.now()}-${Math.random().toString(36).slice(2)}.rgb`);
    await runFfmpeg(["-y", "-ss", atS.toFixed(3), "-i", video, "-frames:v", "1", "-an", "-vf", `format=rgb24,crop=1:1:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", out]);
    const b = await readFile(out);
    return [b[0]!, b[1]!, b[2]!];
  }

  it(
    "draws the logo in the chosen corner on every scene but the end card, and lint stays quiet",
    async () => {
      const s: VideoSpec = structuredClone(spec);
      s.scenes[2] = { ...s.scenes[2]!, deterministic: { kind: "end_card", props: { title: "Thanks" } } };
      const dir = await makeProject("brand-logo", s);
      await mkdir(join(dir, "assets"), { recursive: true });
      await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=0xFF0000:s=200x100", "-frames:v", "1", join(dir, "assets", "logo.png")]);
      await writeFile(
        join(dir, "brand.yaml"),
        "version: 2\nbrand:\n  name: Test\nvisual:\n  fonts: { heading: Inter, body: Inter }\n  palette: { primary: '#22AA55' }\n  logo: assets/logo.png\n  logo_placement: { position: top_right, max_fraction: 0.2 }\n",
      );
      const r = await renderProject(dir, opts());
      const state = JSON.parse(await readFile(join(dir, "renders", "preview", "render-state.json"), "utf8"));
      expect(state.logo).toMatchObject({ path: "assets/logo.png", scenes: ["s01", "s02"] });
      const { x, y, w, h } = state.logo.box;
      expect(w).toBe(36); // 20% of 180 px
      expect(x + w).toBeLessThanOrEqual(180);
      const cx = x + Math.floor(w / 2);
      const cy = y + Math.floor(h / 2);
      const [red, green] = await pixel(r.dist.reel, 0.5, cx, cy);
      expect(red).toBeGreaterThan(200);
      expect(green).toBeLessThan(60);
      // The end card draws the logo itself (centred), not in the corner.
      const [red3] = await pixel(r.dist.reel, 2.5, cx, cy);
      expect(red3).toBeLessThan(150);
      expect(r.warnings.filter((m) => m.startsWith("brand:"))).toEqual([]);
    },
    T,
  );
});

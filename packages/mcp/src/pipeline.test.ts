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
import { type RenderProjectOptions, SpecInvalidError, exportProject, loadValidSpec, renderProject, runQa, socialCopy } from "./pipeline.js";
import { diffLocks, readLock } from "./lock.js";
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
      expect(firstLock.engine).toMatchObject({ engine: "0.1.0", assembly: "2", target_package: "1" });
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

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashFile, initProject } from "@video-studio/core";
import { createFfmpegRenderer } from "@video-studio/renderer";
import type { VideoSpec } from "@video-studio/schema";
import { type RenderProjectOptions, renderProject } from "./pipeline.js";
import { UNBAKED_REEL } from "./pipeline-stages.js";
import { bakePoster, posterArgs } from "./poster.js";

// Tiny clips only: 180x320, ≤ 3 s, 15 fps, x264 ultrafast, ffmpeg renderer. One render at a time.
const T = 120_000;
let tmp: string;

const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
/** Frame `n` of a video as 8-bit gray pixels. */
const frame = (video: string, n: number) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", video, "-vf", `select=eq(n\\,${n}),format=gray`, "-frames:v", "1", "-f", "rawvideo", "-"]);
const meanDiff = (a: Buffer, b: Buffer) => {
  expect(a.length).toBe(b.length);
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i]! - b[i]!);
  return d / a.length;
};
const mean = (a: Buffer) => a.reduce((s, v) => s + v, 0) / a.length;
/** Decoded frame count and stream duration of the first video stream. */
const frames = (video: string) =>
  execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames,duration", "-of", "csv=p=0", video]).toString().trim();
/** MD5 of the audio packets as stored (copied audio is bit-identical). */
const audioMd5 = (video: string) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", video, "-map", "0:a", "-c", "copy", "-f", "md5", "-"]).toString().trim();

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-poster-"));
});
afterAll(() => rm(tmp, { recursive: true, force: true }));

describe("posterArgs", () => {
  it("overlays the scaled cover on frame 0 only, copies the audio and keeps the pipeline's H.264 settings", () => {
    const a = posterArgs("reel.mp4", "cover.png", "out.mp4", 180, 320, { preset: "ultrafast" });
    expect(a.join(" ")).toContain("[1:v]scale=180:320,setsar=1,format=yuv420p[p];[0:v][p]overlay=0:0:enable='eq(n,0)'[v]");
    expect(a).toEqual(expect.arrayContaining(["-map", "[v]", "0:a?", "-c:a", "copy", "libx264", "high", "ultrafast", "yuv420p", "+faststart"]));
    expect(a.at(-1)).toBe("out.mp4");
  });
});

describe("bakePoster (ffmpeg)", () => {
  it(
    "replaces frame 0 with the cover; frame 1, the frame count, duration and audio are unchanged",
    async () => {
      const reel = join(tmp, "reel.mp4");
      const cover = join(tmp, "cover.png");
      ff(["-f", "lavfi", "-i", "color=c=0x303030:s=180x320:r=15:d=1", "-f", "lavfi", "-i", "sine=f=440:d=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-shortest", reel]);
      // Twice the reel's size: scaled down on the way in.
      ff(["-f", "lavfi", "-i", "color=c=white:s=360x640", "-frames:v", "1", cover]);
      const out = join(tmp, "baked.mp4");
      await expect(bakePoster({ reel, image: cover, out: reel })).rejects.toThrow(/must not overwrite/);
      expect(await bakePoster({ reel, image: cover, out, encode: { preset: "ultrafast" } })).toEqual({ width: 180, height: 320 });
      expect(mean(frame(out, 0))).toBeGreaterThan(230);
      expect(meanDiff(frame(out, 1), frame(reel, 1))).toBeLessThan(2);
      expect(frames(out)).toBe(frames(reel));
      expect(audioMd5(out)).toBe(audioMd5(reel));
    },
    T,
  );
});

const spec: VideoSpec = {
  schema_version: "1.0",
  id: "tiny-poster",
  title: "Poster, tiny",
  goal: "explain",
  audience: "developers",
  platform: "youtube_shorts",
  aspect_ratio: "9:16",
  target_duration_sec: 3,
  language: "en-US",
  grounding: "loose",
  voice: {},
  captions: { preset: "minimal", burn_in: true },
  cover: { headline: "Search by meaning", bake_first_frame: true },
  scenes: [
    {
      id: "s01",
      duration_sec: 1.5,
      purpose: "hook",
      voiceover: "Search finds words.",
      visual_strategy: "motion_graphic",
      deterministic: { kind: "typography", props: { lines: ["Search finds words"] } },
      visual_requirements: { continuity_refs: [] },
      claim_refs: [],
    },
    {
      id: "s02",
      duration_sec: 1.5,
      purpose: "cta",
      voiceover: "Try it.",
      visual_strategy: "motion_graphic",
      deterministic: { kind: "cta", props: { headline: "Try it", action: "Embed your docs" } },
      visual_requirements: { continuity_refs: [] },
      claim_refs: [],
    },
  ],
};

describe("renderProject with cover.bake_first_frame (tiny, silent, ffmpeg)", () => {
  let dir: string;
  let env: Record<string, string | undefined>;
  const opts = (): RenderProjectOptions => ({
    quality: "preview",
    renderer: "ffmpeg",
    renderers: [createFfmpegRenderer({ encodePreset: "ultrafast" })],
    target: { shortSide: 180, fps: 15 },
    encodePreset: "ultrafast",
    voice: "silent",
    env,
    voiceCacheDir: join(tmp, "voice-cache"),
  });
  const rdir = () => join(dir, "renders", "preview");
  const writeSpec = (s: VideoSpec) => writeFile(join(dir, "project", "video-spec.json"), JSON.stringify(s, null, 2));
  const state = async () => JSON.parse(await readFile(join(rdir(), "render-state.json"), "utf8"));

  beforeAll(async () => {
    env = { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_PLUGIN_DATA: join(tmp, "data") };
    dir = join(tmp, "project");
    await initProject(dir, { name: "poster" });
    await writeSpec(spec);
    await mkdir(join(dir, "source"), { recursive: true });
    await writeFile(join(dir, "source", "provenance.json"), JSON.stringify({ sources: [] }));
  });

  it(
    "bakes the cover into frame 0 of the reel and the targets, picks the cover time, and QA ignores the poster",
    async () => {
      const r = await renderProject(dir, opts());
      const st = await state();
      expect(st.poster_baked).toBe(true);
      expect(st.poster_key).toMatch(/^[0-9a-f]{64}$/);
      // Automatic cover time: inside the hook, after its first 0.5 s and before its last frame.
      expect(st.cover.at_ms).toBeGreaterThanOrEqual(500);
      expect(st.cover.at_ms).toBeLessThan(1500);
      const unbaked = join(rdir(), UNBAKED_REEL);
      const reel = join(rdir(), "reel.mp4");
      // Frame 0 is the cover (thumbnail.png), frame 1 is the assembled reel's; nothing else moved.
      const thumb = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", join(rdir(), "thumbnail.png"), "-vf", "format=gray", "-f", "rawvideo", "-"]);
      expect(meanDiff(frame(reel, 0), thumb)).toBeLessThan(3);
      expect(meanDiff(frame(reel, 0), frame(unbaked, 0))).toBeGreaterThan(5);
      expect(meanDiff(frame(reel, 1), frame(unbaked, 1))).toBeLessThan(2);
      expect(frames(reel)).toBe(frames(unbaked));
      // The clean master is untouched; dist and the target video inherit the poster.
      expect(meanDiff(frame(join(rdir(), "master.mp4"), 0), frame(reel, 0))).toBeGreaterThan(5);
      expect(await hashFile(r.dist.reel)).toBe(await hashFile(reel));
      const t = r.dist.targets[0]!;
      expect(meanDiff(frame(t.video, 0), thumb)).toBeLessThan(3);
      expect(JSON.parse(await readFile(t.post, "utf8"))).toMatchObject({ poster_baked: true, cover: { file: "cover.jpg" } });
      // QA: no change, cut or flash leg from the poster.
      expect(st.qa.flash.spike_times_s.every((x: number) => x > 0.1)).toBe(true);
      const qa = JSON.parse(await readFile(join(dir, "qa", "report.json"), "utf8"));
      expect(qa.metrics.motion.change_times_s.every((x: number) => x > 0.1)).toBe(true);
    },
    T,
  );

  it(
    "reuses the baked reel, and dropping the flag restores the assembled reel without re-assembling",
    async () => {
      const reel = join(rdir(), "reel.mp4");
      const unbakedSha = await hashFile(join(rdir(), UNBAKED_REEL));
      const mtime = (await stat(reel)).mtimeMs;
      const again = await renderProject(dir, opts());
      expect(again.cache.assembly).toBe("reused");
      expect((await stat(reel)).mtimeMs).toBe(mtime);

      await writeSpec({ ...spec, cover: { headline: "Search by meaning" } });
      const plain = await renderProject(dir, opts());
      expect(plain.cache.assembly).toBe("reused");
      expect(await hashFile(reel)).toBe(unbakedSha);
      await expect(stat(join(rdir(), UNBAKED_REEL))).rejects.toThrow();
      const st = await state();
      expect(st.poster_baked).toBeUndefined();
      expect(JSON.parse(await readFile(plain.dist.targets[0]!.post, "utf8")).poster_baked).toBeUndefined();

      // Baking again works from the restored reel.
      await writeSpec(spec);
      await renderProject(dir, opts());
      expect(await hashFile(join(rdir(), UNBAKED_REEL))).toBe(unbakedSha);
      expect((await state()).poster_baked).toBe(true);
    },
    T,
  );
});

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffprobe, runFfmpeg } from "@video-studio/media";
import type { PlatformContract, VideoSpec } from "@video-studio/schema";
import { packageTargets, planTargetVideo } from "./targets.js";

const contract = (id: string, video: Partial<PlatformContract["video"]> = {}): PlatformContract => ({
  id,
  name: id,
  contract_version: 1,
  verified: "2026-09-25",
  sources: [{ url: "https://example.com" }],
  route: "api",
  video: { aspect_ratios: ["9:16"], recommended: { width: 1080, height: 1920 }, duration_sec: {}, container: ["mp4"], video_codecs: ["h264"], audio_codecs: ["aac"], ...video },
  cover: { mode: "file" },
  captions: { sidecar_formats: ["srt"], burn_in_recommended: true },
  ui_masks: [],
});

const reel = { width: 1080, height: 1920, fps: 60, duration_sec: 10, bytes: 10 * 1024 * 1024 };

describe("planTargetVideo", () => {
  it("copies when the reel fits", () => {
    expect(planTargetVideo(contract("a", { fps: { min: 23, max: 60 }, max_long_side: 1920, max_bitrate_mbps: 25 }), reel)).toMatchObject({ transcode: false, reasons: [], fps: 60, width: 1080 });
  });

  it("re-encodes down to fps, long side, bitrate and file-size ceilings", () => {
    const p = planTargetVideo(contract("a", { fps: { max: 30 }, max_long_side: 1280, max_bitrate_mbps: 4, max_size_mb: 5 }), reel);
    expect(p.transcode).toBe(true);
    expect(p.reasons).toHaveLength(4);
    expect([p.width, p.height, p.fps]).toEqual([720, 1280, 30]);
    // 5 MB over 10 s ≈ 4194 kbit/s × 0.9 − 192 audio ≈ 3582, under the 3600 bitrate ceiling.
    expect(p.maxrate_kbps).toBe(3582);
  });

  it("does not try to fix what re-encoding down cannot (minimum size, aspect)", () => {
    expect(planTargetVideo(contract("a", { min: { width: 2000, height: 4000 }, aspect_ratios: ["1:1"] }), reel).transcode).toBe(false);
  });
});

describe("packageTargets (tiny ffmpeg)", () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "vs-targets-"));
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=180x320:rate=30:duration=1", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", join(tmp, "reel.mp4")]);
  });
  afterAll(() => rm(tmp, { recursive: true, force: true }));

  it("re-encodes only the target whose envelope needs it, and caches the result", async () => {
    const spec = { publish: {} } as unknown as VideoSpec;
    const input = {
      root: tmp,
      distDir: join(tmp, "dist"),
      renderDir: join(tmp, "renders"),
      quality: "preview" as const,
      spec,
      contracts: [contract("fits"), contract("slow", { fps: { max: 15 }, max_long_side: 160 })],
      reel: join(tmp, "reel.mp4"),
      reelFacts: { width: 180, height: 320, fps: 30, duration_sec: 1, bytes: (await stat(join(tmp, "reel.mp4"))).size },
      generatedCopy: () => ({ post_caption: "hi", hashtags: ["#a"] }),
    };
    const [fits, slow] = await packageTargets(input, ["fits", "slow", "gone"]);
    expect(fits!.transcoded).toBe(false);
    expect(slow!.transcoded).toBe(true);
    const p = await ffprobe(slow!.video);
    expect([p.width, p.height, p.fps]).toEqual([90, 160, 15]);
    const cached = (await stat(join(tmp, "renders", "targets", "slow.mp4"))).mtimeMs;
    await packageTargets(input, ["fits", "slow", "gone"]);
    expect((await stat(join(tmp, "renders", "targets", "slow.mp4"))).mtimeMs).toBe(cached);
  }, 60_000);
});

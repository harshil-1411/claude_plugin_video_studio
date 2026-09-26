import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { concatAudio, loudnorm2pass, measureLoudness } from "./audio.js";
import { groupCaptionLines, toAss } from "./captions.js";
import { assemble, burnCaptions, concatVideos, makeThumbnail, muxAudio, overlayLogo, subtitlesFilter } from "./compose.js";
import {
  FfmpegError,
  type FfmpegProgress,
  type FfmpegTools,
  escapeFilterPath,
  ffmpegFeatures,
  ffprobe,
  locateFfTool,
  resolveFfmpeg,
  runFfmpeg,
} from "./ffmpeg.js";
import { technicalQa, writeQaReport } from "./qa.js";

// Tiny media only (≤ 320 px, ≤ 3 s) and x264 ultrafast in tests: this runs on small laptops.
const FAST = { encode: { preset: "ultrafast" } };
const T = 60_000;

describe("path escaping (pure)", () => {
  it("escapes both filter levels", () => {
    expect(escapeFilterPath("/a b/c.ass", "darwin")).toBe("/a b/c.ass");
    // ':' → '\:' (option level) → '\\:' (graph level escapes the backslash only);
    // "'" → "\'" → "\\\'"; ',' '[' ']' ';' are graph-level only.
    expect(escapeFilterPath("/x:y/it's,[a];b\\c.ass", "linux")).toBe("/x\\\\:y/it\\\\\\'s\\,\\[a\\]\\;b\\\\\\\\c.ass");
    expect(escapeFilterPath("C:\\Users\\me\\c.ass", "win32")).toBe("C\\\\:/Users/me/c.ass");
  });

  it("builds a subtitles filter with fontsdir", () => {
    expect(subtitlesFilter("/p/c.ass", "/p/fonts")).toBe("subtitles=filename=/p/c.ass:fontsdir=/p/fonts");
  });
});

describe("tool resolution", () => {
  it("prefers FFMPEG_PATH, rejects a non-executable override, falls back to PATH", async () => {
    const isExecutable = async (p: string) => ["/opt/ff/ffmpeg", "/usr/bin/ffmpeg", "/usr/bin/ffprobe"].includes(p);
    const deps = { platform: "linux" as const, isExecutable };
    expect(await locateFfTool("ffmpeg", { ...deps, env: { PATH: "/usr/bin", FFMPEG_PATH: "/opt/ff/ffmpeg" } })).toEqual({ ok: true, path: "/opt/ff/ffmpeg", source: "FFMPEG_PATH" });
    expect(await locateFfTool("ffmpeg", { ...deps, env: { PATH: "/usr/bin", FFMPEG_PATH: "/nope" } })).toMatchObject({ ok: false, reason: "bad_override" });
    expect(await locateFfTool("ffprobe", { ...deps, env: { PATH: "/usr/bin", FFPROBE_PATH: "${user_config.x}" } })).toEqual({ ok: true, path: "/usr/bin/ffprobe", source: "PATH" });
    await expect(resolveFfmpeg({ PATH: "/empty" }, { platform: "linux", isExecutable })).rejects.toThrow(/ffmpeg not found/);
  });
});

let tools: FfmpegTools | null = null;
let features = { libass: false, libx264: false, version: "none" };
try {
  tools = await resolveFfmpeg();
  features = await ffmpegFeatures({ tools });
} catch {
  tools = null;
}
const hasFf = tools !== null && features.libx264;
if (!hasFf) console.warn("[media tests] skipping ffmpeg integration tests: ffmpeg with libx264 not found");
if (hasFf && !features.libass) console.warn("[media tests] skipping burn-in tests: ffmpeg built without libass");

describe.skipIf(!hasFf)("ffmpeg integration", () => {
  let dir: string;
  const p = (name: string) => join(dir, name);
  const gen = (args: string[]) => runFfmpeg(["-y", ...args], { tools: tools! });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vs-media-test-"));
    const x264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
    await Promise.all([
      // 9:16 with audio, 25 fps.
      gen(["-f", "lavfi", "-i", "color=c=blue:s=180x320:d=1:r=25", "-f", "lavfi", "-i", "sine=f=440:d=1", ...x264, "-c:a", "aac", "-shortest", p("blue.mp4")]),
      // 16:9, 30 fps, no audio: exercises scale+pad and fps normalisation.
      gen(["-f", "lavfi", "-i", "testsrc=s=320x180:d=1:r=30", ...x264, p("wide.mp4")]),
      gen(["-f", "lavfi", "-i", "color=c=black:s=180x320:d=1:r=25", ...x264, p("black.mp4")]),
      gen(["-f", "lavfi", "-i", "sine=f=440:d=1", "-af", "volume=-12dB", "-c:a", "pcm_s16le", p("tone.wav")]),
      gen(["-f", "lavfi", "-i", "sine=f=440:d=2", "-af", "volume=-25dB", "-c:a", "pcm_s16le", p("quiet2s.wav")]),
    ]);
  }, T);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("probes a file", async () => {
    const r = await ffprobe(p("blue.mp4"), { tools: tools! });
    expect(r).toMatchObject({ width: 180, height: 320, fps: 25, video_codec: "h264", audio_codec: "aac", has_audio: true, has_video: true, pix_fmt: "yuv420p" });
    expect(r.duration_s).toBeGreaterThan(0.9);
    expect(r.duration_s).toBeLessThan(1.2);
    const w = await ffprobe(p("tone.wav"), { tools: tools! });
    expect(w).toMatchObject({ has_video: false, has_audio: true, width: null, audio_codec: "pcm_s16le" });
  });

  it("reports ffmpeg errors with the stderr tail", async () => {
    const err = await runFfmpeg(["-i", p("missing.mp4"), "-f", "null", "-"], { tools: tools! }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FfmpegError);
    expect((err as FfmpegError).message).toMatch(/missing\.mp4/);
  });

  it("aborts on signal", async () => {
    const ac = new AbortController();
    const run = runFfmpeg(["-re", "-f", "lavfi", "-i", "sine=f=440:d=30", "-f", "null", "-"], { tools: tools!, signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    await expect(run).rejects.toThrow(/aborted/);
  });

  it("concatenates segments of different sizes and rates to the target, with progress", async () => {
    const progress: FfmpegProgress[] = [];
    const r = await concatVideos(
      [
        { path: p("blue.mp4"), duration_ms: 1000 },
        { path: p("wide.mp4"), duration_ms: 1000 },
      ],
      p("concat.mp4"),
      { width: 180, height: 320, fps: 25 },
      { tools: tools!, ...FAST, onProgress: (x) => progress.push(x) },
    );
    expect(r.frames).toBe(50);
    const pr = await ffprobe(p("concat.mp4"), { tools: tools! });
    expect(pr).toMatchObject({ width: 180, height: 320, fps: 25, has_audio: false, pix_fmt: "yuv420p" });
    expect(Math.abs(pr.duration_s - 2)).toBeLessThan(0.05);
    expect(progress.at(-1)?.done).toBe(true);
  }, T);

  it("holds the last frame when a segment is shorter than its slot", async () => {
    await concatVideos([{ path: p("blue.mp4"), duration_ms: 1600 }], p("held.mp4"), { width: 180, height: 320, fps: 25 }, { tools: tools!, ...FAST });
    const pr = await ffprobe(p("held.mp4"), { tools: tools! });
    expect(Math.abs(pr.duration_s - 1.6)).toBeLessThan(0.05);
  }, T);

  it("draws the logo inside the concat encode, matching a separate overlay pass", async () => {
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=0xFF0000:s=40x20", "-frames:v", "1", p("logo.png")], { tools: tools! });
    const logo = { path: p("logo.png"), x: 120, y: 20, w: 40, h: 20, ranges_ms: [[0, 1000]] as const };
    const target = { width: 180, height: 320, fps: 25 };
    const px = async (video: string, atS: number, x: number, y: number) => {
      const out = p(`px-${x}-${y}-${atS}.rgb`);
      await runFfmpeg(["-y", "-ss", atS.toFixed(3), "-i", video, "-frames:v", "1", "-vf", `format=rgb24,crop=1:1:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", out], { tools: tools! });
      return [...(await readFile(out))];
    };
    for (const transition of [undefined, { kind: "crossfade" as const, ms: 400 }]) {
      const segs = [
        { path: p("blue.mp4"), duration_ms: 1000 },
        { path: p("wide.mp4"), duration_ms: 1000, ...(transition ? { transition_in: transition } : {}) },
      ];
      const one = await concatVideos(segs, p("logo-one.mp4"), target, { tools: tools!, ...FAST, logo });
      expect(one.frames).toBe(50);
      await concatVideos(segs, p("logo-base.mp4"), target, { tools: tools!, ...FAST });
      await overlayLogo(p("logo-base.mp4"), logo, p("logo-two.mp4"), { tools: tools!, ...FAST });
      const pr = await ffprobe(p("logo-one.mp4"), { tools: tools! });
      expect(Math.abs(pr.duration_s - 2)).toBeLessThan(0.05);
      for (const [t, x, y] of [[0.5, 140, 30], [0.5, 60, 200], [1.5, 140, 30]] as const) {
        const a = await px(p("logo-one.mp4"), t, x, y);
        const b = await px(p("logo-two.mp4"), t, x, y);
        for (let i = 0; i < 3; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(24);
      }
      // Logo shows inside its range, not after it.
      expect((await px(p("logo-one.mp4"), 0.5, 140, 30))[0]).toBeGreaterThan(200);
      expect((await px(p("logo-one.mp4"), 1.5, 140, 30))[0]).toBeLessThan(150);
    }
  }, T);

  it("concatenates audio slots with exact-length silence gaps", async () => {
    const r = await concatAudio(
      [
        { path: p("tone.wav"), duration_ms: 700 }, // trimmed
        { duration_ms: 800 }, // silence
        { path: p("tone.wav"), duration_ms: 1234 }, // padded
      ],
      p("voice.wav"),
      { tools: tools! },
    );
    expect(r.duration_ms).toBe(2734);
    const pr = await ffprobe(p("voice.wav"), { tools: tools! });
    expect(Math.abs(pr.duration_s * 1000 - 2734)).toBeLessThanOrEqual(40);
    expect(pr).toMatchObject({ sample_rate: 48000, channels: 2 });
  }, T);

  it("two-pass loudnorm lands within ±1.5 LU of -14", async () => {
    const before = await measureLoudness(p("quiet2s.wav"), { tools: tools! });
    expect(before.integrated_lufs!).toBeLessThan(-25);
    const r = await loudnorm2pass(p("quiet2s.wav"), p("norm.wav"), { I: -14, TP: -1, LRA: 11 }, { tools: tools! });
    expect(r.mode).toBe("two-pass");
    const after = await measureLoudness(p("norm.wav"), { tools: tools! });
    expect(Math.abs(after.integrated_lufs! + 14)).toBeLessThanOrEqual(1.5);
    expect(after.true_peak_dbtp!).toBeLessThanOrEqual(-0.9);
    expect((await ffprobe(p("norm.wav"), { tools: tools! })).sample_rate).toBe(48000);
  }, T);

  it("muxes audio padded to the video length", async () => {
    await muxAudio(p("concat.mp4"), p("tone.wav"), p("muxed.mp4"), { tools: tools! });
    const pr = await ffprobe(p("muxed.mp4"), { tools: tools! });
    expect(pr).toMatchObject({ has_audio: true, audio_codec: "aac", sample_rate: 48000, video_codec: "h264" });
    expect(Math.abs(pr.duration_s - 2)).toBeLessThan(0.1);
  }, T);

  it.skipIf(!features.libass)("burns ASS captions from a path with special characters", async () => {
    const weird = join(dir, "it's [a], b; c:d");
    await mkdir(weird, { recursive: true });
    const lines = groupCaptionLines([
      { word: "Hello", start_ms: 0, end_ms: 400 },
      { word: "world", start_ms: 400, end_ms: 900 },
    ]);
    const ass = join(weird, "cap's.ass");
    await writeFile(ass, toAss(lines, { width: 180, height: 320, preset: "bold" }));
    await burnCaptions(p("blue.mp4"), ass, p("burned.mp4"), { tools: tools!, ...FAST, fontsDir: weird });
    const pr = await ffprobe(p("burned.mp4"), { tools: tools! });
    expect(pr).toMatchObject({ width: 180, height: 320, has_audio: true });
    // Text was actually drawn: the burned video differs clearly from the source.
    const { stderr } = await runFfmpeg(["-i", p("burned.mp4"), "-i", p("blue.mp4"), "-lavfi", "psnr", "-f", "null", "-"], { tools: tools!, keepStderr: true });
    const psnr = Number(/PSNR .*average:([\d.]+|inf)/.exec(stderr)?.[1]);
    expect(psnr).toBeLessThan(35);
  }, T);

  it("makes a full-resolution PNG thumbnail", async () => {
    const r = await makeThumbnail(p("concat.mp4"), p("thumb.png"), { tools: tools!, atMs: 99_000 });
    expect(r.at_ms).toBeLessThan(2000);
    const pr = await ffprobe(p("thumb.png"), { tools: tools! });
    expect(pr).toMatchObject({ width: 180, height: 320, video_codec: "png" });
  }, T);

  it("assembles master + captioned reel and QA flags black and silent parts", async () => {
    const ass = p("reel.ass");
    await writeFile(ass, toAss(groupCaptionLines([{ word: "Hi", start_ms: 0, end_ms: 500 }]), { width: 180, height: 320 }));
    const out = await assemble(
      {
        width: 180,
        height: 320,
        fps: 25,
        segments: [
          { path: p("blue.mp4"), duration_ms: 1000 },
          { path: p("black.mp4"), duration_ms: 1000 }, // deliberately black
          { path: p("blue.mp4"), duration_ms: 1000 },
        ],
        audio: [
          { path: p("tone.wav"), duration_ms: 1000 },
          { duration_ms: 1500 }, // deliberately silent
          { path: p("tone.wav"), duration_ms: 500 },
        ],
        master: p("master.mp4"),
        ...(features.libass ? { reel: p("reel.mp4"), assPath: ass } : {}),
      },
      { tools: tools!, ...FAST },
    );
    expect(out.duration_ms).toBe(3000);
    if (features.libass) expect(existsSync(p("reel.mp4"))).toBe(true);

    const qa = await technicalQa(p("master.mp4"), { width: 180, height: 320, duration_s: 3 }, { tools: tools! });
    const byId = (id: string) => qa.checks.find((c) => c.id === id)!;
    expect(byId("resolution").status).toBe("ok");
    expect(byId("aspect").status).toBe("ok");
    expect(byId("duration").status).toBe("ok");
    expect(byId("audio_stream").status).toBe("ok");
    expect(byId("black_frames").status).toBe("warn");
    expect(qa.metrics.black).toHaveLength(1);
    expect(qa.metrics.black[0]!.start_s).toBeCloseTo(1, 1);
    expect(qa.metrics.black[0]!.end_s).toBeCloseTo(2, 1);
    expect(byId("silence").status).toBe("warn");
    expect(qa.metrics.silence[0]!.start_s).toBeCloseTo(1, 1);
    expect(qa.metrics.silence[0]!.end_s).toBeCloseTo(2.5, 1);
    // Solid-colour segments are static: reported as a warning, never a failure.
    expect(byId("frozen_frames").status).toBe("warn");
    expect(qa.metrics.integrated_lufs).not.toBeNull();
    expect(qa.status).toBe("warn");

    const bad = await technicalQa(p("master.mp4"), { width: 1080, height: 1920, duration_s: 10 }, { tools: tools! });
    expect(bad.status).toBe("fail");
    expect(bad.checks.find((c) => c.id === "resolution")!.status).toBe("fail");
    expect(bad.checks.find((c) => c.id === "duration")!.status).toBe("fail");

    const silentOnly = await technicalQa(p("concat.mp4"), { width: 180, height: 320, duration_s: 2 }, { tools: tools! });
    expect(silentOnly.checks.find((c) => c.id === "audio_stream")!.status).toBe("fail");
    expect((await technicalQa(p("concat.mp4"), { width: 180, height: 320, duration_s: 2, require_audio: false }, { tools: tools! })).status).not.toBe("fail");

    const files = await writeQaReport(dir, qa);
    expect(JSON.parse(await readFile(files.json, "utf8")).status).toBe("warn");
    const md = await readFile(files.md, "utf8");
    expect(md).toContain("# Technical QA: WARN");
    expect(md).toContain("| black_frames | WARN |");
    expect((await stat(files.md)).size).toBeGreaterThan(0);
  }, T * 2);
});

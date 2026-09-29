import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { muxAudio } from "./compose.js";
import { type FfmpegTools, type ProbeResult, ffmpegFeatures, ffprobe, resolveFfmpeg, runFfmpeg } from "./ffmpeg.js";
import {
  BIG_CHANGE_SCORE,
  CUT_SCORE,
  DEFAULT_MAX_FROZEN_PCT,
  FLASH_MAX_PER_SEC,
  FLASH_SPIKE_Y,
  LOOP_AUDIO_JUMP_DB,
  LOOP_SSIM_MIN,
  type LumaSample,
  MOVING_YDIF,
  analyzeVideo,
  avSyncCheck,
  flashCheck,
  flashStats,
  measureAvSync,
  motionChecks,
  motionStats,
  movingPct,
  parseDetections,
  parseFrameDiff,
  parseLuma,
  parseSceneChanges,
  rmsDb,
  technicalQa,
  writeQaReport,
} from "./qa.js";

describe("scene-change parsing and motion stats (pure)", () => {
  const log = [
    "[Parsed_scdet_2 @ 0x1] lavfi.scd.score: 15.625, lavfi.scd.time: 0.533333",
    "[Parsed_scdet_2 @ 0x1] lavfi.scd.score: 7.552, lavfi.scd.time: 1.0",
    // Within the merge window of the previous change: one change, the higher score kept.
    "[Parsed_scdet_2 @ 0x1] lavfi.scd.score: 60.1, lavfi.scd.time: 1.066667",
    "[Parsed_scdet_2 @ 0x1] lavfi.scd.score: 3.2, lavfi.scd.time: 2.0",
  ].join("\n");

  it("keeps changes at or above the big-change score and merges near-duplicates", () => {
    expect(parseSceneChanges(log)).toEqual([
      { t: 0.533, score: 15.625 },
      { t: 1, score: 60.1 },
    ]);
  });

  it("drops changes before `fromS` before merging (a baked poster's cut on frame 1)", () => {
    const poster = ["[Parsed_scdet_2 @ 0x1] lavfi.scd.score: 80, lavfi.scd.time: 0.066667", "[Parsed_scdet_2 @ 0x1] lavfi.scd.score: 9, lavfi.scd.time: 0.133333"].join("\n");
    // Without the skip the frame-2 change merges into the poster's cut.
    expect(parseSceneChanges(poster)).toEqual([{ t: 0.067, score: 80 }]);
    expect(parseSceneChanges(poster, BIG_CHANGE_SCORE, 1.5 / 15)).toEqual([{ t: 0.133, score: 9 }]);
  });

  it("derives changes/s, cuts/s, the longest static stretch and frozen share", () => {
    const m = motionStats(parseSceneChanges(log), 3, [{ start_s: 1.5, end_s: 3, duration_s: 1.5 }]);
    expect(m).toMatchObject({ changes: 2, cuts: 2, frozen_s: 1.5, frozen_pct: 50 });
    expect(m.changes_per_sec).toBeCloseTo(0.667, 3);
    expect(m.longest_static_s).toBe(2);
    expect(m.longest_static_at).toEqual({ start_s: 1, end_s: 3 });
    // No changes at all: the whole runtime is one static stretch.
    expect(motionStats([], 4, [])).toMatchObject({ changes: 0, changes_per_sec: 0, cuts: 0, longest_static_s: 4, frozen_pct: 0 });
  });

  it("measures RMS level in dB with a silence floor", () => {
    expect(rmsDb(new Float32Array(100))).toBe(-90);
    expect(rmsDb(new Float32Array(100).fill(0.5))).toBeCloseTo(-6.02, 1);
  });
});

describe("flash and A/V sync measurement (pure)", () => {
  // Luma samples at 15 fps from a list of 8-bit YAVG values.
  const luma = (ys: number[]): LumaSample[] => ys.map((y, i) => ({ t: Math.round((i / 15) * 1000) / 1000, y }));

  it("parses per-frame YAVG with its pts, across interleaved lines, scaled to 8 bits", () => {
    const log = [
      "[Parsed_metadata_4 @ 0xabc] frame:0    pts:0       pts_time:0",
      "[Parsed_silencedetect_0 @ 0xdef] silence_start: 0",
      "[Parsed_metadata_4 @ 0xabc] lavfi.signalstats.YAVG=126",
      "[Parsed_scdet_2 @ 0x1] lavfi.scd.score: 15.625, lavfi.scd.time: 0.066667",
      "[Parsed_metadata_4 @ 0xabc] frame:1    pts:1       pts_time:0.0666667",
      "[Parsed_metadata_4 @ 0xabc] lavfi.signalstats.YAVG=235.5",
      // A YAVG line without a pending frame header is ignored.
      "[Parsed_metadata_4 @ 0xabc] lavfi.signalstats.YAVG=16",
    ].join("\n");
    expect(parseLuma(log)).toEqual([
      { t: 0, y: 126 },
      { t: 0.067, y: 235.5 },
    ]);
    // 10-bit YAVG is scaled down to 8-bit code values; other parsers still read the same log.
    expect(parseLuma(log, 10)[0]!.y).toBe(31.5);
    expect(parseSceneChanges(log)).toEqual([{ t: 0.067, score: 15.625 }]);
  });

  it("parses per-frame YDIF from its own metadata instance next to YAVG", () => {
    const log = [
      "[Parsed_metadata_5 @ 0xa] frame:0    pts:0       pts_time:0",
      "[Parsed_metadata_5 @ 0xa] lavfi.signalstats.YAVG=100",
      "[Parsed_metadata_6 @ 0xb] frame:0    pts:0       pts_time:0",
      "[Parsed_metadata_6 @ 0xb] lavfi.signalstats.YDIF=0",
      "[Parsed_metadata_5 @ 0xa] frame:1    pts:1       pts_time:0.0666667",
      "[Parsed_metadata_5 @ 0xa] lavfi.signalstats.YAVG=101",
      "[Parsed_metadata_6 @ 0xb] frame:1    pts:1       pts_time:0.0666667",
      "[Parsed_metadata_6 @ 0xb] lavfi.signalstats.YDIF=9.5",
    ].join("\n");
    expect(parseFrameDiff(log)).toEqual([
      { t: 0, y: 0 },
      { t: 0.067, y: 9.5 },
    ]);
    expect(parseLuma(log).map((s) => s.y)).toEqual([100, 101]);
    expect(parseFrameDiff(log, 10)[1]!.y).toBeCloseTo(2.375, 3);
  });

  it("moving share: frame steps at or above the threshold, first frame and skipped frames left out", () => {
    const d = (ys: number[]): LumaSample[] => ys.map((y, i) => ({ t: i / 15, y }));
    // Frame 0 reads 0 (no previous frame) and is not a step.
    expect(movingPct(d([0, 1, 1, 0, 0]))).toBe(50);
    expect(movingPct(d([0, MOVING_YDIF, MOVING_YDIF - 0.01]))).toBe(50);
    expect(movingPct(d([0]))).toBe(0);
    // A baked poster: frames 0-1 are left out (frame 1 is the cut back to the reel).
    expect(movingPct(d([0, 200, 0, 0, 1]), 2)).toBeCloseTo(33.3, 1);
  });

  it("the moving check is reported, and fails only below acceptance.min_moving_pct", () => {
    const m = { ...motionStats([], 3, []), moving_pct: 40 };
    expect(motionChecks(m, [], {}).find((c) => c.id === "moving")).toMatchObject({ status: "ok", detail: expect.stringMatching(/40% of frames.*no acceptance minimum/) });
    expect(motionChecks(m, [], { min_moving_pct: 40 }).find((c) => c.id === "moving")!.status).toBe("ok");
    expect(motionChecks(m, [], { min_moving_pct: 60 }).find((c) => c.id === "moving")).toMatchObject({ status: "fail", detail: expect.stringMatching(/minimum 60%/), fix: expect.any(String) });
    // Not measured (older analyses): no check.
    expect(motionChecks(motionStats([], 3, []), [], { min_moving_pct: 60 }).some((c) => c.id === "moving")).toBe(false);
  });

  it("flags a lone white frame as a spike but not a flash rate", () => {
    const f = flashStats(luma([100, 100, 100, 235, 100, 100, 100]));
    expect(f).toMatchObject({ frames: 7, spikes: 1, spike_times_s: [0.2], flash_rate_max: 1 });
    expect(flashCheck(f)).toMatchObject({ id: "flashing", status: "warn" });
    // A two-frame step is a cut, not a spike; noise below the spike threshold is nothing.
    expect(flashStats(luma([100, 100, 235, 235, 235])).spikes).toBe(0);
    expect(flashStats(luma([100, 100 + FLASH_SPIKE_Y - 1, 100])).spikes).toBe(0);
  });

  it("leaves skipped leading frames out of spikes and transitions, not out of the frame count", () => {
    // A white poster on frame 0 of a dark reel; then the same with a lone white frame 2 (a spike).
    const ys = [235, 16, 16, 16, 16, 16];
    expect(flashStats(luma(ys))).toMatchObject({ frames: 6, spikes: 0, transitions: 1 });
    const spiky = [235, 16, 235, 16, 16, 16];
    expect(flashStats(luma(spiky))).toMatchObject({ spikes: 2, transitions: 3 });
    // Frames 0–1 skipped: frame 1 is no spike candidate and frame 0's leg is gone; frame 2 still counts.
    expect(flashStats(luma(spiky), 2)).toMatchObject({ frames: 6, spikes: 1, spike_times_s: [0.133], transitions: 2 });
    expect(flashStats(luma(ys), 2)).toMatchObject({ frames: 6, spikes: 0, transitions: 0 });
  });

  it("fails a 5 Hz black/white strobe and passes a slow fade", () => {
    const strobe = flashStats(luma(Array.from({ length: 45 }, (_, i) => (i % 3 < 2 ? 235 : 16))));
    expect(strobe.flash_rate_max).toBe(5);
    expect(strobe.flash_rate_max).toBeGreaterThan(FLASH_MAX_PER_SEC);
    expect(flashCheck(strobe)).toMatchObject({ status: "fail", detail: expect.stringMatching(/red flashes are not measured/) });
    const fade = flashStats(luma(Array.from({ length: 30 }, (_, i) => 16 + Math.round((219 * i) / 29))));
    expect(fade).toMatchObject({ spikes: 0, transitions: 1, flash_rate_max: 0 });
    expect(flashCheck(fade).status).toBe("ok");
    // Swings above 80% luminance on both ends do not count (WCAG's darker-state rule).
    expect(flashStats(luma(Array.from({ length: 30 }, (_, i) => (i % 2 ? 235 : 220)))).transitions).toBe(0);
  });

  it("measures the audio offset and lengths, and skips without audio", () => {
    const base = { has_video: true, has_audio: true, fps: 15, duration_s: 2 } as ProbeResult;
    const timing = (start: number, dur: number) => ({ start_s: start, duration_s: dur, nb_frames: 30, nb_read_frames: null });
    const ok = measureAvSync({ ...base, video_timing: timing(0, 2), audio_timing: timing(0, 2) }, 30)!;
    expect(ok).toMatchObject({ offset_ms: 0, video_frames: 30, video_length_s: 2, audio_length_s: 2, length_diff_ms: 0 });
    expect(avSyncCheck(ok).status).toBe("ok");
    // Unskipped AAC priming (1024 samples at 48 kHz) is within one 15 fps frame; 100 ms is not.
    expect(avSyncCheck(measureAvSync({ ...base, video_timing: timing(0, 2), audio_timing: timing(0.021333, 2) }, 30)).status).toBe("ok");
    const late = avSyncCheck(measureAvSync({ ...base, video_timing: timing(0, 2), audio_timing: timing(0.1, 2) }, 30));
    expect(late).toMatchObject({ status: "fail", detail: expect.stringMatching(/audio starts 100 ms after/) });
    // A short audio track: a warning, not a sync failure.
    expect(avSyncCheck(measureAvSync({ ...base, video_timing: timing(0, 2), audio_timing: timing(0, 1.8) }, 30)).status).toBe("warn");
    expect(measureAvSync({ ...base, has_audio: false })).toBeNull();
    expect(avSyncCheck(null)).toMatchObject({ status: "ok", detail: expect.stringMatching(/not applicable/) });
  });
});

let tools: FfmpegTools | null = null;
try {
  tools = await resolveFfmpeg();
  if (!(await ffmpegFeatures({ tools })).libx264) tools = null;
} catch {
  tools = null;
}

// Synthetic clips with a known number of big changes: 160x288, 3 s, 15 fps, x264 ultrafast.
describe.skipIf(!tools)("motion density, frozen share and loop seam on synthetic clips", () => {
  let dir: string;
  const p = (n: string) => join(dir, n);
  const x264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
  const S = "s=160x288:r=15";
  const gen = (args: string[]) => runFfmpeg(["-y", ...args], { tools: tools! });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vs-qa-test-"));
    const colours = ["red", "blue", "green", "white", "black", "yellow"];
    const cuts = colours.map((c, i) => `color=c=${c}:${S}:d=0.5[c${i}]`).join(";") + `;${colours.map((_, i) => `[c${i}]`).join("")}concat=n=6`;
    await Promise.all([
      // 6 flat shots, 5 hard cuts.
      gen(["-f", "lavfi", "-i", cuts, ...x264, p("cuts.mp4")]),
      // A box of 25% of the frame toggling every 0.5 s: 5 big changes (large enough to score like cuts).
      gen(["-f", "lavfi", "-i", `color=c=0x202020:${S}:d=3,drawbox=x=40:y=72:w=80:h=144:c=white:t=fill:enable='gte(mod(t,1),0.5)'`, ...x264, p("box25.mp4")]),
      // A box of 10% of the frame toggling: 5 big changes, 0 cuts.
      gen(["-f", "lavfi", "-i", `color=c=0x202020:${S}:d=3,drawbox=x=40:y=100:w=80:h=58:c=white:t=fill:enable='gte(mod(t,1),0.5)'`, ...x264, p("box10.mp4")]),
      // Continuous smooth motion: never frozen, but no big change either.
      gen(["-f", "lavfi", "-i", `color=c=0x202020:${S}:d=3[bg];color=c=white:s=40x80:r=15:d=3[box];[bg][box]overlay=x='mod(t*40,120)':y=72`, ...x264, p("move.mp4")]),
      // Fully static, with a quiet tone: 100% frozen.
      gen(["-f", "lavfi", "-i", `color=c=0x303030:${S}:d=3`, "-f", "lavfi", "-i", "sine=f=440:d=3", ...x264, "-c:a", "aac", "-ar", "48000", "-shortest", p("static.mp4")]),
      // A loop: grey → white box → grey, the last frame equals the first; the tone is steady across the seam.
      gen(["-f", "lavfi", "-i", `color=c=0x303030:${S}:d=2,drawbox=x=40:y=72:w=80:h=144:c=white:t=fill:enable='between(t,0.6,1.4)'`, "-f", "lavfi", "-i", "sine=f=440:d=2", ...x264, "-c:a", "aac", "-ar", "48000", "-shortest", p("loop.mp4")]),
      // A baked poster: a white frame 0 on a still dark clip.
      gen(["-f", "lavfi", "-i", `color=c=0x202020:${S}:d=2,drawbox=x=0:y=0:w=iw:h=ih:c=white:t=fill:enable='eq(n,0)'`, ...x264, p("poster.mp4")]),
      // Not a loop: ends on another picture, and the audio fades in from silence (a level jump at the seam).
      gen([
        "-f", "lavfi", "-i", `color=c=0x303030:${S}:d=2,drawbox=x=40:y=72:w=80:h=144:c=white:t=fill:enable='gte(t,1)'`,
        "-f", "lavfi", "-i", "sine=f=440:d=2", "-af", "afade=t=in:d=1.5", ...x264, "-c:a", "aac", "-ar", "48000", "-shortest", p("noloop.mp4"),
      ]),
    ]);
  }, 60_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("counts big changes and cuts exactly, with change times within one frame", async () => {
    const want = [0.5, 1, 1.5, 2, 2.5];
    const cuts = await analyzeVideo(p("cuts.mp4"), {}, { tools: tools! });
    expect(cuts.motion).toMatchObject({ changes: 5, cuts: 5 });
    // 0.5 s at 15 fps is 7.5 frames: concat rounds each shot to 8 frames.
    cuts.motion.change_times_s.forEach((t, i) => expect(Math.abs(t - (i + 1) * (8 / 15))).toBeLessThanOrEqual(1 / 15 + 1e-3));
    const box25 = await analyzeVideo(p("box25.mp4"), {}, { tools: tools! });
    expect(box25.motion.changes).toBe(5);
    box25.motion.change_times_s.forEach((t, i) => expect(Math.abs(t - want[i]!)).toBeLessThanOrEqual(1 / 15 + 1e-3));
    const box10 = await analyzeVideo(p("box10.mp4"), {}, { tools: tools! });
    expect(box10.motion).toMatchObject({ changes: 5, cuts: 0 });
    expect(box10.motion.changes_per_sec).toBeCloseTo(5 / 3, 1);
    expect(box10.motion.longest_static_s).toBeCloseTo(0.5, 1);
    const move = await analyzeVideo(p("move.mp4"), {}, { tools: tools! });
    expect(move.motion).toMatchObject({ changes: 0, cuts: 0, frozen_pct: 0 });
    expect(move.motion.longest_static_s).toBeCloseTo(3, 1);
    // The thresholds sit between the measured scores: the 10% box (~7.5) is a change, not a cut.
    expect(BIG_CHANGE_SCORE).toBeLessThan(7.5);
    expect(CUT_SCORE).toBeGreaterThan(7.5);
  }, 60_000);

  it("skip_leading_frames leaves a baked poster out of the change and flash stats", async () => {
    const base = { width: 160, height: 288, duration_s: 2, require_audio: false };
    const raw = await technicalQa(p("poster.mp4"), base, { tools: tools! });
    expect(raw.metrics.motion).toMatchObject({ changes: 1, cuts: 1 });
    expect(raw.metrics.flash!.transitions).toBeGreaterThan(0);
    const baked = await technicalQa(p("poster.mp4"), { ...base, skip_leading_frames: 2 }, { tools: tools! });
    expect(baked.metrics.motion).toMatchObject({ changes: 0, cuts: 0 });
    expect(baked.metrics.flash).toMatchObject({ frames: 30, spikes: 0, transitions: 0 });
    expect(baked.checks.find((c) => c.id === "flashing")!.status).toBe("ok");
  }, 60_000);

  it("fails a frozen reel above the frozen limit and never excuses it as expected", async () => {
    const qa = await technicalQa(p("static.mp4"), { width: 160, height: 288, duration_s: 3 }, { tools: tools! });
    const frozen = qa.checks.find((c) => c.id === "frozen_frames")!;
    expect(frozen.status).toBe("fail");
    expect(frozen.detail).toMatch(/% of the runtime/);
    expect(frozen.detail).not.toMatch(/expected/);
    expect(frozen.detail).toContain(`limit ${DEFAULT_MAX_FROZEN_PCT}%`);
    // Without acceptance numbers, density and static stretch are reported, not failed.
    expect(qa.checks.find((c) => c.id === "motion_density")).toMatchObject({ status: "ok" });
    expect(qa.checks.find((c) => c.id === "longest_static")).toMatchObject({ status: "ok" });
    expect(qa.metrics.motion).toMatchObject({ changes: 0, frozen_pct: expect.any(Number) });
    expect(qa.metrics.motion!.frozen_pct).toBeGreaterThan(60);
    // A generous limit lets the same freeze pass.
    const lenient = await technicalQa(p("static.mp4"), { width: 160, height: 288, duration_s: 3, acceptance: { max_frozen_pct: 100 } }, { tools: tools! });
    expect(lenient.checks.find((c) => c.id === "frozen_frames")!.status).toBe("ok");
  }, 60_000);

  it("holds the render to acceptance numbers", async () => {
    const acceptance = { min_changes_per_sec: 1, max_static_sec: 1, hold_ms: 400 };
    const good = await technicalQa(p("box10.mp4"), { width: 160, height: 288, duration_s: 3, require_audio: false, acceptance }, { tools: tools! });
    expect(good.checks.filter((c) => ["motion_density", "longest_static", "hold"].includes(c.id)).map((c) => c.status)).toEqual(["ok", "ok", "ok"]);
    const bad = await technicalQa(p("move.mp4"), { width: 160, height: 288, duration_s: 3, require_audio: false, acceptance }, { tools: tools! });
    expect(bad.checks.find((c) => c.id === "motion_density")).toMatchObject({ status: "fail", detail: expect.stringMatching(/0 big changes\/s .*minimum 1/) });
    expect(bad.checks.find((c) => c.id === "longest_static")).toMatchObject({ status: "fail" });
    const files = await writeQaReport(dir, bad);
    const md = await readFile(files.md, "utf8");
    expect(md).toMatch(/- Motion: 0 big changes \(0\/s\), 0 cuts/);
    expect(JSON.parse(await readFile(files.json, "utf8")).metrics.motion.changes).toBe(0);
  }, 60_000);

  it("checks the loop seam: first vs last frame SSIM and the audio level jump", async () => {
    const loop = await technicalQa(p("loop.mp4"), { width: 160, height: 288, duration_s: 2, loop: true }, { tools: tools! });
    const seam = loop.checks.find((c) => c.id === "loop_seam")!;
    expect(seam.status).toBe("ok");
    expect(loop.metrics.loop_seam!.ssim).toBeGreaterThanOrEqual(LOOP_SSIM_MIN);
    expect(loop.metrics.loop_seam!.audio_jump_db).toBeLessThan(LOOP_AUDIO_JUMP_DB);
    const broken = await technicalQa(p("noloop.mp4"), { width: 160, height: 288, duration_s: 2, loop: true }, { tools: tools! });
    const bad = broken.checks.find((c) => c.id === "loop_seam")!;
    expect(bad.status).toBe("fail");
    expect(broken.metrics.loop_seam!.ssim).toBeLessThan(LOOP_SSIM_MIN);
    expect(broken.metrics.loop_seam!.audio_jump_db).toBeGreaterThan(LOOP_AUDIO_JUMP_DB);
    expect(bad.detail).toMatch(/SSIM/);
    // Without loop, no seam check.
    expect((await technicalQa(p("loop.mp4"), { width: 160, height: 288, duration_s: 2 }, { tools: tools! })).checks.some((c) => c.id === "loop_seam")).toBe(false);
  }, 60_000);
});

// Flash and A/V sync on synthetic clips: 160x288, 3 s, 15 fps, x264 ultrafast.
describe.skipIf(!tools)("flashing and A/V sync on synthetic clips", () => {
  let dir: string;
  const p = (n: string) => join(dir, n);
  const x264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
  const S = "s=160x288:r=15";
  const gen = (args: string[]) => runFfmpeg(["-y", ...args], { tools: tools! });
  const expect3 = { width: 160, height: 288, duration_s: 3, require_audio: false };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vs-qa-flash-"));
    await Promise.all([
      // Mid-grey with one all-white frame (frame 22, 1.467 s).
      gen(["-f", "lavfi", "-i", `color=c=0x606060:${S}:d=3,drawbox=x=0:y=0:w=iw:h=ih:c=white:t=fill:enable='eq(n,22)'`, ...x264, p("spike.mp4")]),
      // Black/white strobe: 2 frames white, 1 black at 15 fps = 5 Hz, 5 flashes/s.
      gen(["-f", "lavfi", "-i", `color=c=black:${S}:d=3,drawbox=x=0:y=0:w=iw:h=ih:c=white:t=fill:enable='lt(mod(n,3),2)'`, ...x264, p("strobe.mp4")]),
      // Dark grey, a smooth 1 s fade up to mid-grey, then a hard cut to another mid-grey.
      gen(["-f", "lavfi", "-i", `color=c=black:${S}:d=3,format=yuv420p,geq=lum='if(lt(T,1),64,if(lt(T,2),64+64*(T-1),90))':cb=128:cr=128`, ...x264, p("fadecut.mp4")]),
      // Video only and a tone, for the mux.
      gen(["-f", "lavfi", "-i", `color=c=0x303030:${S}:d=2`, ...x264, p("silent.mp4")]),
      gen(["-f", "lavfi", "-i", "sine=f=440:d=2", "-ar", "48000", p("tone.wav")]),
    ]);
  }, 60_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("warns on a single white frame, fails a 5 Hz strobe, passes a fade and a cut", async () => {
    const spike = await technicalQa(p("spike.mp4"), expect3, { tools: tools! });
    expect(spike.checks.find((c) => c.id === "flashing")).toMatchObject({ status: "warn", detail: expect.stringMatching(/1 single-frame luma spike\(s\) at 1\.47s/) });
    expect(spike.metrics.flash).toMatchObject({ frames: 45, spikes: 1 });
    expect(spike.metrics.flash!.flash_rate_max).toBeLessThanOrEqual(FLASH_MAX_PER_SEC);
    const strobe = await technicalQa(p("strobe.mp4"), expect3, { tools: tools! });
    expect(strobe.checks.find((c) => c.id === "flashing")).toMatchObject({ status: "fail", fix: expect.stringMatching(/3 per second/) });
    expect(strobe.metrics.flash!.flash_rate_max).toBe(5);
    expect(strobe.status).toBe("fail");
    const fade = await technicalQa(p("fadecut.mp4"), expect3, { tools: tools! });
    expect(fade.checks.find((c) => c.id === "flashing")).toMatchObject({ status: "ok" });
    expect(fade.metrics.flash).toMatchObject({ spikes: 0 });
    expect(fade.metrics.flash!.flash_rate_max).toBeLessThanOrEqual(1);
    // Nothing else changed: no audio → no av_sync check; the report carries the flash metrics.
    expect(fade.checks.map((c) => c.id)).not.toContain("av_sync");
    expect(fade.checks.find((c) => c.id === "audio_stream")).toMatchObject({ status: "ok" });
    const md = await readFile((await writeQaReport(dir, fade)).md, "utf8");
    expect(md).toMatch(/- Flashing: worst \d flash\(es\) in 1 s/);
  }, 60_000);

  it("keeps the other QA outputs as before (the luma filters only add a measurement)", async () => {
    for (const clip of ["spike.mp4", "fadecut.mp4"]) {
      const a = await analyzeVideo(p(clip), {}, { tools: tools! });
      // The detector chain without signalstats, as before this check existed.
      const { stderr } = await runFfmpeg(["-i", p(clip), "-map", "0:v:0", "-vf", `blackdetect=d=0.5:pix_th=0.1,freezedetect=n=-60dB:d=1.0,scdet=t=${BIG_CHANGE_SCORE}`, "-f", "null", "-"], { tools: tools!, keepStderr: true });
      const before = parseDetections(stderr, a.probe.duration_s);
      expect({ black: a.black, freeze: a.freeze }).toEqual({ black: before.black, freeze: before.freeze });
      const { moving_pct: _moving, ...motion } = a.motion;
      expect(motion).toEqual(motionStats(parseSceneChanges(stderr), a.probe.duration_s, before.freeze));
      expect(a.flash.frames).toBe(45);
    }
  }, 60_000);

  it("muxes a tone onto a video with the audio starting within one frame", async () => {
    await muxAudio(p("silent.mp4"), p("tone.wav"), p("muxed.mp4"), { tools: tools! });
    const probe = await ffprobe(p("muxed.mp4"), { tools: tools!, countFrames: true });
    expect(probe.video_timing!.nb_read_frames).toBe(30);
    const sync = measureAvSync(probe)!;
    expect(Math.abs(sync.offset_ms)).toBeLessThanOrEqual(1000 / 15);
    expect(Math.abs(sync.length_diff_ms)).toBeLessThanOrEqual(1000 / 15 + 10);
    const qa = await technicalQa(p("muxed.mp4"), { width: 160, height: 288, duration_s: 2 }, { tools: tools! });
    expect(qa.checks.find((c) => c.id === "av_sync")).toMatchObject({ status: "ok" });
    expect(qa.metrics.av_sync).toMatchObject({ video_frames: 30 });
    // Audio delayed by 200 ms fails.
    await gen(["-i", p("silent.mp4"), "-itsoffset", "0.2", "-i", p("tone.wav"), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", p("late.mp4")]);
    const late = await technicalQa(p("late.mp4"), { width: 160, height: 288, duration_s: 2.2, tolerance_s: 1 }, { tools: tools! });
    expect(late.checks.find((c) => c.id === "av_sync")).toMatchObject({ status: "fail" });
    expect(late.metrics.av_sync!.offset_ms).toBeGreaterThan(150);
  }, 60_000);
});

// Smooth-motion share on synthetic clips: 160x288, 3 s, 15 fps, x264 ultrafast.
describe.skipIf(!tools)("moving share on synthetic clips", () => {
  let dir: string;
  const p = (n: string) => join(dir, n);
  const x264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
  const S = "s=160x288:r=15";
  const gen = (args: string[]) => runFfmpeg(["-y", ...args], { tools: tools! });
  const card = (c: string, d: number) => `color=c=${c}:${S}:d=${d},drawbox=x=20:y=40:w=120:h=20:c=white:t=fill,drawbox=x=40:y=200:w=80:h=40:c=0xe94560:t=fill`;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vs-qa-moving-"));
    await Promise.all([
      // A still title card.
      gen(["-f", "lavfi", "-i", card("0x1a1a2e", 3), ...x264, p("static.mp4")]),
      // A slow zoom (0.2% per frame, 3%/s) into one large frame of a test pattern (sub-pixel steps).
      gen(["-f", "lavfi", "-i", "testsrc2=s=1280x2304:r=15:d=0.0667,zoompan=z='1+0.002*on':d=45:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=160x288:fps=15", "-frames:v", "45", ...x264, p("zoom.mp4")]),
      // Two still cards with a 1 s crossfade between them (1.0–2.0 s).
      gen(["-f", "lavfi", "-i", card("0x1a1a2e", 2), "-f", "lavfi", "-i", card("0xf0e0c0", 2), "-filter_complex", "[0][1]xfade=transition=fade:duration=1:offset=1", ...x264, p("xfade.mp4")]),
      // A slideshow: three still cards, two hard cuts.
      gen(["-f", "lavfi", "-i", `${card("red", 1)}[a];${card("blue", 1)}[b];${card("0xf0e0c0", 1)}[c];[a][b][c]concat=n=3`, ...x264, p("slides.mp4")]),
    ]);
  }, 60_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("separates a still card, a slow zoom, a crossfade and a hard-cut slideshow", async () => {
    const pct = async (f: string) => (await analyzeVideo(p(f), {}, { tools: tools! })).motion.moving_pct!;
    const [still, zoom, xfade, slides] = [await pct("static.mp4"), await pct("zoom.mp4"), await pct("xfade.mp4"), await pct("slides.mp4")];
    expect(still).toBe(0);
    // Continuous motion: every step moves, although scdet sees no big change.
    expect(zoom).toBeGreaterThanOrEqual(95);
    // The 1 s fade is 15 of 44 steps (~34%); the holds either side are still.
    expect(xfade).toBeGreaterThan(28);
    expect(xfade).toBeLessThan(40);
    // Two cut frames of 44 steps.
    expect(slides).toBeLessThanOrEqual(5);
    expect(slides).toBeGreaterThan(0);
  }, 60_000);

  it("holds the render to acceptance.min_moving_pct and reports the share", async () => {
    const base = { width: 160, height: 288, duration_s: 3, require_audio: false };
    const good = await technicalQa(p("zoom.mp4"), { ...base, acceptance: { min_moving_pct: 60 } }, { tools: tools! });
    expect(good.checks.find((c) => c.id === "moving")!.status).toBe("ok");
    expect(good.metrics.motion!.moving_pct).toBeGreaterThanOrEqual(95);
    const bad = await technicalQa(p("slides.mp4"), { ...base, acceptance: { min_moving_pct: 60 } }, { tools: tools! });
    expect(bad.checks.find((c) => c.id === "moving")).toMatchObject({ status: "fail", detail: expect.stringMatching(/minimum 60%/) });
    const md = await readFile((await writeQaReport(dir, bad)).md, "utf8");
    expect(md).toMatch(/- Motion: .*moving [\d.]+% of frames/);
  }, 60_000);
});

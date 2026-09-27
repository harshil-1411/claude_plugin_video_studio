import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FfmpegTools, ffmpegFeatures, resolveFfmpeg, runFfmpeg } from "./ffmpeg.js";
import {
  BIG_CHANGE_SCORE,
  CUT_SCORE,
  DEFAULT_MAX_FROZEN_PCT,
  LOOP_AUDIO_JUMP_DB,
  LOOP_SSIM_MIN,
  analyzeVideo,
  motionStats,
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

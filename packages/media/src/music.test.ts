import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { duckExpression, mergeIntervals, mixMusic } from "./audio.js";
import { BLACK_PIX_TH, blackThreshold } from "./qa.js";
import { ffprobe, runFfmpeg } from "./ffmpeg.js";

/** RMS level (dB) of `file` between `from` and `to` seconds. */
async function rmsDb(file: string, from: number, to: number): Promise<number> {
  const r = await runFfmpeg(["-ss", String(from), "-t", String(to - from), "-i", file, "-af", "astats=measure_overall=RMS_level:measure_perchannel=0", "-f", "null", "-"], { keepStderr: true });
  const m = /RMS level dB:\s*(-?[\d.]+|-inf)/.exec(r.stderr);
  return m && m[1] !== "-inf" ? Number(m[1]) : -Infinity;
}

describe("music bed helpers (pure)", () => {
  it("merges close speech intervals", () => {
    expect(mergeIntervals([{ start_ms: 1000, end_ms: 2000 }, { start_ms: 0, end_ms: 500 }, { start_ms: 2100, end_ms: 3000 }], 300)).toEqual([
      { start_ms: 0, end_ms: 500 },
      { start_ms: 1000, end_ms: 3000 },
    ]);
  });
  it("builds a unity expression without speech and a ducking one with it", () => {
    expect(duckExpression([], 0.3)).toBe("1");
    expect(duckExpression([{ start_ms: 1000, end_ms: 2000 }], 0.25, 100)).toBe("1-0.75*min(1,clip(min((t-0.9)/0.1,(2.1-t)/0.1),0,1))");
  });
});

describe("mixMusic (tiny ffmpeg)", () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "vs-music-"));
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1.5", "-ac", "2", join(tmp, "bed.wav")]);
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "3", join(tmp, "voice.wav")]);
  });
  afterAll(() => rm(tmp, { recursive: true, force: true }));

  it("loops the bed to the exact duration, fades, and ducks by duck_db over speech", async () => {
    const out = join(tmp, "mix.wav");
    const r = await mixMusic(
      {
        voice: join(tmp, "voice.wav"),
        music: { path: join(tmp, "bed.wav"), volume_db: -12, duck_db: -12, fade_in_ms: 0, fade_out_ms: 0 },
        duration_ms: 3000,
        speech: [{ start_ms: 1000, end_ms: 2000 }],
        out,
      },
      {},
    );
    expect(r.duration_ms).toBe(3000);
    const p = await ffprobe(out);
    expect(Math.abs(p.duration_s - 3)).toBeLessThan(0.01);
    const outside = await rmsDb(out, 0.2, 0.8);
    const inside = await rmsDb(out, 1.25, 1.75);
    const after = await rmsDb(out, 2.3, 2.9); // past the 1.5 s file: the loop keeps playing
    expect(outside - inside).toBeGreaterThan(10);
    expect(outside - inside).toBeLessThan(14);
    expect(Math.abs(after - outside)).toBeLessThan(1);
  });

  it("plays the bed alone (no voice, no ducking) for music-only videos", async () => {
    const out = join(tmp, "only.wav");
    await mixMusic({ music: { path: join(tmp, "bed.wav"), fade_in_ms: 0, fade_out_ms: 0 }, duration_ms: 2000, speech: [{ start_ms: 500, end_ms: 1500 }], out }, {});
    expect(Math.abs((await rmsDb(out, 0.1, 0.4)) - (await rmsDb(out, 0.8, 1.2)))).toBeLessThan(1);
  });
});

describe("black-frame threshold follows the background", () => {
  it("sits below a dark theme's background, and only warns on near-black ones", () => {
    expect(blackThreshold()).toEqual({ pix_th: BLACK_PIX_TH, nearBlack: false });
    const dark = blackThreshold("#0B0F19");
    expect(dark.pix_th).toBeLessThan(0.05);
    expect(dark.nearBlack).toBe(false);
    expect(blackThreshold("#FFFFFF").pix_th).toBe(BLACK_PIX_TH);
    expect(blackThreshold("#000000")).toEqual({ pix_th: 0.005, nearBlack: true });
  });
});

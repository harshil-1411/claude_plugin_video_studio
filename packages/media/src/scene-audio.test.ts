import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { atempoChain, mixMusic, mixSceneAudio } from "./audio.js";
import { ffprobe, runFfmpeg } from "./ffmpeg.js";

let tmp: string;
let tone: string; // 1 s silence, then 3 s of 440 Hz
let click: string; // 50 ms burst
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-scene-audio-"));
  tone = join(tmp, "tone.wav");
  await runFfmpeg(["-y", "-f", "lavfi", "-i", "aevalsrc=if(gte(t\\,1)\\,0.5*sin(2*PI*440*t)\\,0):s=48000:d=4", tone]);
  click = join(tmp, "click.wav");
  await runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=2000:sample_rate=48000:duration=0.05", click]);
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Mean volume (dB) of a window; -91 for digital silence. */
async function meanDb(path: string, startMs: number, durMs: number): Promise<number> {
  const r = await runFfmpeg(["-ss", String(startMs / 1000), "-t", String(durMs / 1000), "-i", path, "-af", "volumedetect", "-f", "null", "-"], { keepStderr: true });
  const m = /mean_volume:\s*(-?[\d.]+|-inf)/.exec(r.stderr);
  return m && m[1] !== "-inf" ? Number(m[1]) : -91;
}

describe("atempoChain", () => {
  it("splits rates outside 0.5–2 into several atempo stages", () => {
    expect(atempoChain(1)).toEqual([]);
    expect(atempoChain(1.5)).toEqual(["atempo=1.5"]);
    expect(atempoChain(4)).toEqual(["atempo=2", "atempo=2"]);
    expect(atempoChain(0.25)).toEqual(["atempo=0.5", "atempo=0.5"]);
  });
});

describe("mixSceneAudio", () => {
  it("is sample-exact and places native sound by offset, silence where a slot has no layers", async () => {
    const out = join(tmp, "a.wav");
    const r = await mixSceneAudio(
      [
        { duration_ms: 1000, layers: [{ path: tone, offset_sec: 1 }] }, // tone from 0
        { duration_ms: 1000, layers: [] }, // silence
        { duration_ms: 1000, layers: [{ path: tone, offset_sec: 0, span_sec: 0.5, loop: true }] }, // silent loop
      ],
      out,
    );
    expect(r.samples).toBe(144_000);
    const p = await ffprobe(out);
    expect(Math.abs(p.duration_s - 3)).toBeLessThan(0.01);
    expect(await meanDb(out, 100, 800)).toBeGreaterThan(-20);
    expect(await meanDb(out, 1100, 800)).toBeLessThan(-80);
    expect(await meanDb(out, 2100, 800)).toBeLessThan(-80);
  }, 30_000);

  it("applies tempo (2x reaches the tone twice as fast) and gain", async () => {
    const out = join(tmp, "b.wav");
    await mixSceneAudio([{ duration_ms: 1000, layers: [{ path: tone, tempo: 2, gain_db: -12 }] }], out);
    // Source 0–1 s is silence → 0–0.5 s here; the tone follows.
    expect(await meanDb(out, 50, 400)).toBeLessThan(-80);
    const loud = await meanDb(out, 550, 400);
    expect(loud).toBeGreaterThan(-35);
    const ref = join(tmp, "b0.wav");
    await mixSceneAudio([{ duration_ms: 1000, layers: [{ path: tone, tempo: 2 }] }], ref);
    expect((await meanDb(ref, 550, 400)) - loud).toBeGreaterThan(10);
  }, 30_000);

  it("crossfades: the outgoing slot keeps playing under the incoming one", async () => {
    const out = join(tmp, "c.wav");
    await mixSceneAudio(
      [
        { duration_ms: 1000, layers: [{ path: tone, offset_sec: 1 }] },
        { duration_ms: 1000, layers: [], crossfade_ms: 400 },
      ],
      out,
    );
    // Without a crossfade 1.0–1.2 s would be silent; with it the tone's tail fades out there.
    expect(await meanDb(out, 1000, 150)).toBeGreaterThan(-40);
    expect(await meanDb(out, 1500, 400)).toBeLessThan(-80);
  }, 30_000);

  it("mixes one-shots at their times", async () => {
    const out = join(tmp, "d.wav");
    await mixSceneAudio([{ duration_ms: 1000, layers: [] }, { duration_ms: 1000, layers: [] }], out, { sfx: [{ path: click, at_ms: 1500, volume_db: -3 }] });
    expect(await meanDb(out, 0, 1400)).toBeLessThan(-80);
    expect(await meanDb(out, 1490, 80)).toBeGreaterThan(-30);
  }, 30_000);
});

describe("mixMusic mute", () => {
  it("silences the bed over mute intervals", async () => {
    const bed = join(tmp, "bed.wav");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=3", bed]);
    const out = join(tmp, "m.wav");
    await mixMusic({ music: { path: bed, fade_in_ms: 0, fade_out_ms: 0, volume_db: -6 }, duration_ms: 3000, mute: [{ start_ms: 1000, end_ms: 2000 }], out });
    expect(await meanDb(out, 200, 600)).toBeGreaterThan(-40);
    expect(await meanDb(out, 1250, 500)).toBeLessThan(-80);
    expect(await meanDb(out, 2300, 500)).toBeGreaterThan(-40);
  }, 30_000);
});

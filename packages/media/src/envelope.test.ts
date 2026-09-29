import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BEAT_SAMPLE_RATE } from "./beats.js";
import { ENVELOPE_VERSION, envelopeFromPcm, musicEnvelope, normaliseCurve, sliceEnvelope } from "./envelope.js";
import { runFfmpeg } from "./ffmpeg.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-envelope-test-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** `lead` s of silence, then a 60 Hz kick (decaying, 150 ms) every 0.5 s for `beats` beats, then 0.5 s of silence. */
function kicks(lead: number, beats: number): Float32Array {
  const sr = BEAT_SAMPLE_RATE;
  const n = Math.round((lead + beats * 0.5 + 0.5) * sr);
  const x = new Float32Array(n);
  for (let b = 0; b < beats; b++) {
    const a = Math.round((lead + b * 0.5) * sr);
    for (let i = 0; i < 0.15 * sr && a + i < n; i++) x[a + i] = 0.8 * Math.sin((2 * Math.PI * 60 * i) / sr) * Math.exp((-12 * i) / sr);
  }
  return x;
}

const at = (u: Uint8Array, t: number, fps: number) => u[Math.floor(t * fps)]!;

describe("normaliseCurve", () => {
  it("divides by the 98th percentile and clips, so one spike does not flatten the rest", () => {
    const v = Array.from({ length: 100 }, (_, i) => (i === 99 ? 1000 : i % 2 ? 1 : 0.5));
    const u = normaliseCurve(v);
    expect(u[99]).toBe(255);
    expect(u[1]).toBe(255);
    expect(u[0]).toBe(128);
    expect([...normaliseCurve([0, 0, 0])]).toEqual([0, 0, 0]);
    // Mostly silence: the percentile is 0, so the max is the reference.
    const sparse = normaliseCurve([...Array(99).fill(0), 2]);
    expect(sparse[99]).toBe(255);
  });
});

describe("envelopeFromPcm", () => {
  const fps = 30;
  const env = envelopeFromPcm(kicks(1, 8), fps);

  it("one value per video frame, 0 in silence, high on the kicks", () => {
    expect(env.version).toBe(ENVELOPE_VERSION);
    expect(env.frames).toBe(Math.ceil(5.5 * fps));
    expect(env.rms.length).toBe(env.frames);
    expect(env.low.length).toBe(env.frames);
    expect(env.onset.length).toBe(env.frames);
    for (const u of [env.rms, env.low, env.onset]) expect(Math.max(...u.slice(0, 25))).toBe(0);
    for (let b = 0; b < 8; b++) {
      const t = 1 + b * 0.5;
      expect(at(env.rms, t + 0.01, fps), `rms beat ${b}`).toBeGreaterThan(150);
      expect(at(env.low, t + 0.01, fps), `low beat ${b}`).toBeGreaterThan(150);
      // Between kicks (after the kick has died away) the level is low.
      expect(at(env.rms, t + 0.4, fps)).toBeLessThan(40);
    }
  });

  it("onset: peaks at each attack and releases over a few frames", () => {
    for (let b = 1; b < 8; b++) {
      const k = Math.floor((1 + b * 0.5) * fps);
      const peak = Math.max(...env.onset.slice(k - 1, k + 3));
      expect(peak, `onset beat ${b}`).toBeGreaterThan(150);
      expect(env.onset[k + 8]!, "released before the next beat").toBeLessThan(peak / 4);
    }
  });

  it("is deterministic", () => {
    const again = envelopeFromPcm(kicks(1, 8), fps);
    expect(Buffer.from(again.rms).equals(Buffer.from(env.rms))).toBe(true);
    expect(Buffer.from(again.onset).equals(Buffer.from(env.onset))).toBe(true);
    expect(Buffer.from(again.low).equals(Buffer.from(env.low))).toBe(true);
  });

  it("a high tone has energy but no low band", () => {
    const sr = BEAT_SAMPLE_RATE;
    const pcm = new Float32Array(sr * 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = (i < sr ? 0.01 : 0.5) * Math.sin((2 * Math.PI * 2000 * i) / sr) + 0.5 * (i < sr ? Math.sin((2 * Math.PI * 50 * i) / sr) : 0);
    const e = envelopeFromPcm(pcm, 25);
    expect(at(e.low, 0.5, 25)).toBeGreaterThan(200);
    expect(at(e.low, 1.5, 25)).toBeLessThan(10);
  });
});

describe("sliceEnvelope", () => {
  const env = envelopeFromPcm(kicks(0, 5), 10); // 3 s, 30 frames
  const dec = (s: string) => [...Buffer.from(s, "base64")];

  it("maps video frames to file frames (start offset), silent past the end without loop", () => {
    const s = sliceEnvelope(env, { fromFrame: 10, frames: 20, startSec: 0.5 });
    expect(s.fps).toBe(10);
    const rms = dec(s.rms);
    expect(rms.length).toBe(20);
    expect(rms.slice(0, 15)).toEqual([...env.rms.slice(15, 30)]);
    expect(rms.slice(15)).toEqual(Array(5).fill(0));
  });

  it("repeats a looping bed", () => {
    const s = sliceEnvelope(env, { fromFrame: 25, frames: 10, loop: true });
    expect(dec(s.low)).toEqual([...env.low.slice(25, 30), ...env.low.slice(0, 5)]);
    expect(dec(s.onset)).toEqual([...env.onset.slice(25, 30), ...env.onset.slice(0, 5)]);
  });

  it("is small: 3 bytes a frame, base64", () => {
    const s = sliceEnvelope(env, { fromFrame: 0, frames: 30 });
    expect(s.rms.length + s.low.length + s.onset.length).toBe(120);
  });
});

describe("musicEnvelope", () => {
  it("decodes a file with the beat decoder and caches by hash + fps", async () => {
    const wav = join(tmp, "click.wav");
    const expr = `if(lt(mod(t\\,0.5)\\,0.02)\\,0.8*sin(2*PI*80*t)\\,0)`;
    await runFfmpeg(["-y", "-f", "lavfi", "-i", `aevalsrc=${expr}:s=48000:d=3`, "-c:a", "pcm_s16le", wav]);
    const cacheDir = join(tmp, "cache");
    const a = await musicEnvelope(wav, 30, { sha256: "abc", cacheDir });
    expect(a.frames).toBe(90);
    expect(Math.max(...a.rms)).toBe(255);
    expect((await readdir(cacheDir)).length).toBe(1);
    const b = await musicEnvelope(join(tmp, "missing.wav"), 30, { sha256: "abc", cacheDir });
    expect(Buffer.from(b.rms).equals(Buffer.from(a.rms))).toBe(true);
    await musicEnvelope(wav, 24, { sha256: "abc", cacheDir });
    expect((await readdir(cacheDir)).length).toBe(2);
  }, 30_000);
});

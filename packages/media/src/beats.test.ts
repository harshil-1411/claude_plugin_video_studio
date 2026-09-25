import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectBeats, snapCuts } from "./beats.js";
import { runFfmpeg } from "./ffmpeg.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-beats-test-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** A click (10 ms 1 kHz burst) every 60/bpm s, starting at `first` s, over a quiet noise floor. */
async function clickTrack(name: string, bpm: number, first: number, dur: number): Promise<string> {
  const p = 60 / bpm;
  const out = join(tmp, name);
  const expr = `if(gte(t\\,${first})*lt(mod(t-${first}\\,${p})\\,0.01)\\,0.8*sin(2*PI*1000*t)\\,0)+0.002*sin(2*PI*97*t)`;
  await runFfmpeg(["-y", "-f", "lavfi", "-i", `aevalsrc=${expr}:s=48000:d=${dur}`, "-c:a", "pcm_s16le", out]);
  return out;
}

describe("detectBeats", () => {
  it("finds 120 bpm and beats on the clicks of a synthetic click track", async () => {
    const path = await clickTrack("click120.wav", 120, 0.25, 8);
    const r = await detectBeats(path);
    expect(r.bpm).not.toBeNull();
    expect(Math.abs(r.bpm! - 120)).toBeLessThanOrEqual(2);
    expect(r.onsets_ms.length).toBeGreaterThanOrEqual(14);
    // Every detected beat sits within 30 ms of a click.
    for (const b of r.beats_ms) {
      const k = Math.round((b - 250) / 500);
      expect(Math.abs(b - (250 + k * 500)), `beat at ${b}`).toBeLessThanOrEqual(30);
    }
    expect(r.beats_ms.length).toBeGreaterThanOrEqual(14);
  }, 30_000);

  it("handles 90 bpm and returns no tempo for silence", async () => {
    const r = await detectBeats(await clickTrack("click90.wav", 90, 0.1, 8));
    expect(Math.abs(r.bpm! - 90)).toBeLessThanOrEqual(2);
    const silent = join(tmp, "silence.wav");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "2", silent]);
    const s = await detectBeats(silent);
    expect(s.bpm).toBeNull();
    expect(s.beats_ms).toEqual([]);
  }, 30_000);
});

describe("snapCuts", () => {
  const beats = [0, 500, 1000, 1500, 2000, 2500, 3000];
  it("moves each cut to the nearest beat within tolerance", () => {
    expect(snapCuts([1100, 1880, 2700], beats, 250)).toEqual([1000, 2000, 2500]);
  });
  it("leaves cuts with no beat in range", () => {
    expect(snapCuts([1240, 2760], [0, 1000, 2000, 3000], 200)).toEqual([1240, 2760]);
  });
  it("keeps a minimum scene length and order", () => {
    // 600 would snap to 500 but then the first scene is < 700 ms; 1300 → 1500 keeps both sides ≥ 700.
    expect(snapCuts([800, 1300], beats, 250, 700)).toEqual([800, 1500]);
    // Two cuts near the same beat: the second can't also take it.
    expect(snapCuts([990, 1010], beats, 250, 0)).toEqual([1000, 1010]);
    const r = snapCuts([400, 900, 1400], beats, 300, 400);
    for (let i = 1; i < r.length; i++) expect(r[i]! - r[i - 1]!).toBeGreaterThanOrEqual(400);
  });
  it("prefers the earlier beat on a tie and returns [] for no cuts", () => {
    expect(snapCuts([1250], beats, 250)).toEqual([1000]);
    expect(snapCuts([], beats, 250)).toEqual([]);
  });
});

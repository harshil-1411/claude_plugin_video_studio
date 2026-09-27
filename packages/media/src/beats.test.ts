import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BEAT_ANALYSIS_VERSION, BEAT_SAMPLE_RATE, analyzePcm, detectBeats, downbeatPhase, dropBar, snapCuts, trimGrid } from "./beats.js";
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

/**
 * A synthetic 4/4 track at the analysis rate: `lead` s of silence, a swept-sine kick on every
 * beat (accented on beat 1), seeded noise hats on the off-beats, a 55 Hz bass from `drop` (bar
 * index) on, then `tail` s of silence.
 */
function song(bpm: number, lead: number, bars: number, drop: number, tail = 1.5): Float32Array {
  const sr = BEAT_SAMPLE_RATE;
  const p = 60 / bpm;
  const n = Math.round((lead + bars * 4 * p + tail) * sr);
  const x = new Float32Array(n);
  let seed = 12345;
  const noise = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  const add = (at: number, len: number, f: (tau: number, k: number) => number) => {
    const a = Math.round(at * sr);
    for (let i = 0; i < len * sr && a + i < n; i++) x[a + i]! += f(i / sr, a + i);
  };
  for (let b = 0; b < bars * 4; b++) {
    const t0 = lead + b * p;
    const amp = b % 4 === 0 ? 0.9 : 0.5;
    add(t0, 0.25, (tau) => amp * Math.sin(2 * Math.PI * (50 * tau + 2 * (1 - Math.exp(-30 * tau)))) * Math.exp(-9 * tau));
    add(t0 + p / 2, 0.05, (tau) => 0.4 * noise() * Math.exp(-60 * tau));
    if (Math.floor(b / 4) >= drop) add(t0, p, (tau, k) => 0.25 * Math.sin((2 * Math.PI * 55 * k) / sr) * Math.min(1, tau / 0.01));
  }
  return x;
}

describe("analyzePcm (beat v2 on synthetic tracks)", () => {
  const cases = [
    { bpm: 75, lead: 0.43, bars: 8, drop: 4 },
    { bpm: 90, lead: 1.21, bars: 8, drop: 4 },
    { bpm: 120, lead: 0.07, bars: 12, drop: 6 },
    { bpm: 140, lead: 0.66, bars: 12, drop: 5 },
    { bpm: 174, lead: 0.29, bars: 12, drop: 6 },
  ];
  for (const c of cases) {
    it(`${c.bpm} bpm: tempo, downbeats on the accented kick, the drop, and no beats in silence`, () => {
      const p = 60 / c.bpm;
      const r = analyzePcm(song(c.bpm, c.lead, c.bars, c.drop));
      expect(r.analysis_version).toBe(BEAT_ANALYSIS_VERSION);
      const tempoOk = Math.abs(r.bpm! - c.bpm) <= 1 || Math.abs((r.alternate_bpm ?? 0) - c.bpm) <= 1;
      expect(tempoOk, `bpm ${r.bpm} (alt ${r.alternate_bpm})`).toBe(true);
      expect(r.downbeats_ms!.length).toBeGreaterThanOrEqual(c.bars - 1);
      for (const d of r.downbeats_ms!) {
        const k = Math.round((d / 1000 - c.lead) / (4 * p));
        expect(Math.abs(d - (c.lead + k * 4 * p) * 1000), `downbeat ${d}`).toBeLessThanOrEqual(20);
      }
      expect(Math.abs(r.drop_ms! - (c.lead + c.drop * 4 * p) * 1000)).toBeLessThanOrEqual(30);
      expect(r.bar_energy!.length).toBe(r.downbeats_ms!.length);
      expect(Math.max(...r.bar_energy!)).toBe(1);
      // No phantom beats in the leading silence or after the last kick.
      expect(r.beats_ms[0]!).toBeGreaterThanOrEqual(c.lead * 1000 - 30);
      expect(r.beats_ms.at(-1)!).toBeLessThanOrEqual((c.lead + (c.bars * 4 - 1) * p) * 1000 + 30);
    });
  }

  it("reads loud off-beat hats as a double-time alternate, not as the pulse", () => {
    const r = analyzePcm(song(90, 0.2, 8, 4));
    expect(r.bpm).toBe(90);
    expect(r.alternate_bpm).toBe(180);
  });
});

describe("bar helpers", () => {
  it("trims grid points outside the onset span", () => {
    expect(trimGrid([0, 0.5, 1, 1.5, 2, 2.5], [0.52, 1.49, 2.01])).toEqual([0.5, 1, 1.5, 2]);
    expect(trimGrid([0, 1], [])).toEqual([]);
  });
  it("picks the bar phase with the most low-band energy, or none without an accent", () => {
    const accent = Array.from({ length: 16 }, (_, i) => (i % 4 === 2 ? 3 : 1) * (i >= 8 ? 5 : 1));
    expect(downbeatPhase(accent)).toBe(2);
    expect(downbeatPhase(Array(16).fill(1))).toBeNull();
    expect(downbeatPhase([3, 1, 1])).toBeNull();
  });
  it("finds a sustained rise and ignores a partial final bar", () => {
    expect(dropBar([0.3, 0.3, 0.3, 1, 1, 0.9], 6)).toBe(3);
    // The loud last bar is partial (only 5 full bars): no drop.
    expect(dropBar([0.3, 0.3, 0.3, 0.3, 0.3, 1], 5)).toBeNull();
    // A one-bar hit is not sustained.
    expect(dropBar([0.3, 0.3, 1, 0.3, 0.3, 0.3], 6)).toBeNull();
  });
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

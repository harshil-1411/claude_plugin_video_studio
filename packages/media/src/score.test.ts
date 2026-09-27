import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectBeats } from "./beats.js";
import { ffprobe } from "./ffmpeg.js";
import { SCORE_PRESETS, chordNotes, resolveScorePreset, scoreBars, scoreExpression, scoreGrid, synthScore } from "./score.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-score-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("score parameters (pure)", () => {
  it("builds chords from roman degrees in major and minor keys", () => {
    // C major: I = C major, vi = A minor (roots stay in A2–G#3).
    expect(chordNotes("C", "I")).toEqual({ bass: 36, pad: [60, 64, 67] });
    expect(chordNotes("C", "vi")).toEqual({ bass: 33, pad: [57, 60, 64] });
    // A minor: i = A minor, VI = F major, VII = G major.
    expect(chordNotes("Am", "i").pad).toEqual([57, 60, 64]);
    expect(chordNotes("Am", "VI").pad).toEqual([65, 69, 72]);
    expect(chordNotes("Bb", "IV").bass).toBe(39); // Eb2
    expect(() => chordNotes("H", "I")).toThrow(/key like C/);
  });

  it("merges overrides onto a preset and lists the presets for an unknown name", () => {
    const r = resolveScorePreset("pulse", { bpm: 100, drop_bar: 2 });
    expect(r.params).toMatchObject({ bpm: 100, key: "Am", drop_bar: 2, drums: true, progression: SCORE_PRESETS.pulse!.params.progression });
    expect(resolveScorePreset("ambient").params.drums).toBe(false);
    expect(() => resolveScorePreset("dubstep")).toThrow(/unknown synth preset "dubstep"; use one of synth:pulse, synth:lofi, synth:ambient, synth:drive/);
    expect(() => resolveScorePreset("toString")).toThrow(/unknown synth preset/);
  });

  it("covers the duration in whole bars on an exact grid", () => {
    expect(scoreBars(120, 4)).toBe(2);
    expect(scoreBars(120, 4.01)).toBe(3);
    expect(scoreBars(60, 0.5)).toBe(1);
    const g = scoreGrid(140, 2);
    expect(g.beats_ms).toEqual([0, 429, 857, 1286, 1714, 2143, 2571, 3000]);
    expect(g.downbeats_ms).toEqual([0, 1714]);
  });

  it("brings the kick and bass in at drop_bar and leaves drums out without them", () => {
    const e = scoreExpression({ bpm: 120, drop_bar: 3 });
    expect(e).toContain("gte(t,4)*("); // bar 3 starts at 4 s
    expect(scoreExpression({ bpm: 60, drums: false })).not.toMatch(/7919/);
    expect(scoreExpression({ bpm: 60, seed: 3 })).not.toBe(scoreExpression({ bpm: 60, seed: 4 }));
  });
});

describe("synthScore (tiny ffmpeg)", () => {
  it("is byte-identical across runs and exactly two bars long", async () => {
    const params = { bpm: 120, key: "Am", progression: ["i", "VI"] as const, drop_bar: 2, duration_s: 3.5 };
    const a = await synthScore({ ...params, progression: [...params.progression] }, join(tmp, "a.wav"));
    const b = await synthScore({ ...params, progression: [...params.progression] }, join(tmp, "b.wav"));
    expect(a.sha256).toBe(b.sha256);
    expect(a.bars).toBe(2);
    expect(a.duration_s).toBe(4);
    expect(a.license).toEqual({ id: "CC0-1.0", source: "synthesized locally by video-studio" });
    const p = await ffprobe(a.path);
    expect(Math.abs(p.duration_s - 4)).toBeLessThan(0.001);
  }, 30_000);

  it("puts the kick on its own grid (detection agrees with the exact beats after the drop)", async () => {
    const r = await synthScore({ ...resolveScorePreset("pulse").params, drop_bar: 1, duration_s: 8 }, join(tmp, "pulse.wav"));
    const d = await detectBeats(r.path);
    expect(Math.abs(d.bpm! - 120)).toBeLessThanOrEqual(1);
    // Detection on a full mix is looser than the exact grid (which is why the grid is used), but
    // most detected beats and every downbeat land on it.
    const err = d.beats_ms.map((b) => Math.min(...r.beats_ms.map((x) => Math.abs(x - b)))).sort((a, b) => a - b);
    expect(err[Math.floor(err.length / 2)]!).toBeLessThanOrEqual(15);
    for (const b of d.downbeats_ms ?? []) expect(Math.min(...r.downbeats_ms.map((x) => Math.abs(x - b)))).toBeLessThanOrEqual(20);
  }, 30_000);
});

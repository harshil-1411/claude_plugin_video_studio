import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AudioLicense, ChordDegree, SynthParams } from "@video-studio/schema";
import { type RunOptions, runFfmpeg } from "./ffmpeg.js";

/**
 * A locally synthesized score (Phase 6.5): chords, a swept-sine kick, pseudo-noise hats and a
 * bass, written as one ffmpeg `aevalsrc` expression, so it needs no samples, no downloads and no
 * model, and is CC0 by construction. The same parameters always give the same bytes, and the beat
 * grid is exact (no detection). Before `drop_bar` the arrangement is sparse (pads and hats); from
 * it on the kick and bass come in.
 */

/** Bumped whenever the synthesis changes, so cached scores are regenerated. */
export const SCORE_VERSION = 1;
export const SCORE_SAMPLE_RATE = 48_000;
/** Beats per bar (4/4). */
export const SCORE_BEATS_PER_BAR = 4;
export const SCORE_LICENSE: AudioLicense = { id: "CC0-1.0", source: "synthesized locally by video-studio" };
/** Pad attack and release inside each bar, so chord changes don't click (s). */
const PAD_ATTACK_S = 0.08;
const PAD_RELEASE_S = 0.15;

export interface ScorePreset {
  title: string;
  mood: string;
  params: Required<Pick<SynthParams, "bpm" | "key" | "progression">> & Pick<SynthParams, "drop_bar" | "seed">;
  /** Kick and hats; without them the full arrangement only adds the bass (ambient). */
  drums: boolean;
}

/** Presets for `music.file: synth:<preset>`; `music.synth` overrides their parameters. */
export const SCORE_PRESETS: Readonly<Record<string, ScorePreset>> = {
  pulse: { title: "Synth pulse", mood: "confident, driving", params: { bpm: 120, key: "Am", progression: ["i", "VI", "III", "VII"], drop_bar: 3 }, drums: true },
  lofi: { title: "Synth lo-fi", mood: "warm, relaxed", params: { bpm: 80, key: "F", progression: ["ii", "V", "I", "vi"], drop_bar: 2 }, drums: true },
  ambient: { title: "Synth ambient", mood: "calm, spacious", params: { bpm: 60, key: "C", progression: ["I", "V", "vi", "IV"], drop_bar: 5 }, drums: false },
  drive: { title: "Synth drive", mood: "energetic, bright", params: { bpm: 128, key: "Em", progression: ["i", "VII", "VI", "VII"], drop_bar: 5 }, drums: true },
};

export interface ScoreParams extends SynthParams {
  /** Seconds the score must cover; it is rounded up to whole bars. */
  duration_s: number;
  /** Kick and hats (default true). */
  drums?: boolean;
}

export interface ScoreResult {
  path: string;
  sha256: string;
  bpm: number;
  bars: number;
  /** Exact beat and bar-start times (ms from the start of the file). */
  beats_ms: number[];
  downbeats_ms: number[];
  duration_s: number;
  license: AudioLicense;
}

/** Preset parameters with `overrides` on top. Throws, listing the presets, for an unknown name. */
export function resolveScorePreset(name: string, overrides: Partial<SynthParams> = {}): { preset: ScorePreset; params: SynthParams & { drums: boolean } } {
  const preset = Object.hasOwn(SCORE_PRESETS, name) ? SCORE_PRESETS[name] : undefined;
  if (!preset) throw new Error(`unknown synth preset "${name}"; use one of ${Object.keys(SCORE_PRESETS).map((k) => `synth:${k}`).join(", ")}`);
  const merged = { ...preset.params, drums: preset.drums } as SynthParams & { drums: boolean };
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
  return { preset, params: merged };
}

const PITCH: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const DEGREE: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7 };

/** Chord of a roman degree in `key`, as MIDI notes: bass, then three pad notes an octave or two up. */
export function chordNotes(key: string, degree: ChordDegree): { bass: number; pad: number[] } {
  const m = /^([A-G])(#|b)?(m?)$/.exec(key);
  if (!m) throw new Error(`synth key "${key}" is not a key like C, F#, Bb or Am`);
  const tonic = (PITCH[m[1]!]! + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + 12) % 12;
  const scale = m[3] ? MINOR : MAJOR;
  const deg = DEGREE[degree.toLowerCase()]!;
  let root = 48 + tonic + scale[deg - 1]!; // octave 3
  if (root >= 57) root -= 12; // roots A2–G#3, so every chord sits in the same register
  const third = degree === degree.toUpperCase() ? 4 : 3;
  return { bass: root - 12, pad: [root + 12, root + 12 + third, root + 19] };
}

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const f3 = (x: number) => (Math.round(x * 1000) / 1000).toString();

/** Whole bars covering `durationS` (at least one). */
export function scoreBars(bpm: number, durationS: number): number {
  const bar = (SCORE_BEATS_PER_BAR * 60) / bpm;
  return Math.max(1, Math.ceil(durationS / bar - 1e-9));
}

/** The exact grid of a score: beats and bar starts in ms. */
export function scoreGrid(bpm: number, bars: number): { beats_ms: number[]; downbeats_ms: number[] } {
  const beats_ms = Array.from({ length: bars * SCORE_BEATS_PER_BAR }, (_, k) => Math.round((k * 60_000) / bpm));
  return { beats_ms, downbeats_ms: beats_ms.filter((_, k) => k % SCORE_BEATS_PER_BAR === 0) };
}

/**
 * The aevalsrc expression. Each chord's pitches are chosen per bar by a selector (one sine per
 * voice, not one per chord), and the pad envelope closes at each bar line so the jump in phase is
 * silent. Kick: a 110→50 Hz sweep whose phase restarts each beat (accented on beat 1). Hats: a
 * product of high inharmonic sines (aevalsrc has no seeded noise) on the off-beats; the seed
 * shifts their partials and adds soft 16ths on odd seeds.
 */
export function scoreExpression(p: SynthParams & { drums?: boolean }): string {
  const beat = 60 / p.bpm;
  const bar = beat * SCORE_BEATS_PER_BAR;
  const prog = p.progression ?? ["I", "V", "vi", "IV"];
  const chords = prog.map((d) => chordNotes(p.key ?? "C", d));
  const idx = `mod(floor(t/${f3(bar)}),${prog.length})`;
  const pick = (f: (c: (typeof chords)[number]) => number) => chords.map((c, i) => `eq(${idx},${i})*${f3(hz(f(c)))}`).join("+");
  const pos = `mod(t,${f3(bar)})`;
  const padEnv = `min(1,${pos}/${PAD_ATTACK_S})*min(1,(${f3(bar)}-${pos})/${PAD_RELEASE_S})`;
  const pad = [0, 1, 2].map((v) => `sin(2*PI*(${pick((c) => c.pad[v]!)})*t)`).join("+");
  const bass = `0.22*min(1,${pos}/0.01)*min(1,(${f3(bar)}-${pos})/0.05)*sin(2*PI*(${pick((c) => c.bass)})*t)`;
  const tau = `mod(t,${f3(beat)})`;
  const accent = `(1+0.25*eq(mod(floor(t/${f3(beat)}),${SCORE_BEATS_PER_BAR}),0))`;
  const kick = `0.42*${accent}*sin(2*PI*(50*${tau}+2*(1-exp(-30*${tau}))))*exp(-9*${tau})*min(1,${tau}/0.002)`;
  const seed = p.seed ?? 0;
  const shift = (seed * 37) % 400;
  const partials = `(sin(2*PI*${7919 + shift}*t)*sin(2*PI*${5387 + shift}*t)+0.5*sin(2*PI*${9103 - shift}*t))`;
  const off = `gte(${tau},${f3(beat / 2)})*exp(-60*(${tau}-${f3(beat / 2)}))`;
  const sixteenths = seed % 2 ? `+0.4*exp(-80*mod(t,${f3(beat / 4)}))*(1-gte(${tau},${f3(beat / 2)}))` : "";
  const hat = `0.06*(${off}${sixteenths})*${partials}`;
  const dropT = f3(Math.max(0, (p.drop_bar ?? 1) - 1) * bar);
  const drums = p.drums ?? true;
  const sparse = `0.045*${padEnv}*(${pad})${drums ? `+${hat}` : ""}`;
  const full = `${bass}${drums ? `+${kick}` : ""}`;
  return `${sparse}+gte(t,${dropT})*(${full})`;
}

/**
 * Synthesize a score into `outPath` (16-bit mono WAV at {@link SCORE_SAMPLE_RATE}, bitexact, no
 * metadata), long enough to cover `params.duration_s` in whole bars.
 */
export async function synthScore(params: ScoreParams, outPath: string, opts: RunOptions = {}): Promise<ScoreResult> {
  if (!(params.duration_s > 0)) throw new Error(`synth score: duration_s must be positive (got ${params.duration_s})`);
  const bars = scoreBars(params.bpm, params.duration_s);
  const duration_s = (bars * SCORE_BEATS_PER_BAR * 60) / params.bpm;
  const samples = Math.round(duration_s * SCORE_SAMPLE_RATE);
  // Commas inside the expression are escaped for the filtergraph parser.
  const expr = scoreExpression(params).replace(/,/g, "\\,");
  await runFfmpeg(
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `aevalsrc=exprs=${expr}:s=${SCORE_SAMPLE_RATE}:n=1024,atrim=end_sample=${samples}`,
      "-c:a",
      "pcm_s16le",
      "-ac",
      "1",
      "-fflags",
      "+bitexact",
      "-flags:a",
      "+bitexact",
      "-map_metadata",
      "-1",
      outPath,
    ],
    opts,
  );
  const sha256 = createHash("sha256").update(await readFile(outPath)).digest("hex");
  return { path: outPath, sha256, bpm: params.bpm, bars, ...scoreGrid(params.bpm, bars), duration_s, license: { ...SCORE_LICENSE } };
}

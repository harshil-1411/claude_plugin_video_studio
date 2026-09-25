import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FfmpegTools, runFfmpeg } from "./ffmpeg.js";

/**
 * Beat and onset detection for music beds, and snapping scene cuts to beats. No model: the file
 * is decoded to mono PCM with ffmpeg, an energy envelope gives an onset strength curve, onsets are
 * its adaptive-threshold peaks, the tempo comes from the inter-onset intervals, and the beat grid
 * is phase-aligned to the strongest onsets.
 */

export interface BeatAnalysis {
  bpm: number | null;
  /** Beat times in ms from the start of the file. */
  beats_ms: number[];
  onsets_ms: number[];
  /** Strength-weighted share of onsets within 40 ms of a beat (0–1); below 0.6 no tempo is reported. */
  confidence?: number;
}

const MIN_CONFIDENCE = 0.6;

/** Strength-weighted share of onsets within 40 ms of a beat. */
export function gridConfidence(times: readonly number[], strengths: readonly number[], beats: readonly number[]): number {
  let hit = 0;
  let all = 0;
  times.forEach((t, i) => {
    all += strengths[i]!;
    if (beats.some((b) => Math.abs(b - t) <= 0.04)) hit += strengths[i]!;
  });
  return all > 0 ? Math.round((hit / all) * 1000) / 1000 : 0;
}

/** Analysis sample rate and hop (10 ms frames). */
const SR = 11_025;
const HOP = 110;
const WIN = 441;
const FRAME_S = HOP / SR;
/** Frame index → onset time: a rise shows first in the frame whose window just reaches the attack. */
const ONSET_OFFSET_S = (WIN - HOP) / SR;

/** Onset strength per 10 ms frame: positive rise of log energy over the previous two frames. */
export function onsetEnvelope(pcm: Float32Array): Float32Array {
  const n = Math.max(0, Math.floor((pcm.length - WIN) / HOP) + 1);
  const logE = new Float32Array(n);
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    let e = 0;
    const o = i * HOP;
    for (let k = 0; k < WIN; k++) {
      const v = pcm[o + k]!;
      e += v * v;
    }
    logE[i] = 10 * Math.log10(e / WIN + 1e-12);
    if (logE[i]! > max) max = logE[i]!;
  }
  // Floor at 60 dB below the loudest frame so near-silence doesn't produce huge rises.
  const floor = max - 60;
  for (let i = 0; i < n; i++) logE[i] = Math.max(floor, logE[i]!);
  const env = new Float32Array(n);
  for (let i = 2; i < n; i++) env[i] = Math.max(0, logE[i]! - logE[i - 2]!);
  return env;
}

/** Local maxima of the envelope above a moving mean + 1.5 std (±0.5 s), at least 100 ms apart. Frame indices. */
export function pickOnsets(env: Float32Array): number[] {
  const n = env.length;
  const half = 50;
  const out: number[] = [];
  let globalMax = 0;
  for (const v of env) globalMax = Math.max(globalMax, v);
  if (globalMax <= 0) return out;
  for (let i = 1; i < n - 1; i++) {
    const v = env[i]!;
    if (v <= 0 || v < globalMax * 0.1) continue;
    let isMax = true;
    for (let k = Math.max(0, i - 5); k <= Math.min(n - 1, i + 5); k++) {
      if (env[k]! > v || (env[k]! === v && k < i)) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    let s = 0;
    let s2 = 0;
    let c = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(n - 1, i + half); k++) {
      s += env[k]!;
      s2 += env[k]! * env[k]!;
      c++;
    }
    const mean = s / c;
    const std = Math.sqrt(Math.max(0, s2 / c - mean * mean));
    if (v < mean + 1.5 * std) continue;
    const last = out[out.length - 1];
    if (last !== undefined && i - last < 10) {
      if (env[last]! < v) out[out.length - 1] = i;
      continue;
    }
    out.push(i);
  }
  return out;
}

/**
 * Beat period (s) from inter-onset intervals: every onset pair up to 2 s apart votes (weighted by
 * both strengths) into 10 ms bins; each candidate period in 0.3–1.0 s (60–200 bpm) scores the
 * votes at its first four multiples. Null with fewer than 4 onsets.
 */
export function tempoFromOnsets(times: readonly number[], strengths: readonly number[]): number | null {
  if (times.length < 4) return null;
  const bins = new Float64Array(201); // 0..2 s in 10 ms
  const pairs: Array<{ d: number; w: number }> = [];
  for (let i = 0; i < times.length; i++) {
    for (let j = i + 1; j < times.length; j++) {
      const d = times[j]! - times[i]!;
      if (d > 2.005) break;
      if (d < 0.1) continue;
      const w = strengths[i]! * strengths[j]!;
      bins[Math.round(d * 100)]! += w;
      pairs.push({ d, w });
    }
  }
  const at = (sec: number) => {
    const c = Math.round(sec * 100);
    let s = 0;
    for (let k = c - 2; k <= c + 2; k++) if (k >= 0 && k < bins.length) s += bins[k]!;
    return s;
  };
  let best = 0;
  let bestP = 0;
  for (let c = 30; c <= 100; c++) {
    const p = c / 100;
    let score = 0;
    for (let m = 1; m <= 4 && m * p <= 2.02; m++) score += at(m * p);
    // Normalise by how many multiples fit so slow tempi aren't penalised for having fewer.
    const fits = Math.min(4, Math.floor(2.02 / p));
    score /= Math.sqrt(fits);
    if (score > best * 1.0001) {
      best = score;
      bestP = p;
    }
  }
  if (!bestP) return null;
  // Refine: weighted mean of the intervals near multiples of the winning period, divided back.
  let num = 0;
  let den = 0;
  for (const { d, w } of pairs) {
    const m = Math.round(d / bestP);
    if (m < 1 || m > 4) continue;
    if (Math.abs(d - m * bestP) <= 0.025 * m) {
      num += (d / m) * w;
      den += w;
    }
  }
  return den > 0 ? num / den : bestP;
}

/** Beat grid with period `p` (s) aligned to the onsets, each beat nudged to an onset within 60 ms. Seconds. */
export function beatGrid(times: readonly number[], strengths: readonly number[], p: number, durationS: number): number[] {
  const sigma = 0.03;
  let bestPhase = 0;
  let bestScore = -1;
  for (const t0 of times) {
    const phase = ((t0 % p) + p) % p;
    let score = 0;
    for (let i = 0; i < times.length; i++) {
      const r = ((times[i]! - phase) % p + p) % p;
      const d = Math.min(r, p - r);
      score += strengths[i]! * Math.exp(-(d * d) / (2 * sigma * sigma));
    }
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }
  const beats: number[] = [];
  for (let t = bestPhase; t < durationS; t += p) {
    let near = t;
    let nd = 0.06;
    for (const o of times) {
      const d = Math.abs(o - t);
      if (d <= nd) {
        nd = d;
        near = o;
      }
    }
    beats.push(near);
  }
  return beats;
}

/** Analyse a mono PCM buffer (at {@link SR} Hz). Exported for tests. */
export function analyzePcm(pcm: Float32Array): BeatAnalysis {
  const env = onsetEnvelope(pcm);
  const idx = pickOnsets(env);
  const times = idx.map((i) => i * FRAME_S + ONSET_OFFSET_S);
  const strengths = idx.map((i) => env[i]!);
  const onsets_ms = times.map((t) => Math.max(0, Math.round(t * 1000)));
  const p = tempoFromOnsets(times, strengths);
  if (!p) return { bpm: null, beats_ms: [], onsets_ms, confidence: 0 };
  const durationS = pcm.length / SR;
  const beats = beatGrid(times, strengths, p, durationS);
  const confidence = gridConfidence(times, strengths, beats);
  // A pad or drone has no pulse: its "onsets" are swells that don't sit on any grid.
  if (confidence < MIN_CONFIDENCE) return { bpm: null, beats_ms: [], onsets_ms, confidence };
  return { bpm: Math.round((60 / p) * 10) / 10, beats_ms: beats.map((t) => Math.max(0, Math.round(t * 1000))), onsets_ms, confidence };
}

export async function detectBeats(audioPath: string, opts: { signal?: AbortSignal; tools?: FfmpegTools } = {}): Promise<BeatAnalysis> {
  const work = await mkdtemp(join(tmpdir(), "vs-beats-"));
  try {
    const out = join(work, "mono.f32");
    await runFfmpeg(["-y", "-i", audioPath, "-map", "0:a:0", "-ac", "1", "-ar", String(SR), "-f", "f32le", "-c:a", "pcm_f32le", out], {
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.tools ? { tools: opts.tools } : {}),
    });
    const buf = await readFile(out);
    const pcm = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    return analyzePcm(pcm);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Move each cut to the nearest beat within `toleranceMs`, keeping order and a minimum scene length
 * (against the previous snapped cut, starting at 0, and the next original cut). Cuts are internal
 * scene boundaries in ms; a cut with no acceptable beat stays where it was.
 */
export function snapCuts(cutsMs: readonly number[], beatsMs: readonly number[], toleranceMs: number, minSceneMs = 500): number[] {
  const out: number[] = [];
  let prev = 0;
  cutsMs.forEach((c, i) => {
    const next = cutsMs[i + 1];
    const candidates = beatsMs.filter((b) => Math.abs(b - c) <= toleranceMs).sort((a, b) => Math.abs(a - c) - Math.abs(b - c) || a - b);
    const ok = candidates.find((b) => b > prev && b - prev >= minSceneMs && (next === undefined || (b < next && next - b >= minSceneMs)));
    const x = ok ?? c;
    out.push(x);
    prev = x;
  });
  return out;
}

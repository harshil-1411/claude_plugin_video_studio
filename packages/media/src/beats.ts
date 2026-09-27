import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FfmpegTools, runFfmpeg } from "./ffmpeg.js";

/**
 * Beat and onset detection for music beds, and snapping scene cuts to beats. No model: the file
 * is decoded to mono PCM with ffmpeg, an energy envelope gives an onset strength curve, onsets are
 * its adaptive-threshold peaks, the tempo comes from the inter-onset intervals, and the beat grid
 * is phase-aligned to the strongest onsets. Version 2 adds bars: downbeats from the low band (the
 * kick and bass mark the bar), energy per bar, the drop, and a half/double-time reading.
 */

export interface BeatAnalysis {
  bpm: number | null;
  /** Beat times in ms from the start of the file. */
  beats_ms: number[];
  onsets_ms: number[];
  /** Strength-weighted share of onsets within 40 ms of a beat (0–1); below 0.6 no tempo is reported. */
  confidence?: number;
  /** Beat v2 (Phase 6.5): bar starts, in ms. */
  downbeats_ms?: number[];
  /** Mean low-band energy per bar (0–1, normalised to the loudest bar), one entry per downbeat. */
  bar_energy?: number[];
  /** Start of the biggest sustained energy rise (the drop), in ms. */
  drop_ms?: number;
  /** Half- or double-time reading when the tempo is ambiguous. */
  alternate_bpm?: number;
  /** Bumped whenever detection changes, so cached analyses are recomputed. */
  analysis_version?: number;
}

/** Version of the detection below; anything that caches a {@link BeatAnalysis} keys on it. */
export const BEAT_ANALYSIS_VERSION = 2;
const MIN_CONFIDENCE = 0.6;
/** Upper edge of the band that carries the kick and bass (downbeats, bar energy). */
export const LOW_BAND_HZ = 150;
/** Beats per bar (4/4 is assumed). */
export const BEATS_PER_BAR = 4;
/** The winning bar phase must carry this much more normalised low-band energy than the mean of the others. */
export const DOWNBEAT_MIN_CONTRAST = 1.08;
/** Smallest rise in normalised bar energy (0–1) that counts as a drop. */
export const DROP_MIN_RISE = 0.2;
/** A half/double-time grid "explains the onsets" when this share of onset strength sits on it and this share of its beats has an onset. */
export const ALT_MIN_FIT = 0.6;
/** Beats whose low-band energy is below this share of the other half's read as off-beats (the pulse is half as fast). */
export const OFFBEAT_LOW_RATIO = 0.3;
/** Only a pulse faster than this can be re-read at half time from the low band (kick on 1 and 3 at 120 stays 120). */
export const HALF_TIME_ABOVE_BPM = 140;
/** Grid points further than this outside the first/last onset are dropped (no beats in silence). */
const TRIM_S = 0.06;

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
/** Sample rate {@link analyzePcm} expects. */
export const BEAT_SAMPLE_RATE = SR;
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

/** Grid points within {@link TRIM_S} of the onset span only: a grid never runs into leading or trailing silence. */
export function trimGrid(beats: readonly number[], times: readonly number[]): number[] {
  if (!times.length) return [];
  const first = times[0]! - TRIM_S;
  const last = times[times.length - 1]! + TRIM_S;
  return beats.filter((b) => b >= first && b <= last);
}

/**
 * Least-squares period (s) through the onsets that sit on a grid of period `p` (within 40 ms),
 * against their beat index. Much finer than the 10 ms interval bins over a long track.
 */
export function refinePeriod(times: readonly number[], beats: readonly number[], p: number): number {
  if (beats.length < 2) return p;
  const t0 = beats[0]!;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const t of times) {
    const k = Math.round((t - t0) / p);
    if (k >= 0 && Math.abs(t - (t0 + k * p)) <= 0.04) {
      xs.push(k);
      ys.push(t);
    }
  }
  if (xs.length < 4 || xs[xs.length - 1]! - xs[0]! < 4) return p;
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  const slope = den > 0 ? num / den : p;
  // Only a refinement: never let it jump to another tempo.
  return Math.abs(slope - p) <= p * 0.03 ? slope : p;
}

/** Share of grid points with an onset within 40 ms (0–1). */
export function gridCoverage(times: readonly number[], beats: readonly number[]): number {
  if (!beats.length) return 0;
  const hit = beats.filter((b) => times.some((t) => Math.abs(t - b) <= 0.04)).length;
  return hit / beats.length;
}

/** In-place 2nd-order Butterworth low-pass (RBJ biquad) at `hz` for sample rate {@link SR}. */
function lowpass(x: Float32Array, hz: number): Float32Array {
  const w = (2 * Math.PI * hz) / SR;
  const alpha = Math.sin(w) / Math.SQRT2;
  const cw = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 - cw) / 2 / a0;
  const b1 = (1 - cw) / a0;
  const a1 = (-2 * cw) / a0;
  const a2 = (1 - alpha) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    const o = b0 * v + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    y[i] = o;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = o;
  }
  return y;
}

/**
 * Low-band (< {@link LOW_BAND_HZ}) energy per 10 ms frame, linear: a 4th-order low-pass (two
 * biquads), squared and summed per hop. Linear rather than log so a loud kick outweighs a soft one.
 */
export function lowBandFrames(pcm: Float32Array): Float32Array {
  const y = lowpass(lowpass(pcm, LOW_BAND_HZ), LOW_BAND_HZ);
  const n = Math.floor(y.length / HOP);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let e = 0;
    for (let k = i * HOP; k < (i + 1) * HOP; k++) e += y[k]! * y[k]!;
    out[i] = e;
  }
  return out;
}

/** Sum of frames covering [a, b) seconds. */
function frameSum(frames: Float32Array, a: number, b: number): number {
  const i0 = Math.max(0, Math.floor(a / FRAME_S));
  const i1 = Math.min(frames.length, Math.ceil(b / FRAME_S));
  let s = 0;
  for (let i = i0; i < i1; i++) s += frames[i]!;
  return s;
}

/** Low-band energy at each beat: from 20 ms before it to 40% of a beat after (the kick and the bass attack). */
export function beatLowEnergy(frames: Float32Array, beats: readonly number[], p: number): number[] {
  return beats.map((b) => frameSum(frames, b - 0.02, b + Math.min(0.12, p * 0.4)));
}

/**
 * Bar phase (0–3): each beat's low-band energy is divided by the mean over the two bars around it
 * (so a quiet intro counts as much as a loud chorus), and the phase whose beats carry the most wins.
 * Null when no phase stands out by {@link DOWNBEAT_MIN_CONTRAST} (no accent to read a bar from).
 */
export function downbeatPhase(energy: readonly number[]): number | null {
  const n = energy.length;
  if (n < BEATS_PER_BAR * 2) return null;
  const norm = energy.map((_, i) => {
    let s = 0;
    let c = 0;
    for (let k = Math.max(0, i - BEATS_PER_BAR); k < Math.min(n, i + BEATS_PER_BAR); k++) {
      s += energy[k]!;
      c++;
    }
    const mean = s / c;
    return mean > 0 ? energy[i]! / mean : 0;
  });
  const score = Array.from({ length: BEATS_PER_BAR }, (_, ph) => {
    let s = 0;
    let c = 0;
    for (let i = ph; i < n; i += BEATS_PER_BAR) {
      s += norm[i]!;
      c++;
    }
    return c ? s / c : 0;
  });
  let best = 0;
  for (let ph = 1; ph < BEATS_PER_BAR; ph++) if (score[ph]! > score[best]!) best = ph;
  const others = score.filter((_, ph) => ph !== best);
  const rest = others.reduce((a, b) => a + b, 0) / others.length;
  return score[best]! > 0 && score[best]! >= rest * DOWNBEAT_MIN_CONTRAST ? best : null;
}

/**
 * The drop: the full bar where mean energy over the next two bars rises most above the two before
 * it (at least {@link DROP_MIN_RISE}). `full` bars only, so a partial final bar never counts.
 * Returns the bar index or null.
 */
export function dropBar(barEnergy: readonly number[], full: number): number | null {
  let best: number | null = null;
  let bestRise = DROP_MIN_RISE;
  for (let i = 1; i + 1 < full; i++) {
    const before = (barEnergy[i - 1]! + barEnergy[Math.max(0, i - 2)]!) / 2;
    const after = (barEnergy[i]! + barEnergy[i + 1]!) / 2;
    // Sustained: the bar after the step must stay up too, not just a one-bar hit.
    if (Math.min(barEnergy[i]!, barEnergy[i + 1]!) - before < bestRise / 2) continue;
    if (after - before > bestRise) {
      bestRise = after - before;
      best = i;
    }
  }
  return best;
}

/** Beat grid (seconds) for period `p`, trimmed to the onsets and refined once. */
function fitGrid(times: readonly number[], strengths: readonly number[], p: number, durationS: number): { p: number; beats: number[] } {
  const rough = trimGrid(beatGrid(times, strengths, p, durationS), times);
  const q = refinePeriod(times, rough, p);
  return { p: q, beats: trimGrid(beatGrid(times, strengths, q, durationS), times) };
}

/** Analyse a mono PCM buffer (at {@link SR} Hz). Exported for tests. */
export function analyzePcm(pcm: Float32Array): BeatAnalysis {
  const env = onsetEnvelope(pcm);
  const idx = pickOnsets(env);
  const times = idx.map((i) => i * FRAME_S + ONSET_OFFSET_S);
  const strengths = idx.map((i) => env[i]!);
  const onsets_ms = times.map((t) => Math.max(0, Math.round(t * 1000)));
  const version = { analysis_version: BEAT_ANALYSIS_VERSION };
  const p0 = tempoFromOnsets(times, strengths);
  if (!p0) return { bpm: null, beats_ms: [], onsets_ms, confidence: 0, ...version };
  const durationS = pcm.length / SR;
  let { p, beats } = fitGrid(times, strengths, p0, durationS);
  const confidence = gridConfidence(times, strengths, beats);
  // Octave check. Half time (twice the period) explains the onsets when most onset strength sits on
  // every other beat; double time when the off-beats are mostly filled too.
  const fits = (q: number) => {
    const g = fitGrid(times, strengths, q, durationS);
    return { ...g, ok: gridConfidence(times, strengths, g.beats) >= ALT_MIN_FIT && gridCoverage(times, g.beats) >= ALT_MIN_FIT };
  };
  const fast = fits(p / 2);
  // A pad or drone has no pulse: its "onsets" are swells that don't sit on any grid. Loud off-beat
  // hats pull the beat grid's share down, but then the double-time grid holds them.
  if (confidence < MIN_CONFIDENCE && !fast.ok) return { bpm: null, beats_ms: [], onsets_ms, confidence, ...version };
  const slow = fits(p * 2);

  const frames = lowBandFrames(pcm);
  let alternate: number | undefined;
  // The low band decides which reading is the pulse: when every other beat has (almost) no kick
  // or bass, those are off-beats (hats) and the pulse is half as fast.
  const e = beatLowEnergy(frames, beats, p);
  const byParity = [0, 1].map((par) => {
    const v = e.filter((_, i) => i % 2 === par);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  });
  const weak = Math.min(byParity[0]!, byParity[1]!);
  const strong = Math.max(byParity[0]!, byParity[1]!);
  if (60 / p > HALF_TIME_ABOVE_BPM && strong > 0 && weak < strong * OFFBEAT_LOW_RATIO && gridCoverage(times, slow.beats) >= ALT_MIN_FIT) {
    alternate = 60 / p;
    ({ p, beats } = slow);
  } else if (slow.ok && 60 / slow.p >= 30) {
    alternate = 60 / slow.p;
  } else if (fast.ok && 60 / fast.p <= 300) {
    alternate = 60 / fast.p;
  }

  const out: BeatAnalysis = {
    bpm: Math.round((60 / p) * 10) / 10,
    beats_ms: beats.map((t) => Math.max(0, Math.round(t * 1000))),
    onsets_ms,
    confidence: gridConfidence(times, strengths, beats),
    ...(alternate !== undefined ? { alternate_bpm: Math.round(alternate * 10) / 10 } : {}),
    ...version,
  };

  // Bars: the phase whose beats carry the most low-band energy starts each bar.
  const phase = downbeatPhase(beatLowEnergy(frames, beats, p));
  if (phase === null) return out;
  const down = beats.filter((_, i) => i % BEATS_PER_BAR === phase);
  const barEnd = (k: number) => (k + 1 < down.length ? down[k + 1]! : Math.min(durationS, down[k]! + BEATS_PER_BAR * p));
  const raw = down.map((d, k) => frameSum(frames, d, barEnd(k)) / Math.max(1e-9, barEnd(k) - d));
  // A bar is full when all its beats are on the grid; the last one usually is not.
  const full = down.filter((_, k) => phase + k * BEATS_PER_BAR + BEATS_PER_BAR - 1 < beats.length).length;
  const peak = Math.max(...raw.slice(0, Math.max(1, full)));
  const bar_energy = raw.map((v) => (peak > 0 ? Math.round(Math.min(1, v / peak) * 1000) / 1000 : 0));
  const drop = dropBar(bar_energy, full);
  return {
    ...out,
    downbeats_ms: down.map((t) => Math.max(0, Math.round(t * 1000))),
    bar_energy,
    ...(drop !== null ? { drop_ms: Math.max(0, Math.round(down[drop]! * 1000)) } : {}),
  };
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

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, readJson, sha256Hex, writeJsonAtomic } from "@video-studio/core";
import { BEAT_FRAME_S, BEAT_ONSET_OFFSET_S, BEAT_SAMPLE_RATE, decodeMonoPcm, lowBandFrames, onsetEnvelope } from "./beats.js";
import type { FfmpegTools } from "./ffmpeg.js";

/**
 * The music bed's per-video-frame envelope (Phase 6.7), for music-reactive `motion` pages
 * (`window.__vs.audio`, the kit's `vs.energy` / `vs.bass` / `vs.onset`). Three curves, one value
 * per video frame of the file, each normalised 0..1 by its own 98th percentile (clipped, so one
 * loud hit does not flatten the rest) and quantised to 0..255:
 *
 * - `rms`: loudness (root mean square of the frame's samples);
 * - `low`: the kick and bass (energy below LOW_BAND_HZ, the same filter the downbeats use);
 * - `onset`: attacks (the beat detector's onset strength, the loudest 10 ms rise in the frame) with
 *   an 80 ms half-life release, so a hit reads for a few frames instead of one.
 *
 * Decoding and the onset/low-band curves are beats.ts's own (no second decoder). Deterministic:
 * the same file and fps give the same bytes.
 */

/** Bumped whenever the envelope computation changes, so cached envelopes are recomputed. */
export const ENVELOPE_VERSION = 1;
/** Percentile each curve is normalised by. */
export const ENVELOPE_PERCENTILE = 0.98;
/** Half-life (s) of the onset curve's release. */
export const ONSET_RELEASE_S = 0.08;

export interface MusicEnvelope {
  version: number;
  fps: number;
  /** Values per curve (video frames covering the file). */
  frames: number;
  /** File length in seconds. */
  duration_s: number;
  rms: Uint8Array;
  low: Uint8Array;
  onset: Uint8Array;
}

/** 0..1 by the robust peak (the ENVELOPE_PERCENTILE value, or the max when that is 0), clipped, as 0..255. */
export function normaliseCurve(values: ArrayLike<number>): Uint8Array {
  const n = values.length;
  const out = new Uint8Array(n);
  if (!n) return out;
  const sorted = Float64Array.from(values).sort();
  let ref = sorted[Math.min(n - 1, Math.floor(ENVELOPE_PERCENTILE * (n - 1)))]!;
  if (!(ref > 0)) ref = sorted[n - 1]!;
  if (!(ref > 0)) return out;
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.min(1, Math.max(0, values[i]! / ref)) * 255);
  return out;
}

/** Envelope of mono PCM at BEAT_SAMPLE_RATE, one value per video frame at `fps`. Pure; exported for tests. */
export function envelopeFromPcm(pcm: Float32Array, fps: number): MusicEnvelope {
  if (!(fps > 0)) throw new Error(`invalid fps ${fps}`);
  const sr = BEAT_SAMPLE_RATE;
  const duration = pcm.length / sr;
  // A trailing partial frame shorter than 1% of a frame (sample rounding) is dropped.
  const frames = Math.max(0, Math.ceil(duration * fps - 0.01));
  const rms = new Float64Array(frames);
  const low = new Float64Array(frames);
  const onset = new Float64Array(frames);
  for (let k = 0; k < frames; k++) {
    const a = Math.floor((k * sr) / fps);
    const b = Math.min(pcm.length, Math.floor(((k + 1) * sr) / fps));
    let e = 0;
    for (let i = a; i < b; i++) e += pcm[i]! * pcm[i]!;
    rms[k] = b > a ? Math.sqrt(e / (b - a)) : 0;
  }
  // 10 ms analysis frames -> video frames: every analysis frame that starts inside the video frame
  // (at least one, when video frames are shorter than 10 ms).
  const hops = (k: number, offset: number, count: number): [number, number] => {
    const i0 = Math.max(0, Math.ceil((k / fps - offset) / BEAT_FRAME_S - 1e-9));
    const i1 = Math.max(i0 + 1, Math.ceil(((k + 1) / fps - offset) / BEAT_FRAME_S - 1e-9));
    return [Math.min(i0, count), Math.min(i1, count)];
  };
  const lowFrames = lowBandFrames(pcm);
  for (let k = 0; k < frames; k++) {
    const [i0, i1] = hops(k, 0, lowFrames.length);
    let s = 0;
    for (let i = i0; i < i1; i++) s += lowFrames[i]!;
    low[k] = i1 > i0 ? Math.sqrt(s / (i1 - i0)) : 0;
  }
  const env = onsetEnvelope(pcm);
  const decay = Math.pow(0.5, 1 / (ONSET_RELEASE_S * fps));
  let prev = 0;
  for (let k = 0; k < frames; k++) {
    const [i0, i1] = hops(k, BEAT_ONSET_OFFSET_S, env.length);
    let m = 0;
    for (let i = i0; i < i1; i++) m = Math.max(m, env[i]!);
    prev = Math.max(m, prev * decay);
    onset[k] = prev;
  }
  return { version: ENVELOPE_VERSION, fps, frames, duration_s: duration, rms: normaliseCurve(rms), low: normaliseCurve(low), onset: normaliseCurve(onset) };
}

export interface MusicEnvelopeOptions {
  /** The bed's content hash; with `cacheDir`, the envelope is cached under it. */
  sha256?: string;
  /** Where envelopes are cached (`<plugin data>/cache/envelope`), keyed by bed hash + fps + ENVELOPE_VERSION. */
  cacheDir?: string;
  signal?: AbortSignal;
  tools?: FfmpegTools;
}

interface CachedEnvelope {
  version: number;
  fps: number;
  frames: number;
  duration_s: number;
  rms: string;
  low: string;
  onset: string;
}

const b64 = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/** Envelope of a music bed file at `fps` (decoded with ffmpeg; cached by hash when asked). */
export async function musicEnvelope(bedFile: string, fps: number, o: MusicEnvelopeOptions = {}): Promise<MusicEnvelope> {
  const cacheFile = o.cacheDir && o.sha256 ? join(o.cacheDir, `${sha256Hex(canonicalJson({ v: ENVELOPE_VERSION, bed: o.sha256, fps }))}.json`) : undefined;
  if (cacheFile) {
    const c = await readJson<CachedEnvelope>(cacheFile).catch(() => undefined);
    if (c && c.version === ENVELOPE_VERSION && c.fps === fps) {
      const env = { version: c.version, fps, frames: c.frames, duration_s: c.duration_s, rms: unb64(c.rms), low: unb64(c.low), onset: unb64(c.onset) };
      if (env.rms.length === c.frames && env.low.length === c.frames && env.onset.length === c.frames) return env;
    }
  }
  const pcm = await decodeMonoPcm(bedFile, { ...(o.signal ? { signal: o.signal } : {}), ...(o.tools ? { tools: o.tools } : {}) });
  const env = envelopeFromPcm(pcm, fps);
  if (cacheFile) {
    const c: CachedEnvelope = { version: env.version, fps, frames: env.frames, duration_s: env.duration_s, rms: b64(env.rms), low: b64(env.low), onset: b64(env.onset) };
    await mkdir(o.cacheDir!, { recursive: true }).catch(() => undefined);
    await writeJsonAtomic(cacheFile, c).catch(() => undefined);
  }
  return env;
}

/** A span of the envelope on the video timeline, as base64 of the Uint8 values (what a motion page receives). */
export interface EnvelopeSlice {
  fps: number;
  rms: string;
  low: string;
  onset: string;
}

/**
 * The envelope under video frames [fromFrame, fromFrame + frames) with the bed placed as the mix
 * places it: video time t plays file time t + `startSec`, repeating with `loop`; past the file's
 * end without loop the bed is silent (0).
 */
export function sliceEnvelope(env: MusicEnvelope, o: { fromFrame: number; frames: number; startSec?: number; loop?: boolean }): EnvelopeSlice {
  const n = Math.max(0, Math.round(o.frames));
  const out = { rms: new Uint8Array(n), low: new Uint8Array(n), onset: new Uint8Array(n) };
  const start = o.startSec ?? 0;
  for (let j = 0; j < n; j++) {
    let tf = (o.fromFrame + j) / env.fps + start;
    if (o.loop && env.duration_s > 0) tf = tf % env.duration_s;
    let k = Math.floor(tf * env.fps + 1e-6);
    if (o.loop && env.frames > 0) k %= env.frames;
    if (k < 0 || k >= env.frames) continue;
    out.rms[j] = env.rms[k]!;
    out.low[j] = env.low[k]!;
    out.onset[j] = env.onset[k]!;
  }
  return { fps: env.fps, rms: b64(out.rms), low: b64(out.low), onset: b64(out.onset) };
}

import { extname } from "node:path";
import { type RunOptions, filterGraph, runFfmpeg } from "./ffmpeg.js";

export const AUDIO_SAMPLE_RATE = 48_000;

/** Output audio codec args by extension: WAV → 16-bit PCM, anything else → AAC 192k. */
export function audioCodecArgs(out: string, sampleRate = AUDIO_SAMPLE_RATE): string[] {
  const ext = extname(out).toLowerCase();
  if (ext === ".wav") return ["-c:a", "pcm_s16le", "-ar", String(sampleRate)];
  if (ext === ".flac") return ["-c:a", "flac", "-ar", String(sampleRate)];
  return ["-c:a", "aac", "-b:a", "192k", "-ar", String(sampleRate)];
}

export interface AudioSlot {
  /** Audio for this slot; absent means silence (e.g. a scene without voice). */
  path?: string;
  /** Exact slot length. Audio is padded with silence or trimmed to it. */
  duration_ms: number;
}

export interface ConcatAudioOptions extends RunOptions {
  sampleRate?: number;
  /** 1 or 2. Default 2. */
  channels?: 1 | 2;
}

export interface ConcatAudioResult {
  path: string;
  duration_ms: number;
  samples: number;
}

/**
 * Concatenate per-scene audio into one track, sample-exact: each slot is resampled, padded with
 * silence or trimmed to exactly `duration_ms`, and slots without audio become `anullsrc` silence.
 * Output format follows the extension (`.wav` PCM, `.m4a`/`.aac` AAC).
 */
export async function concatAudio(slots: readonly AudioSlot[], out: string, opts: ConcatAudioOptions = {}): Promise<ConcatAudioResult> {
  const sr = opts.sampleRate ?? AUDIO_SAMPLE_RATE;
  const layout = (opts.channels ?? 2) === 1 ? "mono" : "stereo";
  const inputs: string[] = [];
  const chains: string[][] = [];
  const labels: string[] = [];
  let totalSamples = 0;
  let nIn = 0;
  for (const [i, s] of slots.entries()) {
    if (!Number.isFinite(s.duration_ms) || s.duration_ms < 0) throw new Error(`slot ${i}: invalid duration_ms ${s.duration_ms}`);
    // Integer samples per slot so the total is exact regardless of rounding elsewhere.
    const samples = Math.round((s.duration_ms * sr) / 1000);
    if (samples === 0) continue;
    totalSamples += samples;
    const label = `[a${i}]`;
    const fmt = `aformat=sample_fmts=fltp:sample_rates=${sr}:channel_layouts=${layout}`;
    if (s.path) {
      inputs.push("-i", s.path);
      chains.push([`[${nIn}:a:0]aresample=${sr}`, fmt, `apad=whole_len=${samples}`, `atrim=end_sample=${samples}`, `asetpts=N/SR/TB${label}`]);
      nIn++;
    } else {
      chains.push([`anullsrc=r=${sr}:cl=${layout}`, fmt, `atrim=end_sample=${samples}`, `asetpts=N/SR/TB${label}`]);
    }
    labels.push(label);
  }
  if (labels.length === 0) throw new Error("concatAudio: total duration is zero");
  chains.push([`${labels.join("")}concat=n=${labels.length}:v=0:a=1[aout]`]);
  await runFfmpeg(["-y", ...inputs, "-filter_complex", filterGraph(chains), "-map", "[aout]", ...audioCodecArgs(out, sr), out], opts);
  return { path: out, samples: totalSamples, duration_ms: Math.round((totalSamples / sr) * 1000) };
}

// ---------------------------------------------------------------------------------- loudness

export interface LoudnessTarget {
  /** Integrated loudness, LUFS. Default -14 (social/streaming). */
  I?: number;
  /** True peak ceiling, dBTP. Default -1. */
  TP?: number;
  /** Loudness range. Default 11. */
  LRA?: number;
}

export interface LoudnormMeasurement {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
}

/** Extract the JSON block `loudnorm=print_format=json` writes to stderr. Returns null if absent or non-finite (e.g. digital silence). */
export function parseLoudnormJson(stderr: string): LoudnormMeasurement | null {
  const at = stderr.lastIndexOf("[Parsed_loudnorm");
  const from = at >= 0 ? stderr.indexOf("{", at) : stderr.lastIndexOf("{");
  if (from < 0) return null;
  const to = stderr.indexOf("}", from);
  if (to < 0) return null;
  try {
    const raw = JSON.parse(stderr.slice(from, to + 1)) as Record<string, string>;
    const m: LoudnormMeasurement = {
      input_i: Number(raw.input_i),
      input_tp: Number(raw.input_tp),
      input_lra: Number(raw.input_lra),
      input_thresh: Number(raw.input_thresh),
      target_offset: Number(raw.target_offset),
    };
    return Object.values(m).every(Number.isFinite) ? m : null;
  } catch {
    return null;
  }
}

export interface LoudnormResult {
  path: string;
  mode: "two-pass" | "single-pass";
  measured: LoudnormMeasurement | null;
}

export interface LoudnormOptions extends RunOptions {
  sampleRate?: number;
}

/**
 * EBU R128 loudness normalization in two passes: measure with `print_format=json`, then apply
 * with the measured values (`linear=true`). Falls back to a single dynamic pass when the
 * measurement cannot be parsed. Video, if any, is stream-copied (unless the output is audio-only).
 */
export async function loudnorm2pass(input: string, out: string, target: LoudnessTarget = {}, opts: LoudnormOptions = {}): Promise<LoudnormResult> {
  const I = target.I ?? -14;
  const TP = target.TP ?? -1;
  const LRA = target.LRA ?? 11;
  const sr = opts.sampleRate ?? AUDIO_SAMPLE_RATE;
  const base = `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}`;

  let measured: LoudnormMeasurement | null = null;
  try {
    const pass1 = await runFfmpeg(["-i", input, "-map", "0:a:0", "-af", `${base}:print_format=json`, "-f", "null", "-"], { ...opts, onProgress: undefined, keepStderr: true });
    measured = parseLoudnormJson(pass1.stderr);
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    measured = null;
  }
  const af = measured
    ? `${base}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true:print_format=summary`
    : base;
  const audioOnly = [".wav", ".m4a", ".aac", ".flac", ".mp3"].includes(extname(out).toLowerCase());
  const maps = audioOnly ? ["-map", "0:a:0"] : ["-map", "0:v?", "-map", "0:a:0", "-c:v", "copy"];
  const codec = audioOnly ? audioCodecArgs(out, sr) : ["-c:a", "aac", "-b:a", "192k", "-ar", String(sr)];
  const extra = !audioOnly && extname(out).toLowerCase() === ".mp4" ? ["-movflags", "+faststart"] : [];
  // loudnorm upsamples to 192 kHz internally, so the output rate is always set explicitly.
  await runFfmpeg(["-y", "-i", input, ...maps, "-af", af, ...codec, ...extra, out], opts);
  return { path: out, mode: measured ? "two-pass" : "single-pass", measured };
}

export interface LoudnessStats {
  integrated_lufs: number | null;
  lra: number | null;
  true_peak_dbtp: number | null;
}

/** Parse the `ebur128` summary from stderr. */
export function parseEbur128Summary(stderr: string): LoudnessStats {
  const at = stderr.lastIndexOf("Summary:");
  const s = at >= 0 ? stderr.slice(at) : "";
  const num = (re: RegExp) => {
    const m = re.exec(s);
    if (!m?.[1]) return null;
    const v = Number(m[1]);
    return Number.isFinite(v) ? v : null;
  };
  return {
    integrated_lufs: num(/I:\s+(-?[\d.]+|-?inf)\s+LUFS/),
    lra: num(/LRA:\s+(-?[\d.]+)\s+LU\b/),
    true_peak_dbtp: num(/Peak:\s+(-?[\d.]+|-?inf)\s+dBFS/),
  };
}

/** Measure integrated loudness / LRA / true peak with `ebur128`. */
export async function measureLoudness(input: string, opts: RunOptions = {}): Promise<LoudnessStats> {
  const r = await runFfmpeg(["-i", input, "-map", "0:a:0", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"], { ...opts, keepStderr: true });
  return parseEbur128Summary(r.stderr);
}

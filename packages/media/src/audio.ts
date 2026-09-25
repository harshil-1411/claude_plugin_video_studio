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

// ---------------------------------------------------------------------------------- scene audio

/** One sound source inside a scene slot (a voice file, or a footage clip's own audio). */
export interface AudioLayer {
  path: string;
  /** Start inside the file, seconds. */
  offset_sec?: number;
  /** Source seconds to use from `offset_sec`; afterwards silence (or the span loops). Default: to the end of the file. */
  span_sec?: number;
  /** Playback rate (atempo), 0.25–4. Default 1. */
  tempo?: number;
  /** Gain in dB. Default 0. */
  gain_db?: number;
  /** Loop the span to fill the slot (needs `span_sec`). */
  loop?: boolean;
}

export interface SceneAudioSlot {
  /** Exact slot length. */
  duration_ms: number;
  /** Sources mixed in this slot; none = silence. */
  layers: readonly AudioLayer[];
  /**
   * Crossfade into this slot: it fades in over this long from its start while the previous slot
   * plays on for the same time (reading further into its sources) and fades out.
   */
  crossfade_ms?: number;
}

/** A one-shot sound effect at an absolute time. */
export interface OneShot {
  path: string;
  at_ms: number;
  volume_db?: number;
}

/** `atempo` filters for a rate in 0.25–4 (each atempo takes 0.5–2). */
export function atempoChain(rate: number): string[] {
  if (!(rate > 0) || Math.abs(rate - 1) < 1e-6) return [];
  const out: string[] = [];
  let r = rate;
  while (r > 2) {
    out.push("atempo=2");
    r /= 2;
  }
  while (r < 0.5) {
    out.push("atempo=0.5");
    r /= 0.5;
  }
  out.push(`atempo=${Math.round(r * 1e6) / 1e6}`);
  return out;
}

/**
 * Mix per-scene audio into one track, sample-exact: each slot's layers (voice, native clip sound)
 * are trimmed, re-timed (atempo), gained and mixed, then placed at the slot's start with `adelay`.
 * Crossfades overlap neighbouring slots; one-shots are mixed at their times. The result is exactly
 * the sum of the slot lengths.
 */
export async function mixSceneAudio(
  slots: readonly SceneAudioSlot[],
  out: string,
  opts: ConcatAudioOptions & { sfx?: readonly OneShot[] } = {},
): Promise<ConcatAudioResult> {
  const sr = opts.sampleRate ?? AUDIO_SAMPLE_RATE;
  const layout = (opts.channels ?? 2) === 1 ? "mono" : "stereo";
  const fmt = `aformat=sample_fmts=fltp:sample_rates=${sr}:channel_layouts=${layout}`;
  const toS = (ms: number) => Math.round((ms * sr) / 1000);
  const starts: number[] = [];
  let total = 0;
  for (const [i, s] of slots.entries()) {
    if (!Number.isFinite(s.duration_ms) || s.duration_ms < 0) throw new Error(`slot ${i}: invalid duration_ms ${s.duration_ms}`);
    starts.push(total);
    total += toS(s.duration_ms);
  }
  if (total === 0) throw new Error("mixSceneAudio: total duration is zero");
  const inputs: string[] = [];
  const chains: string[][] = [];
  const mixLabels: string[] = [];
  let nIn = 0;
  const f6 = (n: number) => String(Math.round(n * 1e6) / 1e6);
  slots.forEach((s, i) => {
    const len = toS(s.duration_ms);
    if (len === 0 || s.layers.length === 0) return;
    const next = slots[i + 1];
    // Crossfades are capped at half of either slot.
    const cap = (a: number, b: number, x: number) => Math.min(toS(x), Math.floor(a / 2), Math.floor(b / 2));
    const fadeIn = i > 0 && s.crossfade_ms ? cap(len, toS(slots[i - 1]!.duration_ms), s.crossfade_ms) : 0;
    const tail = next?.crossfade_ms ? cap(len, toS(next.duration_ms), next.crossfade_ms) : 0;
    const need = len + tail;
    const layerLabels: string[] = [];
    s.layers.forEach((l, j) => {
      inputs.push(...(l.offset_sec ? ["-ss", f6(l.offset_sec)] : []), "-i", l.path);
      const lab = `[l${i}_${j}]`;
      const span = l.span_sec !== undefined ? Math.max(1, Math.round(l.span_sec * sr)) : undefined;
      chains.push([
        `[${nIn}:a:0]aresample=${sr}`,
        fmt,
        ...(span !== undefined ? [`atrim=end_sample=${span}`, "asetpts=N/SR/TB"] : []),
        ...(l.loop && span !== undefined ? [`aloop=loop=-1:size=${span}`] : []),
        ...atempoChain(l.tempo ?? 1),
        ...(l.gain_db ? [`volume=${l.gain_db}dB`] : []),
        // atempo may change the format; normalise again before padding.
        fmt,
        `apad=whole_len=${need}`,
        `atrim=end_sample=${need}`,
        `asetpts=N/SR/TB${lab}`,
      ]);
      layerLabels.push(lab);
      nIn++;
    });
    const lab = `[s${i}]`;
    const mixed = layerLabels.length > 1 ? [`${layerLabels.join("")}amix=inputs=${layerLabels.length}:duration=longest:normalize=0`] : [`${layerLabels[0]}anull`];
    chains.push([
      ...mixed,
      ...(fadeIn > 0 ? [`afade=t=in:ss=0:ns=${fadeIn}`] : []),
      ...(tail > 0 ? [`afade=t=out:ss=${len}:ns=${tail}`] : []),
      ...(starts[i]! > 0 ? [`adelay=delays=${starts[i]}S:all=1`] : []),
      `anull${lab}`,
    ]);
    mixLabels.push(lab);
  });
  for (const [k, fx] of (opts.sfx ?? []).entries()) {
    const at = toS(fx.at_ms);
    if (at >= total) continue;
    inputs.push("-i", fx.path);
    const lab = `[fx${k}]`;
    chains.push([
      `[${nIn}:a:0]aresample=${sr}`,
      fmt,
      ...(fx.volume_db ? [`volume=${fx.volume_db}dB`] : []),
      `atrim=end_sample=${total - at}`,
      "asetpts=N/SR/TB",
      ...(at > 0 ? [`adelay=delays=${at}S:all=1`] : []),
      `anull${lab}`,
    ]);
    mixLabels.push(lab);
    nIn++;
  }
  const bed = "[bed]";
  chains.push([`anullsrc=r=${sr}:cl=${layout}`, fmt, `atrim=end_sample=${total}`, `asetpts=N/SR/TB${bed}`]);
  chains.push([`${bed}${mixLabels.join("")}amix=inputs=${mixLabels.length + 1}:duration=first:normalize=0`, `atrim=end_sample=${total}`, "asetpts=N/SR/TB[aout]"]);
  await runFfmpeg(["-y", ...inputs, "-filter_complex", filterGraph(chains), "-map", "[aout]", ...audioCodecArgs(out, sr), out], opts);
  return { path: out, samples: total, duration_ms: Math.round((total / sr) * 1000) };
}

// ---------------------------------------------------------------------------------- music bed

/** Defaults for a music bed under narration (spec.audio.music). */
export const MUSIC_DEFAULTS = { volume_db: -18, duck_db: -10, fade_in_ms: 500, fade_out_ms: 1500, ramp_ms: 150 } as const;

export interface MusicBedInput {
  path: string;
  /** Bed level before ducking, dB. Default -18. */
  volume_db?: number;
  /** Extra attenuation while speech plays, dB. Default -10. */
  duck_db?: number;
  fade_in_ms?: number;
  fade_out_ms?: number;
  /** Loop the file to cover the duration. Default true. */
  loop?: boolean;
  start_sec?: number;
}

export interface SpeechInterval {
  start_ms: number;
  end_ms: number;
}

export interface MixMusicInput {
  /** Voice track (any format ffmpeg reads); absent for music-only videos. */
  voice?: string;
  music: MusicBedInput;
  duration_ms: number;
  /** Where speech plays; the bed ducks by `duck_db` there, with short ramps. */
  speech?: readonly SpeechInterval[];
  /** Where the bed is silent (footage scenes with native or muted sound), with short ramps. */
  mute?: readonly SpeechInterval[];
  out: string;
}

/** Merge intervals that overlap or sit closer than `gapMs`, sorted by start. */
export function mergeIntervals(intervals: readonly SpeechInterval[], gapMs: number): SpeechInterval[] {
  const sorted = intervals.filter((i) => i.end_ms > i.start_ms).map((i) => ({ ...i })).sort((a, b) => a.start_ms - b.start_ms);
  const out: SpeechInterval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start_ms - last.end_ms <= gapMs) last.end_ms = Math.max(last.end_ms, i.end_ms);
    else out.push(i);
  }
  return out;
}

/**
 * ffmpeg `volume` expression (eval=frame) that is 1 outside speech and `duckGain` inside it, with
 * linear ramps of `rampMs` before and after each interval. Intervals must not overlap (merge first).
 */
export function duckExpression(speech: readonly SpeechInterval[], duckGain: number, rampMs: number = MUSIC_DEFAULTS.ramp_ms): string {
  if (speech.length === 0) return "1";
  const r = Math.max(1, rampMs) / 1000;
  const f = (n: number) => String(Math.round(n * 1000) / 1000);
  // s(t) in [0,1]: how far into a (ramped) speech interval t is; the sum works because intervals are disjoint.
  const terms = speech.map((i) => {
    const a = i.start_ms / 1000;
    const b = i.end_ms / 1000;
    return `clip(min((t-${f(a - r)})/${f(r)},(${f(b + r)}-t)/${f(r)}),0,1)`;
  });
  return `1-${f(1 - duckGain)}*min(1,${terms.join("+")})`;
}

/**
 * Mix a looping, faded music bed under the voice (or alone), ducking it over the speech intervals.
 * The result is exactly `duration_ms` long; loudness normalization happens afterwards on the mix.
 */
export async function mixMusic(input: MixMusicInput, opts: ConcatAudioOptions = {}): Promise<{ path: string; duration_ms: number }> {
  const sr = opts.sampleRate ?? AUDIO_SAMPLE_RATE;
  const m = input.music;
  const samples = Math.round((input.duration_ms * sr) / 1000);
  if (samples <= 0) throw new Error("mixMusic: duration is zero");
  const dur = samples / sr;
  const fadeIn = Math.min((m.fade_in_ms ?? MUSIC_DEFAULTS.fade_in_ms) / 1000, dur / 2);
  const fadeOut = Math.min((m.fade_out_ms ?? MUSIC_DEFAULTS.fade_out_ms) / 1000, dur / 2);
  const fmt = `aformat=sample_fmts=fltp:sample_rates=${sr}:channel_layouts=stereo`;
  const speech = input.voice ? mergeIntervals(input.speech ?? [], 2 * MUSIC_DEFAULTS.ramp_ms) : [];
  const duckGain = 10 ** ((m.duck_db ?? MUSIC_DEFAULTS.duck_db) / 20);
  const mute = mergeIntervals(input.mute ?? [], 0);
  const musicChain = [
    `[0:a:0]aresample=${sr}`,
    fmt,
    `atrim=end_sample=${samples}`,
    `apad=whole_len=${samples}`,
    "asetpts=N/SR/TB",
    `volume=${m.volume_db ?? MUSIC_DEFAULTS.volume_db}dB`,
    ...(speech.length ? [`volume='${duckExpression(speech, duckGain)}':eval=frame`] : []),
    ...(mute.length ? [`volume='${duckExpression(mute, 0)}':eval=frame`] : []),
    ...(fadeIn > 0 ? [`afade=t=in:st=0:d=${fadeIn}`] : []),
    ...(fadeOut > 0 ? [`afade=t=out:st=${Math.max(0, dur - fadeOut)}:d=${fadeOut}`] : []),
  ];
  const loop = m.loop ?? true;
  const inputs = [...(loop ? ["-stream_loop", "-1"] : []), ...(m.start_sec ? ["-ss", String(m.start_sec)] : []), "-i", m.path];
  const chains: string[][] = [];
  if (input.voice) {
    inputs.push("-i", input.voice);
    chains.push([...musicChain, "anull[m]"]);
    chains.push([`[1:a:0]aresample=${sr}`, fmt, `apad=whole_len=${samples}`, `atrim=end_sample=${samples}`, "asetpts=N/SR/TB[v]"]);
    chains.push(["[v][m]amix=inputs=2:duration=first:normalize=0", `atrim=end_sample=${samples}[aout]`]);
  } else {
    chains.push([...musicChain, "anull[aout]"]);
  }
  await runFfmpeg(["-y", ...inputs, "-filter_complex", filterGraph(chains), "-map", "[aout]", ...audioCodecArgs(input.out, sr), input.out], opts);
  return { path: input.out, duration_ms: Math.round((samples / sr) * 1000) };
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

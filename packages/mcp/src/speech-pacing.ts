import { ffprobe, runFfmpeg } from "@video-studio/media";
import type { FormatGrammar } from "@video-studio/schema";

/**
 * Measured speech pacing: the pauses inside speech of a video or audio file, from ffmpeg
 * `silencedetect` on the voice band (200–3500 Hz below -35 dBFS for at least 100 ms). Structure
 * only: no audio is kept. Feeds `analyze` (`speech_pacing`) and `tighten pacing_from`.
 */

export type SpeechPacing = NonNullable<FormatGrammar["speech_pacing"]>;

export interface Silence {
  start_ms: number;
  end_ms: number;
}

/** Shortest silence counted as a pause. */
export const MIN_PAUSE_MS = 100;
/** Silences at least this long count against `speech_ratio` (the analyze rule since 0.2). */
export const SPEECH_RATIO_MIN_SILENCE_MS = 300;

/** Silences from `silencedetect` stderr; a silence still open at the end runs to `durationMs`. */
export function parseSilences(stderr: string, durationMs: number): Silence[] {
  const starts = [...stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => Math.max(0, Number(m[1]) * 1000));
  const ends = [...stderr.matchAll(/silence_end:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]) * 1000);
  return starts.map((s, i) => ({ start_ms: Math.round(s), end_ms: Math.round(Math.min(ends[i] ?? durationMs, durationMs)) })).filter((x) => x.end_ms > x.start_ms);
}

/** Voice-band silences of a file (one decode). */
export async function measureSilences(path: string, durationMs: number, signal?: AbortSignal): Promise<Silence[]> {
  const r = await runFfmpeg(["-i", path, "-map", "0:a:0", "-vn", "-af", `highpass=f=200,lowpass=f=3500,silencedetect=n=-35dB:d=${MIN_PAUSE_MS / 1000}`, "-f", "null", "-"], {
    keepStderr: true,
    timeoutMs: 30 * 60 * 1000,
    ...(signal ? { signal } : {}),
  });
  return parseSilences(r.stderr, durationMs);
}

/** Share of the file with voice-band sound (silences of 300 ms or more count as silent). */
export function soundShareOf(silences: readonly Silence[], durationMs: number): number {
  const silent = silences.filter((s) => s.end_ms - s.start_ms >= SPEECH_RATIO_MIN_SILENCE_MS).reduce((t, s) => t + (s.end_ms - s.start_ms), 0);
  return Math.max(0, Math.min(1, 1 - silent / Math.max(durationMs, 1)));
}

/** Nearest-rank percentile of sorted values. */
function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

/**
 * Pause statistics: the pauses are the silences inside speech (a silence touching the start or
 * the end of the file is lead-in or tail, not a pause). `silence_share` is the pauses' total over
 * the speech span (first sound to last sound); median and p95 use the nearest rank and are null
 * without pauses.
 */
export function speechPacing(silences: readonly Silence[], durationMs: number): SpeechPacing {
  const EDGE = 20;
  const sorted = [...silences].sort((a, b) => a.start_ms - b.start_ms);
  const lead = sorted.find((s) => s.start_ms <= EDGE);
  const tail = [...sorted].reverse().find((s) => s.end_ms >= durationMs - EDGE);
  const spanStart = lead ? lead.end_ms : 0;
  const spanEnd = tail && tail !== lead ? tail.start_ms : durationMs;
  const pauses = sorted.filter((s) => s !== lead && s !== tail).map((s) => s.end_ms - s.start_ms);
  const span = Math.max(1, spanEnd - spanStart);
  const total = pauses.reduce((t, d) => t + d, 0);
  const lengths = [...pauses].sort((a, b) => a - b);
  return {
    silence_share: lead && tail === lead ? 1 : Math.round(Math.min(1, total / span) * 1000) / 1000,
    pauses_analyzed: pauses.length,
    pause_median_ms: lengths.length ? percentile(lengths, 50) : null,
    pause_p95_ms: lengths.length ? percentile(lengths, 95) : null,
  };
}

/** Pause statistics of a file (probe + one silencedetect pass). */
export async function measureSpeechPacing(path: string, signal?: AbortSignal): Promise<SpeechPacing> {
  const p = await ffprobe(path);
  if (!p.has_audio) throw new Error(`${path} has no audio track to measure pauses in`);
  const durationMs = Math.round(p.duration_s * 1000);
  return speechPacing(await measureSilences(path, durationMs, signal), durationMs);
}

export const PACING_MAX_PAUSE_RANGE: readonly [number, number] = [250, 1500];
export const PACING_KEEP_PAUSE_RANGE: readonly [number, number] = [120, 600];

const clamp = (x: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, Math.round(x)));

/**
 * tighten limits from measured pacing: pauses up to the speaker's own p95 stay, longer ones are
 * shortened to their median. max_pause_ms = clamp(p95, 250, 1500), keep_pause_ms =
 * clamp(median, 120, 600) and never above max_pause_ms. The clamps keep a pause-heavy or
 * pause-free reference from producing a rushed or untouched edit.
 */
export function pacingLimits(p: SpeechPacing): { max_pause_ms: number; keep_pause_ms: number } {
  if (p.pause_p95_ms === null || p.pause_median_ms === null || p.pauses_analyzed === 0) {
    throw new Error("the pacing reference has no pauses inside speech to learn from; pass max_pause_ms/keep_pause_ms instead");
  }
  const max_pause_ms = clamp(p.pause_p95_ms, PACING_MAX_PAUSE_RANGE);
  return { max_pause_ms, keep_pause_ms: Math.min(clamp(p.pause_median_ms, PACING_KEEP_PAUSE_RANGE), max_pause_ms) };
}

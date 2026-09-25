/**
 * Minimal local ffmpeg/ffprobe helpers for the voice package.
 * TODO: replace with @video-studio/media once its resolver/helpers land.
 */
import { runChecked, type CommandRunner, type RunOptions } from "./exec.js";

export interface FfTools {
  ffmpeg: string;
  ffprobe: string;
  runner: CommandRunner;
}

/** Convert any input audio to 48 kHz mono 16-bit PCM WAV. */
export async function toWav48kMono(tools: FfTools, input: string, output: string, opts?: RunOptions): Promise<void> {
  await runChecked(
    tools.runner,
    tools.ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", output],
    "ffmpeg (convert to wav)",
    opts,
  );
}

/** Concatenate audio files into one 48 kHz mono WAV. */
export async function concatToWav(tools: FfTools, inputs: string[], output: string, opts?: RunOptions): Promise<void> {
  if (inputs.length === 1) return toWav48kMono(tools, inputs[0]!, output, opts);
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const i of inputs) args.push("-i", i);
  const labels = inputs.map((_, i) => `[${i}:a]`).join("");
  args.push(
    "-filter_complex",
    `${labels}concat=n=${inputs.length}:v=0:a=1[a]`,
    "-map",
    "[a]",
    "-ar",
    "48000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    output,
  );
  await runChecked(tools.runner, tools.ffmpeg, args, "ffmpeg (concat)", opts);
}

/** Container duration in integer milliseconds. */
export async function probeDurationMs(tools: FfTools, file: string, opts?: RunOptions): Promise<number> {
  const res = await runChecked(
    tools.runner,
    tools.ffprobe,
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
    "ffprobe (duration)",
    opts,
  );
  const sec = Number.parseFloat(res.stdout.trim());
  if (!Number.isFinite(sec) || sec < 0) throw new Error(`ffprobe returned no duration for ${file}`);
  return Math.round(sec * 1000);
}

export interface EdgeSilence {
  leadMs: number;
  trailMs: number;
}

/**
 * Parse ffmpeg `silencedetect` stderr into leading/trailing silence.
 * Leading: a silence starting at ~0. Trailing: a silence ending at ~EOF (ffmpeg closes open
 * silences at EOF). Returns zeros when the result would swallow most of the audio.
 */
export function parseEdgeSilence(stderr: string, durationMs: number): EdgeSilence {
  const spans: Array<{ start: number; end?: number }> = [];
  for (const line of stderr.split("\n")) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) spans.push({ start: Math.max(0, Number.parseFloat(s[1]!) * 1000) });
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e && spans.length) spans[spans.length - 1]!.end = Number.parseFloat(e[1]!) * 1000;
  }
  let leadMs = 0;
  let trailMs = 0;
  const first = spans[0];
  const leading = first && first.start <= 10 && first.end !== undefined ? first : undefined;
  if (leading) leadMs = leading.end!;
  const last = spans[spans.length - 1];
  if (last && last !== leading && (last.end === undefined || last.end >= durationMs - 50)) {
    trailMs = durationMs - last.start;
  }
  leadMs = Math.max(0, Math.round(leadMs));
  trailMs = Math.max(0, Math.round(trailMs));
  if (leadMs + trailMs > durationMs * 0.8) return { leadMs: 0, trailMs: 0 };
  return { leadMs, trailMs };
}

/** Detect leading/trailing silence with ffmpeg `silencedetect`; zeros on any failure. */
export async function detectEdgeSilence(
  tools: FfTools,
  file: string,
  durationMs: number,
  opts?: RunOptions,
): Promise<EdgeSilence> {
  try {
    const res = await tools.runner(
      tools.ffmpeg,
      ["-hide_banner", "-nostats", "-i", file, "-af", "silencedetect=noise=-45dB:d=0.08", "-f", "null", "-"],
      opts,
    );
    if (res.code !== 0) return { leadMs: 0, trailMs: 0 };
    return parseEdgeSilence(res.stderr, durationMs);
  } catch {
    return { leadMs: 0, trailMs: 0 };
  }
}

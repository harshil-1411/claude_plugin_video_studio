import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { FfmpegError, runFfmpeg, runProcess } from "./ffmpeg.js";

/**
 * Local speech recognition with whisper.cpp (`whisper-cli`) and caption-file import, producing
 * timed words. The media file is only decoded to 16 kHz mono PCM; nothing in it is executed.
 */

export interface TimedWord {
  word: string;
  start_ms: number;
  end_ms: number;
}

export interface AsrOptions {
  /** ggml model file (e.g. ggml-base.en.bin). */
  model: string;
  /** whisper-cli binary (default: on PATH). */
  bin?: string;
  language?: string;
  signal?: AbortSignal;
  /** false forces CPU (`-ng`). Default: try the GPU and retry on CPU if whisper-cli crashes. */
  gpu?: boolean;
  /** Kill whisper-cli after this long. Default 60 minutes. */
  timeoutMs?: number;
}

/** Language passed to whisper-cli: explicit, else `en` for English-only (`*.en`) models, else auto-detect. */
export function whisperLanguage(model: string, language?: string): string {
  if (language) return language;
  return /\.en(?:[.-]|$)/i.test(basename(model).replace(/\.bin$/i, "")) ? "en" : "auto";
}

/**
 * Transcribe a video or audio file into timed words: ffmpeg extracts 16 kHz mono PCM, then
 * `whisper-cli -ml 1 -sow -oj` emits one segment per word with millisecond offsets.
 */
export async function whisperTranscribe(mediaPath: string, opts: AsrOptions): Promise<TimedWord[]> {
  const work = await mkdtemp(join(tmpdir(), "vs-asr-"));
  try {
    const wav = join(work, "audio.wav");
    await runFfmpeg(["-y", "-i", mediaPath, "-vn", "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], {
      ...(opts.signal ? { signal: opts.signal } : {}),
      timeoutMs: 30 * 60 * 1000,
    });
    const outBase = join(work, "out");
    const bin = opts.bin ?? "whisper-cli";
    const args = (cpu: boolean) => [
      "-m", opts.model,
      "-f", wav,
      "-l", whisperLanguage(opts.model, opts.language),
      "-ml", "1",
      "-sow",
      "-oj",
      "-of", outBase,
      "-np",
      ...(cpu ? ["-ng"] : []),
    ];
    const run = (cpu: boolean) =>
      runProcess(bin, args(cpu), { ...(opts.signal ? { signal: opts.signal } : {}), timeoutMs: opts.timeoutMs ?? 60 * 60 * 1000 });
    try {
      await run(opts.gpu === false);
    } catch (err) {
      // A GPU backend that cannot allocate (headless/sandboxed Metal) crashes whisper-cli; CPU works.
      const retriable = opts.gpu === undefined && err instanceof FfmpegError && err.exitCode !== 0 && !opts.signal?.aborted && !/could not start/.test(err.message);
      if (!retriable) throw whisperError(err, bin);
      try {
        await run(true);
      } catch (err2) {
        throw whisperError(err2, bin);
      }
    }
    return parseWhisperJson(await readFile(`${outBase}.json`, "utf8"));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function whisperError(err: unknown, bin: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/could not start/.test(msg)) {
    return new Error(`${bin} not found: install whisper.cpp (macOS: \`brew install whisper-cpp\`) or import a caption file (captions_file: .srt/.vtt) instead`);
  }
  return new Error(`whisper-cli failed: ${msg}`);
}

interface WhisperSegment {
  offsets?: { from?: number; to?: number };
  text?: string;
}

/** Non-speech annotations whisper emits as text: `[BLANK_AUDIO]`, `[Music]`, `(laughs)`, `*sigh*`. */
const NON_SPEECH = /^(?:\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+)$/;

/**
 * whisper-cli `-oj` output (with `-ml 1 -sow`: one segment per word) → timed words. Segments
 * without leading whitespace continue the previous word (`don` + `'t`, a lone `,`).
 */
export function parseWhisperJson(json: string): TimedWord[] {
  const data = JSON.parse(json) as { transcription?: WhisperSegment[] };
  const words: TimedWord[] = [];
  let prevNonSpeech = false;
  for (const seg of data.transcription ?? []) {
    const raw = seg.text ?? "";
    const text = raw.trim();
    const from = Number(seg.offsets?.from);
    const to = Number(seg.offsets?.to);
    if (!text || !Number.isFinite(from) || !Number.isFinite(to)) continue;
    if (NON_SPEECH.test(text)) {
      prevNonSpeech = true;
      continue;
    }
    const last = words[words.length - 1];
    if (last && !/^\s/.test(raw) && !prevNonSpeech) {
      last.word += text;
      last.end_ms = Math.max(last.end_ms, to);
    } else {
      words.push({ word: text, start_ms: Math.max(0, from), end_ms: Math.max(from, to) });
    }
    prevNonSpeech = false;
  }
  return monotonic(words);
}

/** Force non-decreasing, non-overlapping times. */
function monotonic(words: TimedWord[]): TimedWord[] {
  let t = 0;
  for (const w of words) {
    w.start_ms = Math.max(Math.round(w.start_ms), t);
    w.end_ms = Math.max(Math.round(w.end_ms), w.start_ms);
    t = w.end_ms;
  }
  return words;
}

// ---------------------------------------------------------------------------------- captions

const CUE_TIME = /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;

function parseTimestamp(t: string): number {
  const [hms, frac = "0"] = t.split(/[.,]/);
  const parts = hms!.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts as [number, number, number];
  return ((h * 60 + m) * 60 + s) * 1000 + Number(frac.padEnd(3, "0").slice(0, 3));
}

/** Strip VTT/SRT markup: `<v Name>`, `<i>`, `<00:00:01.000>`, `{\an8}`, HTML entities. */
function cleanCueText(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the text is a WebVTT file (else SRT is assumed). */
export function isVtt(text: string): boolean {
  return /^﻿?WEBVTT/.test(text);
}

/** Parse an SRT or VTT file into timed words (cue time spread evenly over its words). */
export function parseCaptionFile(text: string): TimedWord[] {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const words: TimedWord[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = CUE_TIME.exec(lines[i]!);
    if (!m) continue;
    const start = parseTimestamp(m[1]!);
    const end = Math.max(start, parseTimestamp(m[2]!));
    const body: string[] = [];
    while (i + 1 < lines.length && lines[i + 1]!.trim() !== "") body.push(lines[++i]!);
    const cueWords = cleanCueText(body.join(" ")).split(" ").filter((w) => w && !NON_SPEECH.test(w));
    const n = cueWords.length;
    cueWords.forEach((word, k) => {
      words.push({ word, start_ms: Math.round(start + ((end - start) * k) / n), end_ms: Math.round(start + ((end - start) * (k + 1)) / n) });
    });
  }
  return monotonic(words);
}

// ---------------------------------------------------------------------------------- sentences

export interface TimedSentence {
  text: string;
  start_ms: number;
  end_ms: number;
  /** Index range [first, last] into the word list. */
  first: number;
  last: number;
}

export interface SentenceOptions {
  /** A silence at least this long ends a sentence even without punctuation. Default 700 ms. */
  pauseMs?: number;
  /** Hard cap on words per sentence. Default 60. */
  maxWords?: number;
}

/** Group timed words into sentences: terminal punctuation (. ? ! …), a long pause, or the word cap. */
export function groupSentences(words: readonly TimedWord[], opts: SentenceOptions = {}): TimedSentence[] {
  const pause = opts.pauseMs ?? 700;
  const maxWords = opts.maxWords ?? 60;
  const out: TimedSentence[] = [];
  let first = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const next = words[i + 1];
    const terminal = /[.?!…]["'”’)\]]*$/.test(w.word) && !/^(?:[A-Z]\.|Mr\.|Mrs\.|Ms\.|Dr\.|St\.|vs\.|e\.g\.|i\.e\.)$/.test(w.word);
    const gap = next ? next.start_ms - w.end_ms : Infinity;
    if (!next || terminal || gap >= pause || i - first + 1 >= maxWords) {
      const slice = words.slice(first, i + 1);
      out.push({ text: slice.map((x) => x.word).join(" "), start_ms: slice[0]!.start_ms, end_ms: w.end_ms, first, last: i });
      first = i + 1;
    }
  }
  return out;
}

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
  /**
   * Speaker label from speaker-turn detection (`S1`, `S2`, …). Present only when the transcript
   * was made with turn detection (tinydiarize); absent otherwise.
   */
  speaker?: string;
}

export interface AsrOptions {
  /** ggml model file (e.g. ggml-base.en.bin). */
  model: string;
  /** whisper-cli binary (default: on PATH). */
  bin?: string;
  /** ISO 639-1 code (`es`) or `auto`. Default: `en` for `*.en` models, else `auto` (detect). */
  language?: string;
  /** Detect speaker turns (`-tdrz`); needs a tinydiarize model (`ggml-small.en-tdrz.bin`). */
  speakers?: boolean;
  signal?: AbortSignal;
  /** false forces CPU (`-ng`). Default: try the GPU and retry on CPU if whisper-cli crashes. */
  gpu?: boolean;
  /** Kill whisper-cli after this long. Default 60 minutes. */
  timeoutMs?: number;
}

/** Language passed to whisper-cli: explicit, else `en` for English-only (`*.en`) models, else auto-detect. */
export function whisperLanguage(model: string, language?: string): string {
  if (language) return language;
  return isEnglishOnlyModel(model) ? "en" : "auto";
}

/** True for an English-only whisper model file (`ggml-base.en.bin`, `ggml-small.en-tdrz.bin`). */
export function isEnglishOnlyModel(model: string): boolean {
  return /\.en(?:[.-]|$)/i.test(basename(model).replace(/\.bin$/i, ""));
}

export interface WhisperResult {
  words: TimedWord[];
  /** Language whisper reports (`result.language`); always `en` for English-only models. */
  language?: string;
  /** Speaker turns found (only with `speakers: true`). */
  speaker_turns?: number;
}

/**
 * Transcribe a video or audio file into timed words: ffmpeg extracts 16 kHz mono PCM, then
 * `whisper-cli -ml 1 -sow -oj` emits one segment per word with millisecond offsets.
 */
export async function whisperTranscribe(mediaPath: string, opts: AsrOptions): Promise<TimedWord[]> {
  return (await whisperTranscribeDetailed(mediaPath, opts)).words;
}

/**
 * {@link whisperTranscribe} plus the detected language and, with `speakers: true` (tinydiarize,
 * `-tdrz`), word-level speaker labels. `-tdrz` works with word segmentation (`-ml 1`): whisper
 * marks `speaker_turn_next` on the last word before a turn.
 */
export async function whisperTranscribeDetailed(mediaPath: string, opts: AsrOptions): Promise<WhisperResult> {
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
      ...(opts.speakers ? ["-tdrz"] : []),
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
    return parseWhisperOutput(await readFile(`${outBase}.json`, "utf8"), { speakers: opts.speakers === true });
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
  /** tinydiarize (`-tdrz`): the speaker changes after this segment. */
  speaker_turn_next?: boolean;
}

/** Non-speech annotations whisper emits as text: `[BLANK_AUDIO]`, `[Music]`, `(laughs)`, `*sigh*`. */
const NON_SPEECH = /^(?:\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+)$/;

/**
 * whisper-cli `-oj` output (with `-ml 1 -sow`: one segment per word) → timed words. Segments
 * without leading whitespace continue the previous word (`don` + `'t`, a lone `,`).
 */
export function parseWhisperJson(json: string): TimedWord[] {
  return parseWhisperOutput(json).words;
}

/**
 * Parse whisper-cli JSON into words, the detected language and (with `speakers`) speaker labels.
 * A `speaker_turn_next` flag ends the current speaker's run; runs are labelled S1, S2, S1, …
 * alternating, which assumes a two-person conversation (tinydiarize detects turn changes, not
 * who speaks; relabel the words when more people talk).
 */
export function parseWhisperOutput(json: string, opts: { speakers?: boolean } = {}): WhisperResult {
  const data = JSON.parse(json) as { transcription?: WhisperSegment[]; result?: { language?: unknown } };
  const words: TimedWord[] = [];
  let prevNonSpeech = false;
  let speaker = 1;
  let pendingTurn = false;
  let turns = 0;
  for (const seg of data.transcription ?? []) {
    const raw = seg.text ?? "";
    const text = raw.trim();
    const from = Number(seg.offsets?.from);
    const to = Number(seg.offsets?.to);
    const turn = seg.speaker_turn_next === true;
    if (!text || !Number.isFinite(from) || !Number.isFinite(to) || NON_SPEECH.test(text)) {
      if (text && NON_SPEECH.test(text)) prevNonSpeech = true;
      // A turn marked on a blank/non-speech segment still ends the speaker's run.
      if (turn && words.length) pendingTurn = true;
      continue;
    }
    const last = words[words.length - 1];
    if (last && !/^\s/.test(raw) && !prevNonSpeech) {
      last.word += text;
      last.end_ms = Math.max(last.end_ms, to);
    } else {
      if (pendingTurn) {
        speaker = speaker === 1 ? 2 : 1;
        turns++;
        pendingTurn = false;
      }
      words.push({ word: text, start_ms: Math.max(0, from), end_ms: Math.max(from, to), ...(opts.speakers ? { speaker: `S${speaker}` } : {}) });
    }
    if (turn) pendingTurn = true;
    prevNonSpeech = false;
  }
  const lang = typeof data.result?.language === "string" && data.result.language.trim() ? data.result.language.trim() : undefined;
  return {
    words: monotonic(words),
    ...(lang ? { language: lang } : {}),
    ...(opts.speakers ? { speaker_turns: turns } : {}),
  };
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
  /** Speaker label of the sentence's words (only when the words carry one). */
  speaker?: string;
}

export interface SentenceOptions {
  /** A silence at least this long ends a sentence even without punctuation. Default 700 ms. */
  pauseMs?: number;
  /** Hard cap on words per sentence. Default 60. */
  maxWords?: number;
}

/**
 * Group timed words into sentences: terminal punctuation (. ? ! …), a long pause, the word cap,
 * or a change of speaker label (words with `speaker`).
 */
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
    const turn = next !== undefined && w.speaker !== undefined && next.speaker !== undefined && w.speaker !== next.speaker;
    if (!next || terminal || turn || gap >= pause || i - first + 1 >= maxWords) {
      const slice = words.slice(first, i + 1);
      const speaker = slice[0]!.speaker;
      out.push({ text: slice.map((x) => x.word).join(" "), start_ms: slice[0]!.start_ms, end_ms: w.end_ms, first, last: i, ...(speaker !== undefined ? { speaker } : {}) });
      first = i + 1;
    }
  }
  return out;
}

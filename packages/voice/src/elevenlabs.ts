import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SceneVoiceTrack, WordTiming } from "@video-studio/schema";
import { ensureDir } from "@video-studio/core";
import { isCjkUnitChar, isNoStartChar } from "./estimate.js";
import { defaultResolver, defaultRunner, type CommandRunner, type ToolResolver } from "./exec.js";
import { concatToWav, probeDurationMs, type FfTools } from "./ffmpeg.js";
import type { Availability, Env, SynthesisContext, SynthesisInput, VoiceBackend } from "./types.js";

export const ELEVENLABS_API_BASE = "https://api.elevenlabs.io";
export const DEFAULT_ELEVENLABS_MODEL = "eleven_multilingual_v2";
export const DEFAULT_ELEVENLABS_OUTPUT = "mp3_44100_128";
/** "Rachel", a stock premade voice; override with spec.voice.voice_id or ELEVENLABS_VOICE_ID. */
export const DEFAULT_ELEVENLABS_VOICE = "21m00Tcm4TlvDq8ikWAM";
/** Per-request character budget; well under every current model's limit (5k for eleven_v3). */
export const DEFAULT_CHUNK_CHARS = 2500;

export interface CharacterAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

export interface WithTimestampsResponse {
  audio_base64: string;
  alignment?: CharacterAlignment | null;
  normalized_alignment?: CharacterAlignment | null;
}

const WORDLIKE = /[\p{L}\p{N}]/u;

/**
 * Group ElevenLabs character-level alignment into words.
 * - Whitespace separates words (runs of spaces are fine).
 * - A punctuation-only group ("—", "!") is attached to the preceding word, keeping that word's end
 *   time; with no preceding word it is prefixed to the next one.
 * - A word's start is its first character's start; its end is the end of its last letter/digit
 *   (trailing punctuation carries no speech time).
 * - Times are integer ms offset by `offsetMs`, forced monotonic and non-overlapping.
 */
export function alignmentToWords(alignment: CharacterAlignment, offsetMs = 0): WordTiming[] {
  const { characters: chars, character_start_times_seconds: starts, character_end_times_seconds: ends } = alignment;
  const out: WordTiming[] = [];
  let pendingPrefix = "";
  let text = "";
  let start = -1;
  let end = -1;
  let lastSpokenEnd = -1;

  const flush = () => {
    if (!text) return;
    if (!WORDLIKE.test(text)) {
      if (out.length) out[out.length - 1]!.word += text;
      else pendingPrefix += text;
    } else {
      const s = Math.round(start * 1000) + offsetMs;
      const e = Math.round((lastSpokenEnd >= 0 ? lastSpokenEnd : end) * 1000) + offsetMs;
      out.push({ word: pendingPrefix + text, start_ms: s, end_ms: e });
      pendingPrefix = "";
    }
    text = "";
    start = -1;
    end = -1;
    lastSpokenEnd = -1;
  };

  // CJK has no spaces: each ideograph/kana is a word; small kana, ー and closing punctuation join it.
  let cjkOpen = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] ?? "";
    if (/^\s*$/u.test(c)) {
      flush();
      cjkOpen = false;
      continue;
    }
    if (isCjkUnitChar(c) && !(cjkOpen && isNoStartChar(c))) {
      flush();
      cjkOpen = true;
    } else if (cjkOpen && !isNoStartChar(c)) {
      flush();
      cjkOpen = false;
    }
    if (start < 0) start = starts[i] ?? 0;
    end = ends[i] ?? end;
    if (WORDLIKE.test(c)) lastSpokenEnd = ends[i] ?? lastSpokenEnd;
    text += c;
  }
  flush();

  let prev = 0;
  for (const w of out) {
    w.start_ms = Math.max(prev, w.start_ms);
    w.end_ms = Math.max(w.start_ms, w.end_ms);
    prev = w.end_ms;
  }
  return out;
}

/** Split text into chunks of at most `max` chars, preferring sentence, then word boundaries. */
export function chunkText(text: string, max = DEFAULT_CHUNK_CHARS): string[] {
  const clean = text.trim();
  if (clean.length <= max) return clean ? [clean] : [];
  const sentences = clean.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)\s*/gu) ?? [clean];
  const chunks: string[] = [];
  let cur = "";
  const push = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = "";
  };
  for (const s of sentences) {
    if ((cur + s).length <= max) {
      cur += s;
      continue;
    }
    push();
    if (s.length <= max) {
      cur = s;
      continue;
    }
    for (const w of s.split(/(\s+)/)) {
      if ((cur + w).length > max) push();
      cur += w;
    }
  }
  push();
  return chunks;
}

export interface ElevenLabsOptions {
  fetch?: typeof fetch;
  runner?: CommandRunner;
  resolver?: ToolResolver;
  modelId?: string;
  outputFormat?: string;
  seed?: number;
  pronunciationDictionaryLocators?: Array<{ pronunciation_dictionary_id: string; version_id?: string }>;
  baseUrl?: string;
  chunkChars?: number;
}

export class ElevenLabsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ElevenLabsError";
  }
}

/** An unset `${user_config.X}` may reach the env as the literal placeholder: that is not a key. */
function isPlaceholder(v: string): boolean {
  return /^\$\{[^}]*\}$/.test(v);
}

function apiKey(env: Env): string | undefined {
  const k = env.ELEVENLABS_API_KEY?.trim();
  return k && !isPlaceholder(k) ? k : undefined;
}

/**
 * ElevenLabs `with-timestamps` TTS over plain fetch. Enabled only when ELEVENLABS_API_KEY is set.
 * Long scripts are chunked; each chunk passes up to 3 `previous_request_ids` for prosody continuity
 * (also across scenes within one backend instance) and its word times are offset by the cumulative
 * measured audio duration. The key is only ever sent in the `xi-api-key` header, never logged.
 */
export function createElevenLabsBackend(options: ElevenLabsOptions = {}): Omit<VoiceBackend, "available"> & { available(env: Env): Availability } {
  const doFetch = options.fetch ?? globalThis.fetch;
  const runner = options.runner ?? defaultRunner;
  const resolver = options.resolver ?? defaultResolver;
  const modelId = options.modelId ?? DEFAULT_ELEVENLABS_MODEL;
  const outputFormat = options.outputFormat ?? DEFAULT_ELEVENLABS_OUTPUT;
  const baseUrl = (options.baseUrl ?? ELEVENLABS_API_BASE).replace(/\/+$/, "");
  const recentRequestIds: string[] = [];

  const available = (env: Env): Availability => {
    if (!apiKey(env)) {
      const raw = env.ELEVENLABS_API_KEY?.trim();
      return { ok: false, reason: raw && isPlaceholder(raw) ? "ELEVENLABS_API_KEY not set (unexpanded ${user_config...} placeholder)" : "ELEVENLABS_API_KEY not set" };
    }
    if (!resolver("ffmpeg", env) || !resolver("ffprobe", env)) {
      return { ok: false, reason: "ELEVENLABS_API_KEY set but ffmpeg/ffprobe missing" };
    }
    return { ok: true, reason: "ELEVENLABS_API_KEY set" };
  };

  const resolveVoice = async (requested: string | undefined, env: Env) =>
    requested ?? (env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_ELEVENLABS_VOICE);

  const request = async (voiceId: string, text: string, key: string, signal?: AbortSignal) => {
    const body: Record<string, unknown> = { text, model_id: modelId };
    if (recentRequestIds.length) body.previous_request_ids = recentRequestIds.slice(-3);
    if (options.seed !== undefined) body.seed = options.seed;
    if (options.pronunciationDictionaryLocators?.length) {
      body.pronunciation_dictionary_locators = options.pronunciationDictionaryLocators;
    }
    const url = `${baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=${encodeURIComponent(outputFormat)}`;
    const res = await doFetch(url, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300).replaceAll(key, "***");
      throw new ElevenLabsError(`ElevenLabs TTS failed: HTTP ${res.status}${detail ? ` ${detail}` : ""}`, res.status);
    }
    const json = (await res.json()) as WithTimestampsResponse;
    if (!json || typeof json.audio_base64 !== "string" || !json.audio_base64) {
      throw new ElevenLabsError("ElevenLabs response missing audio_base64");
    }
    const requestId = res.headers.get("request-id");
    if (requestId) {
      recentRequestIds.push(requestId);
      if (recentRequestIds.length > 3) recentRequestIds.shift();
    }
    return json;
  };

  const synthesize = async (input: SynthesisInput, ctx: SynthesisContext): Promise<SceneVoiceTrack> => {
    const key = apiKey(ctx.env);
    if (!key) throw new ElevenLabsError("ELEVENLABS_API_KEY not set");
    const ffmpeg = resolver("ffmpeg", ctx.env);
    const ffprobe = resolver("ffprobe", ctx.env);
    if (!ffmpeg || !ffprobe) throw new ElevenLabsError("ffmpeg/ffprobe missing");
    const tools: FfTools = { ffmpeg, ffprobe, runner };
    const run = { signal: ctx.signal };
    const voice = (await resolveVoice(input.voice, ctx.env))!;
    const chunks = chunkText(input.text, options.chunkChars ?? DEFAULT_CHUNK_CHARS);

    await ensureDir(ctx.outDir);
    const outFile = join(ctx.outDir, `${input.scene_id}.wav`);
    const work = await mkdtemp(join(tmpdir(), "vs-11l-"));
    try {
      const parts: string[] = [];
      const words: WordTiming[] = [];
      let offset = 0;
      for (const [i, chunk] of chunks.entries()) {
        const json = await request(voice, chunk, key, ctx.signal);
        const part = join(work, `part-${i}.${outputFormat.split("_")[0] ?? "mp3"}`);
        await writeFile(part, Buffer.from(json.audio_base64, "base64"));
        parts.push(part);
        const alignment = json.alignment ?? json.normalized_alignment;
        if (alignment) words.push(...alignmentToWords(alignment, offset));
        offset += await probeDurationMs(tools, part, run);
      }
      if (parts.length === 0) throw new ElevenLabsError(`scene ${input.scene_id} has no text`);
      await concatToWav(tools, parts, outFile, run);
      const duration_ms = await probeDurationMs(tools, outFile, run);
      let prev = 0;
      for (const w of words) {
        w.start_ms = Math.min(Math.max(prev, w.start_ms), duration_ms);
        w.end_ms = Math.min(Math.max(w.start_ms, w.end_ms), duration_ms);
        prev = w.end_ms;
      }
      return {
        scene_id: input.scene_id,
        audio_path: outFile,
        duration_ms,
        words,
        timing_source: "provider",
        voice,
        provider: "elevenlabs",
      };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  };

  return {
    id: "elevenlabs",
    available,
    synthesize,
    resolveVoice,
    cacheOptions: () => ({
      modelId,
      outputFormat,
      seed: options.seed ?? null,
      dictionaries: options.pronunciationDictionaryLocators ?? null,
    }),
  };
}

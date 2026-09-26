import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, delimiter, join } from "node:path";
import { canonicalJson, hashFile, readJson, sha256Hex, writeJsonAtomic } from "@video-studio/core";
import { type TimedWord, whisperTranscribe } from "@video-studio/media";
import { type SceneVoiceTrack, type WordTiming, cueToken } from "@video-studio/schema";
import { resolveWhisperModel } from "./transcribe.js";

/**
 * Exact word timings for voices that only give estimates (macOS `say`, espeak-ng): local whisper
 * listens to each synthesized scene and its word times replace the estimates. We already know the
 * words, so this is alignment, not transcription: whisper's words are matched to the script, and
 * words it heard differently keep a position interpolated between matched neighbours. Only runs
 * when whisper.cpp and its model are installed (the model is never downloaded here).
 */

/** A track is re-timed only when at least this share of its words matched what whisper heard. */
export const ALIGN_MIN_MATCH = 0.5;
const ALIGN_VERSION = 1;

/** Matching key: the cue token (lower case, no surrounding punctuation), `%` spelled out. */
function key(w: string): string {
  return cueToken(w.replace(/%/g, " percent")).replace(/\s+/g, "");
}

function close(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4 || Math.abs(a.length - b.length) > 1) return false;
  // One edit apart (whisper's spelling of a name, a plural).
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Re-time `expected` (the script's words with estimated times, scene-local ms) from `heard`
 * (whisper's words, same clock). Longest-common-subsequence matching on normalised words; matched
 * words take whisper's times, the rest are placed between their matched neighbours in proportion to
 * their estimated positions. Output is monotonic and inside [0, durationMs].
 */
export function alignWords(expected: readonly WordTiming[], heard: readonly TimedWord[], durationMs: number): { words: WordTiming[]; matched: number } {
  const n = expected.length;
  const m = heard.length;
  if (!n) return { words: [], matched: 0 };
  const ek = expected.map((w) => key(w.word));
  const hk = heard.map((w) => key(w.word));
  // LCS table (scenes are short: a few hundred words at most).
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = ek[i] && close(ek[i]!, hk[j]!) ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const match = new Array<number>(n).fill(-1);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (ek[i] && close(ek[i]!, hk[j]!) && dp[i]![j] === dp[i + 1]![j + 1]! + 1) {
      match[i] = j;
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  const matched = match.filter((j) => j >= 0).length;

  const out: WordTiming[] = expected.map((w) => ({ ...w }));
  // Anchors: matched words, plus the scene's start and end.
  const anchors: Array<{ i: number; start: number; end: number }> = [];
  match.forEach((j, i) => {
    if (j >= 0) anchors.push({ i, start: heard[j]!.start_ms, end: Math.max(heard[j]!.start_ms, heard[j]!.end_ms) });
  });
  for (const a of anchors) {
    out[a.i]!.start_ms = Math.round(a.start);
    out[a.i]!.end_ms = Math.round(a.end);
  }
  // Unmatched runs: spread between the previous anchor's end and the next anchor's start, keeping
  // the estimates' relative spacing.
  let i = 0;
  while (i < n) {
    if (match[i]! >= 0) {
      i++;
      continue;
    }
    let k = i;
    while (k < n && match[k]! < 0) k++;
    const prev = anchors.filter((a) => a.i < i).pop();
    const next = anchors.find((a) => a.i >= k);
    const lo = prev ? prev.end : 0;
    const hi = next ? next.start : Math.max(lo, durationMs);
    const e0 = expected[i]!.start_ms;
    const e1 = expected[k - 1]!.end_ms;
    const span = Math.max(1, e1 - e0);
    for (let x = i; x < k; x++) {
      const s = lo + ((expected[x]!.start_ms - e0) / span) * (hi - lo);
      const e = lo + ((expected[x]!.end_ms - e0) / span) * (hi - lo);
      out[x]!.start_ms = Math.round(s);
      out[x]!.end_ms = Math.round(Math.max(s, e));
    }
    i = k;
  }
  // Monotonic, inside the scene.
  let t = 0;
  for (const w of out) {
    w.start_ms = Math.min(Math.max(w.start_ms, t), durationMs);
    w.end_ms = Math.min(Math.max(w.end_ms, w.start_ms), durationMs);
    t = w.start_ms;
  }
  return { words: out, matched };
}

/** whisper.cpp's binary: WHISPER_CPP_PATH, else whisper-cli / whisper-cpp on PATH. */
export function findWhisperBin(env: Record<string, string | undefined> = process.env): string | undefined {
  const override = env.WHISPER_CPP_PATH?.trim();
  if (override && existsSync(override)) return override;
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of ["whisper-cli", "whisper-cpp"]) if (existsSync(join(dir, name))) return join(dir, name);
  }
  return undefined;
}

export interface AlignTracksOptions {
  root: string;
  env?: Record<string, string | undefined>;
  /** Cache folder for alignments (keyed by audio hash, words and model). */
  cacheDir: string;
  signal?: AbortSignal;
  /** Test seam: the transcriber (default: whisper-cli). */
  transcribe?: (audioPath: string, model: string, bin: string) => Promise<TimedWord[]>;
  whisperBin?: string;
  model?: string;
}

export interface AlignTracksResult {
  tracks: SceneVoiceTrack[];
  /** Scenes re-timed from the audio. */
  aligned: string[];
  /** Why alignment did not run at all (no whisper, no model), when it didn't. */
  skipped?: string;
  warnings: string[];
}

/** Align every track whose timings are estimated and that has audio. Others pass through. */
export async function alignVoiceTracks(tracks: readonly SceneVoiceTrack[], o: AlignTracksOptions): Promise<AlignTracksResult> {
  const env = o.env ?? process.env;
  const todo = tracks.filter((t) => t.timing_source === "estimated" && t.audio_path && t.words.length);
  if (!todo.length) return { tracks: [...tracks], aligned: [], warnings: [] };
  const bin = o.whisperBin ?? findWhisperBin(env);
  const model = o.model ?? resolveWhisperModel(env);
  const modelPath = typeof model === "string" ? model : model.exists ? model.path : undefined;
  if (!bin || !modelPath) {
    return {
      tracks: [...tracks],
      aligned: [],
      skipped: !bin ? "whisper.cpp is not installed" : "the whisper model is not downloaded (transcribe with download_model: true, once)",
      warnings: [],
    };
  }
  const transcribe =
    o.transcribe ?? ((audio: string, m: string, b: string) => whisperTranscribe(audio, { model: m, bin: b, ...(o.signal ? { signal: o.signal } : {}) }));
  await mkdir(o.cacheDir, { recursive: true });
  const warnings: string[] = [];
  const aligned: string[] = [];
  const byId = new Map<string, SceneVoiceTrack>();
  for (const t of todo) {
    o.signal?.throwIfAborted();
    const audio = join(o.root, t.audio_path!);
    const cacheKey = sha256Hex(
      canonicalJson({ v: ALIGN_VERSION, audio: await hashFile(audio), words: t.words.map((w) => w.word), model: basename(modelPath), ms: t.duration_ms }),
    );
    const cacheFile = join(o.cacheDir, `${cacheKey}.json`);
    let heard: TimedWord[] | undefined;
    if (existsSync(cacheFile)) heard = await readJson<TimedWord[]>(cacheFile).catch(() => undefined);
    if (!heard) {
      try {
        heard = await transcribe(audio, modelPath, bin);
      } catch (err) {
        if (o.signal?.aborted) throw err;
        warnings.push(`align: ${t.scene_id}: whisper failed (${(err instanceof Error ? err.message : String(err)).slice(0, 200)}); kept estimated timings`);
        continue;
      }
      await writeJsonAtomic(cacheFile, heard);
    }
    const r = alignWords(t.words, heard, t.duration_ms);
    if (r.matched / t.words.length < ALIGN_MIN_MATCH) {
      warnings.push(`align: ${t.scene_id}: whisper matched only ${r.matched} of ${t.words.length} words; kept estimated timings`);
      continue;
    }
    byId.set(t.scene_id, { ...t, words: r.words, timing_source: "aligned" });
    aligned.push(t.scene_id);
  }
  return { tracks: tracks.map((t) => byId.get(t.scene_id) ?? t), aligned, warnings };
}

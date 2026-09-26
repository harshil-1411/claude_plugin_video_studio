import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { SceneVoiceTrack, type Brand, type VideoSpec } from "@video-studio/schema";
import {
  ContentStore,
  cacheKey,
  projectPaths,
  readJson,
  resolveDataDir,
  sha256Hex,
  writeJsonAtomic,
} from "@video-studio/core";
import { createElevenLabsBackend } from "./elevenlabs.js";
import { createSilentBackend, silentTrack } from "./silent.js";
import { createSystemBackend } from "./system.js";
import { mapTimingsToCaptions, prepareSpeechText } from "./text.js";
import type { Env, VoiceBackend } from "./types.js";

/** Bump to invalidate cached voice tracks (e.g. after changing estimation or text preparation). */
export const VOICE_CACHE_VERSION = "1";

export type BackendChoice = "auto" | "system" | "elevenlabs" | "silent";

export interface BackendSelection {
  backend: VoiceBackend;
  /** Why this backend was chosen, including why better ones were skipped. */
  reason: string;
}

export class VoiceBackendUnavailableError extends Error {
  constructor(
    readonly backendId: string,
    reason: string,
  ) {
    super(`voice backend "${backendId}" is unavailable: ${reason}`);
    this.name = "VoiceBackendUnavailableError";
  }
}

export interface BackendSet {
  system: VoiceBackend;
  elevenlabs: VoiceBackend;
  silent: VoiceBackend;
}

export function defaultBackends(): BackendSet {
  return { system: createSystemBackend(), elevenlabs: createElevenLabsBackend(), silent: createSilentBackend() };
}

/** Backend ids that cost money when a backend does not say (`VoiceBackend.paid`). */
export const PAID_BACKEND_IDS: ReadonlySet<string> = new Set(["elevenlabs"]);

export function isPaidBackend(b: Pick<VoiceBackend, "id" | "paid">): boolean {
  return b.paid ?? PAID_BACKEND_IDS.has(b.id);
}

/**
 * Decides whether a paid backend may be used. Returns null to allow it, or the reason it is not
 * allowed (shown in `voice.reason`). `explicit` is true when the caller named the backend itself.
 */
export type PaidBackendGate = (backendId: string, explicit: boolean) => string | null;

export interface SelectBackendOptions {
  /** Gate for paid backends (policy). Without one, paid backends are selectable as before. */
  paidGate?: PaidBackendGate;
}

/**
 * auto: elevenlabs if its key is set (and, for a paid backend, the paid gate allows it), else
 * system TTS if available, else silent. An explicit choice that is unavailable, or a paid one the
 * gate refuses, throws VoiceBackendUnavailableError.
 */
export async function selectBackend(
  choice: BackendChoice,
  env: Env,
  backends: BackendSet = defaultBackends(),
  opts: SelectBackendOptions = {},
): Promise<BackendSelection> {
  if (choice !== "auto") {
    const backend = backends[choice];
    const a = await backend.available(env);
    if (!a.ok) throw new VoiceBackendUnavailableError(choice, a.reason ?? "unavailable");
    if (isPaidBackend(backend) && opts.paidGate) {
      const refused = opts.paidGate(backend.id, true);
      if (refused) throw new VoiceBackendUnavailableError(choice, refused);
    }
    return { backend, reason: `requested "${choice}"${a.reason ? ` (${a.reason})` : ""}` };
  }
  const skipped: string[] = [];
  for (const id of ["elevenlabs", "system"] as const) {
    const a = await backends[id].available(env);
    if (a.ok) {
      const refused = isPaidBackend(backends[id]) && opts.paidGate ? opts.paidGate(backends[id].id, false) : null;
      if (refused) {
        skipped.push(refused);
        continue;
      }
      const prefix = skipped.length ? `${skipped.join("; ")}; ` : "";
      return { backend: backends[id], reason: `auto: ${prefix}using ${id} (${a.reason ?? "available"})` };
    }
    skipped.push(`${id} unavailable: ${a.reason ?? "unknown"}`);
  }
  return { backend: backends.silent, reason: `auto: ${skipped.join("; ")}; falling back to silent (no audio)` };
}

export interface SynthesizeSpecOptions {
  projectDir: string;
  backend?: BackendChoice;
  brand?: Pick<Brand, "language"> | null;
  env?: Env;
  /** Voice cache root (default `<data dir>/cache/voice`). */
  cacheDir?: string;
  signal?: AbortSignal;
  /** Override backend implementations (tests, custom rate/options). */
  backends?: Partial<BackendSet>;
}

export interface VoiceOverrun {
  scene_id: string;
  scene_duration_sec: number;
  audio_duration_sec: number;
  /** Audio duration + 0.3 s, rounded up to 0.1 s. */
  suggested_duration_sec: number;
}

export interface SynthesizeSpecResult {
  backend: string;
  reason: string;
  tracks: SceneVoiceTrack[];
  /** Project-relative path of voice-tracks.json. */
  tracks_path: string;
  overruns: VoiceOverrun[];
  /** Scene ids served from cache (no synthesis). */
  cache_hits: string[];
}

interface CacheEntry {
  version: string;
  audio_sha256?: string;
  track: SceneVoiceTrack;
}

const toPosix = (p: string) => p.split(sep).join("/");

/** Cache key of one scene's synthesized narration (shared by synthesizeSpec and planSynthesis). */
function voiceCacheKey(spec: VideoSpec, voiceover: string, speech: string, backend: VoiceBackend, voice: string | undefined): string {
  return cacheKey({
    kind: "voice",
    inputDigest: sha256Hex(`${speech}\u0000${voiceover}`),
    extractorVersion: VOICE_CACHE_VERSION,
    options: {
      backend: backend.id,
      voice: voice ?? null,
      text: speech,
      ...(spec.voice.rate_wpm ? { rate_wpm: spec.voice.rate_wpm } : {}),
      ...(backend.cacheOptions?.() ?? {}),
    },
    irSchemaVersion: 1,
  });
}

export interface SynthesisPlanScene {
  scene_id: string;
  /** Characters sent to the backend (speech text after pronunciation replacements). */
  chars: number;
  /** Already in the voice cache: no synthesis, no cost. */
  cached: boolean;
  cache_key: string;
}

export interface SynthesisPlan {
  backend: string;
  paid: boolean;
  scenes: SynthesisPlanScene[];
  chars_total: number;
  /** Characters that would actually be synthesized (cache misses). */
  chars_uncached: number;
  /** USD per 1k characters, or null when the backend has no price estimate. */
  usd_per_1k_chars: number | null;
  /** Estimated cost of the cache misses, or null when unknown. */
  estimated_usd: number | null;
  /** Stable digest of the uncached scenes' cache keys (identifies this exact synthesis). */
  uncached_digest: string;
}

/**
 * What synthesizeSpec would do with `backend`, without synthesizing: characters per scene, which
 * scenes are cache hits, and the estimated cost of the rest. Used for spend limits and consent.
 */
export async function planSynthesis(
  spec: VideoSpec,
  options: { backend: VoiceBackend; env?: Env; brand?: Pick<Brand, "language"> | null; cacheDir?: string },
): Promise<SynthesisPlan> {
  const env = options.env ?? process.env;
  const backend = options.backend;
  const cacheRoot = options.cacheDir ?? join(resolveDataDir(env).cache, "voice");
  const store = new ContentStore(join(cacheRoot, "cas"));
  const scenes: SynthesisPlanScene[] = [];
  for (const scene of spec.scenes) {
    const prepared = prepareSpeechText(scene.voiceover, options.brand);
    if (prepared.captionWords.length === 0) continue;
    const voice = await backend.resolveVoice?.(spec.voice.voice_id, env, spec.language);
    const key = voiceCacheKey(spec, scene.voiceover, prepared.speech, backend, voice);
    const cached = await readJson<CacheEntry>(join(cacheRoot, "index", `${key}.json`)).catch(() => undefined);
    const hit = cached?.version === VOICE_CACHE_VERSION && !!cached.audio_sha256 && (await store.has(cached.audio_sha256));
    scenes.push({ scene_id: scene.id, chars: prepared.speech.length, cached: hit, cache_key: key });
  }
  const chars_total = scenes.reduce((n, s) => n + s.chars, 0);
  const chars_uncached = scenes.filter((s) => !s.cached).reduce((n, s) => n + s.chars, 0);
  const rate = backend.usdPer1kChars?.() ?? null;
  return {
    backend: backend.id,
    paid: isPaidBackend(backend),
    scenes,
    chars_total,
    chars_uncached,
    usd_per_1k_chars: rate,
    estimated_usd: rate === null ? null : Math.round((chars_uncached / 1000) * rate * 10_000) / 10_000,
    uncached_digest: sha256Hex(scenes.filter((s) => !s.cached).map((s) => s.cache_key).join("\n")),
  };
}

function detectOverrun(scene: VideoSpec["scenes"][number], track: SceneVoiceTrack): VoiceOverrun | undefined {
  if (!track.audio_path || track.duration_ms <= Math.round(scene.duration_sec * 1000)) return undefined;
  const audio = track.duration_ms / 1000;
  return {
    scene_id: scene.id,
    scene_duration_sec: scene.duration_sec,
    audio_duration_sec: audio,
    suggested_duration_sec: Math.ceil(Math.round((audio + 0.3) * 1000) / 100) / 10,
  };
}

/**
 * Synthesize voice for every scene of a spec into `<project>/assets/voice/<scene_id>.wav` and write
 * `assets/voice/voice-tracks.json`. Results are cached by content (backend, voice, text, options)
 * in a ContentStore, so re-runs are free. The spec is never modified: scenes whose audio is longer
 * than `duration_sec` are reported in `overruns` for the caller to act on.
 */
export async function synthesizeSpec(spec: VideoSpec, options: SynthesizeSpecOptions): Promise<SynthesizeSpecResult> {
  const env = options.env ?? process.env;
  const backends: BackendSet = { ...defaultBackends(), ...options.backends };
  const { backend, reason } = await selectBackend(options.backend ?? "auto", env, backends);
  const paths = projectPaths(options.projectDir);
  const voiceDir = paths.assetsVoice;
  const cacheRoot = options.cacheDir ?? join(resolveDataDir(env).cache, "voice");
  const store = new ContentStore(join(cacheRoot, "cas"));
  const indexDir = join(cacheRoot, "index");

  const tracks: SceneVoiceTrack[] = [];
  const overruns: VoiceOverrun[] = [];
  const cacheHits: string[] = [];
  const work = await mkdtemp(join(tmpdir(), "vs-voice-spec-"));
  try {
    for (const scene of spec.scenes) {
      options.signal?.throwIfAborted();
      const durationMs = Math.round(scene.duration_sec * 1000);
      const prepared = prepareSpeechText(scene.voiceover, options.brand);
      if (prepared.captionWords.length === 0) {
        tracks.push(silentTrack({ scene_id: scene.id, text: "", duration_ms: durationMs }));
        continue;
      }
      if (backend.id === "silent") {
        const t = await backend.synthesize(
          { scene_id: scene.id, text: prepared.speech, duration_ms: durationMs },
          { outDir: work, env, ...(options.signal ? { signal: options.signal } : {}) },
        );
        tracks.push({ ...t, words: mapTimingsToCaptions(prepared, t.words) });
        continue;
      }

      const voice = await backend.resolveVoice?.(spec.voice.voice_id, env, spec.language);
      const key = voiceCacheKey(spec, scene.voiceover, prepared.speech, backend, voice);
      const indexFile = join(indexDir, `${key}.json`);
      const dest = join(voiceDir, `${scene.id}.wav`);
      const relAudio = toPosix(relative(paths.root, dest));

      const cached = await readJson<CacheEntry>(indexFile).catch(() => undefined);
      if (cached?.version === VOICE_CACHE_VERSION && cached.audio_sha256 && (await store.has(cached.audio_sha256))) {
        await store.materialize(cached.audio_sha256, dest);
        const track = SceneVoiceTrack.parse({ ...cached.track, scene_id: scene.id, audio_path: relAudio });
        tracks.push(track);
        cacheHits.push(scene.id);
        const o = detectOverrun(scene, track);
        if (o) overruns.push(o);
        continue;
      }

      const raw = await backend.synthesize(
        { scene_id: scene.id, text: prepared.speech, ...(voice ? { voice } : {}), duration_ms: durationMs, language: spec.language, ...(spec.voice.rate_wpm ? { rate_wpm: spec.voice.rate_wpm } : {}) },
        { outDir: work, env, ...(options.signal ? { signal: options.signal } : {}) },
      );
      const words = mapTimingsToCaptions(prepared, raw.words);
      let track: SceneVoiceTrack;
      let audioSha: string | undefined;
      if (raw.audio_path) {
        const entry = await store.put(raw.audio_path);
        audioSha = entry.sha256;
        await store.materialize(entry.sha256, dest);
        await rm(raw.audio_path, { force: true });
        track = SceneVoiceTrack.parse({ ...raw, words, audio_path: relAudio });
      } else {
        const { audio_path: _drop, ...rest } = raw;
        track = SceneVoiceTrack.parse({ ...rest, words });
      }
      if (audioSha) await writeJsonAtomic(indexFile, { version: VOICE_CACHE_VERSION, audio_sha256: audioSha, track } satisfies CacheEntry);
      tracks.push(track);
      const o = detectOverrun(scene, track);
      if (o) overruns.push(o);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  const tracksFile = join(voiceDir, "voice-tracks.json");
  await writeJsonAtomic(tracksFile, tracks);
  return {
    backend: backend.id,
    reason,
    tracks,
    tracks_path: toPosix(relative(paths.root, tracksFile)),
    overruns,
    cache_hits: cacheHits,
  };
}

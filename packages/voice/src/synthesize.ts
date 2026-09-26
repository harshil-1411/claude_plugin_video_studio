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

/**
 * auto: elevenlabs if its key is set, else system TTS if available, else silent.
 * An explicit choice that is unavailable throws VoiceBackendUnavailableError.
 */
export async function selectBackend(
  choice: BackendChoice,
  env: Env,
  backends: BackendSet = defaultBackends(),
): Promise<BackendSelection> {
  if (choice !== "auto") {
    const backend = backends[choice];
    const a = await backend.available(env);
    if (!a.ok) throw new VoiceBackendUnavailableError(choice, a.reason ?? "unavailable");
    return { backend, reason: `requested "${choice}"${a.reason ? ` (${a.reason})` : ""}` };
  }
  const skipped: string[] = [];
  for (const id of ["elevenlabs", "system"] as const) {
    const a = await backends[id].available(env);
    if (a.ok) {
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
      const key = cacheKey({
        kind: "voice",
        inputDigest: sha256Hex(`${prepared.speech}\u0000${scene.voiceover}`),
        extractorVersion: VOICE_CACHE_VERSION,
        options: {
          backend: backend.id,
          voice: voice ?? null,
          text: prepared.speech,
          ...(spec.voice.rate_wpm ? { rate_wpm: spec.voice.rate_wpm } : {}),
          ...(backend.cacheOptions?.() ?? {}),
        },
        irSchemaVersion: 1,
      });
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

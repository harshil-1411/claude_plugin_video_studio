import type { SceneVoiceTrack } from "@video-studio/schema";

export type Env = Record<string, string | undefined>;

export interface Availability {
  ok: boolean;
  /** Why the backend is (un)available; human-readable, never contains secrets. */
  reason?: string;
}

/** One scene's narration as handed to a backend. `text` is the speech text (after pronunciation replacements). */
export interface SynthesisInput {
  scene_id: string;
  text: string;
  /** Requested voice id/name (e.g. spec.voice.voice_id); backends fall back to their default. */
  voice?: string;
  /** Scene duration; used by the silent backend to time words. */
  duration_ms?: number;
  /** Spec language (BCP-47): backends pick a voice that speaks it, or fail rather than read it with another language's voice. */
  language?: string;
}

export interface SynthesisContext {
  /** Directory the backend writes `<scene_id>.wav` (48 kHz mono PCM) into. */
  outDir: string;
  signal?: AbortSignal;
  env: Env;
}

/**
 * A text-to-speech backend.
 *
 * `synthesize` returns a SceneVoiceTrack whose `audio_path` is the ABSOLUTE path of the WAV it wrote
 * under `ctx.outDir` (or undefined when it produced no audio). The caller (`synthesizeSpec`) moves the
 * audio into the project and rewrites `audio_path` to a project-relative path. Word timings are
 * relative to the start of the returned audio and refer to the tokens of `input.text`.
 */
export interface VoiceBackend {
  /** Selection id: "system" | "elevenlabs" | "silent". */
  readonly id: string;
  available(env: Env): Promise<Availability> | Availability;
  synthesize(input: SynthesisInput, ctx: SynthesisContext): Promise<SceneVoiceTrack>;
  /** Resolve the voice that will actually be used (for cache keys). Optional. */
  resolveVoice?(requested: string | undefined, env: Env, language?: string): Promise<string | undefined>;
  /** Options that change the output, folded into the cache key (rate, model, ...). */
  cacheOptions?(): Record<string, unknown>;
}

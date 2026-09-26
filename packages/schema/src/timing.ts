import { z } from "zod";
import { FilePath, Id, NonEmptyString } from "./common.js";

/**
 * Word-level timing is the single source of truth for captions: HTML karaoke
 * captions, ASS burn-in and SRT/VTT sidecars are all derived from it.
 * Times are integer milliseconds relative to the start of the track they belong to.
 */
export const WordTiming = z.strictObject({
  word: NonEmptyString,
  start_ms: z.int().nonnegative(),
  end_ms: z.int().nonnegative(),
  speaker: z.string().min(1).max(64).optional().describe("Speaker label (S1, S2, …) from speaker-turn detection; captions break when it changes."),
});

/**
 * How word timings were obtained, best first:
 * - `provider`: returned by the TTS provider (e.g. ElevenLabs alignment).
 * - `aligned`: forced alignment / ASR against the audio.
 * - `estimated`: distributed across the measured audio duration (e.g. macOS `say`).
 * - `none`: no voice audio (silent mode); words are timed to the scene.
 */
export const TimingSource = z.enum(["provider", "aligned", "estimated", "none"]);

/** Voice output for one scene. */
export const SceneVoiceTrack = z.strictObject({
  scene_id: Id,
  /** Project-relative path to the audio file; absent in silent mode. */
  audio_path: FilePath.optional(),
  duration_ms: z.int().nonnegative(),
  words: z.array(WordTiming),
  timing_source: TimingSource,
  voice: z.string().optional().describe("Provider-specific voice id/name used."),
  provider: z.string().describe("Voice backend id, e.g. system-say, elevenlabs, silent."),
});

export type WordTiming = z.infer<typeof WordTiming>;
export type TimingSource = z.infer<typeof TimingSource>;
export type SceneVoiceTrack = z.infer<typeof SceneVoiceTrack>;

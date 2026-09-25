import type { SceneVoiceTrack } from "@video-studio/schema";
import { estimateWordTimings, tokenize } from "./estimate.js";
import type { SynthesisInput, VoiceBackend } from "./types.js";

/** Silent track: no audio, words timed evenly across the scene duration. */
export function silentTrack(input: SynthesisInput): SceneVoiceTrack {
  const duration_ms = Math.max(0, Math.round(input.duration_ms ?? 0));
  return {
    scene_id: input.scene_id,
    duration_ms,
    words: estimateWordTimings(tokenize(input.text), duration_ms, { even: true }),
    timing_source: "none",
    provider: "silent",
  };
}

export function createSilentBackend(): VoiceBackend {
  return {
    id: "silent",
    available: () => ({ ok: true, reason: "always available (no audio)" }),
    synthesize: async (input) => silentTrack(input),
  };
}

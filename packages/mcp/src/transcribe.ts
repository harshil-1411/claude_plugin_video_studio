/**
 * transcribe: local ASR (whisper.cpp) for a project's video/audio asset, or import of a user
 * SRT/VTT, written as a timed-word transcript and recorded on the asset's `media.transcript`.
 * The whisper model is never downloaded without explicit consent (`download_model: true`).
 *
 * STUB (coordinator): the footage agent implements it.
 */

export interface TranscribeOptions {
  /** Import this caption file instead of running ASR (project-relative .srt or .vtt). */
  captions_file?: string;
  /** Explicit consent to download the whisper model (~150 MB) into the plugin data dir. */
  download_model?: boolean;
  env?: Record<string, string | undefined>;
}

export interface TranscribeResult {
  asset: string;
  source: "whisper" | "srt" | "vtt";
  words: number;
  path: string;
  text: string;
}

export async function transcribeAsset(_projectDir: string, _asset: string, _opts: TranscribeOptions = {}): Promise<TranscribeResult> {
  throw new Error("not implemented: transcribeAsset");
}

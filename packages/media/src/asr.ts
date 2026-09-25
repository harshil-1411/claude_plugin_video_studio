/**
 * Local speech recognition with whisper.cpp (`whisper-cli`) and caption-file import, producing
 * timed words. STUB (coordinator): the footage-ingest agent implements it.
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
}

export async function whisperTranscribe(_mediaPath: string, _opts: AsrOptions): Promise<TimedWord[]> {
  throw new Error("not implemented: whisperTranscribe");
}

/** Parse an SRT or VTT file into timed words (cue time spread evenly over its words). */
export function parseCaptionFile(_text: string): TimedWord[] {
  throw new Error("not implemented: parseCaptionFile");
}

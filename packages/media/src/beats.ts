/**
 * Beat and onset detection for music beds (energy envelope from ffmpeg PCM; no model), and
 * snapping scene cuts to beats. STUB (coordinator): the footage-render agent implements it.
 */

export interface BeatAnalysis {
  bpm: number | null;
  /** Beat times in ms from the start of the file. */
  beats_ms: number[];
  onsets_ms: number[];
}

export async function detectBeats(_audioPath: string, _opts: { signal?: AbortSignal } = {}): Promise<BeatAnalysis> {
  throw new Error("not implemented: detectBeats");
}

/** Move each cut to the nearest beat within `toleranceMs`, keeping order and a minimum scene length. */
export function snapCuts(_cutsMs: readonly number[], _beatsMs: readonly number[], _toleranceMs: number, _minSceneMs = 500): number[] {
  throw new Error("not implemented: snapCuts");
}

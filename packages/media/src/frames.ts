import type { RunOptions } from "./ffmpeg.js";

/**
 * Frame sampling and perceptual comparison for golden-frame tests and render diffs. ffmpeg only
 * (ssim filter), no image libraries.
 *
 * STUB (coordinator): the golden/diff agent implements it.
 */

/** Write the frame at `atSec` of `video` to `out` (PNG), scaled to `width` px wide (keeps aspect) when given. */
export async function extractFrame(_video: string, _atSec: number, _out: string, _opts: { width?: number } & Pick<RunOptions, "tools"> = {}): Promise<void> {
  throw new Error("not implemented: extractFrame");
}

/** SSIM (0–1, 1 = identical) of two same-size images. */
export async function frameSsim(_a: string, _b: string, _opts: Pick<RunOptions, "tools"> = {}): Promise<number> {
  throw new Error("not implemented: frameSsim");
}

/**
 * Motion blur (Phase 6.5 item 8), building block only: NOT wired into the render path (the spec
 * has no motion-blur field yet).
 *
 * Spike finding: the pinned producer 0.8.78 captures sub-frames itself. `RenderConfigInput`
 * takes `motionBlur?: { samplesPerFrame?, shutterAngle?, shutterPhase?, blend? }` (engine
 * `MotionBlurOptions`): per output frame it seeks `samplesPerFrame` times on a 4096-division
 * sub-frame grid inside the shutter window and averages the PNG samples (`MotionBlurAccumulator`,
 * sRGB by default). It needs screenshot capture (forced PNG), refuses the layered HDR/shader
 * transition route and injected video frames, and without an explicit count it picks 16–64
 * samples adaptively. So we only need the options and the cost; no ffmpeg `tmix` pass.
 */

/** Our sub-frame range: enough to smear fast moves, cheap enough for short reels. */
export const MOTION_BLUR_MIN_SUBFRAMES = 3;
export const MOTION_BLUR_MAX_SUBFRAMES = 6;
/** Shutter window in degrees of one frame (180°: film's half-frame exposure, the producer's default). */
export const MOTION_BLUR_SHUTTER_ANGLE = 180;

/** The producer's `MotionBlurOptions` subset we would pass. */
export interface ProducerMotionBlur {
  samplesPerFrame: number;
  shutterAngle: number;
  /** -angle/2 centres the window on the frame instant. */
  shutterPhase: number;
  blend: "srgb";
}

function clampSubframes(n: number): number {
  return Math.min(MOTION_BLUR_MAX_SUBFRAMES, Math.max(MOTION_BLUR_MIN_SUBFRAMES, Math.round(Number.isFinite(n) ? n : MOTION_BLUR_MIN_SUBFRAMES)));
}

/** Options for the producer's native sub-frame blur: a fixed count (never adaptive, so the cost is known), centred window. */
export function motionBlurOptions(subframes: number, shutterAngle = MOTION_BLUR_SHUTTER_ANGLE): ProducerMotionBlur {
  return { samplesPerFrame: clampSubframes(subframes), shutterAngle, shutterPhase: -shutterAngle / 2, blend: "srgb" };
}

/**
 * Centred sub-frame offsets, in frames relative to the frame instant: sample k of n sits at
 * (k + 0.5) / n of the shutter window, which spans ±angle/720 frames. Mirrors the producer's
 * `sampleTickOffsets` before its 1/4096 quantization.
 */
export function subframeOffsets(subframes: number, shutterAngle = MOTION_BLUR_SHUTTER_ANGLE): number[] {
  const n = clampSubframes(subframes);
  const shutter = shutterAngle / 360;
  return Array.from({ length: n }, (_, k) => Math.round((-shutter / 2 + ((k + 0.5) / n) * shutter) * 1e9) / 1e9);
}

/** Scene-local seek times of output frame `frame` at `fps`, clamped at 0 (the producer clamps the same way). */
export function subframeTimes(frame: number, fps: number, subframes: number, shutterAngle = MOTION_BLUR_SHUTTER_ANGLE): number[] {
  return subframeOffsets(subframes, shutterAngle).map((o) => Math.max(0, Math.round(((frame + o) / fps) * 1e9) / 1e9));
}

/** Browser renders a blurred scene costs: seconds × fps × subframes (plain: seconds × fps). */
export function motionBlurCost(durationSec: number, fps: number, subframes: number): { frames: number; captures: number; factor: number } {
  const frames = Math.max(1, Math.round(durationSec * fps));
  const n = clampSubframes(subframes);
  return { frames, captures: frames * n, factor: n };
}

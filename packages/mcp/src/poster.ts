import { rename, rm } from "node:fs/promises";
import { FASTSTART, type EncodeSettings, type RunOptions, ffprobe, h264Args, runFfmpeg } from "@video-studio/media";

/**
 * Poster on frame 0 (spec `cover.bake_first_frame`): chat apps and players that thumbnail a
 * video's first frame (Slack, X, Discord) show the composed cover. Only frame 0 changes: the
 * cover image is scaled to the video, overlaid on the first frame alone, and the picture is
 * re-encoded with the pipeline's own H.264 settings; the audio is copied, so the frame count,
 * duration and sound are unchanged. The clean master is never baked.
 */

/** Bump when baked reels change (part of the poster cache key). */
export const POSTER_VERSION = 1;

/** Frames QA leaves out of its spike and scene-change stats when a poster was baked (the poster, and the cut back to the reel). */
export const POSTER_SKIP_FRAMES = 2;

export interface BakePosterOptions extends Pick<RunOptions, "signal" | "tools"> {
  /** The unbaked reel. */
  reel: string;
  /** The composed cover (thumbnail.png at the master's size); scaled to the reel when sizes differ. */
  image: string;
  /** Output path, written atomically (a temp file renamed into place); must not be `reel`. */
  out: string;
  /** x264 settings of the render (preset), the same as the assembly's. */
  encode?: EncodeSettings;
}

/** ffmpeg arguments that overlay `image` on frame 0 of `reel` (W×H) and write `out`. */
export function posterArgs(reel: string, image: string, out: string, width: number, height: number, encode?: EncodeSettings): string[] {
  const graph = `[1:v]scale=${width}:${height},setsar=1,format=yuv420p[p];[0:v][p]overlay=0:0:enable='eq(n,0)'[v]`;
  return ["-y", "-i", reel, "-i", image, "-filter_complex", graph, "-map", "[v]", "-map", "0:a?", ...h264Args(encode), "-c:a", "copy", ...FASTSTART, out];
}

/** Bake the cover into frame 0 of the reel. */
export async function bakePoster(o: BakePosterOptions): Promise<{ width: number; height: number }> {
  if (o.out === o.reel) throw new Error("poster: the output must not overwrite the input reel");
  const run = { ...(o.signal ? { signal: o.signal } : {}), ...(o.tools ? { tools: o.tools } : {}) };
  const probe = await ffprobe(o.reel, run);
  if (!probe.width || !probe.height) throw new Error(`poster: ${o.reel} has no video stream`);
  const tmp = `${o.out}.tmp-${process.pid}.mp4`;
  try {
    await runFfmpeg(posterArgs(o.reel, o.image, tmp, probe.width, probe.height, o.encode), run);
    await rename(tmp, o.out);
  } finally {
    await rm(tmp, { force: true });
  }
  return { width: probe.width, height: probe.height };
}

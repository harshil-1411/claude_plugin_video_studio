import { open, stat } from "node:fs/promises";
import { type RunOptions, runFfmpeg } from "./ffmpeg.js";

/**
 * Frame sampling and perceptual comparison for golden-frame tests and render diffs. ffmpeg only
 * (ssim filter), no image libraries.
 */

/** Write the frame at `atSec` of `video` to `out` (PNG), scaled to `width` px wide (keeps aspect) when given. */
export async function extractFrame(video: string, atSec: number, out: string, opts: { width?: number } & Pick<RunOptions, "tools"> = {}): Promise<void> {
  if (!Number.isFinite(atSec) || atSec < 0) throw new Error(`extractFrame: invalid time ${atSec}`);
  // Output-side seek (-ss after -i) decodes up to the exact frame: slower but deterministic.
  const vf = opts.width ? ["-vf", `scale=${Math.round(opts.width)}:-2:flags=bicubic`] : [];
  await runFfmpeg(["-y", "-i", video, "-ss", atSec.toFixed(3), "-frames:v", "1", ...vf, "-pix_fmt", "rgb24", "-f", "image2", "-c:v", "png", out], {
    ...(opts.tools ? { tools: opts.tools } : {}),
    timeoutMs: 120_000,
  });
  const s = await stat(out).catch(() => undefined);
  if (!s || s.size === 0) throw new Error(`no frame at ${atSec.toFixed(3)}s in ${video} (past the end?)`);
}

/** SSIM (0–1, 1 = identical) of two same-size images. */
export async function frameSsim(a: string, b: string, opts: Pick<RunOptions, "tools"> = {}): Promise<number> {
  const [sa, sb] = await Promise.all([pngSize(a), pngSize(b)]);
  if (sa && sb && (sa.width !== sb.width || sa.height !== sb.height)) {
    throw new Error(`frameSsim: size mismatch ${sa.width}x${sa.height} vs ${sb.width}x${sb.height}`);
  }
  const { stderr } = await runFfmpeg(["-i", a, "-i", b, "-lavfi", "[0:v][1:v]ssim", "-f", "null", "-"], {
    ...(opts.tools ? { tools: opts.tools } : {}),
    timeoutMs: 60_000,
  });
  return parseSsim(stderr);
}

/** The `All:` value of ffmpeg's ssim filter summary line. */
export function parseSsim(stderr: string): number {
  const m = /SSIM [^\n]*All:\s*([0-9.]+|inf)/.exec(stderr);
  if (!m) throw new Error(`could not read SSIM from ffmpeg output:\n${stderr.slice(-400)}`);
  const v = m[1] === "inf" ? 1 : Number(m[1]);
  if (!Number.isFinite(v)) throw new Error(`bad SSIM value ${m[1]}`);
  return Math.min(1, Math.max(0, v));
}

/**
 * Write a side-by-side comparison PNG to `out`: `a` | `b` | their absolute difference (brightened),
 * for a human to look at. The two images must be the same size.
 */
export async function frameDiffImage(a: string, b: string, out: string, opts: Pick<RunOptions, "tools"> = {}): Promise<void> {
  const graph = "[0:v]format=rgb24,split[a1][a2];[1:v]format=rgb24,split[b1][b2];[a2][b2]blend=all_mode=difference,lutrgb=r='min(val*4,255)':g='min(val*4,255)':b='min(val*4,255)'[d];[a1][b1][d]hstack=inputs=3";
  await runFfmpeg(["-y", "-i", a, "-i", b, "-filter_complex", graph, "-frames:v", "1", "-c:v", "png", out], {
    ...(opts.tools ? { tools: opts.tools } : {}),
    timeoutMs: 60_000,
  });
}

/** Width and height from a PNG's IHDR chunk; undefined when the file is not a PNG. */
export async function pngSize(path: string): Promise<{ width: number; height: number } | undefined> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(24);
    const { bytesRead } = await fh.read(buf, 0, 24, 0);
    if (bytesRead < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString("ascii", 12, 16) !== "IHDR") return undefined;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } finally {
    await fh.close();
  }
}

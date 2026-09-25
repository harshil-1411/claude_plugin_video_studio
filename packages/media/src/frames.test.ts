import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFfmpeg } from "./ffmpeg.js";
import { extractFrame, frameDiffImage, frameSsim, parseSsim, pngSize } from "./frames.js";

// Tiny lavfi clips only: 160x90, 1 s, 15 fps.
const T = 60_000;
let tmp: string;
let clipA: string;
let clipB: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-frames-"));
  clipA = join(tmp, "a.mp4");
  clipB = join(tmp, "b.mp4");
  const enc = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
  await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=15:duration=1", ...enc, clipA]);
  await runFfmpeg(["-y", "-f", "lavfi", "-i", "mandelbrot=size=160x90:rate=15", "-t", "1", ...enc, clipB]);
}, T);
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("frames", () => {
  it(
    "extracts a scaled PNG frame",
    async () => {
      const out = join(tmp, "f1.png");
      await extractFrame(clipA, 0.5, out, { width: 80 });
      expect(await pngSize(out)).toEqual({ width: 80, height: 46 });
      const full = join(tmp, "f1-full.png");
      await extractFrame(clipA, 0.5, full);
      expect(await pngSize(full)).toEqual({ width: 160, height: 90 });
    },
    T,
  );

  it(
    "fails past the end of the clip",
    async () => {
      await expect(extractFrame(clipA, 5, join(tmp, "none.png"))).rejects.toThrow();
    },
    T,
  );

  it(
    "SSIM is ~1 for the same frame and lower for a different one; diff image is 3 frames wide",
    async () => {
      const a1 = join(tmp, "a1.png");
      const a2 = join(tmp, "a2.png");
      const b1 = join(tmp, "b1.png");
      await extractFrame(clipA, 0.4, a1, { width: 80 });
      await extractFrame(clipA, 0.4, a2, { width: 80 });
      await extractFrame(clipB, 0.4, b1, { width: 80 });
      expect(await frameSsim(a1, a2)).toBeGreaterThan(0.999);
      expect(await frameSsim(a1, b1)).toBeLessThan(0.8);
      const diff = join(tmp, "diff.png");
      await frameDiffImage(a1, b1, diff);
      expect(await pngSize(diff)).toEqual({ width: 240, height: 46 });
      const other = join(tmp, "other.png");
      await extractFrame(clipA, 0.4, other, { width: 40 });
      await expect(frameSsim(a1, other)).rejects.toThrow(/size mismatch/);
    },
    T,
  );

  it("parses the ssim summary line", () => {
    expect(parseSsim("[Parsed_ssim_0 @ 0x1] SSIM Y:0.99 (20.0) U:0.98 (17.0) V:0.97 (15.2) All:0.985123 (18.3)\n")).toBeCloseTo(0.985123, 6);
    expect(parseSsim("SSIM R:1 G:1 B:1 All:1.000000 (inf)")).toBe(1);
    expect(() => parseSsim("nothing")).toThrow(/could not read SSIM/);
  });
});

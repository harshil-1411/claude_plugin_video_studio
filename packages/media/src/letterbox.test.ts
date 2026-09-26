import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFfmpeg } from "./ffmpeg.js";
import { decideLetterbox, detectLetterbox, parseCropdetect } from "./letterbox.js";

describe("letterbox decision (pure)", () => {
  const W = 1920;
  const H = 1080;
  const bars = { x: 0, y: 140, w: 1920, h: 800 };

  it("parses the last cropdetect line", () => {
    expect(parseCropdetect("x crop=10:20:30:40 y crop=1920:800:0:140\n")).toEqual(bars);
    expect(parseCropdetect("nothing")).toBeNull();
  });

  it("accepts symmetric bars every sample agrees on", () => {
    expect(decideLetterbox([bars, bars, { ...bars, y: 142, h: 796 }, bars, bars], W, H)).toEqual(bars);
    expect(decideLetterbox([{ x: 240, y: 0, w: 1440, h: 1080 }], W, H)).toEqual({ x: 240, y: 0, w: 1440, h: 1080 });
  });

  it("rejects dark scenes: asymmetric borders (a window seen from a dark room)", () => {
    // What the real wave.mp4 gives: top 86, bottom 282.
    expect(decideLetterbox([{ x: 132, y: 86, w: 1732, h: 712 }], W, H)).toBeNull();
  });

  it("rejects borders that change over the clip (a night sky, moving darkness)", () => {
    expect(decideLetterbox([bars, { x: 0, y: 60, w: 1920, h: 960 }, bars], W, H)).toBeNull();
  });

  it("rejects no-op and absurd boxes, and missing samples", () => {
    expect(decideLetterbox([{ x: 0, y: 4, w: 1920, h: 1072 }], W, H)).toBeNull(); // < 2% trimmed
    expect(decideLetterbox([{ x: 0, y: 440, w: 1920, h: 200 }], W, H)).toBeNull(); // keeps < 30%
    expect(decideLetterbox([bars, null], W, H)).toBeNull();
  });
});

describe("detectLetterbox (tiny ffmpeg)", () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "vs-letterbox-"));
  });
  afterAll(() => rm(tmp, { recursive: true, force: true }));

  it("finds baked-in letterbox bars", async () => {
    const f = join(tmp, "lb.mp4");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=s=320x130:r=10:d=3", "-vf", "pad=320:180:0:25:black", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", f]);
    const box = await detectLetterbox(f, { duration_sec: 3, width: 320, height: 180 });
    expect(box).not.toBeNull();
    expect(Math.abs(box!.y - 25)).toBeLessThanOrEqual(2);
    expect(Math.abs(box!.h - 130)).toBeLessThanOrEqual(4);
    expect(box!.w).toBeGreaterThanOrEqual(316);
  }, 30_000);

  it("leaves a dark, asymmetric scene alone", async () => {
    const f = join(tmp, "dark.mp4");
    // Bright band high in the frame, darkness below: not letterbox.
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=10:d=3", "-vf", "drawbox=x=20:y=10:w=280:h=70:color=teal:t=fill", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", f]);
    expect(await detectLetterbox(f, { duration_sec: 3, width: 320, height: 180 })).toBeNull();
  }, 30_000);

  it("reports nothing for a full-frame clip", async () => {
    const f = join(tmp, "full.mp4");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=10:d=3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", f]);
    expect(await detectLetterbox(f, { duration_sec: 3, width: 320, height: 180 })).toBeNull();
  }, 30_000);
});

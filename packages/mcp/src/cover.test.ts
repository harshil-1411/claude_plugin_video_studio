import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffprobe, runFfmpeg } from "@video-studio/media";
import { type PxRect, layoutZones, loadContracts } from "@video-studio/platforms";
import { DEFAULT_TOKENS } from "@video-studio/renderer";
import type { PlatformContract } from "@video-studio/schema";
import { coverCrops, coverMaxBytes, cropRect, headlineRegion, renderCover } from "./cover.js";

// Tiny media only: a 180x320, 2 s master.
const T = 60_000;
let tmp: string;
let master: string;
let fixtures: PlatformContract[];

const inside = (a: PxRect, b: PxRect) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-cover-test-"));
  master = join(tmp, "master.mp4");
  await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=size=180x320:rate=15:duration=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", master]);
  fixtures = await loadContracts(join(import.meta.dirname, "../../platforms/src/__fixtures__/specs"));
}, T);
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("cover geometry (pure)", () => {
  it("computes anchored crops", () => {
    expect(cropRect(1080, 1920, "1:1")).toEqual({ x: 0, y: 420, w: 1080, h: 1080 });
    expect(cropRect(1080, 1920, "1:1", "top")).toEqual({ x: 0, y: 0, w: 1080, h: 1080 });
    expect(cropRect(1080, 1920, "4:5", "bottom")).toEqual({ x: 0, y: 570, w: 1080, h: 1350 });
    expect(cropRect(1920, 1080, "9:16")).toEqual({ x: 656, y: 0, w: 608, h: 1080 });
  });

  it("merges the square preview with contract crops and reads the size limit from contracts", () => {
    const crops = coverCrops(1080, 1920, fixtures);
    expect(crops.map((c) => [c.id, c.targets])).toEqual([["square-preview", ["preview", "demo-vertical"]]]);
    expect(coverMaxBytes(fixtures)).toBe(8 * 1024 * 1024);
    expect(coverMaxBytes([])).toBeUndefined();
  });

  it("puts the headline where the hook zone survives every crop, else high in the content zone", () => {
    const zones = layoutZones({ width: 1080, height: 1920, aspect_ratio: "9:16" });
    const crops = coverCrops(1080, 1920);
    // Portrait hook zone (y 180–600) vs centre square (y 420–1500): 180 px overlap.
    expect(headlineRegion(zones, crops, 150)).toEqual({ x: zones.hook.x, y: 420, w: zones.hook.w, h: 600 - 420 });
    const tall = headlineRegion(zones, crops, 300);
    expect(tall.y).toBe(420);
    expect(tall.h).toBe(zones.hook.h);
    for (const c of crops) expect(inside(tall, c)).toBe(true);
  });
});

describe("renderCover (tiny)", () => {
  it(
    "writes thumbnail.png, cover.jpg and the square preview, with the headline inside every crop",
    async () => {
      const zones = layoutZones({ width: 180, height: 320, aspect_ratio: "9:16" }, fixtures);
      const r = await renderCover({ master, outDir: tmp, atMs: 500, headline: "Search by meaning, not keywords", zones, tokens: { ...DEFAULT_TOKENS }, contracts: fixtures });
      expect(r.warnings).toEqual([]);
      expect([r.width, r.height, r.at_ms]).toEqual([180, 320, 500]);
      const cover = await ffprobe(r.cover);
      expect([cover.width, cover.height, cover.video_codec]).toEqual([180, 320, "mjpeg"]);
      const sq = await ffprobe(r.square_preview);
      expect([sq.width, sq.height]).toEqual([180, 180]);
      expect((await ffprobe(r.thumbnail)).video_codec).toBe("png");
      expect(r.bytes).toBe((await stat(r.cover)).size);
      expect(r.bytes).toBeLessThanOrEqual(r.max_bytes!);
      const box = r.headline_box!;
      expect(box).toMatchObject({ role: "headline", text: "Search by meaning, not keywords", truncated: false });
      for (const c of r.crops) expect(inside(box.rect, c), c.id).toBe(true);
      expect(inside(box.rect, r.region)).toBe(true);
      // The headline plate changed the frame: the composed cover differs from the plain frame.
      const plain = join(tmp, "plain.png");
      await runFfmpeg(["-y", "-ss", "0.5", "-i", master, "-frames:v", "1", plain]);
      const { stderr } = await runFfmpeg(["-i", r.thumbnail, "-i", plain, "-lavfi", "psnr", "-f", "null", "-"], { keepStderr: true });
      expect(Number(/PSNR .*average:([\d.]+|inf)/.exec(stderr)?.[1])).toBeLessThan(30);
    },
    T,
  );

  it(
    "steps JPEG quality down to meet a contract's size limit, and reports when it cannot",
    async () => {
      const zones = layoutZones({ width: 180, height: 320, aspect_ratio: "9:16" });
      const small = fixtures.map((c) => ({ ...c, cover: { ...c.cover, max_size_mb: 0.0001 } }));
      const r = await renderCover({ master, outDir: join(tmp, "small"), atMs: 99_000, headline: "Hi", zones, tokens: { ...DEFAULT_TOKENS }, contracts: small });
      expect(r.at_ms).toBeLessThan(2000);
      expect(r.jpeg_q).toBe(31);
      expect(r.warnings.join("\n")).toMatch(/over the targets' 104-byte limit/);
    },
    T,
  );
});

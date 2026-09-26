import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffprobe, runFfmpeg } from "@video-studio/media";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REVIEW_MAX_TILES, formatReview, reviewRender } from "./review.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vs-review-"));
  const rdir = join(dir, "renders", "preview");
  await mkdir(rdir, { recursive: true });
  await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=s=180x320:r=15:d=3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", join(rdir, "reel.mp4")]);
  await writeFile(
    join(rdir, "render-state.json"),
    JSON.stringify({
      quality: "preview",
      reel: "renders/preview/reel.mp4",
      target: { width: 180, height: 320, fps: 15 },
      duration_ms: 3000,
      scenes: [
        { scene_id: "s01", duration_ms: 1500 },
        { scene_id: "s02", duration_ms: 1500 },
      ],
    }),
  );
  await writeFile(join(dir, "renders", "latest.json"), JSON.stringify({ quality: "preview" }));
}, 60_000);

afterAll(() => rm(dir, { recursive: true, force: true }));

describe("review", () => {
  it("contact sheet: each scene's in, mid and out frames, labelled", async () => {
    const r = await reviewRender(dir);
    expect(r.mode).toBe("sheet");
    expect(r.image_rel).toBe(join("qa", "review", "sheet-preview.jpg"));
    expect(r.tiles.map((t) => t.label)).toEqual(["s01 in 0.30s", "s01 mid 0.75s", "s01 out 1.27s", "s02 in 1.80s", "s02 mid 2.25s", "s02 out 2.77s"]);
    expect([r.cols, r.rows]).toEqual([6, 1]);
    const p = await ffprobe(r.image);
    // 6 tiles of 240x427 (scale keeps an even height), 4 px padding between and a 4 px margin.
    expect(p.width).toBe(6 * 240 + 5 * 4 + 2 * 4);
    expect(formatReview(r)).toMatch(/Read the image/);
    // The work folder is cleaned up.
    expect(await readdir(join(dir, "qa", "review"))).toEqual(["sheet-preview.jpg"]);
  }, 60_000);

  it("strip: every frame of one scene", async () => {
    const r = await reviewRender(dir, { mode: "strip", scene: "s02" });
    // s02 spans 1.5–3.0 s: frames 23 (1.533 s) to 44 (2.933 s) at 15 fps.
    expect(r.tiles).toHaveLength(22);
    expect(r.tiles[0]!.time_sec).toBe(1.533);
    expect(r.tiles[21]!.time_sec).toBe(2.933);
    expect(r.tiles.every((t) => t.scene_id === "s02")).toBe(true);
    expect(existsSync(r.image)).toBe(true);
    expect(r.image_rel).toBe(join("qa", "review", "strip-preview-s02.jpg"));
  }, 60_000);

  it("strip over a chosen span, below the tile cap", async () => {
    const r = await reviewRender(dir, { mode: "strip", from_sec: 0, to_sec: 2.9, width: 64 });
    expect(r.tiles).toHaveLength(Math.min(REVIEW_MAX_TILES, 44));
    expect(r.notes).toEqual([]);
    expect(r.tiles[r.tiles.length - 1]!.time_sec).toBeCloseTo(2.867, 2);
  }, 60_000);

  it("crop: a region at full resolution, at chosen times", async () => {
    const r = await reviewRender(dir, { mode: "crop", crop: { x: 0, y: 0.5, w: 1, h: 0.25 }, times: [0.5, 2.5], width: 180 });
    expect(r.tiles.map((t) => t.scene_id)).toEqual(["s01", "s02"]);
    const p = await ffprobe(r.image);
    expect(p.height).toBe(80 + 2 * 4); // one row of 180x80 crops
  }, 60_000);

  it("the reel's very last frame still makes a tile", async () => {
    const r = await reviewRender(dir, { times: [2.99, 3] });
    expect(r.tiles).toHaveLength(2);
    expect(r.tiles.every((t) => t.time_sec <= 2.934)).toBe(true);
  }, 60_000);

  it("explains bad input", async () => {
    await expect(reviewRender(dir, { mode: "crop" })).rejects.toThrow(/needs crop/);
    await expect(reviewRender(dir, { scene: "s09" })).rejects.toThrow(/no scene "s09".*s01, s02/);
    await expect(reviewRender(dir, { mode: "crop", crop: { x: 0.5, y: 0, w: 0.8, h: 1 } })).rejects.toThrow(/inside the frame/);
  });
});

import { cpSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffprobe, runFfmpeg } from "@video-studio/media";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LintFinding } from "./lint.js";
import { REVIEW_MAX_TILES, type ReviewTile, applyCues, applyFlags, flagScenes, formatReview, reviewRender, tileDecor } from "./review.js";

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
    // No spec in this fixture: lint cannot run, which review notes and survives.
    expect(r.notes).toEqual([expect.stringMatching(/^lint failed.*no spec/)]);
    expect(r.flagged).toEqual([]);
    expect(r.lint).toBeUndefined();
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

  it("long videos keep every scene on the sheet (fewer tiles per scene)", async () => {
    const many = join(dir, "..", `${Date.now()}-many`);
    await mkdir(join(many, "renders", "preview"), { recursive: true });
    const { copyFile } = await import("node:fs/promises");
    await copyFile(join(dir, "renders", "preview", "reel.mp4"), join(many, "renders", "preview", "reel.mp4"));
    const scenes = Array.from({ length: 20 }, (_, i) => ({ scene_id: `s${String(i + 1).padStart(2, "0")}`, duration_ms: 150 }));
    await writeFile(join(many, "renders", "preview", "render-state.json"), JSON.stringify({ quality: "preview", reel: "renders/preview/reel.mp4", target: { width: 180, height: 320, fps: 15 }, duration_ms: 3000, scenes }));
    try {
      const r = await reviewRender(many, { quality: "preview", width: 64 });
      expect(r.tiles).toHaveLength(40);
      expect(new Set(r.tiles.map((t) => t.scene_id)).size).toBe(20);
      expect(r.notes.join(" ")).toMatch(/20 scenes: middle and closing frame of each/);
    } finally {
      await rm(many, { recursive: true, force: true });
    }
  }, 120_000);

  it("explains bad input", async () => {
    await expect(reviewRender(dir, { mode: "crop" })).rejects.toThrow(/needs crop/);
    await expect(reviewRender(dir, { scene: "s09" })).rejects.toThrow(/no scene "s09".*s01, s02/);
    await expect(reviewRender(dir, { mode: "crop", crop: { x: 0.5, y: 0, w: 0.8, h: 1 } })).rejects.toThrow(/inside the frame/);
  });
});

/** RGB of one pixel of an image. */
async function pixel(image: string, x: number, y: number, work: string): Promise<[number, number, number]> {
  const out = join(work, "px.rgb");
  await runFfmpeg(["-y", "-i", image, "-vf", `crop=1:1:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", out]);
  const b = await readFile(out);
  return [b[0]!, b[1]!, b[2]!];
}

describe("review flags", () => {
  let proj: string;
  beforeAll(async () => {
    // The lint fixture's spec (scenes s01, s02) with a small render whose s01 headline overflows.
    proj = await mkdtemp(join(tmpdir(), "vs-review-flags-"));
    cpSync(join(import.meta.dirname, "__fixtures__", "lint", "tiktok-low-captions"), proj, { recursive: true });
    const rdir = join(proj, "renders", "preview");
    await mkdir(rdir, { recursive: true });
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=0x303030:s=180x320:r=15:d=3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", join(rdir, "reel.mp4")]);
    const box = { role: "headline", text: "Captions hide under the UI and this line goes on", rect: { x: 10, y: 100, w: 160, h: 40 }, font_px: 20, truncated: true, color: "#F5F7FA", background: "#0B0F19" };
    await writeFile(
      join(rdir, "render-state.json"),
      JSON.stringify({
        quality: "preview",
        reel: "renders/preview/reel.mp4",
        target: { width: 180, height: 320, fps: 15, aspect_ratio: "9:16" },
        duration_ms: 3000,
        scenes: [
          { scene_id: "s01", duration_ms: 1500, text_boxes: [box] },
          { scene_id: "s02", duration_ms: 1500 },
        ],
        cues: [
          { scene_id: "s02", word: "lint", item: 0, at_ms: 300, status: "placed" },
          { scene_id: "s01", word: "zebra", item: 1, status: "unmatched" },
        ],
      }),
    );
  }, 60_000);
  afterAll(() => rm(proj, { recursive: true, force: true }));

  it("sheet: lint findings flag their scene's tiles with a red or amber border", async () => {
    const r = await reviewRender(proj, { quality: "preview" });
    expect(r.lint).toMatchObject({ report_md: join("qa", "lint.md") });
    const s01 = r.flagged.find((f) => f.scene_id === "s01")!;
    expect(s01.severity).toBe("error");
    expect(s01.findings.map((f) => f.id)).toEqual(expect.arrayContaining(["text_overflow", "cue_unmatched"]));
    expect(r.flagged[0]!.scene_id).toBe("s01");
    for (const t of r.tiles.filter((x) => x.scene_id === "s01")) {
      expect(t.severity).toBe("error");
      expect(t.flags![0]).toBe("text_overflow");
      expect(t.flags).toContain("cue_unmatched");
    }
    expect(formatReview(r)).toMatch(/flagged \(bordered tiles; look here first\): s01: text_overflow \(error\).*cue_unmatched \(warning\)/);
    // The first tile's left edge is red (x = margin 4 + 2 px into the 6 px border); unflagged tiles keep the grey frame.
    const [red, green, blue] = await pixel(r.image, 6, 200, proj);
    expect(red).toBeGreaterThan(180);
    expect(green).toBeLessThan(120);
    expect(blue).toBeLessThan(120);
    const s02 = r.tiles.find((t) => t.scene_id === "s02")!;
    if (!s02.severity) {
      const x = 4 + s02.index * (240 + 4) + 2;
      const [r2, g2, b2] = await pixel(r.image, x, 200, proj);
      expect(Math.max(r2, g2, b2) - Math.min(r2, g2, b2)).toBeLessThan(20);
    }
  }, 60_000);

  it("strip: placed word cues label the tile where the word is spoken", async () => {
    const r = await reviewRender(proj, { quality: "preview", mode: "strip", scene: "s02" });
    // s02 starts at 1.5 s; "lint" is spoken 300 ms in, at 1.8 s = frame 27 (tile 5 of the strip).
    const cued = r.tiles.filter((t) => t.cues);
    expect(cued.map((t) => [t.time_sec, t.cues])).toEqual([[1.8, ["lint"]]]);
    expect(cued[0]!.label).toBe('s02 1.80s cue "lint"');
    expect(formatReview(r)).toMatch(/word cues: "lint" at 1\.80s \(tile 5\)/);
    // Only s02 is in the strip, so s01's findings are not listed.
    expect(r.flagged.every((f) => f.scene_id === "s02")).toBe(true);
  }, 60_000);

  it("maps findings to tiles without lint or ffmpeg", () => {
    const findings: LintFinding[] = [
      { id: "caption_mask", severity: "error", target: "tiktok", message: "m", fix: "f" },
      { id: "reading_density", severity: "warning", scene_id: "s02", message: "m", fix: "f" },
      { id: "reading_density", severity: "warning", scene_id: "s02", message: "m2", fix: "f" },
      { id: "text_overflow", severity: "error", scene_id: "s03", message: "m", fix: "f" },
    ];
    const cues = [
      { scene_id: "s02", word: "forty", item: 0, at_ms: 500, status: "placed" },
      { scene_id: "s01", word: "nine", item: 1, status: "late" },
    ];
    const flags = flagScenes(findings, cues, ["s01", "s02", "s03"]);
    // Errors first, then scene order; findings not tied to a scene are left out.
    expect(flags.map((f) => [f.scene_id, f.severity])).toEqual([
      ["s03", "error"],
      ["s01", "warning"],
      ["s02", "warning"],
    ]);
    expect(flags[1]!.findings[0]!.message).toMatch(/"nine".*after the scene ends/);
    const tiles: ReviewTile[] = [0, 1, 2, 3].map((i) => ({ index: i, time_sec: 1 + i * 0.2, scene_id: i < 2 ? "s01" : "s02", label: `t${i}` }));
    applyFlags(tiles, flags);
    expect(tiles.map((t) => t.flags)).toEqual([["cue_unmatched"], ["cue_unmatched"], ["reading_density"], ["reading_density"]]);
    applyCues(tiles, cues, [{ id: "s01", start: 0 }, { id: "s02", start: 1 }], 1 / 30);
    expect(tiles.map((t) => t.cues)).toEqual([undefined, undefined, ["forty"], undefined]);
    // A border only on flagged tiles; the label moves inside it.
    expect(tileDecor({ label: "a" }, 240, undefined)).toBe("");
    expect(tileDecor({ label: "a", severity: "error" }, 240, undefined)).toBe(",drawbox=x=0:y=0:w=iw:h=ih:color=0xE5484D:t=6");
    expect(tileDecor({ label: "a", severity: "warning", cues: ["x"] }, 240, "/f.ttf")).toMatch(/color=0xF5A524.*x=8:y=8.*text=cue "x"/);
  });
});

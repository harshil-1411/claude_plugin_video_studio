import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingest } from "@video-studio/ingestion";
import { ContentIR } from "@video-studio/schema";
import { footageLook, footageNotes, pickFrames, thumbDiff } from "./footage-look.js";

const ff = (...args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

/** Four 1.5 s solid-colour shots: black, white, black, yellow (shot 3 repeats shot 1's picture). Colours differ in luma so scene detection cuts them. */
function makeVideo(path: string, colors = ["black", "white", "black", "yellow"]): void {
  const inputs = colors.flatMap((c) => ["-f", "lavfi", "-i", `color=c=${c}:s=320x180:r=15:d=1.5`]);
  const graph = `${colors.map((_, i) => `[${i}:v]`).join("")}concat=n=${colors.length}:v=1:a=0[v]`;
  ff(...inputs, "-filter_complex", graph, "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path);
}

let dir: string;
let project: string;
let video: string;
let videoId: string;
let audioId: string;

const readIr = async () => ContentIR.parse(JSON.parse(await readFile(join(project, "source", "content-ir.json"), "utf8")));
const writeIr = (ir: ContentIR) => writeFile(join(project, "source", "content-ir.json"), JSON.stringify(ir));

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vs-footage-look-"));
  video = join(dir, "shots.mp4");
  makeVideo(video);
  const wav = join(dir, "voice.wav");
  ff("-f", "lavfi", "-i", "sine=frequency=330:duration=1", wav);
  project = join(dir, "proj");
  const { ir } = await ingest([video, wav], { projectDir: project, noCache: true });
  videoId = ir.assets.find((a) => a.kind === "video")!.id;
  audioId = ir.assets.find((a) => a.kind === "audio")!.id;
  // A fake two-speaker transcript for the video.
  const words = [
    { word: "Black", start_ms: 200, end_ms: 500, speaker: "S1" },
    { word: "first.", start_ms: 520, end_ms: 900, speaker: "S1" },
    { word: "White", start_ms: 1700, end_ms: 2000, speaker: "S2" },
    { word: "next.", start_ms: 2020, end_ms: 2400, speaker: "S2" },
    { word: "Yellow", start_ms: 3200, end_ms: 3500, speaker: "S1" },
    { word: "now.", start_ms: 3520, end_ms: 3900, speaker: "S1" },
  ];
  await mkdir(join(project, "source", "transcripts"), { recursive: true });
  await writeFile(join(project, "source", "transcripts", `${videoId}.json`), JSON.stringify(words));
  const cur = await readIr();
  const a = cur.assets.find((x) => x.id === videoId)!;
  a.media = { ...a.media!, transcript: { path: `source/transcripts/${videoId}.json`, source: "srt", speakers: true, words: words.length } };
  await writeIr(cur);
}, 90_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("pickFrames / thumbDiff (pure)", () => {
  it("takes an opening frame per shot, a middle frame for long shots, and spreads when capped", () => {
    const shots = [
      { start_sec: 0, end_sec: 2 },
      { start_sec: 2, end_sec: 10 },
      { start_sec: 10, end_sec: 12 },
    ];
    const all = pickFrames(shots, 0, 12, 12, 12);
    expect(all.map((c) => [c.shot, c.first])).toEqual([
      [1, true],
      [2, true],
      [2, false],
      [3, true],
    ]);
    expect(all[1]!.time).toBeCloseTo(2.3, 3);
    expect(all[2]!.time).toBeCloseTo(6, 3);
    expect(pickFrames(shots, 0, 12, 12, 2).every((c) => c.first)).toBe(true);
    // A range starting mid-shot samples from the range start.
    expect(pickFrames(shots, 5, 11, 12, 12)[0]).toMatchObject({ shot: 2, first: true });
    expect(pickFrames(shots, 5, 11, 12, 12)[0]!.time).toBeGreaterThanOrEqual(5);
  });

  it("measures mean absolute difference", () => {
    expect(thumbDiff(new Uint8Array([10, 20]), new Uint8Array([10, 20]))).toBe(0);
    expect(thumbDiff(new Uint8Array([0, 0]), new Uint8Array([10, 30]))).toBe(20);
    expect(thumbDiff(new Uint8Array([0]), new Uint8Array([0, 0]))).toBe(255);
  });
});

describe("footageLook (tiny ffmpeg)", () => {
  it("shows one frame per shot, drops the repeated picture, labels tiles and returns the transcript window", async () => {
    const ir = await readIr();
    expect(ir.assets.find((a) => a.id === videoId)!.media!.shots).toHaveLength(4);
    const r = await footageLook(project, videoId);
    expect(r.tiles.map((t) => t.shot)).toEqual([1, 2, 4]);
    expect(r.tiles[0]!.label).toMatch(/^t=0\.\ds shot 1$/);
    expect(r.duplicates).toEqual([expect.objectContaining({ shot: 3, same_as_tile: 0 })]);
    expect(r.tile_px).toEqual({ width: 512, height: 288 });
    expect(r.images).toHaveLength(1);
    const dur = ir.assets.find((a) => a.id === videoId)!.media!.duration_sec;
    expect(r.images_rel[0]).toBe(`qa/footage/${videoId}-0.0-${dur.toFixed(1)}.jpg`);
    expect(existsSync(r.images[0]!)).toBe(true);
    expect(r.pages[0]).toMatchObject({ cols: 2, rows: 2 });
    expect(r.transcript).toEqual([
      { start_sec: 0.2, end_sec: 0.9, speaker: "S1", text: "Black first." },
      { start_sec: 1.7, end_sec: 2.4, speaker: "S2", text: "White next." },
      { start_sec: 3.2, end_sec: 3.9, speaker: "S1", text: "Yellow now." },
    ]);
    // No work folders left behind.
    const left = (await import("node:fs/promises")).readdir(join(project, "qa", "footage"));
    expect((await left).filter((f) => f.startsWith(".work"))).toEqual([]);
  }, 60_000);

  it("limits frames and transcript to a range and clamps an end past the duration", async () => {
    const r = await footageLook(project, videoId, { from_sec: 1.6, to_sec: 99 });
    expect(r.to_sec).toBe(r.duration_sec);
    expect(r.tiles.map((t) => t.shot)).toEqual([2, 3, 4]); // black again, but its first showing is outside this range
    expect(r.transcript?.map((s) => s.text)).toEqual(["White next.", "Yellow now."]);
    expect(r.notes.some((n) => n.includes("clamped"))).toBe(true);
    const one = await footageLook(project, videoId, { max_frames: 1 });
    expect(one.tiles).toHaveLength(1);
  }, 60_000);

  it("gives clear errors", async () => {
    await expect(footageLook(project, audioId)).rejects.toThrow(/audio-only/);
    await expect(footageLook(project, "asset-nope")).rejects.toThrow(/not a video or audio asset/);
    await expect(footageLook(project, videoId, { from_sec: 7 })).rejects.toThrow(/past the end/);
    await expect(footageLook(project, videoId, { from_sec: 3, to_sec: 2 })).rejects.toThrow(/must be after/);
    const ir = await readIr();
    const a = ir.assets.find((x) => x.id === videoId)!;
    const saved = a.path;
    a.path = "source/assets/missing.mp4";
    await writeIr(ir);
    try {
      await expect(footageLook(project, videoId)).rejects.toThrow(/asset file not found/);
      a.path = "../outside.mp4";
      await writeIr(ir);
      await expect(footageLook(project, videoId)).rejects.toThrow(/outside the project/);
    } finally {
      a.path = saved;
      await writeIr(ir);
    }
  });
});

describe("footageNotes", () => {
  it("writes, reads and replaces by range without touching evidence or claims", async () => {
    const before = await readIr();
    expect((await footageNotes(project, videoId)).notes).toEqual([]);
    const w = await footageNotes(project, videoId, [
      { from_sec: 1.5, to_sec: 3, subject: "blue field", broll: true, quality: "good", tags: ["blue", "blue", " flat "] },
      { from_sec: 0, to_sec: 1.5, subject: "red field", on_screen_text: "" },
    ]);
    expect(w).toMatchObject({ mode: "write", added: 2, replaced: 0 });
    expect(w.notes.map((n) => n.subject)).toEqual(["red field", "blue field"]);
    expect(w.notes[1]!.tags).toEqual(["blue", "flat"]);
    expect(w.notes[0]).not.toHaveProperty("on_screen_text");

    const r2 = await footageNotes(project, videoId, [{ from_sec: 1.51, to_sec: 3, subject: "blue again", quality: "ok" }]);
    expect(r2).toMatchObject({ added: 0, replaced: 1 });
    const read = await footageNotes(project, videoId);
    expect(read.notes.map((n) => n.subject)).toEqual(["red field", "blue again"]);

    const after = await readIr();
    expect(after.evidence).toEqual(before.evidence);
    expect(after.claims).toEqual(before.claims);
    expect(JSON.stringify(after.evidence)).not.toContain("blue again");

    // footage_look shows the stored notes for its range.
    const look = await footageLook(project, videoId, { from_sec: 0, to_sec: 1.4 });
    expect(look.shot_notes?.map((n) => n.subject)).toEqual(["red field"]);
  }, 60_000);

  it("validates ranges and refuses audio assets", async () => {
    await expect(footageNotes(project, videoId, [{ from_sec: 2, to_sec: 1 }])).rejects.toThrow(/from_sec < to_sec/);
    await expect(footageNotes(project, videoId, [{ from_sec: 1, to_sec: 60 }])).rejects.toThrow(/past the end/);
    await expect(footageNotes(project, videoId, [])).rejects.toThrow(/empty/);
    await expect(footageNotes(project, audioId, [{ from_sec: 0, to_sec: 1 }])).rejects.toThrow(/audio-only/);
  });

  it("survives re-ingest of the same file; a re-cut file drops them", async () => {
    await ingest([video], { projectDir: project, noCache: true });
    let ir = await readIr();
    const asset = ir.assets.find((a) => a.kind === "video")!;
    expect(asset.id).toBe(videoId);
    expect(asset.media?.notes?.map((n) => n.subject)).toEqual(["red field", "blue again"]);

    // A stale note (hash of another file) is reported on read and dropped on write.
    asset.media!.notes!.push({ ...asset.media!.notes![0]!, from_sec: 4.5, to_sec: 6, asset_sha256: "0".repeat(64) });
    await writeIr(ir);
    expect(await footageNotes(project, videoId)).toMatchObject({ stale: 1 });
    const w = await footageNotes(project, videoId, [{ from_sec: 3, to_sec: 4.5, subject: "green field" }]);
    expect(w).toMatchObject({ stale: 1, added: 1 });
    expect((await readIr()).assets.find((a) => a.id === videoId)!.media!.notes).toHaveLength(3);

    makeVideo(video, ["yellow", "blue", "white", "black"]);
    await ingest([video], { projectDir: project, noCache: true });
    ir = await readIr();
    const recut = ir.assets.find((a) => a.id === videoId)!;
    expect(recut.media?.notes).toBeUndefined();
  }, 90_000);
});

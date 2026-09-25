import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentIR } from "@video-studio/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectKind } from "./detect.js";
import { ingest } from "./ingest.js";
import { parseShowinfoTimes, shotsFromCuts, spreadIndices } from "./media.js";

let dir: string;
let video: string;
let audio: string;

function ff(args: string[]): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

/** 6 s, 160x120@15: testsrc | mandelbrot | smptebars (three visually different shots) + a 440 Hz tone. */
function makeThreeShotVideo(out: string): void {
  ff([
    "-f", "lavfi", "-i", "testsrc=size=160x120:rate=15:duration=2",
    "-f", "lavfi", "-i", "mandelbrot=size=160x120:rate=15",
    "-f", "lavfi", "-i", "smptebars=size=160x120:rate=15:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
    "-filter_complex", "[1:v]trim=duration=2,setpts=PTS-STARTPTS[m];[0:v][m][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]",
    "-map", "[v]", "-map", "3:a", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", out,
  ]);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vs-media-ingest-"));
  video = join(dir, "clip.mp4");
  audio = join(dir, "tone.m4a");
  makeThreeShotVideo(video);
  ff(["-f", "lavfi", "-i", "sine=frequency=220:duration=2", "-c:a", "aac", audio]);
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("detectKind for media", () => {
  it("maps audio extensions to audio and video extensions to video", () => {
    for (const ext of [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"]) expect(detectKind(`talk${ext}`)).toBe("audio");
    expect(detectKind("talk.MP4")).toBe("video");
    expect(detectKind("talk.mov")).toBe("video");
  });
});

describe("shot helpers", () => {
  it("parses showinfo and merges tiny shots", () => {
    const stderr = "[Parsed_showinfo_2 @ 0x1] n:   0 pts:  30 pts_time:2       duration: 1\n[Parsed_showinfo_2 @ 0x1] n:   1 pts:  60 pts_time:4.1 x\n";
    expect(parseShowinfoTimes(stderr)).toEqual([2, 4.1]);
    expect(shotsFromCuts([2, 2.1, 4, 5.9], 6)).toEqual([
      { start_sec: 0, end_sec: 2 },
      { start_sec: 2, end_sec: 4 },
      { start_sec: 4, end_sec: 6 },
    ]);
    expect(shotsFromCuts([], 3)).toEqual([{ start_sec: 0, end_sec: 3 }]);
    expect(spreadIndices(3, 5)).toEqual([0, 1, 2]);
    expect(spreadIndices(100, 4)).toEqual([12, 37, 62, 87]);
  });
});

describe("media ingest", () => {
  it("copies a video into the project with probe facts, shots, keyframes and loudness", async () => {
    const project = join(dir, "p1");
    const { ir, summary } = await ingest([video], { projectDir: project, noCache: true, now: "2026-09-25T00:00:00.000Z" });
    expect(ContentIR.safeParse(ir).success).toBe(true);
    expect(ir.sources[0]).toMatchObject({ kind: "video", title: "clip" });
    const v = ir.assets.find((a) => a.kind === "video")!;
    expect(v.path).toBe(`source/assets/${v.sha256}.mp4`);
    expect(existsSync(join(project, v.path))).toBe(true);
    expect(v.source_ref).toBe("video:clip.mp4");
    const m = v.media!;
    expect(m.duration_sec).toBeCloseTo(6, 0);
    expect(m).toMatchObject({ width: 160, height: 120, fps: 15, has_video: true, has_audio: true });
    expect(m.loudness_lufs).toBeTypeOf("number");
    expect(m.shots!.length).toBeGreaterThanOrEqual(2);
    expect(m.shots!.length).toBeLessThanOrEqual(4);
    expect(m.shots![0]!.start_sec).toBe(0);
    expect(m.shots![m.shots!.length - 1]!.end_sec).toBeCloseTo(6, 0);
    // Keyframes are image assets referenced by id from each shot.
    const images = ir.assets.filter((a) => a.kind === "image");
    expect(images.length).toBe(m.shots!.length);
    for (const s of m.shots!) {
      const k = ir.assets.find((a) => a.id === s.keyframe);
      expect(k?.kind).toBe("image");
      expect(k!.path).toMatch(/\.jpg$/);
      expect(existsSync(join(project, k!.path))).toBe(true);
    }
    // No evidence until transcribe; likeness assumed for footage.
    expect(ir.evidence).toHaveLength(0);
    expect(ir.sections[0]!.text).toMatch(/6\.0 s/);
    expect(ir.classification.contains_likeness).toBe(true);
    expect(summary.warnings.map((w) => w.code)).toContain("needs_transcript");
  }, 60_000);

  it("ingests an audio-only file as an audio asset", async () => {
    const project = join(dir, "p2");
    const { ir } = await ingest([audio], { projectDir: project, noCache: true });
    expect(ir.sources[0]!.kind).toBe("audio");
    expect(ir.assets).toHaveLength(1);
    const a = ir.assets[0]!;
    expect(a).toMatchObject({ kind: "audio", source_ref: "audio:tone.m4a" });
    expect(a.media).toMatchObject({ has_video: false, has_audio: true });
    expect(a.media!.shots).toBeUndefined();
    expect(ir.classification.contains_likeness).toBe(false);
  }, 60_000);

  it("restores the media file from the cache into a new project", async () => {
    const cacheDir = join(dir, "cache");
    await ingest([video], { projectDir: join(dir, "p3"), cacheDir });
    const project = join(dir, "p4");
    const { ir, summary } = await ingest([video], { projectDir: project, cacheDir });
    expect(summary.sources[0]!.cache_hit).toBe(true);
    for (const a of ir.assets) expect(existsSync(join(project, a.path))).toBe(true);
  }, 60_000);
});

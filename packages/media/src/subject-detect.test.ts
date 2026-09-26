import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFfmpeg } from "./ffmpeg.js";
import { type FrameDetections, type SubjectDetector, detectSubjects, parseVisionOutput, pickPrimary, picksToTrack, suggestFocusTrack, visionAvailability } from "./subject-detect.js";

// A public-domain portrait; set VS_TEST_FACE_IMAGE to use another one.
const FACE =
  process.env.VS_TEST_FACE_IMAGE ?? "/private/tmp/claude-504/-Users-suparnbector-Desktop-plugin-knowledge-to-video/636d3877-5ba5-45b3-a5e9-655002e78427/scratchpad/vision/lincoln.jpg";
const canVision = visionAvailability().ok && existsSync(FACE);

describe("subject detection (pure)", () => {
  it("is unavailable off macOS, with a reason", async () => {
    const r = await detectSubjects(["/x.png"], { platform: "linux" });
    expect(r).toMatchObject({ available: false, frames: [] });
    expect(!r.available && r.reason).toMatch(/macOS Vision; this is linux/);
    expect(visionAvailability({ platform: "darwin", osascript: "/nope/osascript" }).ok).toBe(false);
  });

  it("parses the JXA output defensively", () => {
    const out = parseVisionOutput('junk [{"path":"a","ok":true,"faces":[{"x":0.1,"y":0.2,"w":0.3,"h":0.4,"c":0.9}],"salient":[]}] trailing', ["a", "b"]);
    expect(out[0]).toEqual({ path: "a", ok: true, faces: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4, c: 0.9 }], salient: [] });
    expect(out[1]).toEqual({ path: "b", ok: false, faces: [], salient: [] });
    expect(parseVisionOutput("not json", ["a"])[0]!.ok).toBe(false);
  });

  it("picks the biggest face, favours one near the previous subject, falls back to salient", () => {
    const left = { x: 0.1, y: 0.2, w: 0.2, h: 0.3, c: 0.9 };
    const right = { x: 0.7, y: 0.2, w: 0.22, h: 0.3, c: 0.9 };
    expect(pickPrimary({ faces: [left, right], salient: [] }, null)!.x).toBeCloseTo(0.81);
    // Following the left speaker: a slightly bigger face across the frame does not steal the crop.
    expect(pickPrimary({ faces: [left, right], salient: [] }, { x: 0.2, y: 0.4 })!.x).toBeCloseTo(0.2);
    const sal = pickPrimary({ faces: [], salient: [{ x: 0.4, y: 0.4, w: 0.2, h: 0.2, c: 1 }] }, null);
    expect(sal).toEqual({ x: 0.5, y: 0.5, source: "salient" });
    expect(pickPrimary({ faces: [], salient: [] }, null)).toBeNull();
  });

  it("carries misses forward, back-fills leading misses and collapses holds", () => {
    const times = [0, 0.5, 1, 1.5, 2, 2.5, 3];
    const P = (x: number) => ({ x, y: 0.5, source: "face" as const });
    const track = picksToTrack(times, [null, P(0.3), P(0.305), null, null, P(0.6), P(0.6)]);
    expect(track[0]).toEqual({ t: 0, x: 0.3, y: 0.5 });
    expect(track.at(-1)).toEqual({ t: 3, x: 0.6, y: 0.5 });
    expect(track.every((k, i) => i === 0 || k.t > track[i - 1]!.t)).toBe(true);
    // The hold at ~0.3 keeps only its ends.
    expect(track.filter((k) => Math.abs(k.x - 0.3) < 0.02).length).toBeLessThanOrEqual(2);
    expect(picksToTrack(times, times.map(() => null))).toEqual([]);
  });
});

describe("suggestFocusTrack", () => {
  let tmp: string;
  let clip: string;
  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "vs-subject-"));
    clip = join(tmp, "box.mp4");
    // A white box moving right over 2 s (no faces: the salient path).
    await runFfmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=320x180:r=15:d=2[bg];color=c=white:s=40x40:r=15:d=2[b];[bg][b]overlay=x='40+100*t':y=70:shortest=1",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      clip,
    ]);
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("samples frames, uses salient objects without faces and carries misses forward", async () => {
    const seen: string[][] = [];
    // Injected detector: the box's true position per sampled frame (frame k at k/2 s), missing frame 2.
    const detector: SubjectDetector = async (frames) => {
      seen.push(frames);
      return {
        available: true,
        frames: frames.map((path, k): FrameDetections => {
          const t = k / 2;
          const cx = (60 + 100 * t) / 320;
          return { path, ok: true, faces: [], salient: k === 2 ? [] : [{ x: cx - 0.0625, y: 0.39, w: 0.125, h: 0.22, c: 1 }] };
        }),
      };
    };
    const r = await suggestFocusTrack(clip, { from: 0, to: 2, fps: 2, width: 160, detector });
    expect(seen[0]!.length).toBe(4);
    expect(seen[0]!.map((f) => basename(f))).toEqual(["f0001.png", "f0002.png", "f0003.png", "f0004.png"]);
    expect(r).toMatchObject({ method: "vision", frames_checked: 4, detections: { faces: 0, salient: 3, missed: 1 } });
    expect(r.keys[0]!.t).toBe(0);
    expect(r.keys[0]!.x).toBeCloseTo(60 / 320, 2);
    expect(r.keys.at(-1)!.x).toBeCloseTo(210 / 320, 2);
    expect(r.notes.join(" ")).toMatch(/no faces found/);
    // Temp frames are cleaned up.
    expect(existsSync(seen[0]![0]!)).toBe(false);
  });

  it("reports unavailable detection", async () => {
    const r = await suggestFocusTrack(clip, { from: 0, to: 1, detector: async () => ({ available: false, reason: "no Vision here", frames: [] }) });
    expect(r).toMatchObject({ method: "unavailable", keys: [], notes: ["no Vision here"] });
  });
});

describe.skipIf(!canVision)("macOS Vision (real)", () => {
  it(
    "finds the one face in a portrait",
    async () => {
      const r = await detectSubjects([resolve(FACE)]);
      expect(r.available).toBe(true);
      expect(r.frames[0]!.ok).toBe(true);
      expect(r.frames[0]!.faces).toHaveLength(1);
      const f = r.frames[0]!.faces[0]!;
      expect(f.x + f.w / 2).toBeGreaterThan(0.3);
      expect(f.x + f.w / 2).toBeLessThan(0.7);
      expect(f.y).toBeGreaterThan(0.1); // top-left origin (y flipped from Vision's bottom-left)
    },
    60_000,
  );

  it(
    "never throws on an image with nothing in it, or a missing file",
    async () => {
      const blank = join(tmpdir(), `vs-blank-${process.pid}.png`);
      await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=black:s=64x64", "-frames:v", "1", blank]);
      const r = await detectSubjects([blank, "/nonexistent/x.png"]);
      await rm(blank, { force: true });
      expect(r.available).toBe(true);
      expect(r.frames[0]!.faces).toEqual([]);
      expect(r.frames[1]!.ok).toBe(false);
    },
    60_000,
  );
});

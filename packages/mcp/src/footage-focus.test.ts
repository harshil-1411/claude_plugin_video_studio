import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingest } from "@video-studio/ingestion";
import type { SubjectDetector } from "@video-studio/media";
import type { VideoSpec } from "@video-studio/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { footageFocus, formatFootageFocus } from "./footage-focus.js";
import { type LintFinding, checkSubjectNearEdge } from "./lint.js";

let dir: string;
let project: string;
let videoId: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vs-focus-tool-"));
  const video = join(dir, "talk.mp4");
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=320x180:rate=15:duration=3",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", video,
  ]);
  project = join(dir, "proj");
  const { ir } = await ingest([video], { projectDir: project, noCache: true });
  videoId = ir.assets.find((a) => a.kind === "video")!.id;
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const faceAt = (x: number): SubjectDetector => async (frames) => ({
  available: true,
  frames: frames.map((path) => ({ path, ok: true, faces: [{ x: x - 0.1, y: 0.2, w: 0.2, h: 0.3, c: 0.9 }], salient: [] })),
});

describe("footageFocus", () => {
  it("returns a focus_track relative to in_sec", async () => {
    const r = await footageFocus(project, { asset: videoId, in_sec: 1, out_sec: 3, detector: faceAt(0.7) });
    expect(r).toMatchObject({ asset: videoId, in_sec: 1, out_sec: 3, method: "vision", frames_checked: 4, detections: { faces: 4 } });
    expect(r.focus_track[0]).toEqual({ t: 0, x: 0.7, y: 0.425 });
    expect(formatFootageFocus(r)).toMatch(/focus_track: \[/);
  });

  it("says when detection is unavailable and points at the by-eye path", async () => {
    const r = await footageFocus(project, { asset: videoId, in_sec: 0, detector: async () => ({ available: false, reason: "subject detection uses macOS Vision; this is linux", frames: [] }) });
    expect(r.method).toBe("unavailable");
    expect(r.focus_track).toEqual([]);
    expect(r.out_sec).toBe(3); // clamped to the asset
    expect(r.notes.join(" ")).toMatch(/footage_look/);
  });

  it("rejects bad ranges and assets", async () => {
    await expect(footageFocus(project, { asset: videoId, in_sec: 9 })).rejects.toThrow(/outside/);
    await expect(footageFocus(project, { asset: "nope", in_sec: 0 })).rejects.toThrow(/not a video or audio asset/);
  });
});

describe("lint subject_near_edge", () => {
  const ir = { assets: [{ id: "v1", media: { width: 1920, height: 1080 } }] };
  const spec = (track: Array<{ t: number; x: number; y: number }>, fit: "cover" | "contain" = "cover") =>
    ({ scenes: [{ id: "s01", duration_sec: 4, footage: { asset: "v1", in_sec: 0, fit, focus_track: track } }] }) as unknown as VideoSpec;

  it("warns when the subject sits at the source edge, not when it can be centred", () => {
    const out: LintFinding[] = [];
    checkSubjectNearEdge(spec([{ t: 0, x: 0.5, y: 0.5 }, { t: 3, x: 0.6, y: 0.5 }]), ir, 1080, 1920, out);
    expect(out).toEqual([]);
    checkSubjectNearEdge(spec([{ t: 0, x: 0.5, y: 0.5 }, { t: 3, x: 0.99, y: 0.5 }]), ir, 1080, 1920, out);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "subject_near_edge", severity: "warning", scene_id: "s01" });
    expect(out[0]!.message).toMatch(/right edge/);
  });

  it("skips non-cover fits and unknown assets", () => {
    const out: LintFinding[] = [];
    checkSubjectNearEdge(spec([{ t: 0, x: 0.99, y: 0.5 }], "contain"), ir, 1080, 1920, out);
    checkSubjectNearEdge(spec([{ t: 0, x: 0.99, y: 0.5 }]), undefined, 1080, 1920, out);
    expect(out).toEqual([]);
  });
});

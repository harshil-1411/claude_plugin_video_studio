import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashFile } from "@video-studio/core";
import { runFfmpeg } from "@video-studio/media";
import type { Scene, SceneVoiceTrack } from "@video-studio/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ResolvedMusic } from "./music.js";
import { beatSyncDurations, bedTimeline, buildSceneAudio, sfxPeakMs } from "./pipeline-media.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-pipeline-media-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const scene = (id: string, duration_sec: number): Scene => ({ id, duration_sec, voiceover: "" }) as unknown as Scene;
const track = (scene_id: string, duration_ms = 0): SceneVoiceTrack => ({
  scene_id,
  duration_ms,
  words: [],
  timing_source: "estimated",
  provider: "silent",
  ...(duration_ms ? { audio_path: `renders/voice/${scene_id}.wav` } : {}),
});
/** A synthesized 120 bpm score, 2 bars (4 s): beats every 500 ms, bars every 2 s. No file is read. */
const synth = (downbeats = true): ResolvedMusic => ({
  ref: "synth:pulse",
  path: "/nonexistent.wav",
  sha256: "0".repeat(64),
  bed: { file: "synth:pulse" },
  grid: { bpm: 120, beats_ms: [0, 500, 1000, 1500, 2000, 2500, 3000, 3500], downbeats_ms: downbeats ? [0, 2000] : [], duration_ms: 4000 },
});

describe("bedTimeline", () => {
  it("shifts by start_sec and repeats a looping bed", () => {
    expect(bedTimeline([0, 2000], 4000, 0, true, 9000)).toEqual([0, 2000, 4000, 6000, 8000]);
    expect(bedTimeline([0, 2000], 4000, 1000, true, 5000)).toEqual([1000, 3000, 5000]);
    expect(bedTimeline([0, 2000], 4000, 0, false, 9000)).toEqual([0, 2000]);
  });
});

describe("beatSyncDurations", () => {
  // Cuts at 1.4 s and 3.7 s.
  const scenes = [scene("s01", 1.4), scene("s02", 2.3), scene("s03", 2.3)];
  const none = new Map<string, SceneVoiceTrack>();

  it("uses a synthesized score's exact grid and snaps to beats by default", async () => {
    const r = await beatSyncDurations(scenes, new Map(), synth(), 700, none);
    expect(r.summary).toMatchObject({ bpm: 120, source: "synth", snap: "beat", moved_cuts: 2 });
    expect(r.summary.downbeat_times_ms).toEqual([0, 2000, 4000, 6000]);
    expect(r.adjustments.map((a) => a.render_duration_sec)).toEqual([1.5, 2, 2.5]);
  });

  it("snaps to bar starts with snap: downbeat", async () => {
    const r = await beatSyncDurations(scenes, new Map(), synth(), 700, none, { snap: "downbeat" });
    expect(r.summary.snap).toBe("downbeat");
    expect(r.adjustments.map((a) => a.render_duration_sec)).toEqual([2, 2, 2]);
    expect(r.adjustments[0]!.reason).toMatch(/onto the nearest bar start/);
    expect(r.warning).toBeUndefined();
  });

  it("falls back to beats, with a note, when the bed has no bar starts", async () => {
    const r = await beatSyncDurations(scenes, new Map(), synth(false), 700, none, { snap: "downbeat" });
    expect(r.summary.snap).toBe("beat");
    expect(r.summary.downbeat_times_ms).toBeUndefined();
    expect(r.warning).toMatch(/no bar starts could be read from synth:pulse.*snapped to beats instead/);
    expect(r.adjustments.map((a) => a.render_duration_sec)).toEqual([1.5, 2, 2.5]);
  });

  it("never moves a cut into a scene's voiceover", async () => {
    // s02's voice lasts 2.2 s: moving the first cut to 2.0 s would leave it 1.7 s (to the 3.7 s cut).
    const voiced = new Map([["s02", track("s02", 2200)]]);
    const r = await beatSyncDurations(scenes, new Map(), synth(), 700, voiced, { snap: "downbeat" });
    expect(r.adjustments.find((a) => a.scene_id === "s01")).toBeUndefined();
  });
});

describe("sfx peak alignment in the scene audio plan", () => {
  it("measures the peak once, caches it by content hash, and lands the peak on at_sec", async () => {
    const root = join(tmp, "proj");
    await mkdir(join(root, "assets", "sfx"), { recursive: true });
    const hit = join(root, "assets", "sfx", "hit.wav");
    // 0.3 s of quiet lead-in, then the hit.
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "aevalsrc=if(lt(t\\,0.3)\\,0.05\\,0.9*exp(-20*(t-0.3)))*sin(2*PI*300*t):s=48000:d=0.6", hit]);
    const cacheDir = join(tmp, "cache");
    const sha = await hashFile(hit);
    const peak = await sfxPeakMs(hit, sha, { cacheDir });
    expect(Math.abs(peak - 305)).toBeLessThanOrEqual(5);
    // Cached by hash: a path ffmpeg can't read still answers.
    expect(await sfxPeakMs(join(tmp, "missing.wav"), sha, { cacheDir })).toBe(peak);
    await expect(sfxPeakMs(join(tmp, "missing.wav"), "f".repeat(64), { cacheDir })).rejects.toThrow(/could not be decoded to find its peak/);

    const s1 = { ...scene("s01", 1), sfx: [{ file: "assets/sfx/hit.wav", at_sec: 0.1 }] } as Scene;
    const s2 = { ...scene("s02", 1), sfx: [{ file: "assets/sfx/hit.wav", at_sec: 0.5 }] } as Scene;
    const plan = await buildSceneAudio(
      root,
      [s1, s2],
      [
        { scene_start_ms: 0, track: track("s01") },
        { scene_start_ms: 1000, track: track("s02") },
      ],
      [1000, 1000],
      { byScene: new Map(), assets: new Map(), used: [] },
      new Map(),
      [],
      { cacheDir },
    );
    // s01: the peak would need to start 205 ms before the scene, so the head is trimmed instead.
    expect(plan.sfx[0]).toMatchObject({ at_ms: 0, trim_ms: peak - 100 });
    // s02: starts a peak earlier.
    expect(plan.sfx[1]).toMatchObject({ at_ms: 1500 - peak });
    expect(plan.sfx[1]!.trim_ms).toBeUndefined();
    expect(plan.sfxState).toEqual([{ file: "assets/sfx/hit.wav", sha256: sha, scenes: ["s01", "s02"], peak_ms: peak }]);
  }, 30_000);
});

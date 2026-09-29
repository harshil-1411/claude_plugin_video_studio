import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashFile } from "@video-studio/core";
import { measurePeakOffset, mixSceneAudio, runFfmpeg } from "@video-studio/media";
import type { Scene, SceneVoiceTrack } from "@video-studio/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ResolvedMusic } from "./music.js";
import { type FootageResolution, beatSyncDurations, bedTimeline, buildSceneAudio, sfxPeakMs, transcriptWords } from "./pipeline-media.js";
import { findSfxDir, loadSfxCatalog } from "./sfx.js";

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

describe("bundled sound effects in the scene audio plan", () => {
  const noFootage: FootageResolution = { byScene: new Map(), assets: new Map(), used: [] };
  const plan = (sfx: unknown[], sfxDir?: string | null) =>
    buildSceneAudio(
      join(tmp, "bundled-proj"),
      [{ ...scene("s01", 1), sfx } as Scene],
      [{ scene_start_ms: 0, track: track("s01") }],
      [1000],
      noFootage,
      new Map(),
      [],
      { cacheDir: join(tmp, "cache"), ...(sfxDir !== undefined ? { sfxDir } : {}) },
    );

  it("resolves bundled:<id> to the plugin catalogue with its default level and CC0 licence", async () => {
    const dir = findSfxDir({});
    const catalog = loadSfxCatalog(dir)!;
    const pop = catalog.sounds.find((x) => x.id === "pop")!;
    const p = await plan([{ file: "bundled:pop", at_sec: 0.5 }, { file: "bundled:pop", at_sec: 0.8, volume_db: -6, license: { id: "user-owned" } }]);
    expect(p.sfx[0]).toMatchObject({ path: join(dir!, "pop.wav"), volume_db: pop.default_db });
    // An explicit volume wins; a licence in the spec cannot relabel a bundled sound.
    expect(p.sfx[1]!.volume_db).toBe(-6);
    expect(p.sfxState).toEqual([{ file: "bundled:pop", sha256: pop.sha256, scenes: ["s01"], license: catalog.license, peak_ms: expect.any(Number) }]);
    expect(p.sfxState[0]!.license).toEqual({ id: "CC0-1.0", source: expect.stringMatching(/synthesized by video-studio/) });
    // The key follows the effective level.
    const q = await plan([{ file: "bundled:pop", at_sec: 0.5, volume_db: -3 }]);
    expect(JSON.stringify(q.key)).not.toBe(JSON.stringify((await plan([{ file: "bundled:pop", at_sec: 0.5 }])).key));
  });

  it("names the available ids for an unknown one, and says when there is no catalogue", async () => {
    await expect(plan([{ file: "bundled:airhorn", at_sec: 0 }])).rejects.toThrow(/s01: sfx file "bundled:airhorn" is not a bundled sound; use one of bundled:whoosh-soft, .*bundled:pop/);
    await expect(plan([{ file: "bundled:pop", at_sec: 0 }], null)).rejects.toThrow(/no sfx\/ catalogue found/);
  });
});

describe("footage av_offset_ms", () => {
  /** 2 s at 15 fps: a white flash frame and a click at 1.0 s, nothing else. */
  let clip: string;
  let footage: FootageResolution;
  const FRAME_MS = 1000 / 15;
  beforeAll(async () => {
    clip = join(tmp, "flash-click.mp4");
    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", "color=c=black:s=160x90:r=15:d=2,drawbox=c=white:t=fill:enable='eq(n\\,15)'",
      "-f", "lavfi", "-i", "aevalsrc=if(between(t\\,1\\,1.01)\\,0.9*sin(2*PI*2000*t)\\,0):s=48000:d=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-shortest", clip.replace(/\.mp4$/, ".mov"),
    ]);
    clip = clip.replace(/\.mp4$/, ".mov");
    const media = { duration_sec: 2, width: 160, height: 90, fps: 15, has_video: true, has_audio: true };
    footage = {
      byScene: new Map([["s01", { path: clip, sha256: "a".repeat(64), media }]]),
      assets: new Map([["v1", { id: "v1", kind: "video", rel: "flash-click.mov", abs: clip, sha256: "a".repeat(64), media }]]),
      used: [],
    };
  });

  async function clickAt(av_offset_ms?: number): Promise<{ ms: number; key: string }> {
    const s = { ...scene("s01", 2), footage: { asset: "v1", in_sec: 0, ...(av_offset_ms !== undefined ? { av_offset_ms } : {}) } } as unknown as Scene;
    const p = await buildSceneAudio(tmp, [s], [{ scene_start_ms: 0, track: track("s01") }], [2000], footage, new Map(), []);
    const out = join(tmp, `mix-${av_offset_ms ?? 0}.wav`);
    await mixSceneAudio(p.slots, out);
    return { ms: await measurePeakOffset(out), key: JSON.stringify(p.key) };
  }

  it("moves the clip's sound against its picture and keeps the scene length", async () => {
    const base = await clickAt();
    expect(Math.abs(base.ms - 1005)).toBeLessThanOrEqual(FRAME_MS);
    const late = await clickAt(200);
    expect(Math.abs(late.ms - base.ms - 200)).toBeLessThanOrEqual(FRAME_MS);
    const early = await clickAt(-200);
    expect(Math.abs(base.ms - early.ms - 200)).toBeLessThanOrEqual(FRAME_MS);
    // Edits re-render: the offset is part of the mix key.
    expect(new Set([base.key, late.key, early.key]).size).toBe(3);
  }, 60_000);

  it("shifts the transcript words with the sound", async () => {
    const root = join(tmp, "tw");
    await mkdir(root, { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, "t.json"), JSON.stringify([{ word: "hi", start_ms: 1000, end_ms: 1200 }, { word: "early", start_ms: 100, end_ms: 150 }]));
    const asset = { ...footage.assets.get("v1")!, transcript: "t.json" };
    const words = (off: number) => transcriptWords(root, asset, { asset: "v1", in_sec: 0, av_offset_ms: off }, 2000, []);
    expect((await words(200)).map((w) => [w.word, w.start_ms])).toEqual([["hi", 1200], ["early", 300]]);
    // Advanced 200 ms: the first 200 ms of the source's sound are never heard.
    expect((await words(-200)).map((w) => [w.word, w.start_ms])).toEqual([["hi", 800]]);
  });
});

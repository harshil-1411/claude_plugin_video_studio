import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg } from "@video-studio/media";
import type { Scene } from "@video-studio/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ResolvedMusic } from "./music.js";
import { revealItemTexts } from "@video-studio/renderer";
import { beatRevealCues, sceneAudioEnvelopes } from "./pipeline-stages.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-reveals-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const scene = (id: string, duration: number, det: Scene["deterministic"], extra: Partial<Scene> = {}): Scene => ({
  id,
  duration_sec: duration,
  purpose: "point",
  voiceover: "",
  visual_strategy: "motion_graphic",
  deterministic: det,
  visual_requirements: { continuity_refs: [] },
  claim_refs: [],
  ...extra,
});
const motion = (id: string, duration: number) => scene(id, duration, { kind: "motion", props: { html: "motion/a.html", text: ["a"] } });
const typo = (id: string, duration: number, lines: string[], extra: Partial<Scene> = {}) => scene(id, duration, { kind: "typography", props: { lines } }, extra);

/** 120 BPM on the video timeline, in ms. */
const grid120 = (totalS: number) => Array.from({ length: totalS * 2 }, (_, i) => i * 500);

describe("beatRevealCues", () => {
  const sync = (total: number) => ({ bpm: 120, beats: total * 2, moved_cuts: 0, beat_times_ms: grid120(total), downbeat_times_ms: grid120(total).filter((_, i) => i % 4 === 0) });

  it("places items 1.. of text scenes on the readable beat schedule, as cues (entrance + CUE_LEAD_S)", () => {
    const scenes = [typo("s01", 5, ["One.", "Two.", "Three."]), typo("s02", 4, ["Every render is cached by its scene hash", "Short."])];
    const cues = beatRevealCues(scenes, 30, sync(9), true);
    // s01: every 3rd beat (0, 1.5, 3 s), plus CUE_LEAD_S (0.12 s).
    expect(cues.get("s01")).toEqual([
      { item: 1, at_s: 1.62 },
      { item: 2, at_s: 3.12 },
    ]);
    // s02: an 8-word line needs 2.4 s + entrance; the 4 s scene cannot give the second line its floor after that.
    expect(cues.has("s02")).toBe(false);
  });

  it("only with beat sync on, never for grid-only grids, word-cued scenes, single items or other kinds", () => {
    const lines = ["One.", "Two.", "Three."];
    expect(beatRevealCues([typo("s01", 5, lines)], 30, sync(5), false).size).toBe(0);
    expect(beatRevealCues([typo("s01", 5, lines)], 30, { ...sync(5), grid_only: true }, true).size).toBe(0);
    expect(beatRevealCues([typo("s01", 5, lines, { cues: [{ word: "one", item: 0 }] } as Partial<Scene>)], 30, sync(5), true).size).toBe(0);
    expect(beatRevealCues([typo("s01", 5, ["Only."])], 30, sync(5), true).size).toBe(0);
    expect(beatRevealCues([scene("s01", 5, { kind: "cta", props: { headline: "Try it", action: "Install" } })], 30, sync(5), true).size).toBe(0);
    expect(beatRevealCues([typo("s01", 5, lines)], 30, undefined, true).size).toBe(0);
  });

  it("uses each scene's own slot of the timeline", () => {
    const cues = beatRevealCues([motion("s00", 1.3), typo("s01", 5, ["One.", "Two."])], 30, sync(7), true);
    // s01 starts at 1.3 s: its beats are 0.2, 0.7, 1.2, ... scene-local; item 1 needs 1.2 s.
    expect(cues.get("s01")).toEqual([{ item: 1, at_s: 1.32 }]);
  });

  it("revealItemTexts: the on-screen words of beat-reveal kinds only", () => {
    expect(revealItemTexts(typo("s", 1, ["a", "b"]))).toEqual(["a", "b"]);
    expect(revealItemTexts(scene("s", 1, { kind: "chart", props: { type: "stat", value: 3 } }))).toBeUndefined();
    expect(revealItemTexts(scene("s", 1, { kind: "chart", props: { type: "bar", series: [{ label: "A", value: 1 }, { label: "B", value: 2 }] } }))).toEqual(["A", "B"]);
    expect(revealItemTexts(motion("s", 1))).toBeUndefined();
  });
});

describe("sceneAudioEnvelopes", () => {
  it("slices the bed's envelope into each motion scene (start offset), nothing for other kinds or without a bed", async () => {
    const wav = join(tmp, "bed.wav");
    // Loud for the first second, silent after.
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "aevalsrc=if(lt(t\\,1)\\,0.5*sin(2*PI*60*t)\\,0):s=48000:d=4", "-c:a", "pcm_s16le", wav]);
    const music = { ref: "music/bed.wav", path: wav, sha256: "bed", bed: { file: "music/bed.wav", start_sec: 0.5, loop: false } } as unknown as ResolvedMusic;
    const scenes = [typo("s01", 0.25, ["a"]), motion("s02", 0.5), motion("s03", 1)];
    const env = await sceneAudioEnvelopes(scenes, 10, music, { cacheDir: join(tmp, "cache") });
    expect([...env.keys()]).toEqual(["s02", "s03"]);
    const rms = (id: string) => [...Buffer.from(env.get(id)!.rms, "base64")];
    // s02 covers video 0.3..0.8 s = file 0.8..1.3 s: loud, then silent.
    expect(rms("s02").length).toBe(5);
    expect(rms("s02").slice(0, 2).every((v) => v > 200)).toBe(true);
    expect(rms("s02").slice(3)).toEqual([0, 0]);
    expect(rms("s03")).toEqual(Array(10).fill(0));
    expect(env.get("s02")!.fps).toBe(10);
    expect((await sceneAudioEnvelopes(scenes, 10, undefined)).size).toBe(0);
    expect((await sceneAudioEnvelopes([typo("s01", 1, ["a"])], 10, music)).size).toBe(0);
  }, 30_000);
});

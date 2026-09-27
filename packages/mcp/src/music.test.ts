import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashFile } from "@video-studio/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveMusic } from "./music.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-music-resolve-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("resolveMusic synth:<preset>", () => {
  it("synthesizes into the cache with the exact grid and a CC0 licence, and reuses the file", async () => {
    const cacheDir = join(tmp, "score");
    const bed = { file: "synth:pulse", synth: { bpm: 120, progression: ["i" as const, "VI" as const], drop_bar: 2 } };
    const m = await resolveMusic(bed, tmp, {}, { durationSec: 3, cacheDir });
    // Whole chord cycles: 2 bars at 120 bpm = 4 s covers 3 s.
    expect(m.grid).toEqual({ bpm: 120, beats_ms: [0, 500, 1000, 1500, 2000, 2500, 3000, 3500], downbeats_ms: [0, 2000], duration_ms: 4000 });
    expect(m.license).toEqual({ id: "CC0-1.0", source: "synthesized locally by video-studio" });
    expect(m.title).toBe("Synth pulse (120 bpm)");
    expect(m.ref).toBe("synth:pulse");
    expect(m.path.startsWith(cacheDir)).toBe(true);
    expect(m.sha256).toBe(await hashFile(m.path));
    const before = (await stat(m.path)).mtimeMs;
    const again = await resolveMusic(bed, tmp, {}, { durationSec: 3.5, cacheDir });
    expect(again.path).toBe(m.path);
    expect((await stat(again.path)).mtimeMs).toBe(before);
    // Different parameters → a different cached score.
    const other = await resolveMusic({ ...bed, synth: { ...bed.synth, seed: 7 } }, tmp, {}, { durationSec: 3, cacheDir });
    expect(other.path).not.toBe(m.path);
  }, 30_000);

  it("names the presets for an unknown one, and rejects synth without a synth: file", async () => {
    await expect(resolveMusic({ file: "synth:dubstep" }, tmp, {}, { cacheDir: tmp })).rejects.toThrow(
      /audio.music.file "synth:dubstep": unknown synth preset "dubstep"; use one of synth:pulse, synth:lofi, synth:ambient, synth:drive/,
    );
    await expect(resolveMusic({ file: "assets/bed.wav", synth: { bpm: 90 } }, tmp, {})).rejects.toThrow(/audio.music.synth only applies to a synthesized score/);
  });
});

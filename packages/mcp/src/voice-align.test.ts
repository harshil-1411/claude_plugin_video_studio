import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SceneVoiceTrack } from "@video-studio/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alignVoiceTracks, alignWords } from "./voice-align.js";

const est = (text: string, dur: number) => {
  const w = text.split(" ");
  return w.map((word, i) => ({ word, start_ms: Math.round((i * dur) / w.length), end_ms: Math.round(((i + 1) * dur) / w.length) }));
};

describe("alignWords", () => {
  it("takes whisper's times for matched words, case and punctuation aside", () => {
    const expected = est("Builds got 40% faster.", 2000);
    const heard = [
      { word: "builds", start_ms: 100, end_ms: 400 },
      { word: "got", start_ms: 450, end_ms: 600 },
      { word: "40", start_ms: 900, end_ms: 1100 },
      { word: "percent", start_ms: 1100, end_ms: 1400 },
      { word: "faster", start_ms: 1500, end_ms: 1900 },
    ];
    const r = alignWords(expected, heard, 2000);
    expect(r.words.map((w) => w.start_ms)).toEqual([100, 450, expect.any(Number), 1500]);
    // "40%" is heard as two words: it sits between its neighbours.
    expect(r.words[2]!.start_ms).toBeGreaterThanOrEqual(600);
    expect(r.words[2]!.end_ms).toBeLessThanOrEqual(1500);
    expect(r.matched).toBe(3);
    expect(r.words.map((w) => w.word)).toEqual(["Builds", "got", "40%", "faster."]);
  });

  it("tolerates one-letter spelling differences and keeps order", () => {
    const r = alignWords(est("Kubernetes clusters scale", 1500), [
      { word: "Kubernetis", start_ms: 200, end_ms: 700 },
      { word: "cluster", start_ms: 800, end_ms: 1000 },
      { word: "scale", start_ms: 1100, end_ms: 1400 },
    ], 1500);
    expect(r.matched).toBe(3);
    expect(r.words.map((w) => w.start_ms)).toEqual([200, 800, 1100]);
  });

  it("stays monotonic and inside the scene with extra or missing words", () => {
    const r = alignWords(est("one two three four five", 1000), [
      { word: "um", start_ms: 0, end_ms: 100 },
      { word: "two", start_ms: 300, end_ms: 400 },
      { word: "four", start_ms: 700, end_ms: 800 },
    ], 1000);
    const s = r.words.map((w) => w.start_ms);
    expect([...s].sort((a, b) => a - b)).toEqual(s);
    expect(Math.max(...r.words.map((w) => w.end_ms))).toBeLessThanOrEqual(1000);
    expect(r.words[1]!.start_ms).toBe(300);
    expect(r.words[3]!.start_ms).toBe(700);
  });
});

describe("alignVoiceTracks", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "vs-align-"));
    await mkdir(join(root, "assets", "voice"), { recursive: true });
    await writeFile(join(root, "assets", "voice", "s01.wav"), "fake audio");
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  const track = (): SceneVoiceTrack => ({ scene_id: "s01", audio_path: "assets/voice/s01.wav", duration_ms: 1500, words: est("ask not what", 1500), timing_source: "estimated", provider: "system-say" });

  it("re-times estimated tracks, caches, and leaves others alone", async () => {
    let calls = 0;
    const transcribe = async () => {
      calls++;
      return [
        { word: "Ask", start_ms: 600, end_ms: 800 },
        { word: "not", start_ms: 900, end_ms: 1100 },
        { word: "what", start_ms: 1200, end_ms: 1400 },
      ];
    };
    const provider: SceneVoiceTrack = { ...track(), scene_id: "s02", timing_source: "provider" };
    const o = { root, cacheDir: join(root, "cache"), whisperBin: "/bin/whisper", model: "/m/ggml-base.en.bin", transcribe };
    const r = await alignVoiceTracks([track(), provider], o);
    expect(r.aligned).toEqual(["s01"]);
    expect(r.tracks[0]).toMatchObject({ timing_source: "aligned", words: [{ start_ms: 600 }, { start_ms: 900 }, { start_ms: 1200 }] });
    expect(r.tracks[1]).toBe(provider);
    await alignVoiceTracks([track()], o);
    expect(calls).toBe(1);
  });

  it("keeps estimates when whisper hears something else, or is missing", async () => {
    const o = { root, cacheDir: join(root, "cache2"), whisperBin: "/bin/whisper", model: "/m/ggml-base.en.bin", transcribe: async () => [{ word: "music", start_ms: 0, end_ms: 500 }] };
    const r = await alignVoiceTracks([track()], o);
    expect(r.aligned).toEqual([]);
    expect(r.tracks[0]!.timing_source).toBe("estimated");
    expect(r.warnings[0]).toMatch(/matched only 0 of 3 words/);
    const none = await alignVoiceTracks([track()], { root, cacheDir: join(root, "c3"), env: { PATH: "" } });
    expect(none.skipped).toMatch(/whisper.cpp is not installed/);
  });
});

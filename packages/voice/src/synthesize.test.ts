import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SceneVoiceTrack, VideoSpec } from "@video-studio/schema";
import { estimateWordTimings, tokenize } from "./estimate.js";
import { createSilentBackend } from "./silent.js";
import { selectBackend, synthesizeSpec, VoiceBackendUnavailableError, type BackendSet } from "./synthesize.js";
import type { Availability, VoiceBackend } from "./types.js";

const exampleSpec = JSON.parse(
  await readFile(fileURLToPath(new URL("../../schema/examples/explain-vector-db.video-spec.json", import.meta.url)), "utf8"),
) as VideoSpec;

function spec(scenes: Array<{ id: string; duration_sec: number; voiceover: string }>): VideoSpec {
  const base = exampleSpec.scenes[0]!;
  return { ...exampleSpec, scenes: scenes.map((s) => ({ ...base, ...s })) };
}

/** Fake audio backend: writes a WAV-ish file and returns `msPerWord` per speech token. */
function fakeBackend(id: string, avail: Availability, msPerWord = 400) {
  const calls: string[] = [];
  const backend: VoiceBackend = {
    id,
    available: () => avail,
    resolveVoice: async (v) => v ?? "fake-voice",
    cacheOptions: () => ({ rate: 180 }),
    synthesize: async (input, ctx) => {
      calls.push(input.text);
      const words = tokenize(input.text);
      const duration_ms = words.length * msPerWord;
      const file = join(ctx.outDir, `${input.scene_id}.wav`);
      await writeFile(file, `RIFF:${input.text}`);
      return {
        scene_id: input.scene_id,
        audio_path: file,
        duration_ms,
        words: estimateWordTimings(words, duration_ms),
        timing_source: "estimated",
        voice: input.voice,
        provider: `fake-${id}`,
      } satisfies SceneVoiceTrack;
    },
  };
  return { backend, calls };
}

function set(opts: { eleven: boolean; system: boolean }): BackendSet {
  return {
    elevenlabs: fakeBackend("elevenlabs", opts.eleven ? { ok: true, reason: "key set" } : { ok: false, reason: "ELEVENLABS_API_KEY not set" }).backend,
    system: fakeBackend("system", opts.system ? { ok: true } : { ok: false, reason: "say not found" }).backend,
    silent: createSilentBackend(),
  };
}

describe("selectBackend", () => {
  it.each([
    [true, true, "elevenlabs"],
    [true, false, "elevenlabs"],
    [false, true, "system"],
    [false, false, "silent"],
  ])("auto with eleven=%s system=%s → %s", async (eleven, system, expected) => {
    const sel = await selectBackend("auto", {}, set({ eleven, system }));
    expect(sel.backend.id).toBe(expected);
    expect(sel.reason).toMatch(/^auto:/);
    if (!eleven) expect(sel.reason).toContain("ELEVENLABS_API_KEY not set");
  });

  it("honours explicit choices and rejects unavailable ones", async () => {
    const backends = set({ eleven: false, system: true });
    expect((await selectBackend("system", {}, backends)).backend.id).toBe("system");
    expect((await selectBackend("silent", {}, backends)).backend.id).toBe("silent");
    await expect(selectBackend("elevenlabs", {}, backends)).rejects.toBeInstanceOf(VoiceBackendUnavailableError);
  });
});

let root: string;
let projectDir: string;
let cacheDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vs-voice-spec-test-"));
  projectDir = join(root, "proj");
  cacheDir = join(root, "cache");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("synthesizeSpec", () => {
  const scenes = [
    { id: "s01", duration_sec: 3, voiceover: "Ship CI/CD every day." },
    { id: "s02", duration_sec: 2, voiceover: "" },
    { id: "s03", duration_sec: 1, voiceover: "This line is much too long for one second." },
  ];
  const brand = { language: { locale: "en-US", terminology: { "CI/CD": "C I C D" } } };

  it("writes wavs + voice-tracks.json, keeps caption words, reports overruns, caches re-runs", async () => {
    const { backend, calls } = fakeBackend("system", { ok: true });
    const backends = { system: backend };
    const s = spec(scenes);
    const res = await synthesizeSpec(s, { projectDir, backend: "system", brand, env: {}, cacheDir, backends });

    expect(res.backend).toBe("system");
    expect(res.tracks_path).toBe("assets/voice/voice-tracks.json");
    expect(calls).toEqual(["Ship C I C D every day.", "This line is much too long for one second."]);
    const [t1, t2, t3] = res.tracks;
    expect(t1!.audio_path).toBe("assets/voice/s01.wav");
    expect(t1!.words.map((w) => w.word)).toEqual(["Ship", "CI/CD", "every", "day."]);
    expect(t1!.duration_ms).toBe(7 * 400);
    expect(t2).toEqual({ scene_id: "s02", duration_ms: 2000, words: [], timing_source: "none", provider: "silent" });
    expect(await readFile(join(projectDir, "assets/voice/s01.wav"), "utf8")).toBe("RIFF:Ship C I C D every day.");
    const written = JSON.parse(await readFile(join(projectDir, "assets/voice/voice-tracks.json"), "utf8"));
    expect(written).toEqual(res.tracks);

    // s03: 9 words × 400 ms = 3.6 s > 1 s → suggest 3.9 s. s01 (2.8 s ≤ 3 s) fits.
    expect(res.overruns).toEqual([{ scene_id: "s03", scene_duration_sec: 1, audio_duration_sec: 3.6, suggested_duration_sec: 3.9 }]);
    expect(t3!.audio_path).toBe("assets/voice/s03.wav");
    expect(s.scenes[2]!.duration_sec).toBe(1); // spec untouched
    expect(res.cache_hits).toEqual([]);

    // Re-run: nothing synthesized, same output.
    await rm(join(projectDir, "assets"), { recursive: true, force: true });
    const again = await synthesizeSpec(s, { projectDir, backend: "system", brand, env: {}, cacheDir, backends });
    expect(calls).toHaveLength(2);
    expect(again.cache_hits).toEqual(["s01", "s03"]);
    expect(again.tracks).toEqual(res.tracks);
    expect(again.overruns).toEqual(res.overruns);
    expect((await stat(join(projectDir, "assets/voice/s01.wav"))).size).toBeGreaterThan(0);

    // Changing the text (or voice) misses the cache.
    const changed = spec([{ id: "s01", duration_sec: 3, voiceover: "Ship CI/CD every week." }]);
    await synthesizeSpec(changed, { projectDir, backend: "system", brand, env: {}, cacheDir, backends });
    expect(calls).toHaveLength(3);
  });

  it("silent mode times words evenly across each scene with no audio", async () => {
    const res = await synthesizeSpec(spec(scenes), { projectDir, backend: "silent", env: {}, cacheDir });
    expect(res.backend).toBe("silent");
    const t1 = res.tracks[0]!;
    expect(t1.audio_path).toBeUndefined();
    expect(t1.timing_source).toBe("none");
    expect(t1.duration_ms).toBe(3000);
    expect(t1.words.map((w) => [w.start_ms, w.end_ms])).toEqual([
      [0, 750],
      [750, 1500],
      [1500, 2250],
      [2250, 3000],
    ]);
    expect(res.overruns).toEqual([]);
  });

  it("auto falls back to silent and explains why", async () => {
    const res = await synthesizeSpec(spec(scenes.slice(0, 1)), {
      projectDir,
      backend: "auto",
      env: {},
      cacheDir,
      backends: set({ eleven: false, system: false }),
    });
    expect(res.backend).toBe("silent");
    expect(res.reason).toMatch(/say not found.*silent/);
  });
});

describe("synthesizeSpec language", () => {
  it("passes the spec language to voice resolution and synthesis", async () => {
    const seen: Array<string | undefined> = [];
    const { backend } = fakeBackend("system", { ok: true });
    const withLang: VoiceBackend = {
      ...backend,
      resolveVoice: async (v, _env, language) => (seen.push(`resolve:${language}`), v ?? "fake-voice"),
      synthesize: async (input, ctx) => (seen.push(`synth:${input.language}`), backend.synthesize(input, ctx)),
    };
    const project = await mkdtemp(join(tmpdir(), "vs-voice-lang-"));
    try {
      const s = { ...spec([{ id: "s01", duration_sec: 3, voiceover: "意味で検索します。" }]), language: "ja" };
      const res = await synthesizeSpec(s, { projectDir: project, backend: "system", cacheDir: join(project, "cache"), backends: { ...set({ eleven: false, system: true }), system: withLang }, env: {} });
      expect(seen).toEqual(["resolve:ja", "synth:ja"]);
      expect(res.tracks[0]!.words.map((w) => w.word)).toEqual(["意", "味", "で", "検", "索", "し", "ま", "す。"]);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

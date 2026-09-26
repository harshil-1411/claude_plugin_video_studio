import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ingest } from "@video-studio/ingestion";
import { ContentIR } from "@video-studio/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  WHISPER_MODEL,
  WHISPER_MODELS,
  type WhisperModelName,
  applyTranscript,
  downloadWhisperModel,
  languageWarnings,
  planWhisperModel,
  resolveWhisperModel,
  selectWhisperModel,
  transcribeAsset,
} from "./transcribe.js";

let dir: string;
let project: string;
let videoId: string;

const SRT = `1
00:00:00,200 --> 00:00:01,800
We cut costs by 40% last year.

2
00:00:02,500 --> 00:00:04,000
Why does that matter?

3
00:00:04,200 --> 00:00:05,600
Because speed wins.
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vs-transcribe-"));
  const video = join(dir, "talk.mp4");
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=160x120:rate=15:duration=6",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video,
  ]);
  project = join(dir, "proj");
  const { ir } = await ingest([video], { projectDir: project, noCache: true });
  videoId = ir.assets.find((a) => a.kind === "video")!.id;
  await writeFile(join(project, "talk.srt"), SRT);
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const readIr = async () => ContentIR.parse(JSON.parse(await readFile(join(project, "source", "content-ir.json"), "utf8")));

describe("transcribeAsset with a caption file", () => {
  it("writes timed words, evidence spans with time refs, a section and media.transcript", async () => {
    const r = await transcribeAsset(project, videoId, { captions_file: "talk.srt", env: {} });
    expect(r).toMatchObject({ asset: videoId, source: "srt", words: 14, path: `source/transcripts/${videoId}.json`, sentences: 3 });
    expect(r.evidence_refs).toEqual(["video:talk.mp4#t=0.2-1.8", "video:talk.mp4#t=2.5-4.0", "video:talk.mp4#t=4.2-5.6"]);
    const words = JSON.parse(await readFile(join(project, r.path), "utf8"));
    expect(words[0]).toEqual({ word: "We", start_ms: 200, end_ms: 429 });

    const ir = await readIr();
    const asset = ir.assets.find((a) => a.id === videoId)!;
    expect(asset.media!.transcript).toEqual({ path: r.path, source: "srt", words: 14 });
    const ev = ir.evidence.find((e) => e.ref === "video:talk.mp4#t=2.5-4.0")!;
    expect(ev).toMatchObject({ text: "Why does that matter?", locator: { time_start_sec: 2.5, time_end_sec: 4 } });
    expect(ir.sections.find((s) => s.heading === `Transcript (${videoId})`)!.text).toBe("We cut costs by 40% last year. Why does that matter? Because speed wins.");
    expect(ir.claims.some((c) => c.text.includes("40%") && c.evidence_refs[0] === "video:talk.mp4#t=0.2-1.8")).toBe(true);
  });

  it("replaces the previous transcript when run again", async () => {
    await transcribeAsset(project, videoId, { captions_file: "talk.srt", env: {} });
    const ir = await readIr();
    expect(ir.evidence.filter((e) => e.ref.startsWith("video:talk.mp4#t="))).toHaveLength(3);
    expect(ir.sections.filter((s) => s.heading?.startsWith("Transcript"))).toHaveLength(1);
    expect(ir.claims.filter((c) => c.text.includes("40%"))).toHaveLength(1);
  });

  it("rejects unknown assets and non-caption files", async () => {
    await expect(transcribeAsset(project, "asset-99", { captions_file: "talk.srt", env: {} })).rejects.toThrow(/not a video or audio asset[\s\S]*use one of/);
    await expect(transcribeAsset(project, videoId, { captions_file: "notes.txt", env: {} })).rejects.toThrow(/\.srt or \.vtt/);
    // Caption files come from inside the project only.
    await writeFile(join(dir, "outside.srt"), SRT);
    await expect(transcribeAsset(project, videoId, { captions_file: join(dir, "outside.srt"), env: {} })).rejects.toThrow(/inside the project/);
    await expect(transcribeAsset(project, videoId, { captions_file: "../outside.srt", env: {} })).rejects.toThrow(/inside the project/);
  });
});

describe("whisper model consent", () => {
  it("refuses to run without a model and without consent, naming size, URL and the ask", async () => {
    const env = { CLAUDE_PLUGIN_DATA: join(dir, "data-none") };
    expect(resolveWhisperModel(env)).toMatchObject({ exists: false, from: "data_dir", path: join(dir, "data-none", "models", "ggml-base.en.bin") });
    const err = await transcribeAsset(project, videoId, { env }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toMatch(/~148 MB/);
    expect(String((err as Error).message)).toContain(WHISPER_MODEL.url);
    expect(String((err as Error).message)).toMatch(/ask the user[\s\S]*download_model: true/);
    expect(existsSync(join(dir, "data-none", "models"))).toBe(false);
  });

  it("downloads with an injected fetch: temp file → sha256 check → rename, recorded next to the model", async () => {
    const bytes = new TextEncoder().encode("fake ggml model bytes");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      return new Response(bytes, { status: 200 });
    };
    const dest = join(dir, "dl", "models", "ggml-base.en.bin");
    const r = await downloadWhisperModel(dest, { fetch, expectedSha256: sha });
    expect(calls).toEqual([WHISPER_MODEL.url]);
    expect(r).toEqual({ path: dest, sha256: sha, bytes: bytes.length });
    expect(await readFile(dest, "utf8")).toBe("fake ggml model bytes");
    expect(JSON.parse(await readFile(`${dest}.json`, "utf8"))).toMatchObject({ url: WHISPER_MODEL.url, sha256: sha, bytes: bytes.length });

    const bad = join(dir, "dl2", "ggml-base.en.bin");
    await expect(downloadWhisperModel(bad, { fetch })).rejects.toThrow(/sha256/);
    expect(existsSync(bad)).toBe(false);
    await expect(downloadWhisperModel(bad, { fetch: async () => new Response("no", { status: 404 }) })).rejects.toThrow(/HTTP 404/);
  });

  it("with download_model: true downloads into the data dir, then runs whisper-cli", async () => {
    const env = { CLAUDE_PLUGIN_DATA: join(dir, "data-dl") };
    const bytes = new Uint8Array([1, 2, 3]);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const err = await transcribeAsset(project, videoId, {
      env,
      download_model: true,
      fetch: async () => new Response(bytes),
      modelSha256: sha,
      whisperBin: join(dir, "no-such-whisper-cli"),
    }).catch((e: Error) => e);
    expect(existsSync(join(dir, "data-dl", "models", "ggml-base.en.bin"))).toBe(true);
    expect((err as Error).message).toMatch(/not found: install whisper\.cpp/);
  });
});

const MODEL = process.env.VS_TEST_WHISPER_MODEL;
describe.skipIf(!MODEL || !existsSync(MODEL))("transcribeAsset with whisper.cpp (VS_TEST_WHISPER_MODEL)", () => {
  it("transcribes an ingested audio file", async () => {
    const wav = process.env.VS_TEST_WHISPER_AUDIO ?? join(dirname(MODEL!), "jfk.wav");
    const p = join(dir, "jfk-proj");
    const { ir } = await ingest([wav], { projectDir: p, noCache: true });
    const id = ir.assets[0]!.id;
    const r = await transcribeAsset(p, id, { env: { VS_WHISPER_MODEL: MODEL } });
    expect(r.source).toBe("whisper");
    expect(r.model).toBe("ggml-base.en");
    expect(r.text.toLowerCase()).toContain("country");
    expect(r.evidence_refs[0]).toMatch(/^audio:jfk\.wav#t=\d+\.\d-\d+\.\d$/);
    const after = ContentIR.parse(JSON.parse(await readFile(join(p, "source", "content-ir.json"), "utf8")));
    expect(after.assets[0]!.media!.transcript).toMatchObject({ source: "whisper", model: "ggml-base.en", language: "en" });
  }, 120_000);
});

describe("whisper model selection", () => {
  const none = () => false;
  const only = (...names: WhisperModelName[]) => (n: WhisperModelName) => names.includes(n);
  const pick = (o: Parameters<typeof selectWhisperModel>[0]) => {
    const r = selectWhisperModel(o);
    return [r.name, r.language];
  };

  it("defaults to base.en, then an already-downloaded base, then base.en to download", () => {
    expect(pick({ has: only("base.en", "base") })).toEqual(["base.en", undefined]);
    expect(pick({ has: only("base") })).toEqual(["base", "auto"]);
    expect(pick({ has: none })).toEqual(["base.en", undefined]);
    expect(pick({ language: "en-US", has: only("base.en") })).toEqual(["base.en", "en"]);
  });

  it("uses the multilingual model for other languages, auto, or a non-English spec", () => {
    expect(pick({ language: "es", has: only("base.en") })).toEqual(["base", "es"]);
    expect(pick({ language: "hi-IN", has: none })).toEqual(["base", "hi"]);
    expect(pick({ language: "AUTO", has: only("base.en") })).toEqual(["base", "auto"]);
    expect(pick({ specLanguage: "es-ES", has: only("base.en") })).toEqual(["base", "auto"]);
    expect(pick({ specLanguage: "en-GB", has: only("base.en") })).toEqual(["base.en", undefined]);
  });

  it("uses tinydiarize for speakers, English only", () => {
    expect(pick({ speakers: true, has: none })).toEqual(["small.en-tdrz", "en"]);
    expect(pick({ speakers: true, language: "en", has: none })).toEqual(["small.en-tdrz", "en"]);
    expect(() => selectWhisperModel({ speakers: true, language: "es", has: none })).toThrow(/speaker turns work only for English \(tinydiarize\)/);
  });

  it("checks an explicit model against language and speakers", () => {
    expect(pick({ model: "base", has: none })).toEqual(["base", undefined]);
    expect(() => selectWhisperModel({ model: "base.en", language: "es", has: none })).toThrow(/English-only[\s\S]*model "base"/);
    expect(() => selectWhisperModel({ model: "base", speakers: true, has: none })).toThrow(/small\.en-tdrz/);
    expect(() => selectWhisperModel({ language: "español", has: none })).toThrow(/ISO 639-1/);
  });

  it("resolves each model to its own file; VS_WHISPER_MODEL overrides the default only", async () => {
    const data = join(dir, "data-sel");
    const env = { CLAUDE_PLUGIN_DATA: data, VS_WHISPER_MODEL: join(dir, "custom.en.bin") };
    expect(resolveWhisperModel(env).from).toBe("VS_WHISPER_MODEL");
    expect(resolveWhisperModel(env, "base")).toMatchObject({ from: "data_dir", path: join(data, "models", "ggml-base.bin"), info: WHISPER_MODELS.base });
    expect(resolveWhisperModel(env, "small.en-tdrz").path).toBe(join(data, "models", "ggml-small.en-tdrz.bin"));
    // An English-only override serves English; a Spanish request falls through to the registry.
    expect((await planWhisperModel(project, {}, env)).model.from).toBe("VS_WHISPER_MODEL");
    expect((await planWhisperModel(project, { language: "es" }, env)).model).toMatchObject({ from: "data_dir", info: WHISPER_MODELS.base });
    expect((await planWhisperModel(project, { speakers: true }, env)).model.info).toBe(WHISPER_MODELS["small.en-tdrz"]);
    // A multilingual override is used for any language.
    const multi = { CLAUDE_PLUGIN_DATA: data, VS_WHISPER_MODEL: join(dir, "custom-multi.bin") };
    expect((await planWhisperModel(project, { language: "es" }, multi)).selection).toMatchObject({ language: "es", reason: "VS_WHISPER_MODEL" });
  });

  it("asks for the chosen model's download, naming its size and URL", async () => {
    const env = { CLAUDE_PLUGIN_DATA: join(dir, "data-none") };
    const es = (await transcribeAsset(project, videoId, { env, language: "es" }).catch((e: Error) => e)) as Error;
    expect(es.message).toContain(WHISPER_MODELS.base.url);
    expect(es.message).toMatch(/ggml-base\.bin \(~148 MB\)/);
    const sp = (await transcribeAsset(project, videoId, { env, speakers: true }).catch((e: Error) => e)) as Error;
    expect(sp.message).toContain(WHISPER_MODELS["small.en-tdrz"].url);
    expect(sp.message).toMatch(/~488 MB/);
  });

  it("downloads the chosen model from its own URL", async () => {
    const env = { CLAUDE_PLUGIN_DATA: join(dir, "data-dl-base") };
    const bytes = new Uint8Array([4, 5, 6]);
    const calls: string[] = [];
    await transcribeAsset(project, videoId, {
      env,
      language: "es",
      download_model: true,
      fetch: async (url: string) => {
        calls.push(url);
        return new Response(bytes);
      },
      modelSha256: createHash("sha256").update(bytes).digest("hex"),
      whisperBin: join(dir, "no-such-whisper-cli"),
    }).catch(() => undefined);
    expect(calls).toEqual([WHISPER_MODELS.base.url]);
    expect(existsSync(join(dir, "data-dl-base", "models", "ggml-base.bin"))).toBe(true);
  });

  it("warns on a language mismatch with the spec", () => {
    expect(languageWarnings({ specLanguage: "es-ES", detected: "en", englishOnly: true })[0]).toMatch(/English-only[\s\S]*model: "base"/);
    expect(languageWarnings({ specLanguage: "es-ES", detected: "en", englishOnly: false })[0]).toMatch(/detected "en"[\s\S]*"es-ES"/);
    expect(languageWarnings({ specLanguage: "es-ES", detected: "es", englishOnly: false })).toEqual([]);
    expect(languageWarnings({ specLanguage: "en-US", detected: "en", englishOnly: true })).toEqual([]);
    expect(languageWarnings({ detected: "fr", englishOnly: false })).toEqual([]);
  });
});

describe("speaker labels in the ContentIR", () => {
  it("records speakers and prefixes a new speaker's sentences in evidence, with time refs unchanged", async () => {
    const ir = ContentIR.parse(JSON.parse(await readFile(join(project, "source", "content-ir.json"), "utf8")));
    const w = (word: string, s: number, e: number, speaker: string) => ({ word, start_ms: s, end_ms: e, speaker });
    const words = [w("Houston,", 0, 400, "S1"), w("problem.", 400, 900, "S1"), w("Say", 1200, 1400, "S2"), w("again.", 1400, 1800, "S2"), w("Main", 2000, 2200, "S1"), w("bus.", 2200, 2600, "S1"), w("Fine.", 2800, 3000, "S1")];
    const r = applyTranscript(ir, videoId, words, { path: "source/transcripts/x.json", source: "whisper", model: "ggml-small.en-tdrz", language: "en", speakers: true });
    const ev = r.ir.evidence.filter((e) => r.refs.includes(e.ref));
    expect(ev.map((e) => e.text)).toEqual(["S1: Houston, problem.", "S2: Say again.", "S1: Main bus.", "Fine."]);
    expect(r.refs).toEqual(["video:talk.mp4#t=0.0-0.9", "video:talk.mp4#t=1.2-1.8", "video:talk.mp4#t=2.0-2.6", "video:talk.mp4#t=2.8-3.0"]);
    expect(r.ir.assets.find((a) => a.id === videoId)!.media!.transcript).toMatchObject({ speakers: true, language: "en", model: "ggml-small.en-tdrz" });
  });
});

// Real runs through transcribeAsset: VS_TEST_WHISPER_DIR holds the models and test audio.
const WDIR = process.env.VS_TEST_WHISPER_DIR;
const have = (...f: string[]) => !!WDIR && f.every((x) => existsSync(join(WDIR, x)));
describe("transcribeAsset real runs (VS_TEST_WHISPER_DIR)", () => {
  const dataDir = () => join(dir, "data-real");
  beforeAll(async () => {
    if (!WDIR) return;
    await mkdir(join(dataDir(), "models"), { recursive: true });
    for (const f of ["ggml-base.bin", "ggml-small.en-tdrz.bin"]) if (existsSync(join(WDIR, f))) await symlink(join(WDIR, f), join(dataDir(), "models", f));
  });
  const ingestOne = async (file: string) => {
    const p = join(dir, `real-${file}`);
    const { ir } = await ingest([join(WDIR!, file)], { projectDir: p, noCache: true });
    return { p, id: ir.assets[0]!.id };
  };

  it.skipIf(!have("ggml-base.bin", "es20.wav"))("Spanish with language auto: detects es, warns when the spec says English", async () => {
    const { p, id } = await ingestOne("es20.wav");
    await mkdir(join(p, "project"), { recursive: true });
    await writeFile(join(p, "project", "video-spec.json"), JSON.stringify({ language: "en-US" }));
    const r = await transcribeAsset(p, id, { env: { CLAUDE_PLUGIN_DATA: dataDir() }, language: "auto" });
    expect(r).toMatchObject({ model: "ggml-base", language: "es" });
    expect(r.text.toLowerCase()).toMatch(/febrero/);
    expect(r.warnings?.[0]).toMatch(/detected "es"/);
    const after = ContentIR.parse(JSON.parse(await readFile(join(p, "source", "content-ir.json"), "utf8")));
    expect(after.assets[0]!.media!.transcript).toMatchObject({ model: "ggml-base", language: "es", speakers: false });
  }, 180_000);

  it.skipIf(!have("ggml-base.bin", "jfk.wav"))("English with only the multilingual model present", async () => {
    const { p, id } = await ingestOne("jfk.wav");
    const r = await transcribeAsset(p, id, { env: { CLAUDE_PLUGIN_DATA: dataDir() } });
    expect(r).toMatchObject({ model: "ggml-base", language: "en" });
    expect(r.text.toLowerCase()).toContain("country");
  }, 180_000);

  it.skipIf(!have("ggml-small.en-tdrz.bin", "a13.wav"))("speakers: true finds turns in the Apollo 13 dialogue", async () => {
    const { p, id } = await ingestOne("a13.wav");
    const r = await transcribeAsset(p, id, { env: { CLAUDE_PLUGIN_DATA: dataDir() }, speakers: true });
    expect(r).toMatchObject({ model: "ggml-small.en-tdrz", language: "en", speakers: true });
    expect(r.speaker_turns).toBeGreaterThanOrEqual(3);
    const words = JSON.parse(await readFile(join(p, r.path), "utf8")) as Array<{ speaker?: string }>;
    expect(new Set(words.map((w) => w.speaker))).toEqual(new Set(["S1", "S2"]));
    expect(r.text).toMatch(/S2: /);
  }, 300_000);
});

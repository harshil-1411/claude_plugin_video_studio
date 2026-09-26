import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ingest } from "@video-studio/ingestion";
import { ContentIR } from "@video-studio/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WHISPER_MODEL, downloadWhisperModel, resolveWhisperModel, transcribeAsset } from "./transcribe.js";

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

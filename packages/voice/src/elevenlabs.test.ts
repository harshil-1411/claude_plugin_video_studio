import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alignmentToWords, chunkText, createElevenLabsBackend, type WithTimestampsResponse } from "./elevenlabs.js";
import type { CommandRunner, ToolResolver } from "./exec.js";

const fixturePath = fileURLToPath(new URL("./__fixtures__/elevenlabs-with-timestamps.json", import.meta.url));
const KEY = "sk_test_secret_key_123";

function chars(text: string, step = 0.1) {
  const characters = [...text];
  return {
    characters,
    character_start_times_seconds: characters.map((_, i) => +(i * step).toFixed(3)),
    character_end_times_seconds: characters.map((_, i) => +((i + 1) * step).toFixed(3)),
  };
}

describe("alignmentToWords", () => {
  it("groups characters into words with punctuation attached and multiple spaces ignored", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as WithTimestampsResponse;
    const words = alignmentToWords(fixture.alignment!);
    expect(words.map((w) => w.word)).toEqual(["Hello,", "world—", "ship", "CI/CD", "fast!"]);
    // "Hello," ends at the "o", not the comma
    const a = fixture.alignment!;
    expect(words[0]!.start_ms).toBe(Math.round(a.character_start_times_seconds[0]! * 1000));
    expect(words[0]!.end_ms).toBe(Math.round(a.character_end_times_seconds[4]! * 1000));
    let prev = 0;
    for (const w of words) {
      expect(w.start_ms).toBeGreaterThanOrEqual(prev);
      expect(w.end_ms).toBeGreaterThanOrEqual(w.start_ms);
      prev = w.end_ms;
    }
  });

  it("prefixes leading punctuation to the first word and applies an offset", () => {
    const words = alignmentToWords(chars('" Hi   there'), 1000);
    expect(words).toEqual([
      { word: '"Hi', start_ms: 1200, end_ms: 1400 },
      { word: "there", start_ms: 1700, end_ms: 2200 },
    ]);
  });
});

describe("chunkText", () => {
  it("keeps short text whole and splits long text at sentence boundaries", () => {
    expect(chunkText("Short one.", 100)).toEqual(["Short one."]);
    expect(chunkText("First sentence here. Second sentence here. Third.", 25)).toEqual([
      "First sentence here.",
      "Second sentence here.",
      "Third.",
    ]);
    const long = chunkText("word ".repeat(30), 20);
    expect(long.every((c) => c.length <= 20)).toBe(true);
    expect(long.join(" ").split(/\s+/)).toHaveLength(30);
  });
});

const tools: ToolResolver = (n) => `/fake/${n}`;

function fakeRunner(durations: number[]): CommandRunner {
  let probes = 0;
  return async (cmd, args) => {
    if (cmd.endsWith("ffprobe")) {
      const d = durations[Math.min(probes++, durations.length - 1)]!;
      return { code: 0, stdout: `${d}\n`, stderr: "" };
    }
    await writeFile(args.at(-1)!, "wav");
    return { code: 0, stdout: "", stderr: "" };
  };
}

function jsonResponse(body: unknown, requestId?: string) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(requestId ? { "request-id": requestId } : {}) },
  });
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vs-voice-11l-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("elevenlabs backend (mocked fetch)", () => {
  it("is available only with ELEVENLABS_API_KEY", () => {
    const b = createElevenLabsBackend({ resolver: tools });
    expect(b.available({})).toMatchObject({ ok: false });
    expect(b.available({ ELEVENLABS_API_KEY: "  " })).toMatchObject({ ok: false });
    expect(b.available({ ELEVENLABS_API_KEY: KEY })).toMatchObject({ ok: true });
    expect(JSON.stringify(b.available({ ELEVENLABS_API_KEY: KEY }))).not.toContain(KEY);
  });

  it("posts with-timestamps, decodes audio and returns provider timings", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as WithTimestampsResponse;
    const fetchMock = vi.fn(async () => jsonResponse(fixture, "req-1"));
    const b = createElevenLabsBackend({ fetch: fetchMock as unknown as typeof fetch, runner: fakeRunner([2.5, 2.5]), resolver: tools, seed: 7 });
    const track = await b.synthesize(
      { scene_id: "s01", text: "Hello,  world — ship CI/CD fast!", voice: "voice123" },
      { outDir: dir, env: { ELEVENLABS_API_KEY: KEY } },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice123/with-timestamps?output_format=mp3_44100_128");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe(KEY);
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ text: "Hello,  world — ship CI/CD fast!", model_id: "eleven_multilingual_v2", seed: 7 });
    expect(track).toMatchObject({ timing_source: "provider", provider: "elevenlabs", voice: "voice123", duration_ms: 2500 });
    expect(track.words.map((w) => w.word)).toEqual(["Hello,", "world—", "ship", "CI/CD", "fast!"]);
    expect(track.audio_path).toBe(join(dir, "s01.wav"));
  });

  it("chunks long text, offsets words by chunk duration and passes previous_request_ids", async () => {
    let n = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const { text } = JSON.parse(init.body as string) as { text: string };
      return jsonResponse({ audio_base64: Buffer.from("x").toString("base64"), alignment: chars(text) }, `req-${++n}`);
    });
    const b = createElevenLabsBackend({ fetch: fetchMock as unknown as typeof fetch, runner: fakeRunner([1.2, 0.9, 2.1]), resolver: tools, chunkChars: 12 });
    const track = await b.synthesize({ scene_id: "s01", text: "One two. Three four." }, { outDir: dir, env: { ELEVENLABS_API_KEY: KEY } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(second.previous_request_ids).toEqual(["req-1"]);
    expect(track.words.map((w) => w.word)).toEqual(["One", "two.", "Three", "four."]);
    expect(track.words[2]!.start_ms).toBe(1200); // offset by first chunk's measured 1.2 s
    expect(track.duration_ms).toBe(2100);
  });

  it("reports HTTP errors without leaking the key", async () => {
    const fetchMock = vi.fn(async () => new Response(`{"detail":"bad key ${KEY}"}`, { status: 401 }));
    const b = createElevenLabsBackend({ fetch: fetchMock as unknown as typeof fetch, runner: fakeRunner([1]), resolver: tools });
    const err = await b.synthesize({ scene_id: "s01", text: "hi" }, { outDir: dir, env: { ELEVENLABS_API_KEY: KEY } }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/HTTP 401/);
    expect((err as Error).message).not.toContain(KEY);
  });
});

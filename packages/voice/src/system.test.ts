import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultResolver, defaultRunner, type CommandRunner, type ToolResolver } from "./exec.js";
import { NoVoiceForLanguageError, createSystemBackend, parseSayVoices, pickSayVoice } from "./system.js";

const SAY_VOICES = [
  "Albert              en_US    # Hello! My name is Albert.",
  "Eddy (English (US)) en_US    # Hello! My name is Eddy.",
  "Samantha            en_US    # Hello! My name is Samantha.",
  "Grandpa (Chinese (China mainland)) zh_CN    # 你好！我叫Grandpa。",
  "Kyoko               ja_JP    # こんにちは、私の名前はKyokoです。",
  "",
].join("\n");

describe("parseSayVoices", () => {
  it("parses names with spaces and parentheses", () => {
    const v = parseSayVoices(SAY_VOICES);
    expect(v.map((x) => x.name)).toEqual(["Albert", "Eddy (English (US))", "Samantha", "Grandpa (Chinese (China mainland))", "Kyoko"]);
    expect(v[3]!.locale).toBe("zh_CN");
    expect(v[0]!.sample).toBe("Hello! My name is Albert.");
  });
});

const allTools: ToolResolver = (name) => `/fake/${name}`;

interface Call {
  cmd: string;
  args: string[];
}

/** Fake runner: `say`/`espeak-ng`/`ffmpeg` write a placeholder file; ffprobe reports `durationSec`. */
function fakeRunner(calls: Call[], durationSec = "1.500000", silence = ""): CommandRunner {
  return async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd.endsWith("say") && args[0] === "-v" && args[1] === "?") return { code: 0, stdout: SAY_VOICES, stderr: "" };
    if (cmd.endsWith("say")) {
      await writeFile(args[args.indexOf("-o") + 1]!, "aiff");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd.endsWith("espeak-ng")) {
      await writeFile(args[args.indexOf("-w") + 1]!, "wav");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd.endsWith("ffprobe")) return { code: 0, stdout: `${durationSec}\n`, stderr: "" };
    if (cmd.endsWith("ffmpeg")) {
      if (args.includes("null")) return { code: 0, stdout: "", stderr: silence };
      await writeFile(args.at(-1)!, "wav");
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 127, stdout: "", stderr: "not found" };
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vs-voice-sys-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("system backend (mocked commands)", () => {
  it("is unavailable without say / espeak-ng / ffmpeg", () => {
    const none: ToolResolver = () => undefined;
    expect(createSystemBackend({ platform: "darwin", resolver: none }).available({}).ok).toBe(false);
    expect(createSystemBackend({ platform: "linux", resolver: none }).available({}).reason).toMatch(/espeak-ng/);
    expect(createSystemBackend({ platform: "win32", resolver: allTools }).available({}).ok).toBe(false);
    const noFf: ToolResolver = (n) => (n === "say" ? "/usr/bin/say" : undefined);
    expect(createSystemBackend({ platform: "darwin", resolver: noFf }).available({}).reason).toMatch(/ffmpeg/);
    expect(createSystemBackend({ platform: "darwin", resolver: allTools }).available({}).ok).toBe(true);
  });

  it("resolves voice: requested if installed, else Samantha", async () => {
    const calls: Call[] = [];
    const b = createSystemBackend({ platform: "darwin", resolver: allTools, runner: fakeRunner(calls) });
    expect(await b.resolveVoice!("Albert", {})).toBe("Albert");
    expect(await b.resolveVoice!("NoSuchVoice", {})).toBe("Samantha");
    expect(await b.resolveVoice!(undefined, {})).toBe("Samantha");
    expect(calls.filter((c) => c.args[1] === "?")).toHaveLength(1); // voice list cached
  });

  it("picks a voice that speaks the spec language (ja → Kyoko), never an English one", async () => {
    const calls: Call[] = [];
    const b = createSystemBackend({ platform: "darwin", resolver: allTools, runner: fakeRunner(calls) });
    expect(await b.resolveVoice!(undefined, {}, "ja")).toBe("Kyoko");
    expect(await b.resolveVoice!(undefined, {}, "ja-JP")).toBe("Kyoko");
    expect(await b.resolveVoice!("Albert", {}, "ja")).toBe("Kyoko"); // Albert does not speak Japanese
    expect(await b.resolveVoice!(undefined, {}, "zh-CN")).toBe("Grandpa (Chinese (China mainland))");
    expect(await b.resolveVoice!(undefined, {}, "en-GB")).toBe("Samantha");
    expect(await b.resolveVoice!(undefined, {}, "hi")).toBeUndefined();
    const voices = parseSayVoices(SAY_VOICES);
    expect(pickSayVoice(voices, "ja", "Kyoko")).toBe("Kyoko");
    expect(pickSayVoice([...voices, { name: "Lekha", locale: "hi_IN", sample: "" }], "hi-IN")).toBe("Lekha");
  });

  it("synthesizes Japanese with Kyoko and per-character words; Hindi without a voice fails with a clear reason", async () => {
    const calls: Call[] = [];
    const b = createSystemBackend({ platform: "darwin", resolver: allTools, runner: fakeRunner(calls), trimSilence: false });
    const track = await b.synthesize({ scene_id: "s01", text: "意味で検索します。", language: "ja" }, { outDir: dir, env: {} });
    expect(track.voice).toBe("Kyoko");
    expect(track.words.map((w) => w.word)).toEqual(["意", "味", "で", "検", "索", "し", "ま", "す。"]);
    const sayCall = calls.find((c) => c.cmd.endsWith("say") && c.args.includes("-o"))!;
    expect(sayCall.args).toEqual(expect.arrayContaining(["-v", "Kyoko"]));
    const err = await b.synthesize({ scene_id: "s02", text: "नमस्ते दुनिया", language: "hi" }, { outDir: dir, env: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoVoiceForLanguageError);
    expect(String(err)).toMatch(/no voice for language "hi".*not reading it with an English voice.*installed voice languages: en, ja, zh/);
    expect(calls.filter((c) => c.cmd.endsWith("say") && c.args.includes("-o"))).toHaveLength(1); // nothing spoken for hi
  });

  it("uses the language code as the espeak-ng voice", async () => {
    const calls: Call[] = [];
    const b = createSystemBackend({ platform: "linux", resolver: allTools, runner: fakeRunner(calls, "0.8"), trimSilence: false });
    await b.synthesize({ scene_id: "s01", text: "नमस्ते", language: "hi-IN" }, { outDir: dir, env: {} });
    expect(calls.find((c) => c.cmd.endsWith("espeak-ng"))!.args).toEqual(expect.arrayContaining(["-v", "hi"]));
  });

  it("falls back to the system default when Samantha is missing", async () => {
    const runner: CommandRunner = async () => ({ code: 0, stdout: "Albert en_US # hi", stderr: "" });
    const b = createSystemBackend({ platform: "darwin", resolver: allTools, runner });
    expect(await b.resolveVoice!(undefined, {})).toBeUndefined();
  });

  it("synthesizes with say → ffmpeg 48k mono → ffprobe, estimating trimmed timings", async () => {
    const calls: Call[] = [];
    const silence = "silence_start: 0\nsilence_end: 0.1\nsilence_start: 1.3\nsilence_end: 1.5";
    const b = createSystemBackend({ platform: "darwin", resolver: allTools, runner: fakeRunner(calls, "1.5", silence), rate: 200 });
    const track = await b.synthesize({ scene_id: "s01", text: "Hello there, world." }, { outDir: dir, env: {} });
    expect(track.provider).toBe("system-say");
    expect(track.timing_source).toBe("estimated");
    expect(track.voice).toBe("Samantha");
    expect(track.duration_ms).toBe(1500);
    expect(track.audio_path).toBe(join(dir, "s01.wav"));
    expect(track.words.map((w) => w.word)).toEqual(["Hello", "there,", "world."]);
    expect(track.words[0]!.start_ms).toBe(100);
    expect(track.words.at(-1)!.end_ms).toBe(1300);
    const sayCall = calls.find((c) => c.cmd.endsWith("say") && c.args.includes("-o"))!;
    expect(sayCall.args).toEqual(expect.arrayContaining(["-v", "Samantha", "-r", "200", "-f"]));
    const conv = calls.find((c) => c.cmd.endsWith("ffmpeg") && c.args.includes("48000"))!;
    expect(conv.args).toEqual(expect.arrayContaining(["-ac", "1", "-c:a", "pcm_s16le"]));
  });

  it("uses espeak-ng on linux", async () => {
    const calls: Call[] = [];
    const b = createSystemBackend({ platform: "linux", resolver: allTools, runner: fakeRunner(calls, "0.8"), trimSilence: false });
    const track = await b.synthesize({ scene_id: "s02", text: "Hi all" }, { outDir: dir, env: {} });
    expect(track.provider).toBe("system-espeak-ng");
    expect(calls.some((c) => c.cmd.endsWith("espeak-ng") && c.args.includes("-s") && c.args.includes("180"))).toBe(true);
    expect(track.words.at(-1)!.end_ms).toBe(800);
  });

  it("fails loudly when say writes no audio (e.g. sandboxed)", async () => {
    const b = createSystemBackend({ platform: "darwin", resolver: allTools, runner: fakeRunner([], "0.000000") });
    await expect(b.synthesize({ scene_id: "s01", text: "Hello" }, { outDir: dir, env: {} })).rejects.toThrow(/no audio/);
  });
});

const ffmpeg = defaultResolver("ffmpeg", process.env);
const ffprobe = defaultResolver("ffprobe", process.env);

describe.skipIf(!ffmpeg || !ffprobe)("system backend with real ffmpeg (fake say)", () => {
  it("converts a generated tone to 48 kHz mono WAV and measures it", async () => {
    // Fake `say` generates a 1 s tone with ffmpeg lavfi instead of speaking.
    const runner: CommandRunner = async (cmd, args, opts) => {
      if (cmd === "/fake/say" && args[1] === "?") return { code: 0, stdout: SAY_VOICES, stderr: "" };
      if (cmd === "/fake/say") {
        const out = args[args.indexOf("-o") + 1]!;
        return defaultRunner(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ar", "22050", out], opts);
      }
      return defaultRunner(cmd, args, opts);
    };
    const resolver: ToolResolver = (n, env) => (n === "say" ? "/fake/say" : defaultResolver(n, env));
    const b = createSystemBackend({ platform: "darwin", resolver, runner });
    const track = await b.synthesize({ scene_id: "s01", text: "one two three" }, { outDir: dir, env: process.env });
    expect(track.duration_ms).toBeGreaterThanOrEqual(990);
    expect(track.duration_ms).toBeLessThanOrEqual(1010);
    expect(track.words).toHaveLength(3);
    const probe = await defaultRunner(ffprobe!, ["-v", "error", "-show_entries", "stream=sample_rate,channels", "-of", "csv=p=0", track.audio_path!]);
    expect(probe.stdout.trim()).toBe("48000,1");
    expect((await stat(track.audio_path!)).size).toBeGreaterThan(90_000);
  });
});

// Opt-in: real macOS `say` (does not work inside the Claude Code sandbox). Run with VS_TEST_SAY=1.
describe.skipIf(process.env.VS_TEST_SAY !== "1" || process.platform !== "darwin")("system backend with real say", () => {
  it("speaks a short phrase", async () => {
    const b = createSystemBackend();
    expect(b.available(process.env).ok).toBe(true);
    const track = await b.synthesize({ scene_id: "s01", text: "Hello world, this is a test." }, { outDir: dir, env: process.env });
    expect(track.duration_ms).toBeGreaterThan(500);
    expect(track.words).toHaveLength(6);
    expect(track.words.at(-1)!.end_ms).toBeLessThanOrEqual(track.duration_ms);
  }, 30_000);
});

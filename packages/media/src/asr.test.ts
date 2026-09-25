import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { groupSentences, parseCaptionFile, parseWhisperJson, whisperLanguage, whisperTranscribe } from "./asr.js";

const SRT = `1
00:00:01,000 --> 00:00:03,000
Hello <i>big</i> world.

2
00:00:03,500 --> 00:00:04,500
{\\an8}Is it?
`;

const VTT = `WEBVTT

NOTE a comment

intro
00:01.000 --> 00:02.000 align:start
<v Ann>One two</v>

00:00:02.500 --> 00:00:03.100
[Music]

00:00:03.500 --> 00:00:04.100
three.
`;

describe("parseCaptionFile", () => {
  it("parses SRT cues, strips markup and spreads cue time over the words", () => {
    const w = parseCaptionFile(SRT);
    expect(w.map((x) => x.word)).toEqual(["Hello", "big", "world.", "Is", "it?"]);
    expect(w[0]).toMatchObject({ start_ms: 1000 });
    expect(w[2]).toMatchObject({ end_ms: 3000 });
    expect(w[3]).toEqual({ word: "Is", start_ms: 3500, end_ms: 4000 });
  });

  it("parses VTT (short timestamps, settings, voice tags) and drops non-speech cues", () => {
    const w = parseCaptionFile(VTT);
    expect(w.map((x) => x.word)).toEqual(["One", "two", "three."]);
    expect(w[0]).toEqual({ word: "One", start_ms: 1000, end_ms: 1500 });
    expect(w[2]).toEqual({ word: "three.", start_ms: 3500, end_ms: 4100 });
  });
});

describe("parseWhisperJson", () => {
  it("joins continuation tokens, drops blanks and non-speech tags", () => {
    const json = JSON.stringify({
      transcription: [
        { offsets: { from: 0, to: 300 }, text: "" },
        { offsets: { from: 300, to: 500 }, text: " I" },
        { offsets: { from: 500, to: 700 }, text: " don" },
        { offsets: { from: 700, to: 800 }, text: "'t" },
        { offsets: { from: 800, to: 1000 }, text: " [BLANK_AUDIO]" },
        { offsets: { from: 1000, to: 1300 }, text: " know." },
      ],
    });
    expect(parseWhisperJson(json)).toEqual([
      { word: "I", start_ms: 300, end_ms: 500 },
      { word: "don't", start_ms: 500, end_ms: 800 },
      { word: "know.", start_ms: 1000, end_ms: 1300 },
    ]);
  });

  it("picks the language from the model name", () => {
    expect(whisperLanguage("/m/ggml-base.en.bin")).toBe("en");
    expect(whisperLanguage("/m/ggml-base.bin")).toBe("auto");
    expect(whisperLanguage("/m/ggml-base.bin", "de")).toBe("de");
  });
});

describe("groupSentences", () => {
  it("splits on terminal punctuation and long pauses", () => {
    const w = (word: string, s: number, e: number) => ({ word, start_ms: s, end_ms: e });
    const s = groupSentences([w("Hi", 0, 200), w("there.", 200, 400), w("So", 500, 600), w("yes", 600, 700), w("then", 2000, 2200), w("what?", 2200, 2400)]);
    expect(s.map((x) => x.text)).toEqual(["Hi there.", "So yes", "then what?"]);
    expect(s[1]).toMatchObject({ start_ms: 500, end_ms: 700, first: 2, last: 3 });
  });
});

const MODEL = process.env.VS_TEST_WHISPER_MODEL;
describe.skipIf(!MODEL || !existsSync(MODEL))("whisperTranscribe (VS_TEST_WHISPER_MODEL)", () => {
  it("transcribes jfk.wav into monotonic timed words", async () => {
    const wav = process.env.VS_TEST_WHISPER_AUDIO ?? join(MODEL!, "..", "jfk.wav");
    const words = await whisperTranscribe(wav, { model: MODEL! });
    const text = words.map((w) => w.word.toLowerCase().replace(/[^a-z]/g, ""));
    expect(text).toContain("country");
    expect(text).toContain("americans");
    for (let i = 1; i < words.length; i++) {
      expect(words[i]!.start_ms).toBeGreaterThanOrEqual(words[i - 1]!.end_ms);
      expect(words[i]!.end_ms).toBeGreaterThanOrEqual(words[i]!.start_ms);
    }
    expect(words[words.length - 1]!.end_ms).toBeGreaterThan(8000);
  }, 120_000);
});

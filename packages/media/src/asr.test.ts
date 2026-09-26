import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { groupSentences, isEnglishOnlyModel, parseCaptionFile, parseWhisperJson, parseWhisperOutput, whisperLanguage, whisperTranscribe, whisperTranscribeDetailed } from "./asr.js";

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

describe("parseWhisperOutput", () => {
  // Captured from `whisper-cli -m ggml-small.en-tdrz.bin -f a13.wav -l en -tdrz -ml 1 -sow -oj` (Apollo 13 air-to-ground, public domain).
  const fixture = readFileSync(join(import.meta.dirname, "__fixtures__", "whisper-tdrz-apollo13.json"), "utf8");

  it("reads the detected language and labels speaker runs S1/S2 at each speaker_turn_next", () => {
    const r = parseWhisperOutput(fixture, { speakers: true });
    expect(r.language).toBe("en");
    // Five turns are flagged; the last one ends the recording, so four change the speaker.
    expect(r.speaker_turns).toBe(4);
    const runs: Array<{ speaker: string; text: string }> = [];
    for (const w of r.words) {
      const last = runs[runs.length - 1];
      if (last && last.speaker === w.speaker) last.text += ` ${w.word}`;
      else runs.push({ speaker: w.speaker!, text: w.word });
    }
    expect(runs.map((x) => x.speaker)).toEqual(["S1", "S2", "S1", "S2", "S1"]);
    expect(runs[0]!.text).toBe("Okay Houston, we've had a problem here.");
    expect(runs[1]!.text).toBe("This is Houston. Say again, please.");
    expect(runs[3]!.text).toMatch(/^Roger, main beam/);
    // Same words and times as the plain parser.
    expect(r.words.map(({ speaker: _s, ...w }) => w)).toEqual(parseWhisperJson(fixture));
  });

  it("adds no speaker labels unless asked", () => {
    const r = parseWhisperOutput(fixture);
    expect(r.words.some((w) => "speaker" in w)).toBe(false);
    expect(r.speaker_turns).toBeUndefined();
  });

  it("applies a turn flagged on a continuation or blank segment to the next word", () => {
    const json = JSON.stringify({
      result: { language: "es" },
      transcription: [
        { offsets: { from: 0, to: 300 }, text: " Hola" },
        { offsets: { from: 300, to: 350 }, text: ",", speaker_turn_next: true },
        { offsets: { from: 400, to: 600 }, text: " Buenas" },
        { offsets: { from: 600, to: 700 }, text: " [BLANK_AUDIO]", speaker_turn_next: true },
        { offsets: { from: 700, to: 900 }, text: " Sí" },
      ],
    });
    const r = parseWhisperOutput(json, { speakers: true });
    expect(r.language).toBe("es");
    expect(r.words.map((w) => `${w.speaker}:${w.word}`)).toEqual(["S1:Hola,", "S2:Buenas", "S1:Sí"]);
    expect(r.speaker_turns).toBe(2);
  });

  it("ends sentences at a speaker change", () => {
    const w = (word: string, s: number, e: number, speaker: string) => ({ word, start_ms: s, end_ms: e, speaker });
    const s = groupSentences([w("go", 0, 100, "S1"), w("ahead", 100, 200, "S1"), w("roger", 250, 400, "S2"), w("that", 400, 500, "S2")]);
    expect(s.map((x) => [x.speaker, x.text])).toEqual([["S1", "go ahead"], ["S2", "roger that"]]);
  });

  it("recognises English-only model files", () => {
    expect(isEnglishOnlyModel("/m/ggml-base.en.bin")).toBe(true);
    expect(isEnglishOnlyModel("/m/ggml-small.en-tdrz.bin")).toBe(true);
    expect(isEnglishOnlyModel("/m/ggml-base.bin")).toBe(false);
  });
});

// Real runs: VS_TEST_WHISPER_DIR holds ggml-base.bin, ggml-small.en-tdrz.bin, jfk.wav, es20.wav, a13.wav.
const WDIR = process.env.VS_TEST_WHISPER_DIR;
const have = (...f: string[]) => !!WDIR && f.every((x) => existsSync(join(WDIR, x)));
describe("whisper.cpp real runs (VS_TEST_WHISPER_DIR)", () => {
  it.skipIf(!have("ggml-base.bin", "es20.wav"))("multilingual base detects Spanish", async () => {
    const r = await whisperTranscribeDetailed(join(WDIR!, "es20.wav"), { model: join(WDIR!, "ggml-base.bin") });
    expect(r.language).toBe("es");
    const text = r.words.map((w) => w.word.toLowerCase()).join(" ");
    expect(text).toMatch(/febrero/);
    expect(text).toMatch(/\bes\b|\bpara\b|\buna\b/);
  }, 180_000);

  it.skipIf(!have("ggml-base.bin", "jfk.wav"))("multilingual base detects English on jfk.wav", async () => {
    const r = await whisperTranscribeDetailed(join(WDIR!, "jfk.wav"), { model: join(WDIR!, "ggml-base.bin") });
    expect(r.language).toBe("en");
    expect(r.words.map((w) => w.word.toLowerCase()).join(" ")).toMatch(/country/);
  }, 180_000);

  it.skipIf(!have("ggml-small.en-tdrz.bin", "a13.wav"))("tinydiarize finds speaker turns in the Apollo 13 dialogue", async () => {
    const r = await whisperTranscribeDetailed(join(WDIR!, "a13.wav"), { model: join(WDIR!, "ggml-small.en-tdrz.bin"), speakers: true });
    expect(r.speaker_turns).toBeGreaterThanOrEqual(3);
    expect(new Set(r.words.map((w) => w.speaker))).toEqual(new Set(["S1", "S2"]));
  }, 300_000);
});

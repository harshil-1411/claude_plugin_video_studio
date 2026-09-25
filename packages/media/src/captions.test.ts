import type { SceneVoiceTrack } from "@video-studio/schema";
import { describe, expect, it } from "vitest";
import {
  type CaptionWord,
  assColor,
  assKaraokeText,
  assTimeCs,
  buildWordTimeline,
  groupCaptionLines,
  toAss,
  toCaptionJson,
  toSrt,
  toTranscript,
  toVtt,
} from "./captions.js";

const s1: SceneVoiceTrack = {
  scene_id: "s01",
  audio_path: "voice/s01.wav",
  duration_ms: 1000,
  timing_source: "estimated",
  provider: "system-say",
  words: [
    { word: "Hello", start_ms: 0, end_ms: 400 },
    { word: "world.", start_ms: 450, end_ms: 900 },
  ],
};
const s2: SceneVoiceTrack = {
  scene_id: "s02",
  duration_ms: 2500,
  timing_source: "provider",
  provider: "elevenlabs",
  words: [
    { word: "Vector", start_ms: 0, end_ms: 300 },
    { word: "databases", start_ms: 300, end_ms: 800 },
    // 700 ms pause (> maxGapMs 600) forces a new line.
    { word: "store", start_ms: 1500, end_ms: 1800 },
    { word: "embeddings", start_ms: 1800, end_ms: 2400 },
  ],
};

const words = buildWordTimeline([
  { scene_start_ms: 0, track: s1 },
  { scene_start_ms: 1000, track: s2 },
]);
const lines = groupCaptionLines(words);

const w = (word: string, start_ms: number, end_ms: number, scene_id = "s"): CaptionWord => ({ word, start_ms, end_ms, scene_id });

describe("word timeline", () => {
  it("offsets scene words to global time", () => {
    expect(words.map((x) => [x.word, x.start_ms, x.end_ms, x.scene_id])).toEqual([
      ["Hello", 0, 400, "s01"],
      ["world.", 450, 900, "s01"],
      ["Vector", 1000, 1300, "s02"],
      ["databases", 1300, 1800, "s02"],
      ["store", 2500, 2800, "s02"],
      ["embeddings", 2800, 3400, "s02"],
    ]);
  });

  it("clamps to the scene, removes overlaps and blank words", () => {
    const t = buildWordTimeline([
      {
        scene_start_ms: 5000,
        track: {
          ...s1,
          duration_ms: 1000,
          words: [
            { word: "a", start_ms: 0, end_ms: 600 },
            { word: " ", start_ms: 100, end_ms: 200 },
            { word: "b", start_ms: 500, end_ms: 1400 },
          ],
        },
      },
    ]);
    expect(t.map((x) => [x.word, x.start_ms, x.end_ms])).toEqual([
      ["a", 5000, 5500],
      ["b", 5500, 6000],
    ]);
  });
});

describe("groupCaptionLines", () => {
  it("breaks on sentence end, scene change and long pauses", () => {
    expect(lines.map((l) => [l.text, l.start_ms, l.end_ms])).toEqual([
      ["Hello world.", 0, 900],
      ["Vector databases", 1000, 1800],
      ["store embeddings", 2500, 3400],
    ]);
  });

  it("respects maxWords", () => {
    const ws = ["a", "b", "c", "d", "e", "f", "g"].map((x, i) => w(x, i * 100, i * 100 + 90));
    expect(groupCaptionLines(ws).map((l) => l.text)).toEqual(["a b c d e", "f g"]);
    expect(groupCaptionLines(ws, { maxWords: 3 }).map((l) => l.text)).toEqual(["a b c", "d e f", "g"]);
  });

  it("respects maxChars, but keeps an over-long word on its own line", () => {
    const ws = ["twelve_chars", "twelve_chars", "twelve_chars", "x".repeat(40), "ok"].map((x, i) => w(x, i * 100, i * 100 + 90));
    // "twelve_chars twelve_chars" = 25 chars; adding another would be 38 > 32.
    expect(groupCaptionLines(ws).map((l) => l.text)).toEqual(["twelve_chars twelve_chars", "twelve_chars", "x".repeat(40), "ok"]);
  });

  it("maxGapMs is exclusive and sentence breaks can be disabled", () => {
    const ws = [w("one.", 0, 100), w("two", 700, 800), w("three", 1401, 1500)];
    expect(groupCaptionLines(ws, { breakOnSentence: false }).map((l) => l.text)).toEqual(["one. two", "three"]);
    expect(groupCaptionLines(ws).map((l) => l.text)).toEqual(["one.", "two", "three"]);
  });
});

describe("sidecar writers", () => {
  it("SRT golden", () => {
    expect(toSrt(lines)).toBe(
      "1\n00:00:00,000 --> 00:00:00,900\nHello world.\n\n" +
        "2\n00:00:01,000 --> 00:00:01,800\nVector databases\n\n" +
        "3\n00:00:02,500 --> 00:00:03,400\nstore embeddings\n",
    );
  });

  it("VTT golden", () => {
    expect(toVtt(lines)).toBe(
      "WEBVTT\n\n" +
        "00:00:00.000 --> 00:00:00.900\nHello world.\n\n" +
        "00:00:01.000 --> 00:00:01.800\nVector databases\n\n" +
        "00:00:02.500 --> 00:00:03.400\nstore embeddings\n",
    );
  });

  it("VTT escapes markup and handles hours", () => {
    expect(toVtt([{ start_ms: 3_723_004, end_ms: 3_724_000, text: "a<b>&c", words: [] }])).toBe("WEBVTT\n\n01:02:03.004 --> 01:02:04.000\na&lt;b&gt;&amp;c\n");
  });

  it("transcript: one paragraph per scene", () => {
    expect(toTranscript(words)).toBe("Hello world.\n\nVector databases store embeddings\n");
  });

  it("caption JSON indexes lines into the word list", () => {
    const j = toCaptionJson(words, lines);
    expect(j.version).toBe(1);
    expect(j.words).toHaveLength(6);
    expect(j.lines.map((l) => [l.first_word, l.word_count])).toEqual([
      [0, 2],
      [2, 2],
      [4, 2],
    ]);
  });
});

describe("ASS", () => {
  it("formats times and colours", () => {
    expect(assTimeCs(0)).toBe("0:00:00.00");
    expect(assTimeCs(372_301)).toBe("1:02:03.01");
    expect(assColor("#FFD60A")).toBe("&H000AD6FF");
    expect(assColor("#00000080")).toBe("&H7F000000");
    expect(() => assColor("red")).toThrow(/invalid colour/);
  });

  it("\\kf durations are centiseconds from the line start, with \\k for pauses", () => {
    expect(lines.map(assKaraokeText)).toEqual(["{\\kf40}Hello {\\k5}{\\kf45}world.", "{\\kf30}Vector {\\kf50}databases", "{\\kf30}store {\\kf60}embeddings"]);
  });

  it("karaoke durations sum to the line length without rounding drift", () => {
    const ws = [w("a", 1004, 1336), w("b", 1336, 1668), w("c", 1668, 2001)];
    const [line] = groupCaptionLines(ws);
    const text = assKaraokeText(line!);
    const total = [...text.matchAll(/\\kf?(\d+)/g)].reduce((s, m) => s + Number(m[1]), 0);
    expect(total).toBe(Math.round(2001 / 10) - Math.round(1004 / 10));
    expect(text).toBe("{\\kf34}a {\\kf33}b {\\kf33}c"); // boundaries 100→134→167→200
  });

  it("golden file for 180x320 minimal", () => {
    const ass = toAss(lines, { width: 180, height: 320, preset: "minimal", font: "Arial", primary: "#FFFFFF", highlight: "#FFD60A" });
    expect(ass).toBe(
      [
        "[Script Info]",
        "; Generated by video-studio",
        "ScriptType: v4.00+",
        "PlayResX: 180",
        "PlayResY: 320",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "YCbCr Matrix: TV.709",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        // 18% bottom margin for 9:16 (58 of 320 px) keeps captions clear of platform UI.
        "Style: Default,Arial,11,&H000AD6FF,&H00FFFFFF,&H00000000,&H7F000000,0,0,0,0,100,100,0,0,1,1,0,2,11,11,58,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        "Dialogue: 0,0:00:00.00,0:00:00.90,Default,,0,0,0,,{\\kf40}Hello {\\k5}{\\kf45}world.",
        "Dialogue: 0,0:00:01.00,0:00:01.80,Default,,0,0,0,,{\\kf30}Vector {\\kf50}databases",
        "Dialogue: 0,0:00:02.50,0:00:03.40,Default,,0,0,0,,{\\kf30}store {\\kf60}embeddings",
        "",
      ].join("\n"),
    );
  });

  it("bold preset at 1080x1920 and 16:9 margins", () => {
    const bold = toAss(lines, { width: 1080, height: 1920, preset: "bold" });
    expect(bold).toContain("Style: Default,Arial,86,&H000AD6FF,&H00FFFFFF,&H00000000,&H7F000000,-1,0,0,0,100,100,0,0,1,6,3,2,65,65,346,1");
    expect(bold).toContain("PlayResX: 1080\nPlayResY: 1920");
    const wide = toAss(lines, { width: 1920, height: 1080, marginV: 40 });
    expect(wide).toMatch(/,2,115,115,40,1\n/);
    expect(toAss(lines, { width: 1920, height: 1080 })).toMatch(/,2,115,115,130,1\n/);
  });

  it("neutralises override braces and backslashes in words", () => {
    const [line] = groupCaptionLines([w("{\\b1}x", 0, 100)]);
    expect(assKaraokeText(line!)).toBe("{\\kf10}(/b1)x");
  });
});

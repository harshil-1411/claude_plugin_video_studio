import type { SceneVoiceTrack } from "@video-studio/schema";
import { describe, expect, it } from "vitest";
import {
  type CaptionWord,
  assColor,
  assKaraokeText,
  assTimeCs,
  buildWordTimeline,
  captionBlockBox,
  captionLayout,
  captionRows,
  groupCaptionLines,
  pickEmphasis,
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

const seq = (text: string, step = 300, scene = "s") => text.split(" ").map((x, i) => w(x, i * step, i * step + step - 20, scene));
const texts = (ls: ReturnType<typeof groupCaptionLines>) => ls.map((l) => captionRows(l).join(" / "));

describe("groupCaptionLines", () => {
  it("breaks on sentence end, scene change and long pauses", () => {
    expect(lines.map((l) => [l.text, l.start_ms, l.end_ms])).toEqual([
      // 100 ms gap to the next caption is held over (< 250 ms).
      ["Hello world.", 0, 1000],
      ["Vector databases", 1000, 1800],
      ["store embeddings", 2500, 3400],
    ]);
  });

  it("makes phrase-level captions of 3–7 words, balanced, never ending on an article", () => {
    const ls = groupCaptionLines(seq("a b c d e f g h i j"));
    expect(ls.map((l) => l.words.length)).toEqual([5, 5]);
    expect(groupCaptionLines(seq("one two three four five six seven")).map((l) => l.words.length)).toEqual([7]);
    for (const l of groupCaptionLines(seq("we store the vectors in an index so that the search stays fast for the users of the app"))) {
      expect(l.words.length).toBeGreaterThanOrEqual(3);
      expect(l.words.length).toBeLessThanOrEqual(7);
      expect(["the", "an", "of", "in", "for"]).not.toContain(l.words.at(-1)!.word);
    }
    expect(groupCaptionLines(seq("a b c d e f g"), { maxWords: 3 }).map((l) => l.text)).toEqual(["a b c", "d e", "f g"]);
  });

  it("prefers breaks after punctuation and before conjunctions", () => {
    expect(texts(groupCaptionLines(seq("Embeddings map meaning to numbers, so similar ideas land close together"), { maxChars: 40 }))).toEqual([
      "Embeddings map meaning to numbers,",
      "so similar ideas land close together",
    ]);
    expect(texts(groupCaptionLines(seq("Search gets faster because the index skips vectors"), { maxChars: 40 }))[0]).toBe("Search gets faster");
  });

  it("wraps onto at most maxLines rows without a one-word orphan", () => {
    const ls = groupCaptionLines(seq("Approximate nearest neighbour search trades exactness for speed"), { maxChars: 24 });
    for (const l of ls) {
      const rows = captionRows(l);
      expect(rows.length).toBeLessThanOrEqual(2);
      for (const r of rows) expect(r.length).toBeLessThanOrEqual(24);
      if (l.words.length >= 3) expect(l.row_sizes?.includes(1) ?? false).toBe(false);
    }
    const one = groupCaptionLines(seq("Approximate nearest neighbour search trades exactness for speed"), { maxChars: 24, maxLines: 1 });
    for (const l of one) expect(l.row_sizes).toBeUndefined();
    expect(one.length).toBeGreaterThan(ls.length);
    const three = groupCaptionLines(seq("Approximate nearest neighbour search trades exactness"), { maxChars: 14, maxLines: 3 });
    expect(Math.max(...three.map((l) => captionRows(l).length))).toBe(3);
  });

  it("keeps an over-long word on its own row", () => {
    const ls = groupCaptionLines(seq(`ok ${"x".repeat(40)} fine`), { maxChars: 20 });
    expect(ls.flatMap(captionRows)).toContain("x".repeat(40));
  });

  it("maxGapMs is exclusive and sentence breaks can be disabled", () => {
    const ws = [w("one.", 0, 100), w("two", 700, 800), w("three", 1401, 1500)];
    expect(groupCaptionLines(ws, { breakOnSentence: false }).map((l) => l.text)).toEqual(["one. two", "three"]);
    expect(groupCaptionLines(ws).map((l) => l.text)).toEqual(["one.", "two", "three"]);
  });

  it("holds each caption for the minimum display time without overlaps or running past the end", () => {
    const ws = [w("Quick.", 0, 200), w("Next", 1000, 1200), w("one.", 1200, 1300), w("Last.", 5000, 5100)];
    const ls = groupCaptionLines(ws, { endMs: 5500 });
    expect(ls.map((l) => [l.start_ms, l.end_ms])).toEqual([
      [0, 800],
      [1000, 1800],
      [5000, 5500],
    ]);
    for (let i = 0; i + 1 < ls.length; i++) expect(ls[i]!.end_ms).toBeLessThanOrEqual(ls[i + 1]!.start_ms);
    const tight = groupCaptionLines([w("A.", 0, 100), w("B.", 300, 400)]);
    expect(tight[0]!.end_ms).toBe(300);
  });

  it("emphasises 1–2 salient words", () => {
    expect(pickEmphasis(seq("Vector databases store embeddings"))).toEqual([3]);
    expect(pickEmphasis(seq("it takes 40 ms"))).toEqual([2]);
    expect(pickEmphasis(seq("so we ask Pinecone about HNSW"))).toEqual([3, 5]);
    expect(pickEmphasis(seq("and it is"))).toEqual([]);
    expect(groupCaptionLines(seq("Vector databases store embeddings"), { emphasis: false })[0]!.emphasis).toBeUndefined();
    expect(groupCaptionLines(seq("Vector databases store embeddings"))[0]!.emphasis).toEqual([3]);
  });
});

describe("sidecar writers", () => {
  it("SRT golden", () => {
    expect(toSrt(lines)).toBe(
      "1\n00:00:00,000 --> 00:00:01,000\nHello world.\n\n" +
        "2\n00:00:01,000 --> 00:00:01,800\nVector databases\n\n" +
        "3\n00:00:02,500 --> 00:00:03,400\nstore embeddings\n",
    );
  });

  it("VTT golden", () => {
    expect(toVtt(lines)).toBe(
      "WEBVTT\n\n" +
        "00:00:00.000 --> 00:00:01.000\nHello world.\n\n" +
        "00:00:01.000 --> 00:00:01.800\nVector databases\n\n" +
        "00:00:02.500 --> 00:00:03.400\nstore embeddings\n",
    );
  });

  it("sidecars show the caption's rows", () => {
    const [l] = groupCaptionLines(seq("Approximate nearest neighbour search"), { maxChars: 20 });
    expect(toSrt([l!])).toContain("\nApproximate nearest\nneighbour search\n");
    expect(toVtt([l!])).toContain("\nApproximate nearest\nneighbour search\n");
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
    expect(j.lines.map((l) => [l.first_word, l.word_count, l.rows, l.emphasis])).toEqual([
      [0, 2, ["Hello world."], [0]],
      [2, 2, ["Vector databases"], [3]],
      [4, 2, ["store embeddings"], [5]],
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
    expect(lines.map((l) => assKaraokeText(l))).toEqual(["{\\kf40}Hello {\\k5}{\\kf45}world.", "{\\kf30}Vector {\\kf50}databases", "{\\kf30}store {\\kf60}embeddings"]);
  });

  it("karaoke durations sum to the line length without rounding drift", () => {
    const ws = [w("a", 1004, 1336), w("b", 1336, 1668), w("c", 1668, 2001)];
    const [line] = groupCaptionLines(ws);
    const text = assKaraokeText(line!);
    const total = [...text.matchAll(/\\kf?(\d+)/g)].reduce((s, m) => s + Number(m[1]), 0);
    expect(total).toBe(Math.round(2001 / 10) - Math.round(1004 / 10));
    expect(text).toBe("{\\kf34}a {\\kf33}b {\\kf33}c"); // boundaries 100→134→167→200
  });

  it("golden file for 180x320 minimal: plate, emphasis, no karaoke", () => {
    const ass = toAss(lines, { width: 180, height: 320, preset: "minimal", font: "Arial", primary: "#FFFFFF", highlight: "#FFD60A" });
    expect(ass).toBe(
      [
        "[Script Info]",
        "; Generated by video-studio",
        "ScriptType: v4.00+",
        "PlayResX: 180",
        "PlayResY: 320",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "YCbCr Matrix: TV.709",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        // BorderStyle 3: an opaque box per row in the outline colour, 55% opaque (ASS alpha 0x73 = 255 − 140).
        "Style: Default,Arial,11,&H00FFFFFF,&H00FFFFFF,&H73000000,&H73000000,0,0,0,0,100,100,0,0,3,2,0,2,11,11,60,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        "Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\c&H0AD6FF&\\b1}Hello{\\c&HFFFFFF&\\b0} world.",
        "Dialogue: 0,0:00:01.00,0:00:01.80,Default,,0,0,0,,Vector {\\c&H0AD6FF&\\b1}databases{\\c&HFFFFFF&\\b0}",
        "Dialogue: 0,0:00:02.50,0:00:03.40,Default,,0,0,0,,store {\\c&H0AD6FF&\\b1}embeddings{\\c&HFFFFFF&\\b0}",
        "",
      ].join("\n"),
    );
  });

  it("karaoke only with activeWord; emphasis is bold there", () => {
    const ass = toAss(lines, { width: 180, height: 320, activeWord: true, highlight: "#FFD60A" });
    expect(ass).toContain("Style: Default,Arial,11,&H000AD6FF,&H00FFFFFF,");
    expect(ass).toContain(",,{\\kf40}{\\b1}Hello{\\b0} {\\k5}{\\kf45}world.");
    expect(toAss(lines, { width: 180, height: 320 })).not.toContain("\\kf");
    expect(toAss(lines, { width: 180, height: 320, emphasis: false })).toContain(",,Hello world.\n");
  });

  it("no plate with plateOpacity 0; bold preset keeps its outline and shadow", () => {
    const bold = toAss(lines, { width: 1080, height: 1920, preset: "bold", plateOpacity: 0 });
    expect(bold).toContain("Style: Default,Arial,86,&H00FFFFFF,&H00FFFFFF,&H00000000,&H7F000000,-1,0,0,0,100,100,0,0,1,6,3,2,65,65,352,1");
    expect(bold).toContain("PlayResX: 1080\nPlayResY: 1920");
    // Bold text: emphasis is colour only.
    expect(bold).toContain("{\\c&H0AD6FF&}databases{\\c&HFFFFFF&}");
    expect(toAss(lines, { width: 1920, height: 1080, marginV: 40, plateOpacity: 0 })).toMatch(/,0,0,1,3,0,2,115,115,43,1\n/);
  });

  it("places the block inside a caption box, or centred on position.y", () => {
    const box = { x: 90, y: 1300, w: 900, h: 230 };
    const o = { width: 1080, height: 1920, preset: "bold" as const, box };
    const layout = captionLayout(o);
    // 86 px bold does not fit two rows + plate in 230 px: the font shrinks.
    expect(layout.fontSize).toBeLessThan(86);
    expect(2 * layout.lineAdvance + 2 * layout.pad).toBeLessThanOrEqual(box.h);
    const ass = toAss(lines, o);
    expect(ass).toContain(`,3,${layout.pad},0,2,90,90,${1920 - 1530 + layout.pad},1`);
    const placed = captionBlockBox(lines, layout, o);
    expect(placed.y + placed.h).toBe(1530);
    expect(placed.y).toBeGreaterThanOrEqual(box.y);
    expect(placed.x).toBeGreaterThanOrEqual(box.x);
    expect(placed.x + placed.w).toBeLessThanOrEqual(box.x + box.w);
    const centred = toAss(lines, { ...o, positionY: 0.5 });
    expect(centred).toContain(",,{\\an5\\pos(540,960)}");
    const c = captionBlockBox(lines, captionLayout({ ...o, positionY: 0.5 }), o);
    expect(Math.abs(c.y + c.h / 2 - 960)).toBeLessThanOrEqual(1);
  });

  it("the row width used for grouping fits the box", () => {
    const layout = captionLayout({ width: 1080, height: 1920, box: { x: 90, y: 1260, w: 900, h: 270 } });
    const ls = groupCaptionLines(seq("Approximate nearest neighbour search trades a little exactness for a lot of speed"), { maxChars: layout.maxChars });
    const b = captionBlockBox(ls, layout, { width: 1080, height: 1920 });
    expect(b.w).toBeLessThanOrEqual(900);
    expect(b.h).toBeLessThanOrEqual(270);
  });

  it("neutralises override braces and backslashes in words", () => {
    const [line] = groupCaptionLines([w("{\\b1}x", 0, 100)]);
    expect(assKaraokeText(line!)).toBe("{\\kf10}(/b1)x");
  });
});

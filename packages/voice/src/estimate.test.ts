import { describe, expect, it } from "vitest";
import type { WordTiming } from "@video-studio/schema";
import { estimateSyllables, estimateWordTimings, pauseWeight, tokenize } from "./estimate.js";
import { parseEdgeSilence } from "./ffmpeg.js";

function assertWellFormed(words: WordTiming[]) {
  let prev = 0;
  for (const w of words) {
    expect(Number.isInteger(w.start_ms) && Number.isInteger(w.end_ms)).toBe(true);
    expect(w.start_ms).toBeGreaterThanOrEqual(prev);
    expect(w.end_ms).toBeGreaterThanOrEqual(w.start_ms);
    prev = w.end_ms;
  }
}

describe("tokenize", () => {
  it("splits on whitespace and attaches punctuation-only tokens to the previous word", () => {
    expect(tokenize("  Hello,   world — really ?  ")).toEqual(["Hello,", "world—", "really?"]);
    expect(tokenize("— leading dash")).toEqual(["—leading", "dash"]);
    expect(tokenize("...")).toEqual([]);
  });
});

describe("estimateSyllables", () => {
  it("counts vowel groups with a minimum of 1", () => {
    expect(estimateSyllables("cat")).toBe(1);
    expect(estimateSyllables("vector")).toBe(2);
    expect(estimateSyllables("database")).toBe(3); // silent e
    expect(estimateSyllables("table")).toBe(2); // -le keeps its syllable
    expect(estimateSyllables("rhythm")).toBe(1);
    expect(estimateSyllables("a")).toBe(1);
    expect(estimateSyllables("—")).toBe(1);
  });
  it("spells out short acronyms and counts digits", () => {
    expect(estimateSyllables("API")).toBe(3);
    expect(estimateSyllables("CI/CD")).toBe(4);
    expect(estimateSyllables("HTTP")).toBe(4);
    expect(estimateSyllables("30s")).toBe(3);
  });
  it("weights longer words more", () => {
    expect(estimateSyllables("internationalization")).toBeGreaterThan(estimateSyllables("world"));
  });
});

describe("pauseWeight", () => {
  it("adds 0.6 for clause punctuation and 1.2 for sentence ends", () => {
    expect(pauseWeight("word")).toBe(0);
    expect(pauseWeight("word,")).toBe(0.6);
    expect(pauseWeight("word;")).toBe(0.6);
    expect(pauseWeight("word.")).toBe(1.2);
    expect(pauseWeight('word?"')).toBe(1.2);
  });
});

describe("estimateWordTimings", () => {
  it("fills the duration exactly with no punctuation (weights by syllable)", () => {
    const words = ["a", "banana", "cat"];
    const t = estimateWordTimings(words, 1000);
    assertWellFormed(t);
    expect(t[0]!.start_ms).toBe(0);
    expect(t.at(-1)!.end_ms).toBe(1000);
    // contiguous: durations sum to total
    expect(t.reduce((s, w) => s + (w.end_ms - w.start_ms), 0)).toBe(1000);
    // banana (3) > a (1) = cat (1)
    const d = t.map((w) => w.end_ms - w.start_ms);
    expect(d[1]).toBe(600);
    expect(d[0]).toBe(200);
  });

  it("inserts pauses after punctuation but not after the last word", () => {
    const t = estimateWordTimings(["Hi,", "there.", "Bye."], 3800);
    assertWellFormed(t);
    // units: 1 + 0.6 + 1 + 1.2 + 1 = 4.8 → 791.67 ms/unit
    expect(t[1]!.start_ms - t[0]!.end_ms).toBe(475);
    expect(t[2]!.start_ms - t[1]!.end_ms).toBe(950);
    expect(t.at(-1)!.end_ms).toBe(3800);
  });

  it("respects leading/trailing silence and stays monotonic for long inputs", () => {
    const words = tokenize("Vector databases store embeddings, so similar things sit close together. Queries find neighbours fast!");
    const t = estimateWordTimings(words, 5000, { leadMs: 120, trailMs: 300 });
    assertWellFormed(t);
    expect(t[0]!.start_ms).toBe(120);
    expect(t.at(-1)!.end_ms).toBe(4700);
    expect(t.map((w) => w.word)).toEqual(words);
  });

  it("ignores edge silence that would swallow the audio, and handles tiny durations", () => {
    const t = estimateWordTimings(["one", "two"], 100, { leadMs: 80, trailMs: 50 });
    expect(t[0]!.start_ms).toBe(0);
    expect(t.at(-1)!.end_ms).toBe(100);
    assertWellFormed(estimateWordTimings(["a", "b", "c", "d", "e"], 3));
    expect(estimateWordTimings([], 1000)).toEqual([]);
  });
});

describe("parseEdgeSilence", () => {
  it("finds leading and trailing silence from silencedetect output", () => {
    const stderr = [
      "[silencedetect @ 0x1] silence_start: 0",
      "[silencedetect @ 0x1] silence_end: 0.12 | silence_duration: 0.12",
      "[silencedetect @ 0x1] silence_start: 0.8",
      "[silencedetect @ 0x1] silence_end: 0.95 | silence_duration: 0.15",
      "[silencedetect @ 0x1] silence_start: 1.7",
      "[silencedetect @ 0x1] silence_end: 2 | silence_duration: 0.3",
    ].join("\n");
    expect(parseEdgeSilence(stderr, 2000)).toEqual({ leadMs: 120, trailMs: 300 });
    expect(parseEdgeSilence("", 2000)).toEqual({ leadMs: 0, trailMs: 0 });
    // a single silence covering nearly everything is ignored
    expect(parseEdgeSilence("silence_start: 0\nsilence_end: 1.9", 2000)).toEqual({ leadMs: 0, trailMs: 0 });
  });
});

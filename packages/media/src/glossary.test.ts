import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWhisperJson } from "./asr.js";
import { applyGlossary, glossaryPrompt, mergeGlossary } from "./glossary.js";

const w = (text: string, start = 0, step = 300) => text.split(" ").map((word, i) => ({ word, start_ms: start + i * step, end_ms: start + i * step + step - 20 }));

describe("applyGlossary", () => {
  it("corrects the recorded whisper fixture: multi-word variants, punctuation and timings kept", () => {
    const words = parseWhisperJson(readFileSync(join(import.meta.dirname, "__fixtures__", "whisper-tdrz-apollo13.json"), "utf8"));
    const glossary = [
      { term: "Main B bus", variants: ["main beam"] },
      { term: "undervolt", variants: ["under volt", "up on a volt"] },
    ];
    const r = applyGlossary(words, glossary);
    const text = r.words.map((x) => x.word).join(" ");
    expect(text).toContain("We've had a Main B bus undervolt. Roger, Main B bus undervolt.");
    expect(r.corrections.map((c) => [c.from, c.to])).toEqual([
      ["main beam", "Main B bus"],
      ["up on a volt.", "undervolt."],
      ["main beam", "Main B bus"],
      ["under volt.", "undervolt."],
    ]);
    // The matched span keeps its start and end; the term's words spread evenly inside it.
    const c = r.corrections[0]!;
    const span = r.words.slice(c.index, c.index + 3);
    expect(span.map((x) => x.word)).toEqual(["Main", "B", "bus"]);
    expect(span[0]!.start_ms).toBe(c.start_ms);
    expect(span[2]!.end_ms).toBe(c.end_ms);
    // Every other word is untouched.
    expect(r.words.slice(0, c.index)).toEqual(words.slice(0, c.index));
    expect(r.words[0]).toEqual(words[0]);
    expect(r.words[r.words.length - 1]).toEqual(words[words.length - 1]);
  });

  it("replaces a single word, keeping its timing and extra fields", () => {
    const words = [
      { word: "Welcome", start_ms: 0, end_ms: 200, speaker: "S1" },
      { word: "to", start_ms: 220, end_ms: 300, speaker: "S1" },
      { word: "Acne!", start_ms: 320, end_ms: 700, speaker: "S1" },
    ];
    const r = applyGlossary(words, [{ term: "Acme", variants: ["acne"] }]);
    expect(r.words[2]).toEqual({ word: "Acme!", start_ms: 320, end_ms: 700, speaker: "S1" });
    expect(r.corrections).toEqual([{ from: "Acne!", to: "Acme!", term: "Acme", start_ms: 320, end_ms: 700, index: 2, words: 1 }]);
  });

  it("joins a multi-word variant into a one-word term covering the span, and keeps 1:1 timings for equal word counts", () => {
    const one = applyGlossary(w("try M S B docks today"), [{ term: "MSBDocs", variants: ["M S B docks"] }]);
    expect(one.words.map((x) => x.word)).toEqual(["try", "MSBDocs", "today"]);
    expect(one.words[1]).toMatchObject({ start_ms: 300, end_ms: 1480 });
    const two = applyGlossary(w("try msp docs today"), [{ term: "MSB Docs", variants: ["msp docs"] }]);
    expect(two.words.map((x) => [x.word, x.start_ms, x.end_ms])).toEqual([
      ["try", 0, 280],
      ["MSB", 300, 580],
      ["Docs", 600, 880],
      ["today", 900, 1180],
    ]);
  });

  it("ignores case unless case_sensitive, prefers the longest variant and never matches the term itself", () => {
    const g = [
      { term: "MSB Docs", variants: ["M S B docks"] },
      { term: "docs", variants: ["docks"] },
      { term: "RAG", variants: ["Rack"], case_sensitive: true },
    ];
    const r = applyGlossary(w("m s b DOCKS and docks with a rack and Rack but rag stays"), g);
    expect(r.words.map((x) => x.word).join(" ")).toBe("MSB Docs and docs with a rack and RAG but rag stays");
  });

  it("does not join words from different scenes", () => {
    const words = [
      { word: "main", start_ms: 0, end_ms: 200, scene_id: "a" },
      { word: "beam", start_ms: 200, end_ms: 400, scene_id: "b" },
    ];
    expect(applyGlossary(words, [{ term: "Main B bus", variants: ["main beam"] }]).corrections).toEqual([]);
  });

  it("is a no-op without a glossary", () => {
    const words = w("nothing to fix");
    expect(applyGlossary(words, undefined)).toEqual({ words, corrections: [] });
  });
});

describe("mergeGlossary", () => {
  it("adds the brand to the series; the brand wins a shared term and variants merge", () => {
    const series = [{ term: "msb docs", variants: ["msp docs"] }, { term: "RAG" }];
    const brand = [{ term: "MSB Docs", variants: ["M S B docks"], case_sensitive: false }, { term: "eBMR" }];
    expect(mergeGlossary(series, brand)).toEqual([
      { term: "MSB Docs", variants: ["msp docs", "M S B docks"], case_sensitive: false },
      { term: "RAG" },
      { term: "eBMR" },
    ]);
  });
});

describe("glossaryPrompt", () => {
  it("dedupes terms and caps the length at a whole term", () => {
    expect(glossaryPrompt([{ term: "MSB Docs" }, { term: "msb docs" }, { term: "eBMR" }])).toBe("MSB Docs, eBMR.");
    expect(glossaryPrompt([])).toBeUndefined();
    const long = Array.from({ length: 100 }, (_, i) => ({ term: `Term${i}` }));
    const p = glossaryPrompt(long, 60)!;
    expect(p.length).toBeLessThanOrEqual(60);
    expect(p).toMatch(/^Term0, Term1, .*Term\d+\.$/);
  });
});

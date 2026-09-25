import { describe, expect, it } from "vitest";
import { estimateWordTimings } from "./estimate.js";
import { mapTimingsToCaptions, prepareSpeechText } from "./text.js";

const brand = { language: { locale: "en-US", terminology: { "CI/CD": "C I C D", "Claude Code": "Clawd Code", k8s: "kubernetes" } } };

describe("prepareSpeechText", () => {
  it("replaces terms for speech but keeps original caption words", () => {
    const p = prepareSpeechText("Ship CI/CD, then k8s with Claude Code.", brand);
    expect(p.speech).toBe("Ship C I C D, then kubernetes with Clawd Code.");
    expect(p.captionWords).toEqual(["Ship", "CI/CD,", "then", "k8s", "with", "Claude", "Code."]);
    expect(p.spans[1]).toEqual({ captionStart: 1, captionEnd: 2, speechStart: 1, speechEnd: 5 });
  });

  it("is a no-op without a brand and matches case-sensitively", () => {
    const p = prepareSpeechText("ci/cd stays", brand);
    expect(p.speech).toBe("ci/cd stays");
    expect(prepareSpeechText("Plain text.").speech).toBe("Plain text.");
  });
});

describe("mapTimingsToCaptions", () => {
  it("keeps caption count and spreads a replaced span across its caption words", () => {
    const p = prepareSpeechText("Ship CI/CD, then k8s with Claude Code.", brand);
    const speechTimings = estimateWordTimings(p.speechWords, 4000);
    const caps = mapTimingsToCaptions(p, speechTimings);
    expect(caps.map((w) => w.word)).toEqual(p.captionWords);
    // CI/CD takes the whole range of "C I C D,"
    expect(caps[1]!.start_ms).toBe(speechTimings[1]!.start_ms);
    expect(caps[1]!.end_ms).toBe(speechTimings[4]!.end_ms);
    // "Claude Code." (2 words) ← "Clawd Code." (2 words): 1:1
    expect(caps[5]!.start_ms).toBe(speechTimings[8]!.start_ms);
    expect(caps.at(-1)!.end_ms).toBe(4000);
    let prev = 0;
    for (const w of caps) {
      expect(w.start_ms).toBeGreaterThanOrEqual(prev);
      expect(w.end_ms).toBeGreaterThanOrEqual(w.start_ms);
      prev = w.end_ms;
    }
  });

  it("spreads a multi-word caption term over a single speech token", () => {
    const p = prepareSpeechText("use Visual Studio Code now", { language: { locale: "en", terminology: { "Visual Studio Code": "VSCode" } } });
    expect(p.speechWords).toEqual(["use", "VSCode", "now"]);
    const t = mapTimingsToCaptions(p, [
      { word: "use", start_ms: 0, end_ms: 100 },
      { word: "VSCode", start_ms: 100, end_ms: 700 },
      { word: "now", start_ms: 700, end_ms: 900 },
    ]);
    expect(t.map((w) => w.word)).toEqual(["use", "Visual", "Studio", "Code", "now"]);
    expect(t[1]!.start_ms).toBe(100);
    expect(t[3]!.end_ms).toBe(700);
  });

  it("falls back to spreading the whole range when counts disagree", () => {
    const p = prepareSpeechText("one two three");
    const t = mapTimingsToCaptions(p, [{ word: "one", start_ms: 50, end_ms: 950 }]);
    expect(t.map((w) => w.word)).toEqual(["one", "two", "three"]);
    expect(t[0]!.start_ms).toBe(50);
    expect(t[2]!.end_ms).toBe(950);
  });
});

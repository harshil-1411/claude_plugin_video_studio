import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cueItemIndexes, cueItems, cueToken, kineticUnits, matchCue } from "./cues.js";
import { DETERMINISTIC_PROPS_EXAMPLES, type DeterministicKind, VideoSpec, validateVideoSpecSemantics } from "./video-spec.js";

describe("word cues", () => {
  it("matches words and phrases case- and punctuation-insensitively, by occurrence", () => {
    const words = ["Builds", "got", "40%", "faster.", "Then", "40%", "cheaper,", "too."];
    expect(cueToken("“Faster.”")).toBe("faster");
    expect(matchCue(words, { word: "faster" })).toBe(3);
    expect(matchCue(words, { word: "40%" })).toBe(2);
    expect(matchCue(words, { word: "40%", occurrence: 2 })).toBe(5);
    expect(matchCue(words, { word: "40% cheaper" })).toBe(5);
    expect(matchCue(words, { word: "40%", occurrence: 3 })).toBe(-1);
    expect(matchCue(words, { word: "slower" })).toBe(-1);
  });

  it("assigns items in order unless one is given", () => {
    expect(cueItemIndexes([{}, {}, {}])).toEqual([0, 1, 2]);
    expect(cueItemIndexes([{ item: 1 }, {}, { item: 0 }])).toEqual([1, 2, 0]);
  });

  it("defines items for every kind", () => {
    for (const [kind, props] of Object.entries(DETERMINISTIC_PROPS_EXAMPLES)) {
      expect(cueItems(kind as DeterministicKind, props).length, kind).toBeGreaterThan(0);
    }
    expect(cueItems("timeline", DETERMINISTIC_PROPS_EXAMPLES.timeline)).toEqual(["Ingest", "Plan", "Render"]);
    expect(cueItems("comparison", { left: {}, right: {} })).toEqual(["left", "right"]);
    expect(cueItems("chart", { type: "bar", series: [{ label: "a", value: 1 }, { label: "b", value: 2 }] })).toEqual(["a", "b"]);
    expect(cueItems("chart", { type: "stat", value: 40 })).toEqual(["40"]);
    expect(kineticUnits("Docs in. Video out.", "phrase")).toEqual(["Docs in.", "Video out."]);
    expect(cueItems("kinetic_text", { text: "Docs in. Video out.", rhythm: "word" })).toHaveLength(4);
  });
});

describe("cue validation", () => {
  const example = JSON.parse(readFileSync(fileURLToPath(new URL("../examples/explain-vector-db.video-spec.json", import.meta.url)), "utf8"));
  const base = (cues: unknown, extra: Record<string, unknown> = {}) =>
    VideoSpec.parse({
      ...example,
      target_duration_sec: 4,
      scenes: [
        {
          ...example.scenes[0],
          duration_sec: 4,
          voiceover: "First ingest, then plan, then render.",
          visual_strategy: "motion_graphic",
          deterministic: { kind: "timeline", props: DETERMINISTIC_PROPS_EXAMPLES.timeline },
          cues,
        },
      ],
      ...extra,
    });
  const cueErrors = (spec: VideoSpec) => validateVideoSpecSemantics(spec).errors.filter((e) => e.path.includes("cues"));

  it("accepts cues on spoken words", () => {
    expect(cueErrors(base([{ word: "ingest" }, { word: "plan" }, { word: "Render" }]))).toEqual([]);
  });

  it("rejects unspoken words, out-of-range and duplicate items", () => {
    const errs = cueErrors(base([{ word: "deploy" }, { word: "plan", item: 5 }, { word: "render", item: 0 }, { word: "ingest", item: 0 }]));
    expect(errs.map((e) => e.path)).toEqual(expect.arrayContaining(["scenes.0.cues.0.word", "scenes.0.cues.1", "scenes.0.cues.3"]));
    expect(errs.find((e) => e.path === "scenes.0.cues.1")!.message).toMatch(/has 3 item\(s\): 0 Ingest, 1 Plan, 2 Render/);
  });

  it("rejects cues when nothing is spoken", () => {
    const spec = base([{ word: "ingest" }], { voice: { ...example.voice, mode: "none" } });
    spec.scenes[0]!.voiceover = "";
    expect(cueErrors(spec)[0]!.message).toMatch(/voice.mode is "none"/);
  });
});

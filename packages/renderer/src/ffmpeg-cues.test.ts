import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFfmpeg, getTools } from "@video-studio/media";
import { DETERMINISTIC_PROPS_EXAMPLES, type DeterministicKind, type Scene, cueItems, kineticUnits } from "@video-studio/schema";
import { CUE_LEAD_S, countUpWindow } from "./cue-timing.js";
import { type Composition, FFMPEG_RENDERER_KINDS, buildFilterGraph, composeScene, createFfmpegRenderer, elementStarts, kineticChunks, motionTiming } from "./ffmpeg-renderer.js";
import { footageOverlay } from "./footage.js";
import { resolveTokens, targetForAspect } from "./tokens.js";
import type { RenderTarget, ResolvedCue } from "./types.js";

const target: RenderTarget = targetForAspect("9:16", { shortSide: 180, fps: 15 });
const tokens = resolveTokens();
const FONTS = { heading: "/f/h.ttf", body: "/f/b.ttf", mono: "/f/m.ttf" };
const IMG = { path: "/x.png", width: 160, height: 90 };
const DUR = 3;

function scene(kind: DeterministicKind, props: Record<string, unknown> = DETERMINISTIC_PROPS_EXAMPLES[kind], duration = DUR): Scene {
  return {
    id: "s01",
    duration_sec: duration,
    purpose: "point",
    voiceover: "",
    visual_strategy: "motion_graphic",
    deterministic: { kind, props },
    visual_requirements: { continuity_refs: [] },
    claim_refs: [],
  };
}

const inputsFor = (kind: DeterministicKind) => (kind === "screenshot" ? { image: IMG } : kind === "split_screen" ? { images: { left: IMG, right: IMG } } : {});

/** Composition plus each element's entrance start, with and without cues. */
function timed(kind: DeterministicKind, props: Record<string, unknown>, cues: ResolvedCue[]) {
  const comp = composeScene(scene(kind, props), target, tokens, inputsFor(kind));
  const { step, fade } = motionTiming(DUR, Math.max(0, ...comp.elements.map((e) => e.beat)), undefined);
  return { comp, step, fade, base: elementStarts(comp, step, fade), cued: elementStarts(comp, step, fade, cues) };
}

/** Earliest start of each item's elements. */
function itemStarts(comp: Composition, starts: number[]): Map<number, number> {
  const m = new Map<number, number>();
  comp.elements.forEach((el, k) => {
    if (el.item !== undefined) m.set(el.item, Math.min(m.get(el.item) ?? Infinity, starts[k]!));
  });
  return m;
}

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 3);

/** The cued item enters at at_s − lead; later items follow; items before it and non-items keep their times; offsets hold. */
function expectCued(kind: DeterministicKind, props: Record<string, unknown>, item: number, at: number) {
  const t = timed(kind, props, [{ item, at_s: at }]);
  const items = itemStarts(t.comp, t.cued);
  const defaults = itemStarts(t.comp, t.base);
  near(items.get(item)!, at - CUE_LEAD_S);
  for (const [i, s] of items) {
    if (i < item) near(s, defaults.get(i)!);
    if (i > item) expect(s).toBeGreaterThanOrEqual(items.get(item)! + t.step * (i - item) - 1e-6);
  }
  t.comp.elements.forEach((el, k) => {
    if (el.item === undefined) near(t.cued[k]!, t.base[k]!);
    // Elements of an item keep their offset from the item's start.
    else near(t.cued[k]! - items.get(el.item)!, t.base[k]! - defaults.get(el.item)!);
  });
  return t;
}

describe("word cues: item mapping per kind", () => {
  it("tags every kind's elements with valid cueItems indexes", () => {
    for (const kind of FFMPEG_RENDERER_KINDS) {
      const props = DETERMINISTIC_PROPS_EXAMPLES[kind];
      const n = cueItems(kind, props).length;
      const comp = composeScene(scene(kind, props), target, tokens, inputsFor(kind));
      const items = new Set(comp.elements.flatMap((e) => (e.item === undefined ? [] : [e.item])));
      expect(items.size, kind).toBeGreaterThan(0);
      for (const i of items) expect(i, kind).toBeLessThan(n);
    }
  });

  it("typography: each line (wrapped or not) is its lines entry", () => {
    const props = { lines: ["Short", "", "A much longer line that will surely wrap onto more than one row", "End"] };
    const t = expectCued("typography", props, 2, 2);
    const byItem = (i: number) => t.comp.elements.filter((e) => e.item === i);
    expect(byItem(0).length).toBe(1);
    expect(byItem(1).length).toBe(0);
    expect(byItem(2).length).toBeGreaterThan(1);
    expect(byItem(3).length).toBe(1);
  });

  it("timeline: each event with its dot, label and text", () => {
    const props = { events: [{ label: "2019", text: "First" }, { label: "2021" }, { label: "2023", text: "Now" }], current: 2 };
    const t = expectCued("timeline", props, 1, 2);
    expect(t.comp.elements.filter((e) => e.item === 2).length).toBeGreaterThanOrEqual(4);
  });

  it("comparison: left, right (panel, label and body), verdict", () => {
    const props = { left: { label: "A", text: "one" }, right: { label: "B", text: "two" }, verdict: "Both" };
    expectCued("comparison", props, 1, 1.5);
    const t = expectCued("comparison", props, 2, 2.5);
    // The body enters one beat after its side's panel.
    const right = t.comp.elements.map((e, k) => ({ e, k })).filter(({ e }) => e.item === 1);
    expect(Math.max(...right.map(({ k }) => t.base[k]!)) - Math.min(...right.map(({ k }) => t.base[k]!))).toBeCloseTo(t.step, 3);
  });

  it("chart bars: each series entry (label, track, fill, value); the title is not an item", () => {
    const props = { type: "bar", label: "Latency", series: [{ label: "a", value: 1 }, { label: "b", value: 2 }, { label: "c", value: 3 }] };
    const t = expectCued("chart", props, 1, 2);
    expect(t.comp.elements.filter((e) => e.item === 1).length).toBe(4);
    expect(t.comp.elements.some((e) => e.item === undefined)).toBe(true);
  });

  it("stat: the value's fade ends on its word; the label follows", () => {
    const props = { value: 40, unit: "%", label: "faster", context: "since v2" };
    const t = timed("stat", props, [{ item: 0, at_s: 2 }]);
    const items = itemStarts(t.comp, t.cued);
    near(items.get(0)!, countUpWindow(2, t.fade).start);
    expect(countUpWindow(2, t.fade).start + t.fade).toBeLessThanOrEqual(2);
    expect(items.get(1)!).toBeGreaterThan(items.get(0)!);
    // The label's own cue lands it normally.
    expectCued("stat", props, 1, 2.2);
  });

  it("chart stat: value and label are item 0 and count up to the word", () => {
    const t = timed("chart", { type: "stat", value: 7, label: "x" }, [{ item: 0, at_s: 1.5 }]);
    expect(t.comp.count_item).toBe(0);
    expect(new Set(t.comp.elements.map((e) => e.item))).toEqual(new Set([0]));
    near(Math.min(...t.cued), countUpWindow(1.5, t.fade).start);
  });

  it("kinetic_text: one item per kineticUnits unit, in both rhythms", () => {
    for (const rhythm of ["word", "phrase"] as const) {
      const props = { text: "Write once, render everywhere — ship today.", rhythm };
      expect(kineticChunks(props.text, rhythm)).toEqual(kineticUnits(props.text, rhythm));
      const units = cueItems("kinetic_text", props);
      const comp = composeScene(scene("kinetic_text", props), target, tokens);
      expect(new Set(comp.elements.map((e) => e.item))).toEqual(new Set(units.map((_, i) => i)));
      expectCued("kinetic_text", props, 1, 2);
    }
  });

  it("screenshot: each callout by its props index (pinned ones are drawn first)", () => {
    const props = { asset: "a1", callouts: ["Listed", { text: "Pinned", x: 0.5, y: 0.3 }, "Also listed"] };
    const t = expectCued("screenshot", props, 0, 2);
    const listed = t.comp.elements.find((e) => e.type === "text" && e.text === "Listed")!;
    expect(listed.item).toBe(0);
    expect(t.comp.elements.find((e) => e.type === "text" && e.text === "Pinned")!.item).toBe(1);
  });

  it("diagram: incoming edges draw with their later node; map routes with the point they reach", () => {
    const d = expectCued("diagram", { nodes: ["A", "B", "C"], edges: [["A", "B"], ["C", "A"]] }, 2, 2);
    expect(d.comp.elements.filter((e) => e.type === "box" && e.item === 2).length).toBeGreaterThan(2);
    const m = expectCued("map", { points: [{ label: "a", x: 0.1, y: 0.1 }, { label: "b", x: 0.9, y: 0.9 }], route: true }, 1, 2);
    expect(m.comp.elements.filter((e) => e.item === 1).length).toBeGreaterThan(3);
  });

  it("other kinds land their items", () => {
    expectCued("code", { language: "ts", code: "a\nb", highlight_lines: [2] }, 1, 2);
    expectCued("cta", { headline: "Go", action: "Install", command: "npm i x", url: "x.com" }, 1, 2);
    expectCued("end_card", { title: "T", subtitle: "S" }, 1, 2);
    expectCued("quote", { text: "Less is more", attribution: "Mies", source: "1947" }, 1, 2);
    expectCued("split_screen", DETERMINISTIC_PROPS_EXAMPLES.split_screen, 1, 2);
    expectCued("lower_third", { name: "Ada", title: "Engineer", headline: "Big news" }, 0, 2);
  });
});

describe("word cues: no cues changes nothing", () => {
  it("builds the identical filtergraph for every kind without cues and with cues: []", () => {
    for (const kind of FFMPEG_RENDERER_KINDS) {
      const comp = composeScene(scene(kind), target, tokens, inputsFor(kind));
      const a = buildFilterGraph(comp, target, DUR, FONTS, "/tmp/x");
      const b = buildFilterGraph(comp, target, DUR, FONTS, "/tmp/x", { cues: [] });
      expect(b.filtergraph, kind).toBe(a.filtergraph);
      expect(b.inputs, kind).toEqual(a.inputs);
      const { step, fade } = motionTiming(DUR, Math.max(0, ...comp.elements.map((e) => e.beat)));
      expect(elementStarts(comp, step, fade, []), kind).toEqual(comp.elements.map((e) => Math.round(e.beat * step * 1000) / 1000));
    }
  });

  it("changes the filtergraph when a cue moves an item", () => {
    const comp = composeScene(scene("timeline"), target, tokens);
    const a = buildFilterGraph(comp, target, DUR, FONTS, "/tmp/x").filtergraph;
    const b = buildFilterGraph(comp, target, DUR, FONTS, "/tmp/x", { cues: [{ item: 1, at_s: 2 }] }).filtergraph;
    expect(b).not.toBe(a);
    expect(b).toContain(`gte(t\\,${2 - CUE_LEAD_S})`);
  });

  it("times the footage overlay from the same cues", () => {
    const s: Scene = { ...scene("lower_third", { name: "Ada", headline: "Big news" }), footage: { asset: "v1" } } as Scene;
    const { comp } = footageOverlay({ scene: s, target, tokens });
    const a = buildFilterGraph(comp!, target, DUR, FONTS, "/tmp/x", { base: "[fg]", noExit: true }).filtergraph;
    const b = buildFilterGraph(comp!, target, DUR, FONTS, "/tmp/x", { base: "[fg]", noExit: true, cues: [{ item: 0, at_s: 2 }] }).filtergraph;
    expect(b).not.toBe(a);
    expect(b).toContain(`gte(t\\,${2 - CUE_LEAD_S})`);
  });
});

// One tiny real render (180x320, 3 s, 15 fps, ultrafast): a cue holds event 2 back until its word.
describe("word cues: pixels", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vs-cues-"));
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("draws the cued timeline event only after its word", async () => {
    const props = { events: [{ label: "A" }, { label: "B" }, { label: "C" }] };
    const out = join(dir, "cue.mp4");
    const renderer = createFfmpegRenderer({ encodePreset: "ultrafast" });
    await renderer.render({ scene: scene("timeline", props), target, tokens, out_path: out, project_dir: dir, cues: [{ item: 2, at_s: 2 }] });
    const tools = await getTools();
    // Mean luma of the third event's label row at 1.5 s (before the word) and 2.3 s (after it).
    const label = composeScene(scene("timeline", props), target, tokens).elements.find((e) => e.type === "text" && e.item === 2)!;
    if (label.type !== "text") throw new Error("no label");
    const x = Math.max(0, label.x - label.size);
    const crop = `crop=${Math.min(target.width - x, label.size * 3)}:${label.size}:${x}:${label.y}`;
    const luma = async (t: number) => {
      const raw = join(dir, `f${t}.gray`);
      await runFfmpeg(["-y", "-ss", String(t), "-i", out, "-frames:v", "1", "-vf", `${crop},format=gray`, "-f", "rawvideo", raw], { tools });
      const buf = await readFile(raw);
      return buf.reduce((a, b) => a + b, 0) / buf.length;
    };
    const before = await luma(1.5);
    const after = await luma(2.3);
    // The dark background stays empty until the word; then the light label is drawn.
    expect(after - before).toBeGreaterThan(10);
  }, 60_000);
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "@video-studio/core";
import { ffprobe, runFfmpeg, runProcess, getTools } from "@video-studio/media";
import type { DeterministicKind, Scene } from "@video-studio/schema";
import { DETERMINISTIC_PROPS_EXAMPLES } from "@video-studio/schema";
import { layoutZones } from "@video-studio/platforms";
import { buildFilterGraph, composeScene, createFfmpegRenderer, ffColor, frameCount, kineticChunks, motionTiming } from "./ffmpeg-renderer.js";
import { resolveTokens, targetForAspect } from "./tokens.js";
import type { RenderTarget } from "./types.js";

// Tiny clips only: 180x320, 1 s, 15 fps, x264 ultrafast.
const T = 60_000;
const target: RenderTarget = targetForAspect("9:16", { shortSide: 180, fps: 15 });
const tokens = resolveTokens();

function scene(kind: DeterministicKind, props: Record<string, unknown> = DETERMINISTIC_PROPS_EXAMPLES[kind], duration = 1): Scene {
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

const PROPS: Record<DeterministicKind, Record<string, unknown>[]> = {
  typography: [{ lines: ["Vector databases", "find meaning, fast: it's [100%] \\ literal %{pts}"], emphasis: "meaning" }],
  code: [{ language: "ts", code: "import { db } from 'x';\n\tconst hits = await db.search(q, { k: 5 });\nreturn hits;", highlight_lines: [2] }],
  chart: [
    { type: "stat", value: 40, unit: "%", label: "faster builds" },
    { type: "bar", label: "Latency (ms)", series: [{ label: "Postgres", value: 120 }, { label: "pgvector", value: 35 }, { label: "Neg", value: -3 }] },
    { type: "pie", series: [{ label: "a", value: 1 }, { label: "b", value: 2 }] },
  ],
  diagram: [{ nodes: ["Text", "Embed", "Index", "Query", "Answer"], edges: [["Text", "Embed"], ["Embed", "Index"], ["Query", "Index"], ["Index", "Answer"], ["Text", "Answer"]] }],
  screenshot: [{ asset: "a1", callouts: ["Click here", { text: "Pinned", x: 0.5, y: 0.3 }] }],
  comparison: [{ left: { label: "Keyword", text: "Matches exact words only" }, right: { label: "Vector", text: "Matches meaning" }, verdict: "Use both" }],
  cta: [{ headline: "Try it today", action: "Install", command: "npm install x", url: "example.com" }],
  end_card: [{ title: "video-studio", subtitle: "knowledge to video" }],
  quote: [DETERMINISTIC_PROPS_EXAMPLES.quote],
  stat: [DETERMINISTIC_PROPS_EXAMPLES.stat],
  timeline: [DETERMINISTIC_PROPS_EXAMPLES.timeline, { events: [{ label: "2019", text: "First prototype" }, { label: "2021" }, { label: "2023", text: "1M users" }], current: 2 }],
  split_screen: [DETERMINISTIC_PROPS_EXAMPLES.split_screen, { left: { label: "Old", text: "Manual", asset: "a1" }, right: { asset: "a1" } }],
  lower_third: [DETERMINISTIC_PROPS_EXAMPLES.lower_third],
  kinetic_text: [DETERMINISTIC_PROPS_EXAMPLES.kinetic_text, { text: "Write once, render everywhere, ship today.", rhythm: "phrase", emphasis: "everywhere" }],
  map: [DETERMINISTIC_PROPS_EXAMPLES.map],
};

const NEW_KINDS = ["quote", "stat", "timeline", "split_screen", "lower_third", "kinetic_text", "map"] as const satisfies readonly DeterministicKind[];
const IMG = { path: "/x.png", width: 160, height: 90 };
const inputsFor = (kind: DeterministicKind) => (kind === "screenshot" ? { image: IMG } : kind === "split_screen" ? { images: { left: IMG, right: IMG } } : {});

let dir: string;
const renderer = createFfmpegRenderer({ encodePreset: "ultrafast" });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vs-ffr-test-"));
  // Project with a screenshot asset referenced from source/content-ir.json.
  await mkdir(join(dir, "assets", "supplied"), { recursive: true });
  await mkdir(join(dir, "source"), { recursive: true });
  await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=s=160x90:d=0.1", "-frames:v", "1", join(dir, "assets", "supplied", "shot.png")]);
  await writeFile(join(dir, "source", "content-ir.json"), JSON.stringify({ assets: [{ id: "a1", kind: "image", path: "assets/supplied/shot.png", sha256: "0".repeat(64) }] }));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("pure parts", () => {
  it("counts frames and colours exactly", () => {
    expect(frameCount(1, 15)).toBe(15);
    expect(frameCount(2.52, 30)).toBe(76);
    expect(ffColor("#0B0F19")).toBe("0x0B0F19");
    expect(ffColor("#4F8CFF", 0.2)).toBe("0x4F8CFF@0.20");
  });

  it("finishes all motion by 60% of the clip", () => {
    const m = motionTiming(1, 5);
    expect(m.step * 5 + m.fade).toBeLessThanOrEqual(0.6 + 1e-9);
  });

  it("passes text through files, never through the filter string", () => {
    const comp = composeScene(scene("typography", PROPS.typography[0]!), target, tokens);
    const g = buildFilterGraph(comp, target, 1, { heading: "/f/h.ttf", body: "/f/b.ttf", mono: "/f/m.ttf" }, "/tmp/x");
    expect([...g.textFiles.values()].join("\n")).toContain("%{pts}");
    expect(g.filtergraph).not.toContain("Vector");
    expect(g.filtergraph).toContain("expansion=none");
    expect(g.filtergraph).toContain(`fontcolor=${ffColor(tokens.color_primary)}`);
  });

  it("lays out every kind inside the frame", () => {
    for (const [kind, list] of Object.entries(PROPS) as [DeterministicKind, Record<string, unknown>[]][]) {
      for (const props of list) {
        const comp = composeScene(scene(kind, props), target, tokens, inputsFor(kind));
        expect(comp.elements.length, kind).toBeGreaterThan(0);
        for (const el of comp.elements) {
          if (el.type === "text") continue;
          expect(el.x, `${kind} x`).toBeGreaterThanOrEqual(0);
          expect(el.y, `${kind} y`).toBeGreaterThanOrEqual(0);
          expect(el.x + el.w, `${kind} right`).toBeLessThanOrEqual(target.width);
          expect(el.y + el.h, `${kind} bottom`).toBeLessThanOrEqual(target.height);
        }
      }
    }
  });

  it("records a text box for every text block, inside the frame", () => {
    for (const [kind, list] of Object.entries(PROPS) as [DeterministicKind, Record<string, unknown>[]][]) {
      for (const props of list) {
        const comp = composeScene(scene(kind, props), target, tokens, inputsFor(kind));
        expect(comp.text_boxes.length, kind).toBeGreaterThan(0);
        for (const b of comp.text_boxes) {
          expect(b.font_px, kind).toBeGreaterThan(0);
          expect(b.color, kind).toMatch(/^#[0-9A-F]{6}$/);
          expect(b.background, kind).toMatch(/^#[0-9A-F]{6}$/);
          expect(b.rect.x + b.rect.w, `${kind} right`).toBeLessThanOrEqual(target.width);
        }
      }
    }
    const hook = composeScene({ ...scene("typography", { lines: ["Stop scrolling"] }), purpose: "hook" }, target, tokens);
    expect(hook.text_boxes).toEqual([expect.objectContaining({ role: "hook", text: "Stop scrolling", truncated: false, color: tokens.color_text, background: tokens.color_background })]);
    const cta = composeScene(scene("cta", PROPS.cta[0]!), target, tokens);
    expect(cta.text_boxes.map((b) => b.role)).toEqual(["cta", "cta", "code", "label"]);
    expect(cta.text_boxes[1]).toMatchObject({ color: tokens.color_background, background: tokens.color_primary });
    const long = composeScene(scene("typography", { lines: [Array(200).fill("overflow").join(" ")] }), target, tokens);
    expect(long.text_boxes[0]).toMatchObject({ role: "headline", truncated: true });
  });

  it("lays content inside zones.content when zones are given", () => {
    const zones = { ...layoutZones(target), content: { x: 20, y: 40, w: 100, h: 150 } };
    const comp = composeScene(scene("end_card", { title: "A title that wraps", subtitle: "sub" }), target, tokens, { zones });
    for (const b of comp.text_boxes) {
      expect(b.rect.x).toBeGreaterThanOrEqual(20);
      expect(b.rect.y).toBeGreaterThanOrEqual(40);
      expect(b.rect.x + b.rect.w).toBeLessThanOrEqual(120);
      expect(b.rect.y + b.rect.h).toBeLessThanOrEqual(190);
    }
  });

  it("warns about unsupported chart types and basic diagrams", () => {
    expect(composeScene(scene("chart", PROPS.chart[2]!), target, tokens).warnings.join()).toMatch(/pie.*stat/);
    expect(composeScene(scene("diagram", PROPS.diagram[0]!), target, tokens).warnings.join()).toMatch(/basic/);
  });
});

describe("reel grammar kinds", () => {
  const roles = (kind: DeterministicKind, props: Record<string, unknown> = DETERMINISTIC_PROPS_EXAMPLES[kind]) =>
    composeScene(scene(kind, props), target, tokens, inputsFor(kind)).text_boxes.map((b) => b.role);

  it("draws natively (no typography fallback) with text boxes inside the safe area", () => {
    const zones = layoutZones(target);
    const safe = zones.content;
    for (const kind of NEW_KINDS) {
      for (const props of PROPS[kind]) {
        const comp = composeScene(scene(kind, props), target, tokens, { ...inputsFor(kind), zones });
        expect(comp.warnings.join(), kind).not.toMatch(/typography card|not implemented/);
        for (const b of comp.text_boxes) {
          expect(b.truncated, `${kind} ${b.text}`).toBe(false);
          expect(b.rect.x, `${kind} ${b.text}`).toBeGreaterThanOrEqual(safe.x);
          expect(b.rect.y, `${kind} ${b.text}`).toBeGreaterThanOrEqual(safe.y);
          expect(b.rect.x + b.rect.w, `${kind} ${b.text}`).toBeLessThanOrEqual(safe.x + safe.w);
          expect(b.rect.y + b.rect.h, `${kind} ${b.text}`).toBeLessThanOrEqual(safe.y + safe.h);
        }
      }
    }
  });

  it("records sensible roles per kind", () => {
    expect(roles("quote")).toEqual(["decorative", "headline", "label", "label"]);
    expect(roles("stat")).toEqual(["headline", "label", "body"]);
    expect(roles("timeline")).toEqual(["label", "label", "label"]);
    expect(roles("split_screen")).toEqual(["label", "body", "label", "body"]);
    expect(roles("lower_third")).toEqual(["headline", "label", "label"]);
    expect(roles("lower_third", { name: "Ada" })).toEqual(["headline"]);
    expect(roles("kinetic_text")).toEqual(["headline"]);
    expect(roles("map")).toEqual(["headline", "label", "label"]);
    const hook = composeScene({ ...scene("stat"), purpose: "hook" }, target, tokens);
    expect(hook.text_boxes[0]).toMatchObject({ role: "hook", text: "40%", color: tokens.color_primary });
  });

  it("highlights the timeline's current event in the primary colour", () => {
    const comp = composeScene(scene("timeline", { events: [{ label: "A" }, { label: "B" }, { label: "C" }], current: 1 }), target, tokens);
    const label = (t: string) => comp.text_boxes.find((b) => b.text === t)!;
    expect(label("B").color).toBe(tokens.color_primary);
    expect(label("A").color).toBe(tokens.color_text);
    expect(label("C").color).toBe(tokens.color_text);
    const texts = comp.elements.filter((e) => e.type === "text");
    expect(texts.find((e) => e.text === "B")).toMatchObject({ color: tokens.color_primary, beat: 1 });
    expect(texts.find((e) => e.text === "C")).toMatchObject({ beat: 2 });
    const out = composeScene(scene("timeline", { events: [{ label: "A" }, { label: "B" }], current: 5 }), target, tokens);
    expect(out.warnings.join()).toMatch(/current 5 is outside/);
  });

  it("labels before_after panels and accents the after panel", () => {
    const comp = composeScene(scene("split_screen", DETERMINISTIC_PROPS_EXAMPLES.split_screen), target, tokens);
    const labels = comp.text_boxes.filter((b) => b.role === "label");
    expect(labels.map((b) => b.text)).toEqual(["Before", "After"]);
    expect(labels[1]!.color).toBe(tokens.color_primary);
    const custom = composeScene(scene("split_screen", { mode: "before_after", left: { label: "v1", text: "a" }, right: { label: "v2", text: "b" } }), target, tokens);
    expect(custom.text_boxes.filter((b) => b.role === "label").map((b) => b.text)).toEqual(["v1", "v2"]);
    const plain = composeScene(scene("split_screen", { left: { text: "a" }, right: { text: "b" } }), target, tokens);
    expect(plain.text_boxes.map((b) => b.role)).toEqual(["body", "body"]);
    const withImg = composeScene(scene("split_screen", PROPS.split_screen[1]!), target, tokens, { images: { left: IMG, right: IMG } });
    expect(withImg.elements.filter((e) => e.type === "image")).toHaveLength(2);
    const missing = composeScene(scene("split_screen", PROPS.split_screen[1]!), target, tokens, { images: { left: null, right: null } });
    expect(missing.elements.filter((e) => e.type === "image")).toHaveLength(0);
    expect(missing.text_boxes.filter((b) => b.role === "decorative")).toHaveLength(2);
  });

  it("chunks kinetic text by word or phrase, one beat per chunk, with emphasis words in primary", () => {
    expect(kineticChunks("Docs in. Video out.", "word")).toEqual(["Docs", "in.", "Video", "out."]);
    expect(kineticChunks("Write once, render everywhere, ship today.", "phrase")).toEqual(["Write once,", "render everywhere,", "ship today."]);
    const words = composeScene(scene("kinetic_text"), target, tokens).elements.filter((e) => e.type === "text");
    expect(words.map((e) => e.text)).toEqual(["Docs", "in.", "Video", "out."]);
    expect(words.map((e) => e.beat)).toEqual([0, 1, 2, 3]);
    expect(words.filter((e) => e.color === tokens.color_primary).map((e) => e.text)).toEqual(["Video"]);
    const phrases = composeScene(scene("kinetic_text", PROPS.kinetic_text[1]!), target, tokens).elements.filter((e) => e.type === "text");
    expect(phrases.map((e) => e.beat)).toEqual([0, 0, 1, 1, 2, 2]);
    expect(phrases.find((e) => e.text === "everywhere,")?.color).toBe(tokens.color_primary);
    expect(composeScene(scene("kinetic_text", { text: "a b", emphasis: "zzz" }), target, tokens).warnings.join()).toMatch(/emphasis "zzz" not found/);
  });

  it("pins map points and draws the route only when asked", () => {
    const withRoute = composeScene(scene("map"), target, tokens);
    const without = composeScene(scene("map", { ...DETERMINISTIC_PROPS_EXAMPLES.map, route: false }), target, tokens);
    const routeDots = (els: typeof withRoute.elements) => els.filter((e) => e.type === "box" && e.color === tokens.color_secondary).length;
    expect(routeDots(withRoute.elements)).toBeGreaterThan(2);
    expect(routeDots(without.elements)).toBe(0);
    const pins = withRoute.elements.filter((e) => e.type === "box" && e.color === tokens.color_primary);
    expect(pins).toHaveLength(2);
    // Laptop (0.3, 0.4) is left of and above CI (0.7, 0.6).
    expect(pins[0]!.x).toBeLessThan(pins[1]!.x);
    expect(pins[0]!.y).toBeLessThan(pins[1]!.y);
    expect(withRoute.text_boxes.filter((b) => b.role === "label").map((b) => b.text)).toEqual(["Laptop", "CI"]);
  });
});

describe("renders every kind", () => {
  const cases = (Object.entries(PROPS) as [DeterministicKind, Record<string, unknown>[]][]).flatMap(([kind, list]) => list.map((props, i) => ({ kind, props, i })));
  it.each(cases)("$kind #$i → exact dims, frames, duration, no audio", async ({ kind, props, i }) => {
    const out = join(dir, "out", `${kind}-${i}.mp4`);
    const res = await renderer.render({ scene: scene(kind, props), target, tokens, out_path: out, project_dir: dir });
    expect(res.duration_ms).toBe(1000);
    expect(res.renderer).toBe("ffmpeg-drawtext");
    expect(res.text_boxes?.length).toBeGreaterThan(0);
    if (kind === "screenshot" || kind === "split_screen") expect(res.warnings.join()).not.toMatch(/could not be resolved/);
    expect(res.warnings.join()).not.toMatch(/typography card/);
    const p = await ffprobe(out);
    expect([p.width, p.height]).toEqual([180, 320]);
    expect(p.video_codec).toBe("h264");
    expect(p.pix_fmt).toBe("yuv420p");
    expect(p.has_audio).toBe(false);
    expect(p.fps).toBe(15);
    expect(p.duration_s).toBeCloseTo(1, 3);
    const { ffprobe: bin } = await getTools();
    const { stdout } = await runProcess(bin, ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", out], { captureStdout: true });
    expect(Number(stdout.trim())).toBe(15);
  }, T);
});

describe("determinism and colour", () => {
  it("renders byte-identical output twice", async () => {
    const s = scene("comparison", PROPS.comparison[0]!);
    const a = join(dir, "det-a.mp4");
    const b = join(dir, "det-b.mp4");
    await renderer.render({ scene: s, target, tokens, out_path: a, project_dir: dir });
    await renderer.render({ scene: s, target, tokens, out_path: b, project_dir: dir });
    expect(sha256Hex(await readFile(a))).toBe(sha256Hex(await readFile(b)));
  }, T);

  it("paints the background token colour", async () => {
    const brandTokens = resolveTokens({ brand: { name: "x" }, visual: { fonts: { heading: "Helvetica", body: "Helvetica" }, palette: { background: "#1E6432" } } });
    const out = join(dir, "bg.mp4");
    await renderer.render({ scene: scene("end_card", { title: "Hi" }), target, tokens: brandTokens, out_path: out, project_dir: dir });
    const raw = join(dir, "bg.rgb");
    await runFfmpeg(["-y", "-i", out, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", raw]);
    const buf = await readFile(raw);
    expect(buf.length).toBe(180 * 320 * 3);
    const px = (x: number, y: number) => [...buf.subarray((y * 180 + x) * 3, (y * 180 + x) * 3 + 3)];
    for (const [x, y] of [[2, 2], [177, 2], [2, 317], [177, 317]] as const) {
      const [r, g, b] = px(x, y);
      expect(Math.abs(r! - 0x1e), `r@${x},${y}`).toBeLessThanOrEqual(4);
      expect(Math.abs(g! - 0x64), `g@${x},${y}`).toBeLessThanOrEqual(4);
      expect(Math.abs(b! - 0x32), `b@${x},${y}`).toBeLessThanOrEqual(4);
    }
  }, T);
});

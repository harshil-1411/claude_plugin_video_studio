import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "@video-studio/core";
import { ffprobe, runFfmpeg, runProcess, getTools } from "@video-studio/media";
import type { DeterministicKind, Scene } from "@video-studio/schema";
import { DETERMINISTIC_PROPS_EXAMPLES } from "@video-studio/schema";
import { layoutZones } from "@video-studio/platforms";
import { type AssFont, type AssTextFonts, assFontRuns, buildFilterGraph, composeScene, createFfmpegRenderer, easingExpr, ffColor, frameCount, kineticChunks, motionTiming, textRoute } from "./ffmpeg-renderer.js";
import { findStylesDir, getStyle } from "./styles.js";
import { applyTextCase } from "./text-layout.js";
import { createFontResolver, resolveTokens, targetForAspect } from "./tokens.js";
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

describe("style tokens", () => {
  const stylesDir = findStylesDir({});
  const styled = async (id: string) => resolveTokens(undefined, {}, await getStyle(stylesDir, id));
  const FONTS = { heading: "/f/h.ttf", body: "/f/b.ttf", mono: "/f/m.ttf" };
  const texts = (c: ReturnType<typeof composeScene>) => c.elements.filter((e) => e.type === "text");

  it("applies the heading case transform", () => {
    expect(applyTextCase("vector search in 30 seconds", "upper")).toBe("VECTOR SEARCH IN 30 SECONDS");
    expect(applyTextCase("the case for gRPC and an API of vectors", "title")).toBe("The Case for gRPC and an API of Vectors");
    expect(applyTextCase("keep as is", "as_is")).toBe("keep as is");
    expect(applyTextCase("keep as is", undefined)).toBe("keep as is");
  });

  it("upper-cases and scales headings, keeps body text, and records the final size", async () => {
    const t = await styled("energetic");
    const s = scene("cta", { headline: "Try it", action: "Install now", url: "example.com" });
    const base = composeScene(s, target, tokens);
    const comp = composeScene(s, target, t);
    const head = texts(comp).find((e) => e.font === "heading" && /TRY/.test(e.text))!;
    expect(head.text).toBe("TRY IT");
    expect(texts(comp).some((e) => e.text === "example.com")).toBe(true);
    const baseHead = texts(base).find((e) => e.text === "Try it")!;
    expect(head.size).toBeGreaterThan(baseHead.size);
    expect(head.size).toBeLessThanOrEqual(Math.floor(baseHead.size * 1.12) + 1);
    const box = comp.text_boxes.find((b) => b.role === "cta" && b.text === "TRY IT")!;
    expect(box.font_px).toBe(head.size);
    expect(box.color).toBe(t.color_text);
  });

  it("scales headings down for a scale below 1 and re-fits when the scaled size no longer fits", async () => {
    const t = await styled("minimal");
    const s = scene("typography", { lines: ["Calm"] });
    const a = texts(composeScene(s, target, tokens))[0]!;
    const b = texts(composeScene(s, target, t))[0]!;
    expect(b.size).toBeLessThan(a.size);
    // A long heading already at the box limit does not grow past it.
    const long = scene("typography", { lines: ["Vector databases find meaning fast across millions of documents"] });
    const big = composeScene(long, target, { ...tokens, heading_scale: 1.6 });
    expect(big.text_boxes[0]!.truncated).toBe(false);
    for (const e of texts(big)) expect(e.size).toBeLessThanOrEqual(Math.round(Math.min(target.width, target.height) * 0.12 * 1.6));
  });

  it("left-aligns headings at the box edge; centred text stays centred", async () => {
    const t = await styled("editorial");
    const comp = composeScene(scene("typography", { lines: ["one line", "and another"] }), target, t);
    const lines = texts(comp);
    expect(lines.map((e) => e.text)).toEqual(["One Line", "And Another"]);
    expect(lines.every((e) => e.cx === undefined)).toBe(true);
    expect(new Set(lines.map((e) => e.x)).size).toBe(1);
    const centred = texts(composeScene(scene("typography", { lines: ["one line"] }), target, tokens));
    expect(centred[0]!.cx).toBeDefined();
    // Kinetic words start at the left edge of the box too.
    const kin = texts(composeScene(scene("kinetic_text", { text: "go go go", rhythm: "word" }), target, t));
    const kinC = texts(composeScene(scene("kinetic_text", { text: "go go go", rhythm: "word" }), target, tokens));
    expect(kin[0]!.x).toBeLessThan(kinC[0]!.x);
  });

  it("times entrances from enter_ms/stagger_ms and keeps the 60% rule", () => {
    const motion = { personality: "energetic", easing: "spring", enter_ms: 350, exit_ms: 120, stagger_ms: 70, transition: "whip", transition_ms: 250 } as const;
    expect(motionTiming(3, 4, motion)).toEqual({ step: 0.07, fade: 0.35 });
    const tight = motionTiming(1, 20, motion);
    expect(tight.step * 20 + tight.fade).toBeLessThanOrEqual(0.6 + 1e-9);
    expect(motionTiming(3, 4, { ...motion, enter_ms: 0 }).fade).toBeGreaterThan(0);
    expect(motionTiming(1, 5)).toEqual(motionTiming(1, 5, undefined));
  });

  it("maps easing names to curves, with the original curve when no motion is set", () => {
    expect(easingExpr(undefined, "p")).toEqual({ alpha: "p", offset: "pow(1-p,2)" });
    expect(easingExpr("spring", "p").offset).toContain("cos(3*PI*p)");
    expect(easingExpr("linear", "p").offset).toBe("(1-p)");
    expect(new Set((["linear", "ease_out", "ease_in_out", "spring", "snap"] as const).map((e) => easingExpr(e, "p").offset)).size).toBe(5);
  });

  it("draws easing and the exit fade into the filtergraph only with motion tokens", async () => {
    const t = await styled("energetic");
    const comp = composeScene(scene("typography", { lines: ["A", "B"] }), target, t);
    const g = buildFilterGraph(comp, target, 1, FONTS, "/tmp/x", { motion: t.motion!, background: t.color_background });
    expect(g.filtergraph).toContain("cos(3*PI*");
    expect(g.filtergraph).toMatch(/fade=t=out:st=0\.813:d=0\.12:color=0x160B33/);
    const plain = buildFilterGraph(composeScene(scene("typography", { lines: ["A", "B"] }), target, tokens), target, 1, FONTS, "/tmp/x");
    expect(plain.filtergraph).not.toContain("fade=t=out");
    expect(plain.filtergraph).not.toContain("cos(");
    const tech = await styled("technical");
    const g2 = buildFilterGraph(composeScene(scene("typography", { lines: ["A"] }), target, tech), target, 1, FONTS, "/tmp/x", { motion: tech.motion!, background: tech.color_background });
    expect(g2.filtergraph).not.toContain("fade=t=out");
  });

  it("resolves heading/body font files at the style weights", async () => {
    const calls: Array<[string, number | undefined]> = [];
    const inner = createFontResolver();
    const r = createFfmpegRenderer({ encodePreset: "ultrafast", fontResolver: (family, weight) => (calls.push([family, weight]), inner(family, weight)) });
    const t = await styled("minimal");
    await r.render({ scene: scene("typography", { lines: ["Hi"] }), target, tokens: t, out_path: join(dir, "w.mp4"), project_dir: dir });
    expect(calls).toContainEqual([t.font_heading, 500]);
    expect(calls).toContainEqual([t.font_body, 400]);
    calls.length = 0;
    await r.render({ scene: scene("typography", { lines: ["Hi"] }), target, tokens, out_path: join(dir, "w2.mp4"), project_dir: dir });
    expect(calls).toContainEqual([tokens.font_heading, 700]);
    expect(calls).toContainEqual([tokens.font_body, undefined]);
  }, T);

  it("renders a styled clip whose last frame has faded to the background", async () => {
    const t = await styled("energetic");
    const out = join(dir, "energetic.mp4");
    const res = await renderer.render({ scene: scene("typography", { lines: ["Big", "Energy"] }), target, tokens: t, out_path: out, project_dir: dir });
    expect(res.text_boxes?.[0]?.text).toBe("BIG\nENERGY");
    const raw = join(dir, "last.rgb");
    await runFfmpeg(["-y", "-i", out, "-vf", "select=eq(n\\,14)", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", raw]);
    const buf = await readFile(raw);
    expect(buf.length).toBe(180 * 320 * 3);
    let maxDiff = 0;
    const bg = [0x16, 0x0b, 0x33];
    for (let i = 0; i < buf.length; i += 3) for (let k = 0; k < 3; k++) maxDiff = Math.max(maxDiff, Math.abs(buf[i + k]! - bg[k]!));
    expect(maxDiff).toBeLessThanOrEqual(24);
  }, T);
});

describe("scripts (CJK, Devanagari, Arabic)", () => {
  const FONTS = { heading: "/f/h.ttf", body: "/f/b.ttf", mono: "/f/m.ttf" };
  const assFont = (family: string, scale = 1.2): AssFont => ({ family, bold: true, scale, winAscent: 1, ascent: 0.9 });
  const ASS: AssTextFonts = {
    fontsDir: "/tmp/fonts",
    latin: { heading: assFont("Inter"), body: assFont("Inter"), mono: assFont("JetBrains Mono") },
    scripts: { arabic: { heading: assFont("Noto Sans Arabic", 2.169), body: assFont("Noto Sans Arabic", 2.169), mono: assFont("Noto Sans Arabic", 2.169) } },
  };

  it("routes lines: shaping scripts through libass, CJK through drawtext with a script font", () => {
    expect(textRoute("Vector databases")).toEqual({ kind: "drawtext" });
    expect(textRoute("ベクトルデータベース")).toEqual({ kind: "drawtext", script: "cjk" });
    expect(textRoute("Whisperは音声")).toEqual({ kind: "drawtext", script: "cjk" });
    expect(textRoute("नमस्ते API")).toEqual({ kind: "ass", script: "devanagari" });
    expect(textRoute("مرحبا Whisper")).toEqual({ kind: "ass", script: "arabic" });
  });

  it("splits libass lines into Latin and script font runs", () => {
    expect(assFontRuns("نموذج Whisper لعام 2022", "arabic")).toEqual([
      { latin: false, text: "نموذج " },
      { latin: true, text: "Whisper " },
      { latin: false, text: "لعام 2022" },
    ]);
    expect(assFontRuns("मॉडल (API) है।", "devanagari")).toEqual([
      { latin: false, text: "मॉडल (" },
      { latin: true, text: "API" },
      { latin: false, text: ") है।" },
    ]);
  });

  it("draws Arabic through an ass filter (right-aligned when the style aligns left) and CJK with the script font", () => {
    const t = { ...tokens, text_align: "left" as const };
    const ar = composeScene(scene("typography", { lines: ["قواعد البيانات المتجهة"] }), target, t);
    const line = ar.elements.find((e) => e.type === "text")!;
    expect(line.type === "text" && line.rx).toBeGreaterThan(target.width / 2);
    const built = buildFilterGraph(ar, target, 1, { ...FONTS, ass: ASS }, "/tmp/x", {});
    expect(built.filtergraph).toContain("ass=filename=/tmp/x/a0.ass:fontsdir=/tmp/fonts");
    expect(built.filtergraph).not.toContain("drawtext");
    const script = built.textFiles.get("a0.ass")!;
    expect(script).toContain("PlayResX: 180");
    expect(script).toMatch(/Style: Text,.*,-1$/m); // Encoding -1: libass picks the base direction
    expect(script).toContain("\\an9");
    expect(script).toContain("\\fnNoto Sans Arabic");
    expect(built.warnings).toEqual([]);

    const ja = composeScene(scene("typography", { lines: ["意味で検索します"] }), target, tokens);
    const jb = buildFilterGraph(ja, target, 1, { ...FONTS, scripts: { cjk: { heading: "/f/jp-bold.otf" } } }, "/tmp/x", {});
    expect(jb.filtergraph).toContain("fontfile=/f/jp-bold.otf");
    expect(jb.filtergraph).not.toContain("ass=");
  });

  it("warns when a shaping script has no libass to draw it", () => {
    const ar = composeScene(scene("typography", { lines: ["نموذج Whisper"] }), target, tokens);
    const built = buildFilterGraph(ar, target, 1, FONTS, "/tmp/x", {});
    expect(built.filtergraph).toContain("drawtext");
    expect(built.warnings.join()).toMatch(/right-to-left mixed with left-to-right runs.*FriBidi.*HyperFrames/);
  });

  it("places RTL kinetic words from the right edge in reading order", () => {
    const c = composeScene(scene("kinetic_text", { text: "نموذج التعرف", rhythm: "word" }), target, tokens);
    const words = c.elements.filter((e) => e.type === "text");
    expect(words.map((w) => w.type === "text" && w.text)).toEqual(["نموذج", "التعرف"]);
    const [a, b] = words as Array<{ x: number; y: number; rx?: number }>;
    if (a!.y === b!.y) expect(a!.x).toBeGreaterThan(b!.x);
    expect(a!.rx).toBeDefined();
  });

  const SCRIPT_SCENES = {
    ja: { lang: "ja", lines: ["ベクトルデータベースは、意味で検索します。", "Whisperは音声認識モデルです（2022年）"] },
    hi: { lang: "hi", lines: ["वेक्टर डेटाबेस अर्थ से खोजते हैं", "क्षत्रिय और Whisper मॉडल"] },
    ar: { lang: "ar", lines: ["قواعد البيانات المتجهة تبحث بالمعنى", "نموذج Whisper لعام 2022"] },
  } as const;
  const big = targetForAspect("9:16", { shortSide: 360, fps: 15 });
  it.each(Object.entries(SCRIPT_SCENES))("renders a %s typography scene at 360x640 without warnings", async (name, c) => {
    const out = join(dir, `script-${name}.mp4`);
    const t = resolveTokens(undefined, {}, undefined, { language: c.lang });
    const res = await renderer.render({ scene: scene("typography", { lines: [...c.lines] }), target: big, tokens: t, out_path: out, project_dir: dir });
    expect(res.warnings).toEqual([]);
    const p = await ffprobe(out);
    expect([p.width, p.height]).toEqual([360, 640]);
    const frame = join(process.env.VS_TEST_FRAMES_DIR ?? dir, `script-${name}.png`);
    await runFfmpeg(["-y", "-sseof", "-0.1", "-i", out, "-frames:v", "1", frame]);
    // Text was drawn: the last frame is not a flat background.
    const raw = join(dir, `script-${name}.gray`);
    await runFfmpeg(["-y", "-i", frame, "-f", "rawvideo", "-pix_fmt", "gray", raw]);
    const buf = await readFile(raw);
    expect(buf.filter((v) => v > 128).length).toBeGreaterThan(2000);
  }, T);
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "@video-studio/core";
import { ffprobe, runFfmpeg, runProcess, getTools } from "@video-studio/media";
import type { DeterministicKind, Scene } from "@video-studio/schema";
import { DETERMINISTIC_PROPS_EXAMPLES } from "@video-studio/schema";
import { layoutZones } from "@video-studio/platforms";
import { buildFilterGraph, composeScene, createFfmpegRenderer, ffColor, frameCount, motionTiming } from "./ffmpeg-renderer.js";
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
};

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
        const comp = composeScene(scene(kind, props), target, tokens, kind === "screenshot" ? { image: { path: "/x.png", width: 160, height: 90 } } : {});
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
        const comp = composeScene(scene(kind, props), target, tokens, kind === "screenshot" ? { image: { path: "/x.png", width: 160, height: 90 } } : {});
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

describe("renders every kind", () => {
  const cases = (Object.entries(PROPS) as [DeterministicKind, Record<string, unknown>[]][]).flatMap(([kind, list]) => list.map((props, i) => ({ kind, props, i })));
  it.each(cases)("$kind #$i → exact dims, frames, duration, no audio", async ({ kind, props, i }) => {
    const out = join(dir, "out", `${kind}-${i}.mp4`);
    const res = await renderer.render({ scene: scene(kind, props), target, tokens, out_path: out, project_dir: dir });
    expect(res.duration_ms).toBe(1000);
    expect(res.renderer).toBe("ffmpeg-drawtext");
    expect(res.text_boxes?.length).toBeGreaterThan(0);
    if (kind === "screenshot") expect(res.warnings.join()).not.toMatch(/could not be resolved/);
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

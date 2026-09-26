import { describe, expect, it } from "vitest";
import { DETERMINISTIC_PROPS_EXAMPLES, type DeterministicKind, type Scene } from "@video-studio/schema";
import { CUE_LEAD_S } from "./cue-timing.js";
import { OPENING_LEAD_MAX_S, openingLead, openingStart } from "./entrance.js";
import { type AssTextFonts, buildFilterGraph, composeScene, elementStarts, motionTiming } from "./ffmpeg-renderer.js";
import { footageOverlay } from "./footage.js";
import { buildComposition } from "./hyperframes-compose.js";
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

/** FFmpeg entrance starts of a scene, with the default and the cued timing. */
function ffmpegStarts(kind: DeterministicKind, props: Record<string, unknown>, cues?: ResolvedCue[]) {
  const comp = composeScene(scene(kind, props), target, tokens, kind === "screenshot" ? { image: IMG } : {});
  const { step, fade } = motionTiming(DUR, Math.max(0, ...comp.elements.map((e) => e.beat)));
  return { comp, step, fade, starts: elementStarts(comp, step, fade, cues) };
}

/** `--t` (s) of each entrance with class prefix `cls`. */
function hfTimes(kind: DeterministicKind, props: Record<string, unknown>, cls: string, cues?: ResolvedCue[], duration = 6): number[] {
  const html = buildComposition({ scene: scene(kind, props, duration), target, tokens, out_path: "/o.mp4", project_dir: "/p", ...(cues ? { cues } : {}) }).html;
  return [...html.matchAll(new RegExp(`class="${cls}[^"]*" style="--t:(-?[\\d.]+)s`, "g"))].map((m) => Number(m[1]));
}

describe("scene opening: the constant", () => {
  it("starts half an entrance early, at most 0.2 s", () => {
    expect(OPENING_LEAD_MAX_S).toBe(0.2);
    expect(openingLead(0.4)).toBe(0.2);
    expect(openingLead(0.3)).toBe(0.15);
    expect(openingLead(0.6)).toBe(0.2);
    expect(openingStart(0.1)).toBe(-0.05);
    expect(openingStart(0)).toBe(0);
  });
});

describe("scene opening: FFmpeg renderer", () => {
  it("pulls the first reveal (item 0 and the chrome drawn with it) before frame 0; later elements keep beat × step", () => {
    const t = ffmpegStarts("code", { language: "ts", code: "a\nb", highlight_lines: [2] });
    const first = Math.min(...t.comp.elements.map((e) => e.beat));
    t.comp.elements.forEach((el, k) => {
      if (el.beat === first) expect(t.starts[k], `${el.type} ${k}`).toBe(openingStart(t.fade));
      else expect(t.starts[k]).toBe(Math.round(el.beat * t.step * 1000) / 1000);
    });
    // The panel (chrome, no item) is part of it.
    expect(t.comp.elements.some((e, k) => e.type === "box" && e.item === undefined && t.starts[k] === openingStart(t.fade))).toBe(true);
  });

  it("the opening frame is not empty in any kind: something is already on screen at t = 0", () => {
    for (const kind of Object.keys(DETERMINISTIC_PROPS_EXAMPLES) as DeterministicKind[]) {
      const t = ffmpegStarts(kind, DETERMINISTIC_PROPS_EXAMPLES[kind]);
      expect(Math.min(...t.starts), kind).toBeLessThan(0);
    }
  });

  it("keeps a cued first item on its cue, but still opens with the chrome", () => {
    const t = ffmpegStarts("code", { language: "ts", code: "a\nb" }, [{ item: 0, at_s: 2 }]);
    t.comp.elements.forEach((el, k) => {
      if (el.item === 0) expect(t.starts[k]!).toBeGreaterThanOrEqual(2 - CUE_LEAD_S - 1e-9);
      else if (el.beat === 0) expect(t.starts[k]).toBe(openingStart(t.fade));
    });
    // A cue early in the scene is still kept exactly (clamped at 0, never pulled before frame 0).
    const early = ffmpegStarts("typography", { lines: ["One", "Two"] }, [{ item: 0, at_s: 0.05 }]);
    expect(early.starts[0]).toBe(0);
  });

  it("an uncued first item still opens when a later item is cued", () => {
    const t = ffmpegStarts("typography", { lines: ["One", "Two", "Three"] }, [{ item: 2, at_s: 2 }]);
    expect(t.starts[0]).toBe(openingStart(t.fade));
    expect(t.starts[1]).toBe(Math.round(t.step * 1000) / 1000);
    expect(t.starts[2]).toBeCloseTo(2 - CUE_LEAD_S, 3);
  });

  it("writes the early start into the graph: drawtext alpha, images trimmed, libass fades", () => {
    const typo = composeScene(scene("typography", { lines: ["One"] }), target, tokens);
    const g = buildFilterGraph(typo, target, DUR, FONTS, "/tmp/x");
    expect(g.filtergraph).toContain("alpha=min(1\\,max(0\\,(t+0.2)/0.4))");

    const shot = composeScene(scene("screenshot", { asset: "a1" }), target, tokens, { image: IMG });
    const s = buildFilterGraph(shot, target, DUR, FONTS, "/tmp/x");
    expect(s.inputs[0]).toContain((DUR + 0.2).toFixed(3));
    expect(s.filtergraph).toContain("fade=t=in:st=0:d=0.4:alpha=1,trim=start=0.2,setpts=PTS-STARTPTS");

    const font = { family: "Noto Sans Arabic", bold: true, scale: 1.2, winAscent: 1, ascent: 0.9 };
    const ASS: AssTextFonts = { fontsDir: "/tmp/fonts", latin: { heading: font, body: font, mono: font }, scripts: { arabic: { heading: font, body: font, mono: font } } };
    const ar = composeScene(scene("typography", { lines: ["مرحبا"] }), target, tokens);
    const a = buildFilterGraph(ar, target, DUR, { ...FONTS, ass: ASS }, "/tmp/x").textFiles.get("a0.ass")!;
    // Half-way in at the event start (0): alpha 50%, the remaining 200 ms to full.
    expect(a).toMatch(/Dialogue: 0,0:00:00\.00,.*\\fade\(128,0,0,0,200,200,200\)/);
  });

  it("footage overlays open the same way", () => {
    const s: Scene = { ...scene("lower_third", { name: "Ada", headline: "Big news" }), footage: { asset: "v1" } } as Scene;
    const { comp } = footageOverlay({ scene: s, target, tokens });
    const { step, fade } = motionTiming(DUR, Math.max(0, ...comp!.elements.map((e) => e.beat)));
    const starts = elementStarts(comp!, step, fade);
    expect(Math.min(...starts)).toBe(openingStart(fade));
    expect(buildFilterGraph(comp!, target, DUR, FONTS, "/tmp/x", { base: "[fg]", noExit: true }).filtergraph).toContain(`(t+${-openingStart(fade)})`);
  });
});

describe("scene opening: HyperFrames renderer", () => {
  it("pulls the first reveal before frame 0; later entrances keep their delays", () => {
    const t = hfTimes("typography", { lines: ["One", "Two", "Three"] }, "vs-a vs-fade-up");
    expect(t[0]).toBe(openingStart(0.6));
    expect(t[1]).toBeGreaterThan(0);
    expect(t[2]).toBeGreaterThan(t[1]!);
  });

  it("keeps cued items on their cue; an uncued first item still opens", () => {
    const cuedFirst = hfTimes("typography", { lines: ["One", "Two"] }, "vs-a vs-fade-up", [{ item: 0, at_s: 2 }]);
    expect(cuedFirst[0]).toBe(Math.round((2 - CUE_LEAD_S) * 1000) / 1000);
    const cuedLater = hfTimes("typography", { lines: ["One", "Two"] }, "vs-a vs-fade-up", [{ item: 1, at_s: 2 }]);
    expect(cuedLater[0]).toBe(openingStart(0.6));
    // An early cue (start clamped at 0) is not pulled before frame 0 either.
    expect(hfTimes("typography", { lines: ["One", "Two"] }, "vs-a vs-fade-up", [{ item: 0, at_s: 0.05 }])[0]).toBe(0);
  });

  it("every kind opens with something already entering at frame 0", () => {
    for (const kind of Object.keys(DETERMINISTIC_PROPS_EXAMPLES) as DeterministicKind[]) {
      const html = buildComposition({ scene: scene(kind), target, tokens, out_path: "/o.mp4", project_dir: "/p" }).html;
      expect(html, kind).toMatch(/--t:-0\.\d+s/);
    }
  });
});

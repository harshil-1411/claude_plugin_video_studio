import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { Scene } from "@video-studio/schema";
import { describe, expect, it } from "vitest";
import { buildComposition } from "./hyperframes-compose.js";
import { MOTION_CSP, composeMotion, scriptJson, splitMotionPage } from "./motion-compose.js";
import { MOTION_KIT_VERSION } from "./motion-kit.js";
import type { SceneRenderRequest, VisualTokens } from "./types.js";

const MORPH = readFileSync(new URL("./__fixtures__/motion/morph.html", import.meta.url), "utf8");
const TOKENS: VisualTokens = {
  font_heading: "Inter, Helvetica, Arial, sans-serif",
  font_body: "Inter, Helvetica, Arial, sans-serif",
  font_mono: "Menlo, monospace",
  color_background: "#0B0F19",
  color_text: "#F5F7FA",
  color_primary: "#4F8CFF",
  color_secondary: "#22C55E",
};

function req(props: Record<string, unknown> = {}, over: Partial<SceneRenderRequest> = {}): SceneRenderRequest {
  const scene: Scene = {
    id: "s01",
    duration_sec: 3,
    purpose: "point",
    voiceover: "",
    visual_strategy: "motion_graphic",
    deterministic: { kind: "motion", props: { html: "motion/morph.html", text: ["Docs in.", "Video out."], ...props } },
    visual_requirements: { continuity_refs: [] },
    claim_refs: [],
  };
  return { scene, target: { width: 1080, height: 1920, fps: 30, aspect_ratio: "9:16" }, tokens: TOKENS, out_path: "/out/s01.mp4", project_dir: "/proj", ...over };
}

async function loadLint(): Promise<{ lintHyperframeHtml: (html: string) => Promise<{ findings: Array<{ severity: string; code: string; message: string }> }> } | null> {
  try {
    const producer = import.meta.resolve("@hyperframes/producer");
    return await import(new URL("../../lint/dist/index.js", producer).href);
  } catch {
    return null;
  }
}

/** The inline <script> bodies of a page, in order. */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
}

describe("composeMotion", () => {
  it("puts the CSP meta first in <head>, with no connect-src", () => {
    const { html } = composeMotion(req(), MORPH);
    expect(html).toMatch(/<head>\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'; [^"]*">/);
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<script"));
    expect(MOTION_CSP).not.toContain("connect-src");
    expect(MOTION_CSP).toContain("default-src 'none'");
  });

  it("injects __vs and the kit before the author's head, and the adapter after the page", () => {
    const { html } = composeMotion(req(), MORPH);
    const at = (s: string) => html.indexOf(s);
    expect(at("window.__vs = ")).toBeGreaterThan(0);
    expect(at("window.__vs = ")).toBeLessThan(at("video-studio motion kit"));
    expect(at("video-studio motion kit")).toBeLessThan(at('href="morph.css"'));
    // Body scripts are moved after the root composition, before the adapter.
    expect(at('<script src="morph.js"></script>')).toBeGreaterThan(at("</div>\n</div>\n</div>"));
    expect(at('<script src="morph.js"></script>')).toBeLessThan(at("window.__timelines["));
    expect(html).toContain('<div id="vs-root" data-composition-id="vs-s01" data-start="0" data-duration="3" data-width="1080" data-height="1920" data-fps="30">');
    expect(html).toContain('<div id="vs-scene" class="clip vs-kind-motion" data-start="0" data-duration="3" data-track-index="0">');
    // The author's own charset, viewport and title are replaced by the composer's.
    expect(html.match(/<meta charset/g)?.length).toBe(1);
    expect(html).not.toContain("<title>Morph</title>");
  });

  it("passes window.__vs: timing, size, copy, beats, cues and the brand tokens", () => {
    const { html } = composeMotion(req({ loop: true }, { beats: { beats_s: [0.5, 1.0004], downbeats_s: [0.5] }, cues: [{ item: 1, at_s: 1.2 }] }), MORPH);
    const window: Record<string, any> = {};
    runInNewContext(inlineScripts(html)[0]!, { window });
    expect(window.__vs).toEqual({
      fps: 30,
      duration: 3,
      width: 1080,
      height: 1920,
      target: { width: 1080, height: 1920, aspect_ratio: "9:16" },
      text: ["Docs in.", "Video out."],
      beats: [0.5, 1],
      downbeats: [0.5],
      cues: [{ item: 1, at: 1.2 }],
      // Item 1 is cued: it starts CUE_LEAD_S before its word, not on the schedule.
      reveals: [0, 1.08],
      loop: true,
      tokens: {
        palette: { background: "#0B0F19", text: "#F5F7FA", primary: "#4F8CFF", secondary: "#22C55E" },
        fonts: { heading: TOKENS.font_heading, body: TOKENS.font_body, mono: TOKENS.font_mono },
      },
    });
    runInNewContext(inlineScripts(html)[1]!, { window });
    expect(window.vs.version).toBe(MOTION_KIT_VERSION);
    expect(window.vs.beatAt(0.7)).toBe(0.5);
  });

  it("reveals: readable times on the beat grid, one per text item (vs.revealAt)", () => {
    const beats = { beats_s: [0, 0.5, 1, 1.5, 2, 2.5], downbeats_s: [0, 2] };
    const three = req({ text: ["Docs in.", "Video out.", "Ship."] });
    const { html } = composeMotion({ ...three, beats, scene: { ...three.scene, duration_sec: 4.5 } }, MORPH);
    const window: Record<string, any> = {};
    runInNewContext(inlineScripts(html)[0]!, { window });
    // 120 BPM: each 2-word line holds 0.8 s after a 0.45 s entrance, so every 3rd beat.
    expect(window.__vs.reveals).toEqual([0, 1.5, 2.75]);
    runInNewContext(inlineScripts(html)[1]!, { window });
    expect(window.vs.revealAt(1)).toBe(1.5);
    expect(window.__vs.audio).toBeUndefined();
    expect(window.vs.energy(1)).toBe(0);
  });

  it("audio: the scene's envelope reaches the page as base64, read by vs.energy / bass / onset", () => {
    const b64 = (xs: number[]) => Buffer.from(xs).toString("base64");
    const audio = { fps: 30, rms: b64([0, 255, 0]), low: b64([255, 255, 0]), onset: b64([0, 0, 255]) };
    const { html } = composeMotion(req({}, { audio }), MORPH);
    const window: Record<string, any> = {};
    runInNewContext(inlineScripts(html)[0]!, { window });
    expect(window.__vs.audio).toEqual(audio);
    runInNewContext(inlineScripts(html)[1]!, { window });
    expect(window.vs.energy(1 / 30)).toBe(1);
    expect(window.vs.bass(1 / 60)).toBe(1);
    expect(window.vs.onset(1 / 60)).toBe(0);
    expect(window.vs.onset(2 / 30)).toBe(1);
    // A second of 30 fps envelope costs 3 × 40 base64 characters in the page.
    const second = { fps: 30, rms: b64(Array(30).fill(9)), low: b64(Array(30).fill(9)), onset: b64(Array(30).fill(9)) };
    const bigger = composeMotion(req({}, { audio: second }), MORPH).html.length - composeMotion(req(), MORPH).html.length;
    expect(bigger).toBeLessThan(200);
  });

  it("text cannot break out of the __vs script", () => {
    const evil = ["</script><script>alert(1)</script>", "a\u2028b\u2029c", "<!-- x", "&amp; <b>"];
    const { html } = composeMotion(req({ text: evil }), MORPH);
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).not.toContain("<!-- x");
    expect(html).not.toMatch(/[\u2028\u2029]/);
    const window: Record<string, any> = {};
    runInNewContext(inlineScripts(html)[0]!, { window });
    expect(window.__vs.text).toEqual(evil);
    expect(scriptJson({ a: "</script>" })).toBe('{"a":"\\u003c/script\\u003e"}');
  });

  it("is deterministic: the same inputs give byte-identical HTML", () => {
    expect(composeMotion(req(), MORPH).html).toBe(composeMotion(req(), MORPH).html);
    expect(composeMotion(req(), MORPH).html).not.toBe(composeMotion(req({ text: ["Other"] }), MORPH).html);
  });

  it("registers a paused timeline whose seek draws window.seek(t), gated on readyForCapture", async () => {
    const { html } = composeMotion(req(), MORPH);
    const adapter = inlineScripts(html).at(-1)!;
    const calls: number[] = [];
    let release!: () => void;
    const window: Record<string, any> = { seek: (t: number) => calls.push(t), readyForCapture: new Promise<void>((r) => (release = r)) };
    runInNewContext(adapter, { window, document: {}, Promise, Number, Math, console });
    const tl = window.__timelines["vs-s01"];
    expect(calls).toEqual([0]);
    tl.seek(1.5);
    tl.totalTime(9);
    tl.progress(0.5);
    expect(calls).toEqual([0, 1.5, 3, 1.5]);
    expect(tl.duration()).toBe(3);
    expect(tl.paused()).toBe(true);
    const ready = window.__hf.buildReady["vs-s01"];
    expect(typeof ready.then).toBe("function");
    release();
    await ready;
    expect(calls.at(-1)).toBe(1.5);
  });

  it("fits a page designed at another size into the target (contain, centred)", () => {
    const page = MORPH.replace("<head>", '<head>\n<meta name="vs-canvas" content="1080x1080">');
    const { html } = composeMotion(req({}, { target: { width: 540, height: 960, fps: 30, aspect_ratio: "9:16" } }), page);
    expect(html).toContain("#vs-canvas { position: absolute; left: 0; top: 0; width: 1080px; height: 1080px; overflow: hidden; left: 0px; top: 210px; transform: scale(0.5); transform-origin: 0 0; }");
    const window: Record<string, any> = {};
    runInNewContext(inlineScripts(html)[0]!, { window });
    expect([window.__vs.width, window.__vs.height]).toEqual([1080, 1080]);
    // Undeclared: the canvas is the target, unscaled.
    expect(composeMotion(req(), MORPH).html).not.toContain("transform: scale(");
  });

  it("splits pages with and without head/body tags", () => {
    expect(splitMotionPage("<div>x</div><script>1</script>")).toEqual({ head: "", body: "<div>x</div>", scripts: ["<script>1</script>"] });
    const s = splitMotionPage(MORPH);
    expect(s.head).toBe('<link rel="stylesheet" href="morph.css">');
    expect(s.scripts).toEqual(['<script src="morph.js"></script>']);
  });

  it("is what buildComposition returns for a motion scene (and it needs the page source)", () => {
    expect(buildComposition(req(), { motionHtml: MORPH }).html).toBe(composeMotion(req(), MORPH).html);
    expect(() => buildComposition(req())).toThrow(/needs its page source/);
  });

  it("passes the HyperFrames 0.8.78 linter with zero errors", async () => {
    const lint = await loadLint();
    expect(lint, "@hyperframes/producer lint must be resolvable for this test").not.toBeNull();
    for (const target of [req().target, { width: 1920, height: 1080, fps: 30, aspect_ratio: "16:9" as const }]) {
      const r = await lint!.lintHyperframeHtml(composeMotion(req({}, { target }), MORPH).html);
      expect(r.findings.filter((f) => f.severity === "error"), `${target.width}x${target.height}`).toEqual([]);
    }
  });
});

describe("composeMotion project fonts", () => {
  it("declares project font files under the chain's name and copies them under __vs/fonts", async () => {
    const { copyFileSync, mkdirSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { scanProjectFonts } = await import("./project-fonts.js");
    const { findFontsDir, withProjectFonts } = await import("./tokens.js");
    const bundled = findFontsDir({})!;
    const root = mkdtempSync(join(tmpdir(), "vs-motion-pfonts-"));
    try {
      mkdirSync(join(root, "fonts", "Field Sans"), { recursive: true });
      copyFileSync(join(bundled, "Inter/Inter-Regular.ttf"), join(root, "fonts", "Field Sans", "FieldSans-Regular.ttf"));
      const { index } = await scanProjectFonts(root);
      const tokens = withProjectFonts({ ...TOKENS, font_body: '"Field Sans", Inter, sans-serif' }, index);
      const c = composeMotion(req({}, { tokens, project_dir: root }), MORPH, { fontsDir: bundled });
      expect(c.html).toMatch(/@font-face \{ font-family: "Field Sans"; src: url\("__vs\/fonts\/FieldSans-Regular\.ttf"\) format\("truetype"\); font-weight: 400/);
      expect(c.assets).toContainEqual({ src: join(root, "fonts", "Field Sans", "FieldSans-Regular.ttf"), dest: "__vs/fonts/FieldSans-Regular.ttf" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

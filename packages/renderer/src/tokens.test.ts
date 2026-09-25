import { describe, expect, it } from "vitest";
import type { Brand } from "@video-studio/schema";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
  parseFontChain,
  resolveFontFile,
  resolveTokens,
  targetForAspect,
} from "./tokens.js";

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
    expect(bundledFontsStatus(null).present).toEqual([]);
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
  });
});

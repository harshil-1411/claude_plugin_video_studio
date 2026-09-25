import { describe, expect, it } from "vitest";
import type { Brand } from "@video-studio/schema";
import { DEFAULT_TOKENS, createFontResolver, normalizeHex, parseFontChain, resolveFontFile, resolveTokens, targetForAspect } from "./tokens.js";

describe("resolveTokens", () => {
  it("returns the defaults without a brand", () => {
    const t = resolveTokens();
    expect(t).toEqual({ ...DEFAULT_TOKENS });
    expect(t.color_background).toBe("#0B0F19");
    expect(t.color_text).toBe("#F5F7FA");
    expect(t.color_primary).toBe("#4F8CFF");
    expect(t.color_secondary).toBe("#22C55E");
    expect(parseFontChain(t.font_heading)).toEqual(["Inter", "Helvetica", "Arial", "sans-serif"]);
    expect(parseFontChain(t.font_mono)).toEqual(["Menlo", "DejaVu Sans Mono", "monospace"]);
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
    expect(t.font_heading).toBe('"Space Grotesk", Inter, Helvetica, Arial, sans-serif');
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
    expect(parseFontChain(t.font_heading)).toEqual(["Space Grotesk", "Inter", "Helvetica", "Arial", "Noto Sans JP", "sans-serif"]);
    expect(t.font_mono).toBe('Menlo, "DejaVu Sans Mono", "Noto Sans JP", Arial, monospace');
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
    expect(await resolveFontFile("Inter, Helvetica", {}, { fcMatch, exists, platform: "darwin" })).toBe("/fc/Inter.ttf");
    // Inter/Helvetica/Arial missing: substitutes are rejected until the generic family, which accepts fontconfig's default.
    const noInter = async () => "Verdana\n/fc/Verdana.ttf";
    expect(await resolveFontFile("Inter, Helvetica, Arial, sans-serif", {}, { fcMatch: noInter, exists, platform: "darwin" })).toBe("/fc/Verdana.ttf");
    expect(calls).toEqual(["Inter"]);
    // Without a generic family the named platform fallback wins over a substitute.
    expect(await resolveFontFile("Inter, Helvetica", {}, { fcMatch: noInter, exists, platform: "darwin" })).toBe("/System/Library/Fonts/Helvetica.ttc");
  });

  it("falls back to platform fonts without fontconfig", async () => {
    const fcMatch = async () => null;
    expect(await resolveFontFile("Inter, Helvetica, sans-serif", {}, { fcMatch, exists, platform: "darwin" })).toBe("/System/Library/Fonts/Helvetica.ttc");
    expect(await resolveFontFile('Menlo, "DejaVu Sans Mono"', {}, { fcMatch, exists, platform: "darwin" })).toBe("/System/Library/Fonts/Menlo.ttc");
    expect(await resolveFontFile("Inter", {}, { fcMatch, exists: async (p) => p.includes("dejavu/DejaVuSans.ttf"), platform: "linux" })).toBe(
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    );
    await expect(resolveFontFile("Inter", {}, { fcMatch, exists: async () => false, platform: "linux" })).rejects.toThrow(/no font file/);
  });

  it("resolves a real font on this machine", async () => {
    const resolve = createFontResolver();
    const file = await resolve(DEFAULT_TOKENS.font_heading);
    expect(file).toMatch(/\.(ttf|otf|ttc)$/i);
    expect(await resolve(DEFAULT_TOKENS.font_heading)).toBe(file);
  });
});

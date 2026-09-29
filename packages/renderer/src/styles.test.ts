import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Style, parseYamlOrJson } from "@video-studio/schema";
import { contrastRatio } from "../../mcp/src/lint.js";
import { findStylesDir, getStyle, loadStyles, styleIds, styleRef } from "./styles.js";
import { resolveTokens } from "./tokens.js";

const CORE = ["editorial", "energetic", "minimal", "technical"];

describe("styles/ packs", () => {
  const dir = findStylesDir({});

  it("finds the bundled styles/ directory (and honours CLAUDE_PLUGIN_ROOT)", () => {
    expect(dir).not.toBeNull();
    const root = mkdtempSync(join(tmpdir(), "vs-styles-root-"));
    mkdirSync(join(root, "styles"));
    writeFileSync(join(root, "styles", "README.md"), "x");
    expect(findStylesDir({ CLAUDE_PLUGIN_ROOT: root })).toBe(join(root, "styles"));
  });

  it("ships the four core packs, each valid against the Style schema with id = file name", async () => {
    const styles = await loadStyles(dir!);
    expect(styles.map((s) => s.id)).toEqual(expect.arrayContaining(CORE));
    for (const id of CORE) {
      const parsed = parseYamlOrJson(Style, readFileSync(join(dir!, `${id}.yaml`), "utf8"));
      expect(parsed.ok, `${id}: ${parsed.ok ? "" : JSON.stringify(parsed.errors)}`).toBe(true);
      expect((await getStyle(dir, id)).id).toBe(id);
    }
  });

  it("every palette is legible: text, primary and secondary reach 4.5:1 on the background", async () => {
    for (const s of await loadStyles(dir!)) {
      const t = resolveTokens(undefined, {}, s);
      for (const key of ["color_text", "color_primary", "color_secondary"] as const) {
        expect(contrastRatio(t[key], t.color_background), `${s.id} ${key}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("the core packs are clearly different looks", async () => {
    const styles = await Promise.all(CORE.map((id) => getStyle(dir, id)));
    const sig = (s: Style) => JSON.stringify([s.palette?.background, s.weights?.heading, s.text?.case, s.text?.align, s.motion.easing]);
    expect(new Set(styles.map(sig)).size).toBe(CORE.length);
    expect(new Set(styles.map((s) => s.palette?.background)).size).toBe(CORE.length);
    expect(new Set(styles.map((s) => s.motion.easing)).size).toBe(CORE.length);
  });

  it("every core pack has a taste guard (motion.avoid) that fits its personality", async () => {
    const avoid = Object.fromEntries(await Promise.all(CORE.map(async (id) => [id, new Set((await getStyle(dir, id)).motion.avoid ?? [])] as const)));
    // Nobody shakes the camera or splits RGB channels for polish; neon glow, synthwave grid floors and
    // decorative equalizer bars date a piece.
    for (const id of CORE) for (const e of ["shake", "neon_glow", "grid_floor", "eq_bars"]) expect(avoid[id]!.has(e as never), `${id} avoids ${e}`).toBe(true);
    // Calm packs ban every stock effect.
    expect(avoid.minimal!.size).toBe(10);
    expect(avoid.editorial!.size).toBeGreaterThanOrEqual(8);
    // Energetic keeps on-beat flashes and its spring overshoot; technical keeps a one-frame glitch on a cut.
    expect(avoid.energetic!.has("flash")).toBe(false);
    expect(avoid.energetic!.has("bouncy_easing")).toBe(false);
    expect(avoid.energetic!.has("rgb_split")).toBe(true);
    expect(avoid.technical!.has("rgb_split")).toBe(false);
    expect(avoid.technical!.has("bouncy_easing")).toBe(true);
  });

  it("unknown ids fail with the available ids; ids must match the file name", async () => {
    await expect(getStyle(dir, "nope")).rejects.toThrow(/unknown style "nope"; available: .*editorial.*minimal/);
    await expect(getStyle(dir, "../minimal")).rejects.toThrow(/unknown style/);
    await expect(getStyle(null, "minimal")).rejects.toThrow(/no styles\/ directory/);
    const bad = mkdtempSync(join(tmpdir(), "vs-styles-"));
    writeFileSync(join(bad, "calm.yaml"), readFileSync(join(dir!, "minimal.yaml"), "utf8"));
    await expect(getStyle(bad, "calm")).rejects.toThrow(/has id "minimal" but is named "calm.yaml"/);
    writeFileSync(join(bad, "broken.yaml"), "id: broken\nname: B\n");
    await expect(loadStyles(bad)).rejects.toThrow(/invalid style/);
    expect(await styleIds(bad)).toEqual(["broken", "calm"]);
  });

  it("styleRef is <id>@<version>", async () => {
    expect(styleRef(await getStyle(dir, "minimal"))).toBe("minimal@2");
  });
});

describe("project-local styles (<project>/styles/<id>.yaml)", () => {
  const dir = findStylesDir({});
  const PACK = (id: string, enter = 420) =>
    `id: ${id}\nname: Measured\nversion: 1\ndescription: measured from a reference; structure only\nmotion:\n  personality: friendly\n  easing: ease_out\n  enter_ms: ${enter}\n  exit_ms: 290\n  stagger_ms: 120\n  transition: crossfade\n  transition_ms: 340\n  avoid: []\n`;
  const project = () => {
    const root = mkdtempSync(join(tmpdir(), "vs-proj-styles-"));
    mkdirSync(join(root, "styles"));
    return root;
  };

  it("resolves from the project first, then the bundled packs; ids list both", async () => {
    const root = project();
    writeFileSync(join(root, "styles", "measured.yaml"), PACK("measured"));
    const s = await getStyle(dir, "measured", root);
    expect(s.motion.enter_ms).toBe(420);
    await expect(getStyle(dir, "measured")).rejects.toThrow(/unknown style "measured"/);
    expect((await getStyle(dir, "minimal", root)).id).toBe("minimal");
    expect(await styleIds(dir, root)).toEqual(expect.arrayContaining([...CORE, "measured"]));
    expect((await loadStyles(dir, root)).map((x) => x.id)).toContain("measured");
    await expect(getStyle(dir, "nope", root)).rejects.toThrow(/available: .*measured/);
    // Parsed as data with the Style schema; the id must equal the file name.
    writeFileSync(join(root, "styles", "other.yaml"), PACK("measured"));
    await expect(getStyle(dir, "other", root)).rejects.toThrow(/has id "measured" but is named "other.yaml"/);
    writeFileSync(join(root, "styles", "bad.yaml"), "id: bad\nname: B\nversion: 1\ndescription: x\nmotion: {}\n");
    await expect(getStyle(dir, "bad", root)).rejects.toThrow(/invalid style/);
  });

  it("a project pack shadows a bundled pack of the same id", async () => {
    const root = project();
    writeFileSync(join(root, "styles", "minimal.yaml"), PACK("minimal", 900));
    expect((await getStyle(dir, "minimal", root)).motion.enter_ms).toBe(900);
    expect((await loadStyles(dir, root)).find((x) => x.id === "minimal")!.motion.enter_ms).toBe(900);
    expect((await getStyle(dir, "minimal")).motion.enter_ms).toBe(600);
  });

  it("the ref carries the project file's sha256, so an edit changes tokens (the scene cache key)", async () => {
    const root = project();
    const file = join(root, "styles", "measured.yaml");
    writeFileSync(file, PACK("measured"));
    const a = await getStyle(dir, "measured", root);
    expect(styleRef(a)).toMatch(/^measured@1\+sha256:[0-9a-f]{64}$/);
    // Spreads (series palettes) keep the hash; JSON never sees it.
    expect(styleRef({ ...a, palette: { background: "#000000" } })).toBe(styleRef(a));
    expect(JSON.stringify(a)).not.toContain("sha256");
    const t1 = resolveTokens(undefined, {}, a).style;
    writeFileSync(file, PACK("measured", 430));
    const b = await getStyle(dir, "measured", root);
    expect(styleRef(b)).not.toBe(styleRef(a));
    expect(resolveTokens(undefined, {}, b).style).not.toBe(t1);
    expect(resolveTokens(undefined, {}, b).style).toBe(styleRef(b));
  });

  it("bundled packs keep their refs and tokens, with or without a project dir", async () => {
    const root = project();
    for (const id of CORE) {
      const plain = await getStyle(dir, id);
      const viaProject = await getStyle(dir, id, root);
      expect(styleRef(viaProject)).toBe(styleRef(plain));
      expect(styleRef(plain)).toBe(`${id}@${plain.version}`);
      expect(resolveTokens(undefined, {}, viaProject)).toEqual(resolveTokens(undefined, {}, plain));
    }
    expect(resolveTokens(undefined, {}, await getStyle(dir, "minimal", root)).style).toBe("minimal@2");
    // A project without styles/ changes nothing.
    expect(await styleIds(dir, mkdtempSync(join(tmpdir(), "vs-no-styles-")))).toEqual(await styleIds(dir));
  });
});

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
    expect(styleRef(await getStyle(dir, "minimal"))).toBe("minimal@1");
  });
});

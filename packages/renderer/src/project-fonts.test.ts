import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanProjectFonts } from "./project-fonts.js";
import {
  DEFAULT_TOKENS,
  createFontResolver,
  findFontsDir,
  fontFaceCss,
  matchProjectFont,
  prepareLibassFontsDir,
  projectFirstResolver,
  projectFontIndexFromTokens,
  readFontNames,
  resolveFontFile,
  resolveTokens,
  withProjectFonts,
} from "./tokens.js";

const bundled = findFontsDir({})!;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A project whose fonts/Field Sans/ holds copies of the bundled Inter (internal name stays "Inter"). */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), "vs-pfonts-"));
  dirs.push(root);
  const fam = join(root, "fonts", "Field Sans");
  mkdirSync(fam, { recursive: true });
  copyFileSync(join(bundled, "Inter/Inter-Regular.ttf"), join(fam, "FieldSans-Regular.ttf"));
  copyFileSync(join(bundled, "Inter/Inter-Bold.ttf"), join(fam, "FieldSans-Bold.ttf"));
  copyFileSync(join(bundled, "Inter/OFL.txt"), join(fam, "OFL.txt"));
  return root;
}

describe("readFontNames", () => {
  it("reads the internal family, weight and italic flag of real TTF/OTF files", () => {
    expect(readFontNames(join(bundled, "Inter/Inter-Regular.ttf"))).toEqual({ family: "Inter", weight: 400, italic: false });
    expect(readFontNames(join(bundled, "Inter/Inter-Bold.ttf"))).toEqual({ family: "Inter", weight: 700, italic: false });
    expect(readFontNames(join(bundled, "NotoSans/NotoSans-Bold.ttf"))).toEqual({ family: "Noto Sans", weight: 700, italic: false });
    expect(readFontNames(join(bundled, "NotoSansJP/NotoSansJP-Regular.otf"))?.family).toBe("Noto Sans JP");
    expect(readFontNames(join(bundled, "README.md"))).toBeNull();
  });
});

describe("scanProjectFonts", () => {
  it("indexes fonts/<Family>/ files by internal name, weight and folder alias, with hashes and the licence", async () => {
    const root = project();
    const { index, warnings } = await scanProjectFonts(root);
    expect(warnings).toEqual([]);
    expect(index!.fonts.map((f) => [f.file, f.family, f.alias, f.weight, f.italic, f.license])).toEqual([
      ["fonts/Field Sans/FieldSans-Bold.ttf", "Inter", "Field Sans", 700, false, "fonts/Field Sans/OFL.txt"],
      ["fonts/Field Sans/FieldSans-Regular.ttf", "Inter", "Field Sans", 400, false, "fonts/Field Sans/OFL.txt"],
    ]);
    expect(index!.fonts[1]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns no index without a fonts/ folder, and skips symlinks, junk files and files over the caps", async () => {
    const empty = mkdtempSync(join(tmpdir(), "vs-pfonts-"));
    dirs.push(empty);
    expect((await scanProjectFonts(empty)).index).toBeNull();
    const root = project();
    symlinkSync(join(bundled, "NotoSans/NotoSans-Regular.ttf"), join(root, "fonts", "Linked.ttf"));
    symlinkSync(join(bundled, "Inter"), join(root, "fonts", "Outside"));
    writeFileSync(join(root, "fonts", "Broken.ttf"), "not a font");
    const { index, warnings } = await scanProjectFonts(root);
    expect(index!.fonts.map((f) => f.file)).toEqual(["fonts/Field Sans/FieldSans-Bold.ttf", "fonts/Field Sans/FieldSans-Regular.ttf"]);
    expect(warnings.join("\n")).toMatch(/Linked\.ttf is a symbolic link/);
    expect(warnings.join("\n")).toMatch(/Outside is a symbolic link/);
    expect(warnings.join("\n")).toMatch(/Broken\.ttf is not a readable/);
    // Files count in path order (Broken.ttf, then Field Sans/FieldSans-Bold.ttf).
    const capped = await scanProjectFonts(root, { maxFiles: 2 });
    expect(capped.index!.fonts.map((f) => f.file)).toEqual(["fonts/Field Sans/FieldSans-Bold.ttf"]);
    expect(capped.warnings.join("\n")).toMatch(/more than 2 font files in fonts\/; 1 not used/);
    expect((await scanProjectFonts(root, { maxBytes: 1000 })).index).toBeNull();
  });
});

describe("project font resolution", () => {
  const brandTokens = () => resolveTokens({ brand: { name: "x" }, visual: { fonts: { heading: "Field Sans", body: "Field Sans" } } });

  it("matches by folder alias or internal name at the nearest weight", async () => {
    const { index } = await scanProjectFonts(project());
    expect(matchProjectFont(index, "Field Sans", 400)!.file).toMatch(/Regular/);
    expect(matchProjectFont(index, "FieldSans", 650)!.file).toMatch(/Bold/);
    expect(matchProjectFont(index, "inter", 500)!.file).toMatch(/Regular/);
    expect(matchProjectFont(index, "sans-serif", 400)).toBeNull();
    expect(matchProjectFont(index, "Roboto", 400)).toBeNull();
  });

  it("tries the project font before bundled, fontconfig and platform fonts", async () => {
    const { index } = await scanProjectFonts(project());
    const fcMatch = async () => "Field Sans\n/fc/Field.ttf";
    const exists = async () => true;
    const deps = { fcMatch, exists, fontsDir: bundled, projectFonts: index };
    expect(await resolveFontFile('"Field Sans", Inter, sans-serif', {}, deps, 700)).toBe(join(index!.root, "fonts/Field Sans/FieldSans-Bold.ttf"));
    // A bundled family earlier in the chain still wins.
    expect(await resolveFontFile('"Noto Sans", "Field Sans"', {}, deps)).toBe(join(bundled, "NotoSans/NotoSans-Regular.ttf"));
    const r = createFontResolver({}, deps);
    expect(await r('"Field Sans"', 400)).not.toBe(await r('"Field Sans"', 700));
    // An injected resolver gets the project font in front of it.
    const wrapped = projectFirstResolver(async () => "/base.ttf", index);
    expect(await wrapped('"Field Sans", Inter', 400)).toBe(join(index!.root, "fonts/Field Sans/FieldSans-Regular.ttf"));
    expect(await wrapped('Inter, "Field Sans"', 400)).toMatch(/FieldSans-Regular/); // Inter is also its internal name
    expect(await wrapped('"Noto Sans", "Field Sans"', 400)).toBe("/base.ttf");
    expect(projectFirstResolver(r, null)).toBe(r);
  });

  it("puts the fonts the chains name into the tokens (hashes, project-relative paths) and leaves other tokens untouched", async () => {
    const root = project();
    const { index } = await scanProjectFonts(root);
    const plain = resolveTokens();
    // Nothing named: the very same object (cache keys do not move). Inter is named by the default chain, so use Georgia.
    const georgia = { ...plain, font_heading: "Georgia", font_body: "Georgia", font_mono: "Courier" };
    expect(withProjectFonts(georgia, index)).toBe(georgia);
    expect(withProjectFonts(plain, null)).toBe(plain);
    const t = withProjectFonts(brandTokens(), index);
    const names = [...new Set(t.project_fonts!.map((f) => f.name))];
    expect(names).toEqual(["Field Sans", "Inter"]);
    expect(t.project_fonts!.every((f) => !f.file.startsWith("/") && f.sha256.length === 64)).toBe(true);
    // A caption family outside the chains is included too.
    expect(withProjectFonts(georgia, index, ["Field Sans"]).project_fonts).toHaveLength(2);
    // Round trip into an index for a renderer; refs escaping the project are ignored.
    const back = projectFontIndexFromTokens(t, root)!;
    expect(back.fonts.every((f) => f.path.startsWith(root))).toBe(true);
    expect(projectFontIndexFromTokens({ project_fonts: [{ ...t.project_fonts![0]!, file: "../x.ttf" }] }, root)).toBeNull();
  });

  it("emits @font-face rules under the CSS name the chain uses, with the file's real weight, before bundled ones it replaces", async () => {
    const root = project();
    const { index } = await scanProjectFonts(root);
    const t = withProjectFonts(brandTokens(), index);
    const css = fontFaceCss(t, { fontsDir: bundled, projectDir: root });
    const lines = css.split("\n");
    const field = lines.filter((l) => l.includes('font-family: "Field Sans"'));
    expect(field).toHaveLength(2);
    expect(field.join("\n")).toContain("FieldSans-Bold.ttf\") format(\"truetype\"); font-weight: 700; font-style: normal");
    expect(field.join("\n")).toContain("fonts/Field%20Sans/FieldSans-Regular.ttf");
    // Inter (the files' internal name) comes from the project too, never twice.
    const inter = lines.filter((l) => l.includes('font-family: "Inter"'));
    expect(inter).toHaveLength(2);
    expect(inter.every((l) => l.includes("FieldSans-"))).toBe(true);
    expect(lines.some((l) => l.includes('font-family: "Noto Sans"'))).toBe(true);
    // Without project fonts the rules are exactly the bundled ones.
    expect(fontFaceCss(DEFAULT_TOKENS, { fontsDir: bundled, projectDir: root })).toBe(fontFaceCss(DEFAULT_TOKENS, { fontsDir: bundled }));
  });

  it("links a project copy of a bundled file under its own name for libass", async () => {
    const root = project();
    const dest = mkdtempSync(join(tmpdir(), "vs-libass-"));
    dirs.push(dest);
    const copy = join(root, "fonts", "Inter-Regular.ttf");
    copyFileSync(join(bundled, "Inter/Inter-Regular.ttf"), copy);
    await prepareLibassFontsDir(dest, [join(bundled, "Inter/Inter-Regular.ttf"), copy], bundled);
    expect(readlinkSync(join(dest, "Inter-Regular.ttf"))).toBe(join(bundled, "Inter/Inter-Regular.ttf"));
    expect(readlinkSync(join(dest, "2-Inter-Regular.ttf"))).toBe(copy);
    expect(readFileSync(copy).length).toBeGreaterThan(0);
  });
});

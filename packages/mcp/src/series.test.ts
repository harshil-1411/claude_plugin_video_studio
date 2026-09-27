import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findStylesDir, getStyle, resolveTokens } from "@video-studio/renderer";
import { type Brand, VideoLock } from "@video-studio/schema";
import { describe, expect, it } from "vitest";
import { buildLock, withSeriesAssets } from "./lock.js";
import { SeriesLoadError, effectiveStyleId, loadSeries, resolveSeriesFile, seriesLook, seriesRecord, seriesUsage } from "./series.js";
import { validateSpecFile } from "./spec-validate.js";

const LINT_FIXTURE = join(import.meta.dirname, "__fixtures__", "lint", "tiktok-low-captions");

const BIBLE = `schema_version: "1.0"
id: intro-series
name: Intro series
palette:
  background: "#101820"
characters:
  - id: host
    name: Ava
    description: Round glasses, teal jacket.
    voice_id: Samantha
    references: [refs/host.png]
  - id: sidekick
    name: Bit
    description: A small cube robot.
    references: [refs/bit.png]
locations:
  - id: lab
    description: A white lab with one window.
motifs:
  - id: toggle
    description: A toggle that flips on.
    asset: refs/toggle.svg
`;

/** <root>/series.yaml + refs/, and <root>/ep1 (the lint fixture) whose spec points at ../series.yaml. */
function seriesProject(bible = BIBLE, edit?: (spec: Record<string, any>) => void): { root: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), "vs-series-"));
  mkdirSync(join(root, "refs"));
  writeFileSync(join(root, "series.yaml"), bible);
  writeFileSync(join(root, "refs", "host.png"), "host-v1");
  writeFileSync(join(root, "refs", "bit.png"), "bit-v1");
  writeFileSync(join(root, "refs", "toggle.svg"), "<svg/>");
  const project = join(root, "ep1");
  cpSync(LINT_FIXTURE, project, { recursive: true });
  const p = join(project, "project", "video-spec.json");
  const spec = JSON.parse(readFileSync(p, "utf8"));
  spec.series = "../series.yaml";
  spec.scenes[0].series_refs = ["host", "lab"];
  spec.scenes[1].series_refs = ["sidekick"];
  edit?.(spec);
  writeFileSync(p, JSON.stringify(spec, null, 2));
  return { root, project };
}
const specOf = (dir: string) => join(dir, "project", "video-spec.json");
const errOf = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as SeriesLoadError);

describe("loadSeries", () => {
  it("reads the bible next to the episodes and hashes it", async () => {
    const { root, project } = seriesProject();
    const s = await loadSeries(project, "../series.yaml");
    expect(s.series.characters?.map((c) => c.id)).toEqual(["host", "sidekick"]);
    expect(s.dir).toBe(realpathSync(root));
    expect(s.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(seriesRecord(s, { files: [] })).toMatchObject({ id: "intro-series", path: "../series.yaml", sha256: s.sha256 });
  });

  it("reports a missing file, a syntax error with its line, and schema issues with paths", async () => {
    const { project, root } = seriesProject();
    const missing = await errOf(loadSeries(project, "../nope.yaml"));
    expect(missing).toBeInstanceOf(SeriesLoadError);
    expect(missing!.issues[0]!.message).toMatch(/series file not found: \.\.\/nope\.yaml/);
    writeFileSync(join(root, "bad.yaml"), 'schema_version: "1.0"\nid: x\nname: [unclosed\n');
    const syntax = await errOf(loadSeries(project, "../bad.yaml"));
    expect(syntax!.issues[0]!.message).toMatch(/syntax error.*line \d/is);
    writeFileSync(join(root, "schema.yaml"), 'schema_version: "1.0"\nid: x\nname: X\ncharacters:\n  - id: a\n    name: A\n');
    const schema = await errOf(loadSeries(project, "../schema.yaml"));
    expect(schema!.issues.map((i) => i.path)).toContain("series:characters.0.description");
    expect(await errOf(loadSeries(project, "/etc/series.yaml"))).toBeInstanceOf(SeriesLoadError);
  });

  it("confines reference files to the bible's folder, symlinks included", async () => {
    const { root, project } = seriesProject();
    const s = await loadSeries(project, "../series.yaml");
    expect(await resolveSeriesFile(s, "refs/host.png")).toHaveProperty("abs");
    expect(await resolveSeriesFile(s, "../x.png")).toEqual({ error: expect.stringMatching(/inside the series folder/) });
    const outside = mkdtempSync(join(tmpdir(), "vs-series-out-"));
    writeFileSync(join(outside, "secret.png"), "x");
    symlinkSync(join(outside, "secret.png"), join(root, "refs", "leak.png"));
    expect(await resolveSeriesFile(s, "refs/leak.png")).toEqual({ error: expect.stringMatching(/symlink that leaves/) });
    expect(await resolveSeriesFile(s, "refs/none.png")).toEqual({ error: expect.stringMatching(/not found/) });
  });

  it("follows a symlinked bible to its real folder", async () => {
    const { root } = seriesProject();
    const ep = mkdtempSync(join(tmpdir(), "vs-series-ep-"));
    symlinkSync(join(root, "series.yaml"), join(ep, "series.yaml"));
    const s = await loadSeries(ep, "series.yaml");
    expect(await resolveSeriesFile(s, "refs/host.png")).toHaveProperty("abs");
  });
});

describe("seriesUsage: cache-key isolation", () => {
  it("changing one character moves only the key of the scene that shows it", async () => {
    const { root, project } = seriesProject();
    const scenes = [
      { id: "s01", series_refs: ["host", "lab"] },
      { id: "s02", series_refs: ["sidekick"] },
      { id: "s03" },
    ];
    const before = await seriesUsage(await loadSeries(project, "../series.yaml"), scenes);
    expect([...before.keys.keys()]).toEqual(["s01", "s02"]);
    expect(before.files.map((f) => f.path)).toEqual(["../refs/bit.png", "../refs/host.png"]);

    // Edit the sidekick's description: only s02 moves.
    writeFileSync(join(root, "series.yaml"), BIBLE.replace("A small cube robot.", "A small round robot."));
    const desc = await seriesUsage(await loadSeries(project, "../series.yaml"), scenes);
    expect(desc.keys.get("s01")).toEqual(before.keys.get("s01"));
    expect(desc.keys.get("s02")).not.toEqual(before.keys.get("s02"));

    // Replace the host's reference image: only s01 moves.
    writeFileSync(join(root, "refs", "host.png"), "host-v2");
    const img = await seriesUsage(await loadSeries(project, "../series.yaml"), scenes);
    expect(img.keys.get("s01")).not.toEqual(desc.keys.get("s01"));
    expect(img.keys.get("s02")).toEqual(desc.keys.get("s02"));
  });

  it("fails on an unknown id or an unusable reference", async () => {
    const { project } = seriesProject();
    const s = await loadSeries(project, "../series.yaml");
    await expect(seriesUsage(s, [{ id: "s01", series_refs: ["hots"] }])).rejects.toThrow(/no entry "hots"/);
  });
});

describe("seriesLook: defaults < series < spec style < brand", () => {
  const stylesDir = findStylesDir();
  const series = { schema_version: "1.0", id: "x", name: "X", style: "minimal", palette: { background: "#101820", secondary: "#ABCDEF" } } as const;

  it("without a series the tokens are unchanged", async () => {
    const style = await getStyle(stylesDir, "editorial");
    const look = seriesLook(undefined, "editorial", style);
    expect(resolveTokens(undefined, look.defaults, look.style)).toEqual(resolveTokens(undefined, {}, style));
    expect(effectiveStyleId(undefined, undefined)).toBeUndefined();
  });

  it("the series palette is over the series' style pack", async () => {
    expect(effectiveStyleId(undefined, series)).toBe("minimal");
    const style = await getStyle(stylesDir, "minimal");
    const look = seriesLook(series, undefined, style);
    const t = resolveTokens(undefined, look.defaults, look.style);
    expect(t.color_background).toBe("#101820");
    expect(t.style).toMatch(/^minimal@/);
    expect(t.color_primary).toBe(resolveTokens(undefined, {}, style).color_primary);
  });

  it("a spec style beats the series look; the series palette fills what it leaves open; brand wins", async () => {
    expect(effectiveStyleId("editorial", series)).toBe("editorial");
    const style = await getStyle(stylesDir, "editorial");
    const look = seriesLook(series, "editorial", style);
    const t = resolveTokens(undefined, look.defaults, look.style);
    expect(t.color_background).toBe(style.palette!.background!.toUpperCase());
    // No style: the series palette applies over the renderer defaults.
    const bare = seriesLook(series, undefined, undefined);
    expect(resolveTokens(undefined, bare.defaults, bare.style).color_secondary).toBe("#ABCDEF");
    const brand = { visual: { palette: { background: "#000000" }, fonts: {} } } as unknown as Brand;
    expect(resolveTokens(brand, look.defaults, look.style).color_background).toBe("#000000");
    const own = seriesLook(series, undefined, await getStyle(stylesDir, "minimal"));
    expect(resolveTokens(brand, own.defaults, own.style).color_background).toBe("#000000");
  });
});

describe("spec_validate: series stage", () => {
  it("accepts a bible whose entries and files exist", async () => {
    const { project } = seriesProject();
    const r = await validateSpecFile(specOf(project), null);
    expect(r.errors.filter((e) => e.stage === "series")).toEqual([]);
  });

  it("suggests the closest ids for an unknown entry", async () => {
    const { project } = seriesProject(BIBLE, (s) => (s.scenes[1].series_refs = ["sidekik"]));
    const r = await validateSpecFile(specOf(project), null);
    const e = r.errors.filter((x) => x.stage === "series");
    expect(r.ok).toBe(false);
    expect(e).toEqual([expect.objectContaining({ path: "scenes.1.series_refs", fix: expect.stringMatching(/^use one of "sidekick"/) })]);
  });

  it("reports a missing bible, a missing reference file, and an unknown series style", async () => {
    const gone = seriesProject(BIBLE, (s) => (s.series = "../other.yaml"));
    expect((await validateSpecFile(specOf(gone.project), null)).errors.find((e) => e.stage === "series")?.message).toMatch(/not found/);
    const { root, project } = seriesProject(BIBLE.replace('name: Intro series', "name: Intro series\nstyle: minimall"));
    rmSync(join(root, "refs", "bit.png"));
    const r = await validateSpecFile(specOf(project), null);
    const msgs = r.errors.filter((e) => e.stage === "series").map((e) => `${e.path}: ${e.message} / ${e.fix}`);
    expect(msgs).toEqual([expect.stringMatching(/^scenes\.1\.series_refs: series entry "sidekick": "refs\/bit\.png" not found/), expect.stringMatching(/^series: the series style: no style pack "minimall".*"minimal"/)]);
  });

  it("notes a narrated scene showing a character with another voice, once", async () => {
    const { project } = seriesProject(BIBLE, (s) => (s.scenes[1].series_refs = ["host"]));
    const w = (await validateSpecFile(specOf(project), null)).warnings.filter((x) => x.stage === "series");
    expect(w).toEqual([expect.objectContaining({ path: "scenes.0.series_refs", message: expect.stringMatching(/Ava.*"Samantha".*default voice/) })]);
    const same = seriesProject(BIBLE, (s) => (s.voice = { ...s.voice, voice_id: "Samantha" }));
    expect((await validateSpecFile(specOf(same.project), null)).warnings.filter((x) => x.stage === "series")).toEqual([]);
  });

  it("warns when no scene draws from the bible", async () => {
    const { project } = seriesProject(BIBLE, (s) => s.scenes.forEach((x: { series_refs?: string[] }) => delete x.series_refs));
    expect((await validateSpecFile(specOf(project), null)).warnings.filter((x) => x.stage === "series").map((x) => x.path)).toEqual(["series"]);
  });
});

describe("video.lock: series assets", () => {
  it("records the bible and the used reference files; without a series the assets are untouched", async () => {
    const { project } = seriesProject();
    const loaded = await loadSeries(project, "../series.yaml");
    const usage = await seriesUsage(loaded, [{ id: "s01", series_refs: ["host"] }]);
    const assets = [{ path: "brand.yaml", sha256: "b".repeat(64) }];
    expect(withSeriesAssets(assets, undefined)).toBe(assets);
    const rec = seriesRecord(loaded, usage);
    const out = withSeriesAssets(assets, rec).map((a) => a.path);
    expect(out).toEqual(["brand.yaml", "../series.yaml", "../refs/host.png"]);
    const lock = buildLock({
      schema_version: "1.0",
      project_id: "p",
      quality: "preview",
      spec_sha256: "c".repeat(64),
      engine: {},
      tools: {},
      voice: { backend: "silent", request_hash: "d".repeat(64) },
      fonts: [],
      targets: [],
      scenes: [],
      assets: withSeriesAssets(assets, rec),
      outputs: [],
    } as VideoLock);
    expect(lock.assets.map((a) => a.path)).toEqual(["../refs/host.png", "../series.yaml", "brand.yaml"]);
  });
});

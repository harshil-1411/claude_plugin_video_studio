import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TranslationSheet, type VideoSpec } from "@video-studio/schema";
import { countUnits, deriveEmphasis, estimateSpeechSec, extractEntries, formatLocalize, isTranslatable, localizeProject, takeEmphasisMarks } from "./localize.js";

const EXAMPLE = join(import.meta.dirname, "..", "..", "..", "examples", "text-to-motion-graphic");
let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-localize-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function copyExample(name: string): Promise<string> {
  const dir = join(tmp, name);
  for (const part of ["project", "source", "input", "assets"]) await cp(join(EXAMPLE, part), join(dir, part), { recursive: true }).catch(() => undefined);
  return dir;
}

const readJson = async <T>(p: string) => JSON.parse(await readFile(p, "utf8")) as T;

/** A fake translation: German-ish, keeping names; longer than the source. */
const GERMAN: Record<string, string> = {
  "scenes.0.deterministic.props.lines.0": "Die Suche findet Wörter,",
  "scenes.0.deterministic.props.lines.1": "nicht *Bedeutung*",
  "scenes.2.deterministic.props.nodes.0": "Text",
  "scenes.2.deterministic.props.nodes.1": "Embedding-Modell",
  "scenes.2.deterministic.props.nodes.2": "Vektor",
};

describe("localize step 1 (sheet)", () => {
  it("copies the project, sets the language and lists every viewer-facing string", async () => {
    const dir = await copyExample("step1");
    const srcBefore = await readFile(join(dir, "project", "video-spec.json"), "utf8");
    const r = await localizeProject(dir, "de-DE");
    expect(r.out_dir).toBe(join(dir, "localized", "de-DE"));
    expect(r.applied).toBe(false);
    expect(await readFile(join(dir, "project", "video-spec.json"), "utf8")).toBe(srcBefore);
    const spec = await readJson<VideoSpec>(join(r.out_dir, "project", "video-spec.json"));
    expect(spec.language).toBe("de-DE");
    expect(spec.id).toBe("vector-db-30s-de-de");
    const sheet = TranslationSheet.parse(await readJson(r.sheet_path));
    expect(sheet.source_language).toBe("en-US");
    expect(sheet.entries.length).toBe(r.entries);
    const paths = sheet.entries.map((e) => e.path);
    expect(paths).toContain("title");
    expect(paths).toContain("scenes.0.voiceover");
    expect(paths).toContain("scenes.0.on_screen_text");
    expect(paths).toContain("scenes.0.deterministic.props.lines.1");
    expect(paths).toContain("scenes.1.deterministic.props.left.label");
    expect(paths).toContain("scenes.2.deterministic.props.nodes.1");
    expect(paths).toContain("scenes.5.deterministic.props.action");
    expect(paths.some((p) => p.endsWith("emphasis"))).toBe(false);
    expect(paths.some((p) => p.includes("edges"))).toBe(false);
    const vo = sheet.entries.find((e) => e.path === "scenes.0.voiceover")!;
    expect(vo.kind).toBe("voiceover");
    expect(vo.note).toMatch(/at most \d+ words/);
    const line = sheet.entries.find((e) => e.path === "scenes.0.deterministic.props.lines.1")!;
    expect(line.note).toMatch(/"meaning" is emphasised/);
    expect(sheet.entries.every((e) => e.target === undefined)).toBe(true);
    expect(formatLocalize(r)).toMatch(/string\(s\) to translate/);
  });

  it("refuses a non-empty out_dir without this language's sheet", async () => {
    const dir = await copyExample("refuse");
    const out = join(tmp, "occupied");
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "x.txt"), "x");
    await expect(localizeProject(dir, "de-DE", { out_dir: out })).rejects.toThrow(/not empty/);
    await expect(localizeProject(dir, "en-US")).rejects.toThrow(/already in en-US/);
  });

  it("re-running step 1 keeps translations whose source is unchanged", async () => {
    const dir = await copyExample("rerun");
    const r = await localizeProject(dir, "de-DE");
    const sheet = TranslationSheet.parse(await readJson(r.sheet_path));
    sheet.entries.find((e) => e.path === "title")!.target = "Vektordatenbanken in 30 Sekunden";
    await writeFile(r.sheet_path, JSON.stringify(sheet));
    const r2 = await localizeProject(dir, "de-DE");
    expect(r2.translated).toBe(1);
    const again = TranslationSheet.parse(await readJson(r2.sheet_path));
    expect(again.entries.find((e) => e.path === "title")!.target).toBe("Vektordatenbanken in 30 Sekunden");
  });
});

describe("localize step 2 (apply)", () => {
  it("writes translations, re-derives emphasis, renames edges, re-times and validates", async () => {
    const dir = await copyExample("apply");
    const r = await localizeProject(dir, "de-DE");
    const sheet = TranslationSheet.parse(await readJson(r.sheet_path));
    for (const e of sheet.entries) {
      if (GERMAN[e.path]) e.target = GERMAN[e.path];
      // A long voiceover for s02 forces re-timing.
      if (e.path === "scenes.1.voiceover") e.target = `${e.source} Das ist eine deutlich längere Übersetzung mit vielen zusätzlichen Wörtern, die mehr Zeit zum Sprechen braucht.`;
    }
    await writeFile(r.sheet_path, JSON.stringify(sheet));
    const a = await localizeProject(dir, "de-DE", { apply: true });
    expect(a.applied).toBe(true);
    expect(a.translated).toBe(Object.keys(GERMAN).length + 1);
    const spec = await readJson<VideoSpec>(join(a.out_dir, "project", "video-spec.json"));
    const src = await readJson<VideoSpec>(join(dir, "project", "video-spec.json"));
    const p0 = spec.scenes[0]!.deterministic!.props as { lines: string[]; emphasis?: string };
    expect(p0.lines).toEqual(["Die Suche findet Wörter,", "nicht Bedeutung"]);
    expect(p0.emphasis).toBe("Bedeutung");
    const p2 = spec.scenes[2]!.deterministic!.props as { nodes: string[]; edges: string[][] };
    expect(p2.edges).toEqual([
      ["Text", "Embedding-Modell"],
      ["Embedding-Modell", "Vektor"],
    ]);
    expect(spec.scenes[1]!.duration_sec).toBeGreaterThan(src.scenes[1]!.duration_sec);
    expect(spec.scenes.map((s) => s.claim_refs)).toEqual(src.scenes.map((s) => s.claim_refs));
    expect(a.notes.some((n) => /re-timed for de-DE/.test(n))).toBe(true);
    expect(a.notes.some((n) => /no target and keep/.test(n))).toBe(true);
    const total = spec.scenes.reduce((x, s) => x + s.duration_sec, 0);
    expect(Math.abs(total - spec.target_duration_sec)).toBeLessThanOrEqual(spec.target_duration_sec * 0.1 + 1e-9);
    expect(a.valid).toBe(true);
    expect(a.errors).toEqual([]);
  });

  it("refuses when the source spec changed since the sheet was made", async () => {
    const dir = await copyExample("changed");
    await localizeProject(dir, "de-DE");
    const specPath = join(dir, "project", "video-spec.json");
    const spec = await readJson<VideoSpec>(specPath);
    spec.title = "Changed";
    await writeFile(specPath, JSON.stringify(spec));
    await expect(localizeProject(dir, "de-DE", { apply: true })).rejects.toThrow(/changed since the sheet was made/);
  });

  it("updates target_duration_sec when the translation runs far longer", async () => {
    const dir = await copyExample("long");
    const r = await localizeProject(dir, "de-DE");
    const sheet = TranslationSheet.parse(await readJson(r.sheet_path));
    for (const e of sheet.entries) if (e.kind === "voiceover") e.target = `${e.source} ${e.source} ${e.source}`;
    await writeFile(r.sheet_path, JSON.stringify(sheet));
    const a = await localizeProject(dir, "de-DE", { apply: true });
    const spec = await readJson<VideoSpec>(join(a.out_dir, "project", "video-spec.json"));
    expect(spec.target_duration_sec).toBeGreaterThan(30);
    expect(a.notes.some((n) => /target_duration_sec 30s →/.test(n))).toBe(true);
  });

  it("CJK: drops an unmarked emphasis, keeps a marked one; budgets in characters", async () => {
    const dir = await copyExample("ja");
    const r = await localizeProject(dir, "ja-JP");
    const sheet = TranslationSheet.parse(await readJson(r.sheet_path));
    expect(sheet.entries.find((e) => e.path === "scenes.0.voiceover")!.note).toMatch(/characters/);
    for (const e of sheet.entries) {
      if (e.path === "scenes.0.deterministic.props.lines.0") e.target = "検索は言葉を見つける、";
      if (e.path === "scenes.0.deterministic.props.lines.1") e.target = "意味ではない";
    }
    await writeFile(r.sheet_path, JSON.stringify(sheet));
    let a = await localizeProject(dir, "ja-JP", { apply: true });
    let spec = await readJson<VideoSpec>(join(a.out_dir, "project", "video-spec.json"));
    expect((spec.scenes[0]!.deterministic!.props as { emphasis?: string }).emphasis).toBeUndefined();
    expect(a.notes.some((n) => /emphasis "meaning" dropped/.test(n))).toBe(true);
    sheet.entries.find((e) => e.path === "scenes.0.deterministic.props.lines.1")!.target = "*意味*ではない";
    await writeFile(r.sheet_path, JSON.stringify(sheet));
    a = await localizeProject(dir, "ja-JP", { apply: true });
    spec = await readJson<VideoSpec>(join(a.out_dir, "project", "video-spec.json"));
    expect((spec.scenes[0]!.deterministic!.props as { emphasis?: string; lines: string[] }).emphasis).toBe("意味");
    expect((spec.scenes[0]!.deterministic!.props as { lines: string[] }).lines[1]).toBe("意味ではない");
  });
});

describe("localize helpers", () => {
  it("skips code, commands, URLs and numbers", () => {
    expect(isTranslatable("npm install video-studio")).toBe(false);
    expect(isTranslatable("https://example.com/docs")).toBe(false);
    expect(isTranslatable("example.com")).toBe(false);
    expect(isTranslatable("42%")).toBe(false);
    expect(isTranslatable("  ")).toBe(false);
    expect(isTranslatable("Try it on your docs")).toBe(true);
  });

  it("extracts props of every kind, never code or emphasis", () => {
    const spec = {
      schema_version: "1.0",
      title: "T",
      goal: "explain",
      audience: "devs",
      platform: "tiktok",
      aspect_ratio: "9:16",
      target_duration_sec: 10,
      language: "en-US",
      grounding: "loose",
      voice: { mode: "none" },
      captions: { preset: "minimal", burn_in: true },
      cover: { headline: "Big claim here", focal_time_sec: 1 },
      publish: { tiktok: { post_caption: "Watch this", hashtags: ["#vectors", "#AI"] } },
      scenes: [
        { id: "s01", duration_sec: 2, purpose: "hook", voiceover: "", on_screen_text: "Look", visual_strategy: "motion_graphic", visual_requirements: { continuity_refs: [] }, claim_refs: [], deterministic: { kind: "code", props: { language: "ts", code: "const a = 1" } } },
        { id: "s02", duration_sec: 2, purpose: "point", voiceover: "", visual_strategy: "motion_graphic", visual_requirements: { continuity_refs: [] }, claim_refs: [], deterministic: { kind: "cta", props: { headline: "Try it", action: "Install", command: "npm i x", url: "https://x.dev" } } },
        { id: "s03", duration_sec: 2, purpose: "proof", voiceover: "", visual_strategy: "motion_graphic", visual_requirements: { continuity_refs: [] }, claim_refs: [], deterministic: { kind: "stat", props: { value: 40, unit: "%", label: "faster builds", context: "vs. last release" } }, sfx: [{ file: "a.wav", at_sec: 0, caption: "[applause]" }] },
        { id: "s04", duration_sec: 2, purpose: "step", voiceover: "", visual_strategy: "motion_graphic", visual_requirements: { continuity_refs: [] }, claim_refs: [], deterministic: { kind: "timeline", props: { events: [{ label: "Ingest" }, { label: "Plan", text: "write the brief" }] } } },
        { id: "s05", duration_sec: 2, purpose: "point", voiceover: "", visual_strategy: "motion_graphic", visual_requirements: { continuity_refs: [] }, claim_refs: [], deterministic: { kind: "map", props: { title: "Where", points: [{ label: "Laptop", x: 0.1, y: 0.1 }] } } },
        { id: "s06", duration_sec: 2, purpose: "point", voiceover: "", visual_strategy: "motion_graphic", visual_requirements: { continuity_refs: [] }, claim_refs: [], deterministic: { kind: "kinetic_text", props: { text: "Docs in. Video out.", emphasis: "Video" } } },
        { id: "s07", duration_sec: 2, purpose: "point", voiceover: "", visual_strategy: "motion_graphic", visual_requirements: { continuity_refs: [] }, claim_refs: [], deterministic: { kind: "lower_third", props: { name: "Ada Lovelace", title: "Engineer" } } },
      ],
    } as unknown as VideoSpec;
    const e = extractEntries(spec, "de-DE");
    const byPath = new Map(e.map((x) => [x.path, x]));
    expect([...byPath.keys()]).toEqual(
      expect.arrayContaining([
        "title",
        "scenes.0.on_screen_text",
        "scenes.1.deterministic.props.headline",
        "scenes.1.deterministic.props.action",
        "scenes.2.deterministic.props.label",
        "scenes.2.deterministic.props.context",
        "scenes.2.sfx.0.caption",
        "scenes.3.deterministic.props.events.1.text",
        "scenes.4.deterministic.props.points.0.label",
        "scenes.5.deterministic.props.text",
        "scenes.6.deterministic.props.name",
        "cover.headline",
        "publish.tiktok.post_caption",
        "publish.tiktok.hashtags.1",
      ]),
    );
    for (const p of byPath.keys()) expect(p).not.toMatch(/code|command|url|emphasis|unit|value/);
    expect(byPath.get("scenes.5.deterministic.props.text")!.note).toMatch(/"Video" is emphasised/);
    expect(byPath.get("scenes.6.deterministic.props.name")!.note).toMatch(/proper name/);
  });

  it("measures length in words or characters by script", () => {
    expect(countUnits("Search finds words, not meaning", "en-US")).toBe(5);
    expect(countUnits("検索は言葉を見つける", "ja-JP")).toBe(10);
    expect(estimateSpeechSec("検索は言葉を見つける", "ja-JP")).toBeCloseTo(10 / 7.5, 2); // SPEECH_RATES.cjk_chars_per_sec
    expect(estimateSpeechSec("", "de-DE")).toBe(0);
  });

  it("emphasis marks and derivation", () => {
    expect(takeEmphasisMarks("nicht *Bedeutung* hier")).toEqual({ text: "nicht Bedeutung hier", marked: ["Bedeutung"] });
    expect(deriveEmphasis({ lines: ["Suche mit HNSW"], marked: [], sourceEmphasis: "HNSW", lineIndex: 0, language: "de-DE" }).emphasis).toBe("HNSW");
    expect(deriveEmphasis({ lines: ["nicht die Bedeutung"], marked: [], sourceEmphasis: "meaning", lineIndex: 0, language: "de-DE" }).emphasis).toBe("Bedeutung");
    expect(deriveEmphasis({ lines: ["意味ではない"], marked: [], sourceEmphasis: "meaning", lineIndex: 0, language: "ja-JP" }).emphasis).toBeNull();
  });
});

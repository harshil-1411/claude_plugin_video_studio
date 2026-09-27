import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@video-studio/core";
import { ExperimentManifest, type ExperimentPlan, type Scene, VideoSpec } from "@video-studio/schema";
import { adaptProject, scaleDurations } from "./adapt.js";
import { checkDurations, experimentStatus, prepareVariants, variantDuration, variantSpec } from "./variants.js";

const EXAMPLE = join(import.meta.dirname, "..", "..", "..", "examples", "text-to-motion-graphic");
let tmp: string;
let base: string;

const hook = (text: string, duration_sec = 3.5): Scene => ({
  id: "s01",
  duration_sec,
  purpose: "hook",
  voiceover: text,
  visual_strategy: "motion_graphic",
  deterministic: { kind: "kinetic_text", props: { text } },
  visual_requirements: { continuity_refs: [] },
  claim_refs: ["markdown:input/vector-databases.md#L3"],
});

const plan: ExperimentPlan = {
  schema_version: "1.0",
  id: "hooks-1",
  hypothesis: "A question hook keeps more viewers past 3 s than a statement hook.",
  metric: "3s_retention",
  hooks: [
    { id: "statement", scene: hook("Keyword search finds words, not meaning.") },
    { id: "question", scene: hook("Why does search miss what you meant?", 3) },
    { id: "contrast", scene: hook("Words match. Meaning doesn't.") },
  ],
  covers: [
    { id: "plain", cover: { headline: "Search by meaning", focal_time_sec: 1 } },
    { id: "bold", cover: { headline: "Words ≠ meaning", focal_time_sec: 1 } },
  ],
};

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-variants-"));
  base = join(tmp, "base");
  for (const part of ["project", "source", "input"]) await cp(join(EXAMPLE, part), join(base, part), { recursive: true }).catch(() => undefined);
  await writeFile(join(base, "project", "variants.json"), JSON.stringify(plan, null, 2));
});
afterAll(() => rm(tmp, { recursive: true, force: true }));

describe("variants", () => {
  it("swaps the hook scene (keeping its id and total length) and the cover", async () => {
    const spec = VideoSpec.parse(JSON.parse(await readFile(join(base, "project", "video-spec.json"), "utf8")));
    const v = variantSpec(spec, plan, "question", "bold");
    expect(v.scenes[0]).toMatchObject({ id: "s01", voiceover: "Why does search miss what you meant?", duration_sec: 3 });
    expect(v.target_duration_sec).toBe(spec.target_duration_sec - 0.5);
    expect(v.cover).toEqual({ headline: "Words ≠ meaning", focal_time_sec: 1 });
    expect(v.scenes.slice(1)).toEqual(spec.scenes.slice(1));
  });

  it("prepares 3 hooks × 2 covers = 6 valid variant projects and an experiment manifest", async () => {
    const r = await prepareVariants(base, () => new Date("2026-09-25T00:00:00Z"));
    expect(r.invalid).toEqual([]);
    expect(r.manifest.variants.map((v) => v.id)).toEqual(["statement-plain", "statement-bold", "question-plain", "question-bold", "contrast-plain", "contrast-bold"]);
    expect(r.manifest.variants.every((v) => v.status === "prepared")).toBe(true);
    ExperimentManifest.parse(JSON.parse(await readFile(join(base, "variants", "experiment.json"), "utf8")));
    for (const v of r.manifest.variants) {
      expect((await stat(join(base, v.project_dir, "source", "content-ir.json"))).isFile()).toBe(true);
      await expect(stat(join(base, v.project_dir, "project", "variants.json"))).rejects.toThrow();
    }
  });

  it("reports a variant as rendered once its dist/video.lock matches its spec", async () => {
    const m = ExperimentManifest.parse(JSON.parse(await readFile(join(base, "variants", "experiment.json"), "utf8")));
    const v = m.variants[1]!;
    const spec = JSON.parse(await readFile(join(base, v.project_dir, "project", "video-spec.json"), "utf8"));
    expect(sha256Hex(canonicalJson(spec))).toBe(v.spec_sha256);
    const lock = {
      schema_version: "1.0",
      project_id: "x",
      quality: "preview",
      spec_sha256: v.spec_sha256,
      engine: {},
      tools: {},
      voice: { backend: "silent", request_hash: "a".repeat(64) },
      fonts: [],
      targets: [],
      scenes: [],
      assets: [],
      outputs: [],
    };
    await cp(join(base, v.project_dir, "project"), join(base, v.project_dir, "dist"), { recursive: true }); // any dist folder
    await writeFile(join(base, v.project_dir, "dist", "video.lock"), JSON.stringify(lock));
    const next = await experimentStatus(base, { [m.variants[0]!.id]: "render-job-1" });
    expect(next.variants[1]).toMatchObject({ status: "rendered", dist: `${v.project_dir}/dist` });
    expect(next.variants[0]).toMatchObject({ status: "rendering", job_id: "render-job-1" });
  });

  it("marks an invalid variant as failed with the spec errors", async () => {
    const bad = structuredClone(plan);
    bad.id = "hooks-bad";
    bad.hooks = [{ id: "long", scene: hook("x", 60) }];
    delete bad.covers;
    const dir = join(tmp, "bad");
    await cp(base, dir, { recursive: true });
    await rm(join(dir, "variants"), { recursive: true, force: true });
    await writeFile(join(dir, "project", "variants.json"), JSON.stringify(bad));
    const r = await prepareVariants(dir);
    expect(r.manifest.variants[0]).toMatchObject({ id: "long", status: "failed" });
    expect(r.invalid[0]!.errors.join("\n")).toMatch(/lasts 60s/);
  });

  it("checkDurations: at most 4 distinct lengths inside the platform norms and every target contract", async () => {
    const spec = VideoSpec.parse(JSON.parse(await readFile(join(base, "project", "video-spec.json"), "utf8")));
    expect(await checkDurations(spec, [15, 30])).toEqual([]);
    expect((await checkDurations(spec, [10, 15, 20, 30, 45])).join("\n")).toMatch(/at most 4/);
    expect((await checkDurations(spec, [15, 15])).join("\n")).toMatch(/duplicate duration 15/);
    // youtube_shorts norms: 7–90 s.
    expect((await checkDurations(spec, [5])).join("\n")).toMatch(/5s is outside youtube_shorts' 7–90s/);
    expect((await checkDurations(spec, [120])).join("\n")).toMatch(/120s is outside youtube_shorts' 7–90s/);
    // A target contract's own limit applies too (facebook-page-api: 3–90 s, instagram_reels norm 7–90 s).
    const fb = { ...spec, platform: "linkedin" as const, targets: ["facebook-page-api"] };
    expect((await checkDurations(fb, [100])).join("\n")).toMatch(/facebook-page-api accepts 3–90s/);
    // Every scene keeps at least 0.5 s.
    const many = { ...spec, platform: "generic" as const, scenes: Array.from({ length: 6 }, (_, i) => ({ ...spec.scenes[0]!, id: `s${i}` })) };
    expect((await checkDurations(many, [2])).join("\n")).toMatch(/6 scenes need at least 3s/);
  });

  it("durations: paired cuts of different lengths from one spec, recorded per variant", async () => {
    const dir = join(tmp, "cuts");
    await cp(base, dir, { recursive: true });
    await rm(join(dir, "variants"), { recursive: true, force: true });
    const one = { ...structuredClone(plan), id: "cuts-1", hooks: [plan.hooks[0]!] };
    delete one.covers;
    await writeFile(join(dir, "project", "variants.json"), JSON.stringify(one));
    const r = await prepareVariants(dir, undefined, { durations: [15, 30] });
    expect(r.manifest.variants.map((v) => v.id)).toEqual(["statement-15s", "statement-30s"]);
    expect(r.manifest.variants.map(variantDuration)).toEqual([15, 30]);
    for (const [i, d] of [15, 30].entries()) {
      const v = r.manifest.variants[i]!;
      const spec = VideoSpec.parse(JSON.parse(await readFile(join(dir, v.project_dir, "project", "video-spec.json"), "utf8")));
      expect(spec.target_duration_sec).toBe(d);
      expect(spec.scenes.reduce((a, s) => a + s.duration_sec, 0)).toBeCloseTo(d, 5);
      expect(spec.scenes[0]!.voiceover).toBe("Keyword search finds words, not meaning.");
      expect(spec.id).toMatch(new RegExp(`-${d}s$`));
    }
    // The 15 s cut of narrated copy says which scenes to trim (Claude edits the words).
    expect(r.notes.join("\n")).toMatch(/statement-15s: s\d+: \d+ voiceover words in [\d.]+s; trim to ≤ \d+ words/);
    // Called again without durations, the experiment keeps its cuts.
    const again = await prepareVariants(dir);
    expect(again.manifest.variants.map((v) => v.id)).toEqual(["statement-15s", "statement-30s"]);
    // An empty list goes back to the base length only.
    const reset = await prepareVariants(dir, undefined, { durations: [] });
    expect(reset.manifest.variants.map((v) => v.id)).toEqual(["statement"]);
    expect(variantDuration(reset.manifest.variants[0]!)).toBeUndefined();
    await expect(prepareVariants(dir, undefined, { durations: [15, 15] })).rejects.toThrow(/duplicate duration 15/);
  });

  it("explains how to start when there is no plan", async () => {
    const dir = join(tmp, "noplan");
    await cp(join(EXAMPLE, "project"), join(dir, "project"), { recursive: true });
    await expect(prepareVariants(dir)).rejects.toThrow(/no project\/variants\.json/);
  });
});

describe("adapt", () => {
  it("scales durations proportionally to an exact total", () => {
    const d = scaleDurations([3.5, 5.5, 6, 6, 5.5, 3.5], 15);
    expect(Math.round(d.reduce((a, b) => a + b, 0) * 10) / 10).toBe(15);
    expect(d.every((x) => x >= 0.5)).toBe(true);
  });

  it("copies to a new folder with a 16:9, 15 s, LinkedIn spec and leaves the source alone", async () => {
    const before = await readFile(join(base, "project", "video-spec.json"), "utf8");
    const out = join(tmp, "adapted");
    const r = await adaptProject(base, out, { aspect_ratio: "16:9", target_duration_sec: 15, platform: "linkedin" });
    expect(await readFile(join(base, "project", "video-spec.json"), "utf8")).toBe(before);
    expect(r.spec.aspect_ratio).toBe("16:9");
    expect(r.spec.master).toMatchObject({ width: 1920, height: 1080 });
    expect(r.spec.targets).toEqual(["linkedin"]);
    expect(r.spec.scenes.reduce((a, s) => a + s.duration_sec, 0)).toBeCloseTo(15, 5);
    expect(r.notes.join("\n")).toMatch(/trim to ≤ \d+ words/);
    expect(JSON.parse(await readFile(join(out, "project", "video-spec.json"), "utf8")).target_duration_sec).toBe(15);
    await expect(adaptProject(base, out, { target_duration_sec: 20 })).rejects.toThrow(/not empty/);
  });
});

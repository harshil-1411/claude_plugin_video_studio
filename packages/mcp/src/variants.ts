import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, hashFile, projectPaths, readJson, sha256Hex, writeJsonAtomic } from "@video-studio/core";
import { ExperimentManifest, ExperimentPlan, type ExperimentVariant, VideoSpec, parseYamlOrJson } from "@video-studio/schema";
import { LOCK_FILE, readLock } from "./lock.js";
import { projectSpecPaths, validateSpecFile } from "./spec-validate.js";

/**
 * variants: an A/B experiment from one planned project. `project/variants.json` (ExperimentPlan)
 * lists hook scenes and covers; every hook × cover pair becomes `variants/<hook>-<cover>/`, a full
 * project whose spec is the base spec with the hook scene and cover swapped. Base renders' scene
 * clips are copied along, so a variant only re-renders its hook scene (the cover is composed from
 * the master). `variants/experiment.json` records the experiment; statuses are recomputed from
 * each variant's dist/video.lock, so the file never goes stale.
 */

export const VARIANTS_FILE = "variants.json";
export const EXPERIMENT_FILE = "experiment.json";

/** Project parts a variant needs (everything else is regenerated or belongs to the base). */
const COPY = ["source", "input", "assets", "brand.yaml", "project"] as const;

export interface VariantsResult {
  manifest: ExperimentManifest;
  manifest_path: string;
  /** Variants whose spec failed validation (not rendered). */
  invalid: Array<{ id: string; errors: string[] }>;
}

function variantsDir(root: string): string {
  return join(root, "variants");
}

async function loadPlan(root: string): Promise<ExperimentPlan> {
  const path = join(root, "project", VARIANTS_FILE);
  if (!existsSync(path)) {
    throw new Error(`no project/${VARIANTS_FILE}; write an ExperimentPlan there first (schema_get experiment-plan): {schema_version, id, hypothesis, hooks: [{id, scene}], covers?: [{id, cover}]}`);
  }
  const r = parseYamlOrJson(ExperimentPlan, await readFile(path, "utf8"));
  if (!r.ok) throw new Error(`project/${VARIANTS_FILE} is invalid: ${r.errors.slice(0, 5).map((e) => `${e.path}: ${e.message}`).join("; ")}`);
  return r.data;
}

async function loadBaseSpec(root: string): Promise<VideoSpec> {
  const r = parseYamlOrJson(VideoSpec, await readFile(projectSpecPaths(root).spec, "utf8"));
  if (!r.ok) throw new Error(`project/video-spec.json is invalid; run spec_validate first (${r.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join("; ")})`);
  return r.data;
}

/** The variant's spec: base spec with the hook scene replaced (keeping its id and slot) and the cover swapped. */
export function variantSpec(base: VideoSpec, plan: ExperimentPlan, hookId: string, coverId: string | undefined): VideoSpec {
  const hook = plan.hooks.find((h) => h.id === hookId)!;
  const cover = coverId ? plan.covers?.find((c) => c.id === coverId) : undefined;
  const idx = Math.max(0, base.scenes.findIndex((s) => s.purpose === "hook"));
  const spec = structuredClone(base);
  const baseHook = base.scenes[idx]!;
  spec.scenes[idx] = { ...structuredClone(hook.scene), id: baseHook.id };
  // Keep the total duration: the new hook takes the old hook's length difference out of the target.
  spec.target_duration_sec = Math.round((base.target_duration_sec + (hook.scene.duration_sec - baseHook.duration_sec)) * 100) / 100;
  if (cover) spec.cover = structuredClone(cover.cover);
  const suffix = coverId ? `${hookId}-${coverId}` : hookId;
  spec.id = `${base.id ?? "video"}-${suffix}`.replace(/[^A-Za-z0-9_.@:-]/g, "-");
  return spec;
}

/** Status of a prepared variant from its files: rendered when its dist lock matches its spec. */
async function variantStatus(root: string, v: ExperimentVariant): Promise<ExperimentVariant> {
  const dir = join(root, v.project_dir);
  const lockPath = join(dir, "dist", LOCK_FILE);
  if (v.status === "failed" && v.error) return v;
  try {
    const lock = await readLock(lockPath);
    if (lock && lock.spec_sha256 === v.spec_sha256) {
      return { ...v, status: "rendered", dist: `${v.project_dir}/dist`, lock_sha256: await hashFile(lockPath) };
    }
  } catch {
    // unreadable lock: not rendered
  }
  return { ...v, status: v.job_id ? "rendering" : "prepared" };
}

/**
 * Create (or refresh) variants/<hook>-<cover>/ projects from project/variants.json and write
 * variants/experiment.json. Existing variant folders are rebuilt from the base, keeping their
 * renders/ so unchanged work stays cached.
 */
export async function prepareVariants(projectDir: string, now: () => Date = () => new Date()): Promise<VariantsResult> {
  const root = projectPaths(projectDir).root;
  const plan = await loadPlan(root);
  const base = await loadBaseSpec(root);
  const vdir = variantsDir(root);
  await mkdir(vdir, { recursive: true });
  const prev = await readJson<ExperimentManifest>(join(vdir, EXPERIMENT_FILE)).catch(() => undefined);
  const covers: Array<string | undefined> = plan.covers?.length ? plan.covers.map((c) => c.id) : [undefined];
  const variants: ExperimentVariant[] = [];
  const invalid: VariantsResult["invalid"] = [];

  for (const hook of plan.hooks) {
    for (const coverId of covers) {
      const id = coverId ? `${hook.id}-${coverId}` : hook.id;
      const dir = join(vdir, id);
      await mkdir(dir, { recursive: true });
      for (const part of COPY) {
        const src = join(root, part);
        await rm(join(dir, part), { recursive: true, force: true });
        if (existsSync(src)) await cp(src, join(dir, part), { recursive: true });
      }
      await rm(join(dir, "project", VARIANTS_FILE), { force: true });
      // Seed the scene clip cache from the base render (clips are keyed by content, so reuse is safe).
      for (const q of ["preview", "final"]) {
        const scenes = join(root, "renders", q, "scenes");
        if (existsSync(scenes) && !existsSync(join(dir, "renders", q, "scenes"))) await cp(scenes, join(dir, "renders", q, "scenes"), { recursive: true });
      }
      const spec = variantSpec(base, plan, hook.id, coverId);
      const { spec: specPath, contentIr } = projectSpecPaths(dir);
      await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);
      const check = await validateSpecFile(specPath, existsSync(contentIr) ? contentIr : null);
      const spec_sha256 = sha256Hex(canonicalJson(spec));
      const old = prev?.variants.find((v) => v.id === id && v.spec_sha256 === spec_sha256);
      const entry: ExperimentVariant = {
        id,
        hook_id: hook.id,
        ...(coverId ? { cover_id: coverId } : {}),
        project_dir: `variants/${id}`,
        spec_sha256,
        status: check.ok ? "prepared" : "failed",
        ...(old?.job_id ? { job_id: old.job_id } : {}),
        ...(check.ok ? {} : { error: `spec invalid: ${check.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}` }),
      };
      if (!check.ok) invalid.push({ id, errors: check.errors.map((e) => `${e.path}: ${e.message} (fix: ${e.fix})`) });
      variants.push(await variantStatus(root, entry));
    }
  }

  const ts = now().toISOString();
  const manifest: ExperimentManifest = ExperimentManifest.parse({
    schema_version: "1.0",
    experiment_id: plan.id,
    hypothesis: plan.hypothesis,
    ...(plan.metric ? { metric: plan.metric } : {}),
    base_spec_sha256: sha256Hex(canonicalJson(base)),
    created_at: prev?.experiment_id === plan.id ? prev.created_at : ts,
    updated_at: ts,
    variants,
  });
  const manifest_path = join(vdir, EXPERIMENT_FILE);
  await writeJsonAtomic(manifest_path, manifest);
  return { manifest, manifest_path, invalid };
}

/** Re-read variants/experiment.json and refresh each variant's status from its files. */
export async function experimentStatus(projectDir: string, jobs: Record<string, string> = {}): Promise<ExperimentManifest> {
  const root = projectPaths(projectDir).root;
  const path = join(variantsDir(root), EXPERIMENT_FILE);
  if (!existsSync(path)) throw new Error("no variants/experiment.json; run variants first");
  const m = ExperimentManifest.parse(await readJson(path));
  const variants = await Promise.all(m.variants.map((v) => variantStatus(root, jobs[v.id] ? { ...v, job_id: jobs[v.id] } : v)));
  const next = { ...m, variants };
  await writeJsonAtomic(path, next);
  return next;
}

/** One-screen summary. */
export function formatVariants(m: ExperimentManifest, invalid: VariantsResult["invalid"] = []): string {
  return [
    `experiment ${m.experiment_id}: ${m.variants.length} variant(s); hypothesis: ${m.hypothesis}`,
    ...m.variants.map((v) => `- ${v.id} (hook ${v.hook_id}${v.cover_id ? `, cover ${v.cover_id}` : ""}): ${v.status}${v.job_id ? ` [job ${v.job_id}]` : ""}${v.dist ? ` → ${v.dist}` : ""}${v.error ? ` — ${v.error}` : ""}`),
    ...invalid.flatMap((i) => i.errors.slice(0, 3).map((e) => `  ${i.id}: ${e}`)),
  ].join("\n");
}

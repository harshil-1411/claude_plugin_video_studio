import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, hashFile, projectPaths, readJson, sha256Hex, writeJsonAtomic } from "@video-studio/core";
import { ExperimentManifest, ExperimentPlan, type ExperimentVariant, PLATFORM_NORMS, VideoSpec, parseYamlOrJson, resolveTargets } from "@video-studio/schema";
import { findPlatformSpecsDir, loadContracts } from "@video-studio/platforms";
import { MIN_SCENE_SEC, retimeSpec } from "./adapt.js";
import { LOCK_FILE, readLock } from "./lock.js";
import { type RenderLockDeps, renderLockHolder } from "./render-lock.js";
import { projectSpecPaths, validateSpecFile } from "./spec-validate.js";

/**
 * variants: an A/B experiment from one planned project. `project/variants.json` (ExperimentPlan)
 * lists hook scenes and covers; every hook × cover pair becomes `variants/<hook>-<cover>/`, a full
 * project whose spec is the base spec with the hook scene and cover swapped. Base renders' scene
 * clips are copied along, so a variant only re-renders its hook scene (the cover is composed from
 * the master). `variants/experiment.json` records the experiment; statuses are recomputed from
 * each variant's dist/video.lock, so the file never goes stale.
 *
 * `durations` (e.g. [15, 30]) adds paired cuts: every hook × cover pair is also retimed to each
 * length with `adapt`'s duration logic, as variants/<hook>-<cover>-<n>s/. The length is part of the
 * variant id (read it back with `variantDuration`), so later calls without `durations` keep the cuts.
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
  /** Variants left untouched because a render of them is running (their render lock is held). */
  skipped: Array<{ id: string; reason: string }>;
  /** Retiming notes per variant, e.g. narration that no longer fits a shorter cut. */
  notes: string[];
}

/** A render job's state, looked up by id (the MCP server passes its job manager's view). */
export type JobLookup = (jobId: string) => { status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted"; error?: string } | undefined;

export interface VariantsOptions {
  /** Look up each variant's render job; without it a variant with a job id counts as rendering. */
  jobs?: JobLookup;
  /** Render-lock liveness checks (tests). */
  lockDeps?: RenderLockDeps;
  /**
   * Paired cut lengths in seconds (at most 4). Omitted: keep the lengths of the existing
   * experiment; []: back to the base spec's length only.
   */
  durations?: number[];
}

/** Most paired cut lengths one experiment may ask for. */
export const MAX_DURATIONS = 4;

/**
 * Problems with the requested cut lengths for this spec: at most 4, no duplicates, each inside
 * the platform's norms and every target contract's duration range, and long enough for every
 * scene to keep 0.5 s.
 */
export async function checkDurations(spec: VideoSpec, durations: readonly number[]): Promise<string[]> {
  const errors: string[] = [];
  if (durations.length > MAX_DURATIONS) errors.push(`${durations.length} durations requested; at most ${MAX_DURATIONS} paired cuts per experiment`);
  const norm = PLATFORM_NORMS[spec.platform];
  const specsDir = findPlatformSpecsDir();
  const contracts = specsDir ? await loadContracts(specsDir) : [];
  const targets = resolveTargets(spec)
    .map((t) => contracts.find((c) => c.id === t))
    .filter((c) => c !== undefined);
  const seen = new Set<number>();
  for (const d of durations) {
    if (!Number.isFinite(d) || d <= 0) {
      errors.push(`duration ${d} must be a positive number of seconds`);
      continue;
    }
    if (seen.has(d)) errors.push(`duplicate duration ${d}s`);
    seen.add(d);
    if (d < norm.min_sec || d > norm.max_sec) errors.push(`${d}s is outside ${spec.platform}' ${norm.min_sec}–${norm.max_sec}s range`);
    for (const c of targets) {
      const { min, max } = c.video.duration_sec;
      if ((min !== undefined && d < min) || (max !== undefined && d > max)) errors.push(`${d}s: target ${c.id} accepts ${min ?? 0}–${max ?? "∞"}s`);
    }
    const least = spec.scenes.length * MIN_SCENE_SEC;
    if (d < least) errors.push(`${d}s is too short: ${spec.scenes.length} scenes need at least ${least}s (${MIN_SCENE_SEC}s each)`);
  }
  return errors;
}

const durationSuffix = (d: number) => `${d}s`;

/** The manifest with each paired cut's `duration_sec` filled in (manifests written before the field existed carry it only in the id). */
export function withDurations(m: ExperimentManifest): ExperimentManifest {
  return { ...m, variants: m.variants.map((v) => ({ ...v, ...(variantDuration(v) !== undefined ? { duration_sec: variantDuration(v)! } : {}) })) };
}

/** The cut length a variant was retimed to (its `duration_sec`, else read from its id), or undefined for the base length. */
export function variantDuration(v: Pick<ExperimentVariant, "id" | "hook_id" | "cover_id" | "duration_sec">): number | undefined {
  if (v.duration_sec !== undefined) return v.duration_sec;
  const prefix = v.cover_id ? `${v.hook_id}-${v.cover_id}` : v.hook_id;
  if (!v.id.startsWith(`${prefix}-`)) return undefined;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(v.id.slice(prefix.length + 1));
  return m ? Number(m[1]) : undefined;
}

const SPEC_INVALID = "spec invalid:";

/** A variant whose spec failed validation (rendering it is pointless until the plan is fixed). */
export function isSpecInvalid(v: ExperimentVariant): boolean {
  return v.status === "failed" && (v.error?.startsWith(SPEC_INVALID) ?? false);
}

/** Whether `variants` with render: true should queue a job for this variant. */
export function needsRender(v: ExperimentVariant): boolean {
  return v.status === "prepared" || (v.status === "failed" && !isSpecInvalid(v));
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

/**
 * The variant's spec: base spec with the hook scene replaced (keeping its id and slot) and the
 * cover swapped; with `durationSec`, then retimed to that length (a paired cut).
 */
export function variantSpec(base: VideoSpec, plan: ExperimentPlan, hookId: string, coverId: string | undefined, durationSec?: number): VideoSpec {
  return variantSpecWithNotes(base, plan, hookId, coverId, durationSec).spec;
}

function variantSpecWithNotes(base: VideoSpec, plan: ExperimentPlan, hookId: string, coverId: string | undefined, durationSec?: number): { spec: VideoSpec; notes: string[] } {
  const hook = plan.hooks.find((h) => h.id === hookId)!;
  const cover = coverId ? plan.covers?.find((c) => c.id === coverId) : undefined;
  const idx = Math.max(0, base.scenes.findIndex((s) => s.purpose === "hook"));
  const spec = structuredClone(base);
  const baseHook = base.scenes[idx]!;
  spec.scenes[idx] = { ...structuredClone(hook.scene), id: baseHook.id };
  // Keep the total duration: the new hook takes the old hook's length difference out of the target.
  spec.target_duration_sec = Math.round((base.target_duration_sec + (hook.scene.duration_sec - baseHook.duration_sec)) * 100) / 100;
  if (cover) spec.cover = structuredClone(cover.cover);
  const notes = durationSec !== undefined ? retimeSpec(spec, durationSec).notes : [];
  spec.id = `${base.id ?? "video"}-${variantId(hookId, coverId, durationSec)}`.replace(/[^A-Za-z0-9_.@:-]/g, "-");
  return { spec, notes };
}

function variantId(hookId: string, coverId: string | undefined, durationSec: number | undefined): string {
  const pair = coverId ? `${hookId}-${coverId}` : hookId;
  return durationSec !== undefined ? `${pair}-${durationSuffix(durationSec)}` : pair;
}

/**
 * Status of a prepared variant from its files and its render job: rendered when its dist lock
 * matches its spec; rendering only while its job is queued or running; failed (resubmittable)
 * when the job failed, was cancelled or was interrupted; else prepared.
 */
async function variantStatus(root: string, v: ExperimentVariant, jobs?: JobLookup): Promise<ExperimentVariant> {
  if (isSpecInvalid(v)) return v;
  const { error: _stale, dist: _dist, lock_sha256: _lock, ...rest } = v;
  const dir = join(root, v.project_dir);
  const lockPath = join(dir, "dist", LOCK_FILE);
  try {
    const lock = await readLock(lockPath);
    if (lock && lock.spec_sha256 === v.spec_sha256) {
      return { ...rest, status: "rendered", dist: `${v.project_dir}/dist`, lock_sha256: await hashFile(lockPath) };
    }
  } catch {
    // unreadable lock: not rendered
  }
  if (!v.job_id) return { ...rest, status: "prepared" };
  if (!jobs) return { ...rest, status: "rendering" };
  const job = jobs(v.job_id);
  switch (job?.status) {
    case "queued":
    case "running":
      return { ...rest, status: "rendering" };
    case "failed":
      return { ...rest, status: "failed", error: `render job ${v.job_id} failed: ${(job.error ?? "unknown error").split("\n")[0]}; fix it and call variants with render: true again` };
    case "cancelled":
      return { ...rest, status: "failed", error: `render job ${v.job_id} was cancelled; call variants with render: true to render it again` };
    case "interrupted":
      return { ...rest, status: "failed", error: `render job ${v.job_id} was interrupted (engine restart); call variants with render: true to render it again` };
    default:
      // Succeeded without a matching dist lock (the spec changed since), or unknown: needs a render.
      return { ...rest, status: "prepared" };
  }
}

/**
 * Create (or refresh) variants/<hook>-<cover>/ projects from project/variants.json and write
 * variants/experiment.json. Existing variant folders are rebuilt from the base, keeping their
 * renders/ so unchanged work stays cached.
 */
export async function prepareVariants(projectDir: string, now: () => Date = () => new Date(), o: VariantsOptions = {}): Promise<VariantsResult> {
  const root = projectPaths(projectDir).root;
  const plan = await loadPlan(root);
  const base = await loadBaseSpec(root);
  const vdir = variantsDir(root);
  await mkdir(vdir, { recursive: true });
  const prev = await readJson<ExperimentManifest>(join(vdir, EXPERIMENT_FILE)).catch(() => undefined);
  const requested = o.durations ?? previousDurations(prev, plan.id);
  const durationErrors = await checkDurations(base, requested);
  if (durationErrors.length) throw new Error(`durations: ${durationErrors.join("; ")}`);
  const lengths: Array<number | undefined> = requested.length ? [...requested] : [undefined];
  const covers: Array<string | undefined> = plan.covers?.length ? plan.covers.map((c) => c.id) : [undefined];
  const pairs = plan.hooks.flatMap((hook) => covers.flatMap((coverId) => lengths.map((durationSec) => ({ hook, coverId, durationSec }))));
  const variants: ExperimentVariant[] = [];
  const invalid: VariantsResult["invalid"] = [];
  const skipped: VariantsResult["skipped"] = [];
  const notes: string[] = [];

  for (const { hook, coverId, durationSec } of pairs) {
    const id = variantId(hook.id, coverId, durationSec);
    const dir = join(vdir, id);
    // Never delete and re-copy a variant that is being rendered right now.
    const holder = await renderLockHolder(join(dir, "renders", ".render.lock"), o.lockDeps);
    if (holder) {
      const reason = `variant ${id} is being rendered (render lock held by pid ${holder.pid} on ${holder.host} since ${holder.started_at}); left as is. Call variants again after it finishes to apply plan changes.`;
      skipped.push({ id, reason });
      const prevEntry = prev?.variants.find((v) => v.id === id);
      const onDisk = await readFile(projectSpecPaths(dir).spec, "utf8")
        .then((t) => sha256Hex(canonicalJson(JSON.parse(t))))
        .catch(() => undefined);
      const entry: ExperimentVariant = prevEntry ?? {
        id,
        hook_id: hook.id,
        ...(coverId ? { cover_id: coverId } : {}),
        ...(durationSec !== undefined ? { duration_sec: durationSec } : {}),
        project_dir: `variants/${id}`,
        spec_sha256: onDisk ?? sha256Hex(canonicalJson(variantSpec(base, plan, hook.id, coverId, durationSec))),
        status: "rendering",
      };
      const st = await variantStatus(root, entry, o.jobs);
      // Its render is live even when this engine has no job for it (another session or the CLI).
      variants.push(st.status === "rendered" ? st : { ...st, status: "rendering" });
      continue;
    }
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
    const built = variantSpecWithNotes(base, plan, hook.id, coverId, durationSec);
    const spec = built.spec;
    notes.push(...built.notes.map((n) => `${id}: ${n}`));
    const { spec: specPath, contentIr } = projectSpecPaths(dir);
    await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);
    const check = await validateSpecFile(specPath, existsSync(contentIr) ? contentIr : null);
    const spec_sha256 = sha256Hex(canonicalJson(spec));
    const old = prev?.variants.find((v) => v.id === id && v.spec_sha256 === spec_sha256);
    const entry: ExperimentVariant = {
      id,
      hook_id: hook.id,
      ...(coverId ? { cover_id: coverId } : {}),
      ...(durationSec !== undefined ? { duration_sec: durationSec } : {}),
      project_dir: `variants/${id}`,
      spec_sha256,
      status: check.ok ? "prepared" : "failed",
      ...(old?.job_id ? { job_id: old.job_id } : {}),
      ...(check.ok ? {} : { error: `spec invalid: ${check.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}` }),
    };
    if (!check.ok) invalid.push({ id, errors: check.errors.map((e) => `${e.path}: ${e.message} (fix: ${e.fix})`) });
    variants.push(await variantStatus(root, entry, o.jobs));
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
  return { manifest, manifest_path, invalid, skipped, notes };
}

/** The cut lengths of the existing experiment (same plan id), so a refresh keeps its cuts. */
function previousDurations(prev: ExperimentManifest | undefined, planId: string): number[] {
  if (!prev || prev.experiment_id !== planId) return [];
  const out: number[] = [];
  for (const v of prev.variants) {
    const d = variantDuration(v);
    if (d !== undefined && !out.includes(d)) out.push(d);
  }
  return out;
}

/** Re-read variants/experiment.json and refresh each variant's status from its files. */
export async function experimentStatus(projectDir: string, jobs: Record<string, string> = {}, lookup?: JobLookup): Promise<ExperimentManifest> {
  const root = projectPaths(projectDir).root;
  const path = join(variantsDir(root), EXPERIMENT_FILE);
  if (!existsSync(path)) throw new Error("no variants/experiment.json; run variants first");
  const m = ExperimentManifest.parse(await readJson(path));
  // A newly submitted job replaces the variant's old job and its failure.
  const variants = await Promise.all(
    m.variants.map((v) => {
      if (!jobs[v.id]) return variantStatus(root, v, lookup);
      const { error: _e, ...rest } = v;
      return variantStatus(root, { ...rest, status: "rendering", job_id: jobs[v.id]! }, lookup);
    }),
  );
  const next = { ...m, variants };
  await writeJsonAtomic(path, next);
  return next;
}

/** One-screen summary. */
export function formatVariants(m: ExperimentManifest, invalid: VariantsResult["invalid"] = [], skipped: VariantsResult["skipped"] = [], notes: string[] = []): string {
  return [
    `experiment ${m.experiment_id}: ${m.variants.length} variant(s); hypothesis: ${m.hypothesis}`,
    ...m.variants.map((v) => `- ${v.id} (hook ${v.hook_id}${v.cover_id ? `, cover ${v.cover_id}` : ""}${variantDuration(v) !== undefined ? `, ${variantDuration(v)}s cut` : ""}): ${v.status}${v.job_id ? ` [job ${v.job_id}]` : ""}${v.dist ? ` → ${v.dist}` : ""}${v.error ? ` — ${v.error}` : ""}`),
    ...invalid.flatMap((i) => i.errors.slice(0, 3).map((e) => `  ${i.id}: ${e}`)),
    ...skipped.map((k) => `skipped: ${k.reason}`),
    ...notes.map((n) => `note: ${n}`),
  ].join("\n");
}

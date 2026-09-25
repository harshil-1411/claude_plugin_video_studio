import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { projectPaths } from "@video-studio/core";
import { type AspectRatio, type Platform, VideoSpec, defaultMaster, parseYamlOrJson, resolveMaster, resolveTargets, voiceMode } from "@video-studio/schema";
import { findPlatformSpecsDir, loadContracts } from "@video-studio/platforms";
import { type SpecValidationResult, projectSpecPaths, validateSpecFile } from "./spec-validate.js";

/**
 * adapt: derive a new project from a planned one for another shape: aspect ratio, duration,
 * platform and targets. The source project is never modified; the copy gets a retargeted spec
 * (scene durations scaled proportionally, master resized, cover time scaled) and a validation
 * result. Words are not rewritten: when narration no longer fits, the notes say which scenes to
 * trim (Claude edits them in the skill).
 */

export interface AdaptOptions {
  aspect_ratio?: AspectRatio;
  target_duration_sec?: number;
  platform?: Platform;
  /** Platform contract ids; default: keep the source's, or the new platform's own contract. */
  targets?: string[];
}

export interface AdaptResult {
  out_dir: string;
  spec: VideoSpec;
  changes: string[];
  notes: string[];
  validation: SpecValidationResult;
}

/** Words per second above which narration is too dense (matches lint's MAX_WORDS_PER_SEC). */
const MAX_WPS = 3.3;
/** Shortest scene the schema allows. */
const MIN_SCENE_SEC = 0.5;

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Scale scene durations to `target`, keeping proportions, each ≥ 0.5 s, summing exactly (to 0.1 s). */
export function scaleDurations(durations: readonly number[], target: number): number[] {
  const total = durations.reduce((a, b) => a + b, 0);
  const scaled = durations.map((d) => Math.max(MIN_SCENE_SEC, round1((d / total) * target)));
  // Put the rounding remainder on the longest scene.
  const diff = round1(target - scaled.reduce((a, b) => a + b, 0));
  const longest = scaled.indexOf(Math.max(...scaled));
  scaled[longest] = Math.max(MIN_SCENE_SEC, round1(scaled[longest]! + diff));
  return scaled;
}

export async function adaptProject(projectDir: string, outDir: string, opts: AdaptOptions): Promise<AdaptResult> {
  const root = projectPaths(projectDir).root;
  const out = resolve(outDir);
  if (out === root) throw new Error("out_dir must differ from the source project (adapt never modifies the source)");
  if (existsSync(out) && (await readdir(out)).length > 0) throw new Error(`out_dir ${out} is not empty; choose a new folder`);
  const parsed = parseYamlOrJson(VideoSpec, await readFile(projectSpecPaths(root).spec, "utf8"));
  if (!parsed.ok) throw new Error(`project/video-spec.json is invalid; run spec_validate first (${parsed.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join("; ")})`);
  const src = parsed.data;
  const spec = structuredClone(src);
  const changes: string[] = [];
  const notes: string[] = [];

  if (opts.platform && opts.platform !== src.platform) {
    spec.platform = opts.platform;
    changes.push(`platform ${src.platform} → ${opts.platform}`);
  }
  if (opts.aspect_ratio && opts.aspect_ratio !== src.aspect_ratio) {
    const fps = resolveMaster(src).fps;
    spec.aspect_ratio = opts.aspect_ratio;
    spec.master = { ...defaultMaster(opts.aspect_ratio), fps };
    changes.push(`aspect_ratio ${src.aspect_ratio} → ${opts.aspect_ratio} (master ${spec.master.width}×${spec.master.height})`);
    notes.push("layouts re-flow for the new frame automatically; check on-screen text and screenshots in the storyboard");
  }
  if (opts.targets) {
    spec.targets = [...new Set(opts.targets)];
    changes.push(`targets → ${spec.targets.join(", ") || "none"}`);
  } else if (opts.platform && opts.platform !== src.platform) {
    delete spec.targets;
    const t = resolveTargets(spec);
    if (t.length) spec.targets = t;
    changes.push(`targets → ${t.join(", ") || "none"} (the new platform's own contract)`);
  }
  // Publish copy only for targets that remain.
  if (spec.publish) {
    const keep = new Set(resolveTargets(spec));
    for (const k of Object.keys(spec.publish)) if (!keep.has(k)) delete spec.publish[k];
  }

  if (opts.target_duration_sec && opts.target_duration_sec !== src.target_duration_sec) {
    const factor = opts.target_duration_sec / src.scenes.reduce((a, s) => a + s.duration_sec, 0);
    const durations = scaleDurations(src.scenes.map((s) => s.duration_sec), opts.target_duration_sec);
    spec.scenes.forEach((s, i) => (s.duration_sec = durations[i]!));
    spec.target_duration_sec = opts.target_duration_sec;
    if (spec.cover) spec.cover.focal_time_sec = round1(spec.cover.focal_time_sec * factor);
    changes.push(`duration ${src.target_duration_sec}s → ${opts.target_duration_sec}s (scenes scaled ×${Math.round(factor * 100) / 100})`);
    if (voiceMode(spec) === "narrated") {
      for (const s of spec.scenes) {
        const words = s.voiceover.trim() ? s.voiceover.trim().split(/\s+/).length : 0;
        const max = Math.floor(s.duration_sec * MAX_WPS);
        if (words > max) notes.push(`${s.id}: ${words} voiceover words in ${s.duration_sec}s; trim to ≤ ${max} words (or merge/drop a scene)`);
      }
    }
  }
  if (changes.length === 0) notes.push("nothing to adapt: the options match the source spec");

  // Contracts: warn when a target does not accept the aspect ratio.
  const specsDir = findPlatformSpecsDir();
  if (specsDir) {
    const contracts = await loadContracts(specsDir);
    for (const t of resolveTargets(spec)) {
      const c = contracts.find((x) => x.id === t);
      if (c && !c.video.aspect_ratios.includes(spec.aspect_ratio)) notes.push(`${t} does not accept ${spec.aspect_ratio} (accepts ${c.video.aspect_ratios.join(", ")})`);
    }
  }

  await mkdir(out, { recursive: true });
  for (const part of ["source", "input", "assets", "brand.yaml", "project"]) {
    const from = join(root, part);
    if (existsSync(from)) await cp(from, join(out, part), { recursive: true });
  }
  spec.id = `${src.id ?? "video"}-${spec.aspect_ratio.replace(":", "x")}-${spec.target_duration_sec}s`.replace(/[^A-Za-z0-9_.@:-]/g, "-");
  const { spec: specPath, contentIr } = projectSpecPaths(out);
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  const validation = await validateSpecFile(specPath, existsSync(contentIr) ? contentIr : null);
  return { out_dir: out, spec, changes, notes, validation };
}

export function formatAdapt(r: AdaptResult): string {
  return [
    `adapted into ${r.out_dir}: ${r.changes.join("; ") || "no changes"}`,
    `spec ${r.validation.ok ? "valid" : `has ${r.validation.errors.length} error(s)`}${r.validation.warnings.length ? `, ${r.validation.warnings.length} warning(s)` : ""}`,
    ...r.validation.errors.map((e) => `- error ${e.path}: ${e.message} (fix: ${e.fix})`),
    ...r.notes.map((n) => `note: ${n}`),
  ].join("\n");
}

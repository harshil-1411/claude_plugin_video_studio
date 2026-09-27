import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkSpecTargets, findPlatformSpecsDir, loadContracts } from "@video-studio/platforms";
import { findStylesDir, formatMotionFinding, getStyle, loadMotionPage, styleIds } from "@video-studio/renderer";
import { ContentIR, VideoSpec, closestMatches, parseYamlOrJson, validateVideoSpecSemantics, voiceMode } from "@video-studio/schema";
import { SeriesLoadError, entryFiles, loadSeries, resolveSeriesFile, seriesEntries } from "./series.js";

export interface ValidationIssue {
  path: string;
  message: string;
  /** Concrete instruction for resolving the issue. */
  fix: string;
  /** Which stage found it. */
  stage: "syntax" | "schema" | "semantic" | "content-ir" | "platform" | "style" | "motion" | "series";
}

export interface SpecValidationResult {
  ok: boolean;
  spec_path: string;
  content_ir_path: string | null;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Conventional locations inside a project folder. */
export function projectSpecPaths(projectDir: string): { spec: string; contentIr: string } {
  return { spec: join(projectDir, "project", "video-spec.json"), contentIr: join(projectDir, "source", "content-ir.json") };
}

/**
 * Validate a VideoSpec file: schema first, then semantic rules. If a ContentIR path
 * is given and exists, evidence refs and asset ids are cross-checked against it.
 * `motion` pages are read from `projectDir` (default: the folder above `project/video-spec.json`)
 * and linted; their errors fail validation.
 */
export async function validateSpecFile(
  specPath: string,
  contentIrPath: string | null,
  platformSpecsDir: string | null = findPlatformSpecsDir(),
  stylesDir: string | null = findStylesDir(),
  projectDir: string = dirname(dirname(specPath)),
): Promise<SpecValidationResult> {
  const result: SpecValidationResult = {
    ok: false,
    spec_path: specPath,
    content_ir_path: null,
    errors: [],
    warnings: [],
  };
  const text = await readIfExists(specPath);
  if (text === null) throw new Error(`spec file not found: ${specPath}`);

  const parsed = parseYamlOrJson(VideoSpec, text);
  if (!parsed.ok) {
    for (const e of parsed.errors) {
      const syntax = e.message.startsWith("syntax error");
      result.errors.push({
        ...e,
        stage: syntax ? "syntax" : "schema",
        fix: syntax
          ? "fix the JSON/YAML syntax at the reported position"
          : `correct ${e.path || "the document"} to match the VideoSpec schema (schema_get name=video-spec)`,
      });
    }
    return result;
  }

  let ir: ContentIR | undefined;
  if (contentIrPath) {
    const irText = await readIfExists(contentIrPath);
    if (irText !== null) {
      result.content_ir_path = contentIrPath;
      const irParsed = parseYamlOrJson(ContentIR, irText);
      if (irParsed.ok) {
        ir = irParsed.data;
      } else {
        result.warnings.push({
          path: "",
          stage: "content-ir",
          fix: "re-run ingest to regenerate source/content-ir.json",
          message: `content IR at ${contentIrPath} is invalid, so evidence refs were not cross-checked: ${irParsed.errors
            .slice(0, 3)
            .map((e) => `${e.path || "(root)"}: ${e.message}`)
            .join("; ")}`,
        });
      }
    }
  }
  if (!ir) {
    result.warnings.push({
      path: "",
      stage: "content-ir",
      message: "no valid ContentIR available; evidence_refs and asset ids were not cross-checked",
      fix: "run ingest for this project (or pass content_ir_path) so claim_refs can be verified",
    });
  }

  const semantic = validateVideoSpecSemantics(parsed.data, ir);
  result.errors.push(...semantic.errors.map((e) => ({ ...e, stage: "semantic" as const })));
  result.warnings.push(...semantic.warnings.map((e) => ({ ...e, stage: "semantic" as const })));

  // Targets are checked once the registry has contracts; an empty registry means none are published yet.
  const contracts = platformSpecsDir ? await loadContracts(platformSpecsDir) : [];
  if (contracts.length > 0) {
    const t = checkSpecTargets(parsed.data, contracts);
    result.errors.push(...t.errors.map((e) => ({ ...e, stage: "platform" as const })));
    result.warnings.push(...t.warnings.map((e) => ({ ...e, stage: "platform" as const })));
  }
  // The style pack must exist in styles/ (and be a valid pack).
  if (parsed.data.style) {
    const style = await checkSpecStyle(parsed.data.style, stylesDir, projectDir);
    if (style) result.errors.push(style);
  }
  const series = await checkSeries(parsed.data, projectDir, stylesDir);
  result.errors.push(...series.errors);
  result.warnings.push(...series.warnings);
  const motion = await checkMotionPages(parsed.data, projectDir);
  result.errors.push(...motion.errors);
  result.warnings.push(...motion.warnings);
  result.ok = result.errors.length === 0;
  return result;
}

/**
 * Every `motion` scene's page, linted (motion-lint.ts): a missing page, a path or symlink leaving
 * the project, and each unsafe or non-deterministic construct. The same findings as lint's
 * `motion_unsafe` rule; errors here block the render.
 */
export async function checkMotionPages(spec: VideoSpec, projectDir: string): Promise<{ errors: ValidationIssue[]; warnings: ValidationIssue[] }> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  for (const [i, s] of spec.scenes.entries()) {
    const det = s.deterministic;
    if (det?.kind !== "motion") continue;
    const html = typeof det.props.html === "string" ? det.props.html : "";
    const page = await loadMotionPage(projectDir, html);
    for (const f of page.findings) {
      const issue: ValidationIssue = { path: `scenes.${i}.deterministic.props.html`, stage: "motion", message: `${s.id}: ${html}: ${formatMotionFinding(f)}`, fix: f.fix };
      (f.severity === "error" ? errors : warnings).push(issue);
    }
  }
  return { errors, warnings };
}

/**
 * The series bible a spec points at (`series`): the file loads and matches the schema; every
 * `series_refs` id names an entry (the fix lists the closest ids); the reference files of the
 * entries scenes show exist inside the bible's folder; the bible's style pack exists when the spec
 * picks none. Warnings: a narrated scene shows a character whose `voice_id` differs from the
 * narration voice, and a bible that no scene draws from (its edits would re-render nothing).
 */
export async function checkSeries(spec: VideoSpec, projectDir: string, stylesDir: string | null = findStylesDir()): Promise<{ errors: ValidationIssue[]; warnings: ValidationIssue[] }> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  if (!spec.series) return { errors, warnings };
  let loaded;
  try {
    loaded = await loadSeries(projectDir, spec.series);
  } catch (e) {
    if (!(e instanceof SeriesLoadError)) throw e;
    return { errors: e.issues.map((i) => ({ ...i, stage: "series" as const })), warnings };
  }
  const entries = seriesEntries(loaded.series);
  const checkedFiles = new Set<string>();
  const voiced = new Set<string>();
  const narrated = voiceMode(spec) === "narrated";
  for (const [i, s] of spec.scenes.entries()) {
    for (const id of s.series_refs ?? []) {
      const e = entries.get(id);
      if (!e) {
        const near = closestMatches(id, entries.keys());
        errors.push({
          path: `scenes.${i}.series_refs`,
          stage: "series",
          message: `scene ${s.id} names "${id}", which is not a character, location or motif in ${spec.series}`,
          fix: near.length ? `use one of ${near.map((n) => `"${n}"`).join(", ")}, or add "${id}" to the series bible` : `add "${id}" to the series bible, or remove it from series_refs`,
        });
        continue;
      }
      for (const ref of entryFiles(e)) {
        if (checkedFiles.has(ref)) continue;
        checkedFiles.add(ref);
        const r = await resolveSeriesFile(loaded, ref);
        if ("error" in r) {
          errors.push({ path: `scenes.${i}.series_refs`, stage: "series", message: `series entry "${id}": ${r.error}`, fix: "put the file in the series folder (next to the bible, or below it) and reference it by its relative path" });
        }
      }
      if (e.kind === "character" && e.entry.voice_id && narrated && s.voiceover.trim() && e.entry.voice_id !== spec.voice.voice_id && !voiced.has(id)) {
        voiced.add(id);
        warnings.push({
          path: `scenes.${i}.series_refs`,
          stage: "series",
          message: `scene ${s.id} shows ${e.entry.name}, whose series voice is "${e.entry.voice_id}", but the narration uses ${spec.voice.voice_id ? `"${spec.voice.voice_id}"` : "the default voice"} (one narrator voice per video)`,
          fix: `if ${e.entry.name} narrates, set voice.voice_id to "${e.entry.voice_id}"; otherwise ignore this`,
        });
      }
    }
  }
  if (entries.size && !spec.scenes.some((s) => s.series_refs?.length)) {
    warnings.push({
      path: "series",
      stage: "series",
      message: `no scene names an entry of ${spec.series} in series_refs, so editing a character, location or motif re-renders nothing`,
      fix: "list the entries each scene shows in its series_refs",
    });
  }
  if (!spec.style && loaded.series.style) {
    const style = await checkSpecStyle(loaded.series.style, stylesDir, projectDir);
    if (style) errors.push({ ...style, path: "series", stage: "series", message: `the series style: ${style.message}`, fix: `${style.fix.replace(/, or remove style$/, "")} in ${spec.series}, or set style in the spec` });
  }
  return { errors, warnings };
}

/**
 * An error when `id` is not a loadable style pack in the project's `styles/` (when `projectDir` is
 * given) or the bundled `dir`, listing the available ids.
 */
export async function checkSpecStyle(id: string, dir: string | null, projectDir?: string): Promise<ValidationIssue | null> {
  const ids = await styleIds(dir, projectDir).catch(() => [] as string[]);
  if (!ids.includes(id)) {
    const near = closestMatches(id, ids);
    return {
      path: "style",
      stage: "style",
      message: `no style pack "${id}" in styles/; available: ${ids.join(", ") || "(none)"}`,
      fix: near.length ? `use one of ${near.map((n) => `"${n}"`).join(", ")}, or remove style` : `use one of the available ids, or remove style`,
    };
  }
  try {
    await getStyle(dir, id, projectDir);
    return null;
  } catch (e) {
    return { path: "style", stage: "style", message: e instanceof Error ? e.message : String(e), fix: `fix styles/${id}.yaml or pick another style` };
  }
}

export function formatSpecValidation(r: SpecValidationResult): string {
  const lines = [`${r.ok ? "VALID" : "INVALID"}: ${r.spec_path}`];
  if (r.content_ir_path) lines.push(`cross-checked against ${r.content_ir_path}`);
  for (const e of r.errors) lines.push(`error   [${e.stage}] ${e.path || "(root)"}: ${e.message}\n        fix: ${e.fix}`);
  for (const w of r.warnings) lines.push(`warning [${w.stage}] ${w.path || "(root)"}: ${w.message}\n        fix: ${w.fix}`);
  return lines.join("\n");
}

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkSpecTargets, findPlatformSpecsDir, loadContracts } from "@video-studio/platforms";
import { findStylesDir, formatMotionFinding, getStyle, loadMotionPage, styleIds } from "@video-studio/renderer";
import { ContentIR, VideoSpec, closestMatches, parseYamlOrJson, validateVideoSpecSemantics } from "@video-studio/schema";

export interface ValidationIssue {
  path: string;
  message: string;
  /** Concrete instruction for resolving the issue. */
  fix: string;
  /** Which stage found it. */
  stage: "syntax" | "schema" | "semantic" | "content-ir" | "platform" | "style" | "motion";
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
    const style = await checkSpecStyle(parsed.data.style, stylesDir);
    if (style) result.errors.push(style);
  }
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

/** An error when `id` is not a loadable style pack in `dir`, listing the available ids. */
export async function checkSpecStyle(id: string, dir: string | null): Promise<ValidationIssue | null> {
  const ids = await styleIds(dir).catch(() => [] as string[]);
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
    await getStyle(dir, id);
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

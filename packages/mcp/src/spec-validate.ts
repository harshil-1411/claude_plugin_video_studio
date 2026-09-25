import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ContentIR, VideoSpec, parseYamlOrJson, validateVideoSpecSemantics } from "@video-studio/schema";

export interface ValidationIssue {
  path: string;
  message: string;
  /** Concrete instruction for resolving the issue. */
  fix: string;
  /** Which stage found it. */
  stage: "syntax" | "schema" | "semantic" | "content-ir";
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
 */
export async function validateSpecFile(specPath: string, contentIrPath: string | null): Promise<SpecValidationResult> {
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
  result.ok = result.errors.length === 0;
  return result;
}

export function formatSpecValidation(r: SpecValidationResult): string {
  const lines = [`${r.ok ? "VALID" : "INVALID"}: ${r.spec_path}`];
  if (r.content_ir_path) lines.push(`cross-checked against ${r.content_ir_path}`);
  for (const e of r.errors) lines.push(`error   [${e.stage}] ${e.path || "(root)"}: ${e.message}\n        fix: ${e.fix}`);
  for (const w of r.warnings) lines.push(`warning [${w.stage}] ${w.path || "(root)"}: ${w.message}\n        fix: ${w.fix}`);
  return lines.join("\n");
}

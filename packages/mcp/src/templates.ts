import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Template, Template as TemplateSchema, parseYamlOrJson } from "@video-studio/schema";

const MARKER = join("explain", "template.yaml");

/**
 * Locate the bundled `templates/` directory: `${CLAUDE_PLUGIN_ROOT}/templates` first, then
 * walk up from this module (works from `packages/mcp/src`, `packages/mcp/dist` and `dist/mcp.mjs`).
 */
export function findTemplatesDir(env: Record<string, string | undefined> = process.env, from?: string): string | null {
  const root = env.CLAUDE_PLUGIN_ROOT;
  if (root && existsSync(join(root, "templates", MARKER))) return join(root, "templates");
  let dir = from ?? dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "templates");
    if (existsSync(join(candidate, MARKER))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function requireTemplatesDir(env: Record<string, string | undefined> = process.env): string {
  const dir = findTemplatesDir(env);
  if (!dir) throw new Error("bundled templates/ directory not found (set CLAUDE_PLUGIN_ROOT)");
  return dir;
}

/** Load and validate `<dir>/<id>/template.yaml` for every subdirectory, sorted by id. Throws on any invalid template. */
export async function loadTemplates(dir: string): Promise<Template[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: Template[] = [];
  for (const e of entries.filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(dir, e.name, "template.yaml");
    if (!existsSync(file)) continue;
    out.push(parseTemplate(await readFile(file, "utf8"), file, e.name));
  }
  return out;
}

function parseTemplate(text: string, file: string, dirName: string): Template {
  const parsed = parseYamlOrJson(TemplateSchema, text);
  if (!parsed.ok) {
    throw new Error(`invalid template ${file}: ${parsed.errors.map((e) => `${e.path || "(root)"}: ${e.message}`).join("; ")}`);
  }
  if (parsed.data.id !== dirName) throw new Error(`template ${file} has id "${parsed.data.id}" but lives in "${dirName}/"`);
  return parsed.data;
}

/** Load one template by id. The error lists the available ids. */
export async function getTemplate(dir: string, id: string): Promise<Template> {
  if (/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    const file = join(dir, id, "template.yaml");
    if (existsSync(file)) return parseTemplate(await readFile(file, "utf8"), file, id);
  }
  const ids = (await loadTemplates(dir)).map((t) => t.id);
  throw new Error(`unknown template "${id}"; available: ${ids.join(", ")}`);
}

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  goals: string[];
  platforms: string[];
  default_duration_sec: number;
  beat_count: number;
}

export function summarizeTemplate(t: Template): TemplateSummary {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    goals: t.goals,
    platforms: t.platforms,
    default_duration_sec: t.default_duration_sec,
    beat_count: t.beats.length,
  };
}

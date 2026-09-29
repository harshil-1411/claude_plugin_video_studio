import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClicheRules, TitleRules, ToneRules, parseYamlOrJson } from "@video-studio/schema";
import type { z } from "zod";

/**
 * `research-specs/`: heuristics kept as dated data (titles, tone presets, clichés; Phase 9 adds more). Unlike
 * `platform-specs/`, nothing here is a platform limit: lint reports them as warnings only.
 */
const TITLES = "titles.yaml";

/**
 * Locate the bundled `research-specs/` directory: `${CLAUDE_PLUGIN_ROOT}/research-specs` first,
 * then walk up from this module (works from `packages/mcp/src`, `packages/mcp/dist` and `dist/mcp.mjs`).
 */
export function findResearchSpecsDir(env: Record<string, string | undefined> = process.env, from?: string): string | null {
  const root = env.CLAUDE_PLUGIN_ROOT;
  if (root && existsSync(join(root, "research-specs", TITLES))) return join(root, "research-specs");
  let dir = from ?? dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "research-specs");
    if (existsSync(join(candidate, TITLES))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const cache = new Map<string, unknown>();

/** `<dir>/<name>` validated against `schema`, cached per file; undefined when missing, throws when invalid. */
async function loadSpec<S extends z.ZodType>(dir: string | null, name: string, schema: S): Promise<z.infer<S> | undefined> {
  if (!dir) return undefined;
  const file = join(dir, name);
  if (cache.has(file)) return cache.get(file) as z.infer<S>;
  if (!existsSync(file)) return undefined;
  const parsed = parseYamlOrJson(schema, await readFile(file, "utf8"));
  if (!parsed.ok) throw new Error(`invalid ${file}: ${parsed.errors.map((e) => `${e.path || "(root)"}: ${e.message}`).join("; ")}`);
  cache.set(file, parsed.data);
  return parsed.data as z.infer<S>;
}

/**
 * `<dir>/titles.yaml` validated as TitleRules, cached per directory. Undefined when the directory
 * or file is missing (the title lint is then skipped); throws when the file is invalid.
 */
export function loadTitleRules(dir: string | null): Promise<TitleRules | undefined> {
  return loadSpec(dir, TITLES, TitleRules);
}

/** `<dir>/tones.yaml` (tone presets); undefined when missing. */
export function loadToneRules(dir: string | null): Promise<ToneRules | undefined> {
  return loadSpec(dir, "tones.yaml", ToneRules);
}

/** `<dir>/cliches.yaml` (stock phrases lint warns about); undefined when missing. */
export function loadClicheRules(dir: string | null): Promise<ClicheRules | undefined> {
  return loadSpec(dir, "cliches.yaml", ClicheRules);
}

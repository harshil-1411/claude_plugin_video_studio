import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TitleRules, parseYamlOrJson } from "@video-studio/schema";

/**
 * `research-specs/`: heuristics kept as dated data (titles today; Phase 9 adds more). Unlike
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

const titleCache = new Map<string, TitleRules>();

/**
 * `<dir>/titles.yaml` validated as TitleRules, cached per directory. Undefined when the directory
 * or file is missing (the title lint is then skipped); throws when the file is invalid.
 */
export async function loadTitleRules(dir: string | null): Promise<TitleRules | undefined> {
  if (!dir) return undefined;
  const file = join(dir, TITLES);
  const cached = titleCache.get(file);
  if (cached) return cached;
  if (!existsSync(file)) return undefined;
  const parsed = parseYamlOrJson(TitleRules, await readFile(file, "utf8"));
  if (!parsed.ok) throw new Error(`invalid ${file}: ${parsed.errors.map((e) => `${e.path || "(root)"}: ${e.message}`).join("; ")}`);
  titleCache.set(file, parsed.data);
  return parsed.data;
}

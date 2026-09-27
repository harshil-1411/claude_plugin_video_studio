import { existsSync, readdirSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderFamily, ProviderSpec as ProviderSpecSchema, type ProviderSpec, parseYamlOrJson } from "@video-studio/schema";

function isSpecsDir(dir: string): boolean {
  try {
    return existsSync(dir) && readdirSync(dir).some((n) => n.endsWith(".yaml"));
  } catch {
    return false;
  }
}

/**
 * Locate the bundled `provider-specs/` directory: `${CLAUDE_PLUGIN_ROOT}/provider-specs` first, then
 * walk up from this module (works from `packages/*\/src`, `packages/*\/dist` and `dist/mcp.mjs`).
 */
export function findProviderSpecsDir(env: Record<string, string | undefined> = process.env, from?: string): string | null {
  const root = env.CLAUDE_PLUGIN_ROOT;
  if (root && isSpecsDir(join(root, "provider-specs"))) return join(root, "provider-specs");
  let dir = from ?? dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "provider-specs");
    if (isSpecsDir(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function parseSpec(text: string, file: string, fileId: string): ProviderSpec {
  const parsed = parseYamlOrJson(ProviderSpecSchema, text);
  if (!parsed.ok) throw new Error(`invalid provider spec ${file}: ${parsed.errors.map((e) => `${e.path || "(root)"}: ${e.message}`).join("; ")}`);
  if (parsed.data.id !== fileId) throw new Error(`provider spec ${file} has id "${parsed.data.id}" but is named "${fileId}.yaml"`);
  return parsed.data;
}

/** Load and validate every `<dir>/<family>.yaml`, sorted by id. Throws on any invalid spec. */
export async function loadProviderSpecs(dir: string): Promise<ProviderSpec[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".yaml")).sort();
  const out: ProviderSpec[] = [];
  for (const name of names) {
    const file = join(dir, name);
    out.push(parseSpec(await readFile(file, "utf8"), file, name.slice(0, -".yaml".length)));
  }
  return out;
}

/** Load one family's spec. The error lists the known families. */
export async function getProviderSpec(dir: string, id: string): Promise<ProviderSpec> {
  const family = ProviderFamily.safeParse(id);
  if (!family.success) throw new Error(`unknown provider family "${id}"; available: ${ProviderFamily.options.join(", ")}`);
  const file = join(dir, `${id}.yaml`);
  if (!existsSync(file)) throw new Error(`no provider spec provider-specs/${id}.yaml`);
  return parseSpec(await readFile(file, "utf8"), file, id);
}

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type PlatformContract,
  PlatformContract as PlatformContractSchema,
  type SemanticIssue,
  type VideoSpec,
  closestMatches,
  parseYamlOrJson,
  resolveTargets,
} from "@video-studio/schema";

/** Present in every `platform-specs/` directory, so it can be found before any contract exists. */
const MARKER = "README.md";

/**
 * Locate the bundled `platform-specs/` directory: `${CLAUDE_PLUGIN_ROOT}/platform-specs` first, then
 * walk up from this module (works from `packages/*\/src`, `packages/*\/dist` and `dist/mcp.mjs`).
 */
export function findPlatformSpecsDir(env: Record<string, string | undefined> = process.env, from?: string): string | null {
  const root = env.CLAUDE_PLUGIN_ROOT;
  if (root && existsSync(join(root, "platform-specs", MARKER))) return join(root, "platform-specs");
  let dir = from ?? dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "platform-specs");
    if (existsSync(join(candidate, MARKER))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function parseContract(text: string, file: string, fileId: string): PlatformContract {
  const parsed = parseYamlOrJson(PlatformContractSchema, text);
  if (!parsed.ok) {
    throw new Error(`invalid platform contract ${file}: ${parsed.errors.map((e) => `${e.path || "(root)"}: ${e.message}`).join("; ")}`);
  }
  if (parsed.data.id !== fileId) throw new Error(`platform contract ${file} has id "${parsed.data.id}" but is named "${fileId}.yaml"`);
  return parsed.data;
}

/** Load and validate every `<dir>/<id>.yaml`, sorted by id. Throws on any invalid contract. */
export async function loadContracts(dir: string): Promise<PlatformContract[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".yaml")).sort();
  const out: PlatformContract[] = [];
  for (const name of names) {
    const file = join(dir, name);
    out.push(parseContract(await readFile(file, "utf8"), file, name.slice(0, -".yaml".length)));
  }
  return out;
}

/** Load one contract by id. The error lists the closest available ids. */
export async function getContract(dir: string, id: string): Promise<PlatformContract> {
  if (/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    const file = join(dir, `${id}.yaml`);
    if (existsSync(file)) return parseContract(await readFile(file, "utf8"), file, id);
  }
  const ids = (await loadContracts(dir)).map((c) => c.id);
  throw new Error(`unknown platform target "${id}"; available: ${ids.join(", ") || "(none)"}`);
}

/**
 * Check a spec's targets against the contract registry: every target must exist (error) and accept
 * the spec's aspect ratio (warning; the per-target compiler would have to crop or pad).
 */
export function checkSpecTargets(spec: Pick<VideoSpec, "platform" | "targets" | "aspect_ratio">, contracts: readonly PlatformContract[]): {
  errors: SemanticIssue[];
  warnings: SemanticIssue[];
} {
  const errors: SemanticIssue[] = [];
  const warnings: SemanticIssue[] = [];
  const byId = new Map(contracts.map((c) => [c.id, c]));
  const explicit = Boolean(spec.targets?.length);
  resolveTargets(spec).forEach((id, i) => {
    const path = explicit ? `targets.${i}` : "platform";
    const contract = byId.get(id);
    if (!contract) {
      const near = closestMatches(id, byId.keys());
      errors.push({
        path,
        message: `no platform contract "${id}" in platform-specs/`,
        fix: near.length ? `use one of ${near.map((n) => `"${n}"`).join(", ")}` : "add platform-specs/" + id + ".yaml or remove the target",
      });
      return;
    }
    if (!contract.video.aspect_ratios.includes(spec.aspect_ratio)) {
      warnings.push({
        path,
        message: `${contract.name} expects ${contract.video.aspect_ratios.join(" or ")}, but the spec is ${spec.aspect_ratio}`,
        fix: `use aspect_ratio ${contract.video.aspect_ratios[0]} or drop "${id}" from targets`,
      });
    }
  });
  return { errors, warnings };
}

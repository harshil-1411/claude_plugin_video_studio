import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve a path supplied in tool input. Absolute paths are used as-is; relative
 * paths resolve against the server's working directory. Rejects empty and NUL-containing input.
 */
export function resolveInputPath(p: string, cwd: string = process.cwd()): string {
  if (typeof p !== "string" || p.trim() === "") throw new Error("path must be a non-empty string");
  if (p.includes("\0")) throw new Error("path must not contain NUL bytes");
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

export const SCHEMA_NAMES = [
  "content-ir",
  "creative-brief",
  "video-spec",
  "render-manifest",
  "brand",
  "policy",
  "template",
  "platform-contract",
  "video-lock",
  "style",
  "experiment-plan",
  "experiment-manifest",
] as const;
export type SchemaName = (typeof SCHEMA_NAMES)[number];

/**
 * Locate the bundled `schemas/` directory: `${CLAUDE_PLUGIN_ROOT}/schemas` first, then
 * walk up from this module (works from `packages/mcp/src`, `packages/mcp/dist` and `dist/mcp.mjs`).
 */
export function findSchemasDir(env: Record<string, string | undefined> = process.env, from?: string): string | null {
  const marker = "video-spec.schema.json";
  const root = env.CLAUDE_PLUGIN_ROOT;
  if (root && existsSync(join(root, "schemas", marker))) return join(root, "schemas");
  let dir = from ?? dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "schemas");
    if (existsSync(join(candidate, marker))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

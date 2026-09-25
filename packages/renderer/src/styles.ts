import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Style as StyleSchema, type Style, parseYamlOrJson } from "@video-studio/schema";

/**
 * Style packs: `styles/<id>.yaml` (look and motion), selected by `VideoSpec.style`.
 * See styles/README.md for the packs and the precedence rules (defaults < style < brand).
 */

/** Present in every `styles/` directory, so it can be found before any pack exists. */
const MARKER = "README.md";
const ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The bundled `styles/` directory: `${CLAUDE_PLUGIN_ROOT}/styles`, else the first `styles/` with a
 * README.md found walking up from this module (the repo root in dev, the plugin root from
 * `dist/mcp.mjs`). Null when not installed.
 */
export function findStylesDir(env: Record<string, string | undefined> = process.env, from?: string): string | null {
  const root = env.CLAUDE_PLUGIN_ROOT;
  if (root && existsSync(join(root, "styles", MARKER))) return join(root, "styles");
  let dir = from ?? dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "styles");
    if (existsSync(join(candidate, MARKER))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function parseStyle(text: string, file: string, fileId: string): Style {
  const parsed = parseYamlOrJson(StyleSchema, text);
  if (!parsed.ok) throw new Error(`invalid style ${file}: ${parsed.errors.map((e) => `${e.path || "(root)"}: ${e.message}`).join("; ")}`);
  if (parsed.data.id !== fileId) throw new Error(`style ${file} has id "${parsed.data.id}" but is named "${fileId}.yaml"`);
  return parsed.data;
}

/** Load and validate every `<dir>/<id>.yaml`, sorted by id. Throws on any invalid pack. */
export async function loadStyles(dir: string): Promise<Style[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".yaml")).sort();
  const out: Style[] = [];
  for (const name of names) {
    const file = join(dir, name);
    out.push(parseStyle(await readFile(file, "utf8"), file, name.slice(0, -".yaml".length)));
  }
  return out;
}

/** Ids of the packs in `dir` (null dir: none). */
export async function styleIds(dir: string | null): Promise<string[]> {
  if (!dir) return [];
  return (await readdir(dir)).filter((n) => n.endsWith(".yaml")).map((n) => n.slice(0, -".yaml".length)).sort();
}

/** Load one pack by id. The error lists the available ids. */
export async function getStyle(dir: string | null, id: string): Promise<Style> {
  if (dir && ID.test(id)) {
    const file = join(dir, `${id}.yaml`);
    if (existsSync(file)) return parseStyle(await readFile(file, "utf8"), file, id);
  }
  const ids = await styleIds(dir);
  throw new Error(`unknown style "${id}"; available: ${ids.join(", ") || "(none: no styles/ directory found)"}`);
}

/** `<id>@<version>`, as recorded in tokens, the cache key and video.lock. */
export function styleRef(style: Pick<Style, "id" | "version">): string {
  return `${style.id}@${style.version}`;
}

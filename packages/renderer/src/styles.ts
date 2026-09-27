import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Style as StyleSchema, type Style, parseYamlOrJson } from "@video-studio/schema";

/**
 * Style packs: `styles/<id>.yaml` (look and motion), selected by `VideoSpec.style`.
 * See styles/README.md for the packs and the precedence rules (defaults < style < brand).
 *
 * Project-local packs: `<project>/styles/<id>.yaml` (e.g. written by `analyze write_style`) are
 * looked up before the bundled directory when a project dir is given. They are parsed as data with
 * the same schema, and their ref carries the file's sha256 so editing the file re-renders.
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

/**
 * The file hash of a pack loaded from a project's `styles/`, kept on the object under a symbol key:
 * it survives spreads (series palettes), and JSON / canonical hashing never see it.
 */
const PROJECT_SHA = Symbol.for("video-studio.style.project-sha256");

/** `<project>/styles`: where project-local packs live. */
export function projectStylesDir(projectDir: string): string {
  return join(projectDir, "styles");
}

function tagProject(style: Style, text: string): Style {
  Object.defineProperty(style, PROJECT_SHA, { value: createHash("sha256").update(text).digest("hex"), enumerable: true });
  return style;
}

/** The sha256 of a project-local pack's file; undefined for a bundled pack. */
export function projectStyleSha(style: object): string | undefined {
  return (style as { [PROJECT_SHA]?: string })[PROJECT_SHA];
}

async function yamlNames(dir: string | null): Promise<string[]> {
  if (!dir || !existsSync(dir)) return [];
  return (await readdir(dir)).filter((n) => n.endsWith(".yaml") && ID.test(n.slice(0, -".yaml".length))).sort();
}

/**
 * Load and validate every `<dir>/<id>.yaml`, sorted by id. Throws on any invalid pack. With a
 * project dir, the project's `styles/` packs come first and shadow bundled packs of the same id.
 */
export async function loadStyles(dir: string | null, projectDir?: string): Promise<Style[]> {
  const out = new Map<string, Style>();
  if (projectDir) {
    const pdir = projectStylesDir(projectDir);
    for (const name of await yamlNames(pdir)) {
      const file = join(pdir, name);
      const text = await readFile(file, "utf8");
      out.set(name.slice(0, -".yaml".length), tagProject(parseStyle(text, file, name.slice(0, -".yaml".length)), text));
    }
  }
  if (dir) {
    for (const name of (await readdir(dir)).filter((n) => n.endsWith(".yaml")).sort()) {
      const id = name.slice(0, -".yaml".length);
      if (out.has(id)) continue;
      const file = join(dir, name);
      out.set(id, parseStyle(await readFile(file, "utf8"), file, id));
    }
  }
  return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Ids of the packs in `dir` (null dir: none), plus the project's own packs when a project dir is given. */
export async function styleIds(dir: string | null, projectDir?: string): Promise<string[]> {
  const ids = new Set<string>();
  if (dir) for (const n of (await readdir(dir)).filter((n) => n.endsWith(".yaml"))) ids.add(n.slice(0, -".yaml".length));
  if (projectDir) for (const n of await yamlNames(projectStylesDir(projectDir))) ids.add(n.slice(0, -".yaml".length));
  return [...ids].sort();
}

/**
 * Load one pack by id: `<projectDir>/styles/<id>.yaml` first (when a project dir is given), then
 * the bundled `dir`. The error lists the available ids.
 */
export async function getStyle(dir: string | null, id: string, projectDir?: string): Promise<Style> {
  if (ID.test(id)) {
    if (projectDir) {
      const file = join(projectStylesDir(projectDir), `${id}.yaml`);
      if (existsSync(file)) {
        const text = await readFile(file, "utf8");
        return tagProject(parseStyle(text, file, id), text);
      }
    }
    if (dir) {
      const file = join(dir, `${id}.yaml`);
      if (existsSync(file)) return parseStyle(await readFile(file, "utf8"), file, id);
    }
  }
  const ids = await styleIds(dir, projectDir);
  throw new Error(`unknown style "${id}"; available: ${ids.join(", ") || "(none: no styles/ directory found)"}`);
}

/**
 * `<id>@<version>`, as recorded in tokens, the cache key and video.lock. A project-local pack adds
 * its file hash (`<id>@<version>+sha256:<hex>`), so editing the file re-renders without a version bump.
 */
export function styleRef(style: Pick<Style, "id" | "version">): string {
  const sha = projectStyleSha(style);
  return sha ? `${style.id}@${style.version}+sha256:${sha}` : `${style.id}@${style.version}`;
}

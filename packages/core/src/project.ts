import { randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep, dirname } from "node:path";
import { ensureDir, readJson, writeJsonAtomic } from "./fs-atomic.js";

/** Version of the on-disk project.json layout. Will move to @video-studio/schema later. */
export const PROJECT_SCHEMA_VERSION = 1;

export interface ProjectMeta {
  id: string;
  name: string;
  created_at: string;
  schema_version: number;
}

export interface ProjectPaths {
  root: string;
  source: string;
  project: string;
  projectFile: string;
  assets: string;
  assetsGenerated: string;
  assetsSupplied: string;
  assetsVoice: string;
  assetsMusic: string;
  renders: string;
  dist: string;
  qa: string;
}

export interface Project {
  meta: ProjectMeta;
  paths: ProjectPaths;
}

export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectError";
  }
}

export class PathTraversalError extends Error {
  constructor(readonly requested: string, reason: string) {
    super(`path "${requested}" rejected: ${reason}`);
    this.name = "PathTraversalError";
  }
}

export function projectPaths(dir: string): ProjectPaths {
  const root = resolve(dir);
  const assets = join(root, "assets");
  return {
    root,
    source: join(root, "source"),
    project: join(root, "project"),
    projectFile: join(root, "project", "project.json"),
    assets,
    assetsGenerated: join(assets, "generated"),
    assetsSupplied: join(assets, "supplied"),
    assetsVoice: join(assets, "voice"),
    assetsMusic: join(assets, "music"),
    renders: join(root, "renders"),
    dist: join(root, "dist"),
    qa: join(root, "qa"),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export interface InitProjectOptions {
  name: string;
  /** Injectable for tests. */
  now?: () => Date;
}

/** Create the standard project layout. Fails if `project/project.json` already exists. */
export async function initProject(dir: string, options: InitProjectOptions): Promise<Project> {
  if (!options.name.trim()) throw new ProjectError("project name must not be empty");
  const paths = projectPaths(dir);
  if (await exists(paths.projectFile)) {
    throw new ProjectError(`a project already exists at ${paths.root}`);
  }
  for (const d of [
    paths.source,
    paths.project,
    paths.assetsGenerated,
    paths.assetsSupplied,
    paths.assetsVoice,
    paths.assetsMusic,
    paths.renders,
    paths.dist,
    paths.qa,
  ]) {
    await ensureDir(d);
  }
  const meta: ProjectMeta = {
    id: randomUUID(),
    name: options.name,
    created_at: (options.now?.() ?? new Date()).toISOString(),
    schema_version: PROJECT_SCHEMA_VERSION,
  };
  await writeJsonAtomic(paths.projectFile, meta);
  return { meta, paths };
}

function validateMeta(value: unknown, file: string): ProjectMeta {
  const v = value as Partial<ProjectMeta> | null;
  if (
    !v ||
    typeof v !== "object" ||
    typeof v.id !== "string" ||
    typeof v.name !== "string" ||
    typeof v.created_at !== "string" ||
    typeof v.schema_version !== "number"
  ) {
    throw new ProjectError(`invalid project metadata in ${file}`);
  }
  if (v.schema_version > PROJECT_SCHEMA_VERSION) {
    throw new ProjectError(
      `project schema_version ${v.schema_version} is newer than supported (${PROJECT_SCHEMA_VERSION})`,
    );
  }
  return { id: v.id, name: v.name, created_at: v.created_at, schema_version: v.schema_version };
}

/** Open an existing project folder (must contain `project/project.json`). */
export async function openProject(dir: string): Promise<Project> {
  const paths = projectPaths(dir);
  let raw: unknown;
  try {
    raw = await readJson(paths.projectFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectError(`not a video-studio project (missing ${paths.projectFile})`);
    }
    throw err;
  }
  const s = await stat(paths.root);
  if (!s.isDirectory()) throw new ProjectError(`${paths.root} is not a directory`);
  return { meta: validateMeta(raw, paths.projectFile), paths };
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** realpath of the deepest existing ancestor of `path`, with the remainder re-appended. */
async function realpathOfExistingPrefix(path: string): Promise<string> {
  let current = path;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = dirname(current);
      if (parent === current) return path;
      rest.push(current.slice(parent.length).replace(/^[\\/]+/, ""));
      current = parent;
    }
  }
}

/**
 * Resolve a project-relative path to an absolute path inside the project root.
 * Rejects absolute paths, any `..` segment, NUL bytes, and paths that escape
 * the root through symlinks (checked via realpath of the deepest existing ancestor).
 * The target itself need not exist.
 */
export async function resolveInsideProject(project: Project | ProjectPaths, rel: string): Promise<string> {
  const root = "paths" in project ? project.paths.root : project.root;
  if (typeof rel !== "string" || rel.length === 0) throw new PathTraversalError(String(rel), "empty path");
  if (rel.includes("\0")) throw new PathTraversalError(rel, "contains NUL byte");
  if (isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith("\\")) {
    throw new PathTraversalError(rel, "absolute paths are not allowed");
  }
  if (rel.split(/[\\/]+/).includes("..")) throw new PathTraversalError(rel, "'..' segments are not allowed");
  const candidate = resolve(root, normalize(rel));
  if (!isWithin(root, candidate)) throw new PathTraversalError(rel, "escapes project root");
  const realRoot = await realpath(root);
  const realCandidate = await realpathOfExistingPrefix(candidate);
  if (!isWithin(realRoot, realCandidate)) {
    throw new PathTraversalError(rel, "escapes project root via symlink");
  }
  return candidate;
}

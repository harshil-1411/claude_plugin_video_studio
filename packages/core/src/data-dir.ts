import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ensureDir } from "./fs-atomic.js";

export interface DataDir {
  root: string;
  cache: string;
  db: string;
  deps: string;
}

export class DataDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataDirError";
  }
}

type Env = Record<string, string | undefined>;

/**
 * Resolve the per-user data directory (ledger, cache, lazily installed deps).
 * Order: CLAUDE_PLUGIN_DATA, VIDEO_STUDIO_DATA, ~/.video-studio.
 * Never resolves inside CLAUDE_PLUGIN_ROOT, which must stay read-only.
 */
export function resolveDataDir(env: Env = process.env, home: string = homedir()): DataDir {
  const pick = (v: string | undefined) => (v && v.trim() ? v : undefined);
  const root = resolve(pick(env.CLAUDE_PLUGIN_DATA) ?? pick(env.VIDEO_STUDIO_DATA) ?? join(home, ".video-studio"));
  const pluginRoot = pick(env.CLAUDE_PLUGIN_ROOT);
  if (pluginRoot) {
    const rel = relative(resolve(pluginRoot), root);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      throw new DataDirError(`data dir ${root} is inside CLAUDE_PLUGIN_ROOT; refusing to write there`);
    }
  }
  return { root, cache: join(root, "cache"), db: join(root, "db"), deps: join(root, "deps") };
}

/** Resolve and create the data directory and its subdirectories. */
export async function ensureDataDir(env: Env = process.env, home?: string): Promise<DataDir> {
  const dd = resolveDataDir(env, home);
  await Promise.all([ensureDir(dd.cache), ensureDir(dd.db), ensureDir(dd.deps)]);
  return dd;
}

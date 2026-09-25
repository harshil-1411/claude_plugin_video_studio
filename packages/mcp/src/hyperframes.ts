import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveDataDir } from "@video-studio/core";
import { HYPERFRAMES_VERSION, type HyperframesProducer, type HyperframesRendererOptions, createHyperframesRenderer, puppeteerLaunchProbe } from "@video-studio/renderer";

type Env = Record<string, string | undefined>;

const PACKAGE = "@hyperframes/producer";

/** Manual setup command (documented in skills/render and the doctor fix). */
export const HYPERFRAMES_INSTALL_COMMAND = `cd "\${CLAUDE_PLUGIN_DATA}" && PUPPETEER_SKIP_DOWNLOAD=1 npm i ${PACKAGE}@${HYPERFRAMES_VERSION} --prefix deps`;

export type ProducerResolution =
  | { ok: true; entry: string; dir: string; version: string; source: "plugin-data" | "plugin-root" }
  | { ok: false; reason: string; searched: string[] };

/**
 * The plugin root: CLAUDE_PLUGIN_ROOT, else the nearest ancestor of this module that holds
 * `.claude-plugin/plugin.json` (works from `dist/mcp.mjs` and from `packages/mcp/{src,dist}`).
 */
export function findPluginRoot(env: Env = process.env, from: string = dirname(fileURLToPath(import.meta.url))): string | null {
  const explicit = env.CLAUDE_PLUGIN_ROOT?.trim();
  if (explicit) return resolve(explicit);
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, ".claude-plugin", "plugin.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function entryOf(pkg: { exports?: unknown; main?: string; module?: string }): string | undefined {
  const exp = pkg.exports as Record<string, unknown> | string | undefined;
  if (typeof exp === "string") return exp;
  const dot = exp?.["."];
  if (typeof dot === "string") return dot;
  if (dot && typeof dot === "object") {
    const d = dot as Record<string, unknown>;
    for (const k of ["import", "default", "node"]) if (typeof d[k] === "string") return d[k] as string;
  }
  return pkg.module ?? pkg.main;
}

function inspect(nodeModules: string): { ok: true; entry: string; dir: string; version: string } | { ok: false; reason: string } | null {
  const dir = join(nodeModules, ...PACKAGE.split("/"));
  const pj = join(dir, "package.json");
  if (!existsSync(pj)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pj, "utf8")) as { version?: string; exports?: unknown; main?: string; module?: string };
    if (pkg.version !== HYPERFRAMES_VERSION) {
      return { ok: false, reason: `${PACKAGE} ${pkg.version ?? "?"} found in ${nodeModules}, but video-studio pins ${HYPERFRAMES_VERSION}` };
    }
    const rel = entryOf(pkg);
    if (!rel) return { ok: false, reason: `${PACKAGE} in ${nodeModules} has no ESM entry point` };
    const entry = resolve(dir, rel);
    if (!existsSync(entry)) return { ok: false, reason: `${PACKAGE} in ${nodeModules} is incomplete (missing ${rel})` };
    return { ok: true, entry, dir, version: pkg.version };
  } catch (e) {
    return { ok: false, reason: `${PACKAGE} in ${nodeModules} is unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Locate the pinned HyperFrames producer for the bundled engine, which cannot import it by
 * bare specifier (it is never bundled). Order:
 *  1. `${CLAUDE_PLUGIN_DATA}/deps/node_modules` (the documented manual install),
 *  2. the plugin/repo root's module path, via createRequire(pluginRoot).
 */
export function resolveHyperframesProducer(env: Env = process.env, opts: { pluginRoot?: string | null } = {}): ProducerResolution {
  const searched: string[] = [];
  const problems: string[] = [];
  const candidates: { dir: string; source: "plugin-data" | "plugin-root" }[] = [];
  try {
    candidates.push({ dir: join(resolveDataDir(env).deps, "node_modules"), source: "plugin-data" });
  } catch {
    /* data dir unusable: skip */
  }
  const root = opts.pluginRoot === undefined ? findPluginRoot(env) : opts.pluginRoot;
  if (root) {
    const req = createRequire(join(root, "package.json"));
    // Only `<ancestor>/node_modules` of the plugin root: NODE_PATH and global folders are not ours.
    const ancestors = new Set<string>();
    for (let d = resolve(root); ; d = dirname(d)) {
      ancestors.add(d);
      if (dirname(d) === d) break;
    }
    for (const p of req.resolve.paths(PACKAGE) ?? []) {
      if (basename(p) === "node_modules" && ancestors.has(dirname(p))) candidates.push({ dir: p, source: "plugin-root" });
    }
  }
  for (const c of candidates) {
    if (searched.includes(c.dir)) continue;
    searched.push(c.dir);
    const r = inspect(c.dir);
    if (!r) continue;
    if (r.ok) return { ...r, source: c.source };
    problems.push(r.reason);
  }
  return {
    ok: false,
    reason: problems[0] ?? `${PACKAGE} ${HYPERFRAMES_VERSION} is not installed; run doctor for setup`,
    searched,
  };
}

/**
 * Renderer options wired to the resolved producer. When nothing is found, the renderer's own
 * defaults stay in place (in a dev checkout it resolves the workspace dependency; in the bundle
 * that fails and `available()` reports "not installed; run doctor for setup").
 */
export function hyperframesOptions(env: Env = process.env, extra: HyperframesRendererOptions = {}): HyperframesRendererOptions & { resolution: ProducerResolution } {
  const resolution = resolveHyperframesProducer(env);
  if (!resolution.ok) return { ...extra, resolution };
  const url = pathToFileURL(resolution.entry).href;
  return {
    ...extra,
    resolution,
    producerInstalled: () => true,
    loadProducer: async () => (await import(url)) as HyperframesProducer,
    // Probe Chrome through the resolved producer's own puppeteer-core.
    launchProbe: (chromePath: string, timeoutMs: number) => puppeteerLaunchProbe(chromePath, timeoutMs, resolution.entry),
  };
}

export interface HyperframesCheck {
  id: "hyperframes";
  status: "ok" | "warn";
  detail: string;
  fix?: string;
}

/** Doctor check: is the producer installed, and does headless Chrome launch? */
export async function checkHyperframes(env: Env = process.env): Promise<HyperframesCheck> {
  const { resolution, ...opts } = hyperframesOptions(env);
  const renderer = createHyperframesRenderer(opts);
  const where = resolution.ok ? ` from ${resolution.dir} (${resolution.source})` : "";
  let a: { ok: boolean; reason?: string };
  try {
    a = await renderer.available(env as NodeJS.ProcessEnv);
  } catch (e) {
    a = { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  if (a.ok) return { id: "hyperframes", status: "ok", detail: `${PACKAGE} ${HYPERFRAMES_VERSION}${where}; headless Chrome launch probe ok` };
  const notInstalled = /not installed|pins|incomplete|no ESM entry/.test(a.reason ?? "");
  return {
    id: "hyperframes",
    status: "warn",
    detail: `HyperFrames renderer unavailable: ${a.reason ?? "unknown"} (the ffmpeg renderer is used instead)`,
    fix: notInstalled
      ? `Optional, for richer motion graphics: ${HYPERFRAMES_INSTALL_COMMAND} (needs Google Chrome installed).`
      : "Install Google Chrome or set CHROME_PATH to a Chrome/Chromium that can start headless; the ffmpeg renderer works meanwhile.",
  };
}

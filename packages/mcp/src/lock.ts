import { readdir, readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import { hashFile } from "@video-studio/core";
import { BUNDLED_FONTS, type FontResolver, createFontResolver, parseFontChain } from "@video-studio/renderer";
import { type LockChange, type LockChangeClass, VideoLock } from "@video-studio/schema";

/**
 * dist/video.lock: built at export from the render state (see VideoLock in @video-studio/schema),
 * and diffed to classify what changed between two renders.
 *
 * The lock is deterministic: no timestamps, every keyed array sorted, paths relative (to the
 * project root for assets and outputs, to the plugin root for bundled fonts), so re-exporting an
 * unchanged render writes a byte-identical file.
 */

export const LOCK_FILE = "video.lock";

const toPosix = (p: string) => p.split(sep).join("/");
const byKey = <T>(key: (x: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

// ------------------------------------------------------------------------------------ build

export type LockFont = VideoLock["fonts"][number];

/** A font the render asked for: a CSS family chain at a weight. */
export interface FontRequest {
  chain: string;
  weight: number;
}

const GENERIC_FAMILIES = new Set(["sans-serif", "serif", "monospace", "system-ui", "ui-monospace", "ui-sans-serif", "cursive", "fantasy"]);

/**
 * Resolve each request the way the renderers do (bundled fonts first, then host fonts) and hash
 * the file. Bundled files are recorded as `fonts/<family dir>/<file>` (relative to the plugin
 * root); host files as `host/<basename>`, so the lock never holds a machine-specific path.
 * Requests that resolve to no file are skipped (the render reported that already).
 */
export async function lockFonts(requests: readonly FontRequest[], opts: { fontsDir: string | null; env?: NodeJS.ProcessEnv; resolver?: FontResolver }): Promise<LockFont[]> {
  const resolve = opts.resolver ?? createFontResolver(opts.env ?? process.env, { fontsDir: opts.fontsDir });
  const out = new Map<string, LockFont>();
  for (const r of requests) {
    let file: string;
    try {
      file = await resolve(r.chain, r.weight);
    } catch {
      continue;
    }
    const weight = r.weight >= 600 ? 700 : 400;
    const inBundle = opts.fontsDir ? toPosix(relative(opts.fontsDir, file)) : "";
    const bundled = inBundle && !inBundle.startsWith("..") && !isAbsolute(inBundle) ? BUNDLED_FONTS.find((f) => f.file === inBundle) : undefined;
    const family = bundled?.family ?? parseFontChain(r.chain).find((n) => !GENERIC_FAMILIES.has(n.toLowerCase())) ?? basename(file, extname(file));
    const entry: LockFont = { family, weight, file: bundled ? `fonts/${bundled.file}` : `host/${basename(file)}`, sha256: await hashFile(file) };
    out.set(`${entry.family}\u0000${entry.weight}\u0000${entry.file}`, entry);
  }
  return [...out.values()];
}

/** Hash project-relative input files that exist; missing ones are skipped. */
export async function lockAssets(root: string, relPaths: readonly string[]): Promise<VideoLock["assets"]> {
  const out = new Map<string, string>();
  for (const p of relPaths) {
    try {
      out.set(toPosix(p), await hashFile(join(root, p)));
    } catch {
      // not there: not an input of this render
    }
  }
  return [...out].map(([path, sha256]) => ({ path, sha256 }));
}

/** Files under `dir` (project-relative, posix), recursively, skipping dotfiles and `skip` subtrees. */
export async function listFiles(root: string, dir: string, skip: readonly string[] = []): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    let entries;
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (skip.includes(child)) continue;
      if (e.isDirectory()) await walk(child);
      else if (e.isFile()) out.push(child);
    }
  };
  await walk(toPosix(dir));
  return out.sort();
}

/**
 * Normalise and validate a lock: sort every keyed array (scenes keep spec order), drop duplicate
 * outputs, and parse with VideoLock. Throws when the input does not match the schema.
 */
export function buildLock(input: VideoLock): VideoLock {
  const sortedRecord = (r: Record<string, string>) => Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const outputs = new Map(input.outputs.map((o) => [o.path, o]));
  const lock: VideoLock = {
    schema_version: input.schema_version,
    project_id: input.project_id,
    quality: input.quality,
    spec_sha256: input.spec_sha256,
    ...(input.content_ir_sha256 ? { content_ir_sha256: input.content_ir_sha256 } : {}),
    engine: sortedRecord(input.engine),
    tools: sortedRecord(input.tools),
    voice: { backend: input.voice.backend, ...(input.voice.voice_id ? { voice_id: input.voice.voice_id } : {}), request_hash: input.voice.request_hash },
    fonts: [...input.fonts].sort((a, b) => byKey<LockFont>((f) => f.family)(a, b) || a.weight - b.weight || byKey<LockFont>((f) => f.file)(a, b)),
    targets: [...input.targets].sort(byKey((t) => t.id)),
    scenes: input.scenes.map((s) => ({ scene_id: s.scene_id, renderer: s.renderer, renderer_version: s.renderer_version, cache_key: s.cache_key, clip_sha256: s.clip_sha256 })),
    assets: [...input.assets].sort(byKey((a) => a.path)),
    outputs: [...outputs.values()]
      .filter((o) => !/(^|\/)dist\/(video\.lock|render-manifest\.json)$/.test(o.path))
      .map((o) => ({ path: o.path, sha256: o.sha256, ...(o.target ? { target: o.target } : {}) }))
      .sort(byKey((o) => o.path)),
  };
  return VideoLock.parse(lock);
}

/** The lock file's text: pretty JSON with a trailing newline. */
export function serializeLock(lock: VideoLock): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

/** Read and validate a lock file; undefined when it does not exist. Throws on an invalid lock. */
export async function readLock(path: string): Promise<VideoLock | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${e instanceof Error ? e.message : String(e)}); re-export the project to rewrite it`);
  }
  const parsed = VideoLock.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`);
    throw new Error(`${path} is not a valid video.lock: ${issues.join("; ")}; re-export the project to rewrite it`);
  }
  return parsed.data;
}

// ------------------------------------------------------------------------------------ diff

const CLASS_ORDER: readonly LockChangeClass[] = ["creative", "renderer", "spec", "asset", "metadata"];

/**
 * Changes from `before` to `after`, each classified; empty when the locks are equal. Sorted by
 * class then path.
 *
 * - spec hash, voice request hash, scene list/order → creative.
 * - engine.*, tools.* (except tools.style: creative), voice backend/voice id, fonts, a scene's renderer or renderer_version → renderer.
 * - targets (contract_version, verified, added/removed) → spec.
 * - content_ir_sha256 and assets.* → asset.
 * - a scene's cache_key/clip_sha256 → creative when the spec changed; otherwise the class of the
 *   cause (that scene's renderer, then any renderer, spec or asset change); with no cause at all,
 *   renderer (the same inputs gave a different clip).
 * - outputs.* → metadata when nothing above changed; otherwise the first cause class in
 *   creative, asset, spec, renderer order.
 * - schema_version, project_id, quality → metadata.
 */
export function diffLocks(before: VideoLock, after: VideoLock): LockChange[] {
  const changes: LockChange[] = [];
  const add = (cls: LockChangeClass, path: string, b: string | undefined, a: string | undefined, message: string) => {
    changes.push({ class: cls, path, ...(b !== undefined ? { before: b } : {}), ...(a !== undefined ? { after: a } : {}), message });
  };
  const field = (cls: LockChangeClass, path: string, b: string | undefined, a: string | undefined, what: string) => {
    if (b === a) return;
    const message = b === undefined ? `${what} added` : a === undefined ? `${what} removed` : `${what} changed`;
    add(cls, path, b, a, message);
  };
  const record = (cls: LockChangeClass, prefix: string, b: Record<string, string>, a: Record<string, string>, what: string) => {
    for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) field(cls, `${prefix}.${k}`, b[k], a[k], `${what} ${k}`);
  };
  /** Keyed list diff: added/removed entries and per-field changes. */
  const keyed = <T extends object>(
    prefix: string,
    b: readonly T[],
    a: readonly T[],
    key: (x: T) => string,
    classOf: (field: string) => LockChangeClass,
    what: string,
  ) => {
    const bm = new Map(b.map((x) => [key(x), x]));
    const am = new Map(a.map((x) => [key(x), x]));
    for (const k of new Set([...bm.keys(), ...am.keys()])) {
      const x = bm.get(k);
      const y = am.get(k);
      if (!x || !y) {
        add(classOf(""), `${prefix}.${k}`, x ? summary(x) : undefined, y ? summary(y) : undefined, `${what} ${k} ${x ? "removed" : "added"}`);
        continue;
      }
      const xr = x as Record<string, unknown>;
      const yr = y as Record<string, unknown>;
      for (const f of new Set([...Object.keys(xr), ...Object.keys(yr)])) {
        field(classOf(f), `${prefix}.${k}.${f}`, str(xr[f]), str(yr[f]), `${what} ${k} ${f}`);
      }
    }
  };

  field("metadata", "schema_version", before.schema_version, after.schema_version, "lock schema version");
  field("metadata", "project_id", before.project_id, after.project_id, "project id");
  field("metadata", "quality", before.quality, after.quality, "render quality");
  field("creative", "spec_sha256", before.spec_sha256, after.spec_sha256, "video spec");
  field("asset", "content_ir_sha256", before.content_ir_sha256, after.content_ir_sha256, "ContentIR");
  record("renderer", "engine", before.engine, after.engine, "engine component");
  // The style pack is a creative choice (the look), not a tool version.
  const { style: bStyle, ...bTools } = before.tools;
  const { style: aStyle, ...aTools } = after.tools;
  record("renderer", "tools", bTools, aTools, "tool");
  field("creative", "tools.style", bStyle, aStyle, "style pack");
  field("renderer", "voice.backend", before.voice.backend, after.voice.backend, "voice backend");
  field("renderer", "voice.voice_id", before.voice.voice_id, after.voice.voice_id, "voice id");
  field("creative", "voice.request_hash", before.voice.request_hash, after.voice.request_hash, "voiceover request");
  keyed("fonts", before.fonts, after.fonts, (f) => `${f.family}@${f.weight}`, () => "renderer", "font");
  keyed("targets", before.targets, after.targets, (t) => t.id, () => "spec", "platform contract");
  keyed("assets", before.assets, after.assets, (x) => x.path, () => "asset", "input");

  // Scenes: list/order and renderer fields first; clip changes are attributed afterwards.
  const bIds = before.scenes.map((s) => s.scene_id).join(",");
  const aIds = after.scenes.map((s) => s.scene_id).join(",");
  if (bIds !== aIds) add("creative", "scenes", bIds, aIds, "scene list or order changed");
  const specChanged = before.spec_sha256 !== after.spec_sha256;
  const causes = new Set(changes.map((c) => c.class));
  const bScenes = new Map(before.scenes.map((s) => [s.scene_id, s]));
  for (const s of after.scenes) {
    const p = bScenes.get(s.scene_id);
    if (!p) continue;
    field("renderer", `scenes.${s.scene_id}.renderer`, p.renderer, s.renderer, `scene ${s.scene_id} renderer`);
    field("renderer", `scenes.${s.scene_id}.renderer_version`, p.renderer_version, s.renderer_version, `scene ${s.scene_id} renderer version`);
    const ownRenderer = p.renderer !== s.renderer || p.renderer_version !== s.renderer_version;
    const cls: LockChangeClass = specChanged
      ? "creative"
      : ownRenderer || causes.has("renderer")
        ? "renderer"
        : causes.has("spec")
          ? "spec"
          : causes.has("asset")
            ? "asset"
            : "renderer";
    const why = specChanged ? "" : cls === "renderer" && !ownRenderer && !causes.has("renderer") ? " with unchanged inputs (non-deterministic render?)" : ` (follows a ${cls} change)`;
    for (const f of ["cache_key", "clip_sha256"] as const) {
      if (p[f] !== s[f]) add(cls, `scenes.${s.scene_id}.${f}`, p[f], s[f], `scene ${s.scene_id} ${f === "cache_key" ? "inputs" : "clip"} changed${why}`);
    }
  }

  // Outputs: metadata only when nothing upstream changed.
  const upstream = new Set(changes.filter((c) => c.class !== "metadata").map((c) => c.class));
  const outCls: LockChangeClass = (["creative", "asset", "spec", "renderer"] as const).find((c) => upstream.has(c)) ?? "metadata";
  keyed("outputs", before.outputs, after.outputs, (o) => o.path, () => outCls, "output");
  if (outCls !== "metadata") {
    for (const c of changes) if (c.path.startsWith("outputs.")) c.message += ` (follows a ${outCls} change)`;
  }

  return changes.sort((a, b) => CLASS_ORDER.indexOf(a.class) - CLASS_ORDER.indexOf(b.class) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return typeof v === "string" ? v : JSON.stringify(v);
}

function summary(x: object): string {
  return Object.entries(x)
    .map(([k, v]) => `${k}=${str(v)}`)
    .join(" ");
}

const short = (v: string | undefined) => (v === undefined ? "(none)" : /^[a-f0-9]{64}$/.test(v) ? `${v.slice(0, 12)}…` : v);

/** Short markdown list of changes grouped by class. */
export function formatLockChanges(changes: readonly LockChange[]): string {
  if (changes.length === 0) return "No changes: the locks are identical.";
  const lines: string[] = [];
  for (const cls of CLASS_ORDER) {
    const group = changes.filter((c) => c.class === cls);
    if (!group.length) continue;
    if (lines.length) lines.push("");
    lines.push(`**${cls}** (${group.length})`);
    for (const c of group) lines.push(`- \`${c.path}\`: ${short(c.before)} → ${short(c.after)} (${c.message})`);
  }
  return lines.join("\n");
}

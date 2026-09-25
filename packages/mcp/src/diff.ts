import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { projectPaths, writeFileAtomic, writeJsonAtomic } from "@video-studio/core";
import { extractFrame, frameDiffImage, frameSsim } from "@video-studio/media";
import type { LockChange } from "@video-studio/schema";
import { GOLDEN_SSIM_THRESHOLD, type Quality, type ResolvedRender, renderSamples, resolveRender } from "./golden.js";
import { LOCK_FILE, diffLocks, formatLockChanges, readLock } from "./lock.js";

/**
 * diff: compare two renders (two project folders, or the same folder's preview vs final):
 * a spec diff, a video.lock diff (diffLocks in lock.ts) and a sampled frame diff.
 * Read-only apart from project b's qa/diff.{json,md} and qa/diff-frames/.
 */

/** Frames are compared this many px wide (or narrower when a reel is narrower). */
export const DIFF_FRAME_WIDTH = 320;
/** A frame pair below this SSIM is flagged (same threshold as the golden-frame test). */
export const DIFF_SSIM_THRESHOLD = GOLDEN_SSIM_THRESHOLD;
/** Long values in the spec diff are cut to this many characters. */
const MAX_VALUE_CHARS = 120;
/** At most this many spec changes are listed in the markdown report (the JSON has all). */
const MAX_MD_CHANGES = 60;

export interface SpecChange {
  kind: "added" | "removed" | "changed" | "reordered";
  /** JSON path, with id-keyed array items as `scenes[s02]`, e.g. `scenes[s02].voiceover`. */
  path: string;
  before?: string;
  after?: string;
}

export interface DiffSide {
  project: string;
  quality?: Quality;
  /** `renders/<q>` or `dist`. */
  source: string;
  reel: string;
  spec?: string;
  width: number;
  height: number;
  fps: number;
  duration_ms: number;
}

export interface FrameDiff {
  label: string;
  at_sec_a: number;
  at_sec_b: number;
  ssim?: number;
  pass: boolean;
  /** a | b | difference image for flagged frames, relative to project b. */
  image?: string;
  error?: string;
}

export interface DiffResult {
  identical: boolean;
  a: DiffSide;
  b: DiffSide;
  spec: {
    compared: boolean;
    reason?: string;
    changes: SpecChange[];
    scenes_added: string[];
    scenes_removed: string[];
    scenes_changed: string[];
  };
  lock: { compared: boolean; reason?: string; changes: LockChange[] };
  frames: { compared: boolean; reason?: string; threshold: number; width: number; samples: FrameDiff[] };
  report_json: string;
  report_md: string;
}

// ------------------------------------------------------------------------------------ spec diff

function fmt(v: unknown): string {
  const s = typeof v === "string" ? JSON.stringify(v) : (JSON.stringify(v) ?? String(v));
  return s.length > MAX_VALUE_CHARS ? `${s.slice(0, MAX_VALUE_CHARS - 1)}…` : s;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keyedById = (arr: unknown[]): arr is Array<Record<string, unknown> & { id: string }> =>
  arr.length > 0 && arr.every((x) => isObj(x) && typeof x.id === "string") && new Set(arr.map((x) => (x as { id: string }).id)).size === arr.length;
const join_ = (path: string, key: string) => (path ? `${path}.${key}` : key);

/** Structural diff of two JSON values; arrays of objects with unique `id`s are matched by id. */
export function diffJson(a: unknown, b: unknown, path = "", out: SpecChange[] = []): SpecChange[] {
  if (a === b) return out;
  if (a === undefined) {
    out.push({ kind: "added", path, after: fmt(b) });
    return out;
  }
  if (b === undefined) {
    out.push({ kind: "removed", path, before: fmt(a) });
    return out;
  }
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) diffJson(a[k], b[k], join_(path, k), out);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if ((keyedById(a) || a.length === 0) && (keyedById(b) || b.length === 0) && (a.length > 0 || b.length > 0)) {
      const ma = new Map(a.map((x) => [(x as { id: string }).id, x]));
      const mb = new Map(b.map((x) => [(x as { id: string }).id, x]));
      for (const [id, x] of ma) diffJson(x, mb.get(id), `${path}[${id}]`, out);
      for (const [id, x] of mb) if (!ma.has(id)) diffJson(undefined, x, `${path}[${id}]`, out);
      const common = (ids: string[], other: Map<string, unknown>) => ids.filter((id) => other.has(id));
      const oa = common([...ma.keys()], mb);
      const ob = common([...mb.keys()], ma);
      if (oa.join("\0") !== ob.join("\0")) out.push({ kind: "reordered", path, before: fmt(oa), after: fmt(ob) });
      return out;
    }
    if (a.every((x) => !isObj(x) && !Array.isArray(x)) && b.every((x) => !isObj(x) && !Array.isArray(x))) {
      if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ kind: "changed", path, before: fmt(a), after: fmt(b) });
      return out;
    }
    for (let i = 0; i < Math.max(a.length, b.length); i++) diffJson(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ kind: "changed", path, before: fmt(a), after: fmt(b) });
  return out;
}

function summariseScenes(changes: readonly SpecChange[]): Pick<DiffResult["spec"], "scenes_added" | "scenes_removed" | "scenes_changed"> {
  const added: string[] = [];
  const removed: string[] = [];
  const changed = new Set<string>();
  for (const c of changes) {
    const m = /^scenes\[([^\]]+)\](.*)$/.exec(c.path);
    if (!m) continue;
    if (!m[2] && c.kind === "added") added.push(m[1]!);
    else if (!m[2] && c.kind === "removed") removed.push(m[1]!);
    else changed.add(m[1]!);
  }
  return { scenes_added: added, scenes_removed: removed, scenes_changed: [...changed] };
}

// ------------------------------------------------------------------------------------ sides

const rel = (root: string, p: string) => relative(root, p).split("\\").join("/") || ".";

/** The spec a render used: dist/video-spec.json when dist holds that render, else project/video-spec.json. */
async function specPathFor(r: ResolvedRender): Promise<string | undefined> {
  const paths = projectPaths(r.root);
  const distSpec = join(paths.dist, "video-spec.json");
  let distQuality: string | undefined;
  try {
    distQuality = (JSON.parse(await readFile(join(paths.dist, "render-manifest.json"), "utf8")) as { settings?: { quality?: string } }).settings?.quality;
  } catch {
    distQuality = undefined;
  }
  if (existsSync(distSpec) && (r.source === "dist" || !distQuality || distQuality === r.quality)) return distSpec;
  const projSpec = join(paths.project, "video-spec.json");
  return existsSync(projSpec) ? projSpec : undefined;
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

// ------------------------------------------------------------------------------------ diff

/**
 * Compare render a with render b. Same-folder comparisons pick renders/<quality_a> and
 * renders/<quality_b>. Writes b's qa/diff.json and qa/diff.md, and a | b | difference images of
 * flagged frames under b's qa/diff-frames/.
 */
export async function diffProjects(a: string, b: string, opts: { quality_a?: Quality; quality_b?: Quality } = {}): Promise<DiffResult> {
  const ra = await resolveRender(a, opts.quality_a);
  const rb = await resolveRender(b, opts.quality_b);
  const pb = projectPaths(rb.root);
  const [specA, specB] = await Promise.all([specPathFor(ra), specPathFor(rb)]);
  const side = (r: ResolvedRender, spec: string | undefined): DiffSide => ({
    project: r.root,
    ...(r.quality ? { quality: r.quality } : {}),
    source: r.source,
    reel: rel(r.root, r.reel),
    ...(spec ? { spec: rel(r.root, spec) } : {}),
    width: r.width,
    height: r.height,
    fps: r.fps,
    duration_ms: r.duration_ms,
  });

  // 1. spec
  let spec: DiffResult["spec"];
  if (!specA || !specB) {
    spec = { compared: false, reason: `no video-spec.json in ${!specA ? ra.root : rb.root}`, changes: [], scenes_added: [], scenes_removed: [], scenes_changed: [] };
  } else {
    const changes = diffJson(await readJsonFile(specA), await readJsonFile(specB));
    spec = { compared: true, changes, ...summariseScenes(changes) };
  }

  // 2. lock
  let lock: DiffResult["lock"];
  // Prefer the per-quality copy in renders/<q>/ (export writes it next to dist/video.lock).
  const lockFor = async (r: ResolvedRender) => (r.quality ? await readLock(join(projectPaths(r.root).renders, r.quality, LOCK_FILE)) : undefined) ?? readLock(join(projectPaths(r.root).dist, LOCK_FILE));
  try {
    const [la, lb] = await Promise.all([lockFor(ra), lockFor(rb)]);
    if (!la || !lb) {
      lock = { compared: false, reason: `no dist/${LOCK_FILE} in ${[!la ? ra.root : "", !lb ? rb.root : ""].filter(Boolean).join(" and ")} (re-export to write one)`, changes: [] };
    } else if ((ra.quality && la.quality !== ra.quality) || (rb.quality && lb.quality !== rb.quality)) {
      lock = { compared: false, reason: `dist/${LOCK_FILE} is for a different quality than the render compared (export that quality to refresh it)`, changes: [] };
    } else {
      lock = { compared: true, changes: diffLocks(la, lb) };
    }
  } catch (err) {
    lock = { compared: false, reason: `could not read dist/${LOCK_FILE}: ${(err as Error).message}`, changes: [] };
  }

  // 3. frames
  const width = Math.min(DIFF_FRAME_WIDTH, ra.width || DIFF_FRAME_WIDTH, rb.width || DIFF_FRAME_WIDTH);
  const framesOut = join(pb.qa, "diff-frames");
  await rm(framesOut, { recursive: true, force: true });
  let frames: DiffResult["frames"];
  const aspectA = ra.height ? ra.width / ra.height : 0;
  const aspectB = rb.height ? rb.width / rb.height : 0;
  if (!aspectA || !aspectB || Math.abs(aspectA - aspectB) > 0.01) {
    frames = { compared: false, reason: `aspect ratios differ (${ra.width}x${ra.height} vs ${rb.width}x${rb.height}); frames not compared`, threshold: DIFF_SSIM_THRESHOLD, width, samples: [] };
  } else {
    // Work files live in b's qa/ (always writable; the MCP server may not inherit TMPDIR).
    await mkdir(pb.qa, { recursive: true });
    const work = await mkdtemp(join(pb.qa, ".diff-work-"));
    try {
      const durA = ra.duration_ms / 1000;
      const durB = rb.duration_ms / 1000;
      const lastB = Math.max(0, durB - 1 / (rb.fps || 30));
      const samples: FrameDiff[] = [];
      for (const [i, s] of renderSamples(ra).entries()) {
        const atB = Math.round(Math.min(lastB, durA > 0 ? (s.at_sec / durA) * durB : s.at_sec) * 1000) / 1000;
        const name = `${String(i).padStart(2, "0")}-${s.label.replace(/[^A-Za-z0-9_-]/g, "_")}`;
        const fa = join(work, `${name}.a.png`);
        const fb = join(work, `${name}.b.png`);
        const entry: FrameDiff = { label: s.label, at_sec_a: s.at_sec, at_sec_b: atB, pass: false };
        try {
          await extractFrame(ra.reel, s.at_sec, fa, { width });
          await extractFrame(rb.reel, atB, fb, { width });
          entry.ssim = Math.round((await frameSsim(fa, fb)) * 10000) / 10000;
          entry.pass = entry.ssim >= DIFF_SSIM_THRESHOLD;
          if (!entry.pass) {
            await mkdir(framesOut, { recursive: true });
            const img = join(framesOut, `${name}.png`);
            await frameDiffImage(fa, fb, img);
            entry.image = rel(pb.root, img);
          }
        } catch (err) {
          entry.error = (err as Error).message.split("\n")[0]!;
        }
        samples.push(entry);
      }
      frames = { compared: true, threshold: DIFF_SSIM_THRESHOLD, width, samples };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  const identical = spec.compared && spec.changes.length === 0 && lock.changes.length === 0 && frames.compared && frames.samples.every((f) => f.pass);
  const result: DiffResult = {
    identical,
    a: side(ra, specA),
    b: side(rb, specB),
    spec,
    lock,
    frames,
    report_json: "qa/diff.json",
    report_md: "qa/diff.md",
  };
  await writeJsonAtomic(join(pb.qa, "diff.json"), result);
  await writeFileAtomic(join(pb.qa, "diff.md"), diffMarkdown(result));
  return result;
}

// ------------------------------------------------------------------------------------ reports

function lockList(changes: readonly LockChange[]): string {
  try {
    return formatLockChanges(changes);
  } catch {
    return changes.map((c) => `- ${c.class} \`${c.path}\`: ${c.message}`).join("\n");
  }
}

const sideLabel = (s: DiffSide) => `${s.project} (${s.quality ?? "?"}, ${s.source}, ${s.width}x${s.height}@${s.fps}, ${s.duration_ms / 1000}s)`;

function diffMarkdown(r: DiffResult): string {
  const lines = ["# Render diff", "", `- A: ${sideLabel(r.a)}`, `- B: ${sideLabel(r.b)}`, `- Identical: **${r.identical ? "yes" : "no"}**`, "", "## Spec", ""];
  if (!r.spec.compared) lines.push(`Not compared: ${r.spec.reason}`);
  else if (!r.spec.changes.length) lines.push("No changes.");
  else {
    if (r.spec.scenes_added.length) lines.push(`- Scenes added: ${r.spec.scenes_added.join(", ")}`);
    if (r.spec.scenes_removed.length) lines.push(`- Scenes removed: ${r.spec.scenes_removed.join(", ")}`);
    if (r.spec.scenes_changed.length) lines.push(`- Scenes changed: ${r.spec.scenes_changed.join(", ")}`);
    lines.push("", "| Change | Path | Before | After |", "|---|---|---|---|");
    const cell = (s?: string) => (s === undefined ? "" : `\`${s.replace(/\|/g, "\\|").replace(/`/g, "'")}\``);
    for (const c of r.spec.changes.slice(0, MAX_MD_CHANGES)) lines.push(`| ${c.kind} | \`${c.path || "(root)"}\` | ${cell(c.before)} | ${cell(c.after)} |`);
    if (r.spec.changes.length > MAX_MD_CHANGES) lines.push("", `…and ${r.spec.changes.length - MAX_MD_CHANGES} more (see qa/diff.json).`);
  }
  lines.push("", "## Lock", "");
  if (!r.lock.compared) lines.push(`Not compared: ${r.lock.reason}`);
  else lines.push(r.lock.changes.length ? lockList(r.lock.changes) : "No changes.");
  lines.push("", "## Frames", "");
  if (!r.frames.compared) lines.push(`Not compared: ${r.frames.reason}`);
  else {
    lines.push(`SSIM threshold ${r.frames.threshold}, compared ${r.frames.width} px wide.`, "", "| Frame | A (s) | B (s) | SSIM | Result | Image |", "|---|---|---|---|---|---|");
    for (const f of r.frames.samples) {
      lines.push(`| ${f.label} | ${f.at_sec_a} | ${f.at_sec_b} | ${f.ssim ?? "-"} | ${f.pass ? "same" : f.error ? `error: ${f.error.replace(/\|/g, "\\|")}` : "DIFFERS"} | ${f.image ? `\`${f.image}\`` : ""} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function formatDiff(r: DiffResult): string {
  const flagged = r.frames.samples.filter((f) => !f.pass);
  const lines = [
    `diff: ${r.identical ? "identical" : "different"} (${r.a.quality ?? "?"} ${r.a.project} → ${r.b.quality ?? "?"} ${r.b.project}); report ${r.report_md}`,
    r.spec.compared
      ? `- spec: ${r.spec.changes.length} change(s)${r.spec.scenes_added.length ? `; added ${r.spec.scenes_added.join(", ")}` : ""}${r.spec.scenes_removed.length ? `; removed ${r.spec.scenes_removed.join(", ")}` : ""}${r.spec.scenes_changed.length ? `; changed ${r.spec.scenes_changed.join(", ")}` : ""}`
      : `- spec: not compared (${r.spec.reason})`,
    r.lock.compared
      ? `- lock: ${r.lock.changes.length} change(s)${r.lock.changes.length ? ` (${[...new Set(r.lock.changes.map((c) => c.class))].join(", ")})` : ""}`
      : `- lock: not compared (${r.lock.reason})`,
    r.frames.compared
      ? `- frames: ${r.frames.samples.length - flagged.length}/${r.frames.samples.length} above SSIM ${r.frames.threshold}${flagged.length ? `; differ: ${flagged.map((f) => `${f.label}${f.ssim !== undefined ? ` (${f.ssim})` : ""}`).join(", ")}` : ""}`
      : `- frames: not compared (${r.frames.reason})`,
  ];
  for (const c of r.spec.changes.slice(0, 10)) lines.push(`  - ${c.kind} ${c.path || "(root)"}${c.before !== undefined ? `: ${c.before}` : ""}${c.after !== undefined ? ` → ${c.after}` : ""}`);
  if (r.spec.changes.length > 10) lines.push(`  - …${r.spec.changes.length - 10} more in ${r.report_md}`);
  return lines.join("\n");
}

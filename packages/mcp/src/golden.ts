import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { hashFile, projectPaths, readJson, writeFileAtomic, writeJsonAtomic } from "@video-studio/core";
import { extractFrame, ffprobe, frameDiffImage, frameSsim, pngSize } from "@video-studio/media";

/**
 * test: golden-frame regression test for a rendered project. Samples frames of the render's reel
 * at deterministic times (each scene's midpoint plus the first and last frames), downscaled, and
 * compares them (SSIM) with the golden frames stored in the project under golden/<quality>/;
 * `update` re-records them. Goldens are durable project files, never plugin data.
 */

/** Golden frames are this many px wide (height keeps the aspect), so committed goldens stay tiny. */
export const GOLDEN_FRAME_WIDTH = 160;
/**
 * A frame passes when its SSIM against the golden is at least this. Tolerant of encoder and
 * ffmpeg version noise (typically > 0.99) while catching layout, text and colour changes.
 */
export const GOLDEN_SSIM_THRESHOLD = 0.97;
export const GOLDEN_DIR = "golden";
export const GOLDEN_FILE = "golden.json";
const GOLDEN_VERSION = 1;

export type Quality = "preview" | "final";

/** The parts of renders/<quality>/render-state.json test and diff read (written by the pipeline). */
export interface RenderStateView {
  quality?: Quality;
  spec_sha256?: string;
  target?: { width: number; height: number; fps: number };
  duration_ms?: number;
  reel?: string;
  scenes?: Array<{ scene_id: string; duration_ms: number }>;
}

/** One sampled frame time. */
export interface FrameSample {
  /** `first`, `last` or a scene id. */
  label: string;
  scene_id?: string;
  at_sec: number;
}

/** A located render: its quality, state (when there is one) and reel. */
export interface ResolvedRender {
  root: string;
  quality?: Quality;
  state?: RenderStateView;
  /** Absolute path of the reel. */
  reel: string;
  duration_ms: number;
  width: number;
  height: number;
  fps: number;
  /** Where the render came from, for reports: `renders/<q>` or `dist`. */
  source: string;
}

interface GoldenFile {
  version: number;
  quality: Quality;
  width: number;
  threshold: number;
  reel_sha256: string;
  spec_sha256?: string;
  target: { width: number; height: number; fps: number };
  duration_ms: number;
  frames: Array<FrameSample & { file: string }>;
}

export interface GoldenFrameResult extends FrameSample {
  /** Golden frame, relative to the project. */
  golden: string;
  ssim?: number;
  pass: boolean;
  /** For failing frames: the current frame and a golden | current | difference image, relative to the project. */
  actual?: string;
  diff?: string;
}

export interface GoldenResult {
  status: "pass" | "fail" | "updated" | "missing";
  quality?: Quality;
  /** golden/<quality>, relative to the project. */
  golden_dir: string;
  threshold: number;
  /** True when the reel is byte-identical to the one the goldens were recorded from. */
  reel_identical?: boolean;
  frames: GoldenFrameResult[];
  /** Why the test failed or is missing, when it did not simply compare frames. */
  message?: string;
  fix?: string;
  report_json: string;
  report_md: string;
}

// ------------------------------------------------------------------------------------ helpers

async function readOptionalJson<T>(path: string): Promise<T | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return await readJson<T>(path);
  } catch {
    return undefined;
  }
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const rel = (root: string, p: string) => relative(root, p).split("\\").join("/");

/** Time of the middle of frame `i` at `fps`, so seeks never land on a frame boundary. */
const frameCentre = (i: number, fps: number) => round3((i + 0.5) / fps);

/**
 * Deterministic sample times: the first frame, each scene's midpoint, and the last frame, each
 * snapped to a frame centre; times within a frame of each other are merged. Without scenes, the
 * reel is sampled at 25%, 50% and 75%.
 */
export function sampleTimes(r: { duration_ms: number; fps: number; scenes?: ReadonlyArray<{ scene_id: string; duration_ms: number }> }): FrameSample[] {
  const fps = r.fps > 0 ? r.fps : 30;
  const frames = Math.max(1, Math.floor((r.duration_ms / 1000) * fps));
  const snap = (sec: number) => frameCentre(Math.min(frames - 1, Math.max(0, Math.floor(sec * fps))), fps);
  const out: FrameSample[] = [{ label: "first", at_sec: frameCentre(0, fps) }];
  if (r.scenes && r.scenes.length > 0) {
    let start = 0;
    for (const s of r.scenes) {
      out.push({ label: s.scene_id, scene_id: s.scene_id, at_sec: snap((start + s.duration_ms / 2) / 1000) });
      start += s.duration_ms;
    }
  } else {
    for (const f of [0.25, 0.5, 0.75]) out.push({ label: `p${Math.round(f * 100)}`, at_sec: snap((r.duration_ms / 1000) * f) });
  }
  // The last frame is often cut short by the encoder; the one before it is always there.
  out.push({ label: "last", at_sec: frameCentre(Math.max(0, frames - 2), fps) });
  const merged: FrameSample[] = [];
  for (const s of out) {
    if (merged.some((m) => Math.abs(m.at_sec - s.at_sec) < 1 / fps / 2)) continue;
    merged.push(s);
  }
  return merged;
}

/** File name of the n-th sample, e.g. `02-s02.png`. */
export function sampleFileName(i: number, s: FrameSample): string {
  return `${String(i).padStart(2, "0")}-${s.label.replace(/[^A-Za-z0-9_-]/g, "_")}.png`;
}

/**
 * Locate a render: `quality` (else renders/latest.json, else dist/render-manifest.json's quality,
 * else whichever renders/<q>/render-state.json exists). The reel is the state's reel, else
 * renders/<q>/reel.mp4, else dist/reel.mp4 when dist holds that quality (or says nothing).
 */
export async function resolveRender(projectDir: string, quality?: Quality): Promise<ResolvedRender> {
  const paths = projectPaths(projectDir);
  const root = paths.root;
  const distQuality = (await readOptionalJson<{ settings?: { quality?: Quality } }>(join(paths.dist, "render-manifest.json")))?.settings?.quality;
  let q = quality ?? (await readOptionalJson<{ quality?: Quality }>(join(paths.renders, "latest.json")))?.quality ?? distQuality;
  if (!q) q = (["final", "preview"] as const).find((c) => existsSync(join(paths.renders, c, "render-state.json")));
  const state = q ? await readOptionalJson<RenderStateView>(join(paths.renders, q, "render-state.json")) : undefined;

  const candidates: Array<[string, string]> = [];
  if (state?.reel) candidates.push([join(root, state.reel), `renders/${q}`]);
  if (q) candidates.push([join(paths.renders, q, "reel.mp4"), `renders/${q}`]);
  if (!distQuality || distQuality === q) candidates.push([join(paths.dist, "reel.mp4"), "dist"]);
  const found = candidates.find(([p]) => existsSync(p));
  if (!found) {
    throw new Error(
      q
        ? `no ${q} reel found in ${root} (looked for ${candidates.map(([p]) => rel(root, p)).join(", ") || "nothing"}); render it first (render_submit${quality ? ` with quality "${quality}"` : ""})`
        : `no render found in ${root}; render it first (render_submit)`,
    );
  }
  const [reel, source] = found;
  const needProbe = !state?.target || !state.duration_ms;
  const probe = needProbe ? await ffprobe(reel) : undefined;
  return {
    root,
    ...(q ? { quality: q } : {}),
    ...(state ? { state } : {}),
    reel,
    duration_ms: state?.duration_ms ?? Math.round((probe?.duration_s ?? 0) * 1000),
    width: state?.target?.width ?? probe?.width ?? 0,
    height: state?.target?.height ?? probe?.height ?? 0,
    fps: state?.target?.fps ?? probe?.fps ?? 30,
    source,
  };
}

/** Sample times for a resolved render (scene midpoints when the render state has scenes). */
export function renderSamples(r: ResolvedRender): FrameSample[] {
  return sampleTimes({ duration_ms: r.duration_ms, fps: r.fps, ...(r.state?.scenes ? { scenes: r.state.scenes } : {}) });
}

async function clearPngs(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  for (const f of await readdir(dir)) if (f.endsWith(".png")) await rm(join(dir, f), { force: true });
}

// ------------------------------------------------------------------------------------ test

/**
 * Golden-frame test of the `quality` render (default: the latest). With `update`, records the
 * current frames as goldens. Writes qa/test.json and qa/test.md; failing frames get the current
 * frame and a golden | current | difference image under qa/test-frames/.
 */
export async function testProject(projectDir: string, opts: { quality?: Quality; update?: boolean } = {}): Promise<GoldenResult> {
  const paths = projectPaths(projectDir);
  const root = paths.root;
  const r = await resolveRender(root, opts.quality);
  if (!r.quality) throw new Error(`cannot tell which quality the render in ${root} is; pass quality`);
  const quality = r.quality;
  const goldenDir = join(root, GOLDEN_DIR, quality);
  const goldenPath = join(goldenDir, GOLDEN_FILE);
  const framesDir = join(paths.qa, "test-frames");
  const samples = renderSamples(r);
  const reelSha = await hashFile(r.reel);
  await rm(framesDir, { recursive: true, force: true });

  const base = { quality, golden_dir: rel(root, goldenDir) };
  const finish = async (res: Omit<GoldenResult, "report_json" | "report_md">): Promise<GoldenResult> => {
    const out: GoldenResult = { ...res, report_json: "qa/test.json", report_md: "qa/test.md" };
    await writeJsonAtomic(join(paths.qa, "test.json"), out);
    await writeFileAtomic(join(paths.qa, "test.md"), goldenMarkdown(out));
    return out;
  };

  if (opts.update) {
    await mkdir(goldenDir, { recursive: true });
    await clearPngs(goldenDir);
    const frames: GoldenFile["frames"] = [];
    for (const [i, s] of samples.entries()) {
      const file = sampleFileName(i, s);
      await extractFrame(r.reel, s.at_sec, join(goldenDir, file), { width: GOLDEN_FRAME_WIDTH });
      frames.push({ ...s, file });
    }
    const golden: GoldenFile = {
      version: GOLDEN_VERSION,
      quality,
      width: GOLDEN_FRAME_WIDTH,
      threshold: GOLDEN_SSIM_THRESHOLD,
      reel_sha256: reelSha,
      ...(r.state?.spec_sha256 ? { spec_sha256: r.state.spec_sha256 } : {}),
      target: { width: r.width, height: r.height, fps: r.fps },
      duration_ms: r.duration_ms,
      frames,
    };
    await writeJsonAtomic(goldenPath, golden);
    return finish({
      ...base,
      status: "updated",
      threshold: GOLDEN_SSIM_THRESHOLD,
      reel_identical: true,
      frames: frames.map((f) => ({ label: f.label, ...(f.scene_id ? { scene_id: f.scene_id } : {}), at_sec: f.at_sec, golden: rel(root, join(goldenDir, f.file)), pass: true })),
      message: `recorded ${frames.length} golden frame(s) from ${rel(root, r.reel)}`,
    });
  }

  const golden = await readOptionalJson<GoldenFile>(goldenPath);
  if (!golden) {
    return finish({
      ...base,
      status: "missing",
      threshold: GOLDEN_SSIM_THRESHOLD,
      frames: [],
      message: `no golden frames in ${rel(root, goldenDir)}/`,
      fix: `check the ${quality} render by eye (look at ${rel(root, r.reel)} or a few frames), then run test with update: true to record it as the golden`,
    });
  }
  const threshold = golden.threshold ?? GOLDEN_SSIM_THRESHOLD;
  const reelIdentical = golden.reel_sha256 === reelSha;
  const goldenFrames = (golden.frames ?? []).map((f) => ({ label: f.label, ...(f.scene_id ? { scene_id: f.scene_id } : {}), at_sec: f.at_sec, golden: rel(root, join(goldenDir, f.file)), pass: false }));
  const updateFix = `if the change is intended, check the ${quality} render by eye and run test with update: true to re-record the goldens; otherwise find what changed (diff against a known-good render)`;

  // Structure first: the same frame size and the same sample times, else the frames are not comparable.
  const sizeChanged = golden.target && (golden.target.width !== r.width || golden.target.height !== r.height || golden.target.fps !== r.fps);
  if (sizeChanged) {
    return finish({
      ...base,
      status: "fail",
      threshold,
      reel_identical: false,
      frames: goldenFrames,
      message: `render size changed: golden ${golden.target.width}x${golden.target.height}@${golden.target.fps} vs current ${r.width}x${r.height}@${r.fps}`,
      fix: updateFix,
    });
  }
  const timesDiffer =
    samples.length !== golden.frames.length || samples.some((s, i) => s.label !== golden.frames[i]!.label || Math.abs(s.at_sec - golden.frames[i]!.at_sec) > 0.0005);
  if (timesDiffer) {
    return finish({
      ...base,
      status: "fail",
      threshold,
      reel_identical: false,
      frames: goldenFrames,
      message: `sampled frames changed (scenes or durations differ): golden ${golden.frames.map((f) => `${f.label}@${f.at_sec}s`).join(", ")}; current ${samples.map((s) => `${s.label}@${s.at_sec}s`).join(", ")}`,
      fix: updateFix,
    });
  }

  const frames: GoldenFrameResult[] = [];
  for (const [i, s] of samples.entries()) {
    const gf = golden.frames[i]!;
    const goldenPng = join(goldenDir, gf.file);
    const entry: GoldenFrameResult = { ...s, golden: rel(root, goldenPng), pass: false };
    if (!existsSync(goldenPng)) {
      frames.push(entry);
      continue;
    }
    await mkdir(framesDir, { recursive: true });
    const actual = join(framesDir, gf.file.replace(/\.png$/, ".actual.png"));
    await extractFrame(r.reel, s.at_sec, actual, { width: golden.width ?? GOLDEN_FRAME_WIDTH });
    const [ga, aa] = await Promise.all([pngSize(goldenPng), pngSize(actual)]);
    if (ga && aa && (ga.width !== aa.width || ga.height !== aa.height)) {
      entry.actual = rel(root, actual);
    } else {
      entry.ssim = round4(await frameSsim(goldenPng, actual));
      entry.pass = entry.ssim >= threshold;
      if (entry.pass) {
        await rm(actual, { force: true });
      } else {
        const diff = join(framesDir, gf.file.replace(/\.png$/, ".diff.png"));
        await frameDiffImage(goldenPng, actual, diff);
        entry.actual = rel(root, actual);
        entry.diff = rel(root, diff);
      }
    }
    frames.push(entry);
  }
  const failed = frames.filter((f) => !f.pass);
  if (!failed.length) await rm(framesDir, { recursive: true, force: true });
  return finish({
    ...base,
    status: failed.length ? "fail" : "pass",
    threshold,
    reel_identical: reelIdentical,
    frames,
    ...(failed.length
      ? {
          message: `${failed.length} of ${frames.length} frame(s) differ from the golden (${failed.map((f) => (f.ssim === undefined ? `${f.label}: missing or wrong size` : `${f.label}: SSIM ${f.ssim}`)).join(", ")}); compare images in qa/test-frames/`,
          fix: updateFix,
        }
      : {}),
  });
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

function goldenMarkdown(r: GoldenResult): string {
  const lines = [
    "# Golden-frame test",
    "",
    `- Status: **${r.status}**`,
    `- Quality: ${r.quality ?? "?"}`,
    `- Goldens: \`${r.golden_dir}/\``,
    `- Threshold: SSIM >= ${r.threshold}`,
  ];
  if (r.reel_identical !== undefined) lines.push(`- Reel byte-identical to the golden's: ${r.reel_identical ? "yes" : "no"}`);
  if (r.message) lines.push("", r.message);
  if (r.fix) lines.push("", `Fix: ${r.fix}`);
  if (r.frames.length) {
    lines.push("", "| Frame | Time (s) | SSIM | Result | Images |", "|---|---|---|---|---|");
    for (const f of r.frames) {
      const imgs = [`golden: \`${f.golden}\``, ...(f.actual ? [`current: \`${f.actual}\``] : []), ...(f.diff ? [`diff: \`${f.diff}\``] : [])].join("<br>");
      lines.push(`| ${f.label} | ${f.at_sec} | ${f.ssim ?? "-"} | ${r.status === "updated" ? "recorded" : f.pass ? "pass" : "FAIL"} | ${imgs} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function formatGolden(r: GoldenResult): string {
  const head = `test ${r.status}${r.quality ? ` (${r.quality})` : ""}: ${r.frames.length} frame(s), threshold SSIM ${r.threshold}; report ${r.report_md}`;
  const lines = [head];
  if (r.message) lines.push(r.message);
  if (r.status === "fail") for (const f of r.frames.filter((x) => !x.pass)) lines.push(`- ${f.label} @ ${f.at_sec}s: ${f.ssim === undefined ? "not compared" : `SSIM ${f.ssim}`}${f.diff ? ` (see ${f.diff})` : ""}`);
  if (r.fix) lines.push(`fix: ${r.fix}`);
  return lines.join("\n");
}

import { copyFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, ensureDir, hashFile, readJson, sha256Hex, writeJsonAtomic } from "@video-studio/core";
import { aacArgs, h264Args, runFfmpeg } from "@video-studio/media";
import type { PlatformContract, VideoSpec } from "@video-studio/schema";
import type { LintFinding, LintResult } from "./lint.js";

/**
 * Per-platform packages: `dist/<target>/{video.mp4, cover.jpg, captions.srt, captions.vtt,
 * post.json, qa.json}`, compiled from one render. The reel is copied unless the target's
 * contract envelope needs a lower fps, a smaller frame, a lower bitrate or a smaller file; only
 * then is it re-encoded (cached under renders/<quality>/targets/). Limits the reel cannot be
 * made to meet by re-encoding down (aspect, minimum size, duration) are left to lint.
 */

/** Bump to invalidate transcoded target videos. */
export const TARGET_PACKAGE_VERSION = 1;

/** Headroom under a bitrate or file-size ceiling (container overhead, VBV overshoot). */
const LIMIT_HEADROOM = 0.9;

export interface ReelFacts {
  width: number;
  height: number;
  fps: number;
  duration_sec: number;
  bytes: number;
}

export interface VideoPlan {
  transcode: boolean;
  /** Why the video is re-encoded, one line per envelope limit it exceeds. */
  reasons: string[];
  width: number;
  height: number;
  fps: number;
  /** Video bitrate ceiling in kbit/s, when a bitrate or file-size limit applies. */
  maxrate_kbps?: number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Decide whether `reel` fits `contract`'s envelope as is, and what to re-encode to if not. */
export function planTargetVideo(contract: PlatformContract, reel: ReelFacts): VideoPlan {
  const v = contract.video;
  const reasons: string[] = [];
  let { width, height, fps } = reel;
  let maxrate: number | undefined;

  if (v.fps?.max !== undefined && fps > v.fps.max) {
    reasons.push(`fps ${fps} > ${v.fps.max}`);
    fps = v.fps.max;
  }
  const long = Math.max(width, height);
  if (v.max_long_side && long > v.max_long_side) {
    const k = v.max_long_side / long;
    reasons.push(`long side ${long}px > ${v.max_long_side}px`);
    width = even(width * k);
    height = even(height * k);
  }
  const kbps = reel.duration_sec > 0 ? (reel.bytes * 8) / 1000 / reel.duration_sec : 0;
  if (v.max_bitrate_mbps && kbps > v.max_bitrate_mbps * 1000) {
    reasons.push(`bitrate ${Math.round(kbps)} kbit/s > ${v.max_bitrate_mbps} Mbit/s`);
    maxrate = v.max_bitrate_mbps * 1000 * LIMIT_HEADROOM;
  }
  if (v.max_size_mb && reel.bytes > v.max_size_mb * 1024 * 1024 && reel.duration_sec > 0) {
    reasons.push(`file ${(reel.bytes / 1024 / 1024).toFixed(1)} MB > ${v.max_size_mb} MB`);
    // Leave room for the 192k audio track.
    const budget = ((v.max_size_mb * 1024 * 1024 * 8) / 1000 / reel.duration_sec) * LIMIT_HEADROOM - 192;
    maxrate = Math.min(maxrate ?? Infinity, Math.max(100, budget));
  }
  return { transcode: reasons.length > 0, reasons, width, height, fps, ...(maxrate !== undefined ? { maxrate_kbps: Math.floor(maxrate) } : {}) };
}

function transcodeArgs(input: string, output: string, plan: VideoPlan, preset: string): string[] {
  const vf = [`scale=${plan.width}:${plan.height}:flags=lanczos`, `fps=${plan.fps}`, "setsar=1"].join(",");
  const rate = plan.maxrate_kbps ? ["-maxrate", `${plan.maxrate_kbps}k`, "-bufsize", `${plan.maxrate_kbps * 2}k`] : [];
  return ["-y", "-i", input, "-vf", vf, ...h264Args({ preset }), ...rate, ...aacArgs(), "-movflags", "+faststart", output];
}

export interface PostJson {
  target: string;
  platform: string;
  route: PlatformContract["route"];
  contract_version: number;
  /** "spec" when the text comes from `publish.<target>`, "generated" when derived from the spec and brief. */
  source: "spec" | "generated";
  post_caption: string;
  hashtags: string[];
  /** Caption plus hashtags, ready to paste; this is what the platform's character limit counts. */
  full_text: string;
  ai_disclosure: { requested: boolean | null; supported: boolean; field?: string };
  cover: { mode: PlatformContract["cover"]["mode"]; file?: string; timestamp_ms?: number };
  captions: { sidecar_formats: string[]; burn_in_recommended: boolean; files: string[] };
  limits: { post_caption_max_chars?: number; hashtags_max?: number; mentions_max?: number };
  /** What is in the audio, and the reminder that in-app trending sounds are chosen when posting. */
  sound: { music?: string; license?: string; attribution?: string; note: string };
}

/** Platforms' trending sounds live in their apps; a file upload cannot carry one. */
export const TRENDING_SOUND_NOTE =
  "Trending sounds can't be added by video-studio: they live inside the platform's app. To use one, add it in the app when you post (it replaces or mixes with this audio).";

export interface TargetQa {
  target: string;
  quality: string;
  status: "pass" | "warn" | "fail";
  counts: { errors: number; warnings: number };
  /** Lint findings for this target plus the target-independent ones. */
  findings: LintFinding[];
  lint_report: string;
  technical_qa?: "pass" | "warn" | "fail";
  lint_error?: string;
}

export interface TargetDist {
  id: string;
  dir: string;
  video: string;
  transcoded: boolean;
  transcode_reasons: string[];
  width: number;
  height: number;
  fps: number;
  cover?: string;
  captions_srt?: string;
  captions_vtt?: string;
  post: string;
  qa: string;
}

export interface PackageTargetsInput {
  /** Project root. */
  root: string;
  distDir: string;
  /** renders/<quality>/: transcoded videos are cached under its `targets/`. */
  renderDir: string;
  quality: "preview" | "final";
  spec: VideoSpec;
  contracts: readonly PlatformContract[];
  reel: string;
  reelFacts: ReelFacts;
  cover?: string;
  /** Video time the cover frame was taken from. */
  coverAtMs?: number;
  captionsSrt?: string;
  captionsVtt?: string;
  /** Draft post copy for a target without `publish.<target>`. */
  generatedCopy: (contract: PlatformContract) => { post_caption: string; hashtags: string[] };
  lint?: LintResult;
  lintError?: string;
  /** The music bed in the audio, for post.json `sound`. */
  music?: { title?: string; ref: string; license?: { id: string; attribution?: string } };
  technicalQa?: "pass" | "warn" | "fail";
}

/** Hashtags are counted by the platform when present in the caption; join them after it. */
function fullText(caption: string, hashtags: readonly string[]): string {
  const tags = hashtags.filter((t) => !caption.includes(t));
  return [caption.trim(), tags.join(" ")].filter(Boolean).join("\n\n");
}

async function cachedTranscode(input: string, inputSha: string, cacheDir: string, id: string, plan: VideoPlan, preset: string): Promise<string> {
  const key = sha256Hex(canonicalJson({ v: TARGET_PACKAGE_VERSION, inputSha, plan, preset }));
  const out = join(cacheDir, `${id}.mp4`);
  const keyFile = join(cacheDir, `${id}.json`);
  const prev = await readJson<{ key?: string }>(keyFile).catch(() => undefined);
  if (prev?.key === key && (await stat(out).catch(() => undefined))) return out;
  await ensureDir(cacheDir);
  await runFfmpeg(transcodeArgs(input, out, plan, preset));
  await writeJsonAtomic(keyFile, { key, plan });
  return out;
}

/** Write dist/<target>/ for every contract, and remove package dirs of targets no longer in the spec. */
export async function packageTargets(i: PackageTargetsInput, allTargetIds: readonly string[]): Promise<TargetDist[]> {
  const wanted = new Set(i.contracts.map((c) => c.id));
  for (const entry of await readdir(i.distDir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && allTargetIds.includes(entry.name) && !wanted.has(entry.name)) await rm(join(i.distDir, entry.name), { recursive: true, force: true });
  }
  const preset = i.quality === "preview" ? "ultrafast" : "medium";
  let reelSha: string | undefined;
  const out: TargetDist[] = [];
  for (const c of i.contracts) {
    const dir = join(i.distDir, c.id);
    await ensureDir(dir);
    const f = (name: string) => join(dir, name);

    const plan = planTargetVideo(c, i.reelFacts);
    let src = i.reel;
    if (plan.transcode) {
      reelSha ??= await hashFile(i.reel);
      src = await cachedTranscode(i.reel, reelSha, join(i.renderDir, "targets"), c.id, plan, preset);
    }
    await copyFile(src, f("video.mp4"));

    const hasCoverFile = Boolean(i.cover) && c.cover.mode !== "none";
    if (hasCoverFile) await copyFile(i.cover!, f("cover.jpg"));
    else await rm(f("cover.jpg"), { force: true });

    const captionFiles: string[] = [];
    for (const [src, name] of [
      [i.captionsSrt, "captions.srt"],
      [i.captionsVtt, "captions.vtt"],
    ] as const) {
      if (src) {
        await copyFile(src, f(name));
        captionFiles.push(name);
      } else {
        await rm(f(name), { force: true });
      }
    }

    const publish = i.spec.publish?.[c.id];
    const draft = publish ? undefined : i.generatedCopy(c);
    const caption = publish?.post_caption ?? draft!.post_caption;
    const hashtags = publish ? (publish.hashtags ?? []) : draft!.hashtags;
    const coverTimestamp =
      c.cover.mode === "frame" || c.cover.mode === "file_or_frame"
        ? Math.round(i.spec.cover ? i.spec.cover.focal_time_sec * 1000 : (i.coverAtMs ?? 0))
        : undefined;
    const post: PostJson = {
      target: c.id,
      platform: c.name,
      route: c.route,
      contract_version: c.contract_version,
      source: publish ? "spec" : "generated",
      post_caption: caption,
      hashtags,
      full_text: fullText(caption, hashtags),
      ai_disclosure: {
        requested: publish?.ai_disclosure ?? null,
        supported: c.ai_disclosure?.supported ?? false,
        ...(c.ai_disclosure?.field ? { field: c.ai_disclosure.field } : {}),
      },
      cover: { mode: c.cover.mode, ...(hasCoverFile ? { file: "cover.jpg" } : {}), ...(coverTimestamp !== undefined ? { timestamp_ms: coverTimestamp } : {}) },
      captions: { sidecar_formats: c.captions.sidecar_formats, burn_in_recommended: c.captions.burn_in_recommended, files: captionFiles },
      sound: {
        ...(i.music ? { music: i.music.title ?? i.music.ref } : {}),
        ...(i.music?.license ? { license: i.music.license.id } : {}),
        ...(i.music?.license?.attribution ? { attribution: i.music.license.attribution } : {}),
        note: TRENDING_SOUND_NOTE,
      },
      limits: {
        ...(c.captions.post_caption_max_chars !== undefined ? { post_caption_max_chars: c.captions.post_caption_max_chars } : {}),
        ...(c.captions.hashtags_max !== undefined ? { hashtags_max: c.captions.hashtags_max } : {}),
        ...(c.captions.mentions_max !== undefined ? { mentions_max: c.captions.mentions_max } : {}),
      },
    };
    await writeJsonAtomic(f("post.json"), post);

    const findings = (i.lint?.findings ?? []).filter((x) => x.target === undefined || x.target === c.id);
    const errors = findings.filter((x) => x.severity === "error").length;
    const qa: TargetQa = {
      target: c.id,
      quality: i.quality,
      status: i.lintError ? "fail" : errors ? "fail" : findings.length ? "warn" : "pass",
      counts: { errors, warnings: findings.length - errors },
      findings,
      lint_report: "qa/lint.json",
      ...(i.technicalQa ? { technical_qa: i.technicalQa } : {}),
      ...(i.lintError ? { lint_error: i.lintError } : {}),
    };
    await writeJsonAtomic(f("qa.json"), qa);

    out.push({
      id: c.id,
      dir,
      video: f("video.mp4"),
      transcoded: plan.transcode,
      transcode_reasons: plan.reasons,
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      ...(hasCoverFile ? { cover: f("cover.jpg") } : {}),
      ...(captionFiles.includes("captions.srt") ? { captions_srt: f("captions.srt") } : {}),
      ...(captionFiles.includes("captions.vtt") ? { captions_vtt: f("captions.vtt") } : {}),
      post: f("post.json"),
      qa: f("qa.json"),
    });
  }
  return out;
}

import { copyFile, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ensureDir, hashFile } from "@video-studio/core";
import { type ContentBox, type ProbeResult, detectLetterbox, ffprobe, measureLoudness, runFfmpeg } from "@video-studio/media";
import type { MediaInfo, Shot } from "@video-studio/schema";
import { writeProjectAsset } from "./office-common.js";
import { displayPath, fileRef } from "./refs.js";
import type { ExtractInput, ExtractedAsset, ExtractedSource, Extractor } from "./types.js";

/**
 * Video and audio files → a project copy of the file plus probe facts (duration, size, fps,
 * streams), shot boundaries from ffmpeg scene detection, one small keyframe JPEG per shot
 * (capped) and integrated loudness. Evidence comes later from the transcript (`transcribe`).
 * The file is only decoded by ffmpeg; nothing in it is executed.
 */

export const MEDIA_MAX_BYTES = 8 * 1024 * 1024 * 1024;
/** Scene-change score above which a frame starts a new shot. */
export const SCENE_THRESHOLD = 0.3;
/** Shots shorter than this are merged into the previous one (flashes, dissolves). */
export const MIN_SHOT_SEC = 0.4;
/** At most this many keyframe images per video (evenly spread over the shots). */
export const MAX_KEYFRAMES = 24;
const KEYFRAME_WIDTH = 320;

export interface DetectShotsOptions {
  threshold?: number;
  minShotSec?: number;
  signal?: AbortSignal;
}

/** Parse `showinfo` frame times from ffmpeg stderr. */
export function parseShowinfoTimes(stderr: string): number[] {
  const out: number[] = [];
  for (const m of stderr.matchAll(/Parsed_showinfo[^\n]*?pts_time:\s*(-?[\d.]+)/g)) {
    const t = Number(m[1]);
    if (Number.isFinite(t)) out.push(t);
  }
  return out;
}

/** Cut times → shots covering [0, duration], merging shots shorter than `minShotSec`. */
export function shotsFromCuts(cuts: readonly number[], duration: number, minShotSec = MIN_SHOT_SEC): Array<{ start_sec: number; end_sec: number }> {
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const bounds = [0];
  for (const c of [...cuts].sort((a, b) => a - b)) {
    if (c - bounds[bounds.length - 1]! >= minShotSec && duration - c >= minShotSec) bounds.push(c);
  }
  const shots: Array<{ start_sec: number; end_sec: number }> = [];
  for (let i = 0; i < bounds.length; i++) {
    const end = bounds[i + 1] ?? duration;
    if (end > bounds[i]!) shots.push({ start_sec: r3(bounds[i]!), end_sec: r3(end) });
  }
  if (shots.length === 0 && duration > 0) shots.push({ start_sec: 0, end_sec: r3(duration) });
  return shots;
}

/** Shot boundaries of a video: `select='gt(scene,T)',showinfo` on a downscaled decode. */
export async function detectShots(path: string, duration: number, opts: DetectShotsOptions = {}): Promise<Array<{ start_sec: number; end_sec: number }>> {
  const t = opts.threshold ?? SCENE_THRESHOLD;
  const r = await runFfmpeg(["-i", path, "-map", "0:v:0", "-an", "-sn", "-vf", `scale=160:-2,select='gt(scene,${t})',showinfo`, "-f", "null", "-"], {
    keepStderr: true,
    timeoutMs: 60 * 60 * 1000,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return shotsFromCuts(parseShowinfoTimes(r.stderr), duration, opts.minShotSec);
}

/** Evenly pick at most `max` indices out of `n`. */
export function spreadIndices(n: number, max: number): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  return Array.from({ length: max }, (_, i) => Math.floor(((i + 0.5) * n) / max));
}

async function copyIntoProject(projectDir: string, src: string, sha256: string): Promise<string> {
  const root = resolve(projectDir);
  const ext = extname(src).toLowerCase().replace(/[^a-z0-9.]/g, "") || ".bin";
  const abs = join(root, "source", "assets", `${sha256}${ext}`);
  const rel = relative(root, abs);
  if (isAbsolute(rel) || rel.startsWith("..")) throw new Error("asset path escaped project dir");
  const exists = await stat(abs).then((s) => s.isFile(), () => false);
  if (!exists && resolve(src) !== abs) {
    await ensureDir(join(root, "source", "assets"));
    const tmp = `${abs}.part-${process.pid}-${Date.now()}`;
    try {
      await copyFile(src, tmp);
      await rename(tmp, abs);
    } finally {
      await rm(tmp, { force: true });
    }
  }
  return rel.split(sep).join("/");
}

function describe(kind: "video" | "audio", p: ProbeResult, shots: number, loudness: number | undefined): string {
  const parts = [`${kind === "video" ? "Video" : "Audio"} file, ${p.duration_s.toFixed(1)} s`];
  if (p.has_video && p.width && p.height) parts.push(`${p.width}x${p.height}${p.fps ? ` at ${p.fps} fps` : ""}`);
  parts.push(p.has_audio ? `audio track (${p.audio_codec ?? "unknown codec"})` : "no audio track");
  if (p.has_video) parts.push(`${shots} shot${shots === 1 ? "" : "s"} detected`);
  if (loudness !== undefined) parts.push(`integrated loudness ${loudness.toFixed(1)} LUFS`);
  return `${parts.join(", ")}. No transcript yet: run transcribe to add what is said as evidence.`;
}

export const mediaExtractor: Extractor = {
  version: "media-2",
  kinds: ["video", "audio"],
  async extract(input: ExtractInput): Promise<ExtractedSource> {
    const st = await stat(input.uri);
    if (!st.isFile()) throw new Error(`not a regular file: ${input.uri}`);
    if (st.size > MEDIA_MAX_BYTES) throw new Error(`${basename(input.uri)} is ${st.size} bytes (limit ${MEDIA_MAX_BYTES})`);
    const sha256 = await hashFile(input.uri);
    const probe = await ffprobe(input.uri);
    if (!probe.has_video && !probe.has_audio) throw new Error(`${basename(input.uri)} has no video or audio stream ffprobe can read`);
    // A file named .mp4 that only holds audio is ingested as audio (and vice versa).
    const kind: "video" | "audio" = probe.has_video ? "video" : "audio";
    const refBase = fileRef(kind, displayPath(input.uri, input.projectDir));
    const warnings: ExtractedSource["warnings"] = [];

    const shots: Shot[] = [];
    const keyframeAssets: ExtractedAsset[] = [];
    if (probe.has_video && probe.duration_s > 0) {
      const detected = await detectShots(input.uri, probe.duration_s);
      shots.push(...detected);
      if (input.projectDir) {
        const work = await mkdtemp(join(tmpdir(), "vs-keyframes-"));
        try {
          for (const i of spreadIndices(detected.length, MAX_KEYFRAMES)) {
            const s = detected[i]!;
            const at = (s.start_sec + s.end_sec) / 2;
            const out = join(work, `k${i}.jpg`);
            try {
              await runFfmpeg(["-y", "-ss", at.toFixed(3), "-i", input.uri, "-map", "0:v:0", "-frames:v", "1", "-vf", `scale=${KEYFRAME_WIDTH}:-2`, "-q:v", "6", out], { timeoutMs: 120_000 });
              const asset = await writeProjectAsset(input.projectDir, new Uint8Array(await readFile(out)), "jpg", "image", `${refBase}#t=${at.toFixed(1)}`);
              asset.local_id = `keyframe-${i + 1}`;
              keyframeAssets.push(asset);
              shots[i] = { ...s, keyframe: asset.local_id };
            } catch {
              /* a keyframe is optional */
            }
          }
        } finally {
          await rm(work, { recursive: true, force: true });
        }
        if (detected.length > MAX_KEYFRAMES) {
          warnings.push({ code: "keyframes_capped", message: `${detected.length} shots; keyframes kept for ${MAX_KEYFRAMES} evenly spread shots` });
        }
      }
    }

    // Baked-in black bars (strict: dark scenes are left alone); the footage renderer crops them off.
    let contentBox: ContentBox | null = null;
    if (probe.has_video && probe.width && probe.height) {
      try {
        contentBox = await detectLetterbox(input.uri, { duration_sec: probe.duration_s, width: probe.width, height: probe.height });
      } catch {
        contentBox = null;
      }
    }

    let loudness: number | undefined;
    if (probe.has_audio) {
      try {
        const l = await measureLoudness(input.uri);
        if (l.integrated_lufs !== null && Number.isFinite(l.integrated_lufs)) loudness = l.integrated_lufs;
      } catch {
        /* loudness is informative only */
      }
      warnings.push({ code: "needs_transcript", message: `${basename(input.uri)} has audio but no transcript; run transcribe (local whisper.cpp, or a .srt/.vtt the user supplies)` });
    }

    const media: MediaInfo = {
      duration_sec: Math.round(probe.duration_s * 1000) / 1000,
      ...(probe.width ? { width: probe.width } : {}),
      ...(probe.height ? { height: probe.height } : {}),
      ...(probe.fps ? { fps: probe.fps } : {}),
      has_video: probe.has_video,
      has_audio: probe.has_audio,
      ...(shots.length ? { shots } : {}),
      ...(loudness !== undefined ? { loudness_lufs: Math.round(loudness * 10) / 10 } : {}),
      ...(contentBox ? { content_box: contentBox } : {}),
    };

    const assets: ExtractedAsset[] = [];
    if (input.projectDir) {
      const path = await copyIntoProject(input.projectDir, input.uri, sha256);
      assets.push({ kind, path, sha256, source_ref: refBase, media }, ...keyframeAssets);
    } else {
      warnings.push({ code: "media_not_copied", message: "no project folder: the media file was probed but not copied" });
    }

    const title = basename(input.uri, extname(input.uri));
    return {
      source: { kind, uri: input.uri, sha256, title },
      sections: [{ heading: basename(input.uri), text: describe(kind, probe, shots.length, loudness) }],
      evidence: [],
      assets,
      warnings,
      classificationHints:
        kind === "video"
          ? { contains_likeness: true, notes: ["likeness: video frames are not checked for faces; assume the footage shows real people until the user confirms otherwise"] }
          : { notes: ["likeness: audio may carry identifiable voices; get consent before reusing a person's voice"] },
    };
  },
};

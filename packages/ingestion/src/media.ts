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
 * The file is only decoded by ffmpeg; nothing in it is executed. Files ffprobe cannot read,
 * with no video/audio stream, with zero duration, or that are still images under a media
 * extension (a PNG renamed .mp4) are refused with a clear error.
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

async function copyIntoProject(projectDir: string, src: string, sha256: string, move = false): Promise<string> {
  const root = resolve(projectDir);
  const ext = extname(src).toLowerCase().replace(/[^a-z0-9.]/g, "") || ".bin";
  const abs = join(root, "source", "assets", `${sha256}${ext}`);
  const rel = relative(root, abs);
  if (isAbsolute(rel) || rel.startsWith("..")) throw new Error("asset path escaped project dir");
  const exists = await stat(abs).then((s) => s.isFile(), () => false);
  if (!exists && resolve(src) !== abs) {
    await ensureDir(join(root, "source", "assets"));
    if (move) {
      // A download staged inside the project: a rename, not a second copy of a large file.
      await rename(src, abs);
      return rel.split(sep).join("/");
    }
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

// ---------------------------------------------------------------------------------- footage quality

/** Luma (8-bit code value) below which a pixel counts as near black; near white is the mirror (255 − this). */
export const QUALITY_BLACK_LUMA = 32;
/** Quality sampling: frames per second and width of the analysis decode. */
const QUALITY_FPS = 2;
const QUALITY_WIDTH = 160;
/** Above this length the analysis decodes keyframes only (fast on long clips). */
const QUALITY_FULL_DECODE_MAX_SEC = 30;
/** RMS window for the audio SNR proxy (samples at 16 kHz: 50 ms). */
const QUALITY_AUDIO_WINDOW = 800;
/** A window peak at or above this (dBFS) counts as clipped. */
export const CLIP_PEAK_DBFS = -0.1;
/** Thresholds (see footageQualityVerdict). */
export const QUALITY_LIMITS = {
  dark_mean: 55,
  dark_fraction: 0.6,
  bright_mean: 200,
  bright_fraction: 0.5,
  low_contrast: 30,
  clipped_windows: 3,
  low_snr_db: 15,
  /** A quiet floor below this (dBFS) is effectively silence: the SNR is fine whatever the spread. */
  silent_floor_db: -60,
} as const;

export interface VideoQualitySamples {
  yavg: number[];
  ylow: number[];
  yhigh: number[];
  /** Per-frame percentage (0–100) of near-black / near-white pixels. */
  pdark: number[];
  pbright: number[];
}

/** Parse `signalstats` metadata and the two named `blackframe` instances from ffmpeg stderr. */
export function parseVideoQuality(stderr: string): VideoQualitySamples {
  const pick = (re: RegExp) => [...stderr.matchAll(re)].map((m) => Number(m[1])).filter(Number.isFinite);
  return {
    yavg: pick(/lavfi\.signalstats\.YAVG=([\d.]+)/g),
    ylow: pick(/lavfi\.signalstats\.YLOW=([\d.]+)/g),
    yhigh: pick(/lavfi\.signalstats\.YHIGH=([\d.]+)/g),
    pdark: pick(/\[blackframe@dark[^\]]*\][^\n]*?pblack:(\d+)/g),
    pbright: pick(/\[blackframe@bright[^\]]*\][^\n]*?pblack:(\d+)/g),
  };
}

/** Per-window RMS and peak levels (dBFS; -inf for digital silence) from `astats` + `ametadata=print`. */
export function parseAudioWindows(stderr: string): { rms: number[]; peak: number[] } {
  const num = (v: string) => (/^-?inf$/i.test(v) ? Number.NEGATIVE_INFINITY : Number(v));
  const pick = (key: string) => [...stderr.matchAll(new RegExp(`lavfi\\.astats\\.Overall\\.${key}=(\\S+)`, "g"))].map((m) => num(m[1]!)).filter((x) => !Number.isNaN(x));
  return { rms: pick("RMS_level"), peak: pick("Peak_level") };
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
function percentile(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1) + 0.5)))]!;
}
const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export type MediaQuality = NonNullable<MediaInfo["quality"]>;

/**
 * Turn the sampled measurements into `media.quality` with a plain note (and a suggestion) per
 * problem. Exposure is not judged on HDR sources: their code values are PQ/HLG, not SDR luma.
 */
export function footageQualityVerdict(v: VideoQualitySamples | null, a: { rms: number[]; peak: number[] } | null, opts: { hdr?: boolean } = {}): MediaQuality | undefined {
  const L = QUALITY_LIMITS;
  const q: MediaQuality = { notes: [] };
  let any = false;
  if (v && v.yavg.length) {
    any = true;
    const lumaMean = mean(v.yavg);
    const contrast = v.ylow.length && v.yhigh.length ? mean(v.yhigh) - mean(v.ylow) : NaN;
    const dark = v.pdark.length ? mean(v.pdark) / 100 : NaN;
    const bright = v.pbright.length ? mean(v.pbright) / 100 : NaN;
    q.luma_mean = r1(lumaMean);
    if (Number.isFinite(contrast)) q.contrast = r1(Math.max(0, contrast));
    if (Number.isFinite(dark)) q.dark_fraction = r3(dark);
    if (Number.isFinite(bright)) q.bright_fraction = r3(bright);
    if (opts.hdr) {
      q.notes.push("HDR footage: exposure is not judged on the PQ/HLG signal; the footage renderer tonemaps it to SDR");
    } else {
      const isDark = lumaMean < L.dark_mean || dark > L.dark_fraction;
      const isBright = !isDark && (lumaMean > L.bright_mean || bright > L.bright_fraction);
      q.exposure = isDark ? "dark" : isBright ? "bright" : "ok";
      if (isDark) q.notes.push(`underexposed: mean luma ${r1(lumaMean)}${Number.isFinite(dark) ? `, ${Math.round(dark * 100)}% near black` : ""}; pick a brighter span or re-shoot with more light (no colour grade option exists yet)`);
      if (isBright) q.notes.push(`overexposed: mean luma ${r1(lumaMean)}${Number.isFinite(bright) ? `, ${Math.round(bright * 100)}% near white` : ""}; highlights are likely blown out, pick another span or re-shoot with less light`);
      if (Number.isFinite(contrast) && contrast < L.low_contrast) q.notes.push(`low contrast (luma spread ${r1(contrast)}): the picture looks flat or hazy; pick another span (text over it needs a scrim)`);
    }
  }
  if (a && a.rms.length) {
    any = true;
    const clippedWindows = a.peak.filter((p) => p >= CLIP_PEAK_DBFS).length;
    q.clipped_audio = clippedWindows >= L.clipped_windows;
    if (q.clipped_audio) q.notes.push(`audio clips (reaches full scale in ${clippedWindows} places): it will sound distorted; replace or re-record the audio at a lower input level`);
    const audible = a.rms.filter(Number.isFinite);
    if (audible.length >= Math.max(4, a.rms.length * 0.1)) {
      const loud = percentile(audible, 0.9);
      // Digital silence (-inf) counts as a very quiet floor.
      const floor = Math.max(-120, percentile(a.rms.map((x) => (Number.isFinite(x) ? x : -120)), 0.1));
      const snr = loud - floor;
      q.snr_db = r1(snr);
      if (floor > L.silent_floor_db && snr < L.low_snr_db) {
        q.notes.push(`noisy or unclear audio (estimated SNR ${r1(snr)} dB, noise floor ${r1(floor)} dBFS): no quiet gaps above the noise; if this clip has speech it may be hard to follow (replace or re-record, or put voiceover or music over it). Steady music, ambience or hum also reads this way: ignore it for b-roll`);
      }
    }
  }
  return any ? q : undefined;
}

/** Sample exposure/contrast of a video at low res and fps (keyframes only for long clips). */
export async function measureVideoQuality(path: string, durationSec: number, opts: { signal?: AbortSignal } = {}): Promise<VideoQualitySamples> {
  const t = QUALITY_BLACK_LUMA;
  const long = durationSec > QUALITY_FULL_DECODE_MAX_SEC;
  const graph =
    `[0:v]${long ? "" : `fps=${QUALITY_FPS},`}scale=${QUALITY_WIDTH}:-2,format=yuv420p,signalstats,metadata=print,split[qa][qb];` +
    `[qa]blackframe@dark=amount=0:threshold=${t},nullsink;[qb]negate,blackframe@bright=amount=0:threshold=${t}[qo]`;
  const r = await runFfmpeg([...(long ? ["-skip_frame", "nokey"] : []), "-i", path, "-map", "0:v:0", "-an", "-sn", "-filter_complex", graph, "-map", "[qo]", "-f", "null", "-"], {
    keepStderr: true,
    timeoutMs: 30 * 60 * 1000,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return parseVideoQuality(r.stderr);
}

/** Per-50 ms RMS and peak levels of the first audio stream (16 kHz, 16-bit: overshoot saturates and counts as clipped). */
export async function measureAudioQuality(path: string, opts: { signal?: AbortSignal } = {}): Promise<{ rms: number[]; peak: number[] }> {
  const af = `aresample=16000,aformat=sample_fmts=s16,asetnsamples=n=${QUALITY_AUDIO_WINDOW}:p=0,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level+Peak_level,ametadata=print`;
  const r = await runFfmpeg(["-i", path, "-map", "0:a:0", "-vn", "-sn", "-af", af, "-f", "null", "-"], {
    keepStderr: true,
    timeoutMs: 30 * 60 * 1000,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return parseAudioWindows(r.stderr);
}

function describe(kind: "video" | "audio", p: ProbeResult, shots: number, loudness: number | undefined, quality?: MediaQuality): string {
  const parts = [`${kind === "video" ? "Video" : "Audio"} file, ${p.duration_s.toFixed(1)} s`];
  const w = p.display_width ?? p.width;
  const h = p.display_height ?? p.height;
  if (p.has_video && w && h) parts.push(`${w}x${h}${p.fps ? ` at ${p.fps} fps` : ""}${p.rotation ? ` (rotated ${p.rotation}°)` : ""}`);
  if (p.has_video && p.hdr) parts.push(`HDR (${p.color_transfer === "arib-std-b67" ? "HLG" : "PQ"}${p.bit_depth ? `, ${p.bit_depth}-bit` : ""}; tonemapped to SDR when rendered)`);
  parts.push(p.has_audio ? `audio track (${p.audio_codec ?? "unknown codec"})` : "no audio track");
  if (p.has_video) parts.push(`${shots} shot${shots === 1 ? "" : "s"} detected`);
  if (loudness !== undefined) parts.push(`integrated loudness ${loudness.toFixed(1)} LUFS`);
  if (quality?.notes.length) parts.push(`quality: ${quality.notes.join("; ")}`);
  return `${parts.join(", ")}. No transcript yet: run transcribe to add what is said as evidence.`;
}

export interface MediaFileOptions {
  /** Project folder: the file is copied (or moved) to `source/assets/<sha256><ext>`. */
  projectDir?: string;
  /** Source uri (default: the file path). A video URL keeps the URL here. */
  uri?: string;
  /** Source title and section heading (default: the file name). */
  title?: string;
  /** Location used in source refs, `video:<refPath>#t=…` (default: the project-relative path). */
  refPath?: string;
  /** Move the file instead of copying it (a download staged inside the project). */
  move?: boolean;
  signal?: AbortSignal;
}

export const mediaExtractor: Extractor = {
  version: "media-3",
  kinds: ["video", "audio"],
  extract(input: ExtractInput): Promise<ExtractedSource> {
    return extractMediaFile(input.uri, { ...(input.projectDir ? { projectDir: input.projectDir } : {}), ...(input.signal ? { signal: input.signal } : {}) });
  },
};

/**
 * Probe a local video/audio file and build its source part (see the module comment). Shared by
 * {@link mediaExtractor} and the video URL extractor, which passes the URL as `uri`/`refPath`.
 */
export async function extractMediaFile(path: string, opts: MediaFileOptions = {}): Promise<ExtractedSource> {
  const input = { uri: path, projectDir: opts.projectDir };
  const st = await stat(input.uri);
  if (!st.isFile()) throw new Error(`not a regular file: ${input.uri}`);
  if (st.size > MEDIA_MAX_BYTES) throw new Error(`${basename(input.uri)} is ${st.size} bytes (limit ${MEDIA_MAX_BYTES})`);
  const sha256 = await hashFile(input.uri);
  let probe: ProbeResult;
  try {
    probe = await ffprobe(input.uri);
  } catch (err) {
    throw new Error(`${basename(input.uri)} is not a readable video or audio file (ffprobe: ${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
  }
  if (!probe.has_video && !probe.has_audio) throw new Error(`${basename(input.uri)} has no video or audio stream ffprobe can read`);
  // A still image renamed .mp4 probes as one "video" stream (png_pipe, image2…) with no
  // duration: refuse it instead of ingesting a 0-second video.
  if (/(?:_pipe|^image2)$/.test(probe.format_name ?? "")) {
    throw new Error(`${basename(input.uri)} is a still image (${probe.format_name}), not a video or audio file; images are not a supported source type yet`);
  }
  if (!(probe.duration_s > 0)) throw new Error(`${basename(input.uri)} has zero duration: ffprobe found no playable video or audio in it`);
  // A file named .mp4 that only holds audio is ingested as audio (and vice versa).
  const kind: "video" | "audio" = probe.has_video ? "video" : "audio";
  const refBase = fileRef(kind, opts.refPath ?? displayPath(input.uri, input.projectDir));
  const warnings: ExtractedSource["warnings"] = [];
  // ffmpeg auto-rotates on decode: shots, keyframes, letterbox and quality all see the displayed frame.
  const dispW = probe.display_width ?? probe.width;
  const dispH = probe.display_height ?? probe.height;

  const shots: Shot[] = [];
  const keyframeAssets: ExtractedAsset[] = [];
  if (probe.has_video && probe.duration_s > 0) {
    const detected = await detectShots(input.uri, probe.duration_s, opts.signal ? { signal: opts.signal } : {});
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
  if (probe.has_video && dispW && dispH) {
    try {
      contentBox = await detectLetterbox(input.uri, { duration_sec: probe.duration_s, width: dispW, height: dispH });
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

  // Cheap quality checks (exposure, contrast, clipping, SNR proxy); informative only.
  let videoQ: VideoQualitySamples | null = null;
  let audioQ: { rms: number[]; peak: number[] } | null = null;
  if (probe.has_video) {
    try {
      videoQ = await measureVideoQuality(input.uri, probe.duration_s, opts.signal ? { signal: opts.signal } : {});
    } catch {
      videoQ = null;
    }
  }
  if (probe.has_audio) {
    try {
      audioQ = await measureAudioQuality(input.uri, opts.signal ? { signal: opts.signal } : {});
    } catch {
      audioQ = null;
    }
  }
  const quality = footageQualityVerdict(videoQ, audioQ, { hdr: probe.hdr });
  for (const note of quality?.notes ?? []) {
    if (/^HDR footage/.test(note)) continue;
    warnings.push({ code: "footage_quality", message: `${basename(input.uri)}: ${note}` });
  }

  const media: MediaInfo = {
    duration_sec: Math.round(probe.duration_s * 1000) / 1000,
    ...(dispW ? { width: dispW } : {}),
    ...(dispH ? { height: dispH } : {}),
    ...(probe.fps ? { fps: probe.fps } : {}),
    has_video: probe.has_video,
    has_audio: probe.has_audio,
    ...(shots.length ? { shots } : {}),
    ...(loudness !== undefined ? { loudness_lufs: Math.round(loudness * 10) / 10 } : {}),
    ...(contentBox ? { content_box: contentBox } : {}),
    ...(probe.has_video && probe.rotation ? { rotation: probe.rotation } : {}),
    ...(probe.has_video && probe.color_transfer ? { color_transfer: probe.color_transfer } : {}),
    ...(probe.has_video && probe.color_primaries ? { color_primaries: probe.color_primaries } : {}),
    ...(probe.has_video && probe.bit_depth ? { bit_depth: probe.bit_depth } : {}),
    ...(probe.has_video && probe.hdr ? { hdr: true } : {}),
    ...(quality ? { quality } : {}),
  };

  const assets: ExtractedAsset[] = [];
  if (input.projectDir) {
    const assetPath = await copyIntoProject(input.projectDir, input.uri, sha256, opts.move === true);
    assets.push({ kind, path: assetPath, sha256, source_ref: refBase, media }, ...keyframeAssets);
  } else {
    warnings.push({ code: "media_not_copied", message: "no project folder: the media file was probed but not copied" });
  }

  const title = opts.title ?? basename(input.uri, extname(input.uri));
  return {
    source: { kind, uri: opts.uri ?? input.uri, sha256, title },
    sections: [{ heading: opts.title ?? basename(input.uri), text: describe(kind, probe, shots.length, loudness, quality) }],
    evidence: [],
    assets,
    warnings,
    classificationHints:
      kind === "video"
        ? { contains_likeness: true, notes: ["likeness: video frames are not checked for faces; assume the footage shows real people until the user confirms otherwise"] }
        : { notes: ["likeness: audio may carry identifiable voices; get consent before reusing a person's voice"] },
  };
}

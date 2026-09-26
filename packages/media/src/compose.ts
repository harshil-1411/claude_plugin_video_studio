import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import {
  type AudioSlot,
  AUDIO_SAMPLE_RATE,
  concatAudio,
  loudnorm2pass,
  type LoudnessTarget,
  type MusicBedInput,
  mixMusic,
  mixSceneAudio,
  type OneShot,
  type SceneAudioSlot,
  type SpeechInterval,
} from "./audio.js";
import { type RunOptions, escapeFilterPath, ffprobe, filterGraph, runFfmpeg, secs } from "./ffmpeg.js";

/** Final delivery encode: H.264 High, CRF 20, preset medium, yuv420p; AAC 192k 48 kHz; `+faststart`. */
export interface EncodeSettings {
  crf?: number;
  /** x264 preset. Default `medium`. Tests use `ultrafast`. */
  preset?: string;
}

export const FINAL_ENCODE = { crf: 20, preset: "medium", profile: "high", audioBitrate: "192k", sampleRate: AUDIO_SAMPLE_RATE } as const;

export function h264Args(e: EncodeSettings = {}): string[] {
  return ["-c:v", "libx264", "-profile:v", FINAL_ENCODE.profile, "-preset", e.preset ?? FINAL_ENCODE.preset, "-crf", String(e.crf ?? FINAL_ENCODE.crf), "-pix_fmt", "yuv420p"];
}

export function aacArgs(): string[] {
  return ["-c:a", "aac", "-b:a", FINAL_ENCODE.audioBitrate, "-ar", String(FINAL_ENCODE.sampleRate)];
}

export const FASTSTART = ["-movflags", "+faststart"] as const;

export interface ComposeOptions extends RunOptions {
  encode?: EncodeSettings;
}

export type SceneTransition = "cut" | "crossfade" | "fade_black" | "slide" | "zoom" | "whip";

export interface VideoSegment {
  path: string;
  /** Exact slot length; shorter segments hold their last frame, longer ones are trimmed. */
  duration_ms: number;
  /** Transition from the previous segment into this one (ignored on the first). Default: cut. */
  transition_in?: { kind: SceneTransition; ms: number };
}

/** ffmpeg xfade names for the spec's transitions. */
export const XFADE: Record<Exclude<SceneTransition, "cut">, string> = {
  crossfade: "fade",
  fade_black: "fadeblack",
  slide: "slideleft",
  zoom: "zoomin",
  whip: "smoothleft",
};

/**
 * Transition length actually used: at most 40% of the incoming slot and at most 1.5 s, and at
 * least two frames; below that the join is a cut.
 */
export function transitionSeconds(ms: number, incomingMs: number, fps: number): number {
  const d = Math.min(ms, incomingMs * 0.4, 1500) / 1000;
  return d >= 2 / fps ? Math.round(d * fps) / fps : 0;
}

export type FitMode = "pad" | "crop";

export interface TargetFormat {
  width: number;
  height: number;
  fps: number;
  /** `pad` letterboxes (default, never loses content); `crop` fills the frame. */
  fit?: FitMode;
  /** Pad colour. Default black. */
  padColor?: string;
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);

function assertEven(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width % 2 || height % 2) {
    throw new Error(`target size must be positive even integers for yuv420p H.264, got ${width}x${height}`);
  }
}

/** Filters that normalise one segment to the target: scale + pad/crop, square pixels, fps, yuv420p, exact frame count. */
export function normalizeFilters(t: TargetFormat, durationMs: number): string[] {
  const { width: W, height: H, fps } = t;
  const frames = Math.max(1, Math.round((durationMs * fps) / 1000));
  const fit =
    (t.fit ?? "pad") === "crop"
      ? [`scale=${W}:${H}:force_original_aspect_ratio=increase`, `crop=${W}:${H}`]
      : [`scale=${W}:${H}:force_original_aspect_ratio=decrease`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${t.padColor ?? "black"}`];
  return [
    ...fit,
    "setsar=1",
    `fps=${fps}`,
    "format=yuv420p",
    // Hold the last frame if the segment is short, then cut to the exact slot.
    `tpad=stop_mode=clone:stop_duration=${secs(durationMs)}`,
    `trim=end_frame=${frames}`,
    "setpts=PTS-STARTPTS",
  ];
}

export interface ConcatOptions extends ComposeOptions {
  /** Brand logo drawn in the same encode (no extra generation for the logo). */
  logo?: LogoOverlay;
}

/**
 * Concatenate video segments with the concat *filter* (tolerates mixed codecs, sizes and
 * frame rates): every segment is normalised to the target size/aspect/fps first. Video only;
 * audio is handled by `concatAudio` + `muxAudio`. Output uses the final H.264 settings.
 * With `logo` (and at least one range), the logo is overlaid inside the same filtergraph.
 */
export async function concatVideos(segments: readonly VideoSegment[], out: string, target: TargetFormat, opts: ConcatOptions = {}): Promise<{ path: string; duration_ms: number; frames: number }> {
  assertEven(target.width, target.height);
  if (!segments.length) throw new Error("concatVideos: no segments");
  const inputs: string[] = [];
  const chains: string[][] = [];
  const logo = opts.logo?.ranges_ms.length ? opts.logo : undefined;
  // Without a logo the timeline is the output; with one, the logo overlay turns it into [vout].
  const vcat = logo ? "[vcat]" : "[vout]";
  let frames = 0;
  segments.forEach((s, i) => {
    if (!(s.duration_ms > 0)) throw new Error(`segment ${i}: duration_ms must be > 0`);
    if (IMAGE_EXT.has(extname(s.path).toLowerCase())) {
      inputs.push("-loop", "1", "-framerate", String(target.fps), "-t", secs(s.duration_ms), "-i", s.path);
    } else {
      inputs.push("-i", s.path);
    }
    chains.push([`[${i}:v:0]${normalizeFilters(target, s.duration_ms).join(",")}[v${i}]`]);
    frames += Math.max(1, Math.round((s.duration_ms * target.fps) / 1000));
  });
  const joins = segments.map((s, i) => {
    const t = i > 0 ? s.transition_in : undefined;
    return t && t.kind !== "cut" ? { kind: t.kind, d: transitionSeconds(t.ms, s.duration_ms, target.fps) } : { kind: "cut" as const, d: 0 };
  });
  if (joins.every((j) => j.d === 0)) {
    chains.push([`${segments.map((_, i) => `[v${i}]`).join("")}concat=n=${segments.length}:v=1:a=0${vcat}`]);
  } else {
    // Timeline-preserving transitions: each incoming segment still starts on its slot boundary.
    // The outgoing picture holds its last frame for the transition (tpad) and xfade blends from it
    // into the incoming segment's first frames, so the total length (and audio/caption sync) is
    // exactly the sum of the slots.
    let acc = "[v0]";
    let accFrames = Math.max(1, Math.round((segments[0]!.duration_ms * target.fps) / 1000));
    segments.forEach((s, i) => {
      if (i === 0) return;
      const n = Math.max(1, Math.round((s.duration_ms * target.fps) / 1000));
      const j = joins[i]!;
      const out = i === segments.length - 1 ? "[vx]" : `[x${i}]`;
      if (j.d === 0) {
        chains.push([`${acc}[v${i}]concat=n=2:v=1:a=0${out}`]);
      } else {
        chains.push([`${acc}tpad=stop_mode=clone:stop_duration=${j.d},settb=AVTB[p${i}]`]);
        chains.push([`[v${i}]settb=AVTB[q${i}]`]);
        chains.push([`[p${i}][q${i}]xfade=transition=${XFADE[j.kind as Exclude<SceneTransition, "cut">]}:duration=${j.d}:offset=${(accFrames / target.fps).toFixed(4)}${out}`]);
      }
      acc = out;
      accFrames += n;
    });
    chains.push([`[vx]fps=${target.fps},trim=end_frame=${frames},setpts=N/FRAME_RATE/TB${vcat}`]);
  }
  if (logo) {
    inputs.push("-loop", "1", "-i", logo.path);
    chains.push([logoOverlayFilter(logo, vcat, `[${segments.length}:v]`, "[vout]")]);
  }
  await runFfmpeg(
    ["-y", ...inputs, "-filter_complex", filterGraph(chains), "-map", "[vout]", "-r", String(target.fps), ...h264Args(opts.encode), "-an", ...FASTSTART, out],
    opts,
  );
  return { path: out, frames, duration_ms: Math.round((frames * 1000) / target.fps) };
}

/** A brand logo drawn over the video at a fixed box, during the given time ranges only. */
export interface LogoOverlay {
  /** Absolute path of the logo image (PNG with alpha, JPEG or SVG rasterised by ffmpeg). */
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** [start, end) in ms on the video timeline where the logo shows. */
  ranges_ms: ReadonlyArray<readonly [number, number]>;
}

/**
 * Filtergraph drawing `logo` (input label `logoIn`, a looped still) over `main` → `out`.
 * The looped still is endless: the overlay ends with the video (shortest=1 on the filter itself).
 */
export function logoOverlayFilter(logo: LogoOverlay, main: string, logoIn: string, out: string): string {
  const enable = logo.ranges_ms.map(([a, b]) => `between(t,${(a / 1000).toFixed(3)},${(b / 1000).toFixed(3)})`).join("+") || "0";
  return `${logoIn}scale=${Math.round(logo.w)}:${Math.round(logo.h)}:flags=lanczos,format=rgba[logo];${main}[logo]overlay=x=${Math.round(logo.x)}:y=${Math.round(logo.y)}:enable='${enable}':format=auto:shortest=1${out}`;
}

/**
 * Overlay `logo` on `video` (re-encoded with the same settings; no audio). `assemble` no longer
 * uses this (the logo is drawn in the concat encode); kept for callers with a finished video.
 */
export async function overlayLogo(video: string, logo: LogoOverlay, out: string, opts: ComposeOptions = {}): Promise<{ path: string }> {
  const graph = logoOverlayFilter(logo, "[0:v]", "[1:v]", "[v]");
  await runFfmpeg(["-y", "-i", video, "-loop", "1", "-i", logo.path, "-filter_complex", graph, "-map", "[v]", ...h264Args(opts.encode), "-an", ...FASTSTART, out], opts);
  return { path: out };
}

/**
 * Mux an audio track onto a video: video is stream-copied, audio encoded to AAC 192k/48 kHz
 * and padded or trimmed to exactly the video's duration.
 */
export async function muxAudio(video: string, audio: string, out: string, opts: RunOptions = {}): Promise<{ path: string }> {
  const probe = await ffprobe(video, opts);
  const d = probe.duration_s.toFixed(3);
  await runFfmpeg(
    ["-y", "-i", video, "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-af", `apad=whole_dur=${d},atrim=duration=${d}`, ...aacArgs(), ...FASTSTART, out],
    opts,
  );
  return { path: out };
}

export interface BurnOptions extends ComposeOptions {
  /** Directory of fonts shipped with the project, so output does not depend on host fonts. */
  fontsDir?: string;
}

/** The `subtitles=` filter for an ASS/SRT file with correctly escaped paths. */
export function subtitlesFilter(subsPath: string, fontsDir?: string): string {
  return `subtitles=filename=${escapeFilterPath(subsPath)}${fontsDir ? `:fontsdir=${escapeFilterPath(fontsDir)}` : ""}`;
}

/** Burn ASS (karaoke) captions into the video with libass; audio is stream-copied. */
export async function burnCaptions(video: string, subsPath: string, out: string, opts: BurnOptions = {}): Promise<{ path: string }> {
  await runFfmpeg(
    ["-y", "-i", video, "-map", "0:v:0", "-map", "0:a?", "-vf", subtitlesFilter(subsPath, opts.fontsDir), ...h264Args(opts.encode), "-c:a", "copy", ...FASTSTART, out],
    opts,
  );
  return { path: out };
}

/** Re-encode any input with the final delivery settings. */
export async function encodeFinal(input: string, out: string, opts: ComposeOptions = {}): Promise<{ path: string }> {
  await runFfmpeg(["-y", "-i", input, "-map", "0:v:0", "-map", "0:a?", ...h264Args(opts.encode), ...aacArgs(), ...FASTSTART, out], opts);
  return { path: out };
}

/** Full-resolution PNG of the frame at `atMs` (clamped into the video). */
export async function makeThumbnail(video: string, out: string, o: { atMs?: number } & RunOptions = {}): Promise<{ path: string; at_ms: number }> {
  const probe = await ffprobe(video, o);
  const maxMs = Math.max(0, Math.floor(probe.duration_s * 1000) - 100);
  const at = Math.min(Math.max(0, o.atMs ?? 0), maxMs);
  await runFfmpeg(["-y", "-ss", secs(at), "-i", video, "-frames:v", "1", "-update", "1", "-c:v", "png", out], o);
  return { path: out, at_ms: at };
}

// ---------------------------------------------------------------------------------- assembly

export interface AssembleInput extends TargetFormat {
  segments: readonly VideoSegment[];
  /** One voice track file, or per-scene slots (missing audio → silence). Omit for a silent video. */
  audio?: string | readonly AudioSlot[];
  /** Normalise loudness (two-pass) before muxing. Default true. */
  loudness?: LoudnessTarget | false;
  /**
   * Per-scene audio (voice and/or footage sound, crossfades, one-shots) instead of `audio`.
   * Takes precedence over `audio` when both are given.
   */
  sceneAudio?: { slots: readonly SceneAudioSlot[]; sfx?: readonly OneShot[] };
  /** Music bed mixed under the voice (or alone), ducked over `speech`, silent over `mute`; the mix is what gets normalised. */
  music?: { bed: MusicBedInput; speech?: readonly SpeechInterval[]; mute?: readonly SpeechInterval[] };
  /** Clean master output path (no burned captions). */
  master: string;
  /** Captioned reel output path; requires `assPath`. */
  reel?: string;
  assPath?: string;
  fontsDir?: string;
  /** Brand logo over the scenes (part of the clean master). */
  logo?: LogoOverlay;
  /** Scratch directory for intermediates; a temp dir is created and removed when omitted. */
  workDir?: string;
}

export interface AssembleResult {
  master: string;
  reel?: string;
  duration_ms: number;
}

/**
 * concat (+ logo, same encode) → (voice concat) → loudnorm → mux (video stream-copied) = clean
 * master; master + ASS burn-in = captioned reel. The master is one video encode from the scene
 * clips and the reel one more (the burn-in); the logo costs no extra generation.
 */
export async function assemble(input: AssembleInput, opts: ComposeOptions = {}): Promise<AssembleResult> {
  const work = input.workDir ?? (await mkdtemp(join(tmpdir(), "vs-media-")));
  await mkdir(work, { recursive: true });
  try {
    const silentVideo = join(work, "video.mp4");
    const v = await concatVideos(input.segments, silentVideo, input, { ...opts, ...(input.logo ? { logo: input.logo } : {}) });
    if (input.audio === undefined && !input.music && !input.sceneAudio) {
      // Silent video: add a silent AAC track so players and platforms see a normal file.
      await concatAudio([{ duration_ms: v.duration_ms }], join(work, "silence.wav"), opts);
      await muxAudio(silentVideo, join(work, "silence.wav"), input.master, opts);
    } else {
      let track = input.sceneAudio
        ? (await mixSceneAudio(input.sceneAudio.slots, join(work, "scenes.wav"), { ...opts, ...(input.sceneAudio.sfx ? { sfx: input.sceneAudio.sfx } : {}) })).path
        : input.audio === undefined
          ? undefined
          : typeof input.audio === "string"
            ? input.audio
            : (await concatAudio(input.audio, join(work, "voice.wav"), opts)).path;
      if (input.music) {
        track = (
          await mixMusic(
            { ...(track ? { voice: track } : {}), music: input.music.bed, duration_ms: v.duration_ms, ...(input.music.speech ? { speech: input.music.speech } : {}), ...(input.music.mute ? { mute: input.music.mute } : {}), out: join(work, "mix.wav") },
            opts,
          )
        ).path;
      }
      if (input.loudness !== false) track = (await loudnorm2pass(track!, join(work, "mix.norm.wav"), input.loudness ?? {}, opts)).path;
      await muxAudio(silentVideo, track!, input.master, opts);
    }
    let reel: string | undefined;
    if (input.reel) {
      if (!input.assPath) throw new Error("assemble: `reel` requires `assPath`");
      reel = (await burnCaptions(input.master, input.assPath, input.reel, { ...opts, fontsDir: input.fontsDir })).path;
    }
    return { master: input.master, ...(reel ? { reel } : {}), duration_ms: v.duration_ms };
  } finally {
    if (!input.workDir) await rm(work, { recursive: true, force: true });
  }
}

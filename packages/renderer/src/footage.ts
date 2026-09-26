import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { type FfmpegTools, FASTSTART, ffmpegFeatures, getTools, h264Args, resolveFfmpeg, runFfmpeg, runProcess } from "@video-studio/media";
import type { DeterministicKind, FootageClip, MediaInfo, RedactRegion, SceneMotion } from "@video-studio/schema";
import {
  type BuiltGraph,
  type Composition,
  type FfmpegEncodeSettings,
  type FontFiles,
  buildFilterGraph,
  composeScene,
  ffColor,
  frameCount,
  revealChains,
  sceneMotionChains,
  sceneMotionParams,
  zoomPanExprs,
  zoomPanFilter,
} from "./ffmpeg-renderer.js";
import { type FontResolver, createFontResolver } from "./tokens.js";
import type { Availability, MotionTokens, RenderTarget, SceneRenderRequest, SceneRenderResult, SceneRenderer } from "./types.js";

/**
 * Footage renderer: turns a span of a real video (or a still) into an exact-length, silent clip
 * at the target size and fps. The span is trimmed (`in_sec..out_sec`), re-timed (`speed`), fitted
 * (`cover` crops around `focus`, `contain` letterboxes on the background colour, `blur_pad` puts a
 * blurred, dimmed copy behind), and a clip shorter than the scene holds its last frame or loops.
 * Stills get a gentle Ken Burns push-in. `scene.motion` moves the fitted picture (after the fit,
 * before any text is drawn, so titles stay put and text boxes are the rest pose lint checks);
 * on a still it replaces the Ken Burns, and `hold` keeps the still still. Text kinds (lower
 * third, kinetic text, typography, quote, stat) are drawn over the footage with the FFmpeg renderer's layout and drawtext code, so
 * text boxes reach lint exactly as for motion graphics. Audio is not touched: the pipeline mixes
 * the clip's own sound separately.
 */

export const FOOTAGE_RENDERER_ID = "ffmpeg-footage";
/**
 * 0.2.0: crops baked-in letterbox bars (media.content_box) before the fit.
 * 0.2.1: `scene.motion` moves the fitted picture; on stills it replaces the Ken Burns.
 * 0.2.2: word cues (`req.cues`) time the overlay's reveal items.
 */
export const FOOTAGE_RENDERER_VERSION = "0.2.2";

/** Deterministic kinds drawn over footage. Others are ignored with a warning. */
export const FOOTAGE_OVERLAY_KINDS = ["lower_third", "kinetic_text", "typography", "quote", "stat"] as const satisfies readonly DeterministicKind[];

/** Kinds whose text sits straight on the picture get a scrim (the lower third has its own panel). */
const SCRIM_KINDS = new Set<string>(["kinetic_text", "typography", "quote", "stat"]);
const SCRIM_ALPHA = 0.45;
/** Ken Burns push-in over the scene. */
const KEN_BURNS_ZOOM = 0.08;

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);

export function isStillPath(path: string): boolean {
  return IMAGE_EXT.has(extname(path).toLowerCase());
}

export interface FootageRendererOptions {
  fontResolver?: FontResolver;
  encodePreset?: string;
  encode?: FfmpegEncodeSettings;
  tools?: FfmpegTools;
  keepTemp?: boolean;
}

/** `scene.motion` for the footage, with the style's easing (absent: ease-in-out). */
export interface FootageCamera {
  motion?: SceneMotion;
  easing?: MotionTokens["easing"];
}

export interface FootagePlan {
  kind: "video" | "still";
  /** Args for input 0. */
  input: string[];
  /** Filter chains from `[0:v]` to `[fg]`. */
  chains: string[];
  frames: number;
  /** Source seconds used (video). */
  span_sec?: number;
  /** Clip seconds after the speed change (video). */
  play_sec?: number;
  fill: "exact" | "hold" | "loop" | "trim";
  warnings: string[];
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const n3 = (n: number) => String(Math.round(n * 1000) / 1000);

/** Blur sigma for redacted regions: heavy enough that text of any size is unreadable. */
export const REDACT_BLUR_SIGMA = 40;

/**
 * Chains that blur or box each redact region of the SOURCE frame (fractions of it), from
 * `inLabel` to `outLabel`. Times are asset seconds; `inSec` is where the input starts in the
 * asset (the input is seeked there, so its timestamps start at 0). Stills pass inSec 0 and no times.
 */
export function redactChains(regions: readonly RedactRegion[], inSec: number, speed: number, inLabel: string, outLabel: string): string[] {
  if (regions.length === 0) return [`${inLabel}null${outLabel}`];
  const chains: string[] = [];
  let cur = inLabel;
  regions.forEach((r, i) => {
    const next = i === regions.length - 1 ? outLabel : `[rd${i}]`;
    const from = r.from_sec !== undefined ? Math.max(0, (r.from_sec - inSec) / speed) : undefined;
    const to = r.to_sec !== undefined ? Math.max(0, (r.to_sec - inSec) / speed) : undefined;
    const enable = from !== undefined || to !== undefined ? `:enable='between(t,${n3(from ?? 0)},${n3(to ?? 1e6)})'` : "";
    const [x, y, w, h] = [r.x, r.y, r.w, r.h].map(n3);
    if (r.mode === "box") {
      chains.push(`${cur}drawbox=x=iw*${x}:y=ih*${y}:w=iw*${w}:h=ih*${h}:color=black:t=fill${enable}${next}`);
    } else {
      chains.push(
        `${cur}split=2[rb${i}][rc${i}]`,
        `[rc${i}]crop=iw*${w}:ih*${h}:iw*${x}:ih*${y},gblur=sigma=${REDACT_BLUR_SIGMA}:steps=4,eq=brightness=-0.05[rx${i}]`,
        `[rb${i}][rx${i}]overlay=x=main_w*${x}:y=main_h*${y}${enable}${next}`,
      );
    }
    cur = next;
  });
  return chains;
}

/** Crop to the real picture inside baked-in bars (source pixels), or pass through. */
export function contentCrop(box: MediaInfo["content_box"]): string {
  return box ? `crop=${box.w}:${box.h}:${box.x}:${box.y}` : "null";
}

/** Filter chains fitting `inLabel` into W×H as `outLabel`. */
function fitChains(fit: NonNullable<FootageClip["fit"]>, W: number, H: number, focus: { x: number; y: number }, bg: string, inLabel: string, outLabel: string, tag: string): string[] {
  const cover = `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bicubic,crop=${W}:${H}:(iw-${W})*${n3(focus.x)}:(ih-${H})*${n3(focus.y)}`;
  const contain = `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=bicubic`;
  if (fit === "cover") return [`${inLabel}${cover},setsar=1${outLabel}`];
  if (fit === "contain") return [`${inLabel}${contain},pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${ffColor(bg)},setsar=1${outLabel}`];
  // blur_pad: a small, blurred, dimmed cover copy scaled back up behind the contained clip.
  const bw = even(W / 8);
  const bh = even(H / 8);
  return [
    `${inLabel}split=2[${tag}a][${tag}b]`,
    `[${tag}a]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},gblur=sigma=${n3(Math.max(1, bw / 12))},scale=${W}:${H}:flags=bicubic,eq=brightness=-0.08:saturation=0.9,setsar=1[${tag}bg]`,
    `[${tag}b]${contain},setsar=1[${tag}fg]`,
    `[${tag}bg][${tag}fg]overlay=(W-w)/2:(H-h)/2:format=auto${outLabel}`,
  ];
}

/**
 * Pure plan of the footage part of the graph (exported for tests): input args and the chains that
 * end in `[fg]` with exactly `frames` frames at the target size and fps.
 */
export function planFootage(
  clip: FootageClip,
  media: Pick<MediaInfo, "duration_sec" | "content_box">,
  path: string,
  target: RenderTarget,
  durationSec: number,
  background: string,
  camera: FootageCamera = {},
): FootagePlan {
  const { width: W, height: H, fps } = target;
  const frames = frameCount(durationSec, fps);
  const D = frames / fps;
  const fit = clip.fit ?? "cover";
  const focus = clip.focus ?? { x: 0.5, y: 0.5 };
  const warnings: string[] = [];
  const tail = [`format=yuv420p`, `trim=end_frame=${frames}`, "setpts=PTS-STARTPTS"];
  const motion = camera.motion;

  if (isStillPath(path)) {
    // Fit at 2x so zoompan's integer steps stay sub-pixel on output, then push in towards the centre.
    const W2 = even(W * 2);
    const H2 = even(H * 2);
    // scene.motion replaces the Ken Burns: hold and reveal keep z = 1 (reveal then wipes in).
    const move = motion
      ? zoomPanFilter(zoomPanExprs(motion, frames, fps, camera.easing), target, frames)
      : `zoompan=z='1+${KEN_BURNS_ZOOM}*on/${Math.max(1, frames - 1)}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=${frames}:s=${W}x${H}:fps=${fps}`;
    const reveal = motion?.pattern === "reveal";
    return {
      kind: "still",
      input: ["-i", path],
      chains: [
        ...redactChains(clip.redact ?? [], 0, 1, "[0:v]", "[red]"),
        `[red]${contentCrop(media.content_box)}[cc]`,
        ...fitChains(fit, W2, H2, focus, background, "[cc]", "[kb]", "k"),
        `[kb]${move},setsar=1,${tail.join(",")}${reveal ? "[mv]" : "[fg]"}`,
        ...(reveal ? revealChains(target, D, sceneMotionParams(motion, D).sec, background, camera.easing, "[mv]", "[fg]") : []),
      ],
      frames,
      fill: "exact",
      warnings,
    };
  }

  const speed = clip.speed ?? 1;
  const srcDur = media.duration_sec > 0 ? media.duration_sec : Number.POSITIVE_INFINITY;
  const end = Math.min(clip.out_sec ?? clip.in_sec + D * speed, srcDur);
  const span = Math.max(1 / fps, end - clip.in_sec);
  const play = span / speed;
  const short = play < D - 0.5 / fps;
  const fill: FootagePlan["fill"] = short ? (clip.loop ? "loop" : "hold") : play > D + 0.5 / fps ? "trim" : "exact";
  // Frame rounding of the scene slot (a frame or so) is not worth a warning; a real gap is.
  if (short && D - play > Math.max(1.5 / fps, 0.1)) {
    warnings.push(
      `footage: the clip gives ${n3(play)}s${speed !== 1 ? ` at speed ${speed}` : ""}, shorter than the ${n3(D)}s scene; ${clip.loop ? "looped" : "last frame held"}`,
    );
  }
  const clipFrames = Math.max(1, Math.floor(play * fps + 1e-6));
  // scene.motion after the fit and fill, on the exact-length clip (hold: no chains).
  const moveChains = motion ? sceneMotionChains(motion, target, frames, background, camera.easing, "[mv]", "[fg]") : [];
  const fillFilter = fill === "loop" ? [`loop=loop=-1:size=${clipFrames}:start=0`, "setpts=N/FRAME_RATE/TB"] : fill === "hold" ? [`tpad=stop_mode=clone:stop_duration=${n3(D)}`] : [];
  return {
    kind: "video",
    input: ["-ss", n3(clip.in_sec), "-t", n3(span), "-i", path],
    chains: [
      `[0:v]setpts=PTS-STARTPTS${speed !== 1 ? `,setpts=PTS/${speed}` : ""},fps=${fps}[src0]`,
      // Redaction before the fit, in source coordinates, so it stays on the content whatever the crop.
      ...redactChains(clip.redact ?? [], clip.in_sec, speed, "[src0]", "[src1]"),
      // Then drop baked-in black bars, so cover fills the frame with picture, not bars.
      `[src1]${contentCrop(media.content_box)}[src]`,
      ...fitChains(fit, W, H, focus, background, "[src]", "[fit]", "b"),
      ...(moveChains.length ? [`[fit]${[...fillFilter, ...tail].join(",")}[mv]`, ...moveChains] : [`[fit]${[...fillFilter, ...tail].join(",")}[fg]`]),
    ],
    frames,
    span_sec: Math.round(span * 1000) / 1000,
    play_sec: Math.round(play * 1000) / 1000,
    fill,
    warnings,
  };
}

/** The overlay composition for a footage scene (null when the scene draws no text over it). */
export function footageOverlay(req: Pick<SceneRenderRequest, "scene" | "target" | "tokens" | "zones">): { comp: Composition | null; warnings: string[] } {
  const det = req.scene.deterministic;
  if (!det) return { comp: null, warnings: [] };
  if (!(FOOTAGE_OVERLAY_KINDS as readonly string[]).includes(det.kind)) {
    return { comp: null, warnings: [`footage: "${det.kind}" is not drawn over footage (supported: ${FOOTAGE_OVERLAY_KINDS.join(", ")}); skipped`] };
  }
  const comp = composeScene(req.scene, req.target, req.tokens, req.zones ? { zones: req.zones } : {});
  if (SCRIM_KINDS.has(det.kind)) {
    const scrim: Composition["elements"][number] = { type: "box", x: 0, y: 0, w: req.target.width, h: req.target.height, color: ffColor(req.tokens.color_background, SCRIM_ALPHA), beat: 0 };
    comp.elements.unshift(scrim);
  }
  return { comp, warnings: comp.warnings };
}

/** Full ffmpeg argv for a footage clip (exported for tests). */
export function footageRenderArgs(plan: FootagePlan, overlay: BuiltGraph | null, target: RenderTarget, encode: FfmpegEncodeSettings, out: string): string[] {
  const graph = [...plan.chains, overlay ? overlay.filtergraph : "[fg]null[vout]"].join(";");
  return [
    "-y",
    ...plan.input,
    ...(overlay ? overlay.inputs.flat() : []),
    "-filter_complex",
    graph,
    "-map",
    "[vout]",
    "-frames:v",
    String(plan.frames),
    "-r",
    String(target.fps),
    ...h264Args({ preset: encode.preset ?? "veryfast", crf: encode.crf ?? 18 }),
    "-threads",
    String(encode.threads ?? 1),
    "-an",
    "-sn",
    "-dn",
    "-map_metadata",
    "-1",
    "-fflags",
    "+bitexact",
    "-flags:v",
    "+bitexact",
    ...FASTSTART,
    out,
  ];
}

export function createFootageRenderer(opts: FootageRendererOptions = {}): SceneRenderer {
  const fontResolver = opts.fontResolver ?? createFontResolver();
  const encode: FfmpegEncodeSettings = { ...opts.encode, ...(opts.encodePreset ? { preset: opts.encodePreset } : {}) };
  const availability = new Map<string, Promise<Availability>>();

  const checkAvailable = async (env: NodeJS.ProcessEnv): Promise<Availability> => {
    try {
      const tools = opts.tools ?? (await resolveFfmpeg(env));
      const { stdout } = await runProcess(tools.ffmpeg, ["-hide_banner", "-filters"], { captureStdout: true, timeoutMs: 15_000 });
      const missing = ["scale", "crop", "pad", "gblur", "overlay", "zoompan", "tpad", "loop", "drawtext", "drawbox"].filter((name) => !new RegExp(`\\s${name}\\s`).test(stdout));
      if (missing.length) return { ok: false, reason: `ffmpeg lacks filter(s) ${missing.join(", ")}` };
      if (!(await ffmpegFeatures({ tools })).libx264) return { ok: false, reason: "ffmpeg was built without libx264" };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  };

  return {
    id: FOOTAGE_RENDERER_ID,
    version: FOOTAGE_RENDERER_VERSION,
    // Not selectable by deterministic kind: renderScenes routes scenes with footage here directly.
    kinds: [],
    available(env) {
      const key = `${env.FFMPEG_PATH ?? ""}\0${env.PATH ?? ""}`;
      let p = availability.get(key);
      if (!p) {
        p = checkAvailable(env);
        availability.set(key, p);
      }
      return p;
    },
    async render(req: SceneRenderRequest, ropts: { signal?: AbortSignal } = {}): Promise<SceneRenderResult> {
      const { scene, target } = req;
      const tokens = req.tokens;
      if (!scene.footage) throw new Error(`scene ${scene.id} has no footage`);
      if (!req.footage) throw new Error(`scene ${scene.id}: footage asset "${scene.footage.asset}" was not resolved`);
      const tools = await getTools(opts.tools);
      const plan = planFootage(scene.footage, req.footage.media, req.footage.path, target, scene.duration_sec, tokens.color_background, {
        ...(scene.motion ? { motion: scene.motion } : {}),
        ...(tokens.motion ? { easing: tokens.motion.easing } : {}),
      });
      const warnings = [...plan.warnings];
      const { comp, warnings: ow } = footageOverlay(req);
      warnings.push(...ow);
      const tmp = await mkdtemp(join(tmpdir(), "vs-footage-"));
      try {
        let overlay: BuiltGraph | null = null;
        if (comp) {
          const fonts: FontFiles = {
            heading: await fontResolver(tokens.font_heading, tokens.weight_heading ?? 700),
            body: await fontResolver(tokens.font_body, tokens.weight_body),
            mono: await fontResolver(tokens.font_mono),
          };
          overlay = buildFilterGraph(comp, target, plan.frames / target.fps, fonts, tmp, {
            ...(tokens.motion ? { motion: tokens.motion } : {}),
            background: tokens.color_background,
            base: "[fg]",
            noExit: true,
            ...(req.cues?.length ? { cues: req.cues } : {}),
          });
          for (const [name, text] of overlay.textFiles) await writeFile(join(tmp, name), text, "utf8");
        }
        await mkdir(dirname(req.out_path), { recursive: true });
        await runFfmpeg(footageRenderArgs(plan, overlay, target, encode, req.out_path), { tools, signal: ropts.signal, timeoutMs: 10 * 60_000 });
      } finally {
        if (!opts.keepTemp) await rm(tmp, { recursive: true, force: true });
      }
      return {
        scene_id: scene.id,
        out_path: req.out_path,
        duration_ms: Math.round((plan.frames * 1000) / target.fps),
        renderer: FOOTAGE_RENDERER_ID,
        renderer_version: FOOTAGE_RENDERER_VERSION,
        warnings,
        ...(comp ? { text_boxes: comp.text_boxes } : {}),
      };
    },
  };
}

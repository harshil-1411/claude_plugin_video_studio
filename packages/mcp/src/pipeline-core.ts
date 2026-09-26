/**
 * Shared pieces of the render pipeline: public option/result types, version constants, the
 * persisted render state, small path helpers, and spec/brand loading. Split out of pipeline.ts;
 * pipeline.ts re-exports the public names, so import them from there.
 */
import { readFile, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { projectPaths } from "@video-studio/core";
import type { CaptionPlacement } from "@video-studio/media";
import {
  type RendererPreference,
  type RenderTarget,
  type SceneRenderEntry,
  type SceneRenderer,
  type VisualTokens,
  createFfmpegRenderer,
  createHyperframesRenderer,
  targetForAspect,
} from "@video-studio/renderer";
import {
  Brand,
  CreativeBrief,
  type TimingAdjustment,
  VideoSpec,
  type PlatformContract,
  type TextBox,
  parseYamlOrJson,
  resolveMaster,
  resolveTargets,
  type AudioLicense,
  type C2paRecord,
  type VoiceMode,
} from "@video-studio/schema";
import { findPlatformSpecsDir, loadContracts } from "@video-studio/platforms";
import type { BackendChoice, BackendSet } from "@video-studio/voice";
import type { FontRequest, LockFont } from "./lock.js";
import { hyperframesOptions } from "./hyperframes.js";
import type { TargetDist } from "./targets.js";
import { type ValidationIssue, projectSpecPaths, validateSpecFile } from "./spec-validate.js";

export type Env = Record<string, string | undefined>;

/** Engine version recorded in manifests. Keep in sync with SERVER_VERSION. */
export const ENGINE_VERSION = "0.1.0";
/** Bump when technical QA's checks change, so cached QA results are re-run. 2: background-aware black frames, intended silence. */
export const QA_VERSION = 3;
/** Bump to invalidate assembled masters/reels. 2: caption engine v2 (plate, emphasis, zones) + bundled fonts. 3: libass gets a flat fonts folder (bundled caption fonts actually load). 4: the caption plate is its own ASS layer (no dark bars around highlighted words). 5: loudness true peak −1.5 dBTP (headroom for the AAC encode). */
export const ASSEMBLY_VERSION = 5;
/** Scene transition length when neither the scene nor the style sets one (ms). */
export const DEFAULT_TRANSITION_MS = 400;

export type Quality = "preview" | "final";

export type RenderStage = "queued" | "validate" | "voice" | "scenes" | "captions" | "assemble" | "thumbnail" | "qa" | "export" | "done";

export interface RenderProgress {
  stage: RenderStage;
  message: string;
  scene_index?: number;
  scene_count?: number;
  scene_id?: string;
}

export interface RenderProjectOptions {
  voice?: BackendChoice;
  renderer?: RendererPreference;
  quality?: Quality;
  /** Draw titled stand-ins for scenes that need a provider (default true). */
  placeholder?: boolean;
  captions?: { burn_in?: boolean };
  /** brand.yaml path (default: <project>/brand.yaml when present). */
  brandPath?: string;
  signal?: AbortSignal;
  onProgress?: (p: RenderProgress) => void;
  env?: Env;
  // ---- advanced / tests
  /** Override the quality's frame size (short side) and fps. */
  target?: { shortSide?: number; fps?: number };
  /** x264 preset for scene clips and assembly (default: preview ultrafast, final veryfast/medium). */
  encodePreset?: string;
  voiceBackends?: Partial<BackendSet>;
  /** Scene renderers, in preference order (default HyperFrames then ffmpeg). */
  renderers?: SceneRenderer[];
  /** Renderer for footage scenes (default: the ffmpeg footage renderer). */
  footageRenderer?: SceneRenderer;
  voiceCacheDir?: string;
  now?: () => Date;
}

export interface QaFinding {
  id: string;
  status: "warn" | "fail";
  detail: string;
  fix?: string;
}

export interface QaOutcome {
  status: "pass" | "warn" | "fail";
  report_json: string;
  report_md: string;
  findings: QaFinding[];
}

export interface RenderProjectResult {
  project_dir: string;
  quality: Quality;
  width: number;
  height: number;
  fps: number;
  duration_sec: number;
  dist: DistFiles;
  qa: QaOutcome;
  voice: { requested: BackendChoice; backend: string; reason: string; timing_source: string; has_audio: boolean };
  renderer: { preference: RendererPreference; used: string[]; reasons: string[] };
  timing_adjustments: TimingAdjustment[];
  placeholders: string[];
  warnings: string[];
  cache: { voice_hits: string[]; scenes_cached: string[]; scenes_rendered: string[]; assembly: "reused" | "assembled" };
}

export interface DistFiles {
  dir: string;
  reel: string;
  clean_master: string;
  captions_srt?: string;
  captions_vtt?: string;
  transcript?: string;
  thumbnail: string;
  /** Present when the spec has a `cover`: the composed cover JPEG and its centre-square crop. */
  cover?: string;
  cover_square_preview?: string;
  social_copy: string;
  render_manifest: string;
  /** dist/video.lock: versions and hashes of everything the render depended on. */
  lock: string;
  provenance: string;
  /** Copy of project/video-spec.json as rendered. */
  video_spec: string;
  storyboard?: string;
  /** One package per target: dist/<target>/. */
  targets: TargetDist[];
  /** C2PA content credentials written by this export (`sign: true`). */
  c2pa?: C2paRecord;
  /** Export-time warnings (e.g. signing skipped); also in the manifest's warnings. */
  warnings?: string[];
}

/** Spec failed validation: the render was refused. */
export class SpecInvalidError extends Error {
  constructor(readonly errors: ValidationIssue[]) {
    super(
      `project/video-spec.json has ${errors.length} error(s); fix them (spec_validate) before rendering:\n` +
        errors
          .slice(0, 10)
          .map((e) => `- ${e.path || "(root)"}: ${e.message} (fix: ${e.fix})`)
          .join("\n"),
    );
    this.name = "SpecInvalidError";
  }
}

// ------------------------------------------------------------------------------------ render state

/** Everything export/QA need, persisted at renders/<quality>/render-state.json. */
export interface RenderState {
  version: 1;
  quality: Quality;
  started_at: string;
  finished_at: string;
  spec_sha256: string;
  content_ir_sha256?: string;
  target: RenderTarget;
  duration_ms: number;
  burn_in: boolean;
  caption_preset: string;
  scenes: Array<{
    scene_id: string;
    status: SceneRenderEntry["status"];
    renderer: string;
    renderer_version: string;
    cache_key: string;
    clip: string;
    clip_sha256: string;
    duration_ms: number;
    placeholder: boolean;
    reason?: string;
    warnings: string[];
    started_at: string;
    finished_at: string;
    claim_refs: string[];
    visual_strategy: string;
    text_boxes?: TextBox[];
  }>;
  voice: {
    requested: BackendChoice;
    backend: string;
    reason: string;
    timing_source: string;
    voice_id?: string;
    has_audio: boolean;
    tracks_path: string;
    request_hash: string;
  };
  renderer: { preference: RendererPreference; used: string[]; reasons: string[] };
  captions: { json?: string; srt?: string; vtt?: string; txt?: string; ass?: string };
  /** Where burned-in captions sit (from the caption zone or `captions.position`). */
  caption_layout?: CaptionPlacement;
  master: string;
  reel: string;
  thumbnail: string;
  /** Hash of everything the thumbnail/cover depends on. */
  thumbnail_key?: string;
  cover?: {
    path: string;
    square_preview: string;
    at_ms: number;
    width: number;
    height: number;
    bytes: number;
    max_bytes?: number;
    headline_box?: TextBox;
    region: { x: number; y: number; w: number; h: number };
    crops: Array<{ id: string; targets: string[]; x: number; y: number; w: number; h: number }>;
  };
  assembly_key: string;
  qa?: { version?: number; status: "pass" | "warn" | "fail"; video_sha256: string; checks: Array<{ id: string; status: "pass" | "warn" | "fail"; message?: string }>; findings: QaFinding[] };
  timing_adjustments: TimingAdjustment[];
  warnings: string[];
  tool_versions: Record<string, string>;
  /** Scene background colour, so QA's black-frame threshold matches the theme. */
  background?: string;
  /** spec.voice.mode at render time (absent in older states: narrated). */
  voice_mode?: VoiceMode;
  /** The audio was mixed per scene (footage sound, crossfades, sfx) and is not silent. */
  scene_audio?: boolean;
  /** Footage assets the scenes showed (project-relative paths). */
  footage?: Array<{ asset: string; path: string; sha256: string; scenes: string[] }>;
  /** Sound effects mixed in, with their rights. */
  sfx?: Array<{ file: string; sha256: string; scenes: string[]; license?: AudioLicense }>;
  /** Beats detected in the music bed when beat_sync is on. */
  beat_sync?: { bpm: number | null; beats: number; moved_cuts: number; /** Beat times on the video timeline (ms, first 1000), for lint's cut_off_beat. */ beat_times_ms?: number[] };
  /** Brand logo drawn over the scenes (brand visual.logo_placement at a corner), for lint and review. */
  logo?: { path: string; box: { x: number; y: number; w: number; h: number }; scenes: string[] };
  /** Word cues as resolved for this render (scene-local ms), for lint's cue checks. */
  cues?: Array<{ scene_id: string; word: string; item: number; at_ms?: number; status: "placed" | "unmatched" | "late" }>;
  /** The music bed mixed in, with its rights. */
  music?: { ref: string; sha256: string; title?: string; license?: AudioLicense };
  /** Brand file the render read, project-relative (`external/<name>` when outside the project). */
  brand_path?: string;
  /** Font files the render resolved (for video.lock). */
  fonts?: LockFont[];
  /** Style pack the render used, `<id>@<version>` (also in tool_versions.style). */
  style?: string;
  /** Sound-event cues added to the captions ([music], sfx captions, [ambient sound]). */
  sound_events?: number;
  /** policy.yaml in effect (sources + merged policy + what the engine enforced). */
  policy?: import("./policy.js").PolicySummary;
  /** Estimated paid-voice charge of this render (also appended to project/spend.json). */
  paid_voice?: { backend: string; chars: number; estimated_usd: number | null; scenes: string[] };
}

export const toPosix = (p: string) => p.split(sep).join("/");
export const rel = (root: string, p: string) => toPosix(relative(root, p));
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export function renderDir(projectDir: string, quality: Quality): string {
  return join(projectPaths(projectDir).renders, quality);
}

export async function loadBrand(projectDir: string, brandPath?: string): Promise<{ brand: Brand; path: string } | undefined> {
  const candidates = brandPath ? [brandPath] : [join(projectDir, "brand.yaml"), join(projectDir, "project", "brand.yaml")];
  for (const p of candidates) {
    if (!(await exists(p))) {
      if (brandPath) throw new Error(`brand file not found: ${brandPath}`);
      continue;
    }
    const parsed = parseYamlOrJson(Brand, await readFile(p, "utf8"));
    if (!parsed.ok) throw new Error(`invalid brand file ${p}: ${parsed.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
    return { brand: parsed.data, path: p };
  }
  return undefined;
}

/** Font chains and weights the renderers, captions and cover ask for (see lockFonts). */
export function fontRequests(tokens: VisualTokens, captionFamily: string | undefined, burnIn: boolean): FontRequest[] {
  const reqs: FontRequest[] = [
    { chain: tokens.font_heading, weight: tokens.weight_heading ?? 700 },
    { chain: tokens.font_body, weight: tokens.weight_body ?? 400 },
    { chain: tokens.font_mono, weight: 400 },
  ];
  // Burned-in captions use both weights (emphasis toggles bold).
  if (burnIn && captionFamily) reqs.push({ chain: captionFamily, weight: 400 }, { chain: captionFamily, weight: 700 });
  return reqs;
}

/** Brand path as recorded in the render state: project-relative, or `external/<name>`. */
export function brandRel(root: string, p: string): string {
  const r = rel(root, p);
  return r.startsWith("../") || r.startsWith("/") ? `external/${basename(p)}` : r;
}

export async function loadBrief(projectDir: string): Promise<CreativeBrief | undefined> {
  for (const name of ["creative-brief.yaml", "creative-brief.yml", "creative-brief.json"]) {
    const p = join(projectDir, "project", name);
    if (!(await exists(p))) continue;
    const parsed = parseYamlOrJson(CreativeBrief, await readFile(p, "utf8"));
    return parsed.ok ? parsed.data : undefined;
  }
  return undefined;
}

/** Load and validate project/video-spec.json (schema + semantics + ContentIR cross-check). */
export async function loadValidSpec(projectDir: string): Promise<{ spec: VideoSpec; warnings: ValidationIssue[]; specPath: string; irPath: string }> {
  const { spec: specPath, contentIr } = projectSpecPaths(projectDir);
  if (!(await exists(specPath))) throw new Error(`no spec at ${specPath}; plan the video first (the plan skill writes project/video-spec.json)`);
  const v = await validateSpecFile(specPath, contentIr);
  if (!v.ok) throw new SpecInvalidError(v.errors);
  const parsed = parseYamlOrJson(VideoSpec, await readFile(specPath, "utf8"));
  if (!parsed.ok) throw new SpecInvalidError(parsed.errors.map((e) => ({ ...e, fix: "match the VideoSpec schema", stage: "schema" as const })));
  return { spec: parsed.data, warnings: v.warnings, specPath, irPath: contentIr };
}

/**
 * Contracts for the spec's targets that exist in platform-specs/. Unknown ids are skipped here:
 * spec_validate already reports them as errors once the registry has contracts.
 */
export async function loadTargetContracts(spec: Pick<VideoSpec, "platform" | "targets">, dir: string | null = findPlatformSpecsDir()): Promise<PlatformContract[]> {
  if (!dir) return [];
  const wanted = new Set(resolveTargets(spec));
  return (await loadContracts(dir)).filter((c) => wanted.has(c.id));
}

/** Frame size / fps for a quality. Final: the spec's master canvas. Preview: half resolution, 15 fps (24 when HyperFrames draws, it needs 24/30/60). */
export function targetFor(spec: Pick<VideoSpec, "aspect_ratio" | "master">, quality: Quality, hyperframes: boolean, override: RenderProjectOptions["target"] = {}): RenderTarget {
  const master = resolveMaster(spec);
  const masterShort = Math.min(master.width, master.height);
  const shortSide = override.shortSide ?? (quality === "preview" ? Math.round(masterShort / 2) : masterShort);
  const fps = override.fps ?? (quality === "preview" ? (hyperframes ? 24 : 15) : master.fps);
  return targetForAspect(spec.aspect_ratio, { shortSide, fps });
}

export function defaultRenderers(env: Env, quality: Quality, encodePreset?: string): SceneRenderer[] {
  const { resolution: _r, ...hf } = hyperframesOptions(env, { quality: quality === "preview" ? "draft" : "standard" });
  return [createHyperframesRenderer(hf), createFfmpegRenderer({ encodePreset: encodePreset ?? (quality === "preview" ? "ultrafast" : "veryfast") })];
}

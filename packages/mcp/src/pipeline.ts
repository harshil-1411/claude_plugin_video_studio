import { copyFile, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { canonicalJson, ensureDir, hashFile, projectPaths, readJson, resolveDataDir, resolveInsideProject, sha256Hex, writeJsonAtomic } from "@video-studio/core";
import {
  type AudioSlot,
  type CaptionPlacement,
  type CaptionWord,
  type OneShot,
  type QaReport,
  type SceneAudioSlot,
  type SpeechInterval,
  assemble,
  buildWordTimeline,
  detectBeats,
  ffmpegFeatures,
  ffprobe,
  snapCuts,
  makeThumbnail,
  technicalQa,
  toTranscript,
  writeCaptionSet,
  writeQaReport,
} from "@video-studio/media";
import {
  type RendererPreference,
  type RenderTarget,
  type ResolvedFootage,
  createFootageRenderer,
  type SceneRenderEntry,
  type SceneRenderer,
  type VisualTokens,
  bundledFontsStatus,
  createFfmpegRenderer,
  findFontsDir,
  findStylesDir,
  getStyle,
  styleRef,
  createHyperframesRenderer,
  LAYOUT_VERSION,
  parseFontChain,
  rendererFamily,
  renderScenes,
  resolveTokens,
  selectRenderer,
  targetForAspect,
  prepareLibassFontsDir,
} from "@video-studio/renderer";
import {
  Brand,
  ContentIR,
  CreativeBrief,
  type FootageClip,
  type MediaInfo,
  type WordTiming,
  RenderManifest,
  type Scene,
  type SceneRender,
  type SceneVoiceTrack,
  type TimingAdjustment,
  VideoSpec,
  type PlatformContract,
  type TextBox,
  parseYamlOrJson,
  resolveMaster,
  resolveTargets,
  voiceMode,
  type AudioLicense,
  type C2paRecord,
  type Style,
  type VoiceMode,
} from "@video-studio/schema";
import { ZONES_VERSION, findPlatformSpecsDir, layoutZones, loadContracts } from "@video-studio/platforms";
import { type BackendChoice, type BackendSet, type SynthesizeSpecResult, defaultBackends, selectBackend, synthesizeSpec } from "@video-studio/voice";
import { type C2paDeps, type SourceFacts, classifySource, signVideos } from "./c2pa.js";
import { COVER_VERSION, renderCover } from "./cover.js";
import { type ResolvedMusic, resolveMusic } from "./music.js";
import { type FontRequest, type LockFont, LOCK_FILE, buildLock, listFiles, lockAssets, lockFonts, serializeLock } from "./lock.js";
import { hyperframesOptions } from "./hyperframes.js";
import { type LintResult, lintProject } from "./lint.js";
import { TARGET_PACKAGE_VERSION, type TargetDist, packageTargets } from "./targets.js";
import { type ValidationIssue, projectSpecPaths, validateSpecFile } from "./spec-validate.js";

type Env = Record<string, string | undefined>;

/** Engine version recorded in manifests. Keep in sync with SERVER_VERSION. */
export const ENGINE_VERSION = "0.1.0";
/** Bump when technical QA's checks change, so cached QA results are re-run. 2: background-aware black frames, intended silence. */
export const QA_VERSION = 2;
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
interface RenderState {
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
}

const toPosix = (p: string) => p.split(sep).join("/");
const rel = (root: string, p: string) => toPosix(relative(root, p));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function renderDir(projectDir: string, quality: Quality): string {
  return join(projectPaths(projectDir).renders, quality);
}

async function loadBrand(projectDir: string, brandPath?: string): Promise<{ brand: Brand; path: string } | undefined> {
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
function fontRequests(tokens: VisualTokens, captionFamily: string | undefined, burnIn: boolean): FontRequest[] {
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
function brandRel(root: string, p: string): string {
  const r = rel(root, p);
  return r.startsWith("../") || r.startsWith("/") ? `external/${basename(p)}` : r;
}

async function loadBrief(projectDir: string): Promise<CreativeBrief | undefined> {
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

// ------------------------------------------------------------------------------------ renderProject

/**
 * Render a planned project into `dist/`: validate → voice → scene clips → captions → assemble
 * (clean master + captioned reel) → thumbnail → technical QA → export. Every stage is cached:
 * voice by content, clips by sidecar cache keys, and assembly by the hash of its inputs, so a
 * re-run only redoes what changed. The spec is never modified.
 */
export async function renderProject(projectDir: string, o: RenderProjectOptions = {}): Promise<RenderProjectResult> {
  const env = o.env ?? process.env;
  const now = o.now ?? (() => new Date());
  const started_at = now().toISOString();
  const quality: Quality = o.quality ?? "preview";
  const preference: RendererPreference = o.renderer ?? "auto";
  const voiceChoice: BackendChoice = o.voice ?? "auto";
  const placeholder = o.placeholder ?? true;
  const progress = (p: RenderProgress) => o.onProgress?.(p);
  const paths = projectPaths(projectDir);
  const root = paths.root;
  const warnings: string[] = [];
  const signal = o.signal;

  // a. validate
  progress({ stage: "validate", message: "validating project/video-spec.json" });
  const { spec, warnings: specWarnings, irPath } = await loadValidSpec(root);
  for (const w of specWarnings) warnings.push(`spec: ${w.path || "(root)"}: ${w.message}`);
  const brandFile = await loadBrand(root, o.brandPath);
  const brand = brandFile?.brand;
  // Style pack (styles/<id>.yaml): defaults < style < brand. Unknown ids fail with the available ones.
  const style: Style | undefined = spec.style ? await getStyle(findStylesDir(env), spec.style) : undefined;
  // The spec language picks script fonts (Noto JP/Devanagari/Arabic) ahead of the Latin chain.
  const tokens: VisualTokens = resolveTokens(brand, {}, style, { language: spec.language });
  const burnIn = o.captions?.burn_in ?? spec.captions.burn_in;
  const captionPreset = brand?.video?.caption_preset ?? spec.captions.preset;
  // Caption styling: the style's, overridden field by field by the brand's.
  const brandCaptions = style?.captions || brand?.captions ? { ...style?.captions, ...brand?.captions } : undefined;
  // Bundled fonts (fonts/): libass burn-in, the cover and the scene renderers use them first.
  const fontsDir = findFontsDir(env);
  const fonts = bundledFontsStatus(fontsDir);
  if (fonts.missing.length) {
    warnings.push(
      `fonts: bundled fonts missing (${fonts.missing.join(", ")}${fontsDir ? ` in ${fontsDir}` : "; no fonts/ directory found"}); using host fonts, so text may look different on other machines`,
    );
  }

  // b. target
  const renderers = o.renderers ?? defaultRenderers(env, quality, o.encodePreset);
  const availability = new Map();
  const probe = await selectRenderer("typography", renderers, env as NodeJS.ProcessEnv, preference, availability);
  const hyperframesFirst = probe.renderer ? rendererFamily(probe.renderer) === "hyperframes" : false;
  const target = targetFor(spec, quality, hyperframesFirst, o.target);
  const encodePreset = o.encodePreset ?? (quality === "preview" ? "ultrafast" : undefined);
  signal?.throwIfAborted();

  // c. voice (auto falls back to silent if the chosen backend fails at synthesis time)
  progress({ stage: "voice", message: `synthesizing voice (${voiceChoice})` });
  const backends: BackendSet = { ...defaultBackends(), ...o.voiceBackends };
  const voiceCacheDir = o.voiceCacheDir ?? join(resolveDataDir(env).cache, "voice");
  // voice.mode none / native: nothing is synthesized, so no backend is asked (the silent one yields empty tracks).
  const mode = voiceMode(spec);
  const narrated = mode === "narrated";
  const sel = narrated ? await selectBackend(voiceChoice, env, backends) : await selectBackend("silent", env, backends);
  let voice: SynthesizeSpecResult;
  let voiceReason = narrated
    ? sel.reason
    : mode === "native"
      ? 'voice.mode is "native": the speech is in the footage (captions from the asset transcripts)'
      : 'voice.mode is "none": no narration';
  try {
    voice = await synthesizeSpec(spec, {
      projectDir: root,
      backend: sel.backend.id as BackendChoice,
      brand: brand ?? null,
      env,
      cacheDir: voiceCacheDir,
      backends,
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    if (!narrated || voiceChoice !== "auto" || sel.backend.id === "silent") {
      throw new Error(`voice backend "${sel.backend.id}" failed: ${errMsg(e)}. Re-run with voice "auto" or "silent", or run doctor.`);
    }
    voiceReason = `${sel.reason}; but ${sel.backend.id} failed at synthesis (${errMsg(e).slice(0, 300)}); falling back to silent (no audio)`;
    voice = await synthesizeSpec(spec, { projectDir: root, backend: "silent", brand: brand ?? null, env, cacheDir: voiceCacheDir, backends, ...(signal ? { signal } : {}) });
  }
  const trackById = new Map(voice.tracks.map((t) => [t.scene_id, t]));
  const hasAudio = voice.tracks.some((t) => t.audio_path);
  let timingSource = [...new Set(voice.tracks.filter((t) => t.words.length).map((t) => t.timing_source))].join("+") || "none";

  // c0. footage assets (ContentIR → project files) and the music bed
  const footage = await resolveFootage(root, spec, irPath);
  const music: ResolvedMusic | undefined = spec.audio?.music ? await resolveMusic(spec.audio.music, root, env) : undefined;

  // c'. overruns: extend the scene in the render plan only (the spec is untouched)
  const timing_adjustments: TimingAdjustment[] = voice.overruns.map((ov) => ({
    scene_id: ov.scene_id,
    spec_duration_sec: ov.scene_duration_sec,
    render_duration_sec: ov.suggested_duration_sec,
    reason: `voiceover lasts ${ov.audio_duration_sec.toFixed(2)}s, longer than the scene's ${ov.scene_duration_sec}s; extended in the render plan only (edit duration_sec in the spec, or shorten the line, to make it permanent)`,
  }));
  const adjusted = new Map(timing_adjustments.map((a) => [a.scene_id, a.render_duration_sec]));
  for (const a of timing_adjustments) warnings.push(`timing: ${a.scene_id} extended ${a.spec_duration_sec}s → ${a.render_duration_sec}s to fit the voiceover`);

  // c''. beat sync: move cuts onto beats of the music bed (render plan only)
  let beatSync: RenderState["beat_sync"];
  if (spec.audio?.beat_sync?.enabled) {
    if (!music) {
      warnings.push("beat_sync: no audio.music bed to detect beats in; cuts unchanged");
    } else {
      signal?.throwIfAborted();
      const r = await beatSyncDurations(spec.scenes, adjusted, music, spec.audio.beat_sync.tolerance_ms ?? 250, trackById, signal);
      beatSync = r.summary;
      if (r.warning) warnings.push(r.warning);
      for (const a of r.adjustments) {
        const prev = timing_adjustments.find((t) => t.scene_id === a.scene_id);
        if (prev) {
          prev.render_duration_sec = a.render_duration_sec;
          prev.reason += `; ${a.reason}`;
        } else {
          timing_adjustments.push(a);
        }
        adjusted.set(a.scene_id, a.render_duration_sec);
      }
      if (r.adjustments.length) warnings.push(`timing: beat sync moved ${r.summary.moved_cuts} cut(s) onto beats (${r.summary.bpm ?? "?"} bpm)`);
    }
  }
  timing_adjustments.sort((a, b) => spec.scenes.findIndex((s) => s.id === a.scene_id) - spec.scenes.findIndex((s) => s.id === b.scene_id));
  const planScenes: Scene[] = spec.scenes.map((s) => (adjusted.has(s.id) ? { ...s, duration_sec: adjusted.get(s.id)! } : s));

  // d. scene clips
  const rdir = renderDir(root, quality);
  const scenesDir = join(rdir, "scenes");
  const count = planScenes.length;
  let done = 0;
  const sceneStart = new Map<string, string>();
  const sceneEnd = new Map<string, string>();
  progress({ stage: "scenes", message: `rendering ${count} scene(s)`, scene_index: 0, scene_count: count });
  const onScene = (e: SceneRenderEntry) => {
    done++;
    sceneEnd.set(e.scene_id, now().toISOString());
    progress({ stage: "scenes", message: `scene ${e.scene_id}: ${e.status}${e.renderer ? ` (${e.renderer})` : ""}`, scene_index: done, scene_count: count, scene_id: e.scene_id });
  };
  for (const s of planScenes) sceneStart.set(s.id, now().toISOString());
  const contracts = await loadTargetContracts(spec);
  const zones = layoutZones(target, contracts);
  const baseOpts = {
    project_dir: root,
    dir: scenesDir,
    renderers,
    tokens,
    target,
    zones,
    placeholder,
    env: env as NodeJS.ProcessEnv,
    ...(signal ? { signal } : {}),
    footage: footage.byScene,
    footageRenderer: o.footageRenderer ?? createFootageRenderer({ encodePreset: o.encodePreset ?? (quality === "preview" ? "ultrafast" : "veryfast") }),
  };
  const first = await renderScenes({ scenes: planScenes }, { ...baseOpts, preference, onScene });
  const entries = new Map(first.scenes.map((e) => [e.scene_id, e]));
  const reasons: string[] = [probe.reason];
  const failed = first.scenes.filter((e) => e.status === "failed");
  if (failed.length && preference === "auto") {
    // A renderer that passed its probe can still fail on a scene (e.g. Chrome dies): retry with ffmpeg.
    for (const f of failed) reasons.push(`${f.scene_id}: ${f.reason ?? "failed"}; retrying with ffmpeg`);
    done -= failed.length;
    const retry = await renderScenes({ scenes: planScenes }, { ...baseOpts, preference: "ffmpeg", only: failed.map((f) => f.scene_id), onScene });
    for (const e of retry.scenes) entries.set(e.scene_id, e);
  }
  const ordered = planScenes.map((s) => entries.get(s.id)!);
  const broken = ordered.filter((e) => e.status === "failed" || !e.out_path);
  if (broken.length) {
    const lines = broken.map((e) => `- ${e.scene_id} (${e.status}): ${e.reason ?? "no clip"}`);
    const hint = broken.some((e) => e.status === "pending")
      ? "Scenes that need a provider are rendered as placeholders only with placeholder: true."
      : "Run doctor, or re-run with renderer \"ffmpeg\".";
    throw new Error(`could not render ${broken.length} scene(s):\n${lines.join("\n")}\n${hint}`);
  }
  const used = [...new Set(ordered.map((e) => e.renderer!).filter(Boolean))];
  const placeholders = ordered.filter((e) => e.placeholder).map((e) => e.scene_id);
  for (const e of ordered) for (const w of e.warnings) warnings.push(`${e.scene_id}: ${w}`);
  if (placeholders.length) warnings.push(`placeholder cards for ${placeholders.join(", ")} (video providers (generated video, avatars) arrive in Phase 7; until then this is a placeholder card)`);

  // e. captions from the word timeline
  signal?.throwIfAborted();
  progress({ stage: "captions", message: "building captions" });
  // Slots sit on frame boundaries of the cumulative timeline, so per-scene rounding never adds frames.
  const bounds = [0];
  let acc = 0;
  for (const s of planScenes) {
    acc += s.duration_sec;
    bounds.push(Math.round(acc * target.fps));
  }
  const frameMs = (f: number) => (f * 1000) / target.fps;
  const slotMs = planScenes.map((_, i) => frameMs(bounds[i + 1]! - bounds[i]!));
  // voice.mode native: each footage scene's words come from its asset transcript, shifted onto the scene.
  const nativeTracks = new Map<string, SceneVoiceTrack>();
  if (mode === "native") {
    for (const [i, s] of planScenes.entries()) {
      const f = footage.byScene.get(s.id);
      if (!s.footage || !f || "error" in f) continue;
      const amode = s.audio?.mode ?? "native";
      if (amode !== "native" && amode !== "mix") continue;
      const words = await transcriptWords(root, footage.assets.get(s.footage.asset), s.footage, slotMs[i]!, warnings);
      if (words.length) nativeTracks.set(s.id, { scene_id: s.id, duration_ms: Math.round(slotMs[i]!), words, timing_source: "aligned", provider: "native" });
    }
    if (nativeTracks.size) timingSource = "aligned";
  }
  const placements = planScenes.map((s, i) => {
    const dur = slotMs[i]!;
    const track: SceneVoiceTrack = nativeTracks.get(s.id) ?? trackById.get(s.id) ?? { scene_id: s.id, duration_ms: Math.round(dur), words: [], timing_source: "none", provider: "silent" };
    return { scene_start_ms: frameMs(bounds[i]!), track: { ...track, duration_ms: Math.min(track.duration_ms || Math.round(dur), Math.round(dur)) } };
  });
  const totalMs = Math.round(frameMs(bounds[bounds.length - 1]!));
  const words = buildWordTimeline(placements);
  const captionsDir = join(rdir, "captions");
  await rm(captionsDir, { recursive: true, force: true });
  // Caption engine: phrases placed in the caption zone (or centred on captions.position.y), brand caption styling.
  const assOpts = {
    width: target.width,
    height: target.height,
    preset: captionPreset === "bold" ? ("bold" as const) : ("minimal" as const),
    font: brandCaptions?.family ?? parseFontChain(tokens.font_body)[0] ?? "sans-serif",
    highlight: tokens.color_primary,
    box: zones.caption,
    ...(spec.captions.position ? { positionY: spec.captions.position.y } : {}),
    ...(brandCaptions?.weight !== undefined ? { bold: brandCaptions.weight >= 600 } : {}),
    ...(brandCaptions?.plate_opacity !== undefined ? { plateOpacity: brandCaptions.plate_opacity } : {}),
    ...(brandCaptions?.active_word !== undefined ? { activeWord: brandCaptions.active_word } : {}),
    maxLines: brandCaptions?.max_lines ?? 2,
  };
  // Sound-event cues ([music], sfx captions, [ambient sound]) join the timeline unless captions.sound_events is false.
  const cues =
    spec.captions.sound_events === false
      ? []
      : soundEventCues(
          {
            scenes: planScenes.map((s, i) => {
              const start = frameMs(bounds[i]!);
              const amode = s.audio?.mode ?? "native";
              const f = footage.byScene.get(s.id);
              const asset = s.footage ? footage.assets.get(s.footage.asset) : undefined;
              const footageSound = !!s.footage && (amode === "native" || amode === "mix") && !!f && !("error" in f) && asset?.kind === "video" && f.media.has_audio;
              const sfx = (s.sfx ?? []).filter((x) => x.caption?.trim()).map((x) => ({ at_ms: start + x.at_sec * 1000, caption: x.caption! }));
              return {
                id: s.id,
                start_ms: start,
                end_ms: start + slotMs[i]!,
                ...(footageSound ? { footage_sound: true } : {}),
                ...(s.footage && (amode === "native" || amode === "mute") ? { bed_muted: true } : {}),
                ...(sfx.length ? { sfx } : {}),
              };
            }),
            speech: words,
            music: !!music,
            total_ms: totalMs,
          },
          warnings,
        );
  const captionWords = cues.length ? [...words, ...cues].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms) : words;
  const captionSet = captionWords.length ? await writeCaptionSet(captionsDir, "captions", captionWords, { ass: assOpts, maxLines: assOpts.maxLines, endMs: totalMs }) : undefined;
  const captionFiles = captionSet?.files;
  if (captionFiles && cues.length) {
    // The transcript is speech only (cues are for the captions).
    if (words.length) {
      await writeFile(captionFiles.txt, toTranscript(words));
    } else {
      await rm(captionFiles.txt, { force: true });
      delete (captionFiles as { txt?: string }).txt;
    }
  }
  if (!words.length && narrated) warnings.push("no voiceover text: captions and transcript skipped");
  if (!words.length && mode === "native") warnings.push('voice.mode "native": no transcript words in the footage spans; captions and transcript skipped (transcribe the video assets first)');

  // e'. music bed (spec.audio.music), ducked where speech plays
  const speech = placements.filter((p) => p.track.audio_path).map((p) => ({ start_ms: Math.round(p.scene_start_ms), end_ms: Math.round(p.scene_start_ms + p.track.duration_ms) }));

  // e''. per-scene audio: footage sound (native / mix), crossfades and one-shots
  const useSceneAudio = mode === "native" || planScenes.some((s) => s.footage || s.sfx?.length);
  const sceneAudio = useSceneAudio ? await buildSceneAudio(root, planScenes, placements, slotMs, footage, nativeTracks, warnings) : undefined;
  const sceneAudioOn = !!sceneAudio && (sceneAudio.slots.some((sl) => sl.layers.length > 0) || sceneAudio.sfx.length > 0);
  const musicSpeech: SpeechInterval[] = useSceneAudio ? [...(hasAudio ? speech : []), ...sceneAudio!.speech] : hasAudio ? speech : [];
  const musicMute = sceneAudio?.mute ?? [];

  // f. assembly (skipped when the inputs are unchanged)
  // Scene transitions: the scene's own `transition`, else the style pack's default; cut without either.
  const transitionMs = tokens.motion?.transition_ms ?? DEFAULT_TRANSITION_MS;
  const segments = await Promise.all(
    ordered.map(async (e, i) => {
      const kind = planScenes[i]!.transition ?? tokens.motion?.transition;
      return {
        path: e.out_path!,
        duration_ms: slotMs[i]!,
        sha256: await hashFile(e.out_path!),
        ...(i > 0 && kind && kind !== "cut" ? { transition_in: { kind, ms: transitionMs } } : {}),
      };
    }),
  );
  const slots = await Promise.all(
    placements.map(async (p, i) => {
      const abs = p.track.audio_path ? join(root, p.track.audio_path) : undefined;
      return { abs, duration_ms: slotMs[i]!, sha256: abs ? await hashFile(abs) : null };
    }),
  );
  const burn = burnIn && !!captionFiles?.ass;
  const assSha = captionFiles?.ass ? sha256Hex(await readFile(captionFiles.ass)) : null;
  const assemblyKey = sha256Hex(
    canonicalJson({
      v: ASSEMBLY_VERSION,
      target,
      encode: encodePreset ?? null,
      pad: tokens.color_background,
      segments: segments.map((s) => ({ sha: s.sha256, ms: s.duration_ms, ...(s.transition_in ? { tr: s.transition_in } : {}) })),
      audio: hasAudio && !useSceneAudio ? slots.map((s) => ({ sha: s.sha256, ms: s.duration_ms })) : null,
      music: music ? { sha: music.sha256, bed: music.bed, speech: musicSpeech, ...(musicMute.length ? { mute: musicMute } : {}) } : null,
      ...(useSceneAudio ? { scene_audio: sceneAudioOn ? sceneAudio!.key : null } : {}),
      burn,
      ass: burn ? assSha : null,
      captions: burn ? assOpts : null,
      fonts: burn ? fonts.present : null,
    }),
  );
  const master = join(rdir, "master.mp4");
  const reel = join(rdir, "reel.mp4");
  const thumbnail = join(rdir, "thumbnail.png");
  const statePath = join(rdir, "render-state.json");
  const prev = await readJson<RenderState>(statePath).catch(() => undefined);
  const reuse = prev?.assembly_key === assemblyKey && (await exists(master)) && (await exists(reel));
  if (!reuse) {
    signal?.throwIfAborted();
    progress({ stage: "assemble", message: `assembling ${segments.length} clip(s) at ${target.width}x${target.height} ${target.fps} fps` });
    const audio: AudioSlot[] | undefined = hasAudio && !useSceneAudio ? slots.map((s) => ({ ...(s.abs ? { path: s.abs } : {}), duration_ms: s.duration_ms })) : undefined;
    await assemble(
      {
        width: target.width,
        height: target.height,
        fps: target.fps,
        fit: "pad",
        padColor: tokens.color_background,
        segments: segments.map(({ path, duration_ms, transition_in }) => ({ path, duration_ms, ...(transition_in ? { transition_in } : {}) })),
        ...(audio ? { audio } : {}),
        ...(sceneAudioOn ? { sceneAudio: { slots: sceneAudio!.slots, sfx: sceneAudio!.sfx } } : {}),
        // −1.5 dBTP leaves headroom for the AAC encode, so the delivered file stays under the −1 dBTP QA limit.
        ...(audio || music || sceneAudioOn ? { loudness: { I: -14, TP: -1.5 } } : {}),
        ...(music
          ? {
              music: {
                bed: {
                  path: music.path,
                  ...(music.bed.volume_db !== undefined ? { volume_db: music.bed.volume_db } : {}),
                  ...(music.bed.duck_db !== undefined ? { duck_db: music.bed.duck_db } : {}),
                  ...(music.bed.fade_in_ms !== undefined ? { fade_in_ms: music.bed.fade_in_ms } : {}),
                  ...(music.bed.fade_out_ms !== undefined ? { fade_out_ms: music.bed.fade_out_ms } : {}),
                  ...(music.bed.loop !== undefined ? { loop: music.bed.loop } : {}),
                  ...(music.bed.start_sec !== undefined ? { start_sec: music.bed.start_sec } : {}),
                },
                ...(musicSpeech.length ? { speech: musicSpeech } : {}),
                ...(musicMute.length ? { mute: musicMute } : {}),
              },
            }
          : {}),
        master,
        // libass does not search subfolders of fontsdir: hand it a flat folder of the bundled fonts.
        ...(burn ? { reel, assPath: captionFiles!.ass!, ...(fontsDir ? { fontsDir: await prepareLibassFontsDir(join(rdir, "fonts"), undefined, fontsDir) } : {}) } : {}),
      },
      { ...(encodePreset ? { encode: { preset: encodePreset } } : {}), ...(signal ? { signal } : {}) },
    );
    if (!burn) await copyFile(master, reel);
  }

  // g. cover (spec.cover: headline frame at the focal time) or thumbnail at the hook scene's midpoint, from the clean master
  const hookIdx = Math.max(0, planScenes.findIndex((s) => s.purpose === "hook"));
  const hookStart = placements[hookIdx]!.scene_start_ms;
  const hookMid = Math.round(hookStart + slotMs[hookIdx]! / 2);
  const coverAt = spec.cover ? Math.round(spec.cover.focal_time_sec * 1000) : hookMid;
  const thumbnailKey = sha256Hex(
    canonicalJson({
      v: COVER_VERSION,
      assembly: assemblyKey,
      at: coverAt,
      cover: spec.cover ?? null,
      ...(spec.cover ? { zones, tokens, fonts: fonts.present, contracts: contracts.map((c) => `${c.id}@${c.contract_version}`) } : {}),
    }),
  );
  let coverState: RenderState["cover"];
  const coverFilesExist = async (c: NonNullable<RenderState["cover"]>) => (await exists(join(root, c.path))) && (await exists(join(root, c.square_preview)));
  if (reuse && prev?.thumbnail_key === thumbnailKey && (await exists(thumbnail)) && (!prev.cover || (await coverFilesExist(prev.cover)))) {
    coverState = prev.cover;
  } else if (spec.cover) {
    progress({ stage: "thumbnail", message: "composing cover" });
    const c = await renderCover({ master, outDir: rdir, atMs: coverAt, headline: spec.cover.headline, zones, tokens, contracts, env: env as NodeJS.ProcessEnv, ...(signal ? { signal } : {}) });
    warnings.push(...c.warnings);
    coverState = {
      path: rel(root, c.cover),
      square_preview: rel(root, c.square_preview),
      at_ms: c.at_ms,
      width: c.width,
      height: c.height,
      bytes: c.bytes,
      ...(c.max_bytes !== undefined ? { max_bytes: c.max_bytes } : {}),
      ...(c.headline_box ? { headline_box: c.headline_box } : {}),
      region: c.region,
      crops: c.crops.map(({ id, targets, x, y, w, h }) => ({ id, targets, x, y, w, h })),
    };
  } else {
    progress({ stage: "thumbnail", message: "extracting thumbnail" });
    await makeThumbnail(master, thumbnail, { atMs: hookMid, ...(signal ? { signal } : {}) });
    for (const name of ["cover.jpg", "cover-square-preview.jpg"]) await rm(join(rdir, name), { force: true });
  }

  // tool versions
  const tool_versions: Record<string, string> = { node: process.versions.node, "video-studio-engine": ENGINE_VERSION };
  try {
    tool_versions.ffmpeg = (await ffmpegFeatures()).version;
  } catch {
    tool_versions.ffmpeg = "unknown";
  }
  for (const e of ordered) if (e.renderer && e.renderer_version) tool_versions[e.renderer] = e.renderer_version;
  tool_versions[`voice:${voice.backend}`] = voice.backend === "silent" ? "n/a" : "local";
  if (style) tool_versions.style = styleRef(style);

  const lockedFonts = await lockFonts(fontRequests(tokens, assOpts.font, burn), { fontsDir, env: env as NodeJS.ProcessEnv });

  const specSha = sha256Hex(canonicalJson(spec));
  const irSha = (await exists(irPath)) ? await hashFile(irPath) : undefined;
  const state: RenderState = {
    version: 1,
    quality,
    started_at,
    finished_at: started_at,
    spec_sha256: specSha,
    ...(irSha ? { content_ir_sha256: irSha } : {}),
    target,
    duration_ms: totalMs,
    burn_in: burn,
    caption_preset: captionPreset,
    scenes: ordered.map((e, i) => ({
      scene_id: e.scene_id,
      status: e.status,
      renderer: e.renderer!,
      renderer_version: e.renderer_version!,
      cache_key: e.cache_key!,
      clip: rel(root, e.out_path!),
      clip_sha256: segments[i]!.sha256,
      duration_ms: Math.round(segments[i]!.duration_ms),
      placeholder: !!e.placeholder,
      ...(e.reason ? { reason: e.reason } : {}),
      warnings: e.warnings,
      started_at: sceneStart.get(e.scene_id) ?? started_at,
      finished_at: sceneEnd.get(e.scene_id) ?? started_at,
      claim_refs: spec.scenes[i]!.claim_refs,
      visual_strategy: spec.scenes[i]!.visual_strategy,
      ...(e.text_boxes ? { text_boxes: e.text_boxes } : {}),
    })),
    voice: {
      requested: voiceChoice,
      backend: voice.backend,
      reason: voiceReason,
      timing_source: timingSource,
      ...(voice.tracks.find((t) => t.voice)?.voice ? { voice_id: voice.tracks.find((t) => t.voice)!.voice! } : {}),
      has_audio: hasAudio,
      tracks_path: voice.tracks_path,
      request_hash: sha256Hex(canonicalJson({ backend: voice.backend, tracks: voice.tracks.map((t) => ({ id: t.scene_id, ms: t.duration_ms, words: t.words.map((w) => w.word) })) })),
    },
    renderer: { preference, used, reasons },
    captions: captionFiles ? Object.fromEntries(Object.entries(captionFiles).map(([k, v]) => [k, rel(root, v as string)])) : {},
    ...(burn && captionSet?.placement ? { caption_layout: captionSet.placement } : {}),
    master: rel(root, master),
    reel: rel(root, reel),
    thumbnail: rel(root, thumbnail),
    thumbnail_key: thumbnailKey,
    ...(coverState ? { cover: coverState } : {}),
    assembly_key: assemblyKey,
    ...(reuse && prev?.qa ? { qa: prev.qa } : {}),
    timing_adjustments,
    warnings,
    tool_versions,
    voice_mode: mode,
    ...(sceneAudioOn ? { scene_audio: true } : {}),
    ...(footage.used.length ? { footage: footage.used } : {}),
    ...(sceneAudio?.sfxState.length ? { sfx: sceneAudio.sfxState } : {}),
    ...(beatSync ? { beat_sync: beatSync } : {}),
    background: tokens.color_background,
    ...(music ? { music: { ref: music.ref, sha256: music.sha256, ...(music.title ? { title: music.title } : {}), ...(music.license ? { license: music.license } : {}) } } : {}),
    ...(brandFile ? { brand_path: brandRel(root, brandFile.path) } : {}),
    fonts: lockedFonts,
    ...(style ? { style: styleRef(style) } : {}),
    ...(cues.length ? { sound_events: cues.length } : {}),
  };

  // f'. technical QA on the reel (reused when the reel is unchanged)
  const reelSha = await hashFile(reel);
  let qa: QaOutcome;
  if (state.qa && state.qa.video_sha256 === reelSha && state.qa.version === QA_VERSION && (await exists(join(paths.qa, "report.json")))) {
    qa = { status: state.qa.status, findings: state.qa.findings, report_json: join(paths.qa, "report.json"), report_md: join(paths.qa, "report.md") };
  } else {
    signal?.throwIfAborted();
    progress({ stage: "qa", message: "running technical QA" });
    qa = await runQaOn(root, state, reelSha);
  }
  state.finished_at = now().toISOString();
  await writeJsonAtomic(statePath, state);
  await writeJsonAtomic(join(paths.renders, "latest.json"), { quality });

  // g'. export
  progress({ stage: "export", message: "exporting dist/" });
  const dist = await exportFromState(root, state, now);
  progress({ stage: "done", message: `done: ${rel(root, dist.reel)}` });

  return {
    project_dir: root,
    quality,
    width: target.width,
    height: target.height,
    fps: target.fps,
    duration_sec: totalMs / 1000,
    dist,
    qa,
    voice: { requested: voiceChoice, backend: voice.backend, reason: voiceReason, timing_source: timingSource, has_audio: hasAudio },
    renderer: { preference, used, reasons },
    timing_adjustments,
    placeholders,
    warnings,
    cache: {
      voice_hits: voice.cache_hits,
      scenes_cached: ordered.filter((e) => e.from_cache).map((e) => e.scene_id),
      scenes_rendered: ordered.filter((e) => !e.from_cache).map((e) => e.scene_id),
      assembly: reuse ? "reused" : "assembled",
    },
  };
}

// ------------------------------------------------------------------------------------ sound-event captions

/** Shortest stretch with only the music bed that gets a `[music]` cue. */
export const MUSIC_CUE_MIN_GAP_MS = 2000;
/** A cue after speech starts this late, so the last spoken caption keeps its display time. */
export const CUE_SETTLE_MS = 300;
/** Longest a `[music]` / `[ambient sound]` cue stays up (it names the sound; it need not last). */
export const CUE_MAX_MS = 3000;
/** How long an sfx caption stays up (the effect's length is not probed). */
export const SFX_CUE_MS = 1500;
/** Cues shorter than this are dropped. */
export const MIN_CUE_MS = 500;
/** Scene id prefix of cue words: cues form their own captions (never merged with speech). */
export const SOUND_CUE_SCENE_PREFIX = "sound:";

export interface SoundCueScene {
  id: string;
  start_ms: number;
  end_ms: number;
  /** The footage's own sound plays (audio mode native or mix, a video with an audio stream). */
  footage_sound?: boolean;
  /** The music bed is silenced here (footage scene in native or mute mode). */
  bed_muted?: boolean;
  /** Sound effects with a caption, at absolute video time. */
  sfx?: Array<{ at_ms: number; caption: string }>;
}

export interface SoundCueInput {
  scenes: SoundCueScene[];
  /** Spoken words (voiceover or transcript) on the video timeline, sorted. */
  speech: ReadonlyArray<{ start_ms: number; end_ms: number }>;
  /** A music bed plays under the video. */
  music: boolean;
  total_ms: number;
}

type Span = { start_ms: number; end_ms: number };

/** `spans` minus `cut`, both as [start, end) intervals. */
function subtractSpans(spans: readonly Span[], cut: readonly Span[]): Span[] {
  let out = spans.map((s) => ({ ...s }));
  for (const c of cut) {
    const next: Span[] = [];
    for (const s of out) {
      if (c.end_ms <= s.start_ms || c.start_ms >= s.end_ms) {
        next.push(s);
        continue;
      }
      if (c.start_ms > s.start_ms) next.push({ start_ms: s.start_ms, end_ms: c.start_ms });
      if (c.end_ms < s.end_ms) next.push({ start_ms: c.end_ms, end_ms: s.end_ms });
    }
    out = next;
  }
  return out;
}

/** `[applause]` stays; `applause` becomes `[applause]`. */
export function bracketCue(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return /^\[.*\]$/.test(t) ? t : `[${t.replace(/^\[|\]$/g, "")}]`;
}

/** True for a sound-event cue word such as `[music]`. */
export function isSoundCue(word: { word: string; scene_id?: string }): boolean {
  return word.scene_id?.startsWith(SOUND_CUE_SCENE_PREFIX) ?? /^\[.*\]$/.test(word.word);
}

/**
 * Bracketed sound-event cues for accessibility, as caption "words" (one cue = one word, which may
 * contain spaces) that never overlap speech:
 * - each sfx `caption` at its time, for up to {@link SFX_CUE_MS} (dropped, with a warning, when
 *   the effect starts during speech);
 * - `[ambient sound]` at the start of a footage scene whose own sound plays and that has no
 *   spoken words;
 * - `[music]` where only the music bed plays for at least {@link MUSIC_CUE_MIN_GAP_MS} (no speech,
 *   no footage sound, bed not muted), shown at the start of that stretch.
 * Cue words carry scene_id `sound:<scene id>`, so the caption engine gives them captions of their own.
 */
export function soundEventCues(i: SoundCueInput, warnings: string[] = []): CaptionWord[] {
  const speech: Span[] = i.speech.map((w) => ({ start_ms: w.start_ms, end_ms: Math.max(w.end_ms, w.start_ms + 1) }));
  const sceneAt = (ms: number) => i.scenes.find((s) => ms >= s.start_ms && ms < s.end_ms) ?? i.scenes[i.scenes.length - 1];
  const cues: CaptionWord[] = [];
  const push = (word: string, start: number, end: number) => cues.push({ word, start_ms: Math.round(start), end_ms: Math.round(end), scene_id: `${SOUND_CUE_SCENE_PREFIX}${sceneAt(start)?.id ?? ""}` });
  const nextSpeechStart = (ms: number) => speech.find((s) => s.start_ms >= ms)?.start_ms ?? Number.POSITIVE_INFINITY;

  // 1. sfx captions
  const sfx = i.scenes.flatMap((s) => (s.sfx ?? []).map((x) => ({ ...x, scene: s }))).sort((a, b) => a.at_ms - b.at_ms);
  sfx.forEach((x, k) => {
    const text = x.caption.trim();
    if (!text || text === "[]") return;
    const word = bracketCue(text);
    if (x.at_ms >= i.total_ms) return;
    if (speech.some((s) => x.at_ms >= s.start_ms && x.at_ms < s.end_ms)) {
      warnings.push(`captions: sfx caption ${word} in ${x.scene.id} starts during speech; not shown (move the effect into a pause)`);
      return;
    }
    const end = Math.min(x.at_ms + SFX_CUE_MS, i.total_ms, nextSpeechStart(x.at_ms), sfx[k + 1]?.at_ms ?? Number.POSITIVE_INFINITY);
    if (end - x.at_ms < MIN_CUE_MS) {
      warnings.push(`captions: sfx caption ${word} in ${x.scene.id} has under ${MIN_CUE_MS} ms before the next speech or effect; not shown`);
      return;
    }
    push(word, x.at_ms, end);
  });
  const taken = (): Span[] => [...speech, ...cues];

  // 2. ambient sound of footage scenes without speech
  for (const s of i.scenes) {
    if (!s.footage_sound) continue;
    if (speech.some((w) => w.start_ms < s.end_ms && w.end_ms > s.start_ms)) continue;
    const free = subtractSpans([{ start_ms: s.start_ms, end_ms: s.end_ms }], taken()).find((f) => f.end_ms - f.start_ms >= MIN_CUE_MS);
    if (free) push("[ambient sound]", free.start_ms, Math.min(free.end_ms, free.start_ms + CUE_MAX_MS));
  }

  // 3. music-only stretches
  if (i.music) {
    const blocked = [
      ...taken(),
      ...i.scenes.filter((s) => s.footage_sound || s.bed_muted).map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms })),
    ];
    for (const f of subtractSpans([{ start_ms: 0, end_ms: i.total_ms }], blocked)) {
      if (f.end_ms - f.start_ms < MUSIC_CUE_MIN_GAP_MS) continue;
      const afterSpeech = speech.some((w) => Math.abs(w.end_ms - f.start_ms) <= 1);
      const start = f.start_ms + (afterSpeech ? CUE_SETTLE_MS : 0);
      push("[music]", start, Math.min(f.end_ms, start + CUE_MAX_MS));
    }
  }
  return cues.sort((a, b) => a.start_ms - b.start_ms);
}

// ------------------------------------------------------------------------------------ footage, scene audio, beat sync

interface FootageAsset {
  id: string;
  kind: "image" | "video" | "audio";
  /** Project-relative path. */
  rel: string;
  abs: string;
  sha256: string;
  media: MediaInfo;
  /** Project-relative transcript JSON ([{word, start_ms, end_ms}]). */
  transcript?: string;
}

interface FootageResolution {
  byScene: Map<string, ResolvedFootage | { error: string }>;
  assets: Map<string, FootageAsset>;
  used: NonNullable<RenderState["footage"]>;
}

async function probeMedia(abs: string, kind: FootageAsset["kind"]): Promise<MediaInfo> {
  const p = await ffprobe(abs);
  return {
    duration_sec: kind === "image" ? 0 : p.duration_s,
    ...(p.width ? { width: p.width } : {}),
    ...(p.height ? { height: p.height } : {}),
    ...(p.fps && kind !== "image" ? { fps: p.fps } : {}),
    has_video: p.has_video,
    has_audio: kind === "image" ? false : p.has_audio,
  };
}

async function loadFootageAsset(root: string, ir: ContentIR | undefined, irError: string | undefined, id: string): Promise<FootageAsset> {
  if (!ir) throw new Error(irError ?? "no ContentIR");
  const a = ir.assets.find((x) => x.id === id);
  if (!a) throw new Error("not a ContentIR asset id");
  if (a.kind === "audio") throw new Error("is an audio asset; footage needs a video or an image");
  const abs = await resolveInsideProject(projectPaths(root), a.path);
  if (!(await exists(abs))) throw new Error(`file ${a.path} is missing`);
  const media = a.media ?? (await probeMedia(abs, a.kind));
  return { id, kind: a.kind, rel: toPosix(a.path), abs, sha256: await hashFile(abs), media, ...(a.media?.transcript ? { transcript: a.media.transcript.path } : {}) };
}

/** Resolve every footage scene's asset through source/content-ir.json (project-relative paths only). */
async function resolveFootage(root: string, spec: VideoSpec, irPath: string): Promise<FootageResolution> {
  const out: FootageResolution = { byScene: new Map(), assets: new Map(), used: [] };
  const scenes = spec.scenes.filter((s) => s.footage);
  if (!scenes.length) return out;
  let ir: ContentIR | undefined;
  let irError: string | undefined;
  try {
    const parsed = parseYamlOrJson(ContentIR, await readFile(irPath, "utf8"));
    if (parsed.ok) ir = parsed.data;
    else irError = "source/content-ir.json is not a valid ContentIR";
  } catch {
    irError = "no source/content-ir.json (ingest the video first)";
  }
  const failed = new Map<string, string>();
  for (const s of scenes) {
    const id = s.footage!.asset;
    if (!out.assets.has(id) && !failed.has(id)) {
      try {
        out.assets.set(id, await loadFootageAsset(root, ir, irError, id));
      } catch (e) {
        failed.set(id, errMsg(e));
      }
    }
    const a = out.assets.get(id);
    if (!a) {
      out.byScene.set(s.id, { error: failed.get(id)! });
      continue;
    }
    out.byScene.set(s.id, { path: a.abs, sha256: a.sha256, media: a.media });
    const u = out.used.find((x) => x.asset === id);
    if (u) u.scenes.push(s.id);
    else out.used.push({ asset: id, path: a.rel, sha256: a.sha256, scenes: [s.id] });
  }
  return out;
}

/** Source seconds a footage clip plays: `in_sec` to `out_sec` (default: the scene at `speed`), clamped to the asset. */
function footageSpanSec(clip: FootageClip, media: MediaInfo, sceneMs: number): number {
  const speed = clip.speed ?? 1;
  const dur = media.duration_sec > 0 ? media.duration_sec : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(clip.out_sec ?? clip.in_sec + (sceneMs / 1000) * speed, dur) - clip.in_sec);
}

/**
 * Words of an asset transcript inside a footage clip's span, on the scene's timeline: shifted by
 * `in_sec`, divided by `speed`, and cut at the scene end (a looped or held tail has no captions).
 */
async function transcriptWords(root: string, asset: FootageAsset | undefined, clip: FootageClip, sceneMs: number, warnings: string[]): Promise<WordTiming[]> {
  if (!asset?.transcript) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(await resolveInsideProject(projectPaths(root), asset.transcript), "utf8"));
  } catch (e) {
    warnings.push(`captions: transcript ${asset.transcript} of "${asset.id}" could not be read (${errMsg(e)})`);
    return [];
  }
  const list: unknown[] = Array.isArray(raw) ? raw : Array.isArray((raw as { words?: unknown })?.words) ? (raw as { words: unknown[] }).words : [];
  const speed = clip.speed ?? 1;
  const inMs = clip.in_sec * 1000;
  const endMs = inMs + footageSpanSec(clip, asset.media, sceneMs) * 1000;
  const out: WordTiming[] = [];
  for (const w of list) {
    const { word, start_ms, end_ms } = (w ?? {}) as Partial<WordTiming>;
    if (typeof word !== "string" || !word.trim() || typeof start_ms !== "number" || typeof end_ms !== "number") continue;
    if (start_ms < inMs || start_ms >= endMs) continue;
    const a = Math.round((start_ms - inMs) / speed);
    if (a >= sceneMs) continue;
    const b = Math.round(Math.min((Math.min(end_ms, endMs) - inMs) / speed, sceneMs));
    out.push({ word: word.trim(), start_ms: a, end_ms: Math.max(a, b) });
  }
  return out;
}

interface SceneAudioPlan {
  slots: SceneAudioSlot[];
  sfx: OneShot[];
  /** Native speech (transcript words) on the video timeline; the bed ducks there. */
  speech: SpeechInterval[];
  /** Footage scenes with native or muted sound: the bed is silent there. */
  mute: SpeechInterval[];
  /** Everything the mix depends on, by hash, for the assembly key. */
  key: unknown;
  sfxState: NonNullable<RenderState["sfx"]>;
}

/**
 * Per-scene audio: a narrated scene keeps its voice slot; a footage scene plays its own sound for
 * the same span (`native`, `mix`), the bed only (`music`) or nothing (`mute`); crossfades come from
 * `audio.crossfade_ms`; sound effects play at scene start + `at_sec`.
 */
async function buildSceneAudio(
  root: string,
  scenes: readonly Scene[],
  placements: ReadonlyArray<{ scene_start_ms: number; track: SceneVoiceTrack }>,
  slotMs: readonly number[],
  footage: FootageResolution,
  nativeTracks: ReadonlyMap<string, SceneVoiceTrack>,
  warnings: string[],
): Promise<SceneAudioPlan> {
  const paths = projectPaths(root);
  const plan: SceneAudioPlan = { slots: [], sfx: [], speech: [], mute: [], key: null, sfxState: [] };
  const keySlots: unknown[] = [];
  const keySfx: unknown[] = [];
  for (const [i, s] of scenes.entries()) {
    const start = placements[i]!.scene_start_ms;
    const dur = slotMs[i]!;
    const layers: SceneAudioSlot["layers"][number][] = [];
    const keyLayers: unknown[] = [];
    const voicePath = placements[i]!.track.audio_path;
    if (voicePath) {
      const abs = join(root, voicePath);
      layers.push({ path: abs });
      keyLayers.push({ voice: await hashFile(abs) });
    }
    if (s.footage) {
      const amode = s.audio?.mode ?? "native";
      if (amode === "native" || amode === "mute") plan.mute.push({ start_ms: Math.round(start), end_ms: Math.round(start + dur) });
      const f = footage.byScene.get(s.id);
      const asset = footage.assets.get(s.footage.asset);
      if ((amode === "native" || amode === "mix") && f && !("error" in f) && asset && asset.kind === "video" && f.media.has_audio) {
        const clip = s.footage;
        const span = footageSpanSec(clip, f.media, dur);
        const layer = {
          path: f.path,
          offset_sec: clip.in_sec,
          // Without out_sec the sound runs on past the span (for a crossfade tail) unless it loops.
          ...(clip.out_sec !== undefined || clip.loop ? { span_sec: span } : {}),
          ...(clip.speed && clip.speed !== 1 ? { tempo: clip.speed } : {}),
          ...(s.audio?.native_db ? { gain_db: s.audio.native_db } : {}),
          ...(clip.loop ? { loop: true } : {}),
        };
        layers.push(layer);
        const { path: _path, ...params } = layer;
        keyLayers.push({ native: f.sha256, ...params });
      }
      for (const w of nativeTracks.get(s.id)?.words ?? []) plan.speech.push({ start_ms: Math.round(start + w.start_ms), end_ms: Math.round(start + w.end_ms) });
    }
    const xf = i > 0 ? (s.audio?.crossfade_ms ?? 0) : 0;
    plan.slots.push({ duration_ms: dur, layers, ...(xf ? { crossfade_ms: xf } : {}) });
    keySlots.push({ ms: dur, xf, layers: keyLayers });
    for (const fx of s.sfx ?? []) {
      let abs: string;
      try {
        abs = await resolveInsideProject(paths, fx.file);
      } catch (e) {
        throw new Error(`${s.id}: sfx file "${fx.file}" is not a project-relative path (${errMsg(e)})`);
      }
      if (!(await exists(abs))) throw new Error(`${s.id}: sfx file "${fx.file}" not found in the project`);
      if (fx.at_sec * 1000 >= dur) warnings.push(`${s.id}: sfx ${fx.file} at ${fx.at_sec}s starts after the scene ends (${(dur / 1000).toFixed(2)}s)`);
      const sha = await hashFile(abs);
      const at = Math.round(start + fx.at_sec * 1000);
      plan.sfx.push({ path: abs, at_ms: at, ...(fx.volume_db !== undefined ? { volume_db: fx.volume_db } : {}) });
      keySfx.push({ sha, at, db: fx.volume_db ?? 0 });
      const rel = toPosix(fx.file.replace(/^\.\//, ""));
      const prev = plan.sfxState.find((x) => x.file === rel);
      if (prev) {
        if (!prev.scenes.includes(s.id)) prev.scenes.push(s.id);
        if (!prev.license && fx.license) prev.license = fx.license;
      } else {
        plan.sfxState.push({ file: rel, sha256: sha, scenes: [s.id], ...(fx.license ? { license: fx.license } : {}) });
      }
    }
  }
  plan.key = { slots: keySlots, sfx: keySfx };
  return plan;
}

const BEAT_MIN_SCENE_MS = 500;

/**
 * Snap scene cuts to beats of the music bed (on the video timeline: `start_sec` offset, looped
 * when the bed loops). A cut is kept where it was when no beat is within tolerance, or when moving
 * it would cut into a scene's voiceover. Returns timing adjustments for the scenes that changed.
 */
async function beatSyncDurations(
  scenes: readonly Scene[],
  adjusted: ReadonlyMap<string, number>,
  music: ResolvedMusic,
  toleranceMs: number,
  trackById: ReadonlyMap<string, SceneVoiceTrack>,
  signal?: AbortSignal,
): Promise<{ adjustments: TimingAdjustment[]; summary: NonNullable<RenderState["beat_sync"]>; warning?: string }> {
  const durs = scenes.map((s) => Math.round((adjusted.get(s.id) ?? s.duration_sec) * 1000));
  const total = durs.reduce((a, b) => a + b, 0);
  const analysis = await detectBeats(music.path, signal ? { signal } : {});
  const summary: NonNullable<RenderState["beat_sync"]> = { bpm: analysis.bpm, beats: analysis.beats_ms.length, moved_cuts: 0 };
  if (!analysis.beats_ms.length) return { adjustments: [], summary, warning: `beat_sync: no clear beat found in ${music.ref}; cuts unchanged` };
  const fileMs = Math.round((await ffprobe(music.path)).duration_s * 1000);
  const startMs = Math.round((music.bed.start_sec ?? 0) * 1000);
  const loop = music.bed.loop ?? true;
  const beats: number[] = [];
  for (let k = 0; k === 0 || (loop && fileMs > 0 && k * fileMs - startMs <= total); k++) {
    for (const b of analysis.beats_ms) {
      const t = b + k * fileMs - startMs;
      if (t >= 0 && t <= total) beats.push(t);
    }
  }
  beats.sort((a, b) => a - b);
  summary.beat_times_ms = beats.slice(0, 1000).map((t) => Math.round(t));
  const cuts: number[] = [];
  let acc = 0;
  for (const d of durs.slice(0, -1)) cuts.push((acc += d));
  const snapped = snapCuts(cuts, beats, toleranceMs, BEAT_MIN_SCENE_MS);
  const voiceMs = (i: number) => {
    const t = trackById.get(scenes[i]!.id);
    return t?.audio_path ? t.duration_ms : 0;
  };
  const final: number[] = [];
  let prev = 0;
  cuts.forEach((c, j) => {
    const next = j + 1 < cuts.length ? cuts[j + 1]! : total;
    const cand = snapped[j]!;
    const x = cand !== c && cand - prev >= voiceMs(j) && next - cand >= voiceMs(j + 1) ? cand : c;
    final.push(x);
    prev = x;
  });
  const b = [0, ...final, total];
  const s3 = (ms: number) => (ms / 1000).toFixed(3).replace(/\.?0+$/, "");
  const adjustments: TimingAdjustment[] = [];
  summary.moved_cuts = final.filter((x, j) => x !== cuts[j]).length;
  scenes.forEach((s, i) => {
    const nd = b[i + 1]! - b[i]!;
    if (nd === durs[i]) return;
    const moved: string[] = [];
    if (i > 0 && final[i - 1] !== cuts[i - 1]) moved.push(`start ${s3(cuts[i - 1]!)}s → ${s3(final[i - 1]!)}s`);
    if (i < cuts.length && final[i] !== cuts[i]) moved.push(`end ${s3(cuts[i]!)}s → ${s3(final[i]!)}s`);
    adjustments.push({
      scene_id: s.id,
      spec_duration_sec: s.duration_sec,
      render_duration_sec: Math.round(nd) / 1000,
      reason: `beat sync${analysis.bpm ? ` (${analysis.bpm} bpm)` : ""}: ${moved.join(", ")} onto the nearest beat within ${toleranceMs} ms; render plan only (the spec is unchanged)`,
    });
  });
  return { adjustments, summary };
}

// ------------------------------------------------------------------------------------ QA

const QA_MAP = { ok: "pass", warn: "warn", fail: "fail" } as const;

async function runQaOn(root: string, state: RenderState, reelSha?: string): Promise<QaOutcome> {
  const reel = join(root, state.reel);
  const report: QaReport = await technicalQa(reel, {
    width: state.target.width,
    height: state.target.height,
    duration_s: state.duration_ms / 1000,
    require_audio: true,
    intended_silence: state.voice_mode === "none" && !state.music && !state.scene_audio,
    ...(state.background ? { background: state.background } : {}),
  });
  // Relative path in the report so the project folder stays portable.
  report.video = state.reel;
  const files = await writeQaReport(root, report);
  const findings: QaFinding[] = report.checks
    .filter((c) => c.status !== "ok")
    .map((c) => ({ id: c.id, status: c.status as "warn" | "fail", detail: c.detail, ...(c.fix ? { fix: c.fix } : {}) }));
  if (!state.voice.has_audio && !state.music && !state.scene_audio) {
    for (const f of findings) {
      if (f.id === "silence" || f.id === "loudness") f.detail += " (expected: rendered with the silent voice backend)";
    }
  }
  const status = QA_MAP[report.status];
  state.qa = {
    version: QA_VERSION,
    status,
    video_sha256: reelSha ?? (await hashFile(reel)),
    checks: report.checks.map((c) => ({ id: c.id, status: QA_MAP[c.status], message: c.detail })),
    findings,
  };
  return { status, findings, report_json: files.json, report_md: files.md };
}

async function loadState(projectDir: string, quality?: Quality): Promise<RenderState> {
  const paths = projectPaths(projectDir);
  const q = quality ?? (await readJson<{ quality: Quality }>(join(paths.renders, "latest.json")).catch(() => undefined))?.quality;
  if (!q) throw new Error(`no render found in ${paths.renders}; run render_submit first`);
  const state = await readJson<RenderState>(join(renderDir(projectDir, q), "render-state.json")).catch(() => undefined);
  if (!state) throw new Error(`no ${q} render found in ${renderDir(projectDir, q)}; run render_submit with quality "${q}" first`);
  for (const p of [state.master, state.reel, state.thumbnail]) {
    if (!(await exists(join(paths.root, p)))) throw new Error(`render output ${p} is missing; re-run render_submit`);
  }
  return state;
}

/** Re-run technical QA on the latest (or given quality's) reel, then refresh dist/. */
export async function runQa(projectDir: string, opts: { quality?: Quality; now?: () => Date } = {}): Promise<{ qa: QaOutcome; quality: Quality; dist: DistFiles }> {
  const root = projectPaths(projectDir).root;
  const state = await loadState(root, opts.quality);
  const qa = await runQaOn(root, state);
  await writeJsonAtomic(join(renderDir(root, state.quality), "render-state.json"), state);
  const dist = await exportFromState(root, state, opts.now ?? (() => new Date()));
  return { qa, quality: state.quality, dist };
}

/** Re-export dist/ from the latest (or given quality's) existing render; renders nothing. */
export async function exportProject(
  projectDir: string,
  opts: {
    quality?: Quality;
    now?: () => Date;
    /** Sign the exported videos (reel, clean master, every dist/<target>/video.mp4) with C2PA content credentials via the local c2patool. */
    sign?: boolean;
    /** c2patool lookup/runner overrides (tests). */
    c2pa?: C2paDeps;
  } = {},
): Promise<{ quality: Quality; dist: DistFiles; qa_status?: string }> {
  const root = projectPaths(projectDir).root;
  const state = await loadState(root, opts.quality);
  const dist = await exportFromState(root, state, opts.now ?? (() => new Date()), { ...(opts.sign ? { sign: true } : {}), ...(opts.c2pa ? { c2pa: opts.c2pa } : {}) });
  return { quality: state.quality, dist, ...(state.qa ? { qa_status: state.qa.status } : {}) };
}

// ------------------------------------------------------------------------------------ export

const STOPWORDS = new Set(
  "a an and are as at be but by can do does for from how in into is it its of on or so that the their this to what when where which who why with without you your in 30s seconds explain explained actually".split(
    " ",
  ),
);

const PLATFORM_TAGS: Record<string, string[]> = {
  youtube_shorts: ["shorts"],
  instagram_reels: ["reels"],
  tiktok: ["fyp"],
  linkedin: [],
  youtube: [],
  x: [],
  generic: [],
};

function hashtag(word: string): string {
  return word.replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

function firstSentence(text: string): string {
  return (text.split(/(?<=[.!?])\s/)[0] ?? text).trim();
}

/** Deterministic social copy (title, 2–3 line description, hashtags). Claude refines it in the skill. */
export function socialCopy(spec: VideoSpec, brief?: CreativeBrief): string {
  const { title, lines, hashtags } = socialCopyParts(spec, brief);
  return [
    "<!-- Generated deterministically from the spec and brief by video-studio. Refine the wording before posting; keep every claim grounded in the sources. -->",
    `# ${title}`,
    "",
    ...lines,
    "",
    hashtags.join(" "),
    "",
  ].join("\n");
}

/** The pieces of {@link socialCopy}: title, up to 3 description lines and up to 7 hashtags (with `#`). */
export function socialCopyParts(spec: VideoSpec, brief?: CreativeBrief): { title: string; lines: string[]; hashtags: string[] } {
  const title = spec.title?.trim() || brief?.chosen_hook || firstSentence(spec.scenes[0]?.voiceover ?? "") || "New video";
  const lines: string[] = [];
  const hook = spec.scenes.find((s) => s.purpose === "hook");
  if (hook?.voiceover.trim()) lines.push(hook.voiceover.trim());
  const messages = brief?.key_messages?.length
    ? brief.key_messages
    : spec.scenes.filter((s) => !["hook", "cta", "end_card"].includes(s.purpose) && s.voiceover.trim()).map((s) => firstSentence(s.voiceover));
  if (messages[0] && !lines.includes(messages[0])) lines.push(messages[0]);
  const action = brief?.desired_action ?? spec.scenes.find((s) => s.purpose === "cta")?.voiceover.trim();
  if (action) lines.push(action);
  const contentWords = (text: string) =>
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  // Title words first, then words the narration repeats across scenes (most frequent first).
  const freq = new Map<string, number>();
  for (const sc of spec.scenes) for (const w of new Set(contentWords(sc.voiceover))) freq.set(w, (freq.get(w) ?? 0) + 1);
  const repeated = [...freq].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([w]) => w);
  const tags: string[] = [];
  const add = (w: string) => {
    const t = hashtag(w);
    if (t && !tags.some((x) => x.toLowerCase() === t.toLowerCase() || x.toLowerCase() === `${t.toLowerCase()}s` || `${x.toLowerCase()}s` === t.toLowerCase())) tags.push(t);
  };
  for (const w of contentWords(title)) add(w);
  for (const w of repeated.slice(0, 3)) add(w);
  for (const w of [...(PLATFORM_TAGS[spec.platform] ?? []), spec.goal === "explain" ? "explained" : spec.goal]) add(w);
  return { title, lines: lines.slice(0, 3), hashtags: tags.slice(0, 7).map((t) => `#${t}`) };
}

async function exportFromState(root: string, state: RenderState, now: () => Date, opts: { sign?: boolean; c2pa?: C2paDeps } = {}): Promise<DistFiles> {
  const paths = projectPaths(root);
  const distDir = paths.dist;
  await ensureDir(distDir);
  const { spec } = await loadSpecLoose(root);
  const brief = await loadBrief(root);
  const d = (name: string) => join(distDir, name);
  const out: DistFiles = {
    dir: distDir,
    reel: d("reel.mp4"),
    clean_master: d("clean-master.mp4"),
    thumbnail: d("thumbnail.png"),
    social_copy: d("social-copy.md"),
    render_manifest: d("render-manifest.json"),
    lock: d(LOCK_FILE),
    provenance: d("provenance.json"),
    video_spec: d("video-spec.json"),
    targets: [],
  };
  await copyFile(join(root, state.reel), out.reel);
  await copyFile(join(root, state.master), out.clean_master);
  await copyFile(join(root, state.thumbnail), out.thumbnail);
  if (state.cover && (await exists(join(root, state.cover.path))) && (await exists(join(root, state.cover.square_preview)))) {
    out.cover = d("cover.jpg");
    out.cover_square_preview = d("cover-square-preview.jpg");
    await copyFile(join(root, state.cover.path), out.cover);
    await copyFile(join(root, state.cover.square_preview), out.cover_square_preview);
  } else {
    for (const name of ["cover.jpg", "cover-square-preview.jpg"]) await rm(d(name), { force: true });
  }
  for (const [key, src, name] of [
    ["captions_srt", state.captions.srt, "captions.srt"],
    ["captions_vtt", state.captions.vtt, "captions.vtt"],
    ["transcript", state.captions.txt, "transcript.txt"],
  ] as const) {
    if (src) {
      await copyFile(join(root, src), d(name));
      out[key] = d(name);
    } else {
      await rm(d(name), { force: true });
    }
  }
  await writeFile(out.social_copy, socialCopy(spec, brief));
  await copyFile(projectSpecPaths(root).spec, out.video_spec);
  const storyboardSrc = join(root, "project", "storyboard.md");
  if (await exists(storyboardSrc)) {
    out.storyboard = d("storyboard.md");
    await copyFile(storyboardSrc, out.storyboard);
  } else {
    await rm(d("storyboard.md"), { force: true });
  }

  // per-target packages: dist/<target>/
  let lint: LintResult | undefined;
  let lintError: string | undefined;
  try {
    lint = await lintProject(root, { quality: state.quality });
  } catch (e) {
    lintError = errMsg(e);
  }
  const specsDir = findPlatformSpecsDir();
  const allContracts = specsDir ? await loadContracts(specsDir) : [];
  const wanted = resolveTargets(spec);
  out.targets = await packageTargets(
    {
      root,
      distDir,
      renderDir: renderDir(root, state.quality),
      quality: state.quality,
      spec,
      contracts: allContracts.filter((c) => wanted.includes(c.id)),
      reel: out.reel,
      reelFacts: {
        width: state.target.width,
        height: state.target.height,
        fps: state.target.fps,
        duration_sec: state.duration_ms / 1000,
        bytes: (await stat(out.reel)).size,
      },
      ...(out.cover ? { cover: out.cover } : {}),
      ...(state.cover ? { coverAtMs: state.cover.at_ms } : {}),
      ...(out.captions_srt ? { captionsSrt: out.captions_srt } : {}),
      ...(out.captions_vtt ? { captionsVtt: out.captions_vtt } : {}),
      generatedCopy: (c) => {
        // Platform hashtags (#Shorts, #Reels, #fyp) follow the target, not the spec's primary platform.
        const copy = socialCopyParts({ ...spec, platform: c.platform ?? "generic" }, brief);
        return { post_caption: [copy.title, ...copy.lines].join("\n"), hashtags: copy.hashtags };
      },
      ...(lint ? { lint } : {}),
      ...(lintError ? { lintError } : {}),
      ...(state.qa ? { technicalQa: state.qa.status } : {}),
      ...(state.music ? { music: { ref: state.music.ref, ...(state.music.title ? { title: state.music.title } : {}), ...(state.music.license ? { license: state.music.license } : {}) } } : {}),
    },
    allContracts.map((c) => c.id),
  );

  // C2PA: sign the exported videos (after packaging, which copies/transcodes the unsigned reel;
  // before hashing, so outputs and video.lock describe the signed files).
  const exportWarnings: string[] = [];
  let signed = new Set<string>();
  let c2pa: C2paRecord | undefined;
  let c2paSource: ReturnType<typeof classifySource> | undefined;
  if (opts.sign) {
    const facts: SourceFacts = {
      voice_backend: state.voice.backend,
      voice_has_audio: state.voice.has_audio,
      scenes: state.scenes.map((s) => ({ renderer: s.renderer, placeholder: s.placeholder })),
    };
    const r = await signVideos({
      root,
      files: [out.reel, out.clean_master, ...out.targets.map((t) => t.video)],
      title: spec.title?.trim() || socialCopyParts(spec, brief).title,
      engineVersion: ENGINE_VERSION,
      facts,
      ...opts.c2pa,
    });
    exportWarnings.push(...r.warnings);
    signed = new Set(r.signed);
    c2pa = r.record;
    if (c2pa) c2paSource = classifySource(facts);
  }
  const c2paFlag = (p: string) => (signed.has(p) ? { c2pa: true } : {});
  if (c2pa) out.c2pa = c2pa;
  if (exportWarnings.length) out.warnings = exportWarnings;

  // provenance: copy source/provenance.json and add what this render used
  let source: unknown = null;
  try {
    source = JSON.parse(await readFile(join(paths.source, "provenance.json"), "utf8"));
  } catch {
    source = null;
  }
  const provenance = {
    ...(source && typeof source === "object" ? (source as Record<string, unknown>) : { sources: [] }),
    render: {
      rendered_at: state.finished_at,
      quality: state.quality,
      spec_sha256: state.spec_sha256,
      ...(state.content_ir_sha256 ? { content_ir_sha256: state.content_ir_sha256 } : {}),
      voice: { backend: state.voice.backend, timing_source: state.voice.timing_source, ...(state.voice_mode ? { mode: state.voice_mode } : {}) },
      ...(state.music ? { music: { file: state.music.ref, ...(state.music.title ? { title: state.music.title } : {}), license: state.music.license ?? null } } : {}),
      ...(state.footage?.length ? { footage: state.footage.map((f) => ({ asset: f.asset, file: f.path, sha256: f.sha256, scenes: f.scenes })) } : {}),
      ...(state.sfx?.length ? { sfx: state.sfx.map((x) => ({ file: x.file, sha256: x.sha256, scenes: x.scenes, license: x.license ?? null })) } : {}),
      ...(state.timing_adjustments.length ? { timing_adjustments: state.timing_adjustments } : {}),
      ...(state.sound_events ? { captions: { sound_events: state.sound_events } } : {}),
      ...(c2pa && c2paSource ? { c2pa: { ...c2pa, digital_source_type: c2paSource.digital_source_type, reasons: c2paSource.reasons } } : {}),
      scenes: state.scenes.map((s) => ({
        scene_id: s.scene_id,
        claim_refs: s.claim_refs,
        visual_strategy: s.visual_strategy,
        renderer: s.renderer,
        placeholder: s.placeholder,
      })),
    },
  };
  await writeJsonAtomic(out.provenance, provenance);

  // manifest
  const sha = (p: string) => hashFile(p);
  const reelProbe = { width: state.target.width, height: state.target.height, duration_sec: state.duration_ms / 1000 };
  const outputs: RenderManifest["outputs"] = [
    { kind: "final", path: rel(root, out.reel), sha256: await sha(out.reel), ...reelProbe, ...c2paFlag(out.reel) },
    { kind: "clean_master", path: rel(root, out.clean_master), sha256: await sha(out.clean_master), ...reelProbe, ...c2paFlag(out.clean_master) },
  ];
  if (out.captions_srt) outputs.push({ kind: "captions", path: rel(root, out.captions_srt), sha256: await sha(out.captions_srt) });
  if (out.captions_vtt) outputs.push({ kind: "captions", path: rel(root, out.captions_vtt), sha256: await sha(out.captions_vtt) });
  if (out.transcript) outputs.push({ kind: "other", path: rel(root, out.transcript), sha256: await sha(out.transcript) });
  outputs.push({ kind: "thumbnail", path: rel(root, out.thumbnail), sha256: await sha(out.thumbnail), width: state.target.width, height: state.target.height });
  if (out.cover && out.cover_square_preview && state.cover) {
    const sq = state.cover.crops.find((c) => c.id === "square-preview");
    outputs.push({ kind: "thumbnail", path: rel(root, out.cover), sha256: await sha(out.cover), width: state.cover.width, height: state.cover.height });
    outputs.push({ kind: "other", path: rel(root, out.cover_square_preview), sha256: await sha(out.cover_square_preview), ...(sq ? { width: sq.w, height: sq.h } : {}) });
  }
  outputs.push({ kind: "social_copy", path: rel(root, out.social_copy), sha256: await sha(out.social_copy) });
  outputs.push({ kind: "provenance", path: rel(root, out.provenance), sha256: await sha(out.provenance) });
  outputs.push({ kind: "spec", path: rel(root, out.video_spec), sha256: await sha(out.video_spec) });
  if (out.storyboard) outputs.push({ kind: "other", path: rel(root, out.storyboard), sha256: await sha(out.storyboard) });
  for (const t of out.targets) {
    const target = t.id;
    outputs.push({
      kind: "final",
      target,
      path: rel(root, t.video),
      sha256: await sha(t.video),
      width: t.width,
      height: t.height,
      duration_sec: state.duration_ms / 1000,
      ...(t.transcoded ? { transcoded: true } : {}),
      ...c2paFlag(t.video),
    });
    if (t.cover) outputs.push({ kind: "thumbnail", target, path: rel(root, t.cover), sha256: await sha(t.cover) });
    for (const p of [t.captions_srt, t.captions_vtt]) if (p) outputs.push({ kind: "captions", target, path: rel(root, p), sha256: await sha(p) });
    outputs.push({ kind: "post", target, path: rel(root, t.post), sha256: await sha(t.post) });
    outputs.push({ kind: "qa", target, path: rel(root, t.qa), sha256: await sha(t.qa) });
  }

  const statusMap: Record<SceneRenderEntry["status"], SceneRender["status"]> = { rendered: "succeeded", cached: "cached", pending: "pending", failed: "failed" };
  const renders: SceneRender[] = state.scenes.map((s) => ({
    scene_id: s.scene_id,
    provider: s.renderer,
    model: `${s.renderer}@${s.renderer_version}`,
    request_hash: s.cache_key,
    output_path: s.clip,
    output_sha256: s.clip_sha256,
    started_at: s.started_at,
    finished_at: s.finished_at,
    attempts: 1,
    status: statusMap[s.status],
    renderer_version: s.renderer_version,
    ...(s.placeholder ? { placeholder: true, error: `placeholder: ${s.reason ?? "video providers (generated video, avatars) arrive in Phase 7; until then this is a placeholder card"}` } : {}),
    ...(s.warnings.length ? { warnings: s.warnings } : {}),
    ...(s.text_boxes?.length ? { text_boxes: s.text_boxes } : {}),
  }));

  const captionFiles: NonNullable<RenderManifest["captions"]>["files"] = [];
  for (const fmt of ["json", "srt", "vtt", "ass"] as const) {
    const p = state.captions[fmt];
    if (p) captionFiles.push({ format: fmt, path: p, sha256: await sha(join(root, p)) });
  }
  const tracksAbs = join(root, state.voice.tracks_path);
  const project = await readJson<{ id?: string }>(paths.projectFile).catch(() => undefined);
  const projectId = project?.id ?? spec.id ?? (basename(root).replace(/[^A-Za-z0-9_.@:-]/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "project");

  const manifest: RenderManifest = {
    schema_version: "1.0",
    project_id: projectId,
    spec_sha256: state.spec_sha256,
    ...(state.content_ir_sha256 ? { content_ir_sha256: state.content_ir_sha256 } : {}),
    created_at: state.started_at,
    updated_at: now().toISOString(),
    renders,
    ...((await exists(tracksAbs))
      ? {
          voice: {
            provider: state.voice.backend,
            ...(state.voice.voice_id ? { voice_id: state.voice.voice_id } : {}),
            request_hash: state.voice.request_hash,
            output_path: state.voice.tracks_path,
            output_sha256: await sha(tracksAbs),
            ...(state.captions.json ? { alignment_path: state.captions.json } : {}),
            timing_source: (["provider", "aligned", "estimated", "none"].includes(state.voice.timing_source) ? state.voice.timing_source : "estimated") as "provider",
            reason: state.voice.reason,
          },
        }
      : {}),
    ...(captionFiles.length
      ? {
          captions: {
            preset: state.caption_preset,
            burn_in: state.burn_in,
            ...(state.burn_in && state.caption_layout ? { box: state.caption_layout.box, max_lines: state.caption_layout.max_lines } : {}),
            ...(state.sound_events ? { sound_events: state.sound_events } : {}),
            files: captionFiles,
          },
        }
      : {}),
    ...(state.music ? { music: { file: state.music.ref, sha256: state.music.sha256, ...(state.music.title ? { title: state.music.title } : {}), ...(state.music.license ? { license: state.music.license } : {}) } } : {}),
    ...(out.cover && state.cover
      ? {
          cover: {
            path: rel(root, out.cover),
            ...(out.cover_square_preview ? { square_preview: rel(root, out.cover_square_preview) } : {}),
            at_ms: state.cover.at_ms,
            ...(state.cover.headline_box ? { headline_box: state.cover.headline_box } : {}),
            crops: state.cover.crops.map(({ id, targets, x, y, w, h }) => ({ id, targets, rect: { x, y, w, h } })),
          },
        }
      : {}),
    outputs,
    ...(c2pa ? { c2pa } : {}),
    ...(state.qa ? { qa: { status: state.qa.status, checks: state.qa.checks, report_path: "qa/report.json" } } : {}),
    settings: {
      quality: state.quality,
      width: state.target.width,
      height: state.target.height,
      fps: state.target.fps,
      aspect_ratio: state.target.aspect_ratio,
      renderer_preference: state.renderer.preference,
      renderer_reasons: state.renderer.reasons,
    },
    ...(state.timing_adjustments.length ? { timing_adjustments: state.timing_adjustments } : {}),
    ...(state.warnings.length || exportWarnings.length ? { warnings: [...state.warnings, ...exportWarnings] } : {}),
    tool_versions: { ...state.tool_versions, ...(c2pa ? { c2patool: c2pa.tool.replace(/^c2patool\s+/, "") } : {}) },
  };
  // video.lock (before the manifest, which lists it)
  const lock = await lockFromState(root, state, projectId, outputs);
  await writeFile(out.lock, serializeLock(lock));
  // A copy per quality, so diff can compare preview and final after dist/ moved on to the other one.
  await writeFile(join(renderDir(root, state.quality), LOCK_FILE), serializeLock(lock));
  manifest.outputs.push({ kind: "lock", path: rel(root, out.lock), sha256: await sha(out.lock) });

  const parsed = RenderManifest.safeParse(manifest);
  if (!parsed.success) throw new Error(`internal: render manifest failed schema validation: ${parsed.error.message}`);
  await writeJsonAtomic(out.render_manifest, parsed.data);
  return out;
}

/**
 * The lock for an exported render. Assets are the project inputs the render and export read:
 * the ContentIR and source provenance, the brand file, the brief and storyboard, and files under
 * assets/ (except assets/voice/, which the render writes; the voice request hash covers it).
 */
async function lockFromState(root: string, state: RenderState, projectId: string, outputs: RenderManifest["outputs"]) {
  const paths = projectPaths(root);
  const brand = state.brand_path && !state.brand_path.startsWith("external/") ? [state.brand_path] : state.brand_path ? [] : ["brand.yaml", "project/brand.yaml"];
  const inputs = [
    rel(root, projectSpecPaths(root).contentIr),
    rel(root, join(paths.source, "provenance.json")),
    ...brand,
    ...["creative-brief.yaml", "creative-brief.yml", "creative-brief.json", "storyboard.md"].map((n) => `project/${n}`),
    ...(await listFiles(root, "assets", ["assets/voice"])),
    // Footage and sound effects may live outside assets/ (e.g. source/); they are inputs too.
    ...(state.footage ?? []).map((f) => f.path),
    ...(state.sfx ?? []).map((x) => x.file),
  ];
  // Fonts: recorded at render time; older render states are resolved now.
  let fonts = state.fonts;
  if (!fonts) {
    const brandFile = await loadBrand(root).catch(() => undefined);
    const styleId = state.style?.split("@")[0];
    const style = styleId ? await getStyle(findStylesDir(process.env), styleId).catch(() => undefined) : undefined;
    const language = await loadSpecLoose(root).then((r) => r.spec.language).catch(() => undefined);
    const tokens = resolveTokens(brandFile?.brand, {}, style, language ? { language } : {});
    const captionFamily = brandFile?.brand.captions?.family ?? parseFontChain(tokens.font_body)[0];
    fonts = await lockFonts(fontRequests(tokens, captionFamily, state.burn_in), { fontsDir: findFontsDir(process.env) });
  }
  const specsDir = findPlatformSpecsDir();
  const contracts = specsDir ? await loadContracts(specsDir) : [];
  const targetIds = new Set(outputs.flatMap((o) => (o.target ? [o.target] : [])));
  const { "video-studio-engine": _e, ...tools } = state.tool_versions;
  return buildLock({
    schema_version: "1.0",
    project_id: projectId,
    quality: state.quality,
    spec_sha256: state.spec_sha256,
    ...(state.content_ir_sha256 ? { content_ir_sha256: state.content_ir_sha256 } : {}),
    engine: {
      engine: ENGINE_VERSION,
      assembly: String(ASSEMBLY_VERSION),
      cover: String(COVER_VERSION),
      target_package: String(TARGET_PACKAGE_VERSION),
      zones: String(ZONES_VERSION),
      layout: String(LAYOUT_VERSION),
    },
    tools,
    voice: { backend: state.voice.backend, ...(state.voice.voice_id ? { voice_id: state.voice.voice_id } : {}), request_hash: state.voice.request_hash },
    fonts,
    targets: contracts.filter((c) => targetIds.has(c.id)).map((c) => ({ id: c.id, contract_version: c.contract_version, verified: c.verified })),
    scenes: state.scenes.map((s) => ({ scene_id: s.scene_id, renderer: s.renderer, renderer_version: s.renderer_version, cache_key: s.cache_key, clip_sha256: s.clip_sha256 })),
    // A user music file outside assets/ is an input too; a bundled bed is recorded by its ref.
    assets: [
      ...(await lockAssets(root, [...new Set(state.music && !state.music.ref.startsWith("bundled:") ? [...inputs, state.music.ref] : inputs)])),
      ...(state.music?.ref.startsWith("bundled:") ? [{ path: state.music.ref, sha256: state.music.sha256 }] : []),
    ],
    outputs: outputs.map((o) => ({ path: o.path, sha256: o.sha256, ...(o.target ? { target: o.target } : {}) })),
  });
}

/** Spec for export: parsed without re-running semantic validation (the render already did). */
async function loadSpecLoose(root: string): Promise<{ spec: VideoSpec }> {
  const { spec: specPath } = projectSpecPaths(root);
  const parsed = parseYamlOrJson(VideoSpec, await readFile(specPath, "utf8"));
  if (!parsed.ok) throw new Error(`project/video-spec.json is no longer valid: ${parsed.errors.map((e) => e.message).join("; ")}`);
  return { spec: parsed.data };
}

import { copyFile, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { canonicalJson, ensureDir, hashFile, projectPaths, readJson, resolveDataDir, sha256Hex, writeJsonAtomic } from "@video-studio/core";
import {
  type AudioSlot,
  type QaReport,
  assemble,
  buildWordTimeline,
  ffmpegFeatures,
  makeThumbnail,
  technicalQa,
  writeCaptionSet,
  writeQaReport,
} from "@video-studio/media";
import {
  type RendererPreference,
  type RenderTarget,
  type SceneRenderEntry,
  type SceneRenderer,
  type VisualTokens,
  createFfmpegRenderer,
  createHyperframesRenderer,
  parseFontChain,
  rendererFamily,
  renderScenes,
  resolveTokens,
  selectRenderer,
  targetForAspect,
} from "@video-studio/renderer";
import {
  Brand,
  CreativeBrief,
  RenderManifest,
  type Scene,
  type SceneRender,
  type SceneVoiceTrack,
  type TimingAdjustment,
  VideoSpec,
  parseYamlOrJson,
  resolveMaster,
} from "@video-studio/schema";
import { type BackendChoice, type BackendSet, type SynthesizeSpecResult, defaultBackends, selectBackend, synthesizeSpec } from "@video-studio/voice";
import { hyperframesOptions } from "./hyperframes.js";
import { type ValidationIssue, projectSpecPaths, validateSpecFile } from "./spec-validate.js";

type Env = Record<string, string | undefined>;

/** Engine version recorded in manifests. Keep in sync with SERVER_VERSION. */
export const ENGINE_VERSION = "0.1.0";
/** Bump to invalidate assembled masters/reels. */
export const ASSEMBLY_VERSION = 1;

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
  social_copy: string;
  render_manifest: string;
  provenance: string;
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
  master: string;
  reel: string;
  thumbnail: string;
  assembly_key: string;
  qa?: { status: "pass" | "warn" | "fail"; video_sha256: string; checks: Array<{ id: string; status: "pass" | "warn" | "fail"; message?: string }>; findings: QaFinding[] };
  timing_adjustments: TimingAdjustment[];
  warnings: string[];
  tool_versions: Record<string, string>;
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

async function loadBrand(projectDir: string, brandPath?: string): Promise<Brand | undefined> {
  const candidates = brandPath ? [brandPath] : [join(projectDir, "brand.yaml"), join(projectDir, "project", "brand.yaml")];
  for (const p of candidates) {
    if (!(await exists(p))) {
      if (brandPath) throw new Error(`brand file not found: ${brandPath}`);
      continue;
    }
    const parsed = parseYamlOrJson(Brand, await readFile(p, "utf8"));
    if (!parsed.ok) throw new Error(`invalid brand file ${p}: ${parsed.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
    return parsed.data;
  }
  return undefined;
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
  const brand = await loadBrand(root, o.brandPath);
  const tokens: VisualTokens = resolveTokens(brand);
  const burnIn = o.captions?.burn_in ?? spec.captions.burn_in;
  const captionPreset = brand?.video?.caption_preset ?? spec.captions.preset;

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
  const sel = await selectBackend(voiceChoice, env, backends);
  let voice: SynthesizeSpecResult;
  let voiceReason = sel.reason;
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
    if (voiceChoice !== "auto" || sel.backend.id === "silent") {
      throw new Error(`voice backend "${sel.backend.id}" failed: ${errMsg(e)}. Re-run with voice "auto" or "silent", or run doctor.`);
    }
    voiceReason = `${sel.reason}; but ${sel.backend.id} failed at synthesis (${errMsg(e).slice(0, 300)}); falling back to silent (no audio)`;
    voice = await synthesizeSpec(spec, { projectDir: root, backend: "silent", brand: brand ?? null, env, cacheDir: voiceCacheDir, backends, ...(signal ? { signal } : {}) });
  }
  const trackById = new Map(voice.tracks.map((t) => [t.scene_id, t]));
  const hasAudio = voice.tracks.some((t) => t.audio_path);
  const timingSource = [...new Set(voice.tracks.filter((t) => t.words.length).map((t) => t.timing_source))].join("+") || "none";

  // c'. overruns: extend the scene in the render plan only (the spec is untouched)
  const timing_adjustments: TimingAdjustment[] = voice.overruns.map((ov) => ({
    scene_id: ov.scene_id,
    spec_duration_sec: ov.scene_duration_sec,
    render_duration_sec: ov.suggested_duration_sec,
    reason: `voiceover lasts ${ov.audio_duration_sec.toFixed(2)}s, longer than the scene's ${ov.scene_duration_sec}s; extended in the render plan only (edit duration_sec in the spec, or shorten the line, to make it permanent)`,
  }));
  const adjusted = new Map(timing_adjustments.map((a) => [a.scene_id, a.render_duration_sec]));
  const planScenes: Scene[] = spec.scenes.map((s) => (adjusted.has(s.id) ? { ...s, duration_sec: adjusted.get(s.id)! } : s));
  for (const a of timing_adjustments) warnings.push(`timing: ${a.scene_id} extended ${a.spec_duration_sec}s → ${a.render_duration_sec}s to fit the voiceover`);

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
  const baseOpts = {
    project_dir: root,
    dir: scenesDir,
    renderers,
    tokens,
    target,
    placeholder,
    env: env as NodeJS.ProcessEnv,
    ...(signal ? { signal } : {}),
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
  if (placeholders.length) warnings.push(`placeholder cards for ${placeholders.join(", ")} (provider rendering arrives in Phase 4)`);

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
  const placements = planScenes.map((s, i) => {
    const dur = slotMs[i]!;
    const track: SceneVoiceTrack = trackById.get(s.id) ?? { scene_id: s.id, duration_ms: Math.round(dur), words: [], timing_source: "none", provider: "silent" };
    return { scene_start_ms: frameMs(bounds[i]!), track: { ...track, duration_ms: Math.min(track.duration_ms || Math.round(dur), Math.round(dur)) } };
  });
  const totalMs = Math.round(frameMs(bounds[bounds.length - 1]!));
  const words = buildWordTimeline(placements);
  const captionsDir = join(rdir, "captions");
  await rm(captionsDir, { recursive: true, force: true });
  const captionFiles = words.length
    ? await writeCaptionSet(captionsDir, "captions", words, {
        ass: {
          width: target.width,
          height: target.height,
          preset: captionPreset === "bold" ? "bold" : "minimal",
          font: parseFontChain(tokens.font_body)[0] ?? "sans-serif",
          highlight: tokens.color_primary,
        },
      })
    : undefined;
  if (!words.length) warnings.push("no voiceover text: captions and transcript skipped");

  // f. assembly (skipped when the inputs are unchanged)
  const segments = await Promise.all(
    ordered.map(async (e, i) => ({ path: e.out_path!, duration_ms: slotMs[i]!, sha256: await hashFile(e.out_path!) })),
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
      segments: segments.map((s) => ({ sha: s.sha256, ms: s.duration_ms })),
      audio: hasAudio ? slots.map((s) => ({ sha: s.sha256, ms: s.duration_ms })) : null,
      burn,
      ass: burn ? assSha : null,
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
    const audio: AudioSlot[] | undefined = hasAudio ? slots.map((s) => ({ ...(s.abs ? { path: s.abs } : {}), duration_ms: s.duration_ms })) : undefined;
    await assemble(
      {
        width: target.width,
        height: target.height,
        fps: target.fps,
        fit: "pad",
        padColor: tokens.color_background,
        segments: segments.map(({ path, duration_ms }) => ({ path, duration_ms })),
        ...(audio ? { audio, loudness: { I: -14, TP: -1 } } : {}),
        master,
        ...(burn ? { reel, assPath: captionFiles!.ass! } : {}),
      },
      { ...(encodePreset ? { encode: { preset: encodePreset } } : {}), ...(signal ? { signal } : {}) },
    );
    if (!burn) await copyFile(master, reel);
  }

  // g. thumbnail at the hook scene's midpoint (from the clean master)
  const hookIdx = Math.max(0, planScenes.findIndex((s) => s.purpose === "hook"));
  const hookStart = placements[hookIdx]!.scene_start_ms;
  const hookMid = Math.round(hookStart + slotMs[hookIdx]! / 2);
  if (!reuse || !(await exists(thumbnail))) {
    progress({ stage: "thumbnail", message: "extracting thumbnail" });
    await makeThumbnail(master, thumbnail, { atMs: hookMid, ...(signal ? { signal } : {}) });
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
    master: rel(root, master),
    reel: rel(root, reel),
    thumbnail: rel(root, thumbnail),
    assembly_key: assemblyKey,
    ...(reuse && prev?.qa ? { qa: prev.qa } : {}),
    timing_adjustments,
    warnings,
    tool_versions,
  };

  // f'. technical QA on the reel (reused when the reel is unchanged)
  const reelSha = await hashFile(reel);
  let qa: QaOutcome;
  if (state.qa && state.qa.video_sha256 === reelSha && (await exists(join(paths.qa, "report.json")))) {
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

// ------------------------------------------------------------------------------------ QA

const QA_MAP = { ok: "pass", warn: "warn", fail: "fail" } as const;

async function runQaOn(root: string, state: RenderState, reelSha?: string): Promise<QaOutcome> {
  const reel = join(root, state.reel);
  const report: QaReport = await technicalQa(reel, {
    width: state.target.width,
    height: state.target.height,
    duration_s: state.duration_ms / 1000,
    require_audio: true,
  });
  // Relative path in the report so the project folder stays portable.
  report.video = state.reel;
  const files = await writeQaReport(root, report);
  const findings: QaFinding[] = report.checks
    .filter((c) => c.status !== "ok")
    .map((c) => ({ id: c.id, status: c.status as "warn" | "fail", detail: c.detail, ...(c.fix ? { fix: c.fix } : {}) }));
  if (!state.voice.has_audio) {
    for (const f of findings) {
      if (f.id === "silence" || f.id === "loudness") f.detail += " (expected: rendered with the silent voice backend)";
    }
  }
  const status = QA_MAP[report.status];
  state.qa = {
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
export async function exportProject(projectDir: string, opts: { quality?: Quality; now?: () => Date } = {}): Promise<{ quality: Quality; dist: DistFiles; qa_status?: string }> {
  const root = projectPaths(projectDir).root;
  const state = await loadState(root, opts.quality);
  const dist = await exportFromState(root, state, opts.now ?? (() => new Date()));
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
  return [
    "<!-- Generated deterministically from the spec and brief by video-studio. Refine the wording before posting; keep every claim grounded in the sources. -->",
    `# ${title}`,
    "",
    ...lines.slice(0, 3),
    "",
    tags.slice(0, 7).map((t) => `#${t}`).join(" "),
    "",
  ].join("\n");
}

async function exportFromState(root: string, state: RenderState, now: () => Date): Promise<DistFiles> {
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
    provenance: d("provenance.json"),
  };
  await copyFile(join(root, state.reel), out.reel);
  await copyFile(join(root, state.master), out.clean_master);
  await copyFile(join(root, state.thumbnail), out.thumbnail);
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
      voice: { backend: state.voice.backend, timing_source: state.voice.timing_source },
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
    { kind: "final", path: rel(root, out.reel), sha256: await sha(out.reel), ...reelProbe },
    { kind: "clean_master", path: rel(root, out.clean_master), sha256: await sha(out.clean_master), ...reelProbe },
  ];
  if (out.captions_srt) outputs.push({ kind: "captions", path: rel(root, out.captions_srt), sha256: await sha(out.captions_srt) });
  if (out.captions_vtt) outputs.push({ kind: "captions", path: rel(root, out.captions_vtt), sha256: await sha(out.captions_vtt) });
  if (out.transcript) outputs.push({ kind: "other", path: rel(root, out.transcript), sha256: await sha(out.transcript) });
  outputs.push({ kind: "thumbnail", path: rel(root, out.thumbnail), sha256: await sha(out.thumbnail), width: state.target.width, height: state.target.height });
  outputs.push({ kind: "social_copy", path: rel(root, out.social_copy), sha256: await sha(out.social_copy) });
  outputs.push({ kind: "provenance", path: rel(root, out.provenance), sha256: await sha(out.provenance) });

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
    ...(s.placeholder ? { placeholder: true, error: `placeholder: ${s.reason ?? "provider rendering arrives in Phase 4"}` } : {}),
    ...(s.warnings.length ? { warnings: s.warnings } : {}),
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
    ...(captionFiles.length ? { captions: { preset: state.caption_preset, burn_in: state.burn_in, files: captionFiles } } : {}),
    outputs,
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
    ...(state.warnings.length ? { warnings: state.warnings } : {}),
    tool_versions: state.tool_versions,
  };
  const parsed = RenderManifest.safeParse(manifest);
  if (!parsed.success) throw new Error(`internal: render manifest failed schema validation: ${parsed.error.message}`);
  await writeJsonAtomic(out.render_manifest, parsed.data);
  return out;
}

/** Spec for export: parsed without re-running semantic validation (the render already did). */
async function loadSpecLoose(root: string): Promise<{ spec: VideoSpec }> {
  const { spec: specPath } = projectSpecPaths(root);
  const parsed = parseYamlOrJson(VideoSpec, await readFile(specPath, "utf8"));
  if (!parsed.ok) throw new Error(`project/video-spec.json is no longer valid: ${parsed.errors.map((e) => e.message).join("; ")}`);
  return { spec: parsed.data };
}

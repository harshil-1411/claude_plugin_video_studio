/**
 * The render stages behind renderProject (pipeline.ts), in order:
 *
 *   a.  stageInputs          validate the spec; brand, style, tokens, caption settings, bundled fonts
 *   b.  stageTarget          renderer probe → frame size / fps
 *   c.  stageVoice           voice synthesis (+ fallback), c1. whisper alignment
 *   c0. stageSources         footage assets and the music bed
 *   c'. stagePlanTiming      voiceover overruns and beat sync → the render plan's scenes
 *       frameTimeline        slot bounds on frame boundaries
 *       stageNativeTracks    voice.mode native: words from the footage transcripts
 *       resolveWordCues      word cues on the spoken words
 *   d.  stageScenes          scene clips (with the ffmpeg retry)
 *   e.  stageCaptions        word timeline, sound-event cues, caption set
 *   e'. stageSceneAudio      per-scene audio and the music bed's speech/mute spans
 *   f.  stageAssembly        logo overlay, assembly key, clean master + reel
 *   g.  stageCover           cover or thumbnail
 *       stageRenderState     tool versions, fonts, the persisted RenderState
 *
 * QA and export (f'., g'.) stay in pipeline.ts next to runQa/exportProject.
 *
 * Every stage reads the shared {@link RenderRun} and returns its results; the orchestrator
 * (renderProjectLocked) passes them on explicitly. The only shared mutable state is
 * `run.warnings`, which stages append to in pipeline order.
 */
import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, hashFile, projectPaths, readJson, resolveDataDir, sha256Hex, writeJsonAtomic } from "@video-studio/core";
import {
  type AudioSlot,
  type CaptionWord,
  type SpeechInterval,
  assemble,
  buildWordTimeline,
  ffmpegFeatures,
  makeThumbnail,
  toTranscript,
  writeCaptionSet,
} from "@video-studio/media";
import {
  type RendererPreference,
  type RenderTarget,
  type ResolvedCue,
  createFootageRenderer,
  type SceneRenderEntry,
  type SceneRenderer,
  type VisualTokens,
  bundledFontsStatus,
  findFontsDir,
  findStylesDir,
  getStyle,
  styleRef,
  parseFontChain,
  rendererFamily,
  renderScenes,
  resolveTokens,
  selectRenderer,
  prepareLibassFontsDir,
} from "@video-studio/renderer";
import {
  type Brand,
  type Scene,
  type SceneVoiceTrack,
  type TimingAdjustment,
  type VideoSpec,
  type PlatformContract,
  voiceMode,
  cueItemIndexes,
  matchCue,
  type Style,
  type VoiceMode,
} from "@video-studio/schema";
import { layoutZones } from "@video-studio/platforms";
import { type BackendChoice, type BackendSet, type SynthesizeSpecResult, defaultBackends, selectBackend, synthesizeSpec } from "@video-studio/voice";
import { COVER_VERSION, renderCover } from "./cover.js";
import { type ResolvedMusic, resolveMusic } from "./music.js";
import { lockFonts } from "./lock.js";
import { alignVoiceTracks } from "./voice-align.js";
import {
  ASSEMBLY_VERSION,
  DEFAULT_TRANSITION_MS,
  ENGINE_VERSION,
  type Env,
  type Quality,
  type RenderProgress,
  type RenderProjectOptions,
  type RenderState,
  brandRel,
  defaultRenderers,
  errMsg,
  exists,
  fontRequests,
  loadBrand,
  loadTargetContracts,
  loadValidSpec,
  rel,
  renderDir,
  targetFor,
} from "./pipeline-core.js";
import { type FootageResolution, type SceneAudioPlan, beatSyncDurations, buildSceneAudio, planLogo, resolveFootage, transcriptWords } from "./pipeline-media.js";
import { soundEventCues } from "./pipeline-sound-cues.js";

// ------------------------------------------------------------------------------------ run context

/** What every stage of one render shares: the options, resolved once, and the warnings list. */
export interface RenderRun {
  o: RenderProjectOptions;
  env: Env;
  now: () => Date;
  started_at: string;
  quality: Quality;
  preference: RendererPreference;
  voiceChoice: BackendChoice;
  placeholder: boolean;
  progress: (p: RenderProgress) => void;
  paths: ReturnType<typeof projectPaths>;
  /** The project root (paths.root). */
  root: string;
  /** Render warnings, appended by the stages in pipeline order (the RenderState/result keep this array). */
  warnings: string[];
  signal: AbortSignal | undefined;
}

/** Resolve the options into the run context (no I/O). */
export function createRenderRun(projectDir: string, o: RenderProjectOptions): RenderRun {
  const now = o.now ?? (() => new Date());
  const paths = projectPaths(projectDir);
  return {
    o,
    env: o.env ?? process.env,
    now,
    started_at: now().toISOString(),
    quality: o.quality ?? "preview",
    preference: o.renderer ?? "auto",
    voiceChoice: o.voice ?? "auto",
    placeholder: o.placeholder ?? true,
    progress: (p: RenderProgress) => o.onProgress?.(p),
    paths,
    root: paths.root,
    warnings: [],
    signal: o.signal,
  };
}

// ------------------------------------------------------------------------------------ a. validate

export interface RenderInputs {
  spec: VideoSpec;
  irPath: string;
  brandFile: { brand: Brand; path: string } | undefined;
  brand: Brand | undefined;
  style: Style | undefined;
  tokens: VisualTokens;
  burnIn: boolean;
  captionPreset: string;
  /** Caption styling: the style's, overridden field by field by the brand's. */
  brandCaptions: (NonNullable<Style["captions"]> & NonNullable<Brand["captions"]>) | undefined;
  fontsDir: ReturnType<typeof findFontsDir>;
  fonts: ReturnType<typeof bundledFontsStatus>;
}

/** a. Validate the spec, then load what styles the render: brand, style pack, tokens, caption settings, bundled fonts. */
export async function stageInputs(run: RenderRun): Promise<RenderInputs> {
  const { o, env, root, warnings } = run;
  run.progress({ stage: "validate", message: "validating project/video-spec.json" });
  const { spec, warnings: specWarnings, irPath } = await loadValidSpec(root);
  for (const w of specWarnings) warnings.push(`spec: ${w.path || "(root)"}: ${w.message}`);
  const brandFile = await loadBrand(root, o.brandPath);
  const brand = brandFile?.brand;
  // Style pack (styles/<id>.yaml): defaults < style < brand. Unknown ids fail with the available ones.
  const style: Style | undefined = spec.style ? await getStyle(findStylesDir(env), spec.style) : undefined;
  // The spec language picks script fonts (Noto JP/Devanagari/Arabic) ahead of the Latin chain.
  const tokens: VisualTokens = resolveTokens(brand, {}, style, { language: spec.language });
  // brand logo_placement "none": no logo anywhere, not even on the end card.
  if (brand?.visual?.logo_placement?.position === "none") delete tokens.logo_path;
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
  return { spec, irPath, brandFile, brand, style, tokens, burnIn, captionPreset, brandCaptions, fontsDir, fonts };
}

// ------------------------------------------------------------------------------------ b. target

export interface TargetPlan {
  renderers: SceneRenderer[];
  /** The renderer probe for a typography scene; its reason opens the renderer reasons. */
  probe: Awaited<ReturnType<typeof selectRenderer>>;
  target: RenderTarget;
  /** x264 preset for assembly (preview: ultrafast unless overridden). */
  encodePreset: string | undefined;
}

/** b. Probe the preferred renderer (HyperFrames needs 24/30/60 fps), then fix the frame size and fps. */
export async function stageTarget(run: RenderRun, spec: VideoSpec): Promise<TargetPlan> {
  const { o, env, quality, preference } = run;
  const renderers = o.renderers ?? defaultRenderers(env, quality, o.encodePreset);
  const availability = new Map();
  const probe = await selectRenderer("typography", renderers, env as NodeJS.ProcessEnv, preference, availability);
  const hyperframesFirst = probe.renderer ? rendererFamily(probe.renderer) === "hyperframes" : false;
  const target = targetFor(spec, quality, hyperframesFirst, o.target);
  const encodePreset = o.encodePreset ?? (quality === "preview" ? "ultrafast" : undefined);
  run.signal?.throwIfAborted();
  return { renderers, probe, target, encodePreset };
}

// ------------------------------------------------------------------------------------ c. voice

export interface VoiceStage {
  voice: SynthesizeSpecResult;
  /** Why this backend (and any fallback / alignment notes). */
  reason: string;
  mode: VoiceMode;
  narrated: boolean;
  trackById: Map<string, SceneVoiceTrack>;
  hasAudio: boolean;
  /** Word timing sources of the voice tracks (`none` without words); native transcripts override it later. */
  timingSource: string;
}

/**
 * c. Voice: synthesize the narration (auto falls back to system TTS, then silent, if the chosen
 * backend fails at synthesis time), then c1. align estimated word timings with whisper.
 */
export async function stageVoice(run: RenderRun, spec: VideoSpec, brand: Brand | undefined): Promise<VoiceStage> {
  const { o, env, root, signal, voiceChoice, warnings } = run;
  run.progress({ stage: "voice", message: `synthesizing voice (${voiceChoice})` });
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
    voiceReason = `${sel.reason}; but ${sel.backend.id} failed at synthesis (${errMsg(e).slice(0, 300)})`;
    const synth = (backend: BackendChoice) => synthesizeSpec(spec, { projectDir: root, backend, brand: brand ?? null, env, cacheDir: voiceCacheDir, backends, ...(signal ? { signal } : {}) });
    let fallback: SynthesizeSpecResult | undefined;
    // auto's order holds after a synthesis failure too: ElevenLabs → system TTS → silent.
    if (sel.backend.id === "elevenlabs") {
      const a = await Promise.resolve(backends.system.available(env)).catch((err: unknown) => ({ ok: false, reason: errMsg(err) }));
      if (!a.ok) voiceReason += `; system voice unavailable (${a.reason ?? "unknown"})`;
      else {
        try {
          fallback = await synth("system");
          voiceReason += `; fell back to the system voice (${a.reason ?? "available"})`;
        } catch (e2) {
          if (signal?.aborted) throw e2;
          voiceReason += `; system also failed at synthesis (${errMsg(e2).slice(0, 300)})`;
        }
      }
    }
    if (!fallback) {
      voiceReason += "; falling back to silent (no audio)";
      fallback = await synth("silent");
    }
    voice = fallback;
  }
  // c1. exact word timings: whisper listens to estimated tracks (system TTS) when it is installed.
  if (narrated && spec.voice.align !== false && voice.tracks.some((t) => t.timing_source === "estimated" && t.audio_path)) {
    run.progress({ stage: "voice", message: "aligning word timings to the audio" });
    const al = await alignVoiceTracks(voice.tracks, { root, env, cacheDir: join(resolveDataDir(env).cache, "align"), ...(signal ? { signal } : {}) });
    warnings.push(...al.warnings);
    if (al.aligned.length) {
      voice = { ...voice, tracks: al.tracks };
      await writeJsonAtomic(join(root, voice.tracks_path), al.tracks);
      voiceReason += `; word timings aligned to the audio with whisper (${al.aligned.length} scene(s))`;
    } else if (al.skipped) {
      voiceReason += `; word timings estimated (${al.skipped}; with it, captions and cues land exactly)`;
    }
  }
  const trackById = new Map(voice.tracks.map((t) => [t.scene_id, t]));
  const hasAudio = voice.tracks.some((t) => t.audio_path);
  const timingSource = [...new Set(voice.tracks.filter((t) => t.words.length).map((t) => t.timing_source))].join("+") || "none";
  return { voice, reason: voiceReason, mode, narrated, trackById, hasAudio, timingSource };
}

// ------------------------------------------------------------------------------------ c0. footage and music

/** c0. Footage assets (ContentIR → project files) and the music bed. */
export async function stageSources(run: RenderRun, spec: VideoSpec, irPath: string): Promise<{ footage: FootageResolution; music: ResolvedMusic | undefined }> {
  const footage = await resolveFootage(run.root, spec, irPath);
  const music: ResolvedMusic | undefined = spec.audio?.music ? await resolveMusic(spec.audio.music, run.root, run.env) : undefined;
  return { footage, music };
}

// ------------------------------------------------------------------------------------ c'. timing

export interface TimingPlan {
  timing_adjustments: TimingAdjustment[];
  beatSync: RenderState["beat_sync"];
  /** The spec's scenes with render-plan durations (the spec itself is untouched). */
  planScenes: Scene[];
}

/** c'. Overruns extend scenes to fit the voiceover; c''. beat sync moves cuts onto beats. Render plan only. */
export async function stagePlanTiming(
  run: RenderRun,
  spec: VideoSpec,
  voice: SynthesizeSpecResult,
  music: ResolvedMusic | undefined,
  trackById: ReadonlyMap<string, SceneVoiceTrack>,
): Promise<TimingPlan> {
  const { warnings, signal } = run;
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
  return { timing_adjustments, beatSync, planScenes };
}

export interface FrameTimeline {
  /** Cumulative frame index of each scene boundary (scenes + 1 entries, starting at 0). */
  bounds: number[];
  frameMs: (f: number) => number;
  /** Each scene's slot length (ms) between its frame bounds. */
  slotMs: number[];
}

/** Slots sit on frame boundaries of the cumulative timeline, so per-scene rounding never adds frames. */
export function frameTimeline(planScenes: readonly Scene[], fps: number): FrameTimeline {
  const bounds = [0];
  let acc = 0;
  for (const s of planScenes) {
    acc += s.duration_sec;
    bounds.push(Math.round(acc * fps));
  }
  const frameMs = (f: number) => (f * 1000) / fps;
  const slotMs = planScenes.map((_, i) => frameMs(bounds[i + 1]! - bounds[i]!));
  return { bounds, frameMs, slotMs };
}

/** voice.mode native: each footage scene's words come from its asset transcript, shifted onto the scene. */
export async function stageNativeTracks(
  run: RenderRun,
  mode: VoiceMode,
  planScenes: readonly Scene[],
  footage: FootageResolution,
  slotMs: readonly number[],
): Promise<Map<string, SceneVoiceTrack>> {
  const nativeTracks = new Map<string, SceneVoiceTrack>();
  if (mode === "native") {
    for (const [i, s] of planScenes.entries()) {
      const f = footage.byScene.get(s.id);
      if (!s.footage || !f || "error" in f) continue;
      const amode = s.audio?.mode ?? "native";
      if (amode !== "native" && amode !== "mix") continue;
      const words = await transcriptWords(run.root, footage.assets.get(s.footage.asset), s.footage, slotMs[i]!, run.warnings);
      if (words.length) nativeTracks.set(s.id, { scene_id: s.id, duration_ms: Math.round(slotMs[i]!), words, timing_source: "aligned", provider: "native" });
    }
  }
  return nativeTracks;
}

/** Word cues: each scene's cued items land on its spoken words (scene-local times). */
export function resolveWordCues(
  run: RenderRun,
  planScenes: readonly Scene[],
  nativeTracks: ReadonlyMap<string, SceneVoiceTrack>,
  trackById: ReadonlyMap<string, SceneVoiceTrack>,
  slotMs: readonly number[],
): { sceneCues: Map<string, ResolvedCue[]>; cueLog: NonNullable<RenderState["cues"]> } {
  const { warnings } = run;
  const sceneCues = new Map<string, ResolvedCue[]>();
  const cueLog: NonNullable<RenderState["cues"]> = [];
  for (const [i, s] of planScenes.entries()) {
    if (!s.cues?.length || !s.deterministic) continue;
    const track = nativeTracks.get(s.id) ?? trackById.get(s.id);
    const words = track?.words ?? [];
    const items = cueItemIndexes(s.cues);
    const placed: ResolvedCue[] = [];
    s.cues.forEach((c, k) => {
      const at = words.length ? matchCue(words.map((w) => w.word), c) : -1;
      const entry = { scene_id: s.id, word: c.word, item: items[k]! };
      if (at < 0) {
        cueLog.push({ ...entry, status: "unmatched" });
        warnings.push(`cues: ${s.id}: "${c.word}" ${words.length ? "is not in the spoken words" : "has no word timings (silent voice?)"}; item ${items[k]} keeps its default timing`);
        return;
      }
      const atMs = words[at]!.start_ms;
      if (atMs >= slotMs[i]!) {
        cueLog.push({ ...entry, at_ms: atMs, status: "late" });
        warnings.push(`cues: ${s.id}: "${c.word}" is spoken after the scene ends; item ${items[k]} keeps its default timing`);
        return;
      }
      cueLog.push({ ...entry, at_ms: atMs, status: "placed" });
      placed.push({ item: items[k]!, at_s: Math.round(atMs) / 1000 });
    });
    if (placed.length) sceneCues.set(s.id, placed.sort((a, b) => a.at_s - b.at_s || a.item - b.item));
  }
  return { sceneCues, cueLog };
}

// ------------------------------------------------------------------------------------ d. scene clips

export interface ScenesStage {
  /** One entry per plan scene, in order; every one has a clip. */
  ordered: SceneRenderEntry[];
  used: string[];
  placeholders: string[];
  /** Renderer reasons: the probe's, then any ffmpeg retries. */
  reasons: string[];
  sceneStart: Map<string, string>;
  sceneEnd: Map<string, string>;
  contracts: PlatformContract[];
  zones: ReturnType<typeof layoutZones>;
}

/**
 * d. Scene clips: render every plan scene (cached by sidecar keys); with renderer "auto", scenes
 * that fail are retried with ffmpeg. Throws when a scene still has no clip. Also resolves the
 * target contracts and layout zones the scenes (and later captions, logo and cover) use.
 */
export async function stageScenes(
  run: RenderRun,
  input: {
    spec: VideoSpec;
    planScenes: Scene[];
    tokens: VisualTokens;
    target: RenderTarget;
    tp: TargetPlan;
    footage: FootageResolution;
    sceneCues: Map<string, ResolvedCue[]>;
  },
): Promise<ScenesStage> {
  const { o, env, root, quality, preference, placeholder, signal, now, progress, warnings } = run;
  const { spec, planScenes, tokens, target, footage, sceneCues } = input;
  const { renderers, probe } = input.tp;
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
    ...(sceneCues.size ? { cues: sceneCues } : {}),
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
  // Footage that could not be used (audio asset, missing file, ...) says exactly why; only scenes
  // that wait for a video provider get the provider note.
  const footageFailed = new Set(placeholders.filter((id) => { const f = footage.byScene.get(id); return f !== undefined && "error" in f; }));
  for (const e of ordered) if (footageFailed.has(e.scene_id)) warnings.push(`${e.scene_id}: placeholder card instead of footage: ${e.reason ?? "footage not resolved"}`);
  const providerPlaceholders = placeholders.filter((id) => !footageFailed.has(id));
  if (providerPlaceholders.length) warnings.push(`placeholder cards for ${providerPlaceholders.join(", ")} (video providers (generated video, avatars) arrive in Phase 7; until then this is a placeholder card)`);
  return { ordered, used, placeholders, reasons, sceneStart, sceneEnd, contracts, zones };
}

// ------------------------------------------------------------------------------------ e. captions

/** A scene's voice track placed on the video timeline. */
export type ScenePlacement = { scene_start_ms: number; track: SceneVoiceTrack };

export interface CaptionsStage {
  placements: ScenePlacement[];
  totalMs: number;
  /** Spoken words on the video timeline (voiceover or native transcript). */
  words: CaptionWord[];
  /** Sound-event cues added to the captions. */
  cues: CaptionWord[];
  captionSet: Awaited<ReturnType<typeof writeCaptionSet>> | undefined;
  captionFiles: Awaited<ReturnType<typeof writeCaptionSet>>["files"] | undefined;
  /** ASS caption options (also part of the assembly key when burning in). */
  assOpts: CaptionAssOptions;
}

export interface CaptionAssOptions {
  width: number;
  height: number;
  preset: "bold" | "minimal";
  font: string;
  highlight: string;
  box: ReturnType<typeof layoutZones>["caption"];
  positionY?: number;
  bold?: boolean;
  plateOpacity?: number;
  activeWord?: NonNullable<RenderInputs["brandCaptions"]>["active_word"];
  maxLines: number;
}

/** e. Captions from the word timeline, plus sound-event cues, written to renders/<quality>/captions/. */
export async function stageCaptions(
  run: RenderRun,
  input: {
    spec: VideoSpec;
    inputs: RenderInputs;
    target: RenderTarget;
    planScenes: Scene[];
    timeline: FrameTimeline;
    vs: VoiceStage;
    nativeTracks: ReadonlyMap<string, SceneVoiceTrack>;
    footage: FootageResolution;
    music: ResolvedMusic | undefined;
    zones: ReturnType<typeof layoutZones>;
  },
): Promise<CaptionsStage> {
  const { root, quality, warnings, signal, progress } = run;
  const { spec, target, planScenes, nativeTracks, footage, music, zones } = input;
  const { tokens, captionPreset, brandCaptions } = input.inputs;
  const { bounds, frameMs, slotMs } = input.timeline;
  const { trackById, narrated, mode } = input.vs;
  signal?.throwIfAborted();
  progress({ stage: "captions", message: "building captions" });
  const placements = planScenes.map((s, i) => {
    const dur = slotMs[i]!;
    const track: SceneVoiceTrack = nativeTracks.get(s.id) ?? trackById.get(s.id) ?? { scene_id: s.id, duration_ms: Math.round(dur), words: [], timing_source: "none", provider: "silent" };
    return { scene_start_ms: frameMs(bounds[i]!), track: { ...track, duration_ms: Math.min(track.duration_ms || Math.round(dur), Math.round(dur)) } };
  });
  const totalMs = Math.round(frameMs(bounds[bounds.length - 1]!));
  const words = buildWordTimeline(placements);
  const captionsDir = join(renderDir(root, quality), "captions");
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
  // Scenes with burn_captions: false (kinetic text already showing the words) get no burned-in captions.
  const noBurnScenes = new Set(planScenes.filter((s) => s.burn_captions === false).map((s) => s.id));
  const captionSet = captionWords.length
    ? await writeCaptionSet(captionsDir, "captions", captionWords, { ass: assOpts, maxLines: assOpts.maxLines, endMs: totalMs, ...(noBurnScenes.size ? { noBurnScenes } : {}) })
    : undefined;
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
  return { placements, totalMs, words, cues, captionSet, captionFiles, assOpts };
}

// ------------------------------------------------------------------------------------ e'. audio

export interface SceneAudioStage {
  /** Per-scene audio is mixed (voice.mode native, footage or sfx in any scene). */
  useSceneAudio: boolean;
  sceneAudio: SceneAudioPlan | undefined;
  /** The per-scene mix has at least one layer or effect. */
  sceneAudioOn: boolean;
  /** Where the music bed ducks. */
  musicSpeech: SpeechInterval[];
  /** Where the music bed is silent. */
  musicMute: SpeechInterval[];
}

/** e'. Music bed ducking spans; e''. per-scene audio: footage sound (native / mix), crossfades and one-shots. */
export async function stageSceneAudio(
  run: RenderRun,
  input: {
    mode: VoiceMode;
    hasAudio: boolean;
    planScenes: Scene[];
    placements: ScenePlacement[];
    slotMs: number[];
    footage: FootageResolution;
    nativeTracks: ReadonlyMap<string, SceneVoiceTrack>;
  },
): Promise<SceneAudioStage> {
  const { mode, hasAudio, planScenes, placements, slotMs, footage, nativeTracks } = input;
  // e'. music bed (spec.audio.music), ducked where speech plays
  const speech = placements.filter((p) => p.track.audio_path).map((p) => ({ start_ms: Math.round(p.scene_start_ms), end_ms: Math.round(p.scene_start_ms + p.track.duration_ms) }));

  // e''. per-scene audio: footage sound (native / mix), crossfades and one-shots
  const useSceneAudio = mode === "native" || planScenes.some((s) => s.footage || s.sfx?.length);
  const sceneAudio = useSceneAudio ? await buildSceneAudio(run.root, planScenes, placements, slotMs, footage, nativeTracks, run.warnings) : undefined;
  const sceneAudioOn = !!sceneAudio && (sceneAudio.slots.some((sl) => sl.layers.length > 0) || sceneAudio.sfx.length > 0);
  const musicSpeech: SpeechInterval[] = useSceneAudio ? [...(hasAudio ? speech : []), ...sceneAudio!.speech] : hasAudio ? speech : [];
  const musicMute = sceneAudio?.mute ?? [];
  return { useSceneAudio, sceneAudio, sceneAudioOn, musicSpeech, musicMute };
}

// ------------------------------------------------------------------------------------ f. assembly

export interface AssemblyStage {
  segments: Array<{ path: string; duration_ms: number; sha256: string; transition_in?: { kind: string; ms: number } }>;
  /** Captions are burned into the reel. */
  burn: boolean;
  logo: Awaited<ReturnType<typeof planLogo>>;
  assemblyKey: string;
  master: string;
  reel: string;
  thumbnail: string;
  statePath: string;
  /** The previous render state of this quality, if any. */
  prev: RenderState | undefined;
  /** The previous master and reel were reused (the assembly key matched). */
  reuse: boolean;
}

/** f. Assembly: clean master + captioned reel, skipped when the hash of its inputs is unchanged. */
export async function stageAssembly(
  run: RenderRun,
  input: {
    inputs: RenderInputs;
    tp: TargetPlan;
    planScenes: Scene[];
    timeline: FrameTimeline;
    ordered: SceneRenderEntry[];
    zones: ReturnType<typeof layoutZones>;
    hasAudio: boolean;
    music: ResolvedMusic | undefined;
    captions: CaptionsStage;
    audio: SceneAudioStage;
  },
): Promise<AssemblyStage> {
  const { root, quality, signal, progress, warnings } = run;
  const { brand, tokens, burnIn, fontsDir, fonts } = input.inputs;
  const { target, encodePreset } = input.tp;
  const { planScenes, ordered, zones, hasAudio, music } = input;
  const { bounds, frameMs, slotMs } = input.timeline;
  const { placements, captionFiles, assOpts } = input.captions;
  const { useSceneAudio, sceneAudio, sceneAudioOn, musicSpeech, musicMute } = input.audio;
  const rdir = renderDir(root, quality);
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
  const logo = await planLogo(root, brand, tokens, zones, target, planScenes, bounds, frameMs, warnings);
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
      ...(logo ? { logo: { sha: logo.sha256, x: logo.x, y: logo.y, w: logo.w, h: logo.h, ranges: logo.ranges_ms } } : {}),
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
        ...(logo ? { logo } : {}),
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
  return { segments, burn, logo, assemblyKey, master, reel, thumbnail, statePath, prev, reuse };
}

// ------------------------------------------------------------------------------------ g. cover / thumbnail

/**
 * g. Cover (spec.cover: headline frame at the focal time) or thumbnail at the hook scene's
 * midpoint, from the clean master; reused with the assembly when its key is unchanged.
 */
export async function stageCover(
  run: RenderRun,
  input: {
    spec: VideoSpec;
    inputs: RenderInputs;
    planScenes: Scene[];
    placements: ScenePlacement[];
    slotMs: number[];
    zones: ReturnType<typeof layoutZones>;
    contracts: PlatformContract[];
    asm: AssemblyStage;
  },
): Promise<{ thumbnailKey: string; coverState: RenderState["cover"] }> {
  const { root, env, quality, signal, progress, warnings } = run;
  const { spec, planScenes, placements, slotMs, zones, contracts } = input;
  const { tokens, fonts } = input.inputs;
  const { assemblyKey, reuse, prev, thumbnail, master } = input.asm;
  const rdir = renderDir(root, quality);
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
  return { thumbnailKey, coverState };
}

// ------------------------------------------------------------------------------------ render state

/** Tool versions, locked fonts and the RenderState persisted at renders/<quality>/render-state.json (before QA fills `qa`). */
export async function stageRenderState(
  run: RenderRun,
  input: {
    inputs: RenderInputs;
    target: RenderTarget;
    vs: VoiceStage;
    timingSource: string;
    timing: TimingPlan;
    footage: FootageResolution;
    music: ResolvedMusic | undefined;
    cueLog: NonNullable<RenderState["cues"]>;
    scenes: ScenesStage;
    captions: CaptionsStage;
    audio: SceneAudioStage;
    asm: AssemblyStage;
    cover: { thumbnailKey: string; coverState: RenderState["cover"] };
  },
): Promise<RenderState> {
  const { env, root, quality, started_at, preference, voiceChoice, warnings } = run;
  const { spec, irPath, brandFile, style, tokens, fontsDir, captionPreset } = input.inputs;
  const { target, timingSource, footage, music, cueLog } = input;
  const { voice, reason: voiceReason, mode, hasAudio } = input.vs;
  const { timing_adjustments, beatSync } = input.timing;
  const { ordered, used, reasons, sceneStart, sceneEnd } = input.scenes;
  const { totalMs, cues, captionSet, captionFiles, assOpts } = input.captions;
  const { sceneAudio, sceneAudioOn } = input.audio;
  const { segments, burn, logo, assemblyKey, master, reel, thumbnail, prev, reuse } = input.asm;
  const { thumbnailKey, coverState } = input.cover;

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
  return {
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
    ...(cueLog.length ? { cues: cueLog } : {}),
    ...(logo ? { logo: { path: logo.rel, box: { x: logo.x, y: logo.y, w: logo.w, h: logo.h }, scenes: logo.scenes } } : {}),
    background: tokens.color_background,
    ...(music ? { music: { ref: music.ref, sha256: music.sha256, ...(music.title ? { title: music.title } : {}), ...(music.license ? { license: music.license } : {}) } } : {}),
    ...(brandFile ? { brand_path: brandRel(root, brandFile.path) } : {}),
    fonts: lockedFonts,
    ...(style ? { style: styleRef(style) } : {}),
    ...(cues.length ? { sound_events: cues.length } : {}),
  };
}

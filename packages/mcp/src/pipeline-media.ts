/**
 * Render-plan helpers over project media: footage assets and their transcripts, per-scene audio,
 * beat sync against the music bed, and the brand logo overlay. Used by the stages in
 * pipeline-stages.ts.
 */
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { canonicalJson, hashFile, projectPaths, readJson, resolveInsideProject, sha256Hex, writeJsonAtomic } from "@video-studio/core";
import {
  BEAT_ANALYSIS_VERSION,
  type BeatAnalysis,
  type LogoOverlay,
  type OneShot,
  SFX_PEAK_VERSION,
  type SceneAudioSlot,
  type SpeechInterval,
  alignOneShot,
  detectBeats,
  ffprobe,
  measurePeakOffset,
  snapCuts,
} from "@video-studio/media";
import type { RenderTarget, ResolvedFootage, VisualTokens } from "@video-studio/renderer";
import {
  type Brand,
  ContentIR,
  type FootageClip,
  type MediaInfo,
  type Scene,
  type SceneVoiceTrack,
  type TimingAdjustment,
  type VideoSpec,
  type WordTiming,
  parseYamlOrJson,
} from "@video-studio/schema";
import type { layoutZones } from "@video-studio/platforms";
import type { ResolvedMusic } from "./music.js";
import { isBundledSfx, resolveBundledSfx } from "./sfx.js";
import { type RenderState, errMsg, exists, toPosix } from "./pipeline-core.js";

// ------------------------------------------------------------------------------------ footage, scene audio, beat sync

export interface FootageAsset {
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

export interface FootageResolution {
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
  if (a.kind === "audio") throw new Error("is audio; footage needs a video or image asset");
  const abs = await resolveInsideProject(projectPaths(root), a.path);
  if (!(await exists(abs))) throw new Error(`file ${a.path} is missing`);
  const media = a.media ?? (await probeMedia(abs, a.kind));
  return { id, kind: a.kind, rel: toPosix(a.path), abs, sha256: await hashFile(abs), media, ...(a.media?.transcript ? { transcript: a.media.transcript.path } : {}) };
}

/** Resolve every footage scene's asset through source/content-ir.json (project-relative paths only). */
export async function resolveFootage(root: string, spec: VideoSpec, irPath: string): Promise<FootageResolution> {
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
 * Where a clip's own sound comes from and when it plays, given `av_offset_ms` (source time):
 * a negative offset advances the sound (read `-offset` later in the source), a positive one delays
 * it (silence first). `readSec` is the source second heard at the scene start (before the delay).
 */
export function footageAudioShift(clip: FootageClip): { readSec: number; delaySec: number } {
  const shift = (clip.av_offset_ms ?? 0) / 1000;
  return { readSec: clip.in_sec + Math.max(0, -shift), delaySec: Math.max(0, shift) };
}

/**
 * Words of an asset transcript inside a footage clip's span, on the scene's timeline: shifted by
 * `in_sec` (and by `av_offset_ms`, like the clip's sound), divided by `speed`, and cut at the
 * scene end (a looped or held tail has no captions).
 */
export async function transcriptWords(root: string, asset: FootageAsset | undefined, clip: FootageClip, sceneMs: number, warnings: string[]): Promise<WordTiming[]> {
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
  const { readSec, delaySec } = footageAudioShift(clip);
  const inMs = readSec * 1000;
  const endMs = inMs + footageSpanSec(clip, asset.media, sceneMs) * 1000;
  const delayMs = delaySec * 1000;
  const out: WordTiming[] = [];
  for (const w of list) {
    const { word, start_ms, end_ms, speaker } = (w ?? {}) as Partial<WordTiming>;
    if (typeof word !== "string" || !word.trim() || typeof start_ms !== "number" || typeof end_ms !== "number") continue;
    if (start_ms < inMs || start_ms >= endMs) continue;
    const a = Math.round((start_ms - inMs + delayMs) / speed);
    if (a >= sceneMs) continue;
    const b = Math.round(Math.min((Math.min(end_ms, endMs) - inMs + delayMs) / speed, sceneMs));
    out.push({ word: word.trim(), start_ms: a, end_ms: Math.max(a, b), ...(typeof speaker === "string" && speaker ? { speaker } : {}) });
  }
  return out;
}

export interface SceneAudioPlan {
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
 * Peak offset (ms) of a sound effect, measured once per file content: cached as JSON under
 * `cacheDir` keyed by the file hash and SFX_PEAK_VERSION. A file ffmpeg cannot decode is an error
 * naming the file.
 */
export async function sfxPeakMs(abs: string, sha: string, o: { cacheDir?: string; signal?: AbortSignal } = {}): Promise<number> {
  const cacheFile = o.cacheDir ? join(o.cacheDir, `${sha256Hex(canonicalJson({ v: SFX_PEAK_VERSION, sfx: sha }))}.json`) : undefined;
  if (cacheFile && (await exists(cacheFile))) {
    const c = await readJson<{ peak_ms?: unknown }>(cacheFile).catch(() => undefined);
    if (typeof c?.peak_ms === "number" && c.peak_ms >= 0) return c.peak_ms;
  }
  let peak: number;
  try {
    peak = await measurePeakOffset(abs, o.signal ? { signal: o.signal } : {});
  } catch (e) {
    if (o.signal?.aborted) throw e;
    throw new Error(`sfx file ${abs} could not be decoded to find its peak (${errMsg(e)}); re-export it as WAV or M4A`);
  }
  if (cacheFile) await writeJsonAtomic(cacheFile, { peak_ms: peak }).catch(() => undefined);
  return peak;
}

/**
 * Per-scene audio: a narrated scene keeps its voice slot; a footage scene plays its own sound for
 * the same span (`native`, `mix`), shifted by `footage.av_offset_ms`, the bed only (`music`) or
 * nothing (`mute`); crossfades come from `audio.crossfade_ms`; sound effects peak at scene start +
 * `at_sec`. A `bundled:<id>` effect resolves to the plugin's sfx/ catalogue, plays at the
 * catalogue's `default_db` unless `volume_db` is set, and carries the catalogue licence.
 */
export async function buildSceneAudio(
  root: string,
  scenes: readonly Scene[],
  placements: ReadonlyArray<{ scene_start_ms: number; track: SceneVoiceTrack }>,
  slotMs: readonly number[],
  footage: FootageResolution,
  nativeTracks: ReadonlyMap<string, SceneVoiceTrack>,
  warnings: string[],
  opts: { cacheDir?: string; signal?: AbortSignal; /** sfx/ catalogue directory (tests); default: the plugin's. */ sfxDir?: string | null; env?: Record<string, string | undefined> } = {},
): Promise<SceneAudioPlan> {
  const paths = projectPaths(root);
  const peaks = new Map<string, number>();
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
        const { readSec, delaySec } = footageAudioShift(clip);
        const layer = {
          path: f.path,
          offset_sec: readSec,
          ...(delaySec > 0 ? { delay_ms: Math.round(delaySec * 1000) } : {}),
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
      let volumeDb = fx.volume_db;
      let license = fx.license;
      if (isBundledSfx(fx.file)) {
        let b: ReturnType<typeof resolveBundledSfx>;
        try {
          const env = opts.env ?? process.env;
          b = opts.sfxDir === undefined ? resolveBundledSfx(fx.file, env) : resolveBundledSfx(fx.file, env, opts.sfxDir);
        } catch (e) {
          throw new Error(`${s.id}: ${errMsg(e)}`);
        }
        abs = b.path;
        volumeDb ??= b.sound.default_db;
        // A bundled sound is CC0 by construction; a licence in the spec cannot change that.
        license = { ...b.license };
      } else {
        try {
          abs = await resolveInsideProject(paths, fx.file);
        } catch (e) {
          throw new Error(`${s.id}: sfx file "${fx.file}" is not a project-relative path (${errMsg(e)})`);
        }
        if (!(await exists(abs))) throw new Error(`${s.id}: sfx file "${fx.file}" not found in the project`);
      }
      if (fx.at_sec * 1000 >= dur) warnings.push(`${s.id}: sfx ${fx.file} at ${fx.at_sec}s starts after the scene ends (${(dur / 1000).toFixed(2)}s)`);
      const sha = await hashFile(abs);
      let peak = peaks.get(sha);
      if (peak === undefined) {
        peak = await sfxPeakMs(abs, sha, opts);
        peaks.set(sha, peak);
      }
      // The peak, not the file start, lands on at_sec (the head is trimmed at the scene start).
      const { at_ms: at, trim_ms: trim } = alignOneShot(start + fx.at_sec * 1000, peak, start);
      plan.sfx.push({ path: abs, at_ms: at, ...(trim ? { trim_ms: trim } : {}), ...(volumeDb !== undefined ? { volume_db: volumeDb } : {}) });
      keySfx.push({ sha, at, trim, db: volumeDb ?? 0 });
      const rel = isBundledSfx(fx.file) ? fx.file : toPosix(fx.file.replace(/^\.\//, ""));
      const prev = plan.sfxState.find((x) => x.file === rel);
      if (prev) {
        if (!prev.scenes.includes(s.id)) prev.scenes.push(s.id);
        if (!prev.license && license) prev.license = license;
      } else {
        plan.sfxState.push({ file: rel, sha256: sha, scenes: [s.id], ...(license ? { license } : {}), peak_ms: peak });
      }
    }
  }
  plan.key = { slots: keySlots, sfx: keySfx };
  return plan;
}

const BEAT_MIN_SCENE_MS = 500;
/** Beat and bar times kept in the render state (lint and motion scenes read them). */
export const BEAT_TIMES_CAP = 1000;

export interface BeatSyncOptions {
  /** Snap cuts to any beat (default) or to bar starts only. */
  snap?: "beat" | "downbeat";
  /** Where detected analyses are cached, keyed by the bed's hash and BEAT_ANALYSIS_VERSION. */
  cacheDir?: string;
  signal?: AbortSignal;
}

/** Beat analysis of a bed: a synthesized score's exact grid, a cached analysis, or a fresh detection. */
export async function bedBeats(music: ResolvedMusic, o: Pick<BeatSyncOptions, "cacheDir" | "signal"> = {}): Promise<{ analysis: BeatAnalysis; fileMs: number; source: "detected" | "synth" }> {
  if (music.grid) {
    const g = music.grid;
    return { analysis: { bpm: g.bpm, beats_ms: g.beats_ms, downbeats_ms: g.downbeats_ms, onsets_ms: [], confidence: 1 }, fileMs: g.duration_ms, source: "synth" };
  }
  const cacheFile = o.cacheDir ? join(o.cacheDir, `${sha256Hex(canonicalJson({ v: BEAT_ANALYSIS_VERSION, bed: music.sha256 }))}.json`) : undefined;
  let cached: { analysis: BeatAnalysis; fileMs: number } | undefined;
  if (cacheFile && (await exists(cacheFile))) cached = await readJson<{ analysis: BeatAnalysis; fileMs: number }>(cacheFile).catch(() => undefined);
  if (cached?.analysis.analysis_version === BEAT_ANALYSIS_VERSION) return { ...cached, source: "detected" };
  const analysis = await detectBeats(music.path, o.signal ? { signal: o.signal } : {});
  const fileMs = Math.round((await ffprobe(music.path)).duration_s * 1000);
  if (cacheFile) await writeJsonAtomic(cacheFile, { analysis, fileMs }).catch(() => undefined);
  return { analysis, fileMs, source: "detected" };
}

/** Times (ms from the file start) mapped onto the video timeline: shifted by `start_sec`, repeated when the bed loops, inside [0, total]. */
export function bedTimeline(times: readonly number[], fileMs: number, startMs: number, loop: boolean, totalMs: number): number[] {
  const out: number[] = [];
  for (let k = 0; k === 0 || (loop && fileMs > 0 && k * fileMs - startMs <= totalMs); k++) {
    for (const b of times) {
      const t = b + k * fileMs - startMs;
      if (t >= 0 && t <= totalMs) out.push(t);
    }
  }
  return out.sort((a, b) => a - b);
}

/**
 * Snap scene cuts to beats (or, with `snap: "downbeat"`, bar starts) of the music bed, on the
 * video timeline: `start_sec` offset, looped when the bed loops. A synthesized score gives its
 * exact grid; any other bed is detected (cached by its hash). A cut is kept where it was when no
 * beat is within tolerance, or when moving it would cut into a scene's voiceover. Returns timing
 * adjustments for the scenes that changed.
 */
export async function beatSyncDurations(
  scenes: readonly Scene[],
  adjusted: ReadonlyMap<string, number>,
  music: ResolvedMusic,
  toleranceMs: number,
  trackById: ReadonlyMap<string, SceneVoiceTrack>,
  signalOrOptions?: AbortSignal | BeatSyncOptions,
): Promise<{ adjustments: TimingAdjustment[]; summary: NonNullable<RenderState["beat_sync"]>; warning?: string }> {
  const o: BeatSyncOptions = signalOrOptions instanceof AbortSignal ? { signal: signalOrOptions } : (signalOrOptions ?? {});
  const durs = scenes.map((s) => Math.round((adjusted.get(s.id) ?? s.duration_sec) * 1000));
  const total = durs.reduce((a, b) => a + b, 0);
  const { analysis, fileMs, source } = await bedBeats(music, o);
  const summary: NonNullable<RenderState["beat_sync"]> = {
    bpm: analysis.bpm,
    beats: analysis.beats_ms.length,
    moved_cuts: 0,
    source,
    ...(source === "detected" ? { analysis_version: analysis.analysis_version ?? 1 } : {}),
    ...(analysis.alternate_bpm ? { alternate_bpm: analysis.alternate_bpm } : {}),
  };
  if (!analysis.beats_ms.length) return { adjustments: [], summary, warning: `beat_sync: no clear beat found in ${music.ref}; cuts unchanged` };
  const startMs = Math.round((music.bed.start_sec ?? 0) * 1000);
  const loop = music.bed.loop ?? true;
  const beats = bedTimeline(analysis.beats_ms, fileMs, startMs, loop, total);
  const downbeats = bedTimeline(analysis.downbeats_ms ?? [], fileMs, startMs, loop, total);
  summary.beat_times_ms = beats.slice(0, BEAT_TIMES_CAP).map((t) => Math.round(t));
  if (downbeats.length) summary.downbeat_times_ms = downbeats.slice(0, BEAT_TIMES_CAP).map((t) => Math.round(t));
  if (analysis.drop_ms !== undefined) {
    const drop = bedTimeline([analysis.drop_ms], fileMs, startMs, loop, total)[0];
    if (drop !== undefined) summary.drop_ms = Math.round(drop);
  }
  let warning: string | undefined;
  let grid = beats;
  summary.snap = "beat";
  if (o.snap === "downbeat") {
    if (downbeats.length) {
      grid = downbeats;
      summary.snap = "downbeat";
    } else {
      warning = `beat_sync: snap "downbeat" but no bar starts could be read from ${music.ref} (no accented beat 1); snapped to beats instead`;
    }
  }
  const cuts: number[] = [];
  let acc = 0;
  for (const d of durs.slice(0, -1)) cuts.push((acc += d));
  const snapped = snapCuts(cuts, grid, toleranceMs, BEAT_MIN_SCENE_MS);
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
      reason: `beat sync${analysis.bpm ? ` (${analysis.bpm} bpm)` : ""}: ${moved.join(", ")} onto the nearest ${summary.snap === "downbeat" ? "bar start" : "beat"} within ${toleranceMs} ms; render plan only (the spec is unchanged)`,
    });
  });
  return { adjustments, summary, ...(warning ? { warning } : {}) };
}

/** Default logo width as a share of the frame width (brand logo_placement.max_fraction overrides). */
export const LOGO_DEFAULT_FRACTION = 0.12;

/**
 * The brand logo overlay: brand `visual.logo_placement` at a corner puts `visual.logo` in that
 * corner of the content zone (above the caption band for bottom corners) on every scene except end
 * cards, which draw the logo themselves. `end_card_only` (the default) and `none` add no overlay.
 */
export async function planLogo(
  root: string,
  brand: Brand | undefined,
  tokens: VisualTokens,
  zones: ReturnType<typeof layoutZones>,
  target: RenderTarget,
  scenes: readonly Scene[],
  bounds: readonly number[],
  frameMs: (f: number) => number,
  warnings: string[],
): Promise<(LogoOverlay & { sha256: string; rel: string; scenes: string[] }) | undefined> {
  const placement = brand?.visual?.logo_placement;
  const pos = placement?.position;
  if (!pos || pos === "end_card_only" || pos === "none") return undefined;
  if (!tokens.logo_path) {
    warnings.push(`brand: logo_placement "${pos}" but brand visual.logo is not set; no logo drawn`);
    return undefined;
  }
  let abs: string;
  try {
    abs = await resolveInsideProject(projectPaths(root), tokens.logo_path);
  } catch {
    warnings.push(`brand: logo "${tokens.logo_path}" is outside the project; no logo drawn`);
    return undefined;
  }
  if (!(await exists(abs))) {
    warnings.push(`brand: logo file ${tokens.logo_path} is missing; no logo drawn`);
    return undefined;
  }
  const probe = await ffprobe(abs).catch(() => undefined);
  if (!probe?.width || !probe.height) {
    warnings.push(`brand: could not read the logo image ${tokens.logo_path}; no logo drawn`);
    return undefined;
  }
  const c = zones.content;
  const margin = Math.round(Math.min(target.width, target.height) * 0.03);
  let w = Math.round(Math.min((placement?.max_fraction ?? LOGO_DEFAULT_FRACTION) * target.width, c.w * 0.3));
  let h = Math.round((w * probe.height) / probe.width);
  const maxH = Math.round(c.h * 0.12);
  if (h > maxH) {
    w = Math.round((w * maxH) / h);
    h = maxH;
  }
  w -= w % 2;
  h -= h % 2;
  const left = pos.endsWith("left");
  const x = left ? c.x + margin : c.x + c.w - margin - w;
  const bottomEdge = Math.min(c.y + c.h, zones.caption.y);
  const y = pos.startsWith("top") ? c.y + margin : bottomEdge - margin - h;
  const shown: string[] = [];
  const ranges: Array<[number, number]> = [];
  scenes.forEach((s, i) => {
    if (s.deterministic?.kind === "end_card") return;
    shown.push(s.id);
    const a = Math.round(frameMs(bounds[i]!));
    const b = Math.round(frameMs(bounds[i + 1]!));
    const last = ranges[ranges.length - 1];
    if (last && last[1] === a) last[1] = b;
    else ranges.push([a, b]);
  });
  return { path: abs, rel: toPosix(relative(root, abs)), sha256: await hashFile(abs), x, y, w, h, ranges_ms: ranges, scenes: shown };
}

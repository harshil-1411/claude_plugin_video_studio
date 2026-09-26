import { rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, ensureDir, readJson, sha256Hex, writeJsonAtomic } from "@video-studio/core";
import type { LayoutZones } from "@video-studio/platforms";
import type { DeterministicKind, Scene, TextBox, VideoSpec } from "@video-studio/schema";
import type { Availability, RenderTarget, ResolvedCue, SceneRenderRequest, SceneRenderer, VisualTokens } from "./types.js";
import { createFootageRenderer } from "./footage.js";
import { LAYOUT_VERSION } from "./text-layout.js";

export type RendererPreference = "auto" | "hyperframes" | "ffmpeg";

export type RendererFamily = "hyperframes" | "ffmpeg" | "other";

export function rendererFamily(r: Pick<SceneRenderer, "id">): RendererFamily {
  if (r.id.startsWith("hyperframes")) return "hyperframes";
  if (r.id.startsWith("ffmpeg")) return "ffmpeg";
  return "other";
}

export interface Selection {
  renderer: SceneRenderer | null;
  reason: string;
}

/** Availability results per renderer, shared across calls within one render pass. */
export type AvailabilityCache = Map<SceneRenderer, Promise<Availability>>;

function availabilityOf(r: SceneRenderer, env: NodeJS.ProcessEnv, cache?: AvailabilityCache): Promise<Availability> {
  let p = cache?.get(r);
  if (!p) {
    p = r.available(env).catch((err: unknown) => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }));
    cache?.set(r, p);
  }
  return p;
}

/**
 * First available renderer that can draw `kind`. The preferred family is tried first
 * (`auto` = HyperFrames, then FFmpeg, then anything else), then the remaining renderers in
 * the given order; the reason says when and why a fallback was used.
 */
export async function selectRenderer(
  kind: DeterministicKind,
  renderers: readonly SceneRenderer[],
  env: NodeJS.ProcessEnv = process.env,
  preference: RendererPreference = "auto",
  cache?: AvailabilityCache,
): Promise<Selection> {
  const preferred: RendererFamily = preference === "ffmpeg" ? "ffmpeg" : "hyperframes";
  const rank = (r: SceneRenderer) => {
    const fam = rendererFamily(r);
    if (fam === preferred) return 0;
    if (preference === "auto" && fam === "ffmpeg") return 1;
    return 2;
  };
  const ordered = renderers.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
  const skipped: string[] = [];
  for (const r of ordered) {
    if (!r.kinds.includes(kind)) {
      skipped.push(`${r.id} does not draw "${kind}"`);
      continue;
    }
    const a = await availabilityOf(r, env, cache);
    if (!a.ok) {
      skipped.push(`${r.id} unavailable${a.reason ? ` (${a.reason})` : ""}`);
      continue;
    }
    const fam = rendererFamily(r);
    const base = preference === "auto" ? `auto: ${r.id}` : fam === preference ? `preferred ${preference}: ${r.id}` : `fallback from ${preference}: ${r.id}`;
    return { renderer: r, reason: skipped.length ? `${base}; skipped ${skipped.join("; ")}` : base };
  }
  return {
    renderer: null,
    reason: renderers.length === 0 ? "no renderers registered" : `no available renderer draws "${kind}": ${skipped.join("; ")}`,
  };
}

// ---------------------------------------------------------------------------------- renderScenes

export type SceneStatus = "rendered" | "cached" | "pending" | "failed";

export interface SceneRenderEntry {
  scene_id: string;
  status: SceneStatus;
  /** Clip path (rendered, cached, or a placeholder for a pending scene). */
  out_path?: string;
  renderer?: string;
  renderer_version?: string;
  cache_key?: string;
  duration_ms?: number;
  /** True when the clip is a titled stand-in for a scene a provider must still render. */
  placeholder?: boolean;
  /** True when an existing clip was reused (sidecar cache key matched). */
  from_cache?: boolean;
  reason?: string;
  warnings: string[];
  /** Text the renderer drew (from the sidecar when cached). */
  text_boxes?: TextBox[];
}

export interface RenderScenesOptions {
  project_dir: string;
  /** Clip directory. Default `<project>/renders/scenes`. */
  dir?: string;
  renderers: readonly SceneRenderer[];
  tokens: VisualTokens;
  target: RenderTarget;
  /** Layout zones for the enabled platform targets; part of the cache key when given. */
  zones?: LayoutZones;
  preference?: RendererPreference;
  /** Scenes rendered in parallel. Default 1 (low-RAM machines). */
  concurrency?: number;
  /** Render titled stand-in cards for non-deterministic scenes so a full cut can be assembled. */
  placeholder?: boolean;
  /** Only these scene ids. */
  only?: readonly string[];
  /** Ignore cached clips. */
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onScene?: (entry: SceneRenderEntry) => void;
  /**
   * Resolved footage per scene id, for scenes with `footage`: the asset file, its hash and probe,
   * or why it could not be resolved (such scenes become placeholders with that reason).
   */
  footage?: ReadonlyMap<string, ResolvedFootage | { error: string }>;
  /** Renderer for footage scenes. Default: a new {@link createFootageRenderer}. */
  footageRenderer?: SceneRenderer;
  /** Word cues per scene id, resolved against the spoken words (see `SceneRenderRequest.cues`). */
  cues?: ReadonlyMap<string, ResolvedCue[]>;
}

export type ResolvedFootage = NonNullable<SceneRenderRequest["footage"]>;

export interface RenderScenesResult {
  scenes: SceneRenderEntry[];
  dir: string;
}

/** Sidecar written next to each clip (`<scene_id>.json`). */
export interface SceneSidecar {
  scene_id: string;
  cache_key: string;
  renderer: string;
  renderer_version: string;
  duration_ms: number;
  placeholder: boolean;
  warnings: string[];
  text_boxes?: TextBox[];
}

export const PENDING_REASON = "video providers (generated video, avatars) arrive in Phase 7; until then this is a placeholder card";

/** Cache key of a scene clip: scene canonical JSON + tokens + target (+ zones) + renderer id/version. */
export function sceneCacheKey(
  scene: Scene,
  tokens: VisualTokens,
  target: RenderTarget,
  renderer: Pick<SceneRenderer, "id" | "version">,
  placeholder = false,
  zones?: LayoutZones,
  footage?: { sha256: string; duration_sec?: number; content_box?: { x: number; y: number; w: number; h: number } },
  cues?: readonly ResolvedCue[],
): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      layout: LAYOUT_VERSION,
      scene,
      tokens,
      target,
      ...(zones ? { zones } : {}),
      renderer: { id: renderer.id, version: renderer.version },
      placeholder,
      // The footage params (in/out, fit, focus, speed, loop) are in `scene.footage`; the file is keyed by its hash.
      ...(footage ? { footage } : {}),
      // Cue times move with the voice, so a re-voiced scene re-renders; absent keeps old keys.
      ...(cues?.length ? { cues } : {}),
    }),
  );
}

/** The picture of a scene: for a cutaway (`footage.cutaway` with a graphic), the graphic alone. */
export function cutawayPicture(scene: Scene): Scene {
  if (!scene.footage?.cutaway || !scene.deterministic) return scene;
  const { footage: _clip, ...rest } = scene;
  return { ...rest, visual_strategy: "motion_graphic" };
}

/** The motion-graphic stand-in drawn for a scene that a provider must render. */
export function placeholderScene(scene: Scene): Scene {
  const vr = scene.visual_requirements;
  const firstSentence = scene.voiceover.split(/(?<=[.!?])\s/)[0]?.trim();
  const title = vr.subject?.trim() || scene.on_screen_text?.trim() || firstSentence || `Scene ${scene.id}`;
  return {
    ...scene,
    visual_strategy: "motion_graphic",
    deterministic: { kind: "end_card", props: { title, subtitle: `placeholder · ${scene.visual_strategy.replace(/_/g, " ")}` } },
  };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function readSidecar(p: string): Promise<SceneSidecar | null> {
  try {
    return await readJson<SceneSidecar>(p);
  } catch {
    return null;
  }
}

/**
 * Render every motion_graphic scene of `spec` to `<project>/renders/scenes/<scene_id>.mp4`,
 * reusing a clip when its sidecar's cache key matches. Other visual strategies come back
 * `pending` (or as a placeholder card with `placeholder: true`). Failures are reported per
 * scene, never thrown, except for an abort.
 */
export async function renderScenes(spec: Pick<VideoSpec, "scenes">, o: RenderScenesOptions): Promise<RenderScenesResult> {
  const dir = o.dir ?? join(o.project_dir, "renders", "scenes");
  await ensureDir(dir);
  const env = o.env ?? process.env;
  const cache: AvailabilityCache = new Map();
  const scenes = o.only ? spec.scenes.filter((s) => o.only!.includes(s.id)) : spec.scenes;
  const results: SceneRenderEntry[] = new Array(scenes.length);

  let footageRenderer: SceneRenderer | undefined = o.footageRenderer;
  const renderOne = async (given: Scene): Promise<SceneRenderEntry> => {
    // A cutaway draws its graphic instead of the footage (the clip only supplies sound and words),
    // so its picture renders, and is cached, like a plain motion-graphic scene.
    const orig = cutawayPicture(given);
    // Footage scenes render from the asset (any strategy); unresolved footage becomes a placeholder.
    const fr = orig.footage ? o.footage?.get(orig.id) : undefined;
    const footage = fr && !("error" in fr) ? fr : undefined;
    const footageError = orig.footage && !footage ? `footage asset "${orig.footage.asset}": ${fr && "error" in fr ? fr.error : "not resolved"}` : undefined;
    const deterministic = !orig.footage && orig.visual_strategy === "motion_graphic" && orig.deterministic !== undefined;
    const pendingReason = footageError ?? `${orig.visual_strategy}: ${PENDING_REASON}`;
    if (!footage && !deterministic && !o.placeholder) {
      const reason = footageError ?? (orig.visual_strategy === "motion_graphic" ? "motion_graphic scene has no deterministic {kind, props}" : pendingReason);
      return { scene_id: orig.id, status: "pending", reason, warnings: [] };
    }
    const placeholder = !footage && !deterministic;
    const scene = placeholder ? placeholderScene(orig) : orig;
    let r: SceneRenderer;
    let selReason: string;
    if (footage) {
      footageRenderer ??= createFootageRenderer();
      r = footageRenderer;
      selReason = `footage: ${r.id}`;
    } else {
      const sel = await selectRenderer(scene.deterministic!.kind, o.renderers, env, placeholder ? "ffmpeg" : (o.preference ?? "auto"), cache);
      if (!sel.renderer) {
        return { scene_id: orig.id, status: placeholder ? "pending" : "failed", reason: placeholder && footageError ? `${footageError}; ${sel.reason}` : sel.reason, warnings: [] };
      }
      r = sel.renderer;
      selReason = sel.reason;
    }
    const cues = placeholder ? undefined : o.cues?.get(orig.id);
    const key = sceneCacheKey(scene, o.tokens, o.target, r, placeholder, o.zones, footage ? { sha256: footage.sha256, duration_sec: footage.media.duration_sec, ...(footage.media.content_box ? { content_box: footage.media.content_box } : {}) } : undefined, cues);
    const out = join(dir, `${orig.id}.mp4`);
    const sidecarPath = join(dir, `${orig.id}.json`);
    const base = { scene_id: orig.id, renderer: r.id, renderer_version: r.version, cache_key: key, ...(placeholder ? { placeholder: true, reason: pendingReason } : {}) };
    if (!o.force) {
      const sc = await readSidecar(sidecarPath);
      if (sc && sc.cache_key === key && (await fileExists(out))) {
        return {
          ...base,
          status: placeholder ? "pending" : "cached",
          from_cache: true,
          out_path: out,
          duration_ms: sc.duration_ms,
          warnings: sc.warnings,
          ...(sc.text_boxes ? { text_boxes: sc.text_boxes } : {}),
        };
      }
    }
    const tmp = join(dir, `.${orig.id}.${process.pid}.tmp.mp4`);
    try {
      const res = await r.render(
        { scene, target: o.target, tokens: o.tokens, out_path: tmp, project_dir: o.project_dir, ...(o.zones ? { zones: o.zones } : {}), ...(footage ? { footage } : {}), ...(cues?.length ? { cues } : {}) },
        { signal: o.signal },
      );
      await rename(tmp, out);
      const sidecar: SceneSidecar = {
        scene_id: orig.id,
        cache_key: key,
        renderer: res.renderer,
        renderer_version: res.renderer_version,
        duration_ms: res.duration_ms,
        placeholder,
        warnings: res.warnings,
        ...(res.text_boxes ? { text_boxes: res.text_boxes } : {}),
      };
      await writeJsonAtomic(sidecarPath, sidecar);
      return {
        ...base,
        status: placeholder ? "pending" : "rendered",
        out_path: out,
        duration_ms: res.duration_ms,
        warnings: res.warnings,
        ...(res.text_boxes ? { text_boxes: res.text_boxes } : {}),
      };
    } catch (err) {
      await rm(tmp, { force: true });
      if (o.signal?.aborted) throw err;
      return { ...base, status: "failed", reason: `${selReason}; render failed: ${err instanceof Error ? err.message : String(err)}`, warnings: [] };
    }
  };

  let next = 0;
  const worker = async () => {
    while (next < scenes.length) {
      const i = next++;
      const entry = await renderOne(scenes[i]!);
      results[i] = entry;
      o.onScene?.(entry);
    }
  };
  const n = Math.max(1, Math.min(o.concurrency ?? 1, scenes.length));
  await Promise.all(Array.from({ length: n }, worker));
  return { scenes: results, dir };
}

import type { LayoutZones } from "@video-studio/platforms";
import type { AspectRatio, Brand, MediaInfo, Scene, TextBox } from "@video-studio/schema";

/**
 * Renders deterministic (motion_graphic) scenes to silent video clips.
 * Voice, captions and assembly happen later in @video-studio/media; a
 * renderer only produces one clip per scene at the exact scene duration.
 */
export interface RenderTarget {
  width: number;
  height: number;
  fps: number;
  aspect_ratio: AspectRatio;
}

/** Resolved visual tokens (brand values or defaults). Renderers must use these exactly. */
export interface VisualTokens {
  font_heading: string;
  font_body: string;
  font_mono: string;
  color_background: string;
  color_text: string;
  color_primary: string;
  color_secondary: string;
  logo_path?: string;
  // ---- style pack / brand v2 (all optional: absent means the renderer's defaults)
  /** Style pack the tokens came from, `<id>@<version>`; part of the scene cache key. */
  style?: string;
  weight_heading?: number;
  weight_body?: number;
  text_case?: "as_is" | "upper" | "title";
  /** Multiplier on the heading size the layout picks. */
  heading_scale?: number;
  text_align?: "center" | "left";
  motion?: MotionTokens;
  /**
   * Spec language (BCP-47), set only for languages written in a non-Latin script (see
   * `withLanguage`): HyperFrames uses it for `lang`/`dir`, both renderers for script fonts.
   * Without it, renderers detect the script from the text itself.
   */
  language?: string;
  /**
   * Font files from the project's own `fonts/` folder that the chains name (see
   * `withProjectFonts`), with their hashes: part of every cache key that takes the tokens, so a
   * replaced font file re-renders. Absent without project fonts, so other keys do not move.
   */
  project_fonts?: ProjectFontRef[];
}

/** A project font file a chain family resolves to (project-relative path and hash). */
export interface ProjectFontRef {
  /** The family name the chains use for it: the internal name or the folder name (alias). */
  name: string;
  /** Internal family (name table nameID 16, else 1): what libass and fontconfig match. */
  family: string;
  weight: number;
  italic: boolean;
  /** Project-relative posix path, e.g. `fonts/FieldSans/FieldSans-Regular.ttf`. */
  file: string;
  sha256: string;
}

/** Resolved motion tokens (style pack, overridden by brand.motion). */
export interface MotionTokens {
  personality: "calm" | "precise" | "friendly" | "energetic" | "playful";
  easing: "linear" | "ease_out" | "ease_in_out" | "spring" | "snap";
  enter_ms: number;
  exit_ms: number;
  stagger_ms: number;
  transition: "cut" | "crossfade" | "fade_black" | "slide" | "zoom" | "whip";
  transition_ms: number;
}

export interface SceneRenderRequest {
  scene: Scene;
  target: RenderTarget;
  tokens: VisualTokens;
  /** Absolute output path (.mp4, H.264, no audio). */
  out_path: string;
  /** Absolute project dir, for resolving scene asset paths (screenshots, logo). */
  project_dir: string;
  /** Layout zones for the enabled platform targets. Absent: the renderer's built-in safe area. */
  zones?: LayoutZones;
  /** Resolved footage for scenes with `footage` (absolute path, hash and probe of the asset). */
  footage?: { path: string; sha256: string; media: MediaInfo };
  /**
   * Word cues resolved to scene-local times (`scene.cues` matched against the spoken words), sorted
   * by `at_s`. Item indexes follow `cueItems(kind, props)` from @video-studio/schema. A cued item's
   * entrance settles on `at_s`; uncued items keep the default stagger but never enter before an
   * earlier item's cue. Absent or empty: the default timing, byte-identical to before.
   */
  cues?: ResolvedCue[];
  /**
   * The music bed's beat grid inside this scene (scene-local seconds, sorted), when the render has
   * one. `motion` pages read it as `window.__vs.beats` / `downbeats`; other kinds ignore it.
   */
  beats?: SceneBeats;
  /**
   * The music bed's envelope under this scene (scene-local frames), when the render has a bed and
   * the scene is a `motion` page: `window.__vs.audio`, read by `vs.energy` / `vs.bass` / `vs.onset`.
   * Other kinds ignore it.
   */
  audio?: SceneAudioEnvelope;
  /**
   * Motion blur for a `motion` scene (final renders only): sub-frames the producer averages per
   * output frame. Absent: a plain render. Other kinds ignore it.
   */
  motion_blur?: { subframes: number };
}

/**
 * The music bed's per-frame envelope inside one scene (media envelope.ts): frame `k` of the scene
 * is byte `k` of each curve; each value is 0..255 (0..1 of the bed's 98th percentile). Base64, so
 * the page stays small (4 characters per 3 frames per curve).
 */
export interface SceneAudioEnvelope {
  fps: number;
  rms: string;
  low: string;
  onset: string;
}

/** Beat and downbeat times inside one scene, in scene-local seconds. */
export interface SceneBeats {
  beats_s: number[];
  downbeats_s: number[];
}

/** One `scene.cues` entry placed on the scene timeline. */
export interface ResolvedCue {
  /** Reveal item index (`cueItems`). */
  item: number;
  /** Scene-local seconds at which the word starts. */
  at_s: number;
}

export interface SceneRenderResult {
  scene_id: string;
  out_path: string;
  duration_ms: number;
  renderer: string;
  renderer_version: string;
  /** Any props the renderer could not honour, surfaced to QA. */
  warnings: string[];
  /** Every text block drawn, in output pixels, for lint (overflow, mask collisions, contrast). */
  text_boxes?: TextBox[];
}

export interface Availability {
  ok: boolean;
  reason?: string;
}

export interface SceneRenderer {
  readonly id: string;
  readonly version: string;
  /** Deterministic kinds this renderer can draw. */
  readonly kinds: ReadonlyArray<NonNullable<Scene["deterministic"]>["kind"]>;
  available(env: NodeJS.ProcessEnv): Promise<Availability>;
  render(req: SceneRenderRequest, opts?: { signal?: AbortSignal }): Promise<SceneRenderResult>;
}

export type { Brand, LayoutZones, TextBox };

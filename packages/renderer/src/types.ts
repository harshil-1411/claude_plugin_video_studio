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

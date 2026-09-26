import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { projectPaths, resolveInsideProject } from "@video-studio/core";
import { type SubjectDetector, suggestFocusTrack } from "@video-studio/media";
import type { FocusKeyframe } from "@video-studio/schema";
import { TranscribeError, findMediaAsset, loadContentIr } from "./transcribe.js";

/**
 * footage_focus: suggest a `footage.focus_track` (subject-aware reframing) for a span of an
 * ingested video. On macOS it samples frames and finds the speaker's face (or the most salient
 * object) with Apple Vision; elsewhere it says so and points Claude at the by-eye path.
 * Read-only: nothing in the project is written.
 */

export const FOCUS_DEFAULT_FPS = 2;
export const FOCUS_MAX_FPS = 8;
/** Longest span analysed in one call (seconds). */
export const FOCUS_MAX_SPAN_SEC = 600;

export interface FootageFocusOptions {
  asset: string;
  in_sec: number;
  /** Default: in_sec + 30 s (clamped to the asset's end). */
  out_sec?: number;
  fps?: number;
  signal?: AbortSignal;
  /** Tests: inject a detector instead of macOS Vision. */
  detector?: SubjectDetector;
}

export interface FootageFocusResult {
  asset: string;
  in_sec: number;
  out_sec: number;
  /** Keyframes for footage.focus_track (t from in_sec; x, y = subject centre in the source frame). Empty when nothing was found. */
  focus_track: FocusKeyframe[];
  method: "vision" | "unavailable";
  frames_checked: number;
  detections: { faces: number; salient: number; missed: number };
  notes: string[];
}

const BY_EYE =
  "mark it by eye instead: look at frames of the span (footage_look, or review crops of a render), note where the subject's centre is at each change (x, y as fractions of the source frame, t in seconds from in_sec) and write footage.focus_track by hand; then check with review strips";

export async function footageFocus(projectDir: string, opts: FootageFocusOptions): Promise<FootageFocusResult> {
  const root = resolve(projectDir);
  const { ir } = await loadContentIr(root);
  const asset = findMediaAsset(ir, opts.asset);
  const media = asset.media;
  if (asset.kind !== "video" || !media?.has_video) throw new TranscribeError(`asset ${asset.id} has no video to reframe`, "pass a video asset id");
  let file: string;
  try {
    file = await resolveInsideProject(projectPaths(root), asset.path);
  } catch {
    throw new TranscribeError(`asset ${asset.id} path ${asset.path} is outside the project`, "re-ingest the video file");
  }
  if (!existsSync(file)) throw new TranscribeError(`asset file not found: ${asset.path}`, "re-ingest the video file (it was moved or deleted)");

  const notes: string[] = [];
  const duration = media.duration_sec;
  const from = opts.in_sec;
  if (!(from >= 0) || from >= duration) throw new TranscribeError(`in_sec ${from} is outside ${asset.id} (0–${duration} s)`);
  let to = Math.min(opts.out_sec ?? from + 30, duration);
  if (!(to > from)) throw new TranscribeError(`out_sec ${opts.out_sec} must be after in_sec ${from}`);
  if (to - from > FOCUS_MAX_SPAN_SEC) {
    to = from + FOCUS_MAX_SPAN_SEC;
    notes.push(`analysed the first ${FOCUS_MAX_SPAN_SEC} s only; call again for the rest`);
  }
  const fps = Math.min(FOCUS_MAX_FPS, Math.max(0.2, opts.fps ?? FOCUS_DEFAULT_FPS));
  if (media.width && media.height && media.height >= media.width) {
    notes.push("the source is already portrait or square: a 9:16 cover crop barely moves sideways, so a track matters little");
  }

  const r = await suggestFocusTrack(file, {
    from,
    to,
    fps,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.detector ? { detector: opts.detector } : {}),
  });
  notes.push(...r.notes);
  if (r.method === "unavailable") notes.push(`automatic detection is unavailable; ${BY_EYE}`);
  else if (!r.keys.length) notes.push(`nothing to follow was found; ${BY_EYE}`);
  else notes.push('paste focus_track into the scene\'s footage (fit "cover", same in_sec), render, and check the crop with review strips; lint warns (subject_near_edge) when the subject gets close to the crop edge');
  return {
    asset: asset.id,
    in_sec: from,
    out_sec: Math.round(to * 1000) / 1000,
    focus_track: r.keys,
    method: r.method,
    frames_checked: r.frames_checked,
    detections: r.detections,
    notes,
  };
}

/** Compact text for the tool result. */
export function formatFootageFocus(r: FootageFocusResult): string {
  const head =
    r.method === "unavailable"
      ? `footage_focus ${r.asset} ${r.in_sec}–${r.out_sec}s: detection unavailable`
      : `footage_focus ${r.asset} ${r.in_sec}–${r.out_sec}s: ${r.focus_track.length} keyframe(s) from ${r.frames_checked} frame(s) (faces ${r.detections.faces}, salient ${r.detections.salient}, missed ${r.detections.missed})`;
  return [head, ...r.notes.map((n) => `- ${n}`), ...(r.focus_track.length ? [`focus_track: ${JSON.stringify(r.focus_track)}`] : [])].join("\n");
}

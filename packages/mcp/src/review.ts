import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { projectPaths } from "@video-studio/core";
import { escapeFilterOption, escapeFilterPath, escapeFiltergraph, runFfmpeg } from "@video-studio/media";
import { findFontsDir } from "@video-studio/renderer";
import { type Quality, resolveRender } from "./golden.js";

/**
 * review: images of a finished render for Claude to look at before handing it over. A contact
 * sheet (each scene's opening, middle and closing frame), a strip (every frame of a stretch, for
 * motion, transitions and word cues) or crops (full-resolution detail of one region). Each tile is
 * labelled with its scene and time. Read-only apart from qa/review/.
 */

export type ReviewMode = "sheet" | "strip" | "crop";

export interface ReviewOptions {
  quality?: Quality;
  /** sheet (default): every scene's in/mid/out frames; strip: every frame in a span; crop: a region at chosen times. */
  mode?: ReviewMode;
  /** Scene to review: sheet and crop sample only it, strip covers its whole span. */
  scene?: string;
  /** Exact times (s) instead of the defaults (sheet, crop). */
  times?: number[];
  /** Strip span in seconds (default: the scene's span, else the first 2 s). */
  from_sec?: number;
  to_sec?: number;
  /** Crop region as fractions of the frame (0–1). Required for mode crop. */
  crop?: { x: number; y: number; w: number; h: number };
  /** Tile width in px (default: sheet 240, strip 180, crop 540). */
  width?: number;
  cols?: number;
}

export interface ReviewTile {
  index: number;
  time_sec: number;
  scene_id?: string;
  label: string;
}

export interface ReviewResult {
  quality?: Quality;
  source: string;
  mode: ReviewMode;
  /** Absolute path of the JPEG. */
  image: string;
  /** Project-relative path of the JPEG. */
  image_rel: string;
  cols: number;
  rows: number;
  tile_width: number;
  /** Tiles in reading order (left to right, top to bottom). */
  tiles: ReviewTile[];
  notes: string[];
}

/** Largest number of tiles in one image (keeps it readable and fast). */
export const REVIEW_MAX_TILES = 48;
const DEFAULT_WIDTH: Record<ReviewMode, number> = { sheet: 240, strip: 180, crop: 540 };
const DEFAULT_COLS: Record<ReviewMode, number> = { sheet: 6, strip: 8, crop: 2 };

interface Span {
  id: string;
  start: number;
  end: number;
}

export async function reviewRender(projectDir: string, opts: ReviewOptions = {}): Promise<ReviewResult> {
  const mode = opts.mode ?? "sheet";
  const r = await resolveRender(projectDir, opts.quality);
  const fps = r.fps;
  const frame = 1 / fps;
  const dur = r.duration_ms / 1000;
  const lastT = Math.max(0, dur - frame);
  const notes: string[] = [];

  let t = 0;
  const spans: Span[] = (r.state?.scenes ?? []).map((s) => {
    const span = { id: s.scene_id, start: t, end: t + s.duration_ms / 1000 };
    t = span.end;
    return span;
  });
  const sceneAt = (x: number) => spans.find((s) => x >= s.start && x < s.end)?.id ?? spans[spans.length - 1]?.id;
  let only: Span | undefined;
  if (opts.scene) {
    only = spans.find((s) => s.id === opts.scene);
    if (!only) throw new Error(`no scene "${opts.scene}" in this render (scenes: ${spans.map((s) => s.id).join(", ") || "unknown: no render state"})`);
  }
  const clamp = (x: number) => Math.min(lastT, Math.max(0, x));
  const round3 = (x: number) => Math.round(x * 1000) / 1000;

  let tiles: Array<{ time: number; tag?: string }>;
  if (opts.times?.length) {
    tiles = opts.times.map((x) => ({ time: clamp(x) }));
  } else if (mode === "strip") {
    // Whole frames only: the first frame at or after the start, the last one before the end.
    const a = clamp(opts.from_sec ?? only?.start ?? 0);
    const b = clamp(opts.to_sec ?? (only ? only.end - 1e-6 : a + 2));
    if (b < a) throw new Error(`strip: to_sec ${b} is before from_sec ${a}`);
    const fa = Math.ceil(a * fps - 1e-6);
    const fb = Math.max(fa, Math.floor(b * fps + 1e-6));
    const n = fb - fa + 1;
    const take = Math.min(n, REVIEW_MAX_TILES);
    if (take < n) notes.push(`${n} frames in ${round3(a)}–${round3(b)}s; showing ${take} evenly spaced (narrow the span for every frame)`);
    tiles = Array.from({ length: take }, (_, i) => ({ time: (fa + (take === 1 ? 0 : Math.round((i * (n - 1)) / (take - 1)))) / fps }));
  } else {
    // Opening frame a little after the cut (past most transitions), the middle, and the settled end
    // state just before the exit fade (the very last frame is often already faded out).
    const list = only ? [only] : spans;
    if (!list.length) {
      tiles = [0.25, 0.5, 0.75].map((f) => ({ time: clamp(dur * f) }));
      notes.push("no render state with scene timings: sampled 25%, 50% and 75%");
    } else {
      tiles = list.flatMap((s) => {
        const len = s.end - s.start;
        return [
          { time: clamp(s.start + Math.min(0.3, len * 0.2)), tag: "in" },
          { time: clamp(s.start + len / 2), tag: "mid" },
          { time: clamp(s.end - Math.max(frame, Math.min(0.45, len * 0.15))), tag: "out" },
        ];
      });
    }
  }
  if (tiles.length > REVIEW_MAX_TILES) {
    notes.push(`${tiles.length} tiles requested; showing the first ${REVIEW_MAX_TILES} (review one scene at a time with scene)`);
    tiles = tiles.slice(0, REVIEW_MAX_TILES);
  }

  let crop = "";
  if (mode === "crop") {
    const c = opts.crop;
    if (!c) throw new Error("crop mode needs crop {x, y, w, h} as fractions of the frame (e.g. {x: 0.1, y: 0.6, w: 0.8, h: 0.3})");
    if (c.x < 0 || c.y < 0 || c.w <= 0 || c.h <= 0 || c.x + c.w > 1.0001 || c.y + c.h > 1.0001) throw new Error("crop must lie inside the frame: 0 ≤ x, y and x + w, y + h ≤ 1");
    const px = (f: number, full: number) => Math.max(0, Math.round(f * full));
    crop = `crop=${Math.max(2, px(c.w, r.width))}:${Math.max(2, px(c.h, r.height))}:${px(c.x, r.width)}:${px(c.y, r.height)},`;
    if (!opts.times?.length) {
      if (!only) tiles = spans.length ? spans.map((s) => ({ time: clamp((s.start + s.end) / 2), tag: "mid" })) : [{ time: clamp(dur / 2) }];
      else tiles = [{ time: clamp((only.start + only.end) / 2), tag: "mid" }];
    }
  }

  const width = Math.max(64, Math.round(opts.width ?? DEFAULT_WIDTH[mode]));
  const cols = Math.max(1, Math.min(opts.cols ?? DEFAULT_COLS[mode], tiles.length));
  const rows = Math.ceil(tiles.length / cols);

  const outDir = join(projectPaths(r.root).root, "qa", "review");
  const work = join(outDir, ".work");
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const fontsDir = findFontsDir();
  const font = fontsDir ? join(fontsDir, "Inter", "Inter-Bold.ttf") : undefined;
  const labelSize = Math.max(11, Math.round(width / 14));

  const out: ReviewTile[] = tiles.map((x, i) => {
    const scene_id = sceneAt(x.time);
    const label = [scene_id, x.tag, `${round3(x.time).toFixed(2)}s`].filter(Boolean).join(" ");
    return { index: i, time_sec: round3(x.time), ...(scene_id ? { scene_id } : {}), label };
  });
  try {
    for (const [i, tile] of out.entries()) {
      const draw =
        font && existsSync(font)
          ? `,drawtext=fontfile=${escapeFilterPath(font)}:text=${escapeFiltergraph(escapeFilterOption(tile.label))}:fontsize=${labelSize}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=${Math.round(labelSize / 3)}:x=4:y=4`
          : "";
      // Input-side seek is accurate when re-encoding and much faster than decoding from the start.
      // A seek onto the reel's final frame can come back empty: step back a frame at a time.
      const png = join(work, `${String(i + 1).padStart(4, "0")}.png`);
      for (let back = 0; back < 4 && !existsSync(png); back++) {
        const at = Math.max(0, tile.time_sec - back * frame);
        await runFfmpeg(["-y", "-ss", at.toFixed(3), "-i", r.reel, "-frames:v", "1", "-vf", `${crop}scale=${width}:-2:flags=bicubic${draw}`, png], { timeoutMs: 60_000 });
        if (back > 0 && existsSync(png)) {
          tile.time_sec = round3(at);
          tile.label = tile.label.replace(/[\d.]+s$/, `${tile.time_sec.toFixed(2)}s`);
        }
      }
      if (!existsSync(png)) throw new Error(`no frame at ${tile.time_sec}s in ${r.reel}`);
    }
    if (!font || !existsSync(font)) notes.push("bundled fonts not found: tiles are unlabelled; use the tiles list for times");
    const name = `${mode}-${r.quality ?? "render"}${opts.scene ? `-${opts.scene}` : ""}.jpg`;
    const image = join(outDir, name);
    await runFfmpeg(
      ["-y", "-framerate", "1", "-i", join(work, "%04d.png"), "-vf", `tile=${cols}x${rows}:padding=4:margin=4:color=0x808080`, "-frames:v", "1", "-q:v", "3", image],
      { timeoutMs: 60_000 },
    );
    return {
      ...(r.quality ? { quality: r.quality } : {}),
      source: r.source,
      mode,
      image,
      image_rel: relative(r.root, image),
      cols,
      rows,
      tile_width: width,
      tiles: out,
      notes,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export function formatReview(r: ReviewResult): string {
  const lines = [
    `review ${r.mode}: ${r.tiles.length} frame(s) of the ${r.quality ?? ""} render (${r.source}) in ${r.cols}×${r.rows} → ${r.image}`.replace(/ {2}/g, " "),
    "Read the image and check: text fits and is readable, nothing sits under captions or app UI, graphics land when their words are spoken, crops keep faces and subjects, transitions are clean.",
    ...r.notes.map((n) => `note: ${n}`),
  ];
  return lines.join("\n");
}

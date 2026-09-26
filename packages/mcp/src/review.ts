import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { projectPaths } from "@video-studio/core";
import { escapeFilterOption, escapeFilterPath, escapeFiltergraph, runFfmpeg } from "@video-studio/media";
import { findFontsDir } from "@video-studio/renderer";
import { type Quality, resolveRender } from "./golden.js";
import { type LintFinding, type LintSeverity, lintProject } from "./lint.js";

/**
 * review: images of a finished render for Claude to look at before handing it over. A contact
 * sheet (each scene's opening, middle and closing frame), a strip (every frame of a stretch, for
 * motion, transitions and word cues) or crops (full-resolution detail of one region). Each tile is
 * labelled with its scene and time. Tiles of scenes with lint findings get a coloured border (red:
 * error, amber: warning) and strip tiles show the word cues spoken on them, so Claude knows where
 * to look first. Read-only apart from qa/review/ and the qa/lint.{json,md} the lint pass writes.
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
  /** Lint finding ids for this tile's scene (deduplicated, errors first); the tile has a border. */
  flags?: string[];
  /** The worst severity among `flags`: red border for error, amber for warning. */
  severity?: LintSeverity;
  /** Word cues spoken nearest this frame (strip mode), also drawn on the tile. */
  cues?: string[];
}

/** One scene with lint findings, for the result's `flagged` list. */
export interface ReviewFlag {
  scene_id: string;
  severity: LintSeverity;
  findings: Array<{ id: string; severity: LintSeverity; message: string }>;
}

/** A word cue as the render state records it (pipeline RenderState.cues; at_ms is scene-local). */
export interface ReviewCue {
  scene_id: string;
  word: string;
  item: number;
  at_ms?: number;
  status: string;
}

export interface ReviewResult {
  quality?: Quality;
  source: string;
  mode: ReviewMode;
  /** Absolute path of the (first) JPEG; kept for compatibility, see `images`. */
  image: string;
  /** Project-relative path of the (first) JPEG. */
  image_rel: string;
  /**
   * Every JPEG, in order. One unless the grid would exceed {@link REVIEW_MAX_IMAGE_PX} on a side
   * (the vision downscale limit): then it is split into `<name>-p1.jpg`, `-p2.jpg`, … Read them all.
   */
  images: string[];
  images_rel: string[];
  /** Per image: its grid, the tile index range [first, last] and the scenes on it. */
  pages: ReviewPage[];
  /** Grid of the first image. */
  cols: number;
  rows: number;
  tile_width: number;
  /** Tiles in reading order (left to right, top to bottom). */
  tiles: ReviewTile[];
  /** Scenes in the image with lint findings, errors first: look at these tiles first. */
  flagged: ReviewFlag[];
  /** The lint pass behind the flags (absent when lint could not run; see notes). */
  lint?: { status: "pass" | "warn" | "fail"; errors: number; warnings: number; report_md: string };
  notes: string[];
}

export interface ReviewPage {
  image: string;
  image_rel: string;
  cols: number;
  rows: number;
  tiles: [number, number];
  scenes: string[];
  /** Scenes on this image with lint findings. */
  flagged?: string[];
}

/** Largest number of tiles in one image, and in a strip, crop or `times` review overall. */
export const REVIEW_MAX_TILES = 48;
/** Largest number of tiles in a whole-video contact sheet (split over several images): 30 scenes × 3. */
export const REVIEW_MAX_SHEET_TILES = 90;
/** Longest image side in px: Claude's vision input downscales anything larger, making labels unreadable. */
export const REVIEW_MAX_IMAGE_PX = 1568;
const PAD = 4;
const MARGIN = 4;
const DEFAULT_WIDTH: Record<ReviewMode, number> = { sheet: 240, strip: 180, crop: 540 };
const DEFAULT_COLS: Record<ReviewMode, number> = { sheet: 6, strip: 8, crop: 2 };

interface Span {
  id: string;
  start: number;
  end: number;
}

const BORDER_COLOR: Record<LintSeverity, string> = { error: "0xE5484D", warning: "0xF5A524" };

/**
 * Group scene-level lint findings (plus the render's unplaced word cues, when lint did not already
 * report them) by scene, errors first within a scene and across scenes; `order` sorts ties.
 */
export function flagScenes(findings: readonly LintFinding[], cues: readonly ReviewCue[] = [], order: readonly string[] = []): ReviewFlag[] {
  const all = findings.filter((f) => f.scene_id).map((f) => ({ scene_id: f.scene_id!, id: f.id, severity: f.severity, message: f.message }));
  for (const c of cues) {
    if (c.status === "placed") continue;
    if (all.some((f) => f.scene_id === c.scene_id && f.id === "cue_unmatched" && f.message.includes(`"${c.word}"`))) continue;
    all.push({ scene_id: c.scene_id, id: "cue_unmatched", severity: "warning", message: `cue "${c.word}" (item ${c.item}) was ${c.status === "late" ? "spoken after the scene ends" : "not found in the spoken words"}` });
  }
  const byScene = new Map<string, ReviewFlag>();
  for (const f of all) {
    const flag = byScene.get(f.scene_id) ?? { scene_id: f.scene_id, severity: "warning" as LintSeverity, findings: [] };
    flag.findings.push({ id: f.id, severity: f.severity, message: f.message });
    if (f.severity === "error") flag.severity = "error";
    byScene.set(f.scene_id, flag);
  }
  const rank = (s: LintSeverity) => (s === "error" ? 0 : 1);
  const pos = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  const out = [...byScene.values()];
  for (const f of out) f.findings.sort((a, b) => rank(a.severity) - rank(b.severity));
  return out.sort((a, b) => rank(a.severity) - rank(b.severity) || pos(a.scene_id) - pos(b.scene_id));
}

/** Mark tiles with their scene's flags (finding ids deduplicated, errors first). */
export function applyFlags(tiles: ReviewTile[], flags: readonly ReviewFlag[]): void {
  for (const t of tiles) {
    const f = t.scene_id ? flags.find((x) => x.scene_id === t.scene_id) : undefined;
    if (!f) continue;
    t.flags = [...new Set(f.findings.map((x) => x.id))];
    t.severity = f.severity;
  }
}

/**
 * Attach each placed word cue to the tile nearest the moment its word is spoken (scene start +
 * at_ms), skipping cues outside the tiles' span (by more than a frame).
 */
export function applyCues(tiles: ReviewTile[], cues: readonly ReviewCue[], spans: ReadonlyArray<{ id: string; start: number }>, frame: number): void {
  if (!tiles.length) return;
  const first = tiles[0]!.time_sec;
  const last = tiles[tiles.length - 1]!.time_sec;
  for (const c of cues) {
    if (c.status !== "placed" || c.at_ms === undefined) continue;
    const span = spans.find((s) => s.id === c.scene_id);
    if (!span) continue;
    const at = span.start + c.at_ms / 1000;
    if (at < first - frame || at > last + frame) continue;
    let best = tiles[0]!;
    for (const t of tiles) if (Math.abs(t.time_sec - at) < Math.abs(best.time_sec - at)) best = t;
    best.cues = [...(best.cues ?? []), c.word];
  }
}

/** The tile's video filter tail: a border when flagged, its label, and a second line for cues. */
export function tileDecor(tile: Pick<ReviewTile, "label" | "severity" | "cues">, width: number, font: string | undefined): string {
  const labelSize = Math.max(11, Math.round(width / 14));
  const border = Math.max(3, Math.round(width / 40));
  const parts: string[] = [];
  if (tile.severity) parts.push(`drawbox=x=0:y=0:w=iw:h=ih:color=${BORDER_COLOR[tile.severity]}:t=${border}`);
  if (font) {
    const text = (t: string) => escapeFiltergraph(escapeFilterOption(t));
    const inset = tile.severity ? border + 2 : 4;
    const common = `fontfile=${escapeFilterPath(font)}:fontsize=${labelSize}:boxborderw=${Math.round(labelSize / 3)}`;
    parts.push(`drawtext=${common}:expansion=none:text=${text(tile.label)}:fontcolor=white:box=1:boxcolor=black@0.6:x=${inset}:y=${inset}`);
    if (tile.cues?.length) {
      parts.push(`drawtext=${common}:expansion=none:text=${text(`cue ${tile.cues.map((w) => `"${w}"`).join(" ")}`)}:fontcolor=black:box=1:boxcolor=0xFFD60A@0.9:x=${inset}:y=h-th-${inset + Math.round(labelSize / 3)}`);
    }
  }
  return parts.length ? `,${parts.join(",")}` : "";
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
      // Three tiles per scene (split over several images when needed); very long videos drop to
      // mid + out, then mid only, so every scene shows.
      const per = list.length * 3 <= REVIEW_MAX_SHEET_TILES ? 3 : list.length * 2 <= REVIEW_MAX_SHEET_TILES ? 2 : 1;
      if (per < 3) notes.push(`${list.length} scenes: ${per === 2 ? "middle and closing" : "middle"} frame of each (use scene for all three)`);
      tiles = list.flatMap((s) => {
        const len = s.end - s.start;
        const all = [
          { time: clamp(s.start + Math.min(0.3, len * 0.2)), tag: "in" },
          { time: clamp(s.start + len / 2), tag: "mid" },
          { time: clamp(s.end - Math.max(frame, Math.min(0.45, len * 0.15))), tag: "out" },
        ];
        return per === 3 ? all : per === 2 ? all.slice(1) : [all[1]!];
      });
    }
  }
  const wholeSheet = mode === "sheet" && !opts.times?.length && !only && spans.length > 0;
  const maxTiles = wholeSheet ? REVIEW_MAX_SHEET_TILES : REVIEW_MAX_TILES;
  if (tiles.length > maxTiles) {
    notes.push(`${tiles.length} tiles requested; showing the first ${maxTiles} (review one scene at a time with scene)`);
    tiles = tiles.slice(0, maxTiles);
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

  // Tile aspect (h/w) of the frame or the crop region, for the image-size budget.
  const aspect = mode === "crop" && opts.crop ? (opts.crop.h * r.height) / Math.max(1e-6, opts.crop.w * r.width) : r.height / r.width;
  const layout = planSheets(tiles.length, {
    width: Math.max(64, Math.round(opts.width ?? DEFAULT_WIDTH[mode])),
    aspect,
    cols: opts.cols ?? DEFAULT_COLS[mode],
    // Keep a scene's in/mid/out together on one row when the sheet shows three per scene.
    group: mode === "sheet" && !opts.times?.length && tiles.length % 3 === 0 && tiles.every((x, i) => x.tag === ["in", "mid", "out"][i % 3]) ? 3 : 1,
  });
  const width = layout.width;
  notes.push(...layout.notes);

  const outDir = join(projectPaths(r.root).root, "qa", "review");
  const work = join(outDir, ".work");
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const fontsDir = findFontsDir();
  const font = fontsDir ? join(fontsDir, "Inter", "Inter-Bold.ttf") : undefined;
  const haveFont = Boolean(font && existsSync(font));

  const out: ReviewTile[] = tiles.map((x, i) => {
    const scene_id = sceneAt(x.time);
    const label = [scene_id, x.tag, `${round3(x.time).toFixed(2)}s`].filter(Boolean).join(" ");
    return { index: i, time_sec: round3(x.time), ...(scene_id ? { scene_id } : {}), label };
  });

  // Lint the same render and flag the tiles of scenes with findings. Lint problems never break review.
  const cues = (r.state as { cues?: ReviewCue[] } | undefined)?.cues ?? [];
  let findings: LintFinding[] = [];
  let lint: ReviewResult["lint"];
  if (!r.quality) {
    notes.push("lint skipped: cannot tell this render's quality, so tiles are not flagged");
  } else {
    try {
      const l = await lintProject(r.root, { quality: r.quality });
      findings = l.findings;
      lint = { status: l.status, errors: l.counts.errors, warnings: l.counts.warnings, report_md: relative(r.root, l.report_md) };
      const general = findings.filter((f) => !f.scene_id).length;
      if (general) notes.push(`${general} lint finding(s) not tied to a scene (targets, captions, cover, post copy): see ${lint.report_md}`);
    } catch (err) {
      notes.push(`lint failed, so tiles are only flagged for unplaced cues: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const inImage = new Set(out.map((x) => x.scene_id).filter(Boolean));
  const flagged = flagScenes(findings, mode === "strip" ? [] : cues, spans.map((s) => s.id)).filter((f) => inImage.has(f.scene_id));
  applyFlags(out, flagged);
  if (mode === "strip") applyCues(out, cues, spans, frame);
  const pageOf = (i: number) => layout.pages.findIndex(([a, b]) => i >= a && i <= b);
  try {
    for (const [i, tile] of out.entries()) {
      const draw = tileDecor(tile, width, haveFont ? font : undefined);
      // Input-side seek is accurate when re-encoding and much faster than decoding from the start.
      // A seek onto the reel's final frame can come back empty: step back a frame at a time.
      const p = pageOf(i);
      await mkdir(join(work, `p${p}`), { recursive: true });
      const png = join(work, `p${p}`, `${String(i - layout.pages[p]![0] + 1).padStart(4, "0")}.png`);
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
    for (const tile of out) if (tile.cues) tile.label += ` cue ${tile.cues.map((w) => `"${w}"`).join(" ")}`;
    if (!haveFont) notes.push("bundled fonts not found: tiles are unlabelled; use the tiles list for times");
    const base = `${mode}-${r.quality ?? "render"}${opts.scene ? `-${opts.scene}` : ""}`;
    // Drop this review's images from an earlier run (a split sheet may now have fewer pages).
    const stale = (f: string) => f === `${base}.jpg` || (f.startsWith(`${base}-p`) && /^\d+\.jpg$/.test(f.slice(base.length + 2)));
    for (const f of await readdir(outDir)) if (stale(f)) await rm(join(outDir, f), { force: true });
    const pages: ReviewPage[] = [];
    for (const [p, [a, b]] of layout.pages.entries()) {
      const n = b - a + 1;
      const cols = Math.min(layout.cols, n);
      const rows = Math.ceil(n / cols);
      const image = join(outDir, layout.pages.length === 1 ? `${base}.jpg` : `${base}-p${p + 1}.jpg`);
      await runFfmpeg(
        ["-y", "-framerate", "1", "-i", join(work, `p${p}`, "%04d.png"), "-vf", `tile=${cols}x${rows}:padding=${PAD}:margin=${MARGIN}:color=0x808080`, "-frames:v", "1", "-q:v", "3", image],
        { timeoutMs: 60_000 },
      );
      const scenes = [...new Set(out.slice(a, b + 1).map((x) => x.scene_id).filter((x): x is string => Boolean(x)))];
      const flaggedHere = flagged.filter((f) => scenes.includes(f.scene_id)).map((f) => f.scene_id);
      pages.push({ image, image_rel: relative(r.root, image), cols, rows, tiles: [a, b], scenes, ...(flaggedHere.length ? { flagged: flaggedHere } : {}) });
    }
    return {
      ...(r.quality ? { quality: r.quality } : {}),
      source: r.source,
      mode,
      image: pages[0]!.image,
      image_rel: pages[0]!.image_rel,
      images: pages.map((p) => p.image),
      images_rel: pages.map((p) => p.image_rel),
      pages,
      cols: pages[0]!.cols,
      rows: pages[0]!.rows,
      tile_width: width,
      tiles: out,
      flagged,
      ...(lint ? { lint } : {}),
      notes,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export function formatReview(r: ReviewResult): string {
  const pages = r.pages ?? [];
  const lines = [
    (pages.length > 1
      ? `review ${r.mode}: ${r.tiles.length} frame(s) of the ${r.quality ?? ""} render (${r.source}) in ${pages.length} images (each ≤ ${REVIEW_MAX_IMAGE_PX} px; Read every one, flagged first):`
      : `review ${r.mode}: ${r.tiles.length} frame(s) of the ${r.quality ?? ""} render (${r.source}) in ${r.cols}×${r.rows} → ${r.image}`
    ).replace(/ {2}/g, " "),
    ...(pages.length > 1
      ? pages.map(
          (p, i) =>
            `  ${i + 1}. ${p.image} (${p.cols}×${p.rows}, tiles ${p.tiles[0] + 1}-${p.tiles[1] + 1}${p.scenes.length ? `, ${p.scenes[0]}${p.scenes.length > 1 ? `–${p.scenes[p.scenes.length - 1]}` : ""}` : ""}${p.flagged?.length ? `; flagged ${p.flagged.join(", ")}` : ""})`,
        )
      : []),
    ...(r.flagged.length
      ? [
          `flagged (bordered tiles; look here first): ${r.flagged.map((f) => `${f.scene_id}: ${[...new Map(f.findings.map((x) => [x.id, x.severity])).entries()].map(([id, sev]) => `${id} (${sev})`).join(", ")}`).join("; ")}`,
        ]
      : r.lint
        ? [`no scene-level lint findings (lint ${r.lint.status})`]
        : []),
    ...(r.tiles.some((t) => t.cues)
      ? [`word cues: ${r.tiles.flatMap((t) => (t.cues ?? []).map((w) => `"${w}" at ${t.time_sec.toFixed(2)}s (tile ${t.index + 1})`)).join(", ")}; check the cued item is appearing on that tile`]
      : []),
    `Read the image${pages.length > 1 ? "s" : ""} and check: text fits and is readable, nothing sits under captions or app UI, graphics land when their words are spoken, crops keep faces and subjects, transitions are clean.`,
    ...r.notes.map((n) => `note: ${n}`),
  ];
  return lines.join("\n");
}

export interface SheetPlanInput {
  /** Requested tile width in px. */
  width: number;
  /** Tile height / width (of the frame, or of the crop region). */
  aspect: number;
  /** Requested columns. */
  cols: number;
  /** Tiles that belong together (a scene's in/mid/out): rows and images never split a group. */
  group?: number;
  /** Longest image side (default {@link REVIEW_MAX_IMAGE_PX}). */
  maxPx?: number;
  /** Most tiles per image (default {@link REVIEW_MAX_TILES}). */
  maxPerImage?: number;
}

export interface SheetPlan {
  /** Tile width actually used (reduced only when a single tile would not fit). */
  width: number;
  /** Tile height (even, as ffmpeg's scale=w:-2 makes it). */
  height: number;
  cols: number;
  rowsPerImage: number;
  /** Tile index ranges [first, last] per image. */
  pages: Array<[number, number]>;
  notes: string[];
}

/** Pixel extent of `k` tiles of size `s` with the tile filter's padding and margin. */
export function gridPx(k: number, s: number): number {
  return k * s + (k - 1) * PAD + 2 * MARGIN;
}

/**
 * Lay `n` tiles out over as few images as possible with every image ≤ maxPx on both sides, so
 * nothing is downscaled before Claude sees it. Columns shrink before tiles do; tiles shrink only
 * when a single tile would not fit. Groups (a scene's three frames) stay on one row and one image.
 */
export function planSheets(n: number, o: SheetPlanInput): SheetPlan {
  const maxPx = o.maxPx ?? REVIEW_MAX_IMAGE_PX;
  const maxPer = Math.max(1, o.maxPerImage ?? REVIEW_MAX_TILES);
  const group = Math.max(1, o.group ?? 1);
  const notes: string[] = [];
  const even = (x: number) => Math.max(2, 2 * Math.round(x / 2));
  let width = Math.max(2, Math.round(o.width));
  const inner = maxPx - 2 * MARGIN;
  if (width > inner) width = inner - (inner % 2);
  let height = even(width * o.aspect);
  if (height > inner) {
    width = Math.max(2, Math.floor(inner / o.aspect) - (Math.floor(inner / o.aspect) % 2));
    height = even(width * o.aspect);
  }
  if (width !== Math.round(o.width)) notes.push(`tile width reduced to ${width}px so each image stays within ${maxPx}px`);
  const colsFit = Math.max(1, Math.floor((inner + PAD) / (width + PAD)));
  let cols = Math.max(1, Math.min(Math.round(o.cols), colsFit, Math.max(1, n)));
  if (cols < Math.min(Math.round(o.cols), n)) notes.push(`${cols} columns (not ${o.cols}) so each image stays within ${maxPx}px wide`);
  if (group > 1 && cols >= group) cols -= cols % group;
  const rowsFit = Math.max(1, Math.floor((inner + PAD) / (height + PAD)));
  const perImage = Math.max(1, Math.floor(Math.min(cols * rowsFit, maxPer) / cols) * cols);
  const pages: Array<[number, number]> = [];
  for (let a = 0; a < n; a += perImage) pages.push([a, Math.min(n, a + perImage) - 1]);
  if (!pages.length) pages.push([0, -1]);
  if (pages.length > 1) notes.push(`${n} tiles split over ${pages.length} images of up to ${perImage} (${cols}×${Math.ceil(perImage / cols)}) so labels stay readable`);
  return { width, height, cols, rowsPerImage: Math.ceil(perImage / cols), pages, notes };
}

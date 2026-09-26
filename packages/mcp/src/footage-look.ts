import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { projectPaths, resolveInsideProject, writeJsonAtomic } from "@video-studio/core";
import { spreadIndices } from "@video-studio/ingestion";
import { groupSentences, runFfmpeg } from "@video-studio/media";
import { ContentIR, type FootageNote, type IrAsset, formatIssues } from "@video-studio/schema";
import { planSheets, reviewFont, tileDecor, tileSheet } from "./review.js";
import { TranscribeError, findMediaAsset, loadContentIr, loadTranscriptWords } from "./transcribe.js";

/**
 * footage_look: let Claude SEE a stretch of an ingested video cheaply. Frames are picked at the
 * shot boundaries ingest detected (a little after each cut, plus a middle frame for long shots),
 * near-identical frames are dropped (16×9 grayscale thumbnails compared by mean absolute
 * difference, so a cut back to the same angle shows once), and the rest are drawn as ONE labelled
 * contact sheet (paged like review when it would exceed the vision size limit), together with the
 * transcript of the same range. footage_notes stores what Claude saw per shot on the asset
 * (`media.notes`), keyed by the file's sha256: observations, never evidence or claims.
 */

/** Long side of a tile in px. */
export const LOOK_TILE_PX = 512;
export const LOOK_DEFAULT_FRAMES = 12;
export const LOOK_MAX_FRAMES = 48;
/** Shots at least this long also get a middle frame. */
export const LOOK_LONG_SHOT_SEC = 5;
/** Mean absolute difference (0–255) of the 16×9 thumbnails below which two frames count as the same picture. */
export const LOOK_DUPLICATE_DIFF = 4;
/** Most transcript characters returned; longer windows are cut at a sentence (narrow the range). */
export const LOOK_MAX_TRANSCRIPT_CHARS = 4000;
const THUMB_W = 16;
const THUMB_H = 9;

export class FootageError extends Error {
  constructor(message: string, fix?: string) {
    super(fix ? `${message}\nFix: ${fix}` : message);
    this.name = "FootageError";
  }
}

export interface FootageLookOptions {
  from_sec?: number;
  to_sec?: number;
  max_frames?: number;
}

export interface FootageTile {
  index: number;
  time_sec: number;
  /** 1-based shot number (media.shots[shot - 1]). */
  shot: number;
  shot_start_sec: number;
  shot_end_sec: number;
  label: string;
}

export interface FootageSentence {
  start_sec: number;
  end_sec: number;
  speaker?: string;
  text: string;
}

export interface FootageLookResult {
  asset: string;
  from_sec: number;
  to_sec: number;
  duration_sec: number;
  /** Absolute JPEG paths, in order: Read every one. */
  images: string[];
  images_rel: string[];
  pages: Array<{ image_rel: string; cols: number; rows: number; tiles: [number, number] }>;
  tile_px: { width: number; height: number };
  tiles: FootageTile[];
  /** Frames left out because they look like an earlier tile (a cut back to the same picture). */
  duplicates: Array<{ time_sec: number; shot: number; same_as_tile: number }>;
  shots_in_range: number;
  transcript?: FootageSentence[];
  /** Set when the transcript window was cut to {@link LOOK_MAX_TRANSCRIPT_CHARS}. */
  transcript_truncated?: { shown_sentences: number; total_sentences: number };
  /** Footage notes already stored for this range (see footage_notes). */
  shot_notes?: FootageNote[];
  notes: string[];
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const fmt = (x: number) => (Math.round(x * 10) / 10).toFixed(1);

async function loadIr(root: string): Promise<{ path: string; ir: ContentIR }> {
  try {
    return await loadContentIr(root);
  } catch (err) {
    if (err instanceof TranscribeError) throw new FootageError(err.message.replace(/\nFix: .*/s, ""), "ingest the video file first");
    throw err;
  }
}

function videoAsset(ir: ContentIR, id: string): IrAsset & { media: NonNullable<IrAsset["media"]> } {
  let asset: IrAsset;
  try {
    asset = findMediaAsset(ir, id);
  } catch (err) {
    throw new FootageError(err instanceof Error ? err.message.replace(/^"/, "asset \"") : String(err));
  }
  if (asset.kind !== "video" || !asset.media?.has_video) {
    const videos = ir.assets.filter((a) => a.kind === "video" && a.media?.has_video).map((a) => a.id);
    throw new FootageError(
      `asset ${asset.id} is audio-only: there is no picture to look at`,
      videos.length ? `use a video asset (${videos.join(", ")}), or read its transcript` : "read its transcript instead (transcribe, then source_section)",
    );
  }
  if (!asset.media) throw new FootageError(`asset ${asset.id} has no probe data`, "re-ingest the video file");
  return asset as IrAsset & { media: NonNullable<IrAsset["media"]> };
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) throw new Error("not a PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Mean absolute difference of two equal-length grayscale buffers (0–255). */
export function thumbDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}

interface Candidate {
  time: number;
  shot: number;
  start: number;
  end: number;
  /** Opening frame of its shot (kept before middle frames when capping). */
  first: boolean;
}

/**
 * Frames to sample in [from, to]: a little after each shot's start (past dissolves), plus a middle
 * frame for shots of at least {@link LOOK_LONG_SHOT_SEC}; at most `limit`, opening frames first,
 * evenly spread when there are more shots than that.
 */
export function pickFrames(shots: ReadonlyArray<{ start_sec: number; end_sec: number }>, from: number, to: number, duration: number, limit: number, fps = 25): Candidate[] {
  const last = Math.max(0, duration - 1 / fps);
  const firsts: Candidate[] = [];
  const mids: Candidate[] = [];
  shots.forEach((s, i) => {
    const a = Math.max(s.start_sec, from);
    const b = Math.min(s.end_sec, to);
    if (b <= a) return;
    const len = b - a;
    const base = { shot: i + 1, start: s.start_sec, end: s.end_sec };
    firsts.push({ ...base, time: r3(Math.min(last, a + Math.min(0.3, len * 0.2))), first: true });
    if (len >= LOOK_LONG_SHOT_SEC) mids.push({ ...base, time: r3(Math.min(last, a + len / 2)), first: false });
  });
  const picked = firsts.length > limit ? spreadIndices(firsts.length, limit).map((i) => firsts[i]!) : [...firsts];
  const room = limit - picked.length;
  if (room > 0 && mids.length) picked.push(...(mids.length > room ? spreadIndices(mids.length, room).map((i) => mids[i]!) : mids));
  return picked.sort((x, y) => x.time - y.time);
}

/** Sentences of the transcript overlapping [from, to], capped at {@link LOOK_MAX_TRANSCRIPT_CHARS}. */
export async function transcriptWindow(
  root: string,
  asset: IrAsset,
  from: number,
  to: number,
): Promise<{ sentences: FootageSentence[]; truncated?: { shown_sentences: number; total_sentences: number } } | undefined> {
  if (!asset.media?.transcript) return undefined;
  const words = (await loadTranscriptWords(root, asset)).filter((w) => w.start_ms < to * 1000 && w.end_ms > from * 1000);
  const all = groupSentences(words).map((s) => ({
    start_sec: r3(s.start_ms / 1000),
    end_sec: r3(s.end_ms / 1000),
    ...(s.speaker !== undefined ? { speaker: s.speaker } : {}),
    text: s.text,
  }));
  const out: FootageSentence[] = [];
  let chars = 0;
  for (const s of all) {
    if (out.length && chars + s.text.length > LOOK_MAX_TRANSCRIPT_CHARS) break;
    out.push(s.text.length > LOOK_MAX_TRANSCRIPT_CHARS ? { ...s, text: `${s.text.slice(0, LOOK_MAX_TRANSCRIPT_CHARS)}…` } : s);
    chars += s.text.length;
  }
  return { sentences: out, ...(out.length < all.length ? { truncated: { shown_sentences: out.length, total_sentences: all.length } } : {}) };
}

/** Notes still valid for the asset's current bytes, and how many are stale. */
function currentNotes(asset: IrAsset): { fresh: FootageNote[]; stale: number } {
  const all = asset.media?.notes ?? [];
  const fresh = all.filter((n) => n.asset_sha256 === asset.sha256);
  return { fresh, stale: all.length - fresh.length };
}

export async function footageLook(projectDir: string, assetId: string, opts: FootageLookOptions = {}): Promise<FootageLookResult> {
  const root = resolve(projectDir);
  const { ir } = await loadIr(root);
  const asset = videoAsset(ir, assetId);
  const media = asset.media;
  const notes: string[] = [];

  let file: string;
  try {
    file = await resolveInsideProject(projectPaths(root), asset.path);
  } catch {
    throw new FootageError(`asset ${asset.id} path ${asset.path} is outside the project`, "re-ingest the video file");
  }
  if (!existsSync(file)) throw new FootageError(`asset file not found: ${asset.path}`, "re-ingest the video file (it was moved or deleted)");

  const duration = media.duration_sec;
  const from = opts.from_sec ?? 0;
  let to = opts.to_sec ?? duration;
  if (!(from >= 0)) throw new FootageError(`from_sec must be ≥ 0 (got ${from})`);
  if (from >= duration) throw new FootageError(`from_sec ${from} is past the end of ${asset.id} (duration ${duration} s)`, `pass a range inside 0–${duration} s`);
  if (!(to > from)) throw new FootageError(`to_sec ${to} must be after from_sec ${from}`);
  if (to > duration + 0.05) {
    notes.push(`to_sec ${to} is past the end; clamped to the duration ${duration} s`);
  }
  to = Math.min(to, duration);

  const max = Math.min(LOOK_MAX_FRAMES, Math.max(1, Math.round(opts.max_frames ?? LOOK_DEFAULT_FRAMES)));
  const shots = media.shots?.length ? media.shots : [{ start_sec: 0, end_sec: duration }];
  if (!media.shots?.length) notes.push("no shot boundaries recorded for this asset: treated as one shot");
  const shotsInRange = shots.filter((s) => s.end_sec > from && s.start_sec < to).length;
  // Sample up to twice the cap so duplicates can be dropped without leaving the sheet short.
  const candidates = pickFrames(shots, from, to, duration, Math.min(max * 2, LOOK_MAX_FRAMES * 2), media.fps ?? 25);

  const outDir = join(root, "qa", "footage");
  const work = join(outDir, `.work-${process.pid}-${Date.now()}`);
  await mkdir(work, { recursive: true });
  const font = reviewFont();
  if (!font) notes.push("bundled fonts not found: tiles are unlabelled; use the tiles list for times");
  try {
    // Tile size from the video's display size (rotation applied by the decoder, so read it back).
    const portrait = (media.height ?? 0) > (media.width ?? 1);
    let tileW = portrait ? 2 * Math.round((LOOK_TILE_PX * (media.width ?? 9)) / (media.height ?? 16) / 2) : LOOK_TILE_PX;
    const kept: Array<Candidate & { png: string; thumb: Uint8Array }> = [];
    const duplicates: FootageLookResult["duplicates"] = [];
    let size: { width: number; height: number } | undefined;
    for (const [i, c] of candidates.entries()) {
      if (kept.length >= max) break;
      const png = join(work, `f${i}.png`);
      const gray = join(work, `f${i}.gray`);
      const label = `t=${fmt(c.time)}s shot ${c.shot}`;
      const scale = size ? `scale=${size.width}:${size.height}` : `scale='if(gte(iw,ih),${LOOK_TILE_PX},-2)':'if(gte(iw,ih),-2,${LOOK_TILE_PX})'`;
      await runFfmpeg(
        [
          "-y", "-ss", c.time.toFixed(3), "-i", file,
          "-filter_complex", `[0:v:0]split=2[a][b];[a]${scale}:flags=bicubic${tileDecor({ label }, tileW, font)}[big];[b]scale=${THUMB_W}:${THUMB_H},format=gray[small]`,
          "-map", "[small]", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", gray,
          "-map", "[big]", "-frames:v", "1", png,
        ],
        { timeoutMs: 60_000 },
      );
      if (!existsSync(png) || !existsSync(gray)) {
        notes.push(`no frame decoded at ${fmt(c.time)} s (shot ${c.shot}); skipped`);
        continue;
      }
      if (!size) {
        size = pngSize(await readFile(png));
        tileW = size.width;
      }
      const thumb = new Uint8Array(await readFile(gray));
      const same = kept.findIndex((k) => thumbDiff(k.thumb, thumb) < LOOK_DUPLICATE_DIFF);
      if (same >= 0) {
        duplicates.push({ time_sec: c.time, shot: c.shot, same_as_tile: same });
        continue;
      }
      kept.push({ ...c, png, thumb });
    }
    if (!kept.length || !size) throw new FootageError(`no frames could be decoded from ${asset.path} in ${fmt(from)}–${fmt(to)} s`);
    const skipped = candidates.length - kept.length - duplicates.length;
    if (kept.length >= max && skipped > 0) notes.push(`${kept.length} frames shown (max_frames ${max}); ${shotsInRange} shots in range: narrow the range or raise max_frames to see more`);
    if (duplicates.length) notes.push(`${duplicates.length} frame(s) left out as near-identical to an earlier tile (see duplicates)`);

    const layout = planSheets(kept.length, { width: size.width, aspect: size.height / size.width, cols: Math.ceil(Math.sqrt(kept.length)) });
    notes.push(...layout.notes);
    const base = `${asset.id.replace(/[^A-Za-z0-9_.-]/g, "_")}-${fmt(from)}-${fmt(to)}`;
    // Drop this range's images from an earlier run (it may now have fewer pages).
    for (const f of await readdir(outDir)) {
      if (f === `${base}.jpg` || (f.startsWith(`${base}-p`) && /^\d+\.jpg$/.test(f.slice(base.length + 2)))) await rm(join(outDir, f), { force: true });
    }
    const images: string[] = [];
    const pages: FootageLookResult["pages"] = [];
    for (const [p, [a, b]] of layout.pages.entries()) {
      const dir = join(work, `p${p}`);
      await mkdir(dir, { recursive: true });
      for (let k = a; k <= b; k++) {
        await copyFile(kept[k]!.png, join(dir, `${String(k - a + 1).padStart(4, "0")}.png`));
      }
      const n = b - a + 1;
      const cols = Math.min(layout.cols, n);
      const rows = Math.ceil(n / cols);
      const image = join(outDir, layout.pages.length === 1 ? `${base}.jpg` : `${base}-p${p + 1}.jpg`);
      await tileSheet(dir, cols, rows, image);
      images.push(image);
      pages.push({ image_rel: relative(root, image), cols, rows, tiles: [a, b] });
    }

    const tiles: FootageTile[] = kept.map((k, index) => ({
      index,
      time_sec: k.time,
      shot: k.shot,
      shot_start_sec: k.start,
      shot_end_sec: k.end,
      label: `t=${fmt(k.time)}s shot ${k.shot}`,
    }));

    const tw = await transcriptWindow(root, asset, from, to);
    if (!tw) notes.push(media.subtitles?.length ? "no transcript yet: import its subtitles with transcribe captions_file" : "no transcript yet: run transcribe to see what is said");
    else if (tw.truncated) notes.push(`transcript cut to ${tw.truncated.shown_sentences} of ${tw.truncated.total_sentences} sentences (${LOOK_MAX_TRANSCRIPT_CHARS} chars): narrow the range for the rest`);
    const { fresh, stale } = currentNotes(asset);
    const inRange = fresh.filter((n) => n.to_sec > from && n.from_sec < to);
    if (stale) notes.push(`${stale} stored footage note(s) are stale (the file changed since): write them again with footage_notes`);

    return {
      asset: asset.id,
      from_sec: r3(from),
      to_sec: r3(to),
      duration_sec: duration,
      images,
      images_rel: images.map((i) => relative(root, i)),
      pages,
      tile_px: size,
      tiles,
      duplicates,
      shots_in_range: shotsInRange,
      ...(tw ? { transcript: tw.sentences } : {}),
      ...(tw?.truncated ? { transcript_truncated: tw.truncated } : {}),
      ...(inRange.length ? { shot_notes: inRange } : {}),
      notes,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export function formatFootageLook(r: FootageLookResult): string {
  const head =
    r.images.length > 1
      ? `footage ${r.asset} ${fmt(r.from_sec)}–${fmt(r.to_sec)} s: ${r.tiles.length} frame(s) from ${r.shots_in_range} shot(s) in ${r.images.length} images; Read every one:\n${r.images.map((i, k) => `  ${k + 1}. ${i}`).join("\n")}`
      : `footage ${r.asset} ${fmt(r.from_sec)}–${fmt(r.to_sec)} s: ${r.tiles.length} frame(s) from ${r.shots_in_range} shot(s) → ${r.images[0]}; Read it`;
  const lines = [
    head,
    r.transcript ? `transcript: ${r.transcript.length} sentence(s) in range` : "",
    "Then record what each shot shows (subject, action, on-screen text, b-roll use, quality) with footage_notes so you need not look again.",
    ...r.notes.map((n) => `note: ${n}`),
  ];
  return lines.filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------------- notes

export interface FootageNoteInput {
  from_sec: number;
  to_sec: number;
  subject?: string;
  action?: string;
  on_screen_text?: string;
  broll?: boolean;
  quality?: "good" | "ok" | "poor";
  tags?: string[];
}

export interface FootageNotesResult {
  asset: string;
  mode: "read" | "write";
  notes: FootageNote[];
  added?: number;
  replaced?: number;
  /** Notes written for an earlier version of the file (dropped on write). */
  stale?: number;
}

/** Two ranges are "the same" when both ends agree within this many seconds. */
const SAME_RANGE_SEC = 0.05;

/**
 * Read (no `notes`) or merge Claude's footage notes into the asset's `media.notes`. A note for
 * the same range (both ends within 50 ms) replaces the old one; others are added. Stale notes (a
 * different file hash) are reported on read and dropped on write. Evidence and claims are never touched.
 */
export async function footageNotes(projectDir: string, assetId: string, input?: readonly FootageNoteInput[], now: () => Date = () => new Date()): Promise<FootageNotesResult> {
  const root = resolve(projectDir);
  const { path, ir } = await loadIr(root);
  const asset = videoAsset(ir, assetId);
  const { fresh, stale } = currentNotes(asset);
  if (!input) return { asset: asset.id, mode: "read", notes: fresh, ...(stale ? { stale } : {}) };
  if (!input.length) throw new FootageError("notes is empty", "omit notes to read the stored ones, or pass at least one note");

  const duration = asset.media.duration_sec;
  const at = now().toISOString();
  const merged = [...fresh];
  let added = 0;
  let replaced = 0;
  for (const [i, n] of input.entries()) {
    if (!(n.from_sec >= 0) || !(n.to_sec > n.from_sec)) throw new FootageError(`notes[${i}]: needs 0 ≤ from_sec < to_sec (got ${n.from_sec}–${n.to_sec})`);
    if (n.to_sec > duration + SAME_RANGE_SEC) throw new FootageError(`notes[${i}]: to_sec ${n.to_sec} is past the end of ${asset.id} (duration ${duration} s)`);
    const clean = (s: string | undefined) => (s === undefined ? undefined : s.trim() || undefined);
    const tags = n.tags?.map((t) => t.trim()).filter(Boolean);
    const note: FootageNote = {
      from_sec: r3(n.from_sec),
      to_sec: r3(Math.min(n.to_sec, duration)),
      ...(clean(n.subject) ? { subject: clean(n.subject)! } : {}),
      ...(clean(n.action) ? { action: clean(n.action)! } : {}),
      ...(clean(n.on_screen_text) ? { on_screen_text: clean(n.on_screen_text)! } : {}),
      ...(n.broll !== undefined ? { broll: n.broll } : {}),
      ...(n.quality ? { quality: n.quality } : {}),
      ...(tags?.length ? { tags: [...new Set(tags)] } : {}),
      asset_sha256: asset.sha256,
      updated_at: at,
    };
    const k = merged.findIndex((m) => Math.abs(m.from_sec - note.from_sec) <= SAME_RANGE_SEC && Math.abs(m.to_sec - note.to_sec) <= SAME_RANGE_SEC);
    if (k >= 0) {
      merged[k] = note;
      replaced++;
    } else {
      merged.push(note);
      added++;
    }
  }
  merged.sort((a, b) => a.from_sec - b.from_sec || a.to_sec - b.to_sec);
  const next = structuredClone(ir);
  const target = next.assets.find((a) => a.id === asset.id)!;
  target.media = { ...target.media!, notes: merged };
  const parsed = ContentIR.safeParse(next);
  if (!parsed.success) throw new FootageError(`notes are invalid: ${formatIssues(parsed.error).map((x) => `${x.path}: ${x.message}`).join("; ")}`);
  await writeJsonAtomic(path, parsed.data);
  return { asset: asset.id, mode: "write", notes: merged, added, replaced, ...(stale ? { stale } : {}) };
}

export function formatFootageNotes(r: FootageNotesResult): string {
  const stale = r.stale ? `; ${r.stale} stale note(s) for an earlier version of the file ${r.mode === "write" ? "dropped" : "(write them again)"}` : "";
  if (r.mode === "read") return `footage notes for ${r.asset}: ${r.notes.length}${stale}`;
  return `footage notes for ${r.asset}: ${r.added ?? 0} added, ${r.replaced ?? 0} replaced, ${r.notes.length} stored${stale}`;
}

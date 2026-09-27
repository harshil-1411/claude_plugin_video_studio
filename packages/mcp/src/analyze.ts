import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic, writeJsonAtomic } from "@video-studio/core";
import { detectShots } from "@video-studio/ingestion";
import { ffprobe, measureLoudness, runFfmpeg } from "@video-studio/media";
import { FormatGrammar, SCHEMA_VERSION } from "@video-studio/schema";
import { measureSilences, soundShareOf, speechPacing } from "./speech-pacing.js";
import { formatMotionTiming, measureMotionTiming, styleFromMotion, styleTarget, writeProjectStyle } from "./motion-timing.js";

export { findShorts, formatShorts } from "./shorts.js";

/**
 * analyze: a reference video → its format grammar (structure only: shots, pacing, caption band,
 * speech share). Clean room: nothing from the file (words, frames, audio) is copied into the
 * project; frames are decoded to tiny grayscale edge maps in a temp folder and deleted.
 */

export const FAST_SHOT_SEC = 2;
export const SLOW_SHOT_SEC = 5;
const SAMPLE_FRAMES = 6;
const EDGE_WIDTH = 192;

export function pacingFor(avgShotSec: number): FormatGrammar["pacing"] {
  return avgShotSec < FAST_SHOT_SEC ? "fast" : avgShotSec > SLOW_SHOT_SEC ? "slow" : "medium";
}

const COMMON_RATIOS: Array<[string, number]> = [
  ["9:16", 9 / 16],
  ["16:9", 16 / 9],
  ["1:1", 1],
  ["4:5", 4 / 5],
  ["4:3", 4 / 3],
  ["3:4", 3 / 4],
  ["21:9", 21 / 9],
];

export function aspectRatioOf(w: number | null, h: number | null): string {
  if (!w || !h) return "unknown";
  const r = w / h;
  for (const [name, v] of COMMON_RATIOS) if (Math.abs(r - v) / v < 0.02) return name;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}

/**
 * Where burned-in text sits, from per-row edge density averaged over sampled frames (values
 * 0–1, index = row). Looks in the lower two-thirds for the densest band that clearly stands
 * out from the frame's median row; null when nothing does.
 */
export function findCaptionBand(rowDensity: readonly number[]): { y_from: number; y_to: number } | null {
  const H = rowDensity.length;
  if (H < 12) return null;
  const bh = Math.max(2, Math.round(H * 0.08));
  const sorted = [...rowDensity].sort((a, b) => a - b);
  const median = sorted[Math.floor(H / 2)]!;
  let best = -1;
  let bestY = -1;
  for (let y = Math.floor(H / 3); y + bh <= H; y++) {
    let s = 0;
    let peak = 0;
    for (let k = 0; k < bh; k++) {
      s += rowDensity[y + k]!;
      peak = Math.max(peak, rowDensity[y + k]!);
    }
    // Text spreads edges over several rows; a lone dense row is a horizontal border or horizon.
    if (s > 0 && peak / s > 0.5) continue;
    if (s / bh > best) {
      best = s / bh;
      bestY = y;
    }
  }
  if (bestY < 0 || best < 0.05 || best < 2.5 * median + 0.02) return null;
  // Grow the band while rows stay dense (text lines have gaps, so compare with half the peak).
  const floor = best * 0.4;
  let top = bestY;
  let bottom = bestY + bh - 1;
  const maxH = Math.round(H * 0.3);
  while (top > Math.floor(H / 3) && rowDensity[top - 1]! >= floor && bottom - top < maxH) top--;
  while (bottom < H - 1 && rowDensity[bottom + 1]! >= floor && bottom - top < maxH) bottom++;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return { y_from: r3(top / H), y_to: r3((bottom + 1) / H) };
}

/** Per-row edge density (0–1) averaged over `frames` gray frames of width×height bytes. */
export function rowEdgeDensity(raw: Uint8Array, width: number, height: number): number[] {
  const frameSize = width * height;
  const frames = Math.floor(raw.length / frameSize);
  const rows = new Array<number>(height).fill(0);
  if (frames === 0) return rows;
  for (let f = 0; f < frames; f++) {
    for (let y = 0; y < height; y++) {
      let n = 0;
      const off = f * frameSize + y * width;
      for (let x = 0; x < width; x++) if (raw[off + x]! > 127) n++;
      rows[y]! += n / width;
    }
  }
  return rows.map((r) => r / frames);
}

async function sampleEdgeRows(path: string, duration: number, w: number, h: number): Promise<number[]> {
  const W = EDGE_WIDTH;
  const H = Math.max(16, Math.round((W * h) / w / 2) * 2);
  const work = await mkdtemp(join(tmpdir(), "vs-analyze-"));
  try {
    const out = join(work, "edges.gray");
    const rate = Math.max(0.001, SAMPLE_FRAMES / Math.max(duration, 0.1));
    await runFfmpeg(
      ["-y", "-i", path, "-map", "0:v:0", "-an", "-vf", `fps=${rate.toFixed(6)},scale=${W}:${H},format=gray,edgedetect=low=0.1:high=0.3`, "-frames:v", String(SAMPLE_FRAMES), "-f", "rawvideo", "-pix_fmt", "gray", out],
      { timeoutMs: 10 * 60 * 1000 },
    );
    return rowEdgeDensity(new Uint8Array(await readFile(out)), W, H);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Share of the file where the voice band (200–3500 Hz) is above -35 dBFS, and the pauses inside
 * speech (speech-pacing.ts), from one silencedetect pass.
 */
async function speechMeasures(path: string, duration: number): Promise<{ share: number; pacing: NonNullable<FormatGrammar["speech_pacing"]> }> {
  const ms = Math.round(duration * 1000);
  const silences = await measureSilences(path, ms);
  return { share: soundShareOf(silences, ms), pacing: speechPacing(silences, ms) };
}

/** Motion timing (motion-timing.ts) for the grammar, with a note; undefined when it can't be measured. */
async function motionTimingFor(path: string, notes: string[]): Promise<FormatGrammar["motion_timing"]> {
  try {
    const m = await measureMotionTiming(path);
    if (m.continuous) notes.push(`${m.continuous} long continuous motion stretch(es) (over 2 s: camera moves or live footage) were left out of the motion timing.`);
    notes.push("motion_timing reads entrances from frame-to-frame difference energy: crossfades read as linear changes, cuts as snaps.");
    return m.timing;
  } catch (e) {
    notes.push(`motion timing not measured: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    return undefined;
  }
}

export interface AnalyzeOptions {
  projectDir?: string;
  /** Also write the measured motion timing as `<project>/styles/<id>.yaml` (needs projectDir). */
  writeStyle?: string;
  /** Replace an existing project style, or shadow a bundled one. */
  overwrite?: boolean;
  /** Bundled styles directory (default: findStylesDir()); for tests. */
  stylesDir?: string | null;
}

export async function analyzeVideo(
  path: string,
  opts: AnalyzeOptions = {},
): Promise<FormatGrammar & { report_md?: string; style_path?: string; style_warnings?: string[] }> {
  if (opts.writeStyle !== undefined && !opts.projectDir) throw new Error("write_style needs project_dir (the style is written to <project>/styles/<id>.yaml)");
  const styleOpts = { ...(opts.overwrite ? { overwrite: true } : {}), ...(opts.stylesDir !== undefined ? { stylesDir: opts.stylesDir } : {}) };
  // Refuse a bad write_style id before the (slow) measurement.
  if (opts.writeStyle !== undefined && opts.projectDir) await styleTarget(opts.projectDir, opts.writeStyle, styleOpts);
  if (!existsSync(path)) throw new Error(`video not found: ${path}`);
  const p = await ffprobe(path);
  if (!p.has_video) throw new Error("analyze needs a video with a picture track (this file has none)");
  const duration = p.duration_s;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const shots = await detectShots(path, duration);
  const avg = shots.length ? duration / shots.length : duration;
  const notes: string[] = ["Structure only: no words, frames or audio from the reference were kept."];

  let caption_band: FormatGrammar["caption_band"] = null;
  if (p.width && p.height && duration > 0) {
    try {
      caption_band = findCaptionBand(await sampleEdgeRows(path, duration, p.width, p.height));
    } catch (e) {
      notes.push(`caption band not measured: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  }
  if (caption_band) notes.push(`Burned-in text most likely sits at ${Math.round(caption_band.y_from * 100)}–${Math.round(caption_band.y_to * 100)}% of the frame height.`);
  else notes.push("No consistent burned-in text band found in the lower two-thirds.");

  let speech_ratio: number | undefined;
  let speech_pacing: FormatGrammar["speech_pacing"];
  let loudness: number | undefined;
  if (p.has_audio) {
    try {
      const sm = await speechMeasures(path, duration);
      speech_ratio = r3(sm.share);
      speech_pacing = sm.pacing;
      notes.push("speech_ratio is the share of time with voice-band sound (200–3500 Hz above -35 dBFS); music can count as speech.");
      notes.push("speech_pacing: pauses are voice-band silences of 100 ms or more inside speech (lead-in and tail excluded); tighten pacing_from uses them.");
    } catch {
      /* optional */
    }
    try {
      const l = await measureLoudness(path);
      if (l.integrated_lufs !== null && Number.isFinite(l.integrated_lufs)) loudness = Math.round(l.integrated_lufs * 10) / 10;
    } catch {
      /* optional */
    }
  } else {
    notes.push("No audio track.");
  }

  const motion_timing = await motionTimingFor(path, notes);

  const g: FormatGrammar = {
    schema_version: SCHEMA_VERSION,
    duration_sec: r3(duration),
    aspect_ratio: aspectRatioOf(p.width, p.height),
    shots,
    avg_shot_sec: r3(avg),
    cuts_per_10s: r3(duration > 0 ? ((shots.length - 1) / duration) * 10 : 0),
    hook_shot_sec: r3(shots[0] ? shots[0].end_sec - shots[0].start_sec : duration),
    has_speech: p.has_audio && (speech_ratio ?? 0) >= 0.2,
    ...(speech_ratio !== undefined ? { speech_ratio } : {}),
    ...(speech_pacing ? { speech_pacing } : {}),
    ...(loudness !== undefined ? { loudness_lufs: loudness } : {}),
    caption_band,
    pacing: pacingFor(avg),
    ...(motion_timing ? { motion_timing } : {}),
    notes,
  };
  const parsed = FormatGrammar.parse(g);
  const written = opts.writeStyle !== undefined && opts.projectDir ? await writeProjectStyle(opts.projectDir, styleFromMotion(opts.writeStyle, parsed), styleOpts) : undefined;
  const report_md = formatGrammar(parsed) + (written ? `\n\nStyle pack written: styles/${opts.writeStyle}.yaml${written.warnings.map((w) => `\n- ${w}`).join("")}` : "");
  if (opts.projectDir) {
    await writeJsonAtomic(join(opts.projectDir, "qa", "analysis.json"), parsed);
    await writeFileAtomic(join(opts.projectDir, "qa", "analysis.md"), `${report_md}\n`);
  }
  return { ...parsed, report_md, ...(written ? { style_path: written.path, style_warnings: written.warnings } : {}) };
}

export function formatGrammar(g: FormatGrammar): string {
  const band = g.caption_band ? `${Math.round(g.caption_band.y_from * 100)}–${Math.round(g.caption_band.y_to * 100)}% of height` : "none found";
  const lines = [
    "# Format grammar",
    "",
    `- Duration: ${g.duration_sec.toFixed(1)} s, aspect ${g.aspect_ratio}`,
    `- Shots: ${g.shots.length} (avg ${g.avg_shot_sec.toFixed(1)} s, ${g.cuts_per_10s.toFixed(1)} cuts per 10 s), pacing **${g.pacing}**`,
    `- Hook shot: ${g.hook_shot_sec.toFixed(1)} s`,
    `- Speech: ${g.has_speech === undefined ? "n/a" : g.has_speech ? "yes" : "no"}${g.speech_ratio !== undefined ? ` (${Math.round(g.speech_ratio * 100)}% voice-band sound)` : ""}`,
    ...(g.speech_pacing ? [`- Pauses: ${g.speech_pacing.pauses_analyzed} inside speech (${Math.round(g.speech_pacing.silence_share * 100)}% of the speech span)${g.speech_pacing.pause_median_ms !== null ? `, median ${g.speech_pacing.pause_median_ms} ms, p95 ${g.speech_pacing.pause_p95_ms} ms` : ""}`] : []),
    `- Loudness: ${g.loudness_lufs !== undefined ? `${g.loudness_lufs} LUFS` : "n/a"}`,
    `- Caption band: ${band}`,
    "",
    "Shot lengths (s): " + g.shots.map((s) => (s.end_sec - s.start_sec).toFixed(1)).join(", "),
  ];
  if (g.motion_timing) lines.push("", ...formatMotionTiming(g.motion_timing));
  if (g.notes.length) lines.push("", ...g.notes.map((n) => `- ${n}`));
  return lines.join("\n");
}

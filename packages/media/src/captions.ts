import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SceneVoiceTrack, WordTiming } from "@video-studio/schema";

/**
 * Captions are derived from one canonical word timeline (global ms from the start of the video).
 * HTML karaoke data (`toCaptionJson`), ASS `\kf` burn-in, SRT/VTT sidecars and the plain transcript
 * all come from the same `CaptionWord[]` → `CaptionLine[]`.
 */

export interface CaptionWord extends WordTiming {
  /** Scene the word belongs to (line breaks never cross scenes). */
  scene_id?: string;
}

export interface CaptionLine {
  start_ms: number;
  end_ms: number;
  text: string;
  words: CaptionWord[];
}

export interface SceneTrackPlacement {
  /** Where the scene starts in the final video. */
  scene_start_ms: number;
  track: SceneVoiceTrack;
}

/**
 * Build the global word timeline: offset each scene's words by its start, clamp them to the
 * scene's track duration, sort, drop empty words and remove overlaps (a word ends no later
 * than the next one starts), so karaoke durations are never negative.
 */
export function buildWordTimeline(scenes: readonly SceneTrackPlacement[]): CaptionWord[] {
  const out: CaptionWord[] = [];
  for (const { scene_start_ms, track } of scenes) {
    const sceneEnd = track.duration_ms > 0 ? scene_start_ms + track.duration_ms : Number.POSITIVE_INFINITY;
    for (const w of track.words) {
      const word = w.word.trim();
      if (!word) continue;
      const start = Math.min(Math.round(scene_start_ms + w.start_ms), sceneEnd);
      const end = Math.min(Math.max(Math.round(scene_start_ms + w.end_ms), start), sceneEnd);
      out.push({ word, start_ms: start, end_ms: end, scene_id: track.scene_id });
    }
  }
  out.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  for (let i = 0; i + 1 < out.length; i++) {
    const cur = out[i]!;
    const next = out[i + 1]!;
    if (cur.end_ms > next.start_ms) cur.end_ms = Math.max(cur.start_ms, next.start_ms);
  }
  return out;
}

export interface GroupOptions {
  /** Max words per line. Default 5. */
  maxWords?: number;
  /** Max characters per line including spaces. Default 32. A single longer word still gets its own line. */
  maxChars?: number;
  /** A pause longer than this starts a new line. Default 600 ms. */
  maxGapMs?: number;
  /** Break after `.`, `!`, `?` (and `…`). Default true. */
  breakOnSentence?: boolean;
}

const SENTENCE_END = /[.!?…]["'”’)\]]*$/;

/** Group words into caption lines. Breaks on: word/char limits, pauses, sentence ends and scene changes. */
export function groupCaptionLines(words: readonly CaptionWord[], opts: GroupOptions = {}): CaptionLine[] {
  const maxWords = opts.maxWords ?? 5;
  const maxChars = opts.maxChars ?? 32;
  const maxGap = opts.maxGapMs ?? 600;
  const sentence = opts.breakOnSentence ?? true;
  const lines: CaptionLine[] = [];
  let cur: CaptionWord[] = [];
  let chars = 0;
  const flush = () => {
    if (!cur.length) return;
    lines.push({ start_ms: cur[0]!.start_ms, end_ms: cur[cur.length - 1]!.end_ms, text: cur.map((w) => w.word).join(" "), words: cur });
    cur = [];
    chars = 0;
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev) {
      const brk =
        cur.length >= maxWords ||
        chars + 1 + w.word.length > maxChars ||
        w.start_ms - prev.end_ms > maxGap ||
        (sentence && SENTENCE_END.test(prev.word)) ||
        prev.scene_id !== w.scene_id;
      if (brk) flush();
    }
    chars += (cur.length ? 1 : 0) + w.word.length;
    cur.push(w);
  }
  flush();
  return lines;
}

// ---------------------------------------------------------------------------------- time formats

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

function hmsParts(ms: number): [number, number, number, number] {
  const t = Math.max(0, Math.round(ms));
  return [Math.floor(t / 3_600_000), Math.floor(t / 60_000) % 60, Math.floor(t / 1000) % 60, t % 1000];
}

/** `HH:MM:SS,mmm` */
export function srtTime(ms: number): string {
  const [h, m, s, f] = hmsParts(ms);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(f, 3)}`;
}

/** `HH:MM:SS.mmm` */
export function vttTime(ms: number): string {
  const [h, m, s, f] = hmsParts(ms);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(f, 3)}`;
}

/** ASS `H:MM:SS.cc` from centiseconds. */
export function assTimeCs(cs: number): string {
  const t = Math.max(0, Math.round(cs));
  return `${Math.floor(t / 360_000)}:${pad(Math.floor(t / 6000) % 60)}:${pad(Math.floor(t / 100) % 60)}.${pad(t % 100)}`;
}

const cs = (ms: number) => Math.round(ms / 10);

// ---------------------------------------------------------------------------------- SRT / VTT / transcript

export function toSrt(lines: readonly CaptionLine[]): string {
  return lines.map((l, i) => `${i + 1}\n${srtTime(l.start_ms)} --> ${srtTime(l.end_ms)}\n${l.text}\n`).join("\n");
}

function vttEscape(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function toVtt(lines: readonly CaptionLine[]): string {
  const cues = lines.map((l) => `${vttTime(l.start_ms)} --> ${vttTime(l.end_ms)}\n${vttEscape(l.text)}\n`);
  return `WEBVTT\n\n${cues.join("\n")}`;
}

/** Plain-text transcript: words joined with spaces, one paragraph per scene. */
export function toTranscript(words: readonly CaptionWord[]): string {
  const paras: string[][] = [];
  let scene: string | undefined | null = null;
  for (const w of words) {
    if (scene === null || w.scene_id !== scene) paras.push([]);
    scene = w.scene_id;
    paras[paras.length - 1]!.push(w.word);
  }
  return paras.map((p) => p.join(" ")).join("\n\n") + (paras.length ? "\n" : "");
}

// ---------------------------------------------------------------------------------- canonical JSON

export interface CaptionJson {
  version: 1;
  words: CaptionWord[];
  lines: { start_ms: number; end_ms: number; text: string; first_word: number; word_count: number }[];
}

/** Canonical word timeline plus line grouping, for the HTML (HyperFrames) karaoke captions. */
export function toCaptionJson(words: readonly CaptionWord[], lines: readonly CaptionLine[] = groupCaptionLines(words)): CaptionJson {
  const index = new Map(words.map((w, i) => [w, i]));
  return {
    version: 1,
    words: words.map((w) => ({ ...w })),
    lines: lines.map((l) => ({
      start_ms: l.start_ms,
      end_ms: l.end_ms,
      text: l.text,
      first_word: l.words[0] ? (index.get(l.words[0]) ?? -1) : -1,
      word_count: l.words.length,
    })),
  };
}

// ---------------------------------------------------------------------------------- ASS

export type CaptionPreset = "minimal" | "bold";

export interface AssOptions {
  /** Output video size: PlayResX/PlayResY must match it so sizes and margins are in output pixels. */
  width: number;
  height: number;
  preset?: CaptionPreset;
  font?: string;
  /** Text colour before it is spoken, `#RRGGBB`. (ASS SecondaryColour.) */
  primary?: string;
  /** Colour the karaoke sweep fills to, `#RRGGBB`. (ASS PrimaryColour.) */
  highlight?: string;
  /** Outline colour, `#RRGGBB`. */
  outline?: string;
  /** Bottom margin in px. Default: 18% of height for tall (≥ 3:2 portrait) video, 12% otherwise. */
  marginV?: number;
  fontSize?: number;
}

/** `#RRGGBB` (or `#RRGGBBAA`, AA = opacity) → ASS `&HAABBGGRR` (ASS alpha: 00 = opaque). */
export function assColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) throw new Error(`invalid colour ${hex}; expected #RRGGBB or #RRGGBBAA`);
  const rgb = m[1]!.toUpperCase();
  const alpha = m[2] ? (255 - Number.parseInt(m[2], 16)).toString(16).padStart(2, "0").toUpperCase() : "00";
  return `&H${alpha}${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`;
}

/** Make a word safe inside an ASS Dialogue: braces start override blocks and `\` starts escapes. */
export function assEscape(text: string): string {
  return text.replace(/\\/g, "/").replace(/\{/g, "(").replace(/\}/g, ")").replace(/[\r\n]+/g, " ");
}

export function defaultMarginV(width: number, height: number): number {
  return Math.round(height * (height / width >= 1.5 ? 0.18 : 0.12));
}

/**
 * Fraction of the frame height, measured from the bottom, that burned-in
 * captions can occupy: the bottom margin plus one or two rows of the largest
 * preset with line spacing and padding. Scene renderers keep content above
 * this band so captions never overlap on-screen graphics.
 */
export function captionReserveFraction(width: number, height: number): number {
  const lineHeight = Math.min(width, height) * 0.08 * 1.3;
  // Tall video wraps a caption line onto two rows; wider frames fit one.
  const rows = height / width >= 1.5 ? 2 : 1;
  return (defaultMarginV(width, height) + rows * lineHeight + height * 0.02) / height;
}

/** Style values for a preset at a given output size. */
export function assStyle(o: AssOptions): { fontSize: number; bold: boolean; outline: number; shadow: number; marginV: number; marginLR: number } {
  const preset = o.preset ?? "minimal";
  const short = Math.min(o.width, o.height);
  const bold = preset === "bold";
  return {
    fontSize: o.fontSize ?? Math.max(8, Math.round(short * (bold ? 0.08 : 0.06))),
    bold,
    outline: Math.max(1, Math.round(short * (bold ? 0.006 : 0.003))),
    shadow: bold ? Math.max(1, Math.round(short * 0.003)) : 0,
    marginV: o.marginV ?? defaultMarginV(o.width, o.height),
    marginLR: Math.round(o.width * 0.06),
  };
}

/** Karaoke text for one line: `{\kf<cs>}word ` per word, with `{\k<cs>}` for pauses, in centiseconds from the line start. */
export function assKaraokeText(line: CaptionLine): string {
  const base = cs(line.start_ms);
  let cursor = base;
  const parts: string[] = [];
  line.words.forEach((w, i) => {
    const s = Math.max(cs(w.start_ms), cursor);
    const e = Math.max(cs(w.end_ms), s);
    if (s > cursor) parts.push(`{\\k${s - cursor}}`);
    parts.push(`{\\kf${e - s}}${assEscape(w.word)}${i < line.words.length - 1 ? " " : ""}`);
    cursor = e;
  });
  return parts.join("");
}

export function toAss(lines: readonly CaptionLine[], o: AssOptions): string {
  if (!(o.width > 0 && o.height > 0)) throw new Error("toAss: width and height are required");
  const st = assStyle(o);
  const font = (o.font ?? "Arial").replace(/,/g, " ");
  const base = assColor(o.primary ?? "#FFFFFF");
  const hi = assColor(o.highlight ?? (o.preset === "bold" ? "#FFD60A" : "#FFFFFF"));
  const outline = assColor(o.outline ?? "#000000");
  const back = assColor("#00000080");
  const style = [
    "Default",
    font,
    st.fontSize,
    hi, // PrimaryColour: the karaoke fill (spoken)
    base, // SecondaryColour: before the sweep reaches the word
    outline,
    back,
    st.bold ? -1 : 0,
    0,
    0,
    0,
    100,
    100,
    0,
    0,
    1,
    st.outline,
    st.shadow,
    2, // bottom centre
    st.marginLR,
    st.marginLR,
    st.marginV,
    1,
  ].join(",");
  const header = [
    "[Script Info]",
    "; Generated by video-studio",
    "ScriptType: v4.00+",
    `PlayResX: ${o.width}`,
    `PlayResY: ${o.height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: ${style}`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events = lines.map((l) => `Dialogue: 0,${assTimeCs(cs(l.start_ms))},${assTimeCs(cs(l.end_ms))},Default,,0,0,0,,${assKaraokeText(l)}`);
  return `${[...header, ...events].join("\n")}\n`;
}

// ---------------------------------------------------------------------------------- writing a caption set

export interface CaptionSetOptions extends GroupOptions {
  ass?: AssOptions;
}

export interface CaptionSetFiles {
  json: string;
  srt: string;
  vtt: string;
  txt: string;
  ass?: string;
}

/** Write `<base>.json|.srt|.vtt|.txt` (and `.ass` when `ass` options are given) into `dir`. */
export async function writeCaptionSet(dir: string, base: string, words: readonly CaptionWord[], opts: CaptionSetOptions = {}): Promise<CaptionSetFiles> {
  await mkdir(dir, { recursive: true });
  const lines = groupCaptionLines(words, opts);
  const files: CaptionSetFiles = {
    json: join(dir, `${base}.json`),
    srt: join(dir, `${base}.srt`),
    vtt: join(dir, `${base}.vtt`),
    txt: join(dir, `${base}.txt`),
  };
  await writeFile(files.json, `${JSON.stringify(toCaptionJson(words, lines), null, 2)}\n`);
  await writeFile(files.srt, toSrt(lines));
  await writeFile(files.vtt, toVtt(lines));
  await writeFile(files.txt, toTranscript(words));
  if (opts.ass) {
    files.ass = join(dir, `${base}.ass`);
    await writeFile(files.ass, toAss(lines, opts.ass));
  }
  return files;
}

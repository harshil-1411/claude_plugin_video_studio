import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SceneVoiceTrack, WordTiming } from "@video-studio/schema";

/**
 * Captions are derived from one canonical word timeline (global ms from the start of the video).
 * HTML caption data (`toCaptionJson`), ASS burn-in, SRT/VTT sidecars and the plain transcript
 * all come from the same `CaptionWord[]` → `CaptionLine[]`.
 *
 * Caption engine defaults (v2 report, PLAN M5): phrase-level captions of 3–7 words on at most
 * 2 rows, broken at punctuation and before conjunctions, a minimum display time, a
 * semi-opaque plate behind the text and 1–2 emphasised keywords per caption. Karaoke
 * (`\kf` word sweep) only when asked for (`activeWord`, brand `captions.active_word`).
 */

export interface CaptionWord extends WordTiming {
  /** Scene the word belongs to (captions never cross scenes). */
  scene_id?: string;
}

/** One caption (cue): a phrase shown on 1..maxLines rows. */
export interface CaptionLine {
  start_ms: number;
  end_ms: number;
  /** The caption's words joined with spaces (rows are not marked). */
  text: string;
  words: CaptionWord[];
  /** Words per display row, summing to `words.length`. Absent: one row. */
  row_sizes?: number[];
  /** Indices into `words` of emphasised keywords (0–2). */
  emphasis?: number[];
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

// ---------------------------------------------------------------------------------- grouping

export interface GroupOptions {
  /** Fewest words per caption when the phrase allows it. Default 3. */
  minWords?: number;
  /** Max words per caption. Default 7. */
  maxWords?: number;
  /** Max characters per row including spaces. Default 32. A single longer word still gets its own row. */
  maxChars?: number;
  /** Max rows per caption (brand `captions.max_lines`, 1–3). Default 2. */
  maxLines?: number;
  /** A pause longer than this starts a new caption. Default 600 ms. */
  maxGapMs?: number;
  /** Always break after `.`, `!`, `?` (and `…`). Default true. */
  breakOnSentence?: boolean;
  /** Shortest time a caption stays up (it never runs into the next one). Default 800 ms. */
  minDisplayMs?: number;
  /** Gaps between captions shorter than this are closed by holding the earlier caption. Default 250 ms. */
  holdGapMs?: number;
  /** End of the video: captions are never held past it. */
  endMs?: number;
  /** Pick 1–2 keywords per caption for emphasis. Default true. */
  emphasis?: boolean;
}

const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
const CLAUSE_END = /[,;:—–-]["'”’)\]]*$/;
/** A caption or row may start with these (a clause boundary). */
const CONJUNCTIONS = new Set(
  "and but or nor so yet because since although though while whereas when whenever where which who whom whose that then unless until if instead".split(" "),
);
/** Never end a caption or row on these: they belong to the next word. */
const DANGLING = new Set("a an the of to in on at by for from with into onto as than my your our their its his her this these those".split(" "));
const STOPWORDS = new Set(
  (
    "a an and are as at be been being but by can could did do does for from had has have how i if in into is it its just like me more most my no not of on one only or our out over so some such than that the their them then there these they this those to too up us very was we were what when where which while who why will with would you your also about after all any because before both each few here her him his she he own same should through under until again further once off down new get got make made use used way really thing things lot"
  ).split(" "),
);

const core = (word: string) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
const charsOf = (ws: readonly CaptionWord[], from: number, to: number) => {
  let n = 0;
  for (let i = from; i < to; i++) n += Array.from(ws[i]!.word).length + (i > from ? 1 : 0);
  return n;
};

/** Cost of a break between `ws[i-1]` and `ws[i]` (0 = natural). */
function breakCost(ws: readonly CaptionWord[], i: number): number {
  const prev = ws[i - 1]!.word;
  const next = core(ws[i]!.word).toLowerCase();
  if (SENTENCE_END.test(prev) || CLAUSE_END.test(prev)) return 0;
  let c = CONJUNCTIONS.has(next) ? 1 : 4;
  if (DANGLING.has(core(prev).toLowerCase())) c += 3;
  return c;
}

interface RowPlan {
  sizes: number[];
  cost: number;
}

/**
 * Best split of `ws[from..to)` into ≤ maxLines rows of ≤ maxChars (a lone over-long word is
 * allowed): balanced rows, natural breaks, no 1-word orphan row when the caption has 3+ words.
 * Null when the words cannot fit.
 */
function planRows(ws: readonly CaptionWord[], from: number, to: number, maxChars: number, maxLines: number): RowPlan | null {
  const n = to - from;
  const rowOk = (a: number, b: number) => b - a === 1 || charsOf(ws, a, b) <= maxChars;
  if (rowOk(from, to)) return { sizes: [n], cost: 0 };
  let best: RowPlan | null = null;
  const walk = (start: number, sizes: number[], cost: number) => {
    if (sizes.length === maxLines) return;
    for (let end = start + 1; end <= to; end++) {
      if (!rowOk(start, end)) break;
      const next = [...sizes, end - start];
      if (end === to) {
        if (next.length < 2) continue;
        const lens = next.map((_, k) => {
          const a = from + next.slice(0, k).reduce((s, x) => s + x, 0);
          return charsOf(ws, a, a + next[k]!);
        });
        const imbalance = ((Math.max(...lens) - Math.min(...lens)) / maxChars) * 3;
        const orphans = n >= 3 ? next.filter((x) => x === 1).length * 5 : 0;
        const total = cost + imbalance + orphans + (next.length - 1);
        if (!best || total < best.cost) best = { sizes: next, cost: total };
      } else {
        walk(end, next, cost + breakCost(ws, end) * 0.5);
      }
    }
  };
  walk(from, [], 0);
  return best;
}

/** 1–2 salient words: numbers, acronyms and capitalised terms first, else the longest non-stopword. */
export function pickEmphasis(words: readonly CaptionWord[], prevWord?: string): number[] {
  const scored: { i: number; score: number }[] = [];
  words.forEach((w, i) => {
    const c = core(w.word);
    if (!c) return;
    const lower = c.toLowerCase();
    const sentenceStart = i === 0 ? !prevWord || SENTENCE_END.test(prevWord) : SENTENCE_END.test(words[i - 1]!.word);
    const len = Array.from(c).length;
    let score = 0;
    if (/\p{N}/u.test(c)) score = 100 + len;
    else if (STOPWORDS.has(lower)) score = 0;
    else if (/^\p{Lu}{2,}s?$/u.test(c)) score = 60 + len;
    else if (/^\p{Lu}/u.test(c) && !sentenceStart) score = 50 + len;
    else if (len >= 4) score = len;
    if (score > 0) scored.push({ i, score });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const out = scored.slice(0, 1).map((s) => s.i);
  const second = scored[1];
  if (second && words.length >= 5 && second.score >= 50) out.push(second.i);
  return out.sort((a, b) => a - b);
}

/**
 * Group words into captions. Hard breaks: scene changes, pauses over `maxGapMs`, sentence ends.
 * Inside a phrase, captions of `minWords`–`maxWords` words that fit `maxLines` rows are chosen
 * to minimise a cost that prefers ~5 words, breaks after punctuation or before a conjunction,
 * and never ends on an article or preposition. Then timing is smoothed: short gaps are held
 * over and each caption stays up at least `minDisplayMs` unless the next one starts sooner.
 */
export function groupCaptionLines(words: readonly CaptionWord[], opts: GroupOptions = {}): CaptionLine[] {
  const minWords = Math.max(1, opts.minWords ?? 3);
  const maxWords = Math.max(minWords, opts.maxWords ?? 7);
  const maxChars = Math.max(1, opts.maxChars ?? 32);
  const maxLines = Math.min(3, Math.max(1, opts.maxLines ?? 2));
  const maxGap = opts.maxGapMs ?? 600;
  const sentence = opts.breakOnSentence ?? true;
  const emphasis = opts.emphasis ?? true;

  // 1. runs between hard breaks
  const runs: CaptionWord[][] = [];
  let run: CaptionWord[] = [];
  for (const w of words) {
    const prev = run[run.length - 1];
    if (prev && (w.start_ms - prev.end_ms > maxGap || (sentence && SENTENCE_END.test(prev.word)) || prev.scene_id !== w.scene_id)) {
      runs.push(run);
      run = [];
    }
    run.push(w);
  }
  if (run.length) runs.push(run);

  // 2. best partition of each run (DP over cue ends)
  const lines: CaptionLine[] = [];
  for (const ws of runs) {
    const n = ws.length;
    const best: { cost: number; from: number; rows: number[] }[] = [{ cost: 0, from: -1, rows: [] }];
    for (let i = 1; i <= n; i++) {
      let pick: { cost: number; from: number; rows: number[] } | undefined;
      for (let j = i - 1; j >= 0 && i - j <= maxWords; j--) {
        const prior = best[j];
        if (!prior || !Number.isFinite(prior.cost)) continue;
        const rows = planRows(ws, j, i, maxChars, maxLines);
        if (!rows) continue;
        const k = i - j;
        const size = (k < minWords ? 6 * (minWords - k) : 0) + 0.3 * (k - 5) ** 2;
        const cost = prior.cost + 3 + size + rows.cost + (i < n ? breakCost(ws, i) : 0);
        if (!pick || cost < pick.cost) pick = { cost, from: j, rows: rows.sizes };
      }
      // A single word always fits on its own (over-long words are allowed alone).
      best[i] = pick ?? { cost: best[i - 1]!.cost + 100, from: i - 1, rows: [1] };
    }
    const cues: CaptionLine[] = [];
    for (let i = n; i > 0; i = best[i]!.from) {
      const { from, rows } = best[i]!;
      const cw = ws.slice(from, i);
      cues.unshift({
        start_ms: cw[0]!.start_ms,
        end_ms: cw[cw.length - 1]!.end_ms,
        text: cw.map((w) => w.word).join(" "),
        words: cw,
        ...(rows.length > 1 ? { row_sizes: rows } : {}),
      });
    }
    lines.push(...cues);
  }

  // 3. emphasis and timing
  const minDisplay = opts.minDisplayMs ?? 800;
  const holdGap = opts.holdGapMs ?? 250;
  lines.forEach((l, i) => {
    if (emphasis) {
      const prev = lines[i - 1]?.words.at(-1)?.word;
      const e = pickEmphasis(l.words, prev);
      if (e.length) l.emphasis = e;
    }
    const next = lines[i + 1];
    const limit = Math.min(next ? next.start_ms : Number.POSITIVE_INFINITY, opts.endMs ?? Number.POSITIVE_INFINITY);
    let end = Math.max(l.end_ms, l.start_ms + minDisplay);
    if (next && next.start_ms - l.end_ms < holdGap) end = Math.max(end, next.start_ms);
    l.end_ms = Math.max(l.end_ms, Math.min(end, limit));
  });
  return lines;
}

/** The caption's display rows (words joined per row). */
export function captionRows(line: CaptionLine): string[] {
  const sizes = line.row_sizes ?? [line.words.length];
  const rows: string[] = [];
  let at = 0;
  for (const n of sizes) {
    rows.push(line.words.slice(at, at + n).map((w) => w.word).join(" "));
    at += n;
  }
  return line.words.length ? rows : [line.text];
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
  return lines.map((l, i) => `${i + 1}\n${srtTime(l.start_ms)} --> ${srtTime(l.end_ms)}\n${captionRows(l).join("\n")}\n`).join("\n");
}

function vttEscape(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function toVtt(lines: readonly CaptionLine[]): string {
  const cues = lines.map((l) => `${vttTime(l.start_ms)} --> ${vttTime(l.end_ms)}\n${vttEscape(captionRows(l).join("\n"))}\n`);
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
  lines: {
    start_ms: number;
    end_ms: number;
    text: string;
    first_word: number;
    word_count: number;
    /** Display rows (≤ max lines). */
    rows: string[];
    /** Emphasised words, as indices into `words`. */
    emphasis: number[];
  }[];
}

/** Canonical word timeline plus caption grouping, for the HTML (HyperFrames) captions. */
export function toCaptionJson(words: readonly CaptionWord[], lines: readonly CaptionLine[] = groupCaptionLines(words)): CaptionJson {
  const index = new Map(words.map((w, i) => [w, i]));
  return {
    version: 1,
    words: words.map((w) => ({ ...w })),
    lines: lines.map((l) => {
      const first = l.words[0] ? (index.get(l.words[0]) ?? -1) : -1;
      return {
        start_ms: l.start_ms,
        end_ms: l.end_ms,
        text: l.text,
        first_word: first,
        word_count: l.words.length,
        rows: captionRows(l),
        emphasis: first >= 0 ? (l.emphasis ?? []).map((i) => first + i) : [],
      };
    }),
  };
}

// ---------------------------------------------------------------------------------- ASS

export type CaptionPreset = "minimal" | "bold";

/** A rectangle in output pixels. */
export interface CaptionBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AssOptions {
  /** Output video size: PlayResX/PlayResY must match it so sizes and margins are in output pixels. */
  width: number;
  height: number;
  preset?: CaptionPreset;
  font?: string;
  /** Text colour, `#RRGGBB` (before the sweep, in karaoke mode). */
  primary?: string;
  /** Emphasis colour, and the colour the karaoke sweep fills to, `#RRGGBB`. */
  highlight?: string;
  /** Outline colour when there is no plate, `#RRGGBB`. */
  outline?: string;
  /** Bottom margin in px when no `box` is given. Default: 18% of height for tall (≥ 3:2 portrait) video, 12% otherwise. */
  marginV?: number;
  /** Font size in px (still shrunk to fit `box`). Default from the preset. */
  fontSize?: number;
  /** Region the caption block must stay inside (e.g. `LayoutZones.caption`). Block is bottom-aligned in it. */
  box?: CaptionBox;
  /** Vertical centre of the block as a fraction of frame height (spec `captions.position.y`); overrides bottom alignment. */
  positionY?: number;
  /** Bold text. Default: the preset's (bold preset → true); brand weight ≥ 600 → true. */
  bold?: boolean;
  /** Plate opacity 0–1 behind each row (0 = outline only). Default 0.55. */
  plateOpacity?: number;
  /** Plate colour `#RRGGBB`. Default black. */
  plateColor?: string;
  /** Karaoke word sweep (`\kf`). Default false: static text with keyword emphasis. */
  activeWord?: boolean;
  /** Style the captions' `emphasis` words. Default true. */
  emphasis?: boolean;
  /** Rows per caption the layout reserves space for. Default 2. */
  maxLines?: number;
}

/** `#RRGGBB` (or `#RRGGBBAA`, AA = opacity) → ASS `&HAABBGGRR` (ASS alpha: 00 = opaque). */
export function assColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) throw new Error(`invalid colour ${hex}; expected #RRGGBB or #RRGGBBAA`);
  const rgb = m[1]!.toUpperCase();
  const alpha = m[2] ? (255 - Number.parseInt(m[2], 16)).toString(16).padStart(2, "0").toUpperCase() : "00";
  return `&H${alpha}${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`;
}

/** `#RRGGBB` → an override-tag colour `&HBBGGRR&` (for `\c`). */
function assTagColor(hex: string): string {
  return `${assColor(hex.slice(0, 7)).replace(/^&H00/, "&H")}&`;
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
 * @deprecated Renderers use `LayoutZones.caption`; kept until text-layout migrates.
 */
export function captionReserveFraction(width: number, height: number): number {
  const lineHeight = Math.min(width, height) * 0.08 * 1.3;
  // Tall video wraps a caption line onto two rows; wider frames fit one.
  const rows = height / width >= 1.5 ? 2 : 1;
  return (defaultMarginV(width, height) + rows * lineHeight + height * 0.02) / height;
}

/** Default plate opacity behind caption rows. */
export const DEFAULT_PLATE_OPACITY = 0.55;
/** libass line advance per px of font size (ascent + descent of typical sans fonts). */
const LINE_ADVANCE = 1.22;
/** Average glyph advance per px of font size, for row width estimates. */
const GLYPH_EM = { regular: 0.54, bold: 0.58 } as const;

/** Style values for a preset at a given output size. */
export function assStyle(o: AssOptions): { fontSize: number; bold: boolean; outline: number; shadow: number; marginV: number; marginLR: number } {
  const preset = o.preset ?? "minimal";
  const short = Math.min(o.width, o.height);
  const bold = o.bold ?? preset === "bold";
  return {
    fontSize: o.fontSize ?? Math.max(8, Math.round(short * (preset === "bold" ? 0.08 : 0.06))),
    bold,
    outline: Math.max(1, Math.round(short * (preset === "bold" ? 0.006 : 0.003))),
    shadow: preset === "bold" ? Math.max(1, Math.round(short * 0.003)) : 0,
    marginV: o.marginV ?? defaultMarginV(o.width, o.height),
    marginLR: Math.round(o.width * 0.06),
  };
}

/** Where and how large captions are drawn, before any caption text is known. */
export interface CaptionLayout {
  fontSize: number;
  bold: boolean;
  /** Plate padding around each row (the ASS outline width when a plate is drawn). */
  pad: number;
  plate: boolean;
  lineAdvance: number;
  /** Max characters per row that fit the region (feed to `groupCaptionLines`). */
  maxChars: number;
  maxLines: number;
  /** Region the block stays inside. */
  region: CaptionBox;
  /** Block anchor: bottom of `region`, or centred on `y` px. */
  anchor: { kind: "bottom" } | { kind: "center"; y: number };
}

export function captionLayout(o: AssOptions): CaptionLayout {
  const st = assStyle(o);
  const maxLines = Math.min(3, Math.max(1, o.maxLines ?? 2));
  const opacity = Math.min(1, Math.max(0, o.plateOpacity ?? DEFAULT_PLATE_OPACITY));
  const plate = opacity > 0;
  const padFor = (size: number) => (plate ? Math.max(2, Math.round(size * 0.22)) : st.outline);
  const blockH = (size: number) => maxLines * size * LINE_ADVANCE + 2 * padFor(size);
  let fontSize = st.fontSize;
  let region: CaptionBox;
  if (o.box) {
    region = { x: Math.round(o.box.x), y: Math.round(o.box.y), w: Math.round(o.box.w), h: Math.round(o.box.h) };
    // Shrink the font until maxLines rows (with the plate) fit the box height.
    while (fontSize > 8 && blockH(fontSize) > region.h) fontSize--;
  } else {
    const h = Math.round(blockH(fontSize));
    const bottom = o.height - st.marginV;
    region = { x: st.marginLR, y: bottom - h, w: o.width - 2 * st.marginLR, h };
  }
  const pad = padFor(fontSize);
  const em = st.bold ? GLYPH_EM.bold : GLYPH_EM.regular;
  const maxChars = Math.max(4, Math.floor((region.w - 2 * pad) / (fontSize * em)));
  const anchor = o.positionY !== undefined ? ({ kind: "center", y: Math.round(Math.min(1, Math.max(0, o.positionY)) * o.height) } as const) : ({ kind: "bottom" } as const);
  return { fontSize, bold: st.bold, pad, plate, lineAdvance: fontSize * LINE_ADVANCE, maxChars, maxLines, region, anchor };
}

/**
 * Box the burned-in captions actually occupy (union over all captions, plate included), in
 * output pixels, clamped to the frame. With no captions, the space reserved for `maxLines` rows.
 */
export function captionBlockBox(lines: readonly CaptionLine[], layout: CaptionLayout, frame: { width: number; height: number }): CaptionBox {
  const em = layout.bold ? GLYPH_EM.bold : GLYPH_EM.regular;
  let w = 0;
  let rows = 0;
  for (const l of lines) {
    const r = captionRows(l);
    rows = Math.max(rows, r.length);
    for (const row of r) w = Math.max(w, Array.from(row).length * layout.fontSize * em);
  }
  if (!lines.length) {
    rows = layout.maxLines;
    w = layout.region.w - 2 * layout.pad;
  }
  const bw = Math.min(frame.width, Math.ceil(w + 2 * layout.pad));
  const bh = Math.ceil(rows * layout.lineAdvance + 2 * layout.pad);
  const cx = layout.region.x + layout.region.w / 2;
  const top = layout.anchor.kind === "center" ? layout.anchor.y - bh / 2 : layout.region.y + layout.region.h - bh;
  const x = Math.max(0, Math.round(cx - bw / 2));
  const y = Math.max(0, Math.min(frame.height - bh, Math.round(top)));
  return { x, y, w: Math.min(bw, frame.width - x), h: Math.min(bh, frame.height - y) };
}

/** Karaoke text for one caption: `{\kf<cs>}word` per word, `{\k<cs>}` for pauses, rows joined with `\N`. */
export function assKaraokeText(line: CaptionLine, emphasis?: { on: string; off: string }): string {
  const base = cs(line.start_ms);
  let cursor = base;
  const parts: string[] = [];
  const breaks = rowBreaks(line);
  const em = new Set(typeof emphasis === "object" ? (line.emphasis ?? []) : []);
  line.words.forEach((w, i) => {
    const s = Math.max(cs(w.start_ms), cursor);
    const e = Math.max(cs(w.end_ms), s);
    if (s > cursor) parts.push(`{\\k${s - cursor}}`);
    const word = em.has(i) ? emphasize(w.word, emphasis!) : assEscape(w.word);
    parts.push(`{\\kf${e - s}}${word}${i < line.words.length - 1 ? (breaks.has(i + 1) ? "\\N" : " ") : ""}`);
    cursor = e;
  });
  return parts.join("");
}

/** Wrap a word's letters/digits (not its surrounding punctuation) in emphasis overrides. */
function emphasize(word: string, e: { on: string; off: string }): string {
  const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u.exec(word);
  if (!m || !m[2]) return assEscape(word);
  return `${assEscape(m[1]!)}{${e.on}}${assEscape(m[2])}{${e.off}}${assEscape(m[3]!)}`;
}

/** Word indices that start a new row. */
function rowBreaks(line: CaptionLine): Set<number> {
  const out = new Set<number>();
  let at = 0;
  for (const n of (line.row_sizes ?? []).slice(0, -1)) out.add((at += n));
  return out;
}

/** Static caption text: rows joined with `\N`, emphasised words wrapped in `on`/`off` overrides. */
export function assStaticText(line: CaptionLine, emphasis?: { on: string; off: string }): string {
  const breaks = rowBreaks(line);
  const em = new Set(emphasis ? (line.emphasis ?? []) : []);
  return line.words
    .map((w, i) => {
      const word = em.has(i) ? emphasize(w.word, emphasis!) : assEscape(w.word);
      return `${i > 0 ? (breaks.has(i) ? "\\N" : " ") : ""}${word}`;
    })
    .join("");
}

/**
 * ASS captions: a plate (BorderStyle 3, opaque box per row) unless `plateOpacity` is 0,
 * keyword emphasis in the highlight colour (bold too when the text is not already bold), and
 * the karaoke sweep only with `activeWord`. Rows are pre-broken (`WrapStyle: 2`, no libass
 * wrapping) and the block is bottom-aligned in `box` (or the legacy bottom margin), or centred
 * on `positionY`. See `captionLayout`/`captionBlockBox` for the geometry.
 */
export function toAss(lines: readonly CaptionLine[], o: AssOptions): string {
  if (!(o.width > 0 && o.height > 0)) throw new Error("toAss: width and height are required");
  const st = assStyle(o);
  const layout = captionLayout(o);
  const font = (o.font ?? "Arial").replace(/,/g, " ");
  const baseHex = o.primary ?? "#FFFFFF";
  const hiHex = o.highlight ?? "#FFD60A";
  const karaoke = o.activeWord ?? false;
  const opacity = Math.min(1, Math.max(0, o.plateOpacity ?? DEFAULT_PLATE_OPACITY));
  const plateAlpha = Math.round(opacity * 255).toString(16).padStart(2, "0");
  const border = layout.plate ? assColor(`${o.plateColor ?? "#000000"}${plateAlpha}`) : assColor(o.outline ?? "#000000");
  const { region } = layout;
  const style = [
    "Default",
    font,
    layout.fontSize,
    assColor(karaoke ? hiHex : baseHex), // PrimaryColour: text (karaoke: the sweep fill)
    assColor(baseHex), // SecondaryColour: karaoke text before the sweep
    border, // OutlineColour: the plate with BorderStyle 3
    layout.plate ? border : assColor("#00000080"),
    layout.bold ? -1 : 0,
    0,
    0,
    0,
    100,
    100,
    0,
    0,
    layout.plate ? 3 : 1,
    layout.pad,
    layout.plate ? 0 : st.shadow,
    2, // bottom centre
    region.x,
    Math.max(0, o.width - region.x - region.w),
    Math.max(0, o.height - region.y - region.h + layout.pad),
    1,
  ].join(",");
  const header = [
    "[Script Info]",
    "; Generated by video-studio",
    "ScriptType: v4.00+",
    `PlayResX: ${o.width}`,
    `PlayResY: ${o.height}`,
    "WrapStyle: 2",
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
  const emphasisOn = o.emphasis ?? true;
  // Karaoke already colours spoken words: emphasis there is bold only. Static text: colour (+ bold).
  // (Karaoke on bold text has no emphasis left to add: the sweep carries it.)
  const em = !emphasisOn || (karaoke && layout.bold)
    ? undefined
    : karaoke
      ? { on: "\\b1", off: "\\b0" }
      : { on: `\\c${assTagColor(hiHex)}${layout.bold ? "" : "\\b1"}`, off: `\\c${assTagColor(baseHex)}${layout.bold ? "" : "\\b0"}` };
  const pos = layout.anchor.kind === "center" ? `{\\an5\\pos(${Math.round(region.x + region.w / 2)},${layout.anchor.y})}` : "";
  const events = lines.map(
    (l) => `Dialogue: 0,${assTimeCs(cs(l.start_ms))},${assTimeCs(cs(l.end_ms))},Default,,0,0,0,,${pos}${karaoke ? assKaraokeText(l, em) : assStaticText(l, em)}`,
  );
  return `${[...header, ...events].join("\n")}\n`;
}

// ---------------------------------------------------------------------------------- writing a caption set

export interface CaptionSetOptions extends GroupOptions {
  /** Also write `.ass` burn-in captions; grouping then uses the layout's row width unless `maxChars` is set. */
  ass?: AssOptions;
}

export interface CaptionSetFiles {
  json: string;
  srt: string;
  vtt: string;
  txt: string;
  ass?: string;
}

/** Where burned-in captions ended up, for the manifest and lint. */
export interface CaptionPlacement {
  box: CaptionBox;
  max_lines: number;
  font_size: number;
}

export interface CaptionSetResult {
  files: CaptionSetFiles;
  lines: CaptionLine[];
  /** Present when `.ass` was written. */
  placement?: CaptionPlacement;
}

/** Write `<base>.json|.srt|.vtt|.txt` (and `.ass` when `ass` options are given) into `dir`. */
export async function writeCaptionSet(dir: string, base: string, words: readonly CaptionWord[], opts: CaptionSetOptions = {}): Promise<CaptionSetResult> {
  await mkdir(dir, { recursive: true });
  const { ass, ...group } = opts;
  const maxLines = Math.min(3, Math.max(1, opts.maxLines ?? ass?.maxLines ?? 2));
  const layout = ass ? captionLayout({ ...ass, maxLines }) : undefined;
  const lines = groupCaptionLines(words, { ...group, maxLines, ...(layout && opts.maxChars === undefined ? { maxChars: layout.maxChars } : {}) });
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
  if (!ass || !layout) return { files, lines };
  files.ass = join(dir, `${base}.ass`);
  await writeFile(files.ass, toAss(lines, { ...ass, maxLines }));
  return { files, lines, placement: { box: captionBlockBox(lines, layout, ass), max_lines: maxLines, font_size: layout.fontSize } };
}

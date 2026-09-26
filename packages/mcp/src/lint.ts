import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { projectPaths, readJson, writeFileAtomic, writeJsonAtomic } from "@video-studio/core";
import { type LayoutZones, type PxRect, type TargetMask, findPlatformSpecsDir, intersect, layoutZones, loadContracts, maskCollisions } from "@video-studio/platforms";
import {
  Brand,
  type PlatformContract,
  type PxBox,
  type TextBox,
  type TextRole,
  VideoSpec,
  parseYamlOrJson,
  propsText,
  resolveMaster,
  resolveTargets,
  voiceMode,
  MIN_CUE_GAP_MS,
} from "@video-studio/schema";
import { REFRAME, type Script, dominantScript, fittedFrame, languageScript, scriptsIn, subjectEdgeHits } from "@video-studio/renderer";
import { projectSpecPaths } from "./spec-validate.js";

/**
 * Platform lint: checks a planned (and ideally rendered) project against the contracts of its
 * targets and the design rules. Read-only apart from `qa/lint.{json,md}`. Every finding carries
 * an actionable `fix` that the lint skill applies to the spec before re-rendering.
 *
 * Platform numbers come only from the contracts (`platform-specs/*.yaml`); the constants below
 * are video-studio design rules, not platform facts.
 */

/** Words per second above which captions get hard to read (design rule). */
export const MAX_WORDS_PER_SEC = 3.3;
/**
 * On-screen reading speed for videos without narration (design rule): viewers read silently and
 * the text is the whole message, so allow a little less than spoken captions plus a 1 s settle.
 */
export const MAX_ONSCREEN_WORDS_PER_SEC = 3;
export const ONSCREEN_SETTLE_SEC = 1;
/**
 * Reading limits for other scripts (design rules). CJK is counted in characters: about 9
 * characters/s is the comfortable caption reading limit for Japanese and Chinese (narration runs
 * 7–8 characters/s), 8 characters/s for silent on-screen text. Devanagari, Arabic and Hebrew are
 * counted in words, a little below the Latin limit (Hindi words carry more syllables; Arabic
 * words fold in articles and prepositions).
 */
export const MAX_CJK_CHARS_PER_SEC = 9;
export const MAX_ONSCREEN_CJK_CHARS_PER_SEC = 8;
export const MAX_WORDS_PER_SEC_BY_SCRIPT: Readonly<Partial<Record<Script, number>>> = Object.freeze({ devanagari: 3, arabic: 2.8, hebrew: 3, hangul: 3, other: 3 });
/** CJK cover headlines: full-width characters are about twice as wide as Latin letters. */
export const COVER_HEADLINE_MAX_CJK_CHARS = 16;
/** WCAG 2.x contrast minimums (AA): normal text and large text. */
export const CONTRAST_NORMAL = 4.5;
export const CONTRAST_LARGE = 3;
/**
 * "Large text" is 24 px CSS (18 pt) on a ~533 px-tall phone viewport, i.e. about 4.5% of the
 * frame height once a 9:16 video fills the screen; applied to every aspect as an approximation.
 */
export const LARGE_TEXT_FRACTION = 0.045;
/** Cover headlines longer than this are hard to read in a grid thumbnail (design rule). */
export const COVER_HEADLINE_MAX_WORDS = 7;
export const COVER_HEADLINE_MAX_CHARS = 40;

/**
 * Caption timing (design rules). A caption needs about 0.25 s per word plus a 0.3 s settle to be
 * read, and never less than 0.7 s; CJK captions are read by characters at MAX_CJK_CHARS_PER_SEC,
 * and other word scripts scale the per-word time by their reading limit.
 */
export const CAPTION_SEC_PER_WORD = 0.25;
export const CAPTION_SETTLE_SEC = 0.3;
export const CAPTION_MIN_SEC = 0.7;
/** A caption may lead its first spoken word by at most this much, and trail its last by at most CAPTION_LATE_MS. */
export const CAPTION_EARLY_MS = 250;
export const CAPTION_LATE_MS = 400;
/** The caption engine keeps every caption up at least this long (media `minDisplayMs` default); not drift. */
export const CAPTION_MIN_DISPLAY_MS = 800;
/** Speech with no caption on screen for longer than this, while captions are on, is a gap. */
export const UNCAPTIONED_SPEECH_MS = 1500;
/** Two captions separated by less than this flicker; they should touch. */
export const CAPTION_FLICKER_MS = 120;
/** Default beat-sync tolerance (spec audio.beat_sync.tolerance_ms overrides it). */
export const BEAT_TOLERANCE_MS = 250;
/** On-screen text counts as "said" when this share of its words is in the scene's voiceover. */
export const ONSCREEN_SPOKEN_SHARE = 0.6;
/** The tension (question, problem, claim, story) should be set up within this share of the video. */
export const STORY_SETUP_FRACTION = 0.4;
/** Cutaway rhythm over a talking head: no cutaway in the hook's first second, 3–10 s each, 2 s of face between. */
export const CUTAWAY = { hook_sec: 1, min_sec: 3, max_sec: 10, face_gap_sec: 2 } as const;
/** Caption cues for sound events carry this scene_id prefix (pipeline SOUND_CUE_SCENE_PREFIX). */
const SOUND_CUE_PREFIX = "sound:";

/** Roles whose overflow or low contrast is an error (v2 design grid: hard failure for hook/caption). */
const CRITICAL_ROLES: ReadonlySet<TextRole> = new Set(["hook", "headline", "caption", "cta"]);

export type LintSeverity = "error" | "warning";
export type LintQuality = "preview" | "final";

export interface LintFinding {
  id: string;
  severity: LintSeverity;
  target?: string;
  scene_id?: string;
  message: string;
  fix: string;
}

export interface LintResult {
  status: "pass" | "warn" | "fail";
  quality: LintQuality;
  targets: string[];
  /** Whether a render of `quality` was found (text boxes, render duration and caption box checked). */
  rendered: boolean;
  counts: { errors: number; warnings: number };
  findings: LintFinding[];
  report_json: string;
  report_md: string;
}

export interface LintOptions {
  quality?: LintQuality;
  /** platform-specs directory (tests); default: the bundled one. */
  specsDir?: string | null;
}

/** The parts of renders/<quality>/render-state.json lint reads (written by the pipeline). */
interface RenderStateView {
  quality?: LintQuality;
  target?: { width: number; height: number; fps: number; aspect_ratio: string };
  duration_ms?: number;
  burn_in?: boolean;
  scenes?: Array<{ scene_id: string; duration_ms?: number; text_boxes?: TextBox[] }>;
  captions?: { box?: PxBox; json?: string };
  /** Where the pipeline placed burned-in captions (RenderState.caption_layout). */
  caption_layout?: { box?: PxBox };
  cover?: { headline_box?: TextBox; crops?: Array<{ id: string; targets: string[]; x: number; y: number; w: number; h: number }> };
  voice?: { timing_source?: string; tracks_path?: string };
  voice_mode?: string;
  beat_sync?: { bpm?: number | null; beats?: number; moved_cuts?: number; beat_times_ms?: number[] };
  cues?: Array<{ scene_id: string; word: string; item: number; at_ms?: number; status: string }>;
  logo?: { path: string; box: PxBox; scenes: string[] };
}

/** captions/captions.json (media `CaptionJson`): the words and the captions built from them. */
interface CaptionJsonView {
  words?: Array<{ word: string; start_ms: number; end_ms: number; scene_id?: string }>;
  lines?: Array<{ start_ms: number; end_ms: number; text: string; first_word: number; word_count: number }>;
}

/** One entry of voice-tracks.json (schema `SceneVoiceTrack`): word times relative to the scene. */
interface VoiceTrackView {
  scene_id: string;
  duration_ms: number;
  words: Array<{ word: string; start_ms: number; end_ms: number }>;
}

/** A compiled cover's headline and the crops it must survive (from render-state or the manifest). */
interface CoverView {
  headline_box?: TextBox;
  crops: Array<{ id: string; targets: string[]; rect: PxBox }>;
}

/** The parts of dist/render-manifest.json lint reads. */
interface ManifestView {
  settings?: { quality?: LintQuality; width?: number; height?: number };
  captions?: { burn_in?: boolean; box?: PxBox };
  renders?: Array<{ scene_id: string; text_boxes?: TextBox[] }>;
  cover?: CoverView;
}

// ------------------------------------------------------------------------------------ helpers

const round2 = (n: number) => Math.round(n * 100) / 100;

async function readOptionalJson<T>(path: string): Promise<T | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return await readJson<T>(path);
  } catch {
    return undefined;
  }
}

async function loadBrand(root: string): Promise<Brand | undefined> {
  for (const p of [join(root, "brand.yaml"), join(root, "project", "brand.yaml")]) {
    if (!existsSync(p)) continue;
    const parsed = parseYamlOrJson(Brand, await readFile(p, "utf8"));
    if (!parsed.ok) throw new Error(`invalid brand file ${p}: ${parsed.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
    return parsed.data;
  }
  return undefined;
}

/** sRGB relative luminance of `#RRGGBB` (WCAG 2.x). */
export function relativeLuminance(hex: string): number {
  const h = hex.replace(/^#/, "");
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two `#RRGGBB` colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const wordCount = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** Every string inside a props value (deterministic scene props are an open record). */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

function snippet(text: string, max = 40): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

// ------------------------------------------------------------------------------------ checks

function checkEnvelope(spec: VideoSpec, contracts: readonly PlatformContract[], state: RenderStateView | undefined, out: LintFinding[]): void {
  const master = resolveMaster(spec);
  const specTotal = round2(spec.scenes.reduce((a, s) => a + s.duration_sec, 0));
  const renderTotal = state?.duration_ms !== undefined ? round2(state.duration_ms / 1000) : undefined;
  for (const c of contracts) {
    const v = c.video;
    const target = c.id;
    if (!v.aspect_ratios.includes(spec.aspect_ratio)) {
      out.push({
        id: "envelope_aspect",
        severity: "error",
        target,
        message: `${c.name} accepts ${v.aspect_ratios.join(", ")}, but the spec is ${spec.aspect_ratio}`,
        fix: `set aspect_ratio to ${v.aspect_ratios[0]} (and master to match) or remove "${target}" from targets`,
      });
    }
    const { min, max } = v.duration_sec;
    for (const [label, total] of [["spec", specTotal], ["render", renderTotal]] as const) {
      if (total === undefined) continue;
      if (max !== undefined && total > max) {
        out.push({
          id: "envelope_duration",
          severity: "error",
          target,
          message: `${label} duration ${total}s is longer than ${c.name}'s ${max}s limit`,
          fix: `shorten scenes (duration_sec and voiceover) so the video totals at most ${max}s, or remove "${target}" from targets`,
        });
      }
      if (min !== undefined && total < min) {
        out.push({
          id: "envelope_duration",
          severity: "error",
          target,
          message: `${label} duration ${total}s is shorter than ${c.name}'s ${min}s minimum`,
          fix: `lengthen scenes so the video lasts at least ${min}s`,
        });
      }
    }
    if (v.fps?.min !== undefined && master.fps < v.fps.min) {
      out.push({
        id: "envelope_fps",
        severity: "error",
        target,
        message: `master fps ${master.fps} is below ${c.name}'s ${v.fps.min} fps minimum`,
        fix: `set master.fps to a value in ${v.fps.min}–${v.fps.max ?? 60} (24, 30 or 60)`,
      });
    }
    // Export re-encodes dist/<target>/video.mp4 down to the ceiling, so exceeding it only costs quality.
    if (v.fps?.max !== undefined && master.fps > v.fps.max) {
      out.push({
        id: "envelope_fps",
        severity: "warning",
        target,
        message: `master fps ${master.fps} is above ${c.name}'s ${v.fps.max} fps; export re-encodes dist/${target}/video.mp4 to ${v.fps.max} fps`,
        fix: `set master.fps to at most ${v.fps.max} to avoid the re-encode`,
      });
    }
    if (v.min && (master.width < v.min.width || master.height < v.min.height)) {
      out.push({
        id: "envelope_size",
        severity: "error",
        target,
        message: `master ${master.width}x${master.height} is smaller than ${c.name}'s minimum ${v.min.width}x${v.min.height}`,
        fix: `set master to ${v.recommended.width}x${v.recommended.height} (or remove master for the default)`,
      });
    }
    if (v.max_long_side && Math.max(master.width, master.height) > v.max_long_side) {
      out.push({
        id: "envelope_size",
        severity: "warning",
        target,
        message: `master ${master.width}x${master.height} exceeds ${c.name}'s ${v.max_long_side}px long side; export downscales dist/${target}/video.mp4`,
        fix: `set master to ${v.recommended.width}x${v.recommended.height} to avoid the re-encode`,
      });
    }
    if (!c.ui_masks.some((m) => m.aspect_ratio === spec.aspect_ratio)) {
      out.push({
        id: "masks_unknown",
        severity: "warning",
        target,
        message: `${c.name} has no UI masks for ${spec.aspect_ratio}; captions and text were not checked against its UI`,
        fix: `check a ${spec.aspect_ratio} frame on ${c.name} by eye, or add ui_masks to platform-specs/${target}.yaml`,
      });
    }
  }
}

function sceneBoxes(state: RenderStateView | undefined, manifest: ManifestView | undefined): Array<{ scene_id: string; box: TextBox }> {
  const src = state?.scenes?.some((s) => s.text_boxes?.length) ? state.scenes : manifest?.renders;
  return (src ?? []).flatMap((s) => (s.text_boxes ?? []).map((box) => ({ scene_id: s.scene_id, box })));
}

function checkOverflow(boxes: Array<{ scene_id: string; box: TextBox }>, out: LintFinding[]): void {
  for (const { scene_id, box } of boxes) {
    if (!box.truncated) continue;
    out.push({
      id: "text_overflow",
      severity: CRITICAL_ROLES.has(box.role) ? "error" : "warning",
      scene_id,
      message: `${box.role} text "${snippet(box.text)}" does not fit its box at the minimum size and is cut off`,
      fix: `shorten that text in scene ${scene_id} (deterministic.props) to about two thirds of its length, or split it across two scenes`,
    });
  }
}

function checkTextMasks(boxes: Array<{ scene_id: string; box: TextBox }>, masks: readonly TargetMask[], W: number, H: number, out: LintFinding[]): void {
  for (const { scene_id, box } of boxes) {
    for (const [target, hits] of byTarget(maskCollisions(box.rect, masks, W, H).map((h) => h.mask))) {
      out.push({
        id: "text_mask",
        severity: box.role === "decorative" ? "warning" : worst(hits),
        target,
        scene_id,
        message: `${box.role} text "${snippet(box.text)}" sits under ${target}'s ${hits.map((m) => m.label).join("; ")}`,
        fix: `re-render so the layout uses the target zones (remove any manual positions), or shorten the text in scene ${scene_id} so it fits the content zone`,
      });
    }
  }
}

/** Top edge (px) of a caption block of height `h` centred at `y` × `H`. */
const captionTop = (y: number, h: number, H: number) => Math.round(y * H - h / 2);

/**
 * Nearest caption centres (fractions of the height, 2 decimals) above and below `cy` at which a
 * box of `box.w`×`box.h` at `box.x` overlaps no error mask; undefined when there is none.
 */
function freeCentres(box: PxRect, cy: number, masks: readonly TargetMask[], W: number, H: number): { up?: number; down?: number } {
  const errors = masks.filter((m) => m.severity === "error");
  const clear = (y: number) => {
    const top = captionTop(y, box.h, H);
    return top >= 0 && top + box.h <= H && maskCollisions({ ...box, y: top }, errors, W, H).length === 0;
  };
  const start = Math.round((cy / H) * 100);
  let up: number | undefined;
  let down: number | undefined;
  for (let p = start; p >= 0 && up === undefined; p--) if (clear(p / 100)) up = p / 100;
  for (let p = start; p <= 100 && down === undefined; p++) if (clear(p / 100)) down = p / 100;
  return { ...(up !== undefined ? { up } : {}), ...(down !== undefined ? { down } : {}) };
}

function checkCaptions(
  spec: VideoSpec,
  zones: LayoutZones,
  manifestBox: PxBox | undefined,
  burnIn: boolean,
  out: LintFinding[],
): void {
  if (!burnIn) return;
  const { width: W, height: H, masks } = zones;
  const position = spec.captions.position;
  let box: PxRect;
  let source: string;
  if (manifestBox) {
    box = manifestBox;
    source = "rendered captions";
  } else if (position) {
    const h = zones.caption.h;
    box = { x: zones.caption.x, y: captionTop(position.y, h, H), w: zones.caption.w, h };
    source = `captions.position.y ${position.y}`;
  } else {
    box = zones.caption;
    source = "the caption zone";
  }
  for (const [target, hits] of byTarget(maskCollisions(box, masks, W, H).map((h) => h.mask))) {
    let fix: string;
    if (position) {
      const cy = position.y * H;
      const { up, down } = freeCentres(box, cy, masks, W, H);
      const pick = up !== undefined && (down === undefined || position.y - up <= down - position.y) ? `set y ≤ ${up}` : down !== undefined ? `set y ≥ ${down}` : undefined;
      fix = pick ? `remove captions.position (auto placement in the caption zone) or ${pick}` : "remove captions.position (auto placement in the caption zone)";
    } else if (manifestBox) {
      fix = "remove captions.position if set and re-render so the caption engine places captions in the targets' caption zone; if it persists, shorten voiceover phrases so captions fit in fewer lines";
    } else {
      fix = `the design caption zone collides with ${target}'s UI: drop a target that shares this aspect ratio or set captions.position.y into a free band`;
    }
    out.push({
      id: "caption_mask",
      severity: worst(hits),
      target,
      message: `captions (${source}, y ${box.y}–${box.y + box.h}px of ${H}) overlap ${target}'s ${hits.map((m) => m.label).join("; ")}`,
      fix,
    });
  }
}

/** Masks grouped by target, in first-seen order. */
function byTarget(masks: readonly TargetMask[]): Map<string, TargetMask[]> {
  const out = new Map<string, TargetMask[]>();
  for (const m of masks) out.set(m.target, [...(out.get(m.target) ?? []), m]);
  return out;
}

const worst = (masks: readonly TargetMask[]): LintSeverity => (masks.some((m) => m.severity === "error") ? "error" : "warning");

function checkContrast(boxes: Array<{ scene_id: string; box: TextBox }>, H: number, out: LintFinding[]): void {
  for (const { scene_id, box } of boxes) {
    if (!box.color || !box.background) continue;
    const large = box.font_px >= LARGE_TEXT_FRACTION * H;
    const need = large ? CONTRAST_LARGE : CONTRAST_NORMAL;
    const ratio = contrastRatio(box.color, box.background);
    if (ratio + 1e-9 >= need) continue;
    out.push({
      id: "contrast",
      severity: CRITICAL_ROLES.has(box.role) ? "error" : "warning",
      scene_id,
      message: `${box.role} text "${snippet(box.text)}" has contrast ${round2(ratio)}:1 (${box.color} on ${box.background}); WCAG needs ${need}:1 for ${large ? "large" : "normal"} text`,
      fix: `change the brand palette (visual.palette text/background/primary) so ${box.color} vs ${box.background} reaches ${need}:1, or enlarge the text`,
    });
  }
}

/** The script a scene's text is read in: its dominant script, else the spec language's. */
function readingScript(text: string, language: string | undefined): Script {
  return scriptsIn(text).length ? dominantScript(text) : (languageScript(language) ?? "latin");
}

/** CJK characters (ideographs, kana, full-width letters/digits) plus other letters and digits; punctuation and spaces do not count. */
const cjkCharCount = (s: string) => Array.from(s).filter((ch) => /[\p{L}\p{N}]/u.test(ch)).length;

/** Reading density for a non-Latin scene; returns true when handled (Latin scenes keep the word rule below). */
function checkScriptDensity(s: VideoSpec["scenes"][number], text: string, script: Script, onScreen: boolean, out: LintFinding[]): boolean {
  if (script === "latin") return false;
  const cjk = script === "cjk";
  const count = cjk ? cjkCharCount(text) : wordCount(text);
  const unit = cjk ? "characters" : "words";
  const limit = cjk ? (onScreen ? MAX_ONSCREEN_CJK_CHARS_PER_SEC : MAX_CJK_CHARS_PER_SEC) : (MAX_WORDS_PER_SEC_BY_SCRIPT[script] ?? MAX_WORDS_PER_SEC) * (onScreen ? MAX_ONSCREEN_WORDS_PER_SEC / MAX_WORDS_PER_SEC : 1);
  const lim = round2(limit);
  if (onScreen) {
    const readable = Math.max(0, s.duration_sec - ONSCREEN_SETTLE_SEC) * limit;
    if (count <= Math.max(cjk ? 8 : 3, readable)) return true;
    out.push({
      id: "reading_density",
      severity: "warning",
      scene_id: s.id,
      message: `${count} on-screen ${unit} (${script}) in ${s.duration_sec}s; without narration viewers read at most about ${lim} ${unit}/s after a ${ONSCREEN_SETTLE_SEC}s settle (${Math.floor(readable)} ${unit})`,
      fix: `cut scene ${s.id}'s on-screen text to at most ${Math.max(cjk ? 8 : 3, Math.floor(readable))} ${unit}, or raise duration_sec to at least ${Math.ceil((count / limit + ONSCREEN_SETTLE_SEC) * 10) / 10}`,
    });
    return true;
  }
  const rate = count / s.duration_sec;
  if (rate <= limit) return true;
  out.push({
    id: "reading_density",
    severity: "warning",
    scene_id: s.id,
    message: `${count} voiceover ${unit} (${script}) in ${s.duration_sec}s is ${round2(rate)} ${unit}/s; captions above ${lim} ${unit}/s are hard to read`,
    fix: `cut scene ${s.id}'s voiceover to at most ${Math.floor(limit * s.duration_sec)} ${unit}, or raise duration_sec to at least ${Math.ceil((count / limit) * 10) / 10}`,
  });
  return true;
}

function checkDensity(spec: VideoSpec, out: LintFinding[]): void {
  if (voiceMode(spec) === "none") return checkOnScreenDensity(spec, out);
  for (const s of spec.scenes) {
    if (checkScriptDensity(s, s.voiceover, readingScript(s.voiceover, spec.language), false, out)) continue;
    const words = wordCount(s.voiceover);
    const wps = words / s.duration_sec;
    if (wps <= MAX_WORDS_PER_SEC) continue;
    const maxWords = Math.floor(MAX_WORDS_PER_SEC * s.duration_sec);
    out.push({
      id: "reading_density",
      severity: "warning",
      scene_id: s.id,
      message: `${words} voiceover words in ${s.duration_sec}s is ${round2(wps)} words/s; captions above ${MAX_WORDS_PER_SEC} words/s are hard to read`,
      fix: `cut scene ${s.id}'s voiceover to at most ${maxWords} words, or raise duration_sec to at least ${Math.ceil((words / MAX_WORDS_PER_SEC) * 10) / 10}`,
    });
  }
}

/** Without narration the text on screen carries the message: check it can be read in the scene's time. */
function checkOnScreenDensity(spec: VideoSpec, out: LintFinding[]): void {
  for (const s of spec.scenes) {
    const text = [s.on_screen_text ?? "", s.deterministic ? propsText(s.deterministic.props) : ""].join(" ");
    if (checkScriptDensity(s, text, readingScript(text, spec.language), true, out)) continue;
    const words = wordCount(text);
    const readable = Math.max(0, s.duration_sec - ONSCREEN_SETTLE_SEC) * MAX_ONSCREEN_WORDS_PER_SEC;
    if (words <= Math.max(3, readable)) continue;
    out.push({
      id: "reading_density",
      severity: "warning",
      scene_id: s.id,
      message: `${words} on-screen words in ${s.duration_sec}s; without narration viewers read at most about ${MAX_ONSCREEN_WORDS_PER_SEC} words/s after a ${ONSCREEN_SETTLE_SEC}s settle (${Math.floor(readable)} words)`,
      fix: `cut scene ${s.id}'s on-screen text to at most ${Math.max(3, Math.floor(readable))} words, or raise duration_sec to at least ${Math.ceil((words / MAX_ONSCREEN_WORDS_PER_SEC + ONSCREEN_SETTLE_SEC) * 10) / 10}`,
    });
  }
}

function checkPostCopy(spec: VideoSpec, contracts: readonly PlatformContract[], out: LintFinding[]): void {
  for (const c of contracts) {
    const copy = spec.publish?.[c.id];
    if (!copy) continue;
    const tags = copy.hashtags ?? [];
    const inline = copy.post_caption.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? [];
    const full = [copy.post_caption, ...tags.filter((t) => !copy.post_caption.includes(t))].join(" ").trim();
    // UTF-16 code units: TikTok counts "UTF-16 runes"; for other platforms it is a close upper bound.
    const length = full.length;
    const lim = c.captions;
    if (lim.post_caption_max_chars !== undefined && length > lim.post_caption_max_chars) {
      out.push({
        id: "post_caption_length",
        severity: "error",
        target: c.id,
        message: `publish.${c.id} post caption with hashtags is ${length} characters; ${c.name} allows ${lim.post_caption_max_chars}`,
        fix: `shorten publish.${c.id}.post_caption (or drop hashtags) by at least ${length - lim.post_caption_max_chars} characters`,
      });
    }
    const hashtagCount = new Set([...tags, ...inline.map((t) => t.trim())].map((t) => t.toLowerCase())).size;
    if (lim.hashtags_max !== undefined && hashtagCount > lim.hashtags_max) {
      out.push({
        id: "post_hashtags",
        severity: "error",
        target: c.id,
        message: `publish.${c.id} has ${hashtagCount} hashtags; ${c.name} allows ${lim.hashtags_max}`,
        fix: `keep at most ${lim.hashtags_max} hashtags in publish.${c.id}`,
      });
    }
    const mentions = (copy.post_caption.match(/(^|\s)@[\p{L}\p{N}_.]+/gu) ?? []).length;
    if (lim.mentions_max !== undefined && mentions > lim.mentions_max) {
      out.push({
        id: "post_mentions",
        severity: "error",
        target: c.id,
        message: `publish.${c.id} mentions ${mentions} accounts; ${c.name} allows ${lim.mentions_max}`,
        fix: `keep at most ${lim.mentions_max} @mentions in publish.${c.id}.post_caption`,
      });
    }
  }
}

function checkCover(spec: VideoSpec, contracts: readonly PlatformContract[], rendered: CoverView | undefined, out: LintFinding[]): void {
  const needing = contracts.filter((c) => c.cover.mode !== "none");
  if (!spec.cover) {
    if (needing.length) {
      out.push({
        id: "cover_missing",
        severity: "warning",
        message: `no cover: ${needing.map((c) => `${c.name} (${c.cover.mode})`).join(", ")} ${needing.length === 1 ? "uses" : "use"} a cover image or frame`,
        fix: 'add cover {headline, focal_time_sec} to the spec, with focal_time_sec inside the hook scene where the headline is on screen',
      });
    }
    return;
  }
  const words = wordCount(spec.cover.headline);
  if (readingScript(spec.cover.headline, spec.language) === "cjk") {
    const chars = cjkCharCount(spec.cover.headline);
    if (chars > COVER_HEADLINE_MAX_CJK_CHARS) {
      out.push({
        id: "cover_headline",
        severity: "warning",
        message: `cover headline "${snippet(spec.cover.headline)}" has ${chars} characters; CJK covers read best at ≤ ${COVER_HEADLINE_MAX_CJK_CHARS} characters`,
        fix: `shorten cover.headline to at most ${COVER_HEADLINE_MAX_CJK_CHARS} characters`,
      });
    }
  } else if (words > COVER_HEADLINE_MAX_WORDS || spec.cover.headline.length > COVER_HEADLINE_MAX_CHARS) {
    out.push({
      id: "cover_headline",
      severity: "warning",
      message: `cover headline "${snippet(spec.cover.headline)}" has ${words} words / ${spec.cover.headline.length} characters; covers read best at ≤ ${COVER_HEADLINE_MAX_WORDS} words and ≤ ${COVER_HEADLINE_MAX_CHARS} characters`,
      fix: `shorten cover.headline to at most ${COVER_HEADLINE_MAX_WORDS} words`,
    });
  }
  const box = rendered?.headline_box;
  if (box) {
    // The compiled cover says where the headline landed: check it against every crop.
    if (box.truncated) {
      out.push({
        id: "cover_overflow",
        severity: "error",
        message: `cover headline "${snippet(spec.cover.headline)}" does not fit the cover frame and was cut`,
        fix: `shorten cover.headline to at most ${COVER_HEADLINE_MAX_WORDS} words`,
      });
    }
    for (const crop of rendered.crops) {
      const inside = intersect(box.rect, crop.rect);
      if (inside && inside.w === box.rect.w && inside.h === box.rect.h) continue;
      out.push({
        id: "cover_crop",
        severity: "error",
        ...(crop.targets.length === 1 ? { target: crop.targets[0]! } : {}),
        message: `the cover headline (${box.rect.x},${box.rect.y} ${box.rect.w}×${box.rect.h}) falls outside the "${crop.id}" crop${crop.targets.length ? ` used by ${crop.targets.join(", ")}` : ""}`,
        fix: "shorten cover.headline so it fits the centre of the frame, then re-render",
      });
    }
    return;
  }
  const crops = needing.flatMap((c) => (c.cover.crops ?? []).map((k) => `${c.name} ${k.aspect_ratio} ${k.anchor}`));
  if (crops.length && words > COVER_HEADLINE_MAX_WORDS / 2 + 1) {
    out.push({
      id: "cover_crop",
      severity: "warning",
      message: `the cover is also cropped to ${crops.join(", ")}; a ${words}-word headline may be cut in the crop`,
      fix: "keep cover.headline to about 4 words so it survives the centre crop, or check the cover preview",
    });
  }
}

function checkBanned(spec: VideoSpec, brand: Brand | undefined, out: LintFinding[]): void {
  const banned = brand?.voice?.banned_phrases ?? [];
  if (banned.length === 0) return;
  const fields: Array<{ where: string; scene_id?: string; text: string }> = [];
  for (const s of spec.scenes) {
    fields.push({ where: `scenes ${s.id} voiceover`, scene_id: s.id, text: s.voiceover });
    if (s.on_screen_text) fields.push({ where: `scenes ${s.id} on_screen_text`, scene_id: s.id, text: s.on_screen_text });
    if (s.deterministic) fields.push({ where: `scenes ${s.id} deterministic.props`, scene_id: s.id, text: strings(s.deterministic.props).join("\n") });
  }
  if (spec.cover) fields.push({ where: "cover.headline", text: spec.cover.headline });
  for (const [id, p] of Object.entries(spec.publish ?? {})) fields.push({ where: `publish.${id}`, text: [p.post_caption, ...(p.hashtags ?? [])].join(" ") });
  for (const phrase of banned) {
    const needle = phrase.toLowerCase();
    for (const f of fields) {
      if (!f.text.toLowerCase().includes(needle)) continue;
      out.push({
        id: "brand_banned_phrase",
        severity: "error",
        ...(f.scene_id ? { scene_id: f.scene_id } : {}),
        message: `banned brand phrase "${phrase}" appears in ${f.where}`,
        fix: `rewrite ${f.where} without "${phrase}" (brand.yaml voice.banned_phrases)`,
      });
    }
  }
}

/** Text the renderers fitted into boxes that the brand's corner logo covers. */
export function checkLogo(state: Pick<RenderStateView, "logo"> | undefined, boxes: ReadonlyArray<{ scene_id: string; box: TextBox }>, out: LintFinding[]): void {
  const logo = state?.logo;
  if (!logo) return;
  const shown = new Set(logo.scenes);
  const hit = new Map<string, string[]>();
  for (const { scene_id, box } of boxes) {
    if (!shown.has(scene_id) || box.role === "caption") continue;
    const r = box.rect;
    const l = logo.box;
    if (r.x < l.x + l.w && r.x + r.w > l.x && r.y < l.y + l.h && r.y + r.h > l.y) hit.set(scene_id, [...(hit.get(scene_id) ?? []), box.role]);
  }
  for (const [scene_id, roles] of hit) {
    out.push({
      id: "logo_overlap",
      severity: "warning",
      scene_id,
      message: `the brand logo (${logo.path}) overlaps the ${[...new Set(roles)].join(", ")} text box in scene ${scene_id}`,
      fix: "move the logo to another corner (brand.yaml visual.logo_placement.position), make it smaller (max_fraction), or shorten the text so it sits clear of the corner",
    });
  }
}

/**
 * Brand `visual.forbidden` treatments ("drop shadows", "zoom transitions", "kinetic text") named by
 * a scene: its visual requirements, transition, motion pattern or graphic kind. Text match only:
 * the rest of the list is guidance for planning.
 */
export function checkForbidden(spec: VideoSpec, brand: Brand | undefined, out: LintFinding[]): void {
  const forbidden = brand?.visual?.forbidden ?? [];
  if (!forbidden.length) return;
  const norm = (s: string) => ` ${s.toLowerCase().replace(/[_-]+/g, " ").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim()} `;
  const stem = (w: string) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
  for (const s of spec.scenes) {
    const parts = [
      ...strings(s.visual_requirements),
      s.transition ? `${s.transition} transition` : "",
      s.motion ? `${s.motion.pattern} motion` : "",
      s.deterministic ? s.deterministic.kind : "",
    ].filter(Boolean);
    const text = norm(parts.join(" ")).split(" ").map(stem).join(" ");
    for (const phrase of forbidden) {
      const want = norm(phrase).trim().split(" ").map(stem);
      if (!want.length || !want[0]) continue;
      if (!text.includes(` ${want.join(" ")} `)) continue;
      out.push({
        id: "brand_forbidden",
        severity: "warning",
        scene_id: s.id,
        message: `scene ${s.id} uses "${phrase}", which brand.yaml lists under visual.forbidden`,
        fix: `change scene ${s.id}'s transition, motion, graphic kind or visual_requirements so it no longer uses "${phrase}"`,
      });
    }
  }
}

// ------------------------------------------------------------------------------------ timing

const sec = (ms: number) => `${round2(ms / 1000)}s`;

/** Seconds a caption needs on screen to be read (design rule; CJK by characters). */
export function captionReadSec(text: string, language: string | undefined): number {
  const script = readingScript(text, language);
  if (script === "cjk") return Math.max(CAPTION_MIN_SEC, cjkCharCount(text) / MAX_CJK_CHARS_PER_SEC + CAPTION_SETTLE_SEC);
  const perWord = CAPTION_SEC_PER_WORD * (script === "latin" ? 1 : MAX_WORDS_PER_SEC / (MAX_WORDS_PER_SEC_BY_SCRIPT[script] ?? MAX_WORDS_PER_SEC));
  return Math.max(CAPTION_MIN_SEC, wordCount(text) * perWord + CAPTION_SETTLE_SEC);
}

/** Scene start/end on the rendered timeline (from render-state scene durations). */
interface SceneSpan {
  id: string;
  start: number;
  end: number;
}

function sceneSpans(state: RenderStateView | undefined): SceneSpan[] | undefined {
  const scenes = state?.scenes;
  if (!scenes?.length || scenes.some((s) => typeof s.duration_ms !== "number")) return undefined;
  let t = 0;
  return scenes.map((s) => {
    const span = { id: s.scene_id, start: t, end: t + s.duration_ms! };
    t = span.end;
    return span;
  });
}

interface TimedLine {
  start_ms: number;
  end_ms: number;
  text: string;
  scene_id: string;
  /** Indices into CaptionJsonView.words. */
  words: number[];
  cue: boolean;
}

function captionLines(cap: CaptionJsonView): TimedLine[] {
  const words = cap.words ?? [];
  return (cap.lines ?? [])
    .map((l) => {
      const idx = Array.from({ length: Math.max(0, l.word_count) }, (_, k) => l.first_word + k).filter((i) => i >= 0 && i < words.length);
      const scene = (idx.length ? words[idx[0]!]!.scene_id : undefined) ?? "";
      return { start_ms: l.start_ms, end_ms: l.end_ms, text: l.text, scene_id: scene, words: idx, cue: scene.startsWith(SOUND_CUE_PREFIX) };
    })
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
}

/** Captions shown for less than their reading time: one finding per scene (worst caption named). */
function checkCaptionBrief(spec: VideoSpec, lines: readonly TimedLine[], brand: Brand | undefined, out: LintFinding[]): void {
  const byScene = new Map<string, Array<{ line: TimedLine; shown: number; need: number }>>();
  for (const line of lines) {
    if (line.cue) continue; // sound-event labels ([music]) are glanced at, not read
    const shown = (line.end_ms - line.start_ms) / 1000;
    const need = captionReadSec(line.text, spec.language);
    if (shown + 1e-6 >= need) continue;
    byScene.set(line.scene_id, [...(byScene.get(line.scene_id) ?? []), { line, shown, need }]);
  }
  const maxLines = brand?.captions?.max_lines ?? 2;
  for (const s of spec.scenes) {
    const bad = byScene.get(s.id);
    if (!bad) continue;
    const worst = [...bad].sort((a, b) => a.shown / a.need - b.shown / b.need)[0]!;
    const cjk = readingScript(worst.line.text, spec.language) === "cjk";
    const n = Math.max(1, wordCount(worst.line.text));
    // The speaking rate at which this caption's words would last its reading time.
    const wpm = Math.min(230, Math.max(110, Math.floor((60 * n) / worst.need / 5) * 5));
    const fewer = maxLines > 1 ? `set brand.yaml captions.max_lines to ${maxLines - 1} (fewer words per caption), ` : "";
    const rule = cjk ? `1/${MAX_CJK_CHARS_PER_SEC} s per character + ${CAPTION_SETTLE_SEC}s` : `${CAPTION_SEC_PER_WORD}s/word + ${CAPTION_SETTLE_SEC}s`;
    out.push({
      id: "caption_too_brief",
      severity: "warning",
      scene_id: s.id,
      message: `${bad.length} caption(s) in ${s.id} are on screen for less than their reading time; "${snippet(worst.line.text)}" shows for ${round2(worst.shown)}s but needs ${round2(worst.need)}s (${rule}, min ${CAPTION_MIN_SEC}s)`,
      fix: `${fewer}slow the voice with voice.rate_wpm ${cjk ? "lower" : `${wpm} or lower`}, or shorten scene ${s.id}'s voiceover`,
    });
  }
}

/**
 * The spoken words on the video timeline, per scene (the truth for caption sync): voice-track
 * word times offset by the scene start and clamped to the scene, like the caption engine does.
 */
function spokenWords(tracks: readonly VoiceTrackView[], spans: readonly SceneSpan[]): Map<string, Array<{ start: number; end: number }>> {
  const out = new Map<string, Array<{ start: number; end: number }>>();
  for (const span of spans) {
    const t = tracks.find((x) => x.scene_id === span.id);
    if (!t?.words?.length) continue;
    const end = span.start + Math.min(t.duration_ms || span.end - span.start, span.end - span.start);
    const ws = t.words
      .filter((w) => w.word.trim())
      .map((w) => {
        const a = Math.min(Math.round(span.start + w.start_ms), end);
        return { start: a, end: Math.min(Math.max(Math.round(span.start + w.end_ms), a), end) };
      });
    out.set(span.id, ws);
  }
  return out;
}

/** Captions that lead or trail the voice, and speech left uncaptioned. */
function checkCaptionSync(spec: VideoSpec, cap: CaptionJsonView, lines: readonly TimedLine[], spoken: Map<string, Array<{ start: number; end: number }>>, out: LintFinding[]): void {
  const words = cap.words ?? [];
  // Caption word i ↔ the k-th spoken word of its scene (same tokenisation; skipped when counts differ).
  const truth = new Map<number, { start: number; end: number }>();
  const perScene = new Map<string, number[]>();
  words.forEach((w, i) => {
    if (!w.scene_id || w.scene_id.startsWith(SOUND_CUE_PREFIX)) return;
    perScene.set(w.scene_id, [...(perScene.get(w.scene_id) ?? []), i]);
  });
  for (const [id, idx] of perScene) {
    const said = spoken.get(id);
    if (!said || said.length !== idx.length) continue;
    idx.forEach((i, k) => truth.set(i, said[k]!));
  }
  const drift = new Map<string, Array<{ line: TimedLine; what: string; ms: number }>>();
  for (const line of lines) {
    if (line.cue || !line.words.length) continue;
    const first = truth.get(line.words[0]!);
    const last = truth.get(line.words[line.words.length - 1]!);
    if (!first || !last) continue;
    const early = first.start - line.start_ms;
    const late = line.end_ms - Math.max(last.end + CAPTION_LATE_MS, first.start + CAPTION_MIN_DISPLAY_MS);
    const add = (what: string, ms: number) => drift.set(line.scene_id, [...(drift.get(line.scene_id) ?? []), { line, what, ms }]);
    if (early > CAPTION_EARLY_MS) add(`starts ${Math.round(early)} ms before its first word`, early - CAPTION_EARLY_MS);
    else if (late > 0) add(`stays ${Math.round(line.end_ms - last.end)} ms after its last word`, late);
  }
  for (const s of spec.scenes) {
    const bad = drift.get(s.id);
    if (!bad) continue;
    const worst = [...bad].sort((a, b) => b.ms - a.ms)[0]!;
    out.push({
      id: "caption_sync",
      severity: "warning",
      scene_id: s.id,
      message: `${bad.length} caption(s) in ${s.id} are out of sync with the voice; "${snippet(worst.line.text)}" ${worst.what} (limits: ${CAPTION_EARLY_MS} ms early, ${CAPTION_LATE_MS} ms late)`,
      fix: `re-render so captions are rebuilt from the current voice tracks; if it persists, split scene ${s.id}'s voiceover into shorter sentences (estimated word timings drift over long ones) or use a voice with real word timings`,
    });
  }
  // Speech with no caption on screen.
  const all = spec.scenes.flatMap((s) => (spoken.get(s.id) ?? []).map((w) => ({ ...w, scene: s.id })));
  const covered = (w: { start: number; end: number }) =>
    lines.some((l) => (w.end > w.start ? l.start_ms < w.end && l.end_ms > w.start : l.start_ms <= w.start && l.end_ms >= w.start));
  let run: typeof all = [];
  const flush = () => {
    if (run.length) {
      const from = run[0]!.start;
      const to = run[run.length - 1]!.end;
      if (to - from > UNCAPTIONED_SPEECH_MS) {
        out.push({
          id: "caption_sync",
          severity: "warning",
          scene_id: run[0]!.scene,
          message: `speech from ${sec(from)} to ${sec(to)} (${round2((to - from) / 1000)}s) has no caption on screen`,
          fix: `re-render so captions are rebuilt from the voice tracks (scene ${run[0]!.scene}'s voiceover may have changed since the captions were made); keep captions.burn_in on`,
        });
      }
    }
    run = [];
  };
  for (const w of all) {
    if (covered(w)) flush();
    else run.push(w);
  }
  flush();
}

/** Captions separated by a hair-thin gap flicker off and on. */
function checkCaptionGap(lines: readonly TimedLine[], out: LintFinding[]): void {
  const gaps: Array<{ at: number; ms: number; scene: string }> = [];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i]!.start_ms - lines[i - 1]!.end_ms;
    if (gap > 0 && gap < CAPTION_FLICKER_MS) gaps.push({ at: lines[i - 1]!.end_ms, ms: gap, scene: lines[i]!.scene_id });
  }
  if (!gaps.length) return;
  const scene = gaps[0]!.scene;
  out.push({
    id: "caption_gap",
    severity: "warning",
    ...(scene && !scene.startsWith(SOUND_CUE_PREFIX) ? { scene_id: scene } : {}),
    message: `minor: ${gaps.length} caption change(s) leave a gap under ${CAPTION_FLICKER_MS} ms, which reads as flicker (${gaps
      .slice(0, 3)
      .map((g) => `${sec(g.at)} +${Math.round(g.ms)} ms`)
      .join(", ")}${gaps.length > 3 ? ", …" : ""})`,
    fix: "re-render (the caption engine holds a caption across gaps under 250 ms); if the gaps persist, join the two phrases into one sentence in the voiceover",
  });
}

/** Scene cuts that beat sync could not move onto a beat. */
function checkBeatCuts(spec: VideoSpec, state: RenderStateView | undefined, spans: readonly SceneSpan[] | undefined, out: LintFinding[]): void {
  const beats = state?.beat_sync?.beat_times_ms;
  if (!spec.audio?.beat_sync?.enabled || !beats?.length || !spans || spans.length < 2) return;
  const tol = spec.audio.beat_sync.tolerance_ms ?? BEAT_TOLERANCE_MS;
  const lastBeat = Math.max(...beats);
  for (let j = 0; j + 1 < spans.length; j++) {
    const cut = spans[j]!.end;
    if (cut > lastBeat + tol) break; // beyond the recorded (capped) beat list
    let near = beats[0]!;
    for (const b of beats) if (Math.abs(b - cut) < Math.abs(near - cut)) near = b;
    const off = Math.abs(near - cut);
    if (off <= tol) continue;
    const cur = spans[j]!;
    const next = spans[j + 1]!;
    const newDur = round2((cur.end - cur.start + (near - cut)) / 1000);
    out.push({
      id: "cut_off_beat",
      severity: "warning",
      scene_id: cur.id,
      message: `the cut from ${cur.id} to ${next.id} at ${sec(cut)} is ${Math.round(off)} ms from the nearest beat (${sec(near)}); tolerance ${tol} ms`,
      fix: `set scene ${cur.id} duration_sec to ${newDur} so the cut lands on the beat at ${sec(near)}; beat sync does not move a cut into speech, so if ${near < cut ? cur.id : next.id}'s voiceover fills its scene, shorten it first (or raise audio.beat_sync.tolerance_ms)`,
    });
  }
}

const tokens = (s: string) =>
  s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);

/** Share of the on-screen text the voiceover also says (words; characters for CJK). */
function spokenShare(onScreen: string, voiceover: string, cjk: boolean): number {
  if (cjk) {
    const said = new Set(Array.from(voiceover).filter((ch) => /[\p{L}\p{N}]/u.test(ch)));
    const chars = Array.from(onScreen).filter((ch) => /[\p{L}\p{N}]/u.test(ch));
    return chars.length ? chars.filter((ch) => said.has(ch)).length / chars.length : 1;
  }
  const said = new Set(tokens(voiceover));
  const shown = [...new Set(tokens(onScreen))];
  return shown.length ? shown.filter((w) => said.has(w)).length / shown.length : 1;
}

/**
 * On-screen text the viewer must read in the scene's time, in every voice mode, when the
 * voiceover does not say the same words. Scenes already flagged by reading_density are skipped.
 */
function checkOnScreenBrief(spec: VideoSpec, state: RenderStateView | undefined, out: LintFinding[]): void {
  const flagged = new Set(out.filter((f) => f.id === "reading_density" && /on-screen/.test(f.message)).map((f) => f.scene_id));
  for (const s of spec.scenes) {
    if (flagged.has(s.id)) continue;
    const text = [s.on_screen_text ?? "", s.deterministic ? propsText(s.deterministic.props) : ""].join(" ").trim();
    if (!text) continue;
    const script = readingScript(text, spec.language);
    const cjk = script === "cjk";
    if (s.voiceover.trim() && spokenShare(text, s.voiceover, cjk) >= ONSCREEN_SPOKEN_SHARE) continue;
    const count = cjk ? cjkCharCount(text) : wordCount(text);
    const unit = cjk ? "characters" : "words";
    const limit = cjk ? MAX_ONSCREEN_CJK_CHARS_PER_SEC : ((MAX_WORDS_PER_SEC_BY_SCRIPT[script] ?? MAX_WORDS_PER_SEC) * MAX_ONSCREEN_WORDS_PER_SEC) / MAX_WORDS_PER_SEC;
    const rendered = state?.scenes?.find((x) => x.scene_id === s.id)?.duration_ms;
    const dur = rendered !== undefined ? rendered / 1000 : s.duration_sec;
    const floor = cjk ? 8 : 3;
    const readable = Math.max(0, dur - ONSCREEN_SETTLE_SEC) * limit;
    if (count <= Math.max(floor, readable)) continue;
    const needSec = Math.ceil((count / limit + ONSCREEN_SETTLE_SEC) * 10) / 10;
    out.push({
      id: "onscreen_too_brief",
      severity: "warning",
      scene_id: s.id,
      message: `${count} on-screen ${unit} in ${round2(dur)}s that the voiceover does not say; reading them takes about ${needSec}s (${round2(limit)} ${unit}/s after a ${ONSCREEN_SETTLE_SEC}s settle)`,
      fix: `cut scene ${s.id}'s on-screen text (on_screen_text and deterministic.props) to at most ${Math.max(floor, Math.floor(readable))} ${unit}, make the voiceover say the same words, or raise duration_sec to at least ${needSec}`,
    });
  }
}

/** Kinds that restate words on purpose: calls to action, end cards, quotes, name cards. */
const ECHO_KINDS: ReadonlySet<string> = new Set(["cta", "end_card", "quote", "lower_third"]);
/** On-screen text repeats the voiceover when a run this long is said verbatim and most of its words are spoken. */
export const REPEAT_RUN_WORDS = 4;
export const REPEAT_SPOKEN_SHARE = 0.8;

/** Longest run of consecutive `shown` tokens that also appears consecutively in `said`. */
function longestSharedRun(shown: readonly string[], said: readonly string[]): { len: number; at: number } {
  let best = { len: 0, at: 0 };
  const prev = new Array<number>(said.length + 1).fill(0);
  for (let i = 1; i <= shown.length; i++) {
    let diag = 0;
    for (let j = 1; j <= said.length; j++) {
      const up = prev[j]!;
      prev[j] = shown[i - 1] === said[j - 1] ? diag + 1 : 0;
      if (prev[j]! > best.len) best = { len: prev[j]!, at: i - prev[j]! };
      diag = up;
    }
  }
  return best;
}

/**
 * On-screen text that repeats the narration word for word while burned-in captions show the same
 * words: the viewer reads the line twice and the frame carries nothing new. Narrated, Latin-script
 * scenes only; calls to action, end cards, quotes and name cards are exempt, and so are scenes with
 * burn_captions: false. Kinetic text that types out the narration is the usual case: its fix is to
 * drop the burned-in captions for that scene.
 */
export function checkTextRepeatsCaptions(spec: VideoSpec, burnIn: boolean, out: LintFinding[]): void {
  if (!burnIn || voiceMode(spec) !== "narrated") return;
  for (const s of spec.scenes) {
    if (!s.voiceover.trim() || s.burn_captions === false || (s.deterministic && ECHO_KINDS.has(s.deterministic.kind))) continue;
    const text = [s.on_screen_text ?? "", s.deterministic ? propsText(s.deterministic.props) : ""].join(" ").trim();
    if (!text || readingScript(text, spec.language) === "cjk") continue;
    const shown = tokens(text);
    if (shown.length < REPEAT_RUN_WORDS) continue;
    const run = longestSharedRun(shown, tokens(s.voiceover));
    if (run.len < REPEAT_RUN_WORDS || spokenShare(text, s.voiceover, false) < REPEAT_SPOKEN_SHARE) continue;
    out.push({
      id: "text_repeats_captions",
      severity: "warning",
      scene_id: s.id,
      message: `scene ${s.id}'s on-screen text repeats its voiceover word for word ("${snippet(text)}"), and the burned-in captions show the same words, so the line is read twice`,
      fix:
        s.deterministic?.kind === "kinetic_text"
          ? `set burn_captions: false on scene ${s.id}: the kinetic text already shows the spoken words (the .srt/.vtt captions keep them for accessibility)`
          : `put something else on screen in ${s.id} (the key number or keyword, the payoff, a visual) or shorten it to the 1–3 words that matter; if the words must stay, set burn_captions: false on ${s.id}`,
    });
  }
}

const TENSION: ReadonlySet<string> = new Set(["question", "problem", "contrarian_claim", "story"]);
const PAYOFF: ReadonlySet<string> = new Set(["payoff", "result", "reveal", "loop_back"]);
const CLOSERS: ReadonlySet<string> = new Set(["cta", "end_card"]);

/** A light story check: tension set up early, and a payoff as the last non-CTA scene. */
export function checkStory(spec: VideoSpec, out: LintFinding[]): void {
  const scenes = spec.scenes;
  if (scenes.length < 3) return;
  const total = scenes.reduce((a, s) => a + s.duration_sec, 0);
  const problems: string[] = [];
  let t = 0;
  const early: string[] = [];
  scenes.forEach((s, i) => {
    if (i > 0 && s.purpose !== "hook" && t < STORY_SETUP_FRACTION * total) early.push(s.purpose);
    t += s.duration_sec;
  });
  if (!early.some((p) => TENSION.has(p))) {
    problems.push(`no scene after the hook in the first ${Math.round(STORY_SETUP_FRACTION * 100)}% sets up tension (purpose question, problem, contrarian_claim or story)`);
  }
  const last = [...scenes].reverse().find((s) => !CLOSERS.has(s.purpose));
  if (last && !PAYOFF.has(last.purpose)) problems.push(`the last scene before the CTA (${last.id}) is "${last.purpose}", not a payoff (payoff, result, reveal or loop_back)`);
  if (!problems.length) return;
  out.push({
    id: "story_structure",
    severity: "warning",
    message: `weak story arc: ${problems.join("; ")}`,
    fix: "re-plan with skills/plan/references/storytelling.md: open a loop early (a question or problem the viewer wants answered), escalate, and close it in a payoff scene right before the CTA",
  });
}

/** Cutaways (`footage.cutaway`): consecutive cutaway scenes form one block, timed on the spec. */
export function checkCutaways(spec: VideoSpec, out: LintFinding[]): void {
  const blocks: Array<{ start: number; end: number; first: string }> = [];
  let t = 0;
  let prevCut = false;
  for (const s of spec.scenes) {
    const cut = !!s.footage?.cutaway;
    if (cut && prevCut) blocks[blocks.length - 1]!.end = t + s.duration_sec;
    else if (cut) blocks.push({ start: t, end: t + s.duration_sec, first: s.id });
    prevCut = cut;
    t += s.duration_sec;
  }
  const r1 = (x: number) => Math.round(x * 10) / 10;
  blocks.forEach((b, i) => {
    const len = b.end - b.start;
    const problems: string[] = [];
    const fixes: string[] = [];
    if (b.start < CUTAWAY.hook_sec) {
      problems.push(`it starts at ${r1(b.start)}s, inside the hook's first second`);
      fixes.push("open on the speaker's face and cut away later");
    }
    if (len < CUTAWAY.min_sec || len > CUTAWAY.max_sec) {
      problems.push(`it lasts ${r1(len)}s (aim for ${CUTAWAY.min_sec}–${CUTAWAY.max_sec}s, the length of one idea)`);
      fixes.push(len < CUTAWAY.min_sec ? "lengthen it to cover the whole idea, or drop it" : "split it with a return to the speaker");
    }
    const prev = blocks[i - 1];
    if (prev && b.start - prev.end < CUTAWAY.face_gap_sec) {
      problems.push(`only ${r1(b.start - prev.end)}s of the speaker since the previous cutaway`);
      fixes.push(`leave at least ${CUTAWAY.face_gap_sec}s of face between cutaways, or merge the two`);
    }
    if (problems.length) {
      out.push({ id: "cutaway_rhythm", severity: "warning", scene_id: b.first, message: `cutaway at ${b.first}: ${problems.join("; ")}`, fix: fixes.join("; ") });
    }
  });
}

/** The ContentIR asset fields subject_near_edge needs. */
interface IrMediaView {
  assets?: Array<{ id: string; media?: { width?: number; height?: number; content_box?: { x: number; y: number; w: number; h: number } } }>;
}

/**
 * Reframed footage (`fit: cover` with a focus_track): the subject centre should not sit within
 * REFRAME.edge_margin of the crop edge at any keyframe, computed with the renderer's own smoothed
 * crop (reframe.ts). A static `focus` is a crop offset, not a subject position, so it is not checked.
 */
export function checkSubjectNearEdge(spec: VideoSpec, ir: IrMediaView | undefined, W: number, H: number, out: LintFinding[]): void {
  for (const s of spec.scenes) {
    const f = s.footage;
    if (!f?.focus_track?.length || (f.fit ?? "cover") !== "cover" || f.cutaway) continue;
    const media = ir?.assets?.find((a) => a.id === f.asset)?.media;
    const frame = media ? fittedFrame(media) : undefined;
    if (!media || !frame) continue;
    const speed = f.speed ?? 1;
    const span = (f.out_sec ?? f.in_sec + s.duration_sec * speed) - f.in_sec;
    const hits = subjectEdgeHits(f.focus_track, frame, { width: W, height: H }, { speed, spanSec: span, media });
    if (!hits.length) continue;
    const worst = hits.reduce((a, b) => (Math.abs(b.pos - 0.5) > Math.abs(a.pos - 0.5) ? b : a));
    const where = (pos: number, edge: string) => (pos < 0 || pos > 1 ? `is outside the crop (${edge})` : `sits ${Math.round(Math.min(pos, 1 - pos) * 100)}% from the crop's ${edge} edge`);
    const side = worst.axis === "x" ? (worst.pos < 0.5 ? "left" : "right") : worst.pos < 0.5 ? "top" : "bottom";
    out.push({
      id: "subject_near_edge",
      severity: "warning",
      scene_id: s.id,
      message: `${s.id}: the reframed subject ${where(worst.pos, side)} at t ${worst.t}s (${hits.length} keyframe(s) within ${Math.round(REFRAME.edge_margin * 100)}%); the crop cannot follow further (source edge) or pans too slowly`,
      fix: "check the keyframe positions (footage_focus, or review crops); if the subject really is at the source edge, use fit blur_pad or contain for that span, split the scene, or choose another span",
    });
  }
}

/** Caption and beat timing against the render: needs render-state.json (and its captions / voice files). */
async function checkTiming(root: string, spec: VideoSpec, state: RenderStateView | undefined, brand: Brand | undefined, out: LintFinding[]): Promise<void> {
  if (!state) return;
  const spans = sceneSpans(state);
  const cap = state.captions?.json ? await readOptionalJson<CaptionJsonView>(join(root, state.captions.json)) : undefined;
  if (cap?.lines?.length) {
    // Scenes without burned-in captions (burn_captions: false) have no on-screen captions to time.
    const noBurn = new Set(spec.scenes.filter((s) => s.burn_captions === false).map((s) => s.id));
    const lines = captionLines(cap).filter((l) => !noBurn.has(l.scene_id));
    checkCaptionBrief(spec, lines, brand, out);
    const tracks = state.voice?.tracks_path ? await readOptionalJson<VoiceTrackView[]>(join(root, state.voice.tracks_path)) : undefined;
    if (state.voice?.timing_source && state.voice.timing_source !== "none" && Array.isArray(tracks) && spans) {
      const spoken = spokenWords(tracks, spans);
      for (const id of noBurn) spoken.delete(id);
      checkCaptionSync(spec, cap, lines, spoken, out);
    }
    checkCaptionGap(lines, out);
  }
  checkBeatCuts(spec, state, spans, out);
  checkCues(state, out);
}

/** Word cues the render could not place, and cues too close together to follow. */
export function checkCues(state: Pick<RenderStateView, "cues">, out: LintFinding[]): void {
  const cues = state.cues ?? [];
  for (const c of cues) {
    if (c.status === "placed") continue;
    out.push({
      id: "cue_unmatched",
      severity: "warning",
      scene_id: c.scene_id,
      message:
        c.status === "late"
          ? `cue "${c.word}" (item ${c.item}) is spoken after scene ${c.scene_id} ends, so the item kept its default timing`
          : `cue "${c.word}" (item ${c.item}) was not found in scene ${c.scene_id}'s spoken words, so the item kept its default timing`,
      fix:
        c.status === "late"
          ? `move the word earlier in the voiceover, cue an earlier word, or lengthen scene ${c.scene_id}`
          : `cue a word the scene actually says (a native transcript may spell it differently), or render with a voice (silent renders have no word timings)`,
    });
  }
  const byScene = new Map<string, number[]>();
  for (const c of cues) if (c.status === "placed" && c.at_ms !== undefined) byScene.set(c.scene_id, [...(byScene.get(c.scene_id) ?? []), c.at_ms]);
  for (const [scene, times] of byScene) {
    const t = [...times].sort((a, b) => a - b);
    const gaps = t.slice(1).map((x, i) => x - t[i]!);
    const min = Math.min(...gaps);
    if (gaps.length && min < MIN_CUE_GAP_MS) {
      out.push({
        id: "cue_too_close",
        severity: "warning",
        scene_id: scene,
        message: `two cues in scene ${scene} land ${Math.round(min)} ms apart; viewers follow about one change per ${MIN_CUE_GAP_MS} ms`,
        fix: `cue words at least ${MIN_CUE_GAP_MS / 1000}s apart: drop a cue (that item keeps the default stagger) or cue a later word`,
      });
    }
  }
}

// ------------------------------------------------------------------------------------ entry

function formatMarkdown(r: Omit<LintResult, "report_json" | "report_md">): string {
  const lines = [
    `# Lint: ${r.status}`,
    "",
    `Targets: ${r.targets.join(", ") || "(none)"}. Render (${r.quality}): ${r.rendered ? "checked" : "not found; render checks skipped"}.`,
    `${r.counts.errors} error(s), ${r.counts.warnings} warning(s).`,
    "",
  ];
  for (const f of r.findings) {
    const where = [f.target, f.scene_id].filter(Boolean).join(" ");
    lines.push(`- **${f.severity}** \`${f.id}\`${where ? ` (${where})` : ""}: ${f.message}`, `  - fix: ${f.fix}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Lint a project: spec + target contracts + (when present) the `quality` render's text boxes,
 * duration and caption box. Writes qa/lint.json and qa/lint.md.
 */
export async function lintProject(projectDir: string, opts: LintOptions = {}): Promise<LintResult> {
  const paths = projectPaths(projectDir);
  const quality = opts.quality ?? "final";
  const specPath = projectSpecPaths(paths.root).spec;
  if (!existsSync(specPath)) throw new Error(`no spec at ${specPath}; plan the video first (the plan skill writes project/video-spec.json)`);
  const parsed = parseYamlOrJson(VideoSpec, await readFile(specPath, "utf8"));
  if (!parsed.ok) throw new Error(`project/video-spec.json does not match the VideoSpec schema; run spec_validate first (${parsed.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join("; ")})`);
  const spec = parsed.data;

  const findings: LintFinding[] = [];
  const wanted = resolveTargets(spec);
  const specsDir = opts.specsDir === undefined ? findPlatformSpecsDir() : opts.specsDir;
  const all = specsDir ? await loadContracts(specsDir) : [];
  const contracts = all.filter((c) => wanted.includes(c.id));
  for (const id of wanted) {
    if (contracts.some((c) => c.id === id)) continue;
    findings.push({
      id: "target_unknown",
      severity: "error",
      target: id,
      message: `no platform contract "${id}" in platform-specs/`,
      fix: `use one of ${all.map((c) => `"${c.id}"`).join(", ") || "(none available)"} in targets, or remove "${id}"`,
    });
  }

  const state = await readOptionalJson<RenderStateView>(join(paths.renders, quality, "render-state.json"));
  const manifestRaw = await readOptionalJson<ManifestView>(join(paths.dist, "render-manifest.json"));
  // dist/ holds the latest export; only trust it when it is the same quality as the render we lint.
  const manifest = manifestRaw?.settings?.quality === quality ? manifestRaw : undefined;
  const master = resolveMaster(spec);
  const W = state?.target?.width ?? manifest?.settings?.width ?? master.width;
  const H = state?.target?.height ?? manifest?.settings?.height ?? master.height;
  const zones = layoutZones({ width: W, height: H, aspect_ratio: spec.aspect_ratio }, contracts);
  const boxes = sceneBoxes(state, manifest);

  checkEnvelope(spec, contracts, state, findings);
  checkOverflow(boxes, findings);
  checkTextMasks(boxes, zones.masks, W, H, findings);
  const burnIn = state?.burn_in ?? manifest?.captions?.burn_in ?? spec.captions.burn_in;
  checkTextRepeatsCaptions(spec, burnIn, findings);
  // The render state is current; the dist manifest may be from the previous export (lint runs during export).
  checkCaptions(spec, zones, state?.caption_layout?.box ?? state?.captions?.box ?? manifest?.captions?.box, burnIn, findings);
  checkContrast(boxes, H, findings);
  checkDensity(spec, findings);
  checkOnScreenBrief(spec, state, findings);
  const brand = await loadBrand(paths.root);
  await checkTiming(paths.root, spec, state, brand, findings);
  checkStory(spec, findings);
  checkCutaways(spec, findings);
  checkSubjectNearEdge(spec, await readOptionalJson<IrMediaView>(join(paths.root, "source", "content-ir.json")), master.width, master.height, findings);
  checkLogo(state, boxes, findings);
  checkForbidden(spec, brand, findings);
  checkPostCopy(spec, contracts, findings);
  const coverView: CoverView | undefined = state?.cover
    ? {
        ...(state.cover.headline_box ? { headline_box: state.cover.headline_box } : {}),
        crops: (state.cover.crops ?? []).map(({ id, targets, x, y, w, h }) => ({ id, targets, rect: { x, y, w, h } })),
      }
    : manifest?.cover;
  checkCover(spec, contracts, coverView, findings);
  checkBanned(spec, brand, findings);

  findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.length - errors;
  const core = {
    status: errors ? "fail" : warnings ? "warn" : "pass",
    quality,
    targets: wanted,
    rendered: Boolean(state),
    counts: { errors, warnings },
    findings,
  } as const;
  const reportJson = join(paths.qa, "lint.json");
  const reportMd = join(paths.qa, "lint.md");
  await writeJsonAtomic(reportJson, core);
  await writeFileAtomic(reportMd, formatMarkdown(core));
  return { ...core, findings: [...findings], targets: [...wanted], report_json: reportJson, report_md: reportMd };
}

/** One-screen summary for the tool result. */
export function formatLint(r: LintResult): string {
  return [
    `lint ${r.status}: ${r.counts.errors} error(s), ${r.counts.warnings} warning(s) for ${r.targets.join(", ") || "no targets"} (${r.rendered ? `${r.quality} render checked` : `no ${r.quality} render; spec-only checks`}); report ${r.report_md}`,
    ...r.findings.map((f) => `- ${f.severity} ${f.id}${f.target ? ` [${f.target}]` : ""}${f.scene_id ? ` ${f.scene_id}` : ""}: ${f.message} (fix: ${f.fix})`),
  ].join("\n");
}

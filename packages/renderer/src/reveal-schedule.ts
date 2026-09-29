import { type Scene, cueItems } from "@video-studio/schema";

/**
 * Readable reveals on a beat grid (Phase 6.7): when a scene's items enter one after another on
 * the music, each TEXT item must stay fully visible for at least its reading floor before the
 * next one lands. The single source of truth for the pipeline (deterministic kinds under beat
 * sync), motion pages (`window.__vs.reveals`, `vs.revealAt(i)`) and lint `reveal_too_fast`.
 *
 * Reading floor: 0.8 s for 1–3 words, otherwise max(1.2 s, 0.3 s × words).
 *
 * Schedule: item 0 opens the scene at `start`; each later item lands on the first beat at or after
 * the moment the previous item has been fully visible for its floor (entrance + floor). With one
 * floor for every item that is every Nth beat: at 120 BPM a short line lands every 3rd beat
 * (1.5 s), never every beat (0.5 s). Without a beat grid (or past its end) the item lands exactly
 * when the floor allows. When the scene is too short for every floor, the items reveal quickly
 * instead (a short stagger, all in by 40% of the scene) so the full set holds to the end, and the
 * schedule says `too_dense`. Pure and deterministic.
 */

/** Floor for short items (1..REVEAL_SHORT_WORDS words). */
export const REVEAL_SHORT_FLOOR_S = 0.8;
export const REVEAL_SHORT_WORDS = 3;
/** Longer items: REVEAL_PER_WORD_S per word, at least REVEAL_MIN_FLOOR_S. */
export const REVEAL_PER_WORD_S = 0.3;
export const REVEAL_MIN_FLOOR_S = 1.2;
/** Default entrance length (s) an item takes to become fully visible (the FFmpeg renderer's fade). */
export const REVEAL_ENTRANCE_S = 0.4;
/** Too dense: the quick reveal's step (s) and the share of the scene by which every item is in. */
export const REVEAL_QUICK_STEP_S = 0.2;
export const REVEAL_QUICK_SHARE = 0.4;

const EPS = 1e-6;

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Words in an item: whitespace-separated tokens; unspaced CJK runs count one word per 2 characters. */
export function revealWords(text: string): number {
  let n = 0;
  for (const tok of text.trim().split(/\s+/)) {
    if (!tok) continue;
    const cjk = tok.match(/[぀-ヿ㐀-鿿가-힯]/g)?.length ?? 0;
    n += cjk > 2 ? Math.ceil(cjk / 2) : 1;
  }
  return n;
}

/** Seconds an item must stay fully visible before the next one replaces or pushes it. */
export function readingFloor(text: string): number {
  const w = revealWords(text);
  if (w <= REVEAL_SHORT_WORDS) return REVEAL_SHORT_FLOOR_S;
  return round3(Math.max(REVEAL_MIN_FLOOR_S, REVEAL_PER_WORD_S * w));
}

export interface RevealScheduleInput {
  /** Each item's text, in reveal order. */
  texts: readonly string[];
  /** Scene-local beat times (s). Empty: no grid. */
  beats?: readonly number[];
  /** Scene-local bar starts (s); used as the grid only when there are no beats. */
  downbeats?: readonly number[];
  /** Scene length (s). */
  duration: number;
  /** Seconds an item's entrance takes (default REVEAL_ENTRANCE_S). */
  entrance?: number;
  /** When item 0 starts entering (default 0). */
  start?: number;
}

export interface RevealSchedule {
  /** Entrance start of each item (scene-local s). */
  times: number[];
  /** Each item's reading floor (s). */
  floors: number[];
  /** The scene is too short for every floor: `times` is the quick reveal. */
  too_dense: boolean;
}

export interface RevealShortfall {
  item: number;
  /** Seconds the item is fully visible before the next item starts (or the scene ends). */
  visible: number;
  floor: number;
}

/**
 * Items that are fully visible for less than their floor: item i is visible from `times[i] +
 * entrance` until the next item starts entering (the last one until the scene ends).
 */
export function revealShortfalls(texts: readonly string[], times: readonly number[], duration: number, entrance = REVEAL_ENTRANCE_S): RevealShortfall[] {
  const out: RevealShortfall[] = [];
  const n = Math.min(texts.length, times.length);
  for (let i = 0; i < n; i++) {
    const end = i + 1 < n ? times[i + 1]! : duration;
    const visible = round3(end - (times[i]! + entrance));
    const floor = readingFloor(texts[i]!);
    if (visible < floor - 1e-3) out.push({ item: i, visible, floor });
  }
  return out;
}

/** Reveal times for `texts` on the scene's beat grid (see the module comment). */
export function revealSchedule(o: RevealScheduleInput): RevealSchedule {
  const entrance = Math.max(0, o.entrance ?? REVEAL_ENTRANCE_S);
  const start = Math.max(0, o.start ?? 0);
  const n = o.texts.length;
  const floors = o.texts.map(readingFloor);
  if (!n) return { times: [], floors, too_dense: false };
  const beats = o.beats?.length ? o.beats : (o.downbeats ?? []);
  const grid = [...beats].filter((b) => b >= 0 && b < o.duration).sort((a, b) => a - b);
  const times = [round3(start)];
  for (let i = 1; i < n; i++) {
    const earliest = times[i - 1]! + entrance + floors[i - 1]!;
    const beat = grid.find((b) => b >= earliest - EPS);
    times.push(round3(beat ?? earliest));
  }
  if (!revealShortfalls(o.texts, times, o.duration, entrance).length) return { times, floors, too_dense: false };
  const step = n > 1 ? Math.min(REVEAL_QUICK_STEP_S, Math.max(0, (REVEAL_QUICK_SHARE * o.duration - start) / (n - 1))) : 0;
  return { times: o.texts.map((_, i) => round3(start + i * step)), floors, too_dense: true };
}

/**
 * Deterministic kinds whose reveal items are the words on screen, one after another (the beat
 * reveal schedule and lint `reveal_too_fast` apply to them). Others (code, comparison, cta, stat,
 * ...) keep their stagger.
 */
export const BEAT_REVEAL_KINDS: ReadonlySet<string> = new Set(["typography", "kinetic_text", "diagram", "timeline", "map", "screenshot", "chart"]);

/** The on-screen text of each reveal item (`cueItems`) of a beat-reveal kind; undefined for other kinds and stat charts. */
export function revealItemTexts(scene: Pick<Scene, "deterministic">): string[] | undefined {
  const det = scene.deterministic;
  if (!det || !BEAT_REVEAL_KINDS.has(det.kind)) return undefined;
  const props = det.props as Record<string, unknown>;
  if (det.kind === "chart" && (props.type === "stat" || !Array.isArray(props.series) || !props.series.length)) return undefined;
  return cueItems(det.kind, props);
}

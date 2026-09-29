import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "@video-studio/core";
import { type LumaSample, parseLuma, runFfmpeg } from "@video-studio/media";
import { findStylesDir, projectStylesDir, styleIds } from "@video-studio/renderer";
import { type Easing, type FormatGrammar, type MotionTiming, Style } from "@video-studio/schema";

/**
 * Motion timing of a reference video (structure only; no frames are kept): how long elements take
 * to settle after a change starts, the shape of that change (easing class), the gap between
 * staggered entrances and the static holds between them.
 *
 * Measurement: one decode pass at 160 px wide in gray, `tblend=all_mode=difference` + `signalstats`
 * YAVG = the mean absolute difference between consecutive frames ("difference energy", 0–255).
 * A change is a run of frames above a low threshold that reaches a high threshold; it ends once
 * the energy stays below the low threshold for ≥ 2 frames. Its duration is the number of active
 * frame intervals. The thresholds sit above the clip's noise floor (median energy + a multiple of
 * its median absolute deviation, with absolute minimums).
 */

/** Analysis width: small enough to be fast, large enough for a caption-sized element. */
export const MOTION_WIDTH = 160;
/** Energy (8-bit code values) a change must reach, above the noise floor. */
export const MOTION_HIGH = 0.5;
/** Energy under which a frame counts as still, above the noise floor. */
export const MOTION_LOW = 0.25;
/** Frames below the low threshold that end a change. */
export const SETTLE_FRAMES = 2;
/** A change longer than this is continuous motion (a camera move, live footage), not an entrance. */
export const MAX_CHANGE_S = 2;
/** Onsets closer than this belong to one burst; their gaps are the stagger. */
export const BURST_GAP_S = 0.8;
/** A still stretch at least this long is a hold. */
export const HOLD_MIN_S = 0.3;
/** A blob this soon after a change and this small next to its peak is that change's settling tail. */
export const TAIL_GAP_S = 0.25;
export const TAIL_SHARE = 0.2;
/** Fewest changes for entrance durations and an easing class (fewer: null). */
export const MIN_CHANGES = 2;

export interface MotionChange {
  /** Time of the last still frame before the change (s). */
  start_sec: number;
  duration_ms: number;
  easing: Easing;
  peak: number;
}

export interface MotionMeasurement {
  timing: MotionTiming;
  changes: MotionChange[];
  /** Changes longer than MAX_CHANGE_S, left out of the timing. */
  continuous: number;
}

const median = (xs: readonly number[]): number => quantile(xs, 0.5);

function quantile(xs: readonly number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/**
 * The easing class of one change from its energy curve (one value per frame interval):
 * - one active interval: `snap` (a cut, or an element that appears in one frame);
 * - a second rise after the main hump has decayed below half its peak: `spring` (overshoot and rebound);
 * - flat (at least 6 intervals, each third's mean within ±20 % of the whole mean): `linear`;
 * - the peak (middle of its plateau) in the first third: `ease_out`; otherwise `ease_in_out`
 *   (an ease-in, peak in the last third, has no class of its own and reads as ease_in_out).
 */
export function classifyEasing(curve: readonly number[]): Easing {
  const n = curve.length;
  if (n <= 1) return "snap";
  const peak = Math.max(...curve);
  const k = curve.indexOf(peak);
  if (n >= 3) {
    let min = peak;
    let decayed = false;
    for (let j = k + 1; j < n; j++) {
      const v = curve[j]!;
      if (v < peak * 0.5) decayed = true;
      if (decayed && v >= min * 1.3 && v - min >= peak * 0.03 && v >= MOTION_LOW) return "spring";
      min = Math.min(min, v);
    }
  }
  if (n >= 6) {
    const mean = (xs: readonly number[]) => xs.reduce((a, v) => a + v, 0) / xs.length;
    const all = mean(curve);
    const third = Math.round(n / 3);
    const parts = [curve.slice(0, third), curve.slice(third, n - third), curve.slice(n - third)];
    if (all > 0 && parts.every((part) => Math.abs(mean(part) - all) <= 0.2 * all)) return "linear";
  }
  let last = k;
  while (last + 1 < n && curve[last + 1]! >= peak * 0.97) last++;
  const pos = (k + last) / 2 / (n - 1);
  return pos < 1 / 3 ? "ease_out" : "ease_in_out";
}

/**
 * Split a change at a deep valley between two humps of similar height (staggered entrances that
 * overlap). A small second hump is a rebound (spring) and stays in the same change.
 */
export function splitOverlaps(curve: readonly number[]): Array<[number, number]> {
  const parts: Array<[number, number]> = [];
  let start = 0;
  let hump = curve[0] ?? 0;
  let valley = Infinity;
  let valleyAt = -1;
  for (let j = 1; j < curve.length; j++) {
    const v = curve[j]!;
    if (valleyAt >= 0 && v > curve[j - 1]!) {
      // Rising again after a valley: find this hump's peak.
      let p = j;
      while (p + 1 < curve.length && curve[p + 1]! >= curve[p]!) p++;
      const next = curve[p]!;
      if (next >= 0.6 * hump && valley <= 0.5 * Math.min(hump, next)) {
        parts.push([start, valleyAt]);
        start = valleyAt + 1;
        hump = next;
      } else {
        hump = Math.max(hump, next);
      }
      valley = Infinity;
      valleyAt = -1;
      j = p;
      continue;
    }
    if (v < curve[j - 1]!) {
      if (v < valley) {
        valley = v;
        valleyAt = j;
      }
    } else if (valleyAt < 0) hump = Math.max(hump, v);
  }
  parts.push([start, curve.length - 1]);
  return parts;
}

/** Energies (clamped at 0), the frame interval and the change/still thresholds above the clip's noise floor. */
function energyThresholds(samples: readonly LumaSample[]): { e: number[]; dt: number; hi: number; lo: number } {
  const e = samples.map((s) => Math.max(0, s.y));
  // Frame interval from the whole span (pts_time is rounded to 1 ms per sample).
  const span = samples.length > 1 ? samples[samples.length - 1]!.t - samples[0]!.t : 0;
  const dt = span > 0 ? span / (samples.length - 1) : 1 / 30;
  const floor = median(e);
  const mad = median(e.map((v) => Math.abs(v - floor)));
  return { e, dt, hi: floor + Math.max(MOTION_HIGH, 6 * mad), lo: floor + Math.max(MOTION_LOW, 3 * mad) };
}

/** A still stretch of the picture (ms on the video's clock): every frame from start to end matches its neighbour. */
export interface HoldSpan {
  start_ms: number;
  end_ms: number;
}

/**
 * Where the holds are: still stretches (every interval ≤ the low threshold) of at least
 * HOLD_MIN_S, as spans on the video clock. Interval i joins frame i−1 to frame i, so a run of
 * still intervals i..j is the picture from frame i−1 to frame j. Same thresholds as
 * motionTimingFrom's hold count.
 */
export function holdSpans(samples: readonly LumaSample[]): HoldSpan[] {
  if (samples.length < 3) return [];
  const { e, dt, lo } = energyThresholds(samples);
  const out: HoldSpan[] = [];
  let from = -1;
  for (let i = 0; i <= e.length; i++) {
    if (i < e.length && e[i]! <= lo) {
      if (from < 0) from = i;
      continue;
    }
    if (from >= 0 && (i - from) * dt >= HOLD_MIN_S - 1e-6) {
      out.push({ start_ms: Math.round(Math.max(0, samples[from]!.t - dt) * 1000), end_ms: Math.round(samples[i - 1]!.t * 1000) });
    }
    from = -1;
  }
  return out;
}

/** Motion timing from per-interval difference energies (`samples[i].y` = |frame i − frame i−1|). */
export function motionTimingFrom(samples: readonly LumaSample[]): MotionMeasurement {
  const empty: MotionMeasurement = {
    timing: { changes_analyzed: 0, enter_ms_median: null, enter_ms_p75: null, easing: null, easing_share: null, stagger_ms_median: null, holds: { count: 0, median_ms: null, longest_ms: null } },
    changes: [],
    continuous: 0,
  };
  if (samples.length < 3) return empty;
  const { e, dt, hi, lo } = energyThresholds(samples);

  // Active runs: above `lo`, ended by SETTLE_FRAMES still frames.
  const runs: Array<[number, number]> = [];
  let i = 0;
  while (i < e.length) {
    if (e[i]! <= lo) {
      i++;
      continue;
    }
    const s = i;
    let last = i;
    let still = 0;
    for (i = i + 1; i < e.length; i++) {
      if (e[i]! > lo) {
        last = i;
        still = 0;
      } else if (++still >= SETTLE_FRAMES) break;
    }
    runs.push([s, last]);
    i = last + 1;
  }

  const changes: MotionChange[] = [];
  let continuous = 0;
  // Frame index range of the last change, for folding a settling tail into it.
  let prev: { from: number; to: number } | undefined;
  for (const [s, t] of runs) {
    const run = e.slice(s, t + 1);
    for (const [a, b] of splitOverlaps(run)) {
      const curve = run.slice(a, b + 1);
      const peak = Math.max(...curve);
      const last = changes[changes.length - 1];
      if (last && prev && (s + a - prev.to) * dt <= TAIL_GAP_S && peak < TAIL_SHARE * last.peak) {
        // A small blob right after a change is that change still settling (a spring's last wiggle).
        prev.to = s + b;
        last.duration_ms = Math.round((prev.to - prev.from + 1) * dt * 1000);
        continue;
      }
      if (peak < hi) continue;
      if (curve.length * dt > MAX_CHANGE_S) {
        continuous++;
        continue;
      }
      const at = s + a;
      prev = { from: at, to: s + b };
      changes.push({
        start_sec: Math.round(Math.max(0, samples[at]!.t - dt) * 1000) / 1000,
        duration_ms: Math.round(curve.length * dt * 1000),
        easing: classifyEasing(curve),
        peak: Math.round(peak * 100) / 100,
      });
    }
  }

  // Holds: still stretches (≤ lo) of at least HOLD_MIN_S.
  const holds: number[] = [];
  let still = 0;
  for (const v of [...e, Infinity]) {
    if (v <= lo) still++;
    else {
      if (still * dt >= HOLD_MIN_S - 1e-6) holds.push(Math.round(still * dt * 1000));
      still = 0;
    }
  }

  const n = changes.length;
  const counts = new Map<Easing, number>();
  for (const c of changes) counts.set(c.easing, (counts.get(c.easing) ?? 0) + 1);
  const order: Easing[] = ["ease_out", "ease_in_out", "spring", "linear", "snap"];
  const winner = order.reduce<Easing | null>((best, cls) => ((counts.get(cls) ?? 0) > (best ? (counts.get(best) ?? 0) : 0) ? cls : best), null);
  // Entrance durations: the animated changes when there are enough, else all (a cut-only reel).
  const animated = changes.filter((c) => c.easing !== "snap").map((c) => c.duration_ms);
  const durations = animated.length >= MIN_CHANGES ? animated : changes.map((c) => c.duration_ms);
  const gaps: number[] = [];
  for (let j = 1; j < n; j++) {
    const g = changes[j]!.start_sec - changes[j - 1]!.start_sec;
    if (g < BURST_GAP_S) gaps.push(g * 1000);
  }
  return {
    timing: {
      changes_analyzed: n,
      enter_ms_median: n >= MIN_CHANGES ? Math.round(median(durations)) : null,
      enter_ms_p75: n >= MIN_CHANGES ? Math.round(quantile(durations, 0.75)) : null,
      easing: n >= MIN_CHANGES ? winner : null,
      easing_share: n >= MIN_CHANGES && winner ? Math.round(((counts.get(winner) ?? 0) / n) * 1000) / 1000 : null,
      stagger_ms_median: gaps.length ? Math.round(median(gaps)) : null,
      holds: { count: holds.length, median_ms: holds.length ? Math.round(median(holds)) : null, longest_ms: holds.length ? Math.max(...holds) : null },
    },
    changes,
    continuous,
  };
}

/** Per-interval difference energy of a video's first picture track, in one decode pass. */
export async function differenceEnergy(path: string): Promise<LumaSample[]> {
  const r = await runFfmpeg(
    ["-i", path, "-map", "0:v:0", "-an", "-sn", "-vf", `scale=${MOTION_WIDTH}:-2,format=gray,tblend=all_mode=difference,signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG`, "-f", "null", "-"],
    { keepStderr: true, timeoutMs: 60 * 60 * 1000 },
  );
  return parseLuma(r.stderr);
}

export async function measureMotionTiming(path: string): Promise<MotionMeasurement> {
  return motionTimingFrom(await differenceEnergy(path));
}

export function formatMotionTiming(m: MotionTiming): string[] {
  const ms = (x: number | null) => (x === null ? "n/a" : `${Math.round(x)} ms`);
  return [
    "## Motion timing",
    "",
    `- Changes analyzed: ${m.changes_analyzed}`,
    `- Entrance: median ${ms(m.enter_ms_median)}, p75 ${ms(m.enter_ms_p75)}`,
    `- Easing: ${m.easing ? `**${m.easing}**${m.easing_share !== null ? ` (${Math.round(m.easing_share * 100)}% of changes)` : ""}` : "n/a"}`,
    `- Stagger: ${ms(m.stagger_ms_median)}`,
    `- Holds (still ≥ ${HOLD_MIN_S * 1000} ms): ${m.holds.count}${m.holds.count ? ` (median ${ms(m.holds.median_ms)}, longest ${ms(m.holds.longest_ms)})` : ""}`,
  ];
}

// ------------------------------------------------------------------------------ write_style

const STYLE_ID = /^[a-z0-9][a-z0-9-]*$/;
const r10 = (x: number) => Math.round(x / 10) * 10;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * A style pack from measured motion timing: easing and durations from the measurement, the scene
 * transition from the cut rate (≥ 3 cuts per 10 s or a snap-dominated reference: cut; else crossfade).
 */
export function styleFromMotion(id: string, g: Pick<FormatGrammar, "cuts_per_10s" | "motion_timing">): Style {
  const m = g.motion_timing;
  const easing: Easing = m?.easing ?? "ease_out";
  const enter = clamp(r10(m?.enter_ms_median ?? 400), 0, 2000);
  const personality =
    easing === "spring" ? "playful" : easing === "snap" || enter < 300 ? "energetic" : easing === "linear" ? "precise" : enter >= 500 ? "calm" : easing === "ease_in_out" ? "precise" : "friendly";
  const cut = easing === "snap" || g.cuts_per_10s >= 3;
  const name = id
    .split("-")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
  return Style.parse({
    id,
    name,
    version: 1,
    description: "measured from a reference; structure only",
    motion: {
      personality,
      easing,
      enter_ms: enter,
      exit_ms: clamp(r10(enter * 0.7), 0, 2000),
      stagger_ms: clamp(r10(m?.stagger_ms_median ?? enter * 0.4), 0, 1000),
      transition: cut ? "cut" : "crossfade",
      transition_ms: cut ? 0 : clamp(r10(enter * 0.8), 200, 800),
      avoid: [],
    },
  });
}

/** The pack as YAML (JSON-quoted scalars; YAML is a superset of JSON). */
export function styleYaml(s: Style): string {
  const q = (v: unknown) => JSON.stringify(v);
  const lines = ["# Measured by analyze from a reference video: motion timing only, nothing from the reference is kept.", `id: ${q(s.id)}`, `name: ${q(s.name)}`, `version: ${s.version}`, `description: ${q(s.description)}`, "motion:"];
  for (const [k, v] of Object.entries(s.motion)) lines.push(`  ${k}: ${Array.isArray(v) ? `[${v.map(q).join(", ")}]` : q(v)}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Where write_style would write `<id>`, or an error: an id that is not a file-name id, an existing
 * file, and an id that would shadow a bundled pack are refused unless `overwrite`.
 */
export async function styleTarget(
  projectDir: string,
  id: string,
  o: { overwrite?: boolean; stylesDir?: string | null } = {},
): Promise<{ path: string; warnings: string[] }> {
  if (!STYLE_ID.test(id)) throw new Error(`write_style id "${id}" must be lowercase letters, digits and dashes (it names styles/<id>.yaml)`);
  const path = join(projectStylesDir(projectDir), `${id}.yaml`);
  const warnings: string[] = [];
  const bundled = await styleIds(o.stylesDir === undefined ? findStylesDir() : o.stylesDir).catch(() => [] as string[]);
  if (bundled.includes(id)) {
    if (!o.overwrite) throw new Error(`"${id}" is a bundled style; pick another id, or pass overwrite: true to shadow it in this project`);
    warnings.push(`styles/${id}.yaml shadows the bundled "${id}" pack in this project`);
  }
  if (existsSync(path) && !o.overwrite) throw new Error(`styles/${id}.yaml already exists; pass overwrite: true to replace it`);
  return { path, warnings };
}

/** Write `<project>/styles/<id>.yaml` (refusals as in styleTarget). */
export async function writeProjectStyle(
  projectDir: string,
  style: Style,
  o: { overwrite?: boolean; stylesDir?: string | null } = {},
): Promise<{ path: string; warnings: string[] }> {
  const t = await styleTarget(projectDir, style.id, o);
  await writeFileAtomic(t.path, styleYaml(style));
  return t;
}

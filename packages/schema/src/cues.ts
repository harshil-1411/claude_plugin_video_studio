import type { DeterministicKind, SceneCue } from "./video-spec.js";

/**
 * Word cues (`scene.cues`): each deterministic kind reveals a fixed, ordered list of items, and a
 * cue lands one item on a spoken word. This module is the single definition of those items,
 * shared by spec validation, the pipeline and both renderers.
 */

/** Words of kinetic_text in reveal order: words, or phrases split after punctuation. */
export function kineticUnits(text: string, rhythm: "word" | "phrase"): string[] {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return [];
  if (rhythm === "word") return t.split(" ");
  return t
    .split(/(?<=[.,;:!?…—])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const label = (v: unknown): string => (typeof v === "object" && v !== null ? str((v as Record<string, unknown>).label) || str((v as Record<string, unknown>).text) : str(v));

/**
 * The reveal items of a deterministic graphic, in order, as short labels. A cue with `item: i`
 * drives item i. Items:
 * - typography: each line · code: the block, then the highlight (with highlight_lines)
 * - diagram: each node (its incoming edges draw with it) · timeline: each event · map: each point
 * - chart: each series entry, or the value (stat type / no series) · screenshot: each callout
 * - comparison: left, right, verdict · split_screen: left, right
 * - cta: headline, action (with command and url) · end_card: title, subtitle
 * - quote: text, attribution · stat: the number (its count-up finishes on the cue), the label
 * - lower_third: the name card, the headline · kinetic_text: each word or phrase (`kineticUnits`)
 */
export function cueItems(kind: DeterministicKind, props: Record<string, unknown>): string[] {
  switch (kind) {
    case "typography":
      return arr(props.lines).map(str);
    case "code":
      return arr(props.highlight_lines).length ? ["code", "highlight"] : ["code"];
    case "diagram":
      return arr(props.nodes).map(str);
    case "timeline":
      return arr(props.events).map(label);
    case "map":
      return arr(props.points).map(label);
    case "chart":
      return props.type !== "stat" && arr(props.series).length ? arr(props.series).map(label) : [str(props.value) || "value"];
    case "screenshot":
      return arr(props.callouts).map(label);
    case "comparison":
      return ["left", "right", ...(str(props.verdict).trim() ? ["verdict"] : [])];
    case "split_screen":
      return ["left", "right"];
    case "cta":
      return ["headline", "action"];
    case "end_card": {
      const items = [...(str(props.title).trim() ? ["title"] : []), ...(str(props.subtitle).trim() ? ["subtitle"] : [])];
      return items.length ? items : ["card"];
    }
    case "quote":
      return ["text", ...(str(props.attribution).trim() ? ["attribution"] : [])];
    case "stat":
      return ["value", "label"];
    case "lower_third":
      return ["name", ...(str(props.headline).trim() ? ["headline"] : [])];
    case "kinetic_text":
      return kineticUnits(str(props.text), props.rhythm === "phrase" ? "phrase" : "word");
  }
}

/** A speech token for matching: NFKC, lower case, surrounding punctuation stripped. */
export function cueToken(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
}

/**
 * Index of the first speech word where the cue's word (or phrase) occurs for the
 * `occurrence`-th time, or -1. `words` are the scene's speech words in order.
 */
export function matchCue(words: readonly string[], cue: Pick<SceneCue, "word" | "occurrence">): number {
  const want = cue.word.split(/\s+/).map(cueToken).filter(Boolean);
  if (!want.length) return -1;
  const toks = words.map(cueToken);
  let seen = 0;
  for (let i = 0; i + want.length <= toks.length; i++) {
    if (want.every((w, k) => toks[i + k] === w) && ++seen === (cue.occurrence ?? 1)) return i;
  }
  return -1;
}

/** The item each cue drives: `item` when given, else the one after the previous cue's (from 0). */
export function cueItemIndexes(cues: readonly Pick<SceneCue, "item">[]): number[] {
  let next = 0;
  return cues.map((c) => {
    const i = c.item ?? next;
    next = i + 1;
    return i;
  });
}

/** Minimum gap between consecutive cues that viewers can follow (lint `cue_too_close`). */
export const MIN_CUE_GAP_MS = 400;

import { z } from "zod";
import {
  AspectRatio,
  Goal,
  Id,
  IsoDateTime,
  LanguageTag,
  NonEmptyString,
  Platform,
  PlatformTargetId,
  SchemaVersion,
} from "./common.js";

export const HookMechanism = z.enum([
  "curiosity_gap",
  "contrarian",
  "statistic",
  "question",
  "pain_point",
  "promise",
  "story",
  "demo",
  "pattern_interrupt",
  "before_after",
  "mistake",
  "contrarian_claim",
]);

export const HookCandidate = z.strictObject({
  text: NonEmptyString,
  mechanism: HookMechanism,
  scores: z
    .record(z.string(), z.number().min(0).max(10))
    .describe("Rubric scores on a 0-10 scale, e.g. clarity, curiosity, relevance, platform_fit."),
});

export const Assumption = z
  .strictObject({
    field: NonEmptyString.describe("Brief field that was inferred, e.g. `audience`."),
    value: z.string(),
    reason: NonEmptyString,
  })
  .describe("A value Claude inferred rather than received; surfaced to the user for confirmation.");

export const CreativeBrief = z
  .strictObject({
    schema_version: SchemaVersion,
    id: Id.optional(),
    created_at: IsoDateTime.optional(),
    content_ir_id: Id.optional(),
    goal: Goal,
    audience: NonEmptyString,
    platform: Platform,
    aspect_ratio: AspectRatio,
    targets: z
      .array(PlatformTargetId)
      .optional()
      .describe("Platform contract ids to compile for; copied to the VideoSpec. Defaults to the primary platform's contract."),
    target_duration_sec: z.number().positive().max(600),
    language: LanguageTag,
    tone: z.array(NonEmptyString),
    desired_action: NonEmptyString.describe("What the viewer should do after watching."),
    key_messages: z.array(NonEmptyString).optional(),
    hook_candidates: z.array(HookCandidate).min(1),
    chosen_hook: NonEmptyString.describe("Text of the selected hook; should match a hook candidate."),
    template: Id.optional(),
    assumptions: z.array(Assumption),
  })
  .meta({
    id: "CreativeBrief",
    title: "CreativeBrief",
    description:
      "The creative intent for one video: goal, audience, platform, duration, tone, hooks and surfaced assumptions.",
  });

export type HookMechanism = z.infer<typeof HookMechanism>;
export type HookCandidate = z.infer<typeof HookCandidate>;
export type Assumption = z.infer<typeof Assumption>;
export type CreativeBrief = z.infer<typeof CreativeBrief>;

/** An actionable finding: where, what, and how to fix it. */
export interface BriefIssue {
  path: string;
  message: string;
  fix: string;
}

export interface BriefSemanticResult {
  ok: boolean;
  errors: BriefIssue[];
  warnings: BriefIssue[];
}

/** Typical duration and aspect ratio per platform (norms, not hard limits). */
export const PLATFORM_NORMS: Record<Platform, { min_sec: number; max_sec: number; aspect_ratios: AspectRatio[] }> = {
  instagram_reels: { min_sec: 7, max_sec: 90, aspect_ratios: ["9:16"] },
  tiktok: { min_sec: 7, max_sec: 90, aspect_ratios: ["9:16"] },
  youtube_shorts: { min_sec: 7, max_sec: 90, aspect_ratios: ["9:16"] },
  youtube: { min_sec: 30, max_sec: 600, aspect_ratios: ["16:9"] },
  linkedin: { min_sec: 15, max_sec: 180, aspect_ratios: ["1:1", "4:5", "9:16", "16:9"] },
  x: { min_sec: 7, max_sec: 140, aspect_ratios: ["16:9", "1:1", "9:16"] },
  generic: { min_sec: 1, max_sec: 600, aspect_ratios: ["9:16", "16:9", "1:1", "4:5"] },
};

/** Minimum number of hook candidates the plan skill should propose. */
export const MIN_HOOK_CANDIDATES = 3;

const normHook = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Cross-field checks for a parsed CreativeBrief (the schema covers structural errors). */
export function validateCreativeBriefSemantics(brief: CreativeBrief): BriefSemanticResult {
  const errors: BriefIssue[] = [];
  const warnings: BriefIssue[] = [];
  const n = brief.hook_candidates.length;
  if (n < MIN_HOOK_CANDIDATES) {
    warnings.push({
      path: "hook_candidates",
      message: `only ${n} hook candidate${n === 1 ? "" : "s"}; propose at least ${MIN_HOOK_CANDIDATES}`,
      fix: `add ${MIN_HOOK_CANDIDATES - n} more hook_candidates using different mechanisms (e.g. question, statistic, contrarian) and score each`,
    });
  }
  const counts = new Map<string, number>();
  for (const h of brief.hook_candidates) counts.set(h.mechanism, (counts.get(h.mechanism) ?? 0) + 1);
  const repeated = [...counts].filter(([, c]) => c > 1).map(([m]) => m);
  if (repeated.length > 0) {
    warnings.push({
      path: "hook_candidates",
      message: `hook mechanisms are not distinct (repeated: ${repeated.join(", ")})`,
      fix: "give each hook candidate a different mechanism so the user gets a real choice",
    });
  }
  const chosen = normHook(brief.chosen_hook);
  if (!brief.hook_candidates.some((h) => normHook(h.text) === chosen)) {
    errors.push({
      path: "chosen_hook",
      message: `chosen_hook "${brief.chosen_hook}" is not among hook_candidates`,
      fix: "set chosen_hook to the exact text of one hook_candidates[].text, or add it as a scored candidate",
    });
  }
  if (brief.assumptions.length === 0) {
    warnings.push({
      path: "assumptions",
      message: "no assumptions listed",
      fix: "list every inferred field (audience, platform, duration, tone, goal) with its value and reason so the user can confirm it",
    });
  }
  const norm = PLATFORM_NORMS[brief.platform];
  if (brief.target_duration_sec > norm.max_sec || brief.target_duration_sec < norm.min_sec) {
    warnings.push({
      path: "target_duration_sec",
      message: `${brief.target_duration_sec}s is outside the usual ${norm.min_sec}–${norm.max_sec}s for ${brief.platform}`,
      fix: `choose a duration between ${norm.min_sec} and ${norm.max_sec}s, or record why in assumptions`,
    });
  }
  if (!norm.aspect_ratios.includes(brief.aspect_ratio)) {
    warnings.push({
      path: "aspect_ratio",
      message: `aspect ratio ${brief.aspect_ratio} is unusual for ${brief.platform}`,
      fix: `use ${norm.aspect_ratios.join(" or ")}`,
    });
  }
  if (brief.tone.length === 0) {
    warnings.push({ path: "tone", message: "tone is empty", fix: "add 1–3 tone words, e.g. clear, confident" });
  }
  return { ok: errors.length === 0, errors, warnings };
}

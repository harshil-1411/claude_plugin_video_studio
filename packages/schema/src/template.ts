import { z } from "zod";
import { AspectRatio, Goal, Id, NonEmptyString, Platform, SchemaVersion } from "./common.js";
import { HookMechanism } from "./creative-brief.js";
import { DeterministicKind, ScenePurpose, VisualStrategy } from "./video-spec.js";

/** Allowed deviation of summed beat shares from 1. */
export const BEAT_SHARE_TOLERANCE = 0.01;

export const TemplateBeat = z
  .strictObject({
    purpose: ScenePurpose,
    share: z.number().gt(0).lte(1).describe("Fraction of the total duration for this beat; all beats sum to 1 (±0.01)."),
    guidance: NonEmptyString.describe("One or two sentences on what this beat must do."),
    suggested_visual_strategy: VisualStrategy,
    suggested_deterministic_kind: DeterministicKind.optional(),
    optional: z.boolean().optional().describe("Beat may be dropped for short cuts; remaining shares are renormalized."),
  })
  .describe("One beat of a template's story structure; becomes one scene when scaffolded.");

export const TemplatePacing = z.strictObject({
  avg_shot_sec: z.number().positive().max(30),
  max_words_per_sec: z.number().positive().max(6),
});

export const DurationRange = z.strictObject({
  min_sec: z.number().positive(),
  max_sec: z.number().positive().max(600),
});

export const Template = z
  .strictObject({
    schema_version: SchemaVersion,
    id: Id,
    name: NonEmptyString,
    description: NonEmptyString,
    goals: z.array(Goal).min(1),
    platforms: z.array(Platform).min(1),
    default_aspect_ratio: AspectRatio.optional(),
    default_duration_sec: z.number().positive().max(600),
    duration_range: DurationRange,
    pacing: TemplatePacing,
    caption_preset: Id,
    beats: z.array(TemplateBeat).min(2),
    hook_mechanisms: z.array(HookMechanism).min(1).describe("Preferred hook mechanisms, best first."),
    rules: z.array(NonEmptyString).describe("Story rules the plan must follow, e.g. one idea per scene."),
  })
  .superRefine((t, ctx) => {
    const sum = t.beats.reduce((s, b) => s + b.share, 0);
    if (Math.abs(sum - 1) > BEAT_SHARE_TOLERANCE) {
      ctx.addIssue({ code: "custom", path: ["beats"], message: `beat shares sum to ${Math.round(sum * 1000) / 1000}, expected 1 ±${BEAT_SHARE_TOLERANCE}` });
    }
    if (t.duration_range.min_sec > t.duration_range.max_sec) {
      ctx.addIssue({ code: "custom", path: ["duration_range"], message: "min_sec must be <= max_sec" });
    }
    if (t.default_duration_sec < t.duration_range.min_sec || t.default_duration_sec > t.duration_range.max_sec) {
      ctx.addIssue({ code: "custom", path: ["default_duration_sec"], message: "default_duration_sec must lie within duration_range" });
    }
  })
  .meta({
    id: "Template",
    title: "Template",
    description:
      "A story template as data: beat structure with duration shares, pacing, caption preset, preferred hook mechanisms and rules.",
  });

export type TemplateBeat = z.infer<typeof TemplateBeat>;
export type TemplatePacing = z.infer<typeof TemplatePacing>;
export type Template = z.infer<typeof Template>;

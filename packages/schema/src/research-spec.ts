import { z } from "zod";
import { NonEmptyString, SchemaVersion } from "./common.js";
import { Acceptance } from "./craft.js";
import { Transition } from "./video-spec.js";

/**
 * research-specs/titles.yaml: title heuristics as dated data. They are heuristics, not platform
 * limits: lint reports them as warnings only, and `verified` stays false until someone checks
 * them against the user's own analytics (Phase 9).
 */
export const TitleRules = z
  .strictObject({
    schema_version: SchemaVersion,
    id: z.literal("titles"),
    title_length: z
      .strictObject({ min_chars: z.int().positive(), max_chars: z.int().positive() })
      .refine((r) => r.min_chars <= r.max_chars, "min_chars must be <= max_chars")
      .describe("Titles outside this band get a title_length warning."),
    basis: z.enum(["heuristic", "measured"]),
    verified: z.boolean(),
    verified_on: z.iso.date().optional(),
    notes: z.array(NonEmptyString).optional(),
  })
  .meta({ id: "TitleRules", title: "TitleRules", description: "research-specs/titles.yaml: title heuristics (length band) as dated data; warnings only." });

export type TitleRules = z.infer<typeof TitleRules>;

/** How much sound design a tone carries: none, a few accents, one per beat of the story, or dense. */
export const SfxDensity = z.enum(["none", "sparse", "moderate", "dense"]);

/**
 * One tone preset: the pacing, transitions and sound a tone implies. The plan skill maps free-text
 * direction ("fake Series A launch from 2016") to the nearest preset; `spec_scaffold` applies it
 * under the template, and the brief's own values win.
 */
export const TonePreset = z.strictObject({
  label: NonEmptyString,
  feel: NonEmptyString.describe("One line: how it should feel."),
  scenes: z
    .strictObject({ min: z.int().positive(), max: z.int().positive() })
    .refine((r) => r.min <= r.max, "min must be <= max")
    .describe("Scene count for a 15–25 s piece."),
  avg_shot_sec: z.number().positive().max(30),
  transitions: z.array(Transition).min(1).describe("Transitions that fit; the first is the default."),
  sfx: SfxDensity,
  bed_db: z.number().min(-40).max(0).describe("Music bed level under the mix (the engine default is -18)."),
  caption_case: z.enum(["as_written", "upper", "lower"]).optional(),
  acceptance: Acceptance.optional().describe("Acceptance hints for the tone, under the template's and the brief's."),
});

/** research-specs/tones.yaml: tone presets as data (pacing, transitions, sound). Heuristics, not rules. */
export const ToneRules = z
  .strictObject({
    schema_version: SchemaVersion,
    id: z.literal("tones"),
    default: NonEmptyString.describe("Preset used when nothing clearly fits."),
    presets: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), TonePreset),
    basis: z.enum(["heuristic", "measured"]),
    verified: z.boolean(),
    notes: z.array(NonEmptyString).optional(),
  })
  .refine((r) => r.default in r.presets, "default must name a preset")
  .meta({ id: "ToneRules", title: "ToneRules", description: "research-specs/tones.yaml: tone presets (pacing, transitions, sound density, bed level) as data." });

/**
 * research-specs/cliches.yaml: stock phrases that make copy generic. Lint reports them as
 * `cliche` warnings in every text channel; a brand's own banned_phrases stay errors.
 */
export const ClicheRules = z
  .strictObject({
    schema_version: SchemaVersion,
    id: z.literal("cliches"),
    phrases: z.array(NonEmptyString).min(1).describe("Matched case-insensitively on word boundaries."),
    notes: z.array(NonEmptyString).optional(),
  })
  .meta({ id: "ClicheRules", title: "ClicheRules", description: "research-specs/cliches.yaml: stock phrases lint warns about in voiceover, on-screen text, cover and post copy." });

export type SfxDensity = z.infer<typeof SfxDensity>;
export type TonePreset = z.infer<typeof TonePreset>;
export type ToneRules = z.infer<typeof ToneRules>;
export type ClicheRules = z.infer<typeof ClicheRules>;

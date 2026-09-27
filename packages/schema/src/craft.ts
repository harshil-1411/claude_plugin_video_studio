import { z } from "zod";

/**
 * Craft vocabulary shared by specs, briefs, templates and style packs (Phase 6.5): the effects a
 * style can ban, measurable acceptance checks, local score synthesis, and project-relative files.
 */

/**
 * Effects that make motion look templated. A style's `motion.avoid` bans them; a `motion` scene
 * declares the ones it uses in `props.effects`, and lint reports the overlap as `banned_effect`.
 */
export const EffectId = z.enum([
  "shake",
  "rgb_split",
  "lens_flare",
  "particle_burst",
  "shockwave",
  "neon_glow",
  "grid_floor",
  "flash",
  "bouncy_easing",
]);

/**
 * Measurable acceptance checks for a piece. The plan skill turns vague asks ("go all out") into
 * these numbers; QA and lint check the render against them.
 */
export const Acceptance = z
  .strictObject({
    min_changes_per_sec: z.number().min(0).max(10).optional().describe("Big visual changes per second the render must reach (motion density)."),
    max_frozen_pct: z.number().min(0).max(100).optional().describe("Most of the runtime that may be frozen, in percent (default 15)."),
    max_static_sec: z.number().positive().max(60).optional().describe("Longest allowed stretch with no visual change."),
    hold_ms: z.int().min(0).max(5000).optional().describe("At least one deliberate hold this long, so change feels earned (e.g. 400)."),
    loop: z.boolean().optional().describe("The piece must loop seamlessly (last frame flows into the first)."),
  })
  .describe("Measurable acceptance checks; the numbers QA and lint hold the render to.");

/** A roman-numeral chord degree; lower case is minor (e.g. vi). */
export const ChordDegree = z.enum(["I", "ii", "iii", "IV", "V", "vi", "vii", "i", "III", "iv", "v", "VI", "VII"]);

/**
 * Parameters for a locally synthesized score (ffmpeg only, no downloads). Deterministic: the same
 * parameters always give the same audio, so the beat grid is known without detection.
 */
export const SynthParams = z
  .strictObject({
    bpm: z.int().min(60).max(200),
    key: z
      .string()
      .regex(/^[A-G](#|b)?m?$/, "expected a key like C, F#, Bb or Am")
      .optional()
      .describe("Musical key (default C, or Am for minor presets)."),
    progression: z.array(ChordDegree).min(1).max(16).optional().describe("Chord degrees, one per bar, repeated."),
    drop_bar: z.int().min(1).max(256).optional().describe("Bar where the full arrangement enters (1-based)."),
    seed: z.int().min(0).optional().describe("Seed for the hi-hat and texture patterns."),
  })
  .describe("A locally synthesized score; `music.file` names the preset as `synth:<preset>`.");

/**
 * A path relative to the project folder: no absolute paths, no `..` segments and no URL schemes.
 * The engine still resolves it with symlink checks before reading it.
 */
export const ProjectRelativePath = z
  .string()
  .min(1)
  .refine((p) => !/^([a-zA-Z]:)?[\\/]/.test(p), "must be relative to the project folder")
  .refine((p) => !p.split(/[\\/]/).includes(".."), "must not contain `..`")
  .refine((p) => !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p), "must be a project file, not a URL");

/**
 * A glossary entry: the correct spelling of a name or term, and the ways speech recognition
 * mishears it. Transcripts and captions are corrected to `term` (word timings kept); TTS
 * pronunciation stays in `brand.language.terminology`.
 */
export const GlossaryEntry = z.strictObject({
  term: z.string().min(1).describe("The correct spelling, e.g. MSB Docs."),
  variants: z.array(z.string().min(1)).optional().describe("Mishearings to replace, e.g. [\"MSP docs\", \"M S B docks\"]; matching ignores case unless case_sensitive."),
  case_sensitive: z.boolean().optional(),
});

export type EffectId = z.infer<typeof EffectId>;
export type GlossaryEntry = z.infer<typeof GlossaryEntry>;
export type Acceptance = z.infer<typeof Acceptance>;
export type ChordDegree = z.infer<typeof ChordDegree>;
export type SynthParams = z.infer<typeof SynthParams>;

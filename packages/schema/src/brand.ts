import { z } from "zod";
import { FilePath, HexColor, Id, LanguageTag, NonEmptyString } from "./common.js";

/** CSS font weight, 100–900 in steps of 100. */
export const FontWeight = z.int().min(100).max(900).multipleOf(100);

export const LogoPosition = z.enum(["top_left", "top_right", "bottom_left", "bottom_right", "end_card_only", "none"]);

export const MotionPersonality = z.enum(["calm", "precise", "friendly", "energetic", "playful"]);

export const BrandCaptions = z
  .strictObject({
    family: NonEmptyString.optional().describe("Caption font family; defaults to the body font."),
    weight: FontWeight.optional(),
    active_word: z.boolean().optional().describe("Karaoke-style active-word highlight. Off by default: keyword emphasis only."),
    plate_opacity: z.number().min(0).max(1).optional().describe("Opacity of the plate behind caption text (0 = no plate)."),
    max_lines: z.int().min(1).max(3).optional(),
  })
  .describe("Burned-in caption styling.");

export const BrandMotion = z
  .strictObject({
    personality: MotionPersonality.optional().describe("Maps to easing curves and durations in the renderers."),
    transition_ms: z.int().min(0).max(2000).optional(),
  })
  .describe("Motion tokens.");

export const Brand = z
  .strictObject({
    version: z.union([z.literal(1), z.literal(2)]).optional().describe("brand.yaml format version. 2 adds captions, motion, weights, logo placement and banned phrases; 1 files stay valid."),
    brand: z.strictObject({
      name: NonEmptyString,
      id: Id.optional(),
    }),
    voice: z
      .strictObject({
        personality: z.array(NonEmptyString),
        avoid: z.array(NonEmptyString).describe("Words and phrases the script should avoid (warning)."),
        banned_phrases: z
          .array(NonEmptyString)
          .optional()
          .describe("Phrases that must never appear in voiceover, on-screen text, cover or post copy (error)."),
      })
      .optional(),
    visual: z
      .strictObject({
        fonts: z.strictObject({
          heading: NonEmptyString,
          body: NonEmptyString,
          mono: NonEmptyString.optional(),
        }),
        weights: z.strictObject({ heading: FontWeight.optional(), body: FontWeight.optional() }).optional(),
        font_fallbacks: z
          .array(NonEmptyString)
          .optional()
          .describe("Families appended to every font chain for scripts the brand fonts lack, e.g. Noto Sans JP."),
        palette: z
          .record(z.string(), HexColor)
          .describe("Named colour tokens, e.g. primary, secondary, background, text."),
        logo: FilePath.optional(),
        logo_placement: z
          .strictObject({
            position: LogoPosition,
            max_fraction: z.number().positive().max(0.5).optional().describe("Largest logo width as a fraction of frame width."),
          })
          .optional(),
        forbidden: z
          .array(NonEmptyString)
          .optional()
          .describe("Visual treatments the brand never uses, e.g. \"drop shadows\", \"gradients on logo\"."),
      })
      .optional(),
    captions: BrandCaptions.optional(),
    motion: BrandMotion.optional(),
    video: z
      .strictObject({
        caption_preset: Id.optional(),
        transition_style: z.enum(["restrained", "balanced", "energetic"]).optional(),
        shot_pacing: z.enum(["slow", "medium", "fast"]).optional(),
        end_card: FilePath.optional(),
      })
      .optional(),
    language: z
      .strictObject({
        locale: LanguageTag,
        terminology: z
          .record(z.string(), z.string())
          .optional()
          .describe("Pronunciation or spelling overrides for TTS, e.g. {\"CI/CD\": \"C I C D\"}."),
      })
      .optional(),
    claims: z
      .strictObject({
        prohibited: z.array(NonEmptyString),
      })
      .optional(),
    cta: z
      .strictObject({
        allowed: z.array(NonEmptyString),
      })
      .optional(),
  })
  .meta({
    id: "Brand",
    title: "Brand",
    description: "brand.yaml: brand voice, visual tokens, caption and motion styling, video defaults, terminology, prohibited claims and allowed CTAs.",
  });

export type FontWeight = z.infer<typeof FontWeight>;
export type LogoPosition = z.infer<typeof LogoPosition>;
export type MotionPersonality = z.infer<typeof MotionPersonality>;
export type BrandCaptions = z.infer<typeof BrandCaptions>;
export type BrandMotion = z.infer<typeof BrandMotion>;
export type Brand = z.infer<typeof Brand>;

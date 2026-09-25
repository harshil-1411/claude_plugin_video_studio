import { z } from "zod";
import { FilePath, HexColor, Id, LanguageTag, NonEmptyString } from "./common.js";

export const Brand = z
  .strictObject({
    version: z.literal(1).optional().describe("brand.yaml format version."),
    brand: z.strictObject({
      name: NonEmptyString,
      id: Id.optional(),
    }),
    voice: z
      .strictObject({
        personality: z.array(NonEmptyString),
        avoid: z.array(NonEmptyString).describe("Words and phrases the script must not use."),
      })
      .optional(),
    visual: z
      .strictObject({
        fonts: z.strictObject({
          heading: NonEmptyString,
          body: NonEmptyString,
          mono: NonEmptyString.optional(),
        }),
        palette: z
          .record(z.string(), HexColor)
          .describe("Named colour tokens, e.g. primary, secondary, background, text."),
        logo: FilePath.optional(),
      })
      .optional(),
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
    description: "brand.yaml: brand voice, visual tokens, video defaults, terminology, prohibited claims and allowed CTAs.",
  });

export type Brand = z.infer<typeof Brand>;

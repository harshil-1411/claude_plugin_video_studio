import { z } from "zod";
import { HexColor, Id, NonEmptyString } from "./common.js";
import { BrandCaptions, FontWeight, MotionPersonality } from "./brand.js";
import { Transition } from "./video-spec.js";

/** Easing curves the renderers implement (CSS/GSAP in HyperFrames, alpha/position curves in ffmpeg). */
export const Easing = z.enum(["linear", "ease_out", "ease_in_out", "spring", "snap"]);

export const StyleMotion = z
  .strictObject({
    personality: MotionPersonality,
    easing: Easing,
    enter_ms: z.int().min(0).max(2000).describe("How long an element takes to appear."),
    exit_ms: z.int().min(0).max(2000),
    stagger_ms: z.int().min(0).max(1000).describe("Delay between successive elements (lines, bullets, words)."),
    transition: Transition.describe("Default transition between scenes."),
    transition_ms: z.int().min(0).max(2000),
  })
  .describe("Motion tokens; brand.motion overrides personality and transition_ms when set.");

/**
 * styles/<id>.yaml: a look-and-motion pack (minimal, editorial, technical, energetic, ...).
 * Precedence when rendering: renderer defaults < style < brand (brand colours, fonts, weights and
 * motion win, because they are the user's identity).
 */
export const Style = z
  .strictObject({
    id: Id.describe("Must equal the file name: styles/<id>.yaml."),
    name: NonEmptyString,
    version: z.int().positive().describe("Bumped whenever a value changes (part of the scene cache key)."),
    description: NonEmptyString,
    palette: z
      .strictObject({ background: HexColor.optional(), text: HexColor.optional(), primary: HexColor.optional(), secondary: HexColor.optional() })
      .optional(),
    fonts: z.strictObject({ heading: z.string().optional(), body: z.string().optional(), mono: z.string().optional() }).optional(),
    weights: z.strictObject({ heading: FontWeight.optional(), body: FontWeight.optional() }).optional(),
    text: z
      .strictObject({
        case: z.enum(["as_is", "upper", "title"]).optional().describe("Heading case transform."),
        heading_scale: z.number().min(0.6).max(1.6).optional().describe("Multiplier on the heading size the layout would pick."),
        align: z.enum(["center", "left"]).optional(),
      })
      .optional(),
    motion: StyleMotion,
    captions: BrandCaptions.optional(),
  })
  .meta({
    id: "Style",
    title: "Style",
    description: "styles/<id>.yaml: a style pack (palette, fonts, weights, text treatment, motion and caption styling) a spec selects with `style`.",
  });

export type Easing = z.infer<typeof Easing>;
export type StyleMotion = z.infer<typeof StyleMotion>;
export type Style = z.infer<typeof Style>;

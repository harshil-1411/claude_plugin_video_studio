import { z } from "zod";
import { Id, NonEmptyString, SchemaVersion } from "./common.js";

/**
 * Phase 6 documents: a demo capture script (the user's running app → a screen recording), a
 * reference video's format grammar (structure only), and long-to-short clip candidates.
 */

export const DemoStep = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("goto"), url: NonEmptyString, wait_ms: z.int().min(0).max(30_000).optional() }),
  z.strictObject({ action: z.literal("click"), selector: NonEmptyString, wait_ms: z.int().min(0).max(30_000).optional() }),
  z.strictObject({ action: z.literal("type"), selector: NonEmptyString, text: z.string(), delay_ms: z.int().min(0).max(500).optional() }),
  z.strictObject({ action: z.literal("hover"), selector: NonEmptyString }),
  z.strictObject({ action: z.literal("scroll"), y: z.int(), smooth: z.boolean().optional() }),
  z.strictObject({
    action: z.literal("zoom"),
    selector: NonEmptyString.describe("Element to zoom into (applied in post, from its box)."),
    scale: z.number().min(1).max(4).optional(),
    hold_ms: z.int().min(0).max(10_000).optional(),
  }),
  z.strictObject({ action: z.literal("wait"), ms: z.int().min(0).max(30_000) }),
]);

export const DemoScript = z
  .strictObject({
    schema_version: SchemaVersion,
    id: Id,
    url: z.url().describe("The app the USER started, e.g. http://localhost:3000. The plugin never starts it."),
    viewport: z
      .strictObject({
        width: z.int().min(320).max(3840).describe("Recording width in output pixels."),
        height: z.int().min(320).max(3840).describe("Recording height in output pixels."),
        device_scale_factor: z
          .number()
          .min(1)
          .max(4)
          .optional()
          .describe(
            "Output pixels per CSS pixel: the page lays out at width / factor CSS px. Default: portrait recordings wider than 600 px lay out at phone width (390 CSS px), others at 1.",
          ),
      })
      .describe("Recording size. 1080x1920 records a phone-width layout at reel resolution; 1920x1080 a desktop layout."),
    steps: z.array(DemoStep).min(1).max(60),
    mask_selectors: z.array(NonEmptyString).optional().describe("Elements blurred in the recording (inputs are always masked)."),
    max_duration_sec: z.number().positive().max(300).optional(),
  })
  .meta({ id: "DemoScript", title: "DemoScript", description: "project/demo.json: a scripted walk through the user's running app, recorded by the demo tool." });

export const FormatGrammar = z
  .strictObject({
    schema_version: SchemaVersion,
    duration_sec: z.number().nonnegative(),
    aspect_ratio: z.string(),
    shots: z.array(z.strictObject({ start_sec: z.number().nonnegative(), end_sec: z.number().positive() })),
    avg_shot_sec: z.number().nonnegative(),
    cuts_per_10s: z.number().nonnegative(),
    hook_shot_sec: z.number().nonnegative().describe("Length of the first shot."),
    has_speech: z.boolean().optional(),
    speech_ratio: z.number().min(0).max(1).optional(),
    loudness_lufs: z.number().optional(),
    caption_band: z
      .strictObject({ y_from: z.number().min(0).max(1), y_to: z.number().min(0).max(1) })
      .nullable()
      .describe("Where burned-in text most likely sits (normalized), or null when none was found."),
    pacing: z.enum(["slow", "medium", "fast"]),
    notes: z.array(z.string()),
  })
  .meta({
    id: "FormatGrammar",
    title: "FormatGrammar",
    description: "A reference video's structure (shot lengths, pacing, caption band, speech share). Never its words, images or audio.",
  });

export const ShortCandidate = z.strictObject({
  id: Id,
  asset: Id,
  start_sec: z.number().nonnegative(),
  end_sec: z.number().positive(),
  score: z.number().min(0).max(1),
  reasons: z.array(z.string()),
  transcript: z.string().describe("The words spoken in the span."),
  hook: z.string().describe("The first sentence of the span."),
});

export const ShortCandidates = z
  .strictObject({
    schema_version: SchemaVersion,
    asset: Id,
    target_sec: z.strictObject({ min: z.number().positive(), max: z.number().positive() }),
    candidates: z.array(ShortCandidate),
  })
  .meta({ id: "ShortCandidates", title: "ShortCandidates", description: "Scored spans of a long recording that could stand alone as shorts." });

export type DemoStep = z.infer<typeof DemoStep>;
export type DemoScript = z.infer<typeof DemoScript>;
export type FormatGrammar = z.infer<typeof FormatGrammar>;
export type ShortCandidate = z.infer<typeof ShortCandidate>;
export type ShortCandidates = z.infer<typeof ShortCandidates>;

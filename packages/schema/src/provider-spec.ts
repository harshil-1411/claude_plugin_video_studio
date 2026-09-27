import { z } from "zod";
import { Id, NonEmptyString, SchemaVersion } from "./common.js";

/**
 * provider-specs/<family>.yaml: what a video-generation model family accepts, as data (limits,
 * reference syntax, audio channels, negative prompts), with the source it was read from and
 * when. Prompt compilers read it; no limit lives in code or skill prose. Specs are hypotheses
 * until re-verified: `verified: false` until someone re-checks the live docs, and the compiler
 * says so in every prompt pack.
 */

export const ProviderFamily = z.enum(["seedance", "veo", "kling", "wan", "runway", "hailuo"]);

export const GenerationMode = z.enum(["text_to_video", "image_to_video", "reference_to_video", "first_last_frame", "extend"]);

const Ratio = z.string().regex(/^\d+:\d+$/, "expected an aspect ratio like 16:9");
const Url = z.url({ protocol: /^https$/ });
const IsoDate = z.iso.date();

export const ProviderModel = z.strictObject({
  id: NonEmptyString.describe("Model id as the provider documents it (re-check before use; preview ids change)."),
  label: z.string().optional(),
  modes: z.array(GenerationMode).min(1),
  notes: z.array(NonEmptyString).optional(),
});

export const ProviderAccess = z
  .strictObject({
    via: z.enum(["direct", "fal", "replicate"]),
    env: z.string().regex(/^[A-Z][A-Z0-9_]*$/).describe("Env var holding the credential; must be in the credential registry."),
    docs_url: Url,
  })
  .describe("One way to reach the models; the credential is a placeholder until Phase 7 wires it.");

export const ProviderSpec = z
  .strictObject({
    schema_version: SchemaVersion,
    id: ProviderFamily.describe("Must equal the file name: provider-specs/<id>.yaml."),
    name: NonEmptyString,
    models: z.array(ProviderModel).min(1),
    duration: z
      .strictObject({
        min_sec: z.number().positive(),
        max_sec: z.number().positive().max(600),
        allowed_sec: z.array(z.number().positive()).optional().describe("Only these lengths, when the provider has fixed steps."),
      })
      .refine((d) => d.min_sec <= d.max_sec, "min_sec must be <= max_sec"),
    aspect_ratios: z.array(Ratio).min(1),
    resolutions: z.array(NonEmptyString).optional(),
    references: z
      .strictObject({
        max_images: z.int().min(0).optional(),
        max_videos: z.int().min(0).optional(),
        max_audio: z.int().min(0).optional(),
        syntax: NonEmptyString.describe("How a prompt names a reference, e.g. @Image{n} or @Element{n}."),
      })
      .optional(),
    audio: z.strictObject({
      native: z.boolean().describe("Generates sound with the video."),
      syntax: z.string().optional().describe("How dialogue, SFX and music are written in the prompt."),
    }),
    negatives: z.enum(["supported", "unsupported", "positive_only"]).describe("positive_only: phrase exclusions as positive statements (\"the camera remains still\")."),
    multi_shot: z.strictObject({ max_shots: z.int().min(1), syntax: NonEmptyString }).optional(),
    camera_syntax: z.string().optional().describe("Bracketed camera commands or other special camera phrasing."),
    prompt_max_chars: z.int().positive().optional(),
    prompt_formula: NonEmptyString.describe("The order the provider's guide recommends, e.g. subject + action + scene + camera + style."),
    access: z.array(ProviderAccess).min(1),
    source_urls: z.array(Url).min(1),
    verified_on: IsoDate.describe("When the facts were read from the sources."),
    verified: z.boolean().describe("false until re-checked against the live docs when Phase 7 starts."),
    notes: z.array(NonEmptyString).optional(),
  })
  .meta({
    id: "ProviderSpec",
    title: "ProviderSpec",
    description: "provider-specs/<family>.yaml: a video-generation model family's limits and prompt syntax, as dated, sourced data.",
  });

export type ProviderFamily = z.infer<typeof ProviderFamily>;
export type GenerationMode = z.infer<typeof GenerationMode>;
export type ProviderModel = z.infer<typeof ProviderModel>;
export type ProviderAccess = z.infer<typeof ProviderAccess>;
export type ProviderSpec = z.infer<typeof ProviderSpec>;

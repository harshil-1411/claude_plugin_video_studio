import { z } from "zod";
import { AspectRatio, DataPolicy, FilePath, Id, NonEmptyString, Sha256, UsdAmount } from "./common.js";
import { SceneId } from "./video-spec.js";

export const Resolution = z.enum(["480p", "540p", "720p", "1080p", "1440p", "4k"]);

export const CapabilityMatrix = z
  .strictObject({
    text_to_video: z.boolean(),
    image_to_video: z.boolean(),
    video_to_video: z.boolean(),
    character_reference: z.boolean(),
    native_audio: z.boolean(),
    max_duration_seconds: z.number().positive(),
    min_duration_seconds: z.number().positive(),
    aspect_ratios: z.array(AspectRatio).min(1),
    resolutions: z.array(Resolution).min(1),
    data_regions: z.array(NonEmptyString).min(1).describe("e.g. `provider-default`, `us`, `eu`."),
  })
  .meta({
    id: "CapabilityMatrix",
    title: "CapabilityMatrix",
    description: "What a provider adapter can do, expressed as capabilities rather than model names.",
  });

export const ReferenceImage = z.strictObject({
  path: FilePath,
  sha256: Sha256,
  role: z.enum(["first_frame", "last_frame", "character", "style", "product"]),
});

export const SceneGenerationRequest = z
  .strictObject({
    project_id: Id,
    scene_id: SceneId,
    modality: z.enum(["video", "image"]),
    prompt: NonEmptyString,
    negative_prompt: z.string().optional(),
    duration_sec: z.number().positive(),
    aspect_ratio: AspectRatio,
    resolution: Resolution.optional(),
    seed: z.int().optional(),
    reference_images: z.array(ReferenceImage),
    reference_video: z.strictObject({ path: FilePath, sha256: Sha256 }).optional(),
    generate_audio: z.boolean(),
    data_policy: DataPolicy,
    max_cost_usd: UsdAmount.optional(),
  })
  .meta({
    id: "SceneGenerationRequest",
    title: "SceneGenerationRequest",
    description: "Provider-neutral request to generate one scene's media, derived from a VideoSpec scene by the router.",
  });

export type Resolution = z.infer<typeof Resolution>;
export type CapabilityMatrix = z.infer<typeof CapabilityMatrix>;
export type ReferenceImage = z.infer<typeof ReferenceImage>;
export type SceneGenerationRequest = z.infer<typeof SceneGenerationRequest>;

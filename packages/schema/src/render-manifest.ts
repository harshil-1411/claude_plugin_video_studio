import { z } from "zod";
import { AspectRatio, FilePath, Id, IsoDateTime, NonEmptyString, SchemaVersion, Sha256, UsdAmount } from "./common.js";
import { TimingSource } from "./timing.js";
import { SceneId } from "./video-spec.js";

export const RenderStatus = z.enum(["pending", "submitted", "running", "succeeded", "failed", "cancelled", "cached"]);

export const SceneRender = z.strictObject({
  scene_id: SceneId,
  provider: Id.describe("Adapter id that produced the output, e.g. `mock` or `hyperframes-local`."),
  model: z.string().optional(),
  prompt: z.string().optional(),
  seed: z.int().optional(),
  task_id: z.string().optional().describe("Provider task/job id, persisted as soon as it is known."),
  request_hash: Sha256.describe("Canonical-JSON hash of the generation request; the idempotency key."),
  output_path: FilePath,
  output_sha256: Sha256,
  cost_usd: UsdAmount.optional(),
  started_at: IsoDateTime,
  finished_at: IsoDateTime,
  attempts: z.int().positive(),
  status: RenderStatus,
  error: z.string().optional(),
  renderer_version: z.string().optional().describe("Version of the local renderer or adapter that produced the output."),
  placeholder: z.boolean().optional().describe("True when the output is a titled stand-in for a scene a provider must still render."),
  warnings: z.array(z.string()).optional(),
});

export const VoiceRender = z.strictObject({
  provider: Id,
  model: z.string().optional(),
  voice_id: z.string().optional(),
  request_hash: Sha256,
  output_path: FilePath,
  output_sha256: Sha256,
  alignment_path: FilePath.optional().describe("Word-timing JSON used for captions."),
  timing_source: TimingSource.optional().describe("How word timings were obtained (provider, aligned, estimated, none)."),
  reason: z.string().optional().describe("Why this voice backend was used, including any fallback."),
  cost_usd: UsdAmount.optional(),
  started_at: IsoDateTime.optional(),
  finished_at: IsoDateTime.optional(),
});

export const CaptionFormat = z.enum(["json", "srt", "vtt", "ass", "html"]);

export const CaptionsRender = z.strictObject({
  preset: Id,
  burn_in: z.boolean(),
  files: z.array(
    z.strictObject({
      format: CaptionFormat,
      path: FilePath,
      sha256: Sha256,
    }),
  ),
});

export const OutputKind = z.enum([
  "final",
  "clean_master",
  "captions",
  "thumbnail",
  "social_copy",
  "provenance",
  "manifest",
  "other",
]);

export const FinalOutput = z.strictObject({
  kind: OutputKind,
  path: FilePath,
  sha256: Sha256,
  width: z.int().positive().optional(),
  height: z.int().positive().optional(),
  duration_sec: z.number().nonnegative().optional(),
});

export const QaStatus = z.enum(["pass", "warn", "fail"]);

export const QaSummary = z.strictObject({
  status: QaStatus,
  checks: z.array(
    z.strictObject({
      id: Id,
      status: QaStatus,
      message: z.string().optional(),
      scene_id: SceneId.optional(),
    }),
  ),
  report_path: FilePath.optional(),
});

/** A scene whose render length differs from the spec (e.g. the voice ran longer); the spec itself is unchanged. */
export const TimingAdjustment = z.strictObject({
  scene_id: SceneId,
  spec_duration_sec: z.number().positive(),
  render_duration_sec: z.number().positive(),
  reason: z.string(),
});

export const RenderSettings = z.strictObject({
  quality: z.enum(["preview", "final"]),
  width: z.int().positive(),
  height: z.int().positive(),
  fps: z.number().positive(),
  aspect_ratio: AspectRatio,
  renderer_preference: z.string().optional(),
  renderer_reasons: z.array(z.string()).optional().describe("Why each renderer was chosen, including fallbacks."),
});

export const RenderManifest = z
  .strictObject({
    schema_version: SchemaVersion,
    project_id: Id,
    spec_sha256: Sha256.describe("Canonical-JSON hash of the VideoSpec that was rendered."),
    content_ir_sha256: Sha256.optional(),
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
    renders: z.array(SceneRender),
    voice: VoiceRender.optional(),
    captions: CaptionsRender.optional(),
    outputs: z.array(FinalOutput),
    qa: QaSummary.optional(),
    settings: RenderSettings.optional(),
    timing_adjustments: z.array(TimingAdjustment).optional(),
    warnings: z.array(z.string()).optional(),
    total_cost_usd: UsdAmount.optional(),
    tool_versions: z
      .record(z.string(), z.string())
      .describe("Versions of every tool involved, e.g. {\"ffmpeg\": \"7.1\", \"hyperframes\": \"0.4.2\"}."),
  })
  .meta({
    id: "RenderManifest",
    title: "RenderManifest",
    description:
      "Exactly what happened: per-scene provider/model, prompts, seeds, task ids, hashes, cost, timestamps, retries, outputs, QA and tool versions.",
  });

export type RenderStatus = z.infer<typeof RenderStatus>;
export type SceneRender = z.infer<typeof SceneRender>;
export type VoiceRender = z.infer<typeof VoiceRender>;
export type CaptionFormat = z.infer<typeof CaptionFormat>;
export type CaptionsRender = z.infer<typeof CaptionsRender>;
export type OutputKind = z.infer<typeof OutputKind>;
export type FinalOutput = z.infer<typeof FinalOutput>;
export type QaStatus = z.infer<typeof QaStatus>;
export type QaSummary = z.infer<typeof QaSummary>;
export type TimingAdjustment = z.infer<typeof TimingAdjustment>;
export type RenderSettings = z.infer<typeof RenderSettings>;
export type RenderManifest = z.infer<typeof RenderManifest>;

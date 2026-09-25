import { z } from "zod";
import { AspectRatio, FilePath, Id, IsoDateTime, NonEmptyString, PlatformTargetId, SchemaVersion, Sha256, UsdAmount } from "./common.js";
import { TimingSource } from "./timing.js";
import { AudioLicense, SceneId } from "./video-spec.js";

export const RenderStatus = z.enum(["pending", "submitted", "running", "succeeded", "failed", "cancelled", "cached"]);

export const PxBox = z.strictObject({ x: z.int(), y: z.int(), w: z.int().nonnegative(), h: z.int().nonnegative() });

export const TextRole = z.enum(["hook", "headline", "body", "label", "code", "caption", "cta", "decorative"]);

export const TextBox = z
  .strictObject({
    role: TextRole.describe("hook, headline, caption and cta overflow is an error in lint; decorative is a warning."),
    text: z.string(),
    rect: PxBox.describe("Box the text was fitted into, in output pixels."),
    font_px: z.number().positive(),
    truncated: z.boolean().describe("fitText could not fit the text without cutting it."),
    color: z.string().optional().describe("Text colour #RRGGBB."),
    background: z.string().optional().describe("Colour behind the text #RRGGBB, for contrast checks."),
  })
  .describe("One text block a renderer drew.");

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
  text_boxes: z.array(TextBox).optional().describe("Text the renderer drew, for lint."),
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
  box: PxBox.optional().describe("Region the burned-in captions occupy, in output pixels, for lint."),
  max_lines: z.int().positive().optional(),
  sound_events: z.int().nonnegative().optional().describe("Sound-event cues ([music], sfx captions, [ambient sound]) in the captions."),
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
  "post",
  "qa",
  "spec",
  "lock",
  "other",
]);

export const FinalOutput = z.strictObject({
  kind: OutputKind,
  target: PlatformTargetId.optional().describe("Platform contract id for files in dist/<target>/; absent for shared files."),
  path: FilePath,
  sha256: Sha256,
  width: z.int().positive().optional(),
  height: z.int().positive().optional(),
  duration_sec: z.number().nonnegative().optional(),
  transcoded: z.boolean().optional().describe("True when the file was re-encoded to fit the target's envelope rather than copied."),
  c2pa: z.boolean().optional().describe("True when the file carries a signed C2PA manifest."),
});

export const C2paRecord = z
  .strictObject({
    tool: z.string().describe("Signer, e.g. c2patool 0.26.68."),
    certificate: z.enum(["test", "user"]).describe("test: the tool's built-in test certificate (not trusted by validators); user: the user's own certificate."),
    claim_generator: z.string(),
    assertions: z.array(z.string()).describe("Assertion labels written, e.g. c2pa.actions, stds.schema-org.CreativeWork."),
    signed: z.array(FilePath),
    ai_generated: z.boolean().describe("Whether the manifest declares AI-generated content (trainedAlgorithmicMedia)."),
  })
  .describe("C2PA content credentials written at export.");

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

export const CoverRender = z
  .strictObject({
    path: FilePath,
    square_preview: FilePath.optional(),
    at_ms: z.int().nonnegative().describe("Video time of the frame the cover was composed from."),
    headline_box: TextBox.optional(),
    crops: z
      .array(z.strictObject({ id: Id, targets: z.array(Id), rect: PxBox }))
      .describe("Regions of the cover that platforms crop to (e.g. a centre square); the headline must fit inside each."),
  })
  .describe("The compiled cover and where its headline landed, for lint.");

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
    cover: CoverRender.optional(),
    music: z
      .strictObject({
        file: FilePath.describe("`bundled:<id>` or the project-relative path from spec.audio.music.file."),
        sha256: Sha256,
        title: z.string().optional(),
        license: AudioLicense.optional(),
      })
      .optional()
      .describe("The music bed mixed into the audio, with its rights."),
    outputs: z.array(FinalOutput),
    c2pa: C2paRecord.optional(),
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
export type PxBox = z.infer<typeof PxBox>;
export type TextRole = z.infer<typeof TextRole>;
export type TextBox = z.infer<typeof TextBox>;
export type VoiceRender = z.infer<typeof VoiceRender>;
export type CaptionFormat = z.infer<typeof CaptionFormat>;
export type CaptionsRender = z.infer<typeof CaptionsRender>;
export type OutputKind = z.infer<typeof OutputKind>;
export type FinalOutput = z.infer<typeof FinalOutput>;
export type C2paRecord = z.infer<typeof C2paRecord>;
export type QaStatus = z.infer<typeof QaStatus>;
export type QaSummary = z.infer<typeof QaSummary>;
export type TimingAdjustment = z.infer<typeof TimingAdjustment>;
export type CoverRender = z.infer<typeof CoverRender>;
export type RenderSettings = z.infer<typeof RenderSettings>;
export type RenderManifest = z.infer<typeof RenderManifest>;

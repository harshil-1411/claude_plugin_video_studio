import { z } from "zod";
import { AspectRatio, NonEmptyString, NormalizedRect, Platform, PlatformTargetId } from "./common.js";

/** Calendar date `YYYY-MM-DD`. */
const IsoDate = z.iso.date();

const Range = (unit: string) =>
  z
    .strictObject({ min: z.number().nonnegative().optional(), max: z.number().positive().optional() })
    .refine((r) => r.min === undefined || r.max === undefined || r.min <= r.max, { message: `min must be ≤ max (${unit})` });

const Size = z.strictObject({ width: z.int().positive(), height: z.int().positive() });

export const ContractSource = z.strictObject({
  url: z.url(),
  title: z.string().optional(),
  note: z.string().optional().describe("Which numbers this source backs."),
});

export const UiMask = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    label: NonEmptyString.describe("What the platform draws here, e.g. \"action rail (like, comment, share)\"."),
    aspect_ratio: AspectRatio.describe("Frame shape the rect is measured on."),
    rect: NormalizedRect,
    severity: z.enum(["error", "warning"]).describe("error: captions and key text must not overlap; warning: avoid."),
  })
  .describe("A region the platform's UI covers, in normalized coordinates of a frame of `aspect_ratio`.");

export const CoverCrop = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  aspect_ratio: AspectRatio,
  anchor: z.enum(["center", "top", "bottom"]),
  note: z.string().optional().describe("Where the platform shows this crop, e.g. the profile grid."),
});

export const PlatformContract = z
  .strictObject({
    id: PlatformTargetId.describe("Must equal the file name: platform-specs/<id>.yaml."),
    name: NonEmptyString,
    contract_version: z.int().positive().describe("Bumped whenever any value changes."),
    verified: IsoDate.describe("Date the values were last checked against the sources."),
    sources: z.array(ContractSource).min(1),
    platform: Platform.optional().describe("The VideoSpec `platform` this contract serves as primary target for."),
    route: z.enum(["app_upload", "api"]).describe("Publishing route the envelope applies to; API limits often differ from the app."),
    video: z.strictObject({
      aspect_ratios: z.array(AspectRatio).min(1).describe("Accepted aspect ratios, preferred first."),
      recommended: Size,
      min: Size.optional(),
      max_long_side: z.int().positive().optional(),
      duration_sec: Range("seconds"),
      fps: Range("fps").optional(),
      max_size_mb: z.number().positive().optional(),
      max_bitrate_mbps: z.number().positive().optional(),
      container: z.array(z.enum(["mp4", "mov", "webm"])).min(1),
      video_codecs: z.array(z.enum(["h264", "h265", "vp9", "av1"])).min(1),
      audio_codecs: z.array(z.enum(["aac", "opus", "mp3"])).min(1),
      audio_sample_rate_hz: z.int().positive().optional(),
      min_audio_bitrate_kbps: z.int().positive().optional(),
      note: z.string().optional().describe("Caveats, e.g. a creator-specific duration limit queried at publish time."),
    }),
    cover: z.strictObject({
      mode: z.enum(["file", "frame", "file_or_frame", "none"]).describe("Upload an image, pick a video frame, either, or unsupported."),
      formats: z.array(z.enum(["jpeg", "png"])).optional(),
      max_size_mb: z.number().positive().optional(),
      recommended: Size.optional(),
      min_height: z.int().positive().optional(),
      crops: z.array(CoverCrop).optional().describe("Other shapes the platform cuts the cover to; key text must survive them."),
    }),
    captions: z.strictObject({
      post_caption_max_chars: z.int().positive().optional(),
      hashtags_max: z.int().nonnegative().optional(),
      mentions_max: z.int().nonnegative().optional(),
      sidecar_formats: z.array(z.enum(["srt", "vtt"])).describe("Caption files the publishing route accepts; empty means burn in."),
      burn_in_recommended: z.boolean(),
    }),
    ai_disclosure: z
      .strictObject({ supported: z.boolean(), field: z.string().optional().describe("API field name, e.g. is_aigc.") })
      .optional(),
    ui_masks: z.array(UiMask).describe("Measured UI overlays; may be empty when unknown (lint then warns)."),
    notes: z.array(z.string()).optional(),
  })
  .meta({
    id: "PlatformContract",
    title: "PlatformContract",
    description:
      "platform-specs/<id>.yaml: one platform publishing route's verified limits, cover spec, caption limits and UI masks, with sources and a verified date.",
  });

export type ContractSource = z.infer<typeof ContractSource>;
export type UiMask = z.infer<typeof UiMask>;
export type CoverCrop = z.infer<typeof CoverCrop>;
export type PlatformContract = z.infer<typeof PlatformContract>;

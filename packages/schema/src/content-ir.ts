import { z } from "zod";
import {
  DataClass,
  FilePath,
  Id,
  IsoDateTime,
  NonEmptyString,
  SchemaVersion,
  Sha256,
  SourceKind,
  SourceRef,
} from "./common.js";

export const Source = z.strictObject({
  id: Id,
  kind: SourceKind,
  uri: NonEmptyString.describe("Original location: file path, URL or repo path."),
  sha256: Sha256.describe("Hash of the raw source bytes as ingested."),
  title: z.string().optional(),
  remote: z
    .strictObject({
      url: NonEmptyString.describe("The URL the user gave."),
      via: z.enum(["direct", "yt-dlp"]).describe("direct: an http(s) media file fetched by the engine; yt-dlp: a video page (YouTube, Vimeo, Loom…) downloaded by the user's yt-dlp."),
      final_url: z.string().optional().describe("URL after redirects (direct downloads)."),
      webpage_url: z.string().optional().describe("Canonical page URL reported by yt-dlp."),
      bytes: z.int().nonnegative().describe("Size of the downloaded media file."),
      content_type: z.string().optional(),
      extractor: z.string().optional().describe("yt-dlp extractor, e.g. Youtube."),
      video_id: z.string().optional(),
      uploader: z.string().optional(),
      duration_sec: z.number().nonnegative().optional(),
      license: z.string().optional().describe("License the platform reports, if any."),
      downloader_version: z.string().optional().describe("yt-dlp version."),
    })
    .optional()
    .describe("Set when the source was downloaded from a video URL: where it came from and what the platform reported."),
});

export const Section = z.strictObject({
  id: Id,
  source_id: Id,
  heading: z.string().optional(),
  text: z.string().describe("Normalized plain text of the section."),
});

export const Locator = z
  .strictObject({
    line_start: z.int().positive().optional(),
    line_end: z.int().positive().optional(),
    page: z.int().positive().optional(),
    slide: z.int().positive().optional(),
    selector: z.string().optional().describe("CSS selector or heading anchor for URL/markdown sources."),
    char_start: z.int().nonnegative().optional(),
    char_end: z.int().nonnegative().optional(),
    time_start_sec: z.number().nonnegative().optional(),
    time_end_sec: z.number().nonnegative().optional(),
  })
  .describe("Machine-readable position of an evidence span inside its source.");

export const EvidenceSpan = z.strictObject({
  ref: SourceRef.describe("Stable source_ref, unique within the ContentIR."),
  source_id: Id,
  text: z.string().describe("Verbatim excerpt from the source."),
  locator: Locator,
});

export const EntityKind = z.enum([
  "product",
  "organization",
  "person",
  "technology",
  "concept",
  "place",
  "metric",
  "other",
]);

export const Entity = z.strictObject({
  id: Id,
  name: NonEmptyString,
  kind: EntityKind,
  aliases: z.array(z.string()).optional(),
  evidence_refs: z.array(SourceRef).optional(),
});

export const Claim = z.strictObject({
  id: Id,
  text: NonEmptyString,
  kind: z.enum(["quantitative", "qualitative"]),
  evidence_refs: z.array(SourceRef).describe("Evidence spans supporting this claim."),
});

export const Shot = z.strictObject({
  start_sec: z.number().nonnegative(),
  end_sec: z.number().positive(),
  keyframe: Id.optional().describe("Image asset id of a representative frame."),
});

export const Transcript = z
  .strictObject({
    path: FilePath.describe("Project-relative JSON file with timed words: [{word, start_ms, end_ms, speaker?}]."),
    source: z.enum(["whisper", "srt", "vtt"]).describe("whisper.cpp (local ASR) or a caption file the user supplied."),
    model: z.string().optional().describe("ASR model, e.g. ggml-base.en."),
    language: z.string().optional().describe("Spoken language: detected by whisper (ISO 639-1, e.g. es), or the one requested."),
    speakers: z.boolean().optional().describe("true when speaker turns were detected (tinydiarize); words then carry speaker labels S1, S2, …"),
    words: z.int().nonnegative(),
  })
  .describe("Timed transcript of the asset's speech.");

export const FootageNote = z
  .strictObject({
    from_sec: z.number().nonnegative(),
    to_sec: z.number().positive(),
    subject: z.string().max(500).optional().describe("Who or what is in the shot."),
    action: z.string().max(500).optional().describe("What happens in it."),
    on_screen_text: z.string().max(500).optional().describe("Text visible in the frame (slides, signs, UI)."),
    broll: z.boolean().optional().describe("true: usable as b-roll / a cutaway (no talking face, no lip sync needed)."),
    quality: z.enum(["good", "ok", "poor"]).optional().describe("Picture quality: focus, exposure, shake."),
    tags: z.array(z.string().min(1).max(40)).max(20).optional(),
    asset_sha256: Sha256.describe("Hash of the asset file the note was written for; a note whose hash differs from the asset's is stale."),
    updated_at: IsoDateTime,
  })
  .describe("Claude's own observation of a stretch of footage (footage_notes). Not source evidence: never cited as a claim or evidence ref.");

export const MediaInfo = z
  .strictObject({
    duration_sec: z.number().nonnegative(),
    width: z.int().positive().optional(),
    height: z.int().positive().optional(),
    fps: z.number().positive().optional(),
    has_video: z.boolean(),
    has_audio: z.boolean(),
    shots: z.array(Shot).optional().describe("Shot boundaries from scene detection."),
    transcript: Transcript.optional(),
    subtitles: z
      .array(
        z.strictObject({
          path: FilePath.describe("Project-relative .vtt next to the asset."),
          lang: NonEmptyString.describe("Language code as the platform reports it, e.g. en, en-US, en-orig."),
          kind: z.enum(["manual", "auto"]).describe("manual: uploaded by the creator; auto: the platform's automatic captions."),
        }),
      )
      .optional()
      .describe("Subtitle files downloaded with a video URL, best first (manual before auto). Import one with transcribe captions_file."),
    loudness_lufs: z.number().optional(),
    content_box: z
      .strictObject({ x: z.int().nonnegative(), y: z.int().nonnegative(), w: z.int().positive(), h: z.int().positive() })
      .optional()
      .describe("The real picture inside baked-in black bars (letterbox/pillarbox), in source pixels; the footage renderer crops to it."),
    notes: z
      .array(FootageNote)
      .optional()
      .describe("Per-shot notes Claude wrote after looking at the footage (footage_look → footage_notes): subject, action, on-screen text, b-roll use, quality. Observations, not evidence."),
    rotation: z
      .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
      .optional()
      .describe("Display rotation of the video (degrees, counter-clockwise as ffprobe reports it; phone footage). width/height are the displayed size, after rotation."),
    color_transfer: z.string().optional().describe("Video transfer characteristic as probed, e.g. bt709, smpte2084 (PQ), arib-std-b67 (HLG)."),
    color_primaries: z.string().optional().describe("Video colour primaries as probed, e.g. bt709, bt2020."),
    bit_depth: z.int().positive().optional().describe("Bits per luma sample (8, 10, 12)."),
    hdr: z.boolean().optional().describe("true for PQ or HLG video (iPhone HDR, HDR10): the footage renderer tonemaps it to SDR BT.709."),
    quality: z
      .strictObject({
        exposure: z.enum(["dark", "ok", "bright"]).optional().describe("Picture exposure from the mean luma and the share of near-black / near-white pixels (video)."),
        luma_mean: z.number().min(0).max(255).optional().describe("Mean luma of sampled frames (8-bit code values, 16–235 video range)."),
        contrast: z.number().min(0).max(255).optional().describe("Mean spread between the 10th and 90th luma percentiles of sampled frames (8-bit)."),
        dark_fraction: z.number().min(0).max(1).optional().describe("Share of sampled pixels that are near black."),
        bright_fraction: z.number().min(0).max(1).optional().describe("Share of sampled pixels that are near white."),
        clipped_audio: z.boolean().optional().describe("true when the audio hits full scale (≥ −0.1 dBFS) in several places: distortion."),
        snr_db: z.number().optional().describe("Speech-clarity proxy: loud (90th percentile) minus quiet (10th percentile) 50 ms RMS levels, in dB. Low means noise or a constant bed under the speech."),
        notes: z.array(z.string()).describe("Plain-language quality problems with a suggestion each; empty when none."),
      })
      .optional()
      .describe("Cheap footage quality checks measured at ingest (low-res, low-fps decode)."),
  })
  .describe("Probe results for a video or audio asset.");

export const IrAsset = z.strictObject({
  id: Id,
  kind: z.enum(["image", "video", "audio"]),
  path: FilePath.describe("Project-relative path of the extracted asset."),
  sha256: Sha256,
  source_ref: SourceRef.optional(),
  media: MediaInfo.optional().describe("For video and audio assets."),
});

export const Classification = z
  .strictObject({
    contains_secrets: z.boolean(),
    contains_pii: z.boolean(),
    contains_likeness: z.boolean(),
    data_class: DataClass,
    notes: z.array(z.string()),
  })
  .describe("Ingestion security label; drives policy routing.");

export const IrWarning = z.strictObject({
  code: NonEmptyString,
  message: NonEmptyString,
  source_id: Id.optional(),
});

export const ContentIR = z
  .strictObject({
    schema_version: SchemaVersion,
    id: Id,
    created_at: IsoDateTime,
    sources: z.array(Source).min(1),
    sections: z.array(Section),
    evidence: z.array(EvidenceSpan),
    entities: z.array(Entity),
    claims: z.array(Claim),
    assets: z.array(IrAsset),
    classification: Classification,
    warnings: z.array(IrWarning),
  })
  .meta({
    id: "ContentIR",
    title: "ContentIR",
    description:
      "What the user gave us: normalized source text, evidence spans with stable source_refs, entities, claims, extracted assets and an ingestion security label.",
  });

export type Source = z.infer<typeof Source>;
export type Section = z.infer<typeof Section>;
export type Locator = z.infer<typeof Locator>;
export type EvidenceSpan = z.infer<typeof EvidenceSpan>;
export type Entity = z.infer<typeof Entity>;
export type Claim = z.infer<typeof Claim>;
export type IrAsset = z.infer<typeof IrAsset>;
export type Shot = z.infer<typeof Shot>;
export type Transcript = z.infer<typeof Transcript>;
export type MediaInfo = z.infer<typeof MediaInfo>;
export type FootageNote = z.infer<typeof FootageNote>;
export type Classification = z.infer<typeof Classification>;
export type IrWarning = z.infer<typeof IrWarning>;
export type ContentIR = z.infer<typeof ContentIR>;

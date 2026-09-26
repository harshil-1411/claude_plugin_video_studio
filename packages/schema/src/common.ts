import { z } from "zod";

/** Version of every canonical object defined in this package. */
export const SCHEMA_VERSION = "1.0" as const;

export const SchemaVersion = z
  .literal(SCHEMA_VERSION)
  .describe("Schema version of this document.");

/** ISO-8601 date-time string (UTC `Z` or explicit offset). Never a Date object. */
export const IsoDateTime = z.iso.datetime({ offset: true });

/** Lower-case hex sha256 digest. */
export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, "expected a lower-case hex sha256 digest");

/** Stable identifier: letters, digits, `_`, `-`, `.`, `@`, `:`. */
export const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.@:-]*$/, "expected a stable identifier");

export const NonEmptyString = z.string().min(1);

/** BCP-47 language tag, e.g. `en`, `en-US`, `zh-Hant-TW`. */
export const LanguageTag = z
  .string()
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, "expected a BCP-47 language tag such as en-US");

/** `video_url` is an ingest input kind only: the source it produces is `video` or `audio` (with `remote`). */
export const SourceKind = z.enum(["text", "markdown", "url", "pdf", "docx", "pptx", "repo", "video", "audio", "video_url"]);

/**
 * Stable provenance reference into a source, e.g. `repo:src/a.ts#L10-L20`,
 * `url:https://example.com/docs#install`, `pdf:report.pdf#p3`.
 */
export const SourceRef = z
  .string()
  .regex(
    /^(?:text|markdown|url|pdf|docx|pptx|repo|video|audio):\S+$/,
    "expected a source_ref like repo:path#L10-L20, url:<u>#<sel> or pdf:<file>#p3",
  );

export const Goal = z.enum(["explain", "launch", "educate", "promote", "announce", "case_study"]);

export const Platform = z.enum([
  "instagram_reels",
  "tiktok",
  "youtube_shorts",
  "youtube",
  "linkedin",
  "x",
  "generic",
]);

export const AspectRatio = z.enum(["9:16", "16:9", "1:1", "4:5"]);

/**
 * Platform contract id: the file name of a `platform-specs/<id>.yaml` contract,
 * e.g. `instagram`, `tiktok`, `youtube-shorts`, `facebook-page-api`.
 */
export const PlatformTargetId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "expected a platform contract id like tiktok or youtube-shorts");

/**
 * Default contract id for each primary `platform`, used when a spec has no `targets`.
 * Null means no contract applies (plain 16:9 YouTube, X and generic output).
 */
export const PRIMARY_TARGET: Readonly<Record<Platform, string | null>> = {
  instagram_reels: "instagram",
  tiktok: "tiktok",
  youtube_shorts: "youtube-shorts",
  youtube: null,
  linkedin: "linkedin",
  x: null,
  generic: null,
};

/** Frame rates every renderer supports (HyperFrames draws only 24, 30 or 60). */
export const Fps = z.union([z.literal(24), z.literal(30), z.literal(60)]);

/** A rectangle in normalized frame coordinates: 0–1 from the top-left corner. */
export const NormalizedRect = z
  .strictObject({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().positive().max(1),
    h: z.number().positive().max(1),
  })
  .refine((r) => r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001, { message: "rect must lie inside the frame (x+w ≤ 1, y+h ≤ 1)" });

export const Grounding = z.enum(["strict", "loose", "off"]);

export const DataClass = z.enum(["public", "internal", "confidential", "restricted"]);

/** Where data for a job may be sent. */
export const DataPolicy = z.enum(["external-ok", "local-only"]);

export const UsdAmount = z.number().nonnegative();

/** Hex colour, `#RGB`, `#RRGGBB` or `#RRGGBBAA`. */
export const HexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "expected a hex colour like #1A2B3C");

/** Relative or absolute file path (no validation of existence). */
export const FilePath = z.string().min(1);

export type SourceKind = z.infer<typeof SourceKind>;
export type SourceRef = z.infer<typeof SourceRef>;
export type Goal = z.infer<typeof Goal>;
export type Platform = z.infer<typeof Platform>;
export type AspectRatio = z.infer<typeof AspectRatio>;
export type PlatformTargetId = z.infer<typeof PlatformTargetId>;
export type Fps = z.infer<typeof Fps>;
export type NormalizedRect = z.infer<typeof NormalizedRect>;
export type Grounding = z.infer<typeof Grounding>;
export type DataClass = z.infer<typeof DataClass>;
export type DataPolicy = z.infer<typeof DataPolicy>;

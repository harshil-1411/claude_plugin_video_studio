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

export const IrAsset = z.strictObject({
  id: Id,
  kind: z.enum(["image", "video", "audio"]),
  path: FilePath.describe("Project-relative path of the extracted asset."),
  sha256: Sha256,
  source_ref: SourceRef.optional(),
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
export type Classification = z.infer<typeof Classification>;
export type IrWarning = z.infer<typeof IrWarning>;
export type ContentIR = z.infer<typeof ContentIR>;

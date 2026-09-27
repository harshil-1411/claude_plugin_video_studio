import { z } from "zod";
import { NonEmptyString, SchemaVersion } from "./common.js";

/**
 * research-specs/titles.yaml: title heuristics as dated data. They are heuristics, not platform
 * limits: lint reports them as warnings only, and `verified` stays false until someone checks
 * them against the user's own analytics (Phase 9).
 */
export const TitleRules = z
  .strictObject({
    schema_version: SchemaVersion,
    id: z.literal("titles"),
    title_length: z
      .strictObject({ min_chars: z.int().positive(), max_chars: z.int().positive() })
      .refine((r) => r.min_chars <= r.max_chars, "min_chars must be <= max_chars")
      .describe("Titles outside this band get a title_length warning."),
    basis: z.enum(["heuristic", "measured"]),
    verified: z.boolean(),
    verified_on: z.iso.date().optional(),
    notes: z.array(NonEmptyString).optional(),
  })
  .meta({ id: "TitleRules", title: "TitleRules", description: "research-specs/titles.yaml: title heuristics (length band) as dated data; warnings only." });

export type TitleRules = z.infer<typeof TitleRules>;

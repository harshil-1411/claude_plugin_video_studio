import { z } from "zod";
import { Grounding, UsdAmount } from "./common.js";

/** Provider id or glob, e.g. `runway`, `*-experimental`, `fal/*`. */
export const ProviderGlob = z
  .string()
  .regex(/^[A-Za-z0-9*?._/@-]+$/, "expected a provider id or glob like runway or *-experimental");

/** How a class of data may be routed. */
export const DataRoute = z.enum(["external_ok", "local_only", "approved_only", "redact", "deny"]);

export const Region = z.enum(["us", "eu", "in", "sg", "provider-default"]);

export const Policy = z
  .strictObject({
    version: z.literal(1),
    providers: z
      .strictObject({
        allow: z.array(ProviderGlob).optional(),
        deny: z.array(ProviderGlob).optional(),
      })
      .optional(),
    privacy: z
      .strictObject({
        source_code: DataRoute.optional(),
        pii: DataRoute.optional(),
        confidential_documents: DataRoute.optional(),
        external_reference_images: DataRoute.optional(),
        data_classes: z
          .strictObject({
            public: DataRoute.optional(),
            internal: DataRoute.optional(),
            confidential: DataRoute.optional(),
            restricted: DataRoute.optional(),
          })
          .optional()
          .describe("Routing per ContentIR classification.data_class."),
      })
      .optional(),
    residency: z
      .strictObject({
        voice: Region.optional(),
        video: Region.optional(),
        avatar: Region.optional(),
        storage: Region.optional(),
      })
      .optional(),
    retention: z
      .strictObject({
        prefer_zero_retention: z.boolean().optional(),
        max_provider_retention_days: z.int().nonnegative().optional(),
      })
      .optional(),
    likeness: z
      .strictObject({
        require_consent_receipt: z.boolean().optional(),
        voice_clone_requires_consent: z.boolean().optional(),
        allow_public_figures: z.boolean().optional(),
      })
      .optional(),
    spend: z
      .strictObject({
        project_limit_usd: UsdAmount.optional(),
        scene_limit_usd: UsdAmount.optional(),
        approval_above_usd: UsdAmount.optional(),
      })
      .optional(),
    grounding: z
      .strictObject({
        factual_claims: Grounding,
      })
      .optional(),
  })
  .meta({
    id: "Policy",
    title: "Policy",
    description:
      "policy.yaml: provider allow/deny globs, data-class routing, residency, retention, likeness consent, spend limits and grounding. Only the parts listed in docs/HANDOFF.md are enforced by the engine; the rest is advisory until the provider phase.",
  });

export type ProviderGlob = z.infer<typeof ProviderGlob>;
export type DataRoute = z.infer<typeof DataRoute>;
export type Region = z.infer<typeof Region>;
export type Policy = z.infer<typeof Policy>;

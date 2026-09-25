import { z } from "zod";
import { FilePath, Id, IsoDateTime, NonEmptyString, SchemaVersion, Sha256 } from "./common.js";
import { Cover, Scene } from "./video-spec.js";

/**
 * project/variants.json: an A/B experiment Claude writes. Every hook × cover pair becomes one
 * variant project under variants/<hook>-<cover>/ with its own dist/ packages. The base spec's
 * other scenes are shared, so variants only re-render the hook scene (and the cover).
 */
export const HookVariant = z
  .strictObject({
    id: Id.describe("Short id, e.g. h1, question, stat."),
    label: z.string().optional().describe("What this hook tries, e.g. 'question hook'."),
    scene: Scene.describe("Replacement for the base spec's hook scene (same id is not required; it takes the hook's place)."),
  })
  .describe("One hook to test.");

export const CoverVariant = z
  .strictObject({
    id: Id.describe("Short id, e.g. c1, bold."),
    label: z.string().optional(),
    cover: Cover,
  })
  .describe("One cover to test.");

export const ExperimentPlan = z
  .strictObject({
    schema_version: SchemaVersion,
    id: Id.describe("Experiment id, e.g. readme-hooks-1."),
    hypothesis: NonEmptyString.describe("What the experiment tests, e.g. 'a question hook beats a stat hook on 3 s retention'."),
    metric: z.string().optional().describe("Primary metric to compare, e.g. 3s_retention, completion_rate, saves."),
    hooks: z.array(HookVariant).min(1).max(6),
    covers: z.array(CoverVariant).min(1).max(4).optional().describe("Omit to keep the base spec's cover for every variant."),
  })
  .superRefine((p, ctx) => {
    for (const [key, list] of [["hooks", p.hooks], ["covers", p.covers ?? []]] as const) {
      const seen = new Set<string>();
      list.forEach((v, i) => {
        if (seen.has(v.id)) ctx.addIssue({ code: "custom", path: [key, i, "id"], message: `duplicate ${key} id "${v.id}"` });
        seen.add(v.id);
      });
    }
  })
  .meta({
    id: "ExperimentPlan",
    title: "ExperimentPlan",
    description: "project/variants.json: hypothesis, hook variants and cover variants for an A/B experiment.",
  });

export const ExperimentVariant = z.strictObject({
  id: Id.describe("<hook id>-<cover id>"),
  hook_id: Id,
  cover_id: Id.optional(),
  project_dir: FilePath.describe("variants/<id>, relative to the base project."),
  spec_sha256: Sha256,
  status: z.enum(["prepared", "rendering", "rendered", "failed"]),
  job_id: z.string().optional(),
  dist: FilePath.optional().describe("variants/<id>/dist once rendered."),
  lock_sha256: Sha256.optional(),
  error: z.string().optional(),
});

export const ExperimentManifest = z
  .strictObject({
    schema_version: SchemaVersion,
    experiment_id: Id,
    hypothesis: NonEmptyString,
    metric: z.string().optional(),
    base_spec_sha256: Sha256,
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
    variants: z.array(ExperimentVariant).min(1),
  })
  .meta({
    id: "ExperimentManifest",
    title: "ExperimentManifest",
    description: "variants/experiment.json: which variant projects an experiment produced, from which base spec, and their render status.",
  });

export type HookVariant = z.infer<typeof HookVariant>;
export type CoverVariant = z.infer<typeof CoverVariant>;
export type ExperimentPlan = z.infer<typeof ExperimentPlan>;
export type ExperimentVariant = z.infer<typeof ExperimentVariant>;
export type ExperimentManifest = z.infer<typeof ExperimentManifest>;

import { z } from "zod";
import { HexColor, Id, NonEmptyString, SchemaVersion } from "./common.js";
import { GlossaryEntry, ProjectRelativePath } from "./craft.js";

/**
 * series.yaml: a series bible shared by the episodes (projects) of one series: recurring
 * characters, locations and motifs, and the look they share. It sits next to the project folders
 * and a spec points at it with `series`. File paths inside it are relative to the series file.
 * Scenes name the entries they use in `series_refs`, so changing one character re-renders only
 * the scenes that show it.
 */

const Refs = z.array(ProjectRelativePath).describe("Reference images or clips, relative to the series file.");

export const SeriesCharacter = z.strictObject({
  id: Id,
  name: NonEmptyString,
  description: NonEmptyString.describe("Look, silhouette, personality: what must stay the same in every episode."),
  wardrobe: z.string().optional(),
  voice_id: z.string().optional().describe("TTS voice used for this character's lines."),
  references: Refs.optional(),
});

export const SeriesLocation = z.strictObject({ id: Id, description: NonEmptyString, references: Refs.optional() });

export const SeriesMotif = z.strictObject({
  id: Id,
  description: NonEmptyString.describe("A recurring visual or sound, e.g. a toggle switch that flips in every episode."),
  asset: ProjectRelativePath.optional(),
});

export const Series = z
  .strictObject({
    schema_version: SchemaVersion,
    id: Id,
    name: NonEmptyString,
    style: Id.optional().describe("Style pack every episode uses unless its spec overrides it."),
    brand_profile: z.string().optional(),
    palette: z.strictObject({ background: HexColor.optional(), text: HexColor.optional(), primary: HexColor.optional(), secondary: HexColor.optional() }).optional(),
    characters: z.array(SeriesCharacter).optional(),
    locations: z.array(SeriesLocation).optional(),
    motifs: z.array(SeriesMotif).optional(),
    rules: z.array(NonEmptyString).optional().describe("Standards every episode follows, e.g. the intro always opens on the motif."),
    glossary: z.array(GlossaryEntry).max(500).optional().describe("Channel names and terms that correct transcripts and captions in every episode; the brand's glossary adds to it."),
  })
  .superRefine((s, ctx) => {
    const seen = new Map<string, string>();
    for (const key of ["characters", "locations", "motifs"] as const) {
      (s[key] ?? []).forEach((e, i) => {
        const prev = seen.get(e.id);
        if (prev) ctx.addIssue({ code: "custom", path: [key, i, "id"], message: `id "${e.id}" is already used in ${prev}; ids are unique across the series` });
        else seen.set(e.id, key);
      });
    }
  })
  .meta({
    id: "Series",
    title: "Series",
    description: "series.yaml: the bible shared by a series' episodes (characters, locations, motifs, look).",
  });

/**
 * Path from a project folder to its series file: relative, may climb out of the project (the
 * file sits next to the episodes), no absolute paths or URLs, and a YAML or JSON file.
 */
export const SeriesRef = z
  .string()
  .min(1)
  .refine((p) => !/^([a-zA-Z]:)?[\\/]/.test(p), "must be relative to the project folder")
  .refine((p) => !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p), "must be a file, not a URL")
  .refine((p) => /\.(ya?ml|json)$/i.test(p), "must be a .yaml, .yml or .json file");

export type SeriesCharacter = z.infer<typeof SeriesCharacter>;
export type SeriesLocation = z.infer<typeof SeriesLocation>;
export type SeriesMotif = z.infer<typeof SeriesMotif>;
export type Series = z.infer<typeof Series>;

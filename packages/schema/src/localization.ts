import { z } from "zod";
import { LanguageTag, SchemaVersion, Sha256 } from "./common.js";

/**
 * localized/<lang>/project/translation.json: every viewer-facing string of a spec (voiceover,
 * on-screen text, text props, cover headline, post copy), keyed by its JSON path. The localize tool
 * writes it with `source` filled; Claude fills `target`; localize with apply writes the
 * translations into the localized spec and re-times it for the language.
 */
export const TranslationEntry = z.strictObject({
  path: z.string().describe("JSON path into the spec, e.g. scenes.2.voiceover or scenes.0.deterministic.props.lines.1."),
  kind: z.enum(["voiceover", "on_screen_text", "props", "cover", "post", "title"]),
  source: z.string(),
  target: z.string().optional().describe("The translation; empty keeps the source text (names, code, URLs)."),
  note: z.string().optional().describe("Context for the translator, e.g. 'keep under 6 words', 'code: do not translate'."),
});

export const TranslationSheet = z
  .strictObject({
    schema_version: SchemaVersion,
    source_language: LanguageTag,
    target_language: LanguageTag,
    source_spec_sha256: Sha256.describe("The spec the sheet was made from; applying to a changed spec is refused."),
    entries: z.array(TranslationEntry),
  })
  .meta({
    id: "TranslationSheet",
    title: "TranslationSheet",
    description: "localized/<lang>/project/translation.json: the strings of a spec to translate, and their translations.",
  });

export type TranslationEntry = z.infer<typeof TranslationEntry>;
export type TranslationSheet = z.infer<typeof TranslationSheet>;

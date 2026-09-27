import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type GlossaryTerm, mergeGlossary } from "@video-studio/media";
import type { Brand } from "@video-studio/schema";
import { loadBrand } from "./pipeline-core.js";
import { type LoadedSeries, loadSeries, seriesGlossary } from "./series.js";

/**
 * The project's glossary: the series bible's (spec.series) with the brand's added
 * (`brand.language.glossary`; the brand wins a term both define). Corrects transcripts and
 * captions only; TTS pronunciation stays in `brand.language.terminology`.
 */
export function projectGlossary(brand: Brand | undefined, series: Pick<LoadedSeries, "series"> | undefined): GlossaryTerm[] {
  return mergeGlossary(seriesGlossary(series), brand?.language?.glossary);
}

/**
 * Load the glossary for a project folder (brand.yaml or project/brand.yaml, and the series named
 * by project/video-spec.json). A missing or unreadable file never blocks transcription: it is
 * reported in `warnings` and skipped.
 */
export async function loadProjectGlossary(root: string): Promise<{ glossary: GlossaryTerm[]; warnings: string[] }> {
  const warnings: string[] = [];
  let brand: Brand | undefined;
  try {
    brand = (await loadBrand(root))?.brand;
  } catch (e) {
    warnings.push(`glossary: brand not read (${e instanceof Error ? e.message : String(e)})`);
  }
  let series: LoadedSeries | undefined;
  let ref: unknown;
  try {
    ref = (JSON.parse(await readFile(join(root, "project", "video-spec.json"), "utf8")) as { series?: unknown }).series;
  } catch {
    /* no spec yet: no series */
  }
  if (typeof ref === "string" && ref.trim()) {
    try {
      series = await loadSeries(root, ref);
    } catch (e) {
      warnings.push(`glossary: series ${ref} not read (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return { glossary: projectGlossary(brand, series), warnings };
}

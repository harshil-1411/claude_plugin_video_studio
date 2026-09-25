import type { TranslationSheet } from "@video-studio/schema";

/**
 * localize: make a language version of a planned project. Without `apply`, copies the project into
 * localized/<lang>/ (sources, assets, brand) with spec.language set and writes
 * project/translation.json listing every viewer-facing string. With `apply`, writes the filled
 * translations into the localized spec, re-times scenes for the language's speaking and reading
 * speed, switches fonts for the script, and validates.
 *
 * STUB (coordinator): the localization agent implements it.
 */

export interface LocalizeOptions {
  apply?: boolean;
  /** Default: <project>/localized/<language>. */
  out_dir?: string;
}

export interface LocalizeResult {
  language: string;
  out_dir: string;
  sheet_path: string;
  entries: number;
  translated: number;
  applied: boolean;
  notes: string[];
  valid?: boolean;
  errors?: string[];
  sheet?: TranslationSheet;
}

export async function localizeProject(_projectDir: string, _language: string, _opts: LocalizeOptions = {}): Promise<LocalizeResult> {
  throw new Error("not implemented: localizeProject");
}

export function formatLocalize(_r: LocalizeResult): string {
  throw new Error("not implemented: formatLocalize");
}

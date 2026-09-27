import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { canonicalJson, hashFile, sha256Hex } from "@video-studio/core";
import type { SeriesKeyInput, VisualTokens } from "@video-studio/renderer";
import { type Scene, Series, type SeriesCharacter, type SeriesLocation, type SeriesMotif, type Style, closestMatches, parseYamlOrJson } from "@video-studio/schema";

/**
 * The series bible (series.yaml) an episode points at with `spec.series`.
 *
 * The file may sit outside the project (next to the episode folders), so it is read as data
 * only: parsed as YAML/JSON and validated against `Series`, never executed. Symlinks are
 * resolved, and every file the bible references must stay inside the bible's own folder.
 * Everything a render takes from it is hashed (the file, the entries a scene shows, their
 * reference files), so the cache keys and video.lock describe it.
 */

/** Largest series file read (a bible is a short YAML document). */
export const SERIES_MAX_BYTES = 1_000_000;

export type SeriesEntryKind = "character" | "location" | "motif";
export type SeriesEntry =
  | { kind: "character"; entry: SeriesCharacter }
  | { kind: "location"; entry: SeriesLocation }
  | { kind: "motif"; entry: SeriesMotif };

export interface LoadedSeries {
  series: Series;
  /** `spec.series` as written (relative to the project). */
  ref: string;
  /** The file, symlinks resolved. */
  path: string;
  /** Its folder, symlinks resolved: reference files must stay inside it. */
  dir: string;
  sha256: string;
}

/** One problem with the series file, with the fix. */
export interface SeriesIssue {
  path: string;
  message: string;
  fix: string;
}

export class SeriesLoadError extends Error {
  constructor(readonly issues: SeriesIssue[]) {
    super(issues.map((i) => `${i.path || "series"}: ${i.message} (fix: ${i.fix})`).join("; "));
    this.name = "SeriesLoadError";
  }
}

const toPosix = (p: string) => p.split(sep).join("/");
const inside = (dir: string, p: string) => {
  const r = relative(dir, p);
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
};

/** Read and validate the series file `ref` (relative to `projectDir`). Throws SeriesLoadError with actionable issues. */
export async function loadSeries(projectDir: string, ref: string): Promise<LoadedSeries> {
  const fail = (message: string, fix: string, path = "series"): never => {
    throw new SeriesLoadError([{ path, message, fix }]);
  };
  if (isAbsolute(ref) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref)) fail(`"${ref}" must be a path relative to the project folder`, "set series to e.g. ../series.yaml");
  const given = resolve(projectDir, ref);
  let real: string;
  try {
    real = await realpath(given);
  } catch {
    return fail(`series file not found: ${ref} (looked at ${given})`, "create the series bible there (see skills/plan/references/series.md), or fix the series path");
  }
  const st = await stat(real);
  if (!st.isFile()) fail(`${ref} is not a file`, "point series at the series.yaml file");
  if (st.size > SERIES_MAX_BYTES) fail(`${ref} is ${st.size} bytes (limit ${SERIES_MAX_BYTES})`, "keep the bible to characters, locations, motifs and look; put media in reference files");
  const text = await readFile(real, "utf8");
  const parsed = parseYamlOrJson(Series, text);
  if (!parsed.ok) {
    throw new SeriesLoadError(
      parsed.errors.map((e) => {
        const syntax = e.message.startsWith("syntax error");
        return {
          path: e.path ? `series:${e.path}` : "series",
          message: `${ref}: ${e.message}`,
          fix: syntax ? "fix the YAML/JSON syntax at the reported line" : `correct ${e.path || "the document"} to match the Series schema (schema_get name=series)`,
        };
      }),
    );
  }
  return { series: parsed.data, ref, path: real, dir: dirname(real), sha256: await hashFile(real) };
}

/** Every bible entry by id. */
export function seriesEntries(series: Series): Map<string, SeriesEntry> {
  const out = new Map<string, SeriesEntry>();
  for (const e of series.characters ?? []) out.set(e.id, { kind: "character", entry: e });
  for (const e of series.locations ?? []) out.set(e.id, { kind: "location", entry: e });
  for (const e of series.motifs ?? []) out.set(e.id, { kind: "motif", entry: e });
  return out;
}

/** The files an entry references (series-relative). */
export function entryFiles(e: SeriesEntry): string[] {
  if (e.kind === "motif") return e.entry.asset ? [e.entry.asset] : [];
  return e.entry.references ?? [];
}

/**
 * A series-relative reference resolved inside the bible's folder (symlinks resolved).
 * Returns the absolute path, or why it can't be used.
 */
export async function resolveSeriesFile(loaded: Pick<LoadedSeries, "dir">, ref: string): Promise<{ abs: string } | { error: string }> {
  if (isAbsolute(ref) || ref.split(/[\\/]/).includes("..")) return { error: `"${ref}" must stay inside the series folder` };
  const p = resolve(loaded.dir, ref);
  if (!inside(loaded.dir, p)) return { error: `"${ref}" must stay inside the series folder` };
  let real: string;
  try {
    real = await realpath(p);
  } catch {
    return { error: `"${ref}" not found in ${loaded.dir}` };
  }
  if (!inside(loaded.dir, real)) return { error: `"${ref}" is a symlink that leaves the series folder` };
  if (!(await stat(real)).isFile()) return { error: `"${ref}" is not a file` };
  return { abs: real };
}

/** A reference file as the project sees it: its path from the project (e.g. `../refs/host.png`) and hash. */
export interface SeriesFileRecord {
  path: string;
  sha256: string;
}

export interface SeriesUsage {
  /** Cache-key input per scene id, for scenes with series_refs. */
  keys: Map<string, SeriesKeyInput>;
  /** Reference files of the entries the scenes show, sorted by path. */
  files: SeriesFileRecord[];
}

/**
 * What each scene takes from the bible: the canonical JSON hash of the entries it names and the
 * hashes of their reference files. Scenes without series_refs get no key input, so their keys
 * do not move. Unknown ids and unusable files fail (spec_validate reports both first).
 */
export async function seriesUsage(loaded: LoadedSeries, scenes: readonly Pick<Scene, "id" | "series_refs">[]): Promise<SeriesUsage> {
  const entries = seriesEntries(loaded.series);
  const hashes = new Map<string, string>();
  const keys = new Map<string, SeriesKeyInput>();
  const issues: SeriesIssue[] = [];
  for (const [i, s] of scenes.entries()) {
    const ids = [...new Set(s.series_refs ?? [])].sort();
    if (!ids.length) continue;
    const used: SeriesEntry[] = [];
    for (const id of ids) {
      const e = entries.get(id);
      if (e) used.push(e);
      else issues.push({ path: `scenes.${i}.series_refs`, message: `scene ${s.id}: no entry "${id}" in ${loaded.ref}`, fix: "run spec_validate" });
    }
    const files: SeriesKeyInput["files"] = [];
    for (const ref of [...new Set(used.flatMap(entryFiles))].sort()) {
      let h = hashes.get(ref);
      if (h === undefined) {
        const r = await resolveSeriesFile(loaded, ref);
        if ("error" in r) {
          issues.push({ path: `scenes.${i}.series_refs`, message: `scene ${s.id}: ${r.error}`, fix: "run spec_validate" });
          continue;
        }
        h = await hashFile(r.abs);
        hashes.set(ref, h);
      }
      files.push({ ref, sha256: h });
    }
    keys.set(s.id, { entries: sha256Hex(canonicalJson(used)), files });
  }
  if (issues.length) throw new SeriesLoadError(issues);
  const base = posix.dirname(toPosix(loaded.ref));
  const files = [...hashes].map(([ref, sha256]) => ({ path: posix.join(base, toPosix(ref)), sha256 })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { keys, files };
}

/**
 * The look inputs for resolveTokens when a spec has a series. Precedence:
 * renderer defaults < series (`style` pack, then `palette`) < spec `style` < brand.
 * - Style pack: the spec's, else the series'.
 * - Series palette: over the series' own style pack; under a style the spec picks (as defaults).
 * Brand stays last because resolveTokens applies it after the style.
 */
export function seriesLook(
  series: Series | undefined,
  specStyle: string | undefined,
  style: Style | undefined,
): { style: Style | undefined; defaults: Partial<VisualTokens> } {
  const pal = series?.palette;
  if (!pal) return { style, defaults: {} };
  const defaults: Partial<VisualTokens> = {
    ...(pal.background ? { color_background: pal.background } : {}),
    ...(pal.text ? { color_text: pal.text } : {}),
    ...(pal.primary ? { color_primary: pal.primary } : {}),
    ...(pal.secondary ? { color_secondary: pal.secondary } : {}),
  };
  if (style && !specStyle) return { style: { ...style, palette: { ...style.palette, ...pal } }, defaults: {} };
  return { style, defaults };
}

/** The style pack id a spec renders with: its own, else its series'. */
export function effectiveStyleId(specStyle: string | undefined, series: Series | undefined): string | undefined {
  return specStyle ?? series?.style;
}

/** What render-state, provenance and video.lock record about the bible. */
export interface SeriesRecord {
  id: string;
  /** The series file from the project folder, as the spec names it (posix, e.g. `../series.yaml`). */
  path: string;
  sha256: string;
  /** Reference files of the entries the scenes show (paths from the project folder). */
  files: SeriesFileRecord[];
}

export function seriesRecord(loaded: LoadedSeries, usage: Pick<SeriesUsage, "files">): SeriesRecord {
  return { id: loaded.series.id, path: posix.normalize(toPosix(loaded.ref)), sha256: loaded.sha256, files: usage.files };
}

/** The series bible's glossary (names and terms that correct transcripts and captions); empty without one. */
export function seriesGlossary(loaded: Pick<LoadedSeries, "series"> | undefined): NonNullable<Series["glossary"]> {
  return loaded?.series.glossary ?? [];
}

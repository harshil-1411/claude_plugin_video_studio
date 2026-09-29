import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { type ProjectFont, type ProjectFontIndex, readFontNames } from "./tokens.js";

/**
 * The project's own font files: `<project>/fonts/<Family>/*.{ttf,otf}` (brand_draft copies a
 * repo's `@font-face` files there, one folder per family, with its licence file). Each file is
 * indexed by its internal family name (name table), weight and italic flag, with the folder name
 * as an alias, so a brand can name it by either. Renderers resolve a chain family to a project
 * font first, then the bundled fonts, then fontconfig and the platform fallbacks.
 */

/** At most this many font files are indexed (the rest are reported). */
export const PROJECT_FONTS_MAX_FILES = 64;
/** Larger font files are skipped (the bundled Noto Sans JP OTF is ~16 MB). */
export const PROJECT_FONT_MAX_BYTES = 32 * 1024 * 1024;
const MAX_DEPTH = 3;
const FONT_FILE = /\.(ttf|otf)$/i;
const LICENSE_FILE = /^(ofl|license|licence|copying)([-_.][\w.-]*)?$/i;

export interface ProjectFontScan {
  /** Null when the project has no usable `fonts/` folder or it holds no readable TTF/OTF. */
  index: ProjectFontIndex | null;
  /** Files skipped and why (too large, unreadable, symlinked, over the count cap). */
  warnings: string[];
}

const toPosix = (p: string) => p.split(sep).join("/");

/**
 * Scan `<projectDir>/fonts/` (up to three folders deep) for TTF/OTF files. Symlinks are never
 * followed (neither files nor folders, nor a symlinked `fonts/` itself), so the index only ever
 * holds files inside the project. Sorted by path.
 */
export async function scanProjectFonts(projectDir: string, opts: { maxFiles?: number; maxBytes?: number } = {}): Promise<ProjectFontScan> {
  const warnings: string[] = [];
  const maxFiles = opts.maxFiles ?? PROJECT_FONTS_MAX_FILES;
  const maxBytes = opts.maxBytes ?? PROJECT_FONT_MAX_BYTES;
  let root: string;
  try {
    root = await realpath(projectDir);
    const st = await lstat(join(root, "fonts"));
    if (st.isSymbolicLink()) warnings.push("fonts: fonts/ is a symbolic link; project fonts not used (copy the files into the project)");
    if (!st.isDirectory()) return { index: null, warnings };
  } catch {
    return { index: null, warnings };
  }
  const fontsDir = join(root, "fonts");
  const files: string[] = [];
  const licenses = new Map<string, string>();
  let over = 0;
  const walk = async (dir: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = join(dir, e.name);
      const rel = toPosix(relative(root, abs));
      if (e.isSymbolicLink()) {
        warnings.push(`fonts: ${rel} is a symbolic link; not used (copy the file into the project)`);
        continue;
      }
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(abs, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (LICENSE_FILE.test(e.name) && !licenses.has(dir)) licenses.set(dir, rel);
      if (!FONT_FILE.test(e.name)) continue;
      if (files.length >= maxFiles) {
        over++;
        continue;
      }
      files.push(abs);
    }
  };
  await walk(fontsDir, 1);
  if (over) warnings.push(`fonts: more than ${maxFiles} font files in fonts/; ${over} not used`);
  const fonts: ProjectFont[] = [];
  for (const abs of files) {
    const rel = toPosix(relative(root, abs));
    try {
      const st = await lstat(abs);
      if (st.size > maxBytes) {
        warnings.push(`fonts: ${rel} is larger than ${maxBytes} bytes; not used`);
        continue;
      }
      const names = readFontNames(abs);
      if (!names) {
        warnings.push(`fonts: ${rel} is not a readable TrueType/OpenType font; not used`);
        continue;
      }
      // The alias is the family folder (fonts/<alias>/…); a file directly in fonts/ has only its internal name.
      const parts = relative(fontsDir, abs).split(sep);
      const alias = parts.length > 1 ? parts[0]! : names.family;
      const license = licenses.get(dirname(abs));
      fonts.push({
        path: abs,
        file: rel,
        family: names.family,
        alias,
        weight: names.weight,
        italic: names.italic,
        sha256: createHash("sha256").update(await readFile(abs)).digest("hex"),
        ...(license ? { license } : {}),
      });
    } catch {
      warnings.push(`fonts: ${rel} could not be read; not used`);
    }
  }
  return { index: fonts.length ? { root, fonts } : null, warnings };
}

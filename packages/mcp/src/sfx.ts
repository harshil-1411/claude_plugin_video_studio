import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AudioLicense } from "@video-studio/schema";
import { z } from "zod";

/**
 * Bundled sound effects: `bundled:<id>` in a scene's `sfx[].file` resolves to sfx/<file> in the
 * plugin (catalog.json, CC0 one-shots made and measured by scripts/generate-sfx.mjs). The catalog's
 * licence is carried into the render state, manifest and provenance like a project file's.
 */

const CATALOG = "catalog.json";
export const BUNDLED_PREFIX = "bundled:";

export const SfxCatalogSound = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  family: z.enum(["whoosh", "riser", "hit", "ui", "type", "chime", "glitch"]),
  file: z.string().min(1),
  duration_ms: z.int().positive(),
  peak_ms: z.int().nonnegative(),
  character: z.enum(["warm", "balanced", "bright"]),
  hf_risk: z.enum(["low", "med", "high"]),
  uses: z.array(z.string().min(1)),
  default_db: z.number().min(-60).max(6),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** The generator's measurements behind the labels (energy shares, loudest 50 ms). */
  measured: z.object({ low_share: z.number(), high_share: z.number(), hf_share: z.number(), short_rms_dbfs: z.number() }).optional(),
});

export const SfxCatalog = z.object({
  version: z.int().positive(),
  generator: z.string().optional(),
  ffmpeg: z.string().optional(),
  license: AudioLicense,
  sounds: z.array(SfxCatalogSound),
});

export type SfxCatalogSound = z.infer<typeof SfxCatalogSound>;
export type SfxCatalog = z.infer<typeof SfxCatalog>;

/** The plugin's sfx/ directory (CLAUDE_PLUGIN_ROOT first, then walking up from this module). */
export function findSfxDir(env: Record<string, string | undefined> = process.env, from?: string): string | null {
  const root = env.CLAUDE_PLUGIN_ROOT;
  if (root && existsSync(join(root, "sfx", CATALOG))) return join(root, "sfx");
  let dir = from ?? dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "sfx");
    if (existsSync(join(candidate, CATALOG))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The catalogue in `dir`, or null when there is none or it does not match {@link SfxCatalog}. */
export function loadSfxCatalog(dir: string | null): SfxCatalog | null {
  if (!dir) return null;
  try {
    const parsed = SfxCatalog.safeParse(JSON.parse(readFileSync(join(dir, CATALOG), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const isBundledSfx = (file: string) => file.startsWith(BUNDLED_PREFIX);

export interface ResolvedBundledSfx {
  path: string;
  sound: SfxCatalogSound;
  license: AudioLicense;
}

/**
 * `bundled:<id>` → the catalogue entry, its absolute path and the catalogue licence. Throws an
 * actionable error for an unknown id (listing the available ones) or a missing file.
 */
export function resolveBundledSfx(ref: string, env: Record<string, string | undefined> = process.env, dir: string | null = findSfxDir(env)): ResolvedBundledSfx {
  const id = ref.slice(BUNDLED_PREFIX.length);
  const catalog = loadSfxCatalog(dir);
  if (!dir || !catalog) throw new Error(`sfx file "${ref}": no sfx/ catalogue found in the plugin; reinstall the plugin or run scripts/generate-sfx.mjs`);
  const sound = catalog.sounds.find((s) => s.id === id);
  if (!sound) throw new Error(`sfx file "${ref}" is not a bundled sound; use one of ${bundledSfxIds(catalog).join(", ")}`);
  const path = join(dir, sound.file);
  if (!existsSync(path)) throw new Error(`bundled sound ${sound.file} is missing from ${dir}; reinstall the plugin or run scripts/generate-sfx.mjs`);
  return { path, sound, license: catalog.license };
}

/** `bundled:<id>` for every sound in the catalogue. */
export function bundledSfxIds(catalog: SfxCatalog | null): string[] {
  return (catalog?.sounds ?? []).map((s) => `${BUNDLED_PREFIX}${s.id}`);
}

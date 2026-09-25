import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashFile, projectPaths, resolveInsideProject } from "@video-studio/core";
import type { AudioLicense, MusicBed } from "@video-studio/schema";

/**
 * Music beds: `bundled:<id>` resolves to music/<file> in the plugin (catalog.json, CC0 beds made
 * by scripts/generate-music.mjs); anything else is a file inside the project. The licence is
 * carried into the render state, manifest, lock and provenance.
 */

const CATALOG = "catalog.json";

export interface MusicCatalogTrack {
  id: string;
  title: string;
  bpm: number;
  duration_sec: number;
  file: string;
  sha256: string;
  mood: string;
  loop: boolean;
}

export interface MusicCatalog {
  version: number;
  license: AudioLicense;
  tracks: MusicCatalogTrack[];
}

export interface ResolvedMusic {
  /** As written in the spec: `bundled:<id>` or a project-relative path. */
  ref: string;
  /** Absolute path of the audio file. */
  path: string;
  sha256: string;
  license?: AudioLicense;
  title?: string;
  bed: MusicBed;
}

/** The plugin's music/ directory (CLAUDE_PLUGIN_ROOT first, then walking up from this module). */
export function findMusicDir(env: Record<string, string | undefined> = process.env, from?: string): string | null {
  const root = env.CLAUDE_PLUGIN_ROOT;
  if (root && existsSync(join(root, "music", CATALOG))) return join(root, "music");
  let dir = from ?? dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "music");
    if (existsSync(join(candidate, CATALOG))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function loadMusicCatalog(dir: string | null): MusicCatalog | null {
  if (!dir) return null;
  try {
    return JSON.parse(readFileSync(join(dir, CATALOG), "utf8")) as MusicCatalog;
  } catch {
    return null;
  }
}

/** Resolve spec.audio.music to a file, its hash and licence. Throws an actionable error when it cannot. */
export async function resolveMusic(bed: MusicBed, projectDir: string, env: Record<string, string | undefined> = process.env): Promise<ResolvedMusic> {
  if (bed.file.startsWith("bundled:")) {
    const id = bed.file.slice("bundled:".length);
    const dir = findMusicDir(env);
    const catalog = loadMusicCatalog(dir);
    const track = catalog?.tracks.find((t) => t.id === id);
    if (!dir || !catalog || !track) {
      const ids = catalog?.tracks.map((t) => `bundled:${t.id}`).join(", ");
      throw new Error(`audio.music.file "${bed.file}" is not a bundled track${ids ? `; use one of ${ids}` : " (no music/ catalogue found in the plugin)"}`);
    }
    const path = join(dir, track.file);
    if (!existsSync(path)) throw new Error(`bundled music file ${track.file} is missing from ${dir}; reinstall the plugin or run scripts/generate-music.mjs`);
    return { ref: bed.file, path, sha256: await hashFile(path), license: bed.license ?? catalog.license, title: track.title, bed };
  }
  let path: string;
  try {
    path = await resolveInsideProject(projectPaths(projectDir), bed.file);
  } catch (e) {
    throw new Error(`audio.music.file "${bed.file}" must be a file inside the project folder (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!existsSync(path)) throw new Error(`audio.music.file "${bed.file}" does not exist in the project folder; add the file or use a bundled track (bundled:lofi, …)`);
  return { ref: bed.file, path, sha256: await hashFile(path), ...(bed.license ? { license: bed.license } : {}), bed };
}

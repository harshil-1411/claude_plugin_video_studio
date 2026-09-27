import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, hashFile, projectPaths, resolveDataDir, resolveInsideProject, sha256Hex } from "@video-studio/core";
import { SCORE_BEATS_PER_BAR, SCORE_LICENSE, SCORE_VERSION, resolveScorePreset, scoreBars, scoreGrid, synthScore } from "@video-studio/media";
import type { AudioLicense, MusicBed } from "@video-studio/schema";

/**
 * Music beds: `bundled:<id>` resolves to music/<file> in the plugin (catalog.json, CC0 beds made
 * by scripts/generate-music.mjs); `synth:<preset>` is a score synthesized locally with ffmpeg
 * (packages/media/src/score.ts) into the render cache; anything else is a file inside the project.
 * The licence is carried into the render state, manifest, lock and provenance.
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
  /** A synthesized score's exact beat grid (ms from the file start): beat sync uses it instead of detection. */
  grid?: { bpm: number; beats_ms: number[]; downbeats_ms: number[]; duration_ms: number };
}

export interface ResolveMusicOptions {
  /** Seconds a synthesized score must cover (default 60); rounded up to whole chord cycles. */
  durationSec?: number;
  /** Where synthesized scores are cached (default `<plugin data>/cache/score`). */
  cacheDir?: string;
  signal?: AbortSignal;
}

/** Default length of a synthesized score when the caller gives none. */
export const SYNTH_DEFAULT_SEC = 60;

/**
 * `synth:<preset>` → a score in the cache, keyed by the final parameters, its length and
 * {@link SCORE_VERSION}; an existing file is reused (the synthesis is deterministic).
 */
async function resolveSynth(bed: MusicBed, env: Record<string, string | undefined>, o: ResolveMusicOptions): Promise<ResolvedMusic> {
  const name = bed.file.slice("synth:".length);
  let resolved: ReturnType<typeof resolveScorePreset>;
  try {
    resolved = resolveScorePreset(name, bed.synth ?? {});
  } catch (e) {
    throw new Error(`audio.music.file "${bed.file}": ${e instanceof Error ? e.message : String(e)}`);
  }
  const { preset, params } = resolved;
  // Whole chord cycles, so a looped score repeats on its own phrase.
  const barsPerCycle = params.progression?.length ?? 4;
  const cycleSec = (barsPerCycle * SCORE_BEATS_PER_BAR * 60) / params.bpm;
  const want = Math.max(1, o.durationSec ?? SYNTH_DEFAULT_SEC);
  const duration_s = Math.ceil(want / cycleSec - 1e-9) * cycleSec;
  const bars = scoreBars(params.bpm, duration_s);
  const key = sha256Hex(canonicalJson({ v: SCORE_VERSION, params, bars }));
  const dir = o.cacheDir ?? join(resolveDataDir(env).cache, "score");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${key}.wav`);
  let sha256: string;
  if (existsSync(path)) {
    sha256 = await hashFile(path);
  } else {
    try {
      sha256 = (await synthScore({ ...params, duration_s }, path, o.signal ? { signal: o.signal } : {})).sha256;
    } catch (e) {
      throw new Error(`audio.music.file "${bed.file}": ffmpeg could not synthesize the score (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  const grid = scoreGrid(params.bpm, bars);
  return {
    ref: bed.file,
    path,
    sha256,
    // A synthesized score is CC0 by construction; a licence in the spec cannot change that.
    license: { ...SCORE_LICENSE },
    title: `${preset.title} (${params.bpm} bpm)`,
    bed,
    grid: { bpm: params.bpm, ...grid, duration_ms: Math.round((bars * SCORE_BEATS_PER_BAR * 60_000) / params.bpm) },
  };
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
export async function resolveMusic(
  bed: MusicBed,
  projectDir: string,
  env: Record<string, string | undefined> = process.env,
  opts: ResolveMusicOptions = {},
): Promise<ResolvedMusic> {
  if (bed.file.startsWith("synth:")) return resolveSynth(bed, env, opts);
  if (bed.synth) throw new Error(`audio.music.synth only applies to a synthesized score; set audio.music.file to "synth:<preset>" (e.g. synth:pulse) or remove synth`);
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

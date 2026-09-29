import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { projectPaths, readJson, resolveDataDir } from "@video-studio/core";
import { runFfmpeg } from "@video-studio/media";
import { layoutZones } from "@video-studio/platforms";
import {
  type CaptureSession,
  type CaptureSessionOptions,
  HYPERFRAMES_KINDS,
  type LayoutZones,
  type RenderTarget,
  type ResolvedCue,
  type SceneAudioEnvelope,
  type SceneBeats,
  type SceneRenderRequest,
  type VisualTokens,
  captureTrace,
  chromeGate,
  composeScene,
  cutawayPicture,
  findChrome,
  frameAlignedTime,
  guardStdout,
  openCaptureSession,
  writeComposition,
} from "@video-studio/renderer";
import type { Scene } from "@video-studio/schema";
import { resolveHyperframesProducer } from "./hyperframes.js";
import { resolveMusic } from "./music.js";
import { type Quality, type RenderState, loadTargetContracts, renderDir, targetFor } from "./pipeline-core.js";
import { beatRevealCues, createRenderRun, hasMotionScenes, musicBeatGrid, sceneAudioEnvelopes, sceneBeatGrids, stageInputs } from "./pipeline-stages.js";
import type { ResolvedMusic } from "./music.js";
import { RenderLockedError, renderLockHolder } from "./render-lock.js";
import { REVIEW_MAX_SHEET_TILES, type ReviewPage, planSheets, reviewFont, tileDecor, tileSheet } from "./review.js";

/**
 * stills: frames of the composed scene pages at chosen moments, drawn in headless Chrome before
 * the full render (not a render: nothing in renders/ or dist/ changes). Each HyperFrames scene is
 * composed exactly as the renderer composes it (same composer, assets, tokens, zones, word cues,
 * beat grid, beat-placed reveals and, for motion pages, the music envelope `__vs.audio`), opened with the producer's own puppeteer-core, and seeked through the timeline
 * it registers on `window.__timelines[<id>]`. Times are explicit scene-local seconds, every beat
 * or downbeat of the music inside the scene, or `count` evenly spaced frames (default: in, mid,
 * out). Tiles are labelled with scene, moment and time and tiled into sheets under
 * `<project>/review/stills/` (full-size frames in `review/stills/frames/`).
 *
 * Chrome is serialized with HyperFrames renders (the renderer's `chromeGate`), and stills refuse
 * to run while a render of the project holds its lock.
 */

export type StillsAt = "beats" | "downbeats";

export interface StillsOptions {
  /** Frame size and fps of this quality's render (default preview). */
  quality?: Quality;
  /** Scene ids (default: every scene a HyperFrames page draws). */
  scenes?: string[];
  /** Scene-local seconds, the same for every scene. */
  times?: number[];
  /** Every beat or bar start of the music bed inside each scene. */
  at?: StillsAt;
  /** Evenly spaced frames per scene (default 3: in, mid, out). */
  count?: number;
  /** Tile width in px (default 240). */
  width?: number;
  cols?: number;
}

export interface StillsDeps {
  env?: Record<string, string | undefined>;
  /** Capture session (tests). */
  openCapture?: (o: CaptureSessionOptions & { width: number; height: number }) => Promise<CaptureSession>;
  /** Chrome executable (default: CHROME_PATH, then platform locations). */
  chromePath?: string;
  /** Deadline per capture step in ms (default 60 000). */
  captureTimeoutMs?: number;
}

export interface StillTile {
  index: number;
  scene_id: string;
  /** Scene-local seconds (on the frame grid). */
  time_sec: number;
  tag: string;
  label: string;
  /** Full-size frame, project-relative. */
  frame: string;
}

export interface StillsResult {
  kind: "stills";
  quality: Quality;
  width: number;
  height: number;
  fps: number;
  image: string;
  image_rel: string;
  images: string[];
  images_rel: string[];
  pages: ReviewPage[];
  cols: number;
  rows: number;
  tile_width: number;
  tiles: StillTile[];
  scenes: Array<{ scene_id: string; kind: string; duration_sec: number; beats: number; downbeats: number }>;
  skipped: Array<{ scene_id: string; reason: string }>;
  /** Where scene durations and the beat grid came from. */
  durations: "render-state" | "spec";
  grid: { source: "render-state" | "music" | "none"; bpm?: number | null };
  notes: string[];
}

export const STILLS_DEFAULT_COUNT = 3;
export const STILLS_MAX_COUNT = 12;

export interface StillScene {
  id: string;
  duration_sec: number;
  beats?: SceneBeats;
}

export interface PlannedStill {
  scene_id: string;
  time: number;
  tag: string;
}

/**
 * The frames to draw, scene by scene, on each scene's frame grid (duplicates dropped): explicit
 * `times`, every beat or downbeat inside the scene (`at`), or `count` evenly spaced frames. A
 * scene without beats falls back to in/mid/out, with a note. At most {@link REVIEW_MAX_SHEET_TILES}.
 */
export function planStillTimes(scenes: readonly StillScene[], fps: number, o: Pick<StillsOptions, "times" | "at" | "count"> = {}): { tiles: PlannedStill[]; notes: string[] } {
  const notes: string[] = [];
  const out: PlannedStill[] = [];
  const spaced = (s: StillScene, n: number): PlannedStill[] => {
    const len = s.duration_sec;
    const frame = 1 / fps;
    const a = Math.min(0.3, len * 0.2);
    const b = len - Math.max(frame, Math.min(0.45, len * 0.15));
    if (n === 1) return [{ scene_id: s.id, time: len / 2, tag: "mid" }];
    if (n === 3) return [a, len / 2, b].map((time, i) => ({ scene_id: s.id, time, tag: ["in", "mid", "out"][i]! }));
    return Array.from({ length: n }, (_, i) => ({ scene_id: s.id, time: a + ((b - a) * i) / (n - 1), tag: `${i + 1}/${n}` }));
  };
  const count = Math.min(STILLS_MAX_COUNT, Math.max(1, Math.round(o.count ?? STILLS_DEFAULT_COUNT)));
  for (const s of scenes) {
    let list: PlannedStill[];
    if (o.times?.length) {
      const inside = o.times.filter((t) => t >= 0 && t <= s.duration_sec);
      if (inside.length < o.times.length) notes.push(`${s.id}: ${o.times.length - inside.length} time(s) past its ${s.duration_sec}s dropped`);
      list = inside.map((time) => ({ scene_id: s.id, time, tag: "t" }));
    } else if (o.at) {
      const grid = (o.at === "beats" ? s.beats?.beats_s : s.beats?.downbeats_s) ?? [];
      if (!grid.length) {
        notes.push(`${s.id}: no ${o.at === "beats" ? "beats" : "bar starts"} inside the scene; showing in/mid/out`);
        list = spaced(s, 3);
      } else list = grid.map((time, i) => ({ scene_id: s.id, time, tag: `${o.at === "beats" ? "beat" : "bar"} ${i + 1}` }));
    } else list = spaced(s, count);
    const seen = new Set<number>();
    for (const x of list) {
      const time = frameAlignedTime(x.time, fps, s.duration_sec);
      if (seen.has(time)) continue;
      seen.add(time);
      out.push({ ...x, time });
    }
  }
  if (out.length > REVIEW_MAX_SHEET_TILES) {
    notes.push(`${out.length} frames requested; showing the first ${REVIEW_MAX_SHEET_TILES} (narrow scenes or times)`);
    out.length = REVIEW_MAX_SHEET_TILES;
  }
  return { tiles: out, notes };
}

/** The render plan's scene durations: the latest render's timing adjustments when it matches the spec, else the spec's. */
export function planDurations(scenes: readonly Scene[], state: Pick<RenderState, "scenes" | "timing_adjustments"> | undefined): { scenes: Scene[]; from: "render-state" | "spec" } {
  const ids = scenes.map((s) => s.id).join("\0");
  if (!state?.scenes || state.scenes.map((s) => s.scene_id).join("\0") !== ids) return { scenes: [...scenes], from: "spec" };
  const adj = new Map((state.timing_adjustments ?? []).map((a) => [a.scene_id, a]));
  return {
    scenes: scenes.map((s) => {
      const a = adj.get(s.id);
      return a && a.spec_duration_sec === s.duration_sec ? { ...s, duration_sec: a.render_duration_sec } : s;
    }),
    from: "render-state",
  };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** What the render hands each scene's page besides the scene itself, per scene id. */
export interface StillsPageData {
  /** Word cues (the render's placed ones) over the beat-placed reveals, as the render merges them. */
  cues: Map<string, ResolvedCue[]>;
  /** The beat grid inside each motion page. */
  beats: Map<string, SceneBeats>;
  /** The music bed's envelope under each motion page (`__vs.audio`). */
  audio: Map<string, SceneAudioEnvelope>;
}

/**
 * The per-scene page data of the render plan, from the same helpers the render's scene stage uses:
 * beat-placed reveal cues (`beatRevealCues`, when `audio.beat_sync` is on) with the render's word
 * cues on top, the motion pages' beat grids, and their envelopes. `beatSyncOn` with a grid read
 * only for the pages (no render yet) still places reveals on it, as the render will.
 */
export function stillsPageData(
  planScenes: readonly Scene[],
  fps: number,
  o: { grid?: RenderState["beat_sync"]; beatSyncOn: boolean; wordCues?: ReadonlyMap<string, ResolvedCue[]>; audio?: ReadonlyMap<string, SceneAudioEnvelope> },
): StillsPageData {
  const revealGrid = o.grid && o.beatSyncOn && o.grid.grid_only ? (({ grid_only: _g, ...rest }) => rest)(o.grid) : o.grid;
  const cues = new Map([...beatRevealCues(planScenes, fps, revealGrid, o.beatSyncOn), ...(o.wordCues ?? new Map())]);
  const beats = new Map([...sceneBeatGrids(planScenes, fps, o.grid)].filter(([, b]) => b.beats_s.length || b.downbeats_s.length));
  return { cues, beats, audio: new Map(o.audio ?? []) };
}

/** The composer request for one still scene: the render's request, minus the clip it would write. */
export function stillRequest(
  scene: Scene,
  base: { target: RenderTarget; tokens: VisualTokens; project_dir: string; zones: LayoutZones; out_path: string },
  data: StillsPageData,
): SceneRenderRequest {
  const cues = data.cues.get(scene.id);
  const beats = data.beats.get(scene.id);
  const audio = data.audio.get(scene.id);
  return { scene, ...base, ...(cues?.length ? { cues } : {}), ...(beats ? { beats } : {}), ...(audio ? { audio } : {}) };
}

export async function stillsProject(projectDir: string, opts: StillsOptions = {}, deps: StillsDeps = {}): Promise<StillsResult> {
  const env = deps.env ?? process.env;
  const quality: Quality = opts.quality ?? "preview";
  const paths = projectPaths(projectDir);
  const root = paths.root;
  const lockPath = join(paths.renders, ".render.lock");
  const holder = await renderLockHolder(lockPath);
  if (holder) throw new RenderLockedError(holder, lockPath);

  const run = createRenderRun(root, { quality, env });
  const inputs = await stageInputs(run);
  const { spec, tokens } = inputs;
  const target = targetFor(spec, quality, true);
  const notes: string[] = [];

  let state: RenderState | undefined;
  const statePath = join(renderDir(root, quality), "render-state.json");
  if (existsSync(statePath)) state = await readJson<RenderState>(statePath).catch(() => undefined);
  const plan = planDurations(spec.scenes, state);
  if (state && plan.from === "spec") notes.push(`the ${quality} render state is for other scenes (spec changed since): spec durations used, no word cues`);
  if (!state) notes.push(`no ${quality} render yet: spec durations (voiceover overruns and beat sync can still move cuts at render time)`);

  // The beat grid: the render's, else the music bed's (same detection or synthesized grid the render uses).
  let grid: RenderState["beat_sync"] | undefined;
  let gridSource: StillsResult["grid"]["source"] = "none";
  // The music bed, resolved once (a synthesized score is cached), for the grid and the motion envelope.
  let musicP: Promise<ResolvedMusic> | undefined;
  const musicBed = () => {
    const total = plan.scenes.reduce((a, s) => a + s.duration_sec, 0);
    return (musicP ??= resolveMusic(spec.audio!.music!, root, env, { durationSec: total, cacheDir: join(resolveDataDir(env).cache, "score") }));
  };
  if (plan.from === "render-state" && state?.beat_sync?.beat_times_ms?.length) {
    grid = state.beat_sync;
    gridSource = "render-state";
  } else if (spec.audio?.music) {
    try {
      const music = await musicBed();
      const g = await musicBeatGrid(plan.scenes, new Map(), music, { cacheDir: join(resolveDataDir(env).cache, "beats") });
      grid = g.grid;
      gridSource = "music";
      if (g.warning) notes.push(g.warning);
    } catch (e) {
      notes.push(`music bed unreadable, so no beat grid: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (opts.at && !grid?.beat_times_ms?.length) {
    throw new Error(`stills at ${opts.at}: this project has no beat grid (${spec.audio?.music ? "no clear beat in the music bed" : "no audio.music bed"}); pass times or count instead`);
  }
  const allGrids = sceneBeatGrids(plan.scenes, target.fps, grid, true);

  // Word cues as the render placed them (scene-local), only when the render matches the spec.
  const cues = new Map<string, ResolvedCue[]>();
  if (plan.from === "render-state") {
    for (const c of state?.cues ?? []) {
      if (c.status !== "placed" || c.at_ms === undefined) continue;
      cues.set(c.scene_id, [...(cues.get(c.scene_id) ?? []), { item: c.item, at_s: c.at_ms / 1000 }]);
    }
    for (const list of cues.values()) list.sort((a, b) => a.at_s - b.at_s);
  }

  // The motion pages' envelope of the bed, sliced as the render slices it (vs.energy / bass / onset).
  let audio: Map<string, SceneAudioEnvelope> | undefined;
  if (spec.audio?.music && hasMotionScenes(plan.scenes)) {
    try {
      audio = await sceneAudioEnvelopes(plan.scenes, target.fps, await musicBed(), { cacheDir: join(resolveDataDir(env).cache, "envelope") });
    } catch (e) {
      notes.push(`motion audio: the music bed's envelope could not be read (${e instanceof Error ? e.message : String(e)}); vs.energy / bass / onset read 0`);
    }
  }
  const beatSyncOn = spec.audio?.beat_sync?.enabled === true;
  if (beatSyncOn && gridSource === "music") notes.push("beat sync: no matching render yet, so reveals sit on the bed's beats at spec durations (the render may still move cuts)");
  const pageData = stillsPageData(plan.scenes, target.fps, { grid, beatSyncOn, wordCues: cues, ...(audio ? { audio } : {}) });

  if (opts.scenes?.length) {
    const unknown = opts.scenes.filter((id) => !plan.scenes.some((s) => s.id === id));
    if (unknown.length) throw new Error(`no scene ${unknown.map((u) => `"${u}"`).join(", ")} in the spec (scenes: ${plan.scenes.map((s) => s.id).join(", ")})`);
  }
  const wanted = opts.scenes?.length ? plan.scenes.filter((s) => opts.scenes!.includes(s.id)) : plan.scenes;
  const skipped: StillsResult["skipped"] = [];
  const drawn: Scene[] = [];
  for (const given of wanted) {
    const s = cutawayPicture(given);
    const kind = s.deterministic?.kind;
    if (s.footage) skipped.push({ scene_id: s.id, reason: "footage scene: stills draw HyperFrames pages only (use review on a render)" });
    else if (s.visual_strategy !== "motion_graphic" || !kind) skipped.push({ scene_id: s.id, reason: `${s.visual_strategy} scene without a deterministic page` });
    else if (!HYPERFRAMES_KINDS.includes(kind)) skipped.push({ scene_id: s.id, reason: `kind "${kind}" is not drawn by HyperFrames` });
    else drawn.push(s);
  }
  if (!drawn.length) throw new Error(`no scene to draw: ${skipped.map((x) => `${x.scene_id} (${x.reason})`).join("; ") || "the spec has no scenes"}`);

  const planned = planStillTimes(
    drawn.map((s) => ({ id: s.id, duration_sec: s.duration_sec, ...(allGrids.get(s.id) ? { beats: allGrids.get(s.id)! } : {}) })),
    target.fps,
    opts,
  );
  notes.push(...planned.notes);
  if (!planned.tiles.length) throw new Error("no frames to draw: every requested time lies outside the scenes");

  const chrome = await findChrome(deps.chromePath, env as NodeJS.ProcessEnv);
  if (!chrome.ok) throw new Error(`stills need headless Chrome: ${chrome.reason}`);
  const producer = resolveHyperframesProducer(env);
  const open = deps.openCapture ?? openCaptureSession;
  if (!deps.openCapture && !producer.ok) throw new Error(`stills need the HyperFrames producer's puppeteer-core: ${producer.reason}`);

  const outDir = join(root, "review", "stills");
  const framesDir = join(outDir, "frames");
  await mkdir(framesDir, { recursive: true });
  const zones = layoutZones(target, await loadTargetContracts(spec));
  const tiles: StillTile[] = [];
  const pageErrors: string[] = [];

  // One Chrome at a time: the same gate the renderer's HyperFrames scenes go through.
  captureTrace(`stills: ${planned.tiles.length} frame(s) in ${drawn.length} scene(s); waiting for the Chrome gate`);
  await chromeGate(async () => {
    captureTrace("stills: Chrome gate acquired");
    const release = guardStdout();
    const session = await open({
      chromePath: chrome.path,
      width: target.width,
      height: target.height,
      ...(producer.ok ? { producerEntry: producer.entry } : {}),
      ...(deps.captureTimeoutMs ? { timeoutMs: deps.captureTimeoutMs } : {}),
    });
    try {
      for (const s of drawn) {
        const mine = planned.tiles.filter((t) => t.scene_id === s.id);
        if (!mine.length) continue;
        for (const f of await readdir(framesDir)) if (f.startsWith(`${s.id}-`) && f.endsWith(".png")) await rm(join(framesDir, f), { force: true });
        const req = stillRequest(s, { target, tokens, out_path: join(framesDir, `${s.id}.unused.mp4`), project_dir: root, zones }, pageData);
        let page;
        captureTrace(`stills: ${s.id}: composing the page`);
        try {
          page = await composeScene(req);
        } catch (e) {
          skipped.push({ scene_id: s.id, reason: e instanceof Error ? e.message : String(e) });
          continue;
        }
        const dir = await mkdtemp(join(tmpdir(), `vs-stills-${s.id}-`));
        try {
          for (const w of [...page.warnings, ...(await writeComposition(dir, page))]) notes.push(`${s.id}: ${w}`);
          captureTrace(`stills: ${s.id}: opening ${page.composition_id}`);
          const pc = await session.open(dir, page.composition_id, target.width, target.height);
          try {
            for (const t of mine) {
              const png = await pc.capture(t.time);
              const frame = join(framesDir, `${s.id}-${t.time.toFixed(3)}s.png`);
              await writeFile(frame, png);
              tiles.push({ index: tiles.length, scene_id: s.id, time_sec: r3(t.time), tag: t.tag, label: `${s.id} ${t.tag} ${t.time.toFixed(2)}s`, frame: relative(root, frame) });
            }
            for (const e of pc.errors) pageErrors.push(`${s.id}: ${e}`);
          } finally {
            await pc.close();
          }
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
    } finally {
      captureTrace("stills: closing Chrome");
      await session.close();
      release();
    }
  });
  captureTrace(`stills: ${tiles.length} frame(s) captured; tiling the sheet`);
  if (pageErrors.length) notes.push(...pageErrors.slice(0, 10).map((e) => `page error: ${e}`));
  if (!tiles.length) throw new Error(`no frame could be drawn: ${skipped.map((x) => `${x.scene_id}: ${x.reason}`).join("; ")}`);

  // Sheets: labelled tiles, split so no image exceeds the vision size limit.
  const tagsPerScene = new Map<string, string[]>();
  for (const t of tiles) tagsPerScene.set(t.scene_id, [...(tagsPerScene.get(t.scene_id) ?? []), t.tag]);
  const inMidOut = [...tagsPerScene.values()].every((tags) => tags.join(",") === "in,mid,out");
  const layout = planSheets(tiles.length, { width: Math.max(64, Math.round(opts.width ?? 240)), aspect: target.height / target.width, cols: opts.cols ?? 6, group: inMidOut ? 3 : 1 });
  notes.push(...layout.notes);
  const work = join(outDir, ".work");
  await rm(work, { recursive: true, force: true });
  const font = reviewFont();
  if (!font) notes.push("bundled fonts not found: tiles are unlabelled; use the tiles list for times");
  const pages: ReviewPage[] = [];
  try {
    for (const [p, [a, b]] of layout.pages.entries()) {
      const pdir = join(work, `p${p}`);
      await mkdir(pdir, { recursive: true });
      for (let i = a; i <= b; i++) {
        const t = tiles[i]!;
        await runFfmpeg(["-y", "-i", join(root, t.frame), "-frames:v", "1", "-vf", `scale=${layout.width}:-2:flags=bicubic${tileDecor(t, layout.width, font)}`, join(pdir, `${String(i - a + 1).padStart(4, "0")}.png`)], { timeoutMs: 60_000 });
      }
    }
    const base = `stills-${quality}${opts.scenes?.length === 1 ? `-${opts.scenes[0]}` : ""}`;
    const stale = (f: string) => f === `${base}.jpg` || (f.startsWith(`${base}-p`) && /^\d+\.jpg$/.test(f.slice(base.length + 2)));
    for (const f of await readdir(outDir)) if (stale(f)) await rm(join(outDir, f), { force: true });
    for (const [p, [a, b]] of layout.pages.entries()) {
      const n = b - a + 1;
      const cols = Math.min(layout.cols, n);
      const rows = Math.ceil(n / cols);
      const image = join(outDir, layout.pages.length === 1 ? `${base}.jpg` : `${base}-p${p + 1}.jpg`);
      await tileSheet(join(work, `p${p}`), cols, rows, image);
      const scenes = [...new Set(tiles.slice(a, b + 1).map((x) => x.scene_id))];
      pages.push({ image, image_rel: relative(root, image), cols, rows, tiles: [a, b], scenes });
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  const drawnIds = new Set(tiles.map((t) => t.scene_id));
  return {
    kind: "stills",
    quality,
    width: target.width,
    height: target.height,
    fps: target.fps,
    image: pages[0]!.image,
    image_rel: pages[0]!.image_rel,
    images: pages.map((p) => p.image),
    images_rel: pages.map((p) => p.image_rel),
    pages,
    cols: pages[0]!.cols,
    rows: pages[0]!.rows,
    tile_width: layout.width,
    tiles,
    scenes: drawn
      .filter((s) => drawnIds.has(s.id))
      .map((s) => ({ scene_id: s.id, kind: s.deterministic!.kind, duration_sec: s.duration_sec, beats: allGrids.get(s.id)?.beats_s.length ?? 0, downbeats: allGrids.get(s.id)?.downbeats_s.length ?? 0 })),
    skipped,
    durations: plan.from,
    grid: { source: gridSource, ...(grid ? { bpm: grid.bpm } : {}) },
    notes,
  };
}

export function formatStills(r: StillsResult): string {
  const lines = [
    `stills (not a render; renders/ and dist/ are unchanged): ${r.tiles.length} frame(s) of ${r.scenes.length} scene(s) drawn from the composed pages at ${r.width}x${r.height}, ${r.fps} fps (${r.quality})${r.pages.length === 1 ? ` → ${r.image}` : ` in ${r.pages.length} images (Read every one):`}`,
    ...(r.pages.length > 1 ? r.pages.map((p, i) => `  ${i + 1}. ${p.image} (${p.cols}×${p.rows}, tiles ${p.tiles[0] + 1}-${p.tiles[1] + 1}, ${p.scenes.join(", ")})`) : []),
    `beat grid: ${r.grid.source === "none" ? "none (no music bed)" : `${r.grid.bpm ?? "?"} bpm from the ${r.grid.source === "music" ? "music bed" : "latest render"}`}; durations from the ${r.durations === "spec" ? "spec" : "latest render"}`,
    ...r.skipped.map((s) => `skipped ${s.scene_id}: ${s.reason}`),
    "Read the image and check every moment: text fits and is readable, nothing overlaps, crowds an edge or sits under captions and app UI, each state lands on its beat or bar (see the labels), no empty or cramped frames. Fix the page or spec and run stills again before render_submit.",
    ...r.notes.map((n) => `note: ${n}`),
  ];
  return lines.join("\n");
}

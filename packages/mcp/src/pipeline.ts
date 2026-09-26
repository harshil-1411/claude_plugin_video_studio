import { copyFile, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ensureDir, hashFile, projectPaths, readJson, writeJsonAtomic } from "@video-studio/core";
import { type QaReport, technicalQa, writeQaReport } from "@video-studio/media";
import { type SceneRenderEntry, findFontsDir, findStylesDir, getStyle, LAYOUT_VERSION, parseFontChain, resolveTokens } from "@video-studio/renderer";
import { CreativeBrief, RenderManifest, type SceneRender, VideoSpec, parseYamlOrJson, resolveTargets, type C2paRecord } from "@video-studio/schema";
import { ZONES_VERSION, findPlatformSpecsDir, loadContracts } from "@video-studio/platforms";
import { type C2paDeps, type SourceFacts, classifySource, signVideos } from "./c2pa.js";
import { COVER_VERSION } from "./cover.js";
import { LOCK_FILE, buildLock, listFiles, lockAssets, lockFonts, serializeLock } from "./lock.js";
import { acquireRenderLock } from "./render-lock.js";
import { type LintResult, lintProject } from "./lint.js";
import { TARGET_PACKAGE_VERSION, packageTargets } from "./targets.js";
import { projectSpecPaths } from "./spec-validate.js";
import {
  ASSEMBLY_VERSION,
  ENGINE_VERSION,
  QA_VERSION,
  type DistFiles,
  type QaFinding,
  type QaOutcome,
  type Quality,
  type RenderProjectOptions,
  type RenderProjectResult,
  type RenderState,
  errMsg,
  exists,
  fontRequests,
  loadBrand,
  loadBrief,
  rel,
  renderDir,
} from "./pipeline-core.js";
import {
  type RenderRun,
  createRenderRun,
  frameTimeline,
  resolveWordCues,
  stageAssembly,
  stageCaptions,
  stageCover,
  stageInputs,
  stageNativeTracks,
  stagePlanTiming,
  stageRenderState,
  stageSceneAudio,
  stageScenes,
  stageSources,
  stageTarget,
  stageVoice,
} from "./pipeline-stages.js";

// Public API (index.ts re-exports this module): types, constants and helpers that live in the pipeline-* modules.
export {
  ASSEMBLY_VERSION,
  DEFAULT_TRANSITION_MS,
  ENGINE_VERSION,
  QA_VERSION,
  SpecInvalidError,
  defaultRenderers,
  loadTargetContracts,
  loadValidSpec,
  targetFor,
  type DistFiles,
  type QaFinding,
  type QaOutcome,
  type Quality,
  type RenderProgress,
  type RenderProjectOptions,
  type RenderProjectResult,
  type RenderStage,
} from "./pipeline-core.js";
export {
  CUE_MAX_MS,
  CUE_SETTLE_MS,
  MIN_CUE_MS,
  MUSIC_CUE_MIN_GAP_MS,
  SFX_CUE_MS,
  SOUND_CUE_SCENE_PREFIX,
  bracketCue,
  isSoundCue,
  soundEventCues,
  type SoundCueInput,
  type SoundCueScene,
} from "./pipeline-sound-cues.js";
export { LOGO_DEFAULT_FRACTION } from "./pipeline-media.js";

// ------------------------------------------------------------------------------------ renderProject

/**
 * Render a planned project into `dist/`: validate → voice → scene clips → captions → assemble
 * (clean master + captioned reel) → thumbnail → technical QA → export. Every stage is cached:
 * voice by content, clips by sidecar cache keys, and assembly by the hash of its inputs, so a
 * re-run only redoes what changed. The spec is never modified.
 */
export async function renderProject(projectDir: string, o: RenderProjectOptions = {}): Promise<RenderProjectResult> {
  // One render per project at a time, across processes (sessions, the MCP server, the dev CLI).
  const release = await acquireRenderLock(join(projectPaths(projectDir).renders, ".render.lock"), o.quality ?? "preview");
  try {
    return await renderProjectLocked(projectDir, o);
  } finally {
    await release();
  }
}


async function renderProjectLocked(projectDir: string, o: RenderProjectOptions): Promise<RenderProjectResult> {
  const run = createRenderRun(projectDir, o);
  const { root, quality, preference, voiceChoice, warnings, now, progress } = run;

  // a. validate; b. target
  const inputs = await stageInputs(run);
  const { spec } = inputs;
  const tp = await stageTarget(run, spec);
  const { target } = tp;

  // c. voice (+ c1. alignment); c0. footage assets and the music bed
  const vs = await stageVoice(run, spec, inputs.brand);
  const { voice, trackById, hasAudio } = vs;
  const { footage, music } = await stageSources(run, spec, inputs.irPath);

  // c'. overruns and beat sync (render plan only); frame-aligned slots; native transcripts; word cues
  const timing = await stagePlanTiming(run, spec, voice, music, trackById);
  const { planScenes, timing_adjustments } = timing;
  const timeline = frameTimeline(planScenes, target.fps);
  const nativeTracks = await stageNativeTracks(run, vs.mode, planScenes, footage, timeline.slotMs);
  const timingSource = nativeTracks.size ? "aligned" : vs.timingSource;
  const { sceneCues, cueLog } = resolveWordCues(run, planScenes, nativeTracks, trackById, timeline.slotMs);

  // d. scene clips
  const scenes = await stageScenes(run, { spec, planScenes, tokens: inputs.tokens, target, tp, footage, sceneCues });
  const { ordered, used, placeholders, reasons, zones, contracts } = scenes;

  // e. captions; e'. music ducking and per-scene audio
  const captions = await stageCaptions(run, { spec, inputs, target, planScenes, timeline, vs, nativeTracks, footage, music, zones });
  const audio = await stageSceneAudio(run, { mode: vs.mode, hasAudio, planScenes, placements: captions.placements, slotMs: timeline.slotMs, footage, nativeTracks });

  // f. assembly (skipped when the inputs are unchanged); g. cover or thumbnail
  const asm = await stageAssembly(run, { inputs, tp, planScenes, timeline, ordered, zones, hasAudio, music, captions, audio });
  const cover = await stageCover(run, { spec, inputs, planScenes, placements: captions.placements, slotMs: timeline.slotMs, zones, contracts, asm });

  const state = await stageRenderState(run, { inputs, target, vs, timingSource, timing, footage, music, cueLog, scenes, captions, audio, asm, cover });

  // f'. technical QA on the reel (reused when the reel is unchanged), then persist the state
  const qa = await stageQa(run, state, asm.reel, asm.statePath);

  // g'. export
  progress({ stage: "export", message: "exporting dist/" });
  const dist = await exportFromState(root, state, now);
  progress({ stage: "done", message: `done: ${rel(root, dist.reel)}` });

  return {
    project_dir: root,
    quality,
    width: target.width,
    height: target.height,
    fps: target.fps,
    duration_sec: captions.totalMs / 1000,
    dist,
    qa,
    voice: { requested: voiceChoice, backend: voice.backend, reason: vs.reason, timing_source: timingSource, has_audio: hasAudio },
    renderer: { preference, used, reasons },
    timing_adjustments,
    placeholders,
    warnings,
    cache: {
      voice_hits: voice.cache_hits,
      scenes_cached: ordered.filter((e) => e.from_cache).map((e) => e.scene_id),
      scenes_rendered: ordered.filter((e) => !e.from_cache).map((e) => e.scene_id),
      assembly: asm.reuse ? "reused" : "assembled",
    },
  };
}

/**
 * f'. Technical QA on the reel, reused when the reel, QA version and report are unchanged; then
 * stamp `finished_at` and write the render state and renders/latest.json.
 */
async function stageQa(run: RenderRun, state: RenderState, reel: string, statePath: string): Promise<QaOutcome> {
  const { root, paths, quality, signal, progress, now } = run;
  const reelSha = await hashFile(reel);
  let qa: QaOutcome;
  if (state.qa && state.qa.video_sha256 === reelSha && state.qa.version === QA_VERSION && (await exists(join(paths.qa, "report.json")))) {
    qa = { status: state.qa.status, findings: state.qa.findings, report_json: join(paths.qa, "report.json"), report_md: join(paths.qa, "report.md") };
  } else {
    signal?.throwIfAborted();
    progress({ stage: "qa", message: "running technical QA" });
    qa = await runQaOn(root, state, reelSha);
  }
  state.finished_at = now().toISOString();
  await writeJsonAtomic(statePath, state);
  await writeJsonAtomic(join(paths.renders, "latest.json"), { quality });
  return qa;
}

// ------------------------------------------------------------------------------------ QA

const QA_MAP = { ok: "pass", warn: "warn", fail: "fail" } as const;

async function runQaOn(root: string, state: RenderState, reelSha?: string): Promise<QaOutcome> {
  const reel = join(root, state.reel);
  const noSound = !state.voice.has_audio && !state.music && !state.scene_audio;
  const report: QaReport = await technicalQa(reel, {
    width: state.target.width,
    height: state.target.height,
    duration_s: state.duration_ms / 1000,
    require_audio: true,
    // Silent on purpose (voice.mode none), or a preview rendered with the silent voice backend:
    // silence and loudness are not findings then, just not measured.
    ...(noSound ? { intended_silence: true, silence_reason: state.voice_mode === "none" ? "silent on purpose (no narration, no music)" : "rendered with the silent voice (no narration audio)" } : {}),
    ...(state.background ? { background: state.background } : {}),
  });
  // Relative path in the report so the project folder stays portable.
  report.video = state.reel;
  const files = await writeQaReport(root, report);
  const findings: QaFinding[] = report.checks
    .filter((c) => c.status !== "ok")
    .map((c) => ({ id: c.id, status: c.status as "warn" | "fail", detail: c.detail, ...(c.fix ? { fix: c.fix } : {}) }));
  const status = QA_MAP[report.status];
  state.qa = {
    version: QA_VERSION,
    status,
    video_sha256: reelSha ?? (await hashFile(reel)),
    checks: report.checks.map((c) => ({ id: c.id, status: QA_MAP[c.status], message: c.detail })),
    findings,
  };
  return { status, findings, report_json: files.json, report_md: files.md };
}

async function loadState(projectDir: string, quality?: Quality): Promise<RenderState> {
  const paths = projectPaths(projectDir);
  const q = quality ?? (await readJson<{ quality: Quality }>(join(paths.renders, "latest.json")).catch(() => undefined))?.quality;
  if (!q) throw new Error(`no render found in ${paths.renders}; run render_submit first`);
  const state = await readJson<RenderState>(join(renderDir(projectDir, q), "render-state.json")).catch(() => undefined);
  if (!state) throw new Error(`no ${q} render found in ${renderDir(projectDir, q)}; run render_submit with quality "${q}" first`);
  for (const p of [state.master, state.reel, state.thumbnail]) {
    if (!(await exists(join(paths.root, p)))) throw new Error(`render output ${p} is missing; re-run render_submit`);
  }
  return state;
}

/** Re-run technical QA on the latest (or given quality's) reel, then refresh dist/. */
export async function runQa(projectDir: string, opts: { quality?: Quality; now?: () => Date } = {}): Promise<{ qa: QaOutcome; quality: Quality; dist: DistFiles }> {
  const root = projectPaths(projectDir).root;
  const state = await loadState(root, opts.quality);
  const qa = await runQaOn(root, state);
  await writeJsonAtomic(join(renderDir(root, state.quality), "render-state.json"), state);
  const dist = await exportFromState(root, state, opts.now ?? (() => new Date()));
  return { qa, quality: state.quality, dist };
}

/** Re-export dist/ from the latest (or given quality's) existing render; renders nothing. */
export async function exportProject(
  projectDir: string,
  opts: {
    quality?: Quality;
    now?: () => Date;
    /** Sign the exported videos (reel, clean master, every dist/<target>/video.mp4) with C2PA content credentials via the local c2patool. */
    sign?: boolean;
    /** c2patool lookup/runner overrides (tests). */
    c2pa?: C2paDeps;
  } = {},
): Promise<{ quality: Quality; dist: DistFiles; qa_status?: string }> {
  const root = projectPaths(projectDir).root;
  const state = await loadState(root, opts.quality);
  const dist = await exportFromState(root, state, opts.now ?? (() => new Date()), { ...(opts.sign ? { sign: true } : {}), ...(opts.c2pa ? { c2pa: opts.c2pa } : {}) });
  return { quality: state.quality, dist, ...(state.qa ? { qa_status: state.qa.status } : {}) };
}

// ------------------------------------------------------------------------------------ export

const STOPWORDS = new Set(
  "a an and are as at be but by can do does for from how in into is it its of on or so that the their this to what when where which who why with without you your in 30s seconds explain explained actually".split(
    " ",
  ),
);

const PLATFORM_TAGS: Record<string, string[]> = {
  youtube_shorts: ["shorts"],
  instagram_reels: ["reels"],
  tiktok: ["fyp"],
  linkedin: [],
  youtube: [],
  x: [],
  generic: [],
};

function hashtag(word: string): string {
  return word.replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

function firstSentence(text: string): string {
  return (text.split(/(?<=[.!?])\s/)[0] ?? text).trim();
}

/** Deterministic social copy (title, 2–3 line description, hashtags). Claude refines it in the skill. */
export function socialCopy(spec: VideoSpec, brief?: CreativeBrief): string {
  const { title, lines, hashtags } = socialCopyParts(spec, brief);
  return [
    "<!-- Generated deterministically from the spec and brief by video-studio. Refine the wording before posting; keep every claim grounded in the sources. -->",
    `# ${title}`,
    "",
    ...lines,
    "",
    hashtags.join(" "),
    "",
  ].join("\n");
}

/** The pieces of {@link socialCopy}: title, up to 3 description lines and up to 7 hashtags (with `#`). */
export function socialCopyParts(spec: VideoSpec, brief?: CreativeBrief): { title: string; lines: string[]; hashtags: string[] } {
  const title = spec.title?.trim() || brief?.chosen_hook || firstSentence(spec.scenes[0]?.voiceover ?? "") || "New video";
  const lines: string[] = [];
  const hook = spec.scenes.find((s) => s.purpose === "hook");
  if (hook?.voiceover.trim()) lines.push(hook.voiceover.trim());
  const messages = brief?.key_messages?.length
    ? brief.key_messages
    : spec.scenes.filter((s) => !["hook", "cta", "end_card"].includes(s.purpose) && s.voiceover.trim()).map((s) => firstSentence(s.voiceover));
  if (messages[0] && !lines.includes(messages[0])) lines.push(messages[0]);
  const action = brief?.desired_action ?? spec.scenes.find((s) => s.purpose === "cta")?.voiceover.trim();
  if (action) lines.push(action);
  const contentWords = (text: string) =>
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  // Title words first, then words the narration repeats across scenes (most frequent first).
  const freq = new Map<string, number>();
  for (const sc of spec.scenes) for (const w of new Set(contentWords(sc.voiceover))) freq.set(w, (freq.get(w) ?? 0) + 1);
  const repeated = [...freq].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([w]) => w);
  const tags: string[] = [];
  const add = (w: string) => {
    const t = hashtag(w);
    if (t && !tags.some((x) => x.toLowerCase() === t.toLowerCase() || x.toLowerCase() === `${t.toLowerCase()}s` || `${x.toLowerCase()}s` === t.toLowerCase())) tags.push(t);
  };
  for (const w of contentWords(title)) add(w);
  for (const w of repeated.slice(0, 3)) add(w);
  for (const w of [...(PLATFORM_TAGS[spec.platform] ?? []), spec.goal === "explain" ? "explained" : spec.goal]) add(w);
  return { title, lines: lines.slice(0, 3), hashtags: tags.slice(0, 7).map((t) => `#${t}`) };
}

async function exportFromState(root: string, state: RenderState, now: () => Date, opts: { sign?: boolean; c2pa?: C2paDeps } = {}): Promise<DistFiles> {
  const paths = projectPaths(root);
  const distDir = paths.dist;
  await ensureDir(distDir);
  const { spec } = await loadSpecLoose(root);
  const brief = await loadBrief(root);
  const d = (name: string) => join(distDir, name);
  const out: DistFiles = {
    dir: distDir,
    reel: d("reel.mp4"),
    clean_master: d("clean-master.mp4"),
    thumbnail: d("thumbnail.png"),
    social_copy: d("social-copy.md"),
    render_manifest: d("render-manifest.json"),
    lock: d(LOCK_FILE),
    provenance: d("provenance.json"),
    video_spec: d("video-spec.json"),
    targets: [],
  };
  await copyFile(join(root, state.reel), out.reel);
  await copyFile(join(root, state.master), out.clean_master);
  await copyFile(join(root, state.thumbnail), out.thumbnail);
  if (state.cover && (await exists(join(root, state.cover.path))) && (await exists(join(root, state.cover.square_preview)))) {
    out.cover = d("cover.jpg");
    out.cover_square_preview = d("cover-square-preview.jpg");
    await copyFile(join(root, state.cover.path), out.cover);
    await copyFile(join(root, state.cover.square_preview), out.cover_square_preview);
  } else {
    for (const name of ["cover.jpg", "cover-square-preview.jpg"]) await rm(d(name), { force: true });
  }
  for (const [key, src, name] of [
    ["captions_srt", state.captions.srt, "captions.srt"],
    ["captions_vtt", state.captions.vtt, "captions.vtt"],
    ["transcript", state.captions.txt, "transcript.txt"],
  ] as const) {
    if (src) {
      await copyFile(join(root, src), d(name));
      out[key] = d(name);
    } else {
      await rm(d(name), { force: true });
    }
  }
  await writeFile(out.social_copy, socialCopy(spec, brief));
  await copyFile(projectSpecPaths(root).spec, out.video_spec);
  const storyboardSrc = join(root, "project", "storyboard.md");
  if (await exists(storyboardSrc)) {
    out.storyboard = d("storyboard.md");
    await copyFile(storyboardSrc, out.storyboard);
  } else {
    await rm(d("storyboard.md"), { force: true });
  }

  // per-target packages: dist/<target>/
  let lint: LintResult | undefined;
  let lintError: string | undefined;
  try {
    lint = await lintProject(root, { quality: state.quality });
  } catch (e) {
    lintError = errMsg(e);
  }
  const specsDir = findPlatformSpecsDir();
  const allContracts = specsDir ? await loadContracts(specsDir) : [];
  const wanted = resolveTargets(spec);
  out.targets = await packageTargets(
    {
      root,
      distDir,
      renderDir: renderDir(root, state.quality),
      quality: state.quality,
      spec,
      contracts: allContracts.filter((c) => wanted.includes(c.id)),
      reel: out.reel,
      reelFacts: {
        width: state.target.width,
        height: state.target.height,
        fps: state.target.fps,
        duration_sec: state.duration_ms / 1000,
        bytes: (await stat(out.reel)).size,
      },
      ...(out.cover ? { cover: out.cover } : {}),
      ...(state.cover ? { coverAtMs: state.cover.at_ms } : {}),
      ...(out.captions_srt ? { captionsSrt: out.captions_srt } : {}),
      ...(out.captions_vtt ? { captionsVtt: out.captions_vtt } : {}),
      generatedCopy: (c) => {
        // Platform hashtags (#Shorts, #Reels, #fyp) follow the target, not the spec's primary platform.
        const copy = socialCopyParts({ ...spec, platform: c.platform ?? "generic" }, brief);
        return { post_caption: [copy.title, ...copy.lines].join("\n"), hashtags: copy.hashtags };
      },
      ...(lint ? { lint } : {}),
      ...(lintError ? { lintError } : {}),
      ...(state.qa ? { technicalQa: state.qa.status } : {}),
      ...(state.music ? { music: { ref: state.music.ref, ...(state.music.title ? { title: state.music.title } : {}), ...(state.music.license ? { license: state.music.license } : {}) } } : {}),
    },
    allContracts.map((c) => c.id),
  );

  // C2PA: sign the exported videos (after packaging, which copies/transcodes the unsigned reel;
  // before hashing, so outputs and video.lock describe the signed files).
  const exportWarnings: string[] = [];
  let signed = new Set<string>();
  let c2pa: C2paRecord | undefined;
  let c2paSource: ReturnType<typeof classifySource> | undefined;
  if (opts.sign) {
    const facts: SourceFacts = {
      voice_backend: state.voice.backend,
      voice_has_audio: state.voice.has_audio,
      scenes: state.scenes.map((s) => ({ renderer: s.renderer, placeholder: s.placeholder })),
    };
    const r = await signVideos({
      root,
      files: [out.reel, out.clean_master, ...out.targets.map((t) => t.video)],
      title: spec.title?.trim() || socialCopyParts(spec, brief).title,
      engineVersion: ENGINE_VERSION,
      facts,
      ...opts.c2pa,
    });
    exportWarnings.push(...r.warnings);
    signed = new Set(r.signed);
    c2pa = r.record;
    if (c2pa) c2paSource = classifySource(facts);
  }
  const c2paFlag = (p: string) => (signed.has(p) ? { c2pa: true } : {});
  if (c2pa) out.c2pa = c2pa;
  if (exportWarnings.length) out.warnings = exportWarnings;

  // provenance: copy source/provenance.json and add what this render used
  let source: unknown = null;
  try {
    source = JSON.parse(await readFile(join(paths.source, "provenance.json"), "utf8"));
  } catch {
    source = null;
  }
  const provenance = {
    ...(source && typeof source === "object" ? (source as Record<string, unknown>) : { sources: [] }),
    render: {
      rendered_at: state.finished_at,
      quality: state.quality,
      spec_sha256: state.spec_sha256,
      ...(state.content_ir_sha256 ? { content_ir_sha256: state.content_ir_sha256 } : {}),
      voice: { backend: state.voice.backend, timing_source: state.voice.timing_source, ...(state.voice_mode ? { mode: state.voice_mode } : {}) },
      ...(state.music ? { music: { file: state.music.ref, ...(state.music.title ? { title: state.music.title } : {}), license: state.music.license ?? null } } : {}),
      ...(state.footage?.length ? { footage: state.footage.map((f) => ({ asset: f.asset, file: f.path, sha256: f.sha256, scenes: f.scenes })) } : {}),
      ...(state.sfx?.length ? { sfx: state.sfx.map((x) => ({ file: x.file, sha256: x.sha256, scenes: x.scenes, license: x.license ?? null })) } : {}),
      ...(state.timing_adjustments.length ? { timing_adjustments: state.timing_adjustments } : {}),
      ...(state.sound_events ? { captions: { sound_events: state.sound_events } } : {}),
      ...(c2pa && c2paSource ? { c2pa: { ...c2pa, digital_source_type: c2paSource.digital_source_type, reasons: c2paSource.reasons } } : {}),
      scenes: state.scenes.map((s) => ({
        scene_id: s.scene_id,
        claim_refs: s.claim_refs,
        visual_strategy: s.visual_strategy,
        renderer: s.renderer,
        placeholder: s.placeholder,
      })),
    },
  };
  await writeJsonAtomic(out.provenance, provenance);

  // manifest
  const sha = (p: string) => hashFile(p);
  const reelProbe = { width: state.target.width, height: state.target.height, duration_sec: state.duration_ms / 1000 };
  const outputs: RenderManifest["outputs"] = [
    { kind: "final", path: rel(root, out.reel), sha256: await sha(out.reel), ...reelProbe, ...c2paFlag(out.reel) },
    { kind: "clean_master", path: rel(root, out.clean_master), sha256: await sha(out.clean_master), ...reelProbe, ...c2paFlag(out.clean_master) },
  ];
  if (out.captions_srt) outputs.push({ kind: "captions", path: rel(root, out.captions_srt), sha256: await sha(out.captions_srt) });
  if (out.captions_vtt) outputs.push({ kind: "captions", path: rel(root, out.captions_vtt), sha256: await sha(out.captions_vtt) });
  if (out.transcript) outputs.push({ kind: "other", path: rel(root, out.transcript), sha256: await sha(out.transcript) });
  outputs.push({ kind: "thumbnail", path: rel(root, out.thumbnail), sha256: await sha(out.thumbnail), width: state.target.width, height: state.target.height });
  if (out.cover && out.cover_square_preview && state.cover) {
    const sq = state.cover.crops.find((c) => c.id === "square-preview");
    outputs.push({ kind: "thumbnail", path: rel(root, out.cover), sha256: await sha(out.cover), width: state.cover.width, height: state.cover.height });
    outputs.push({ kind: "other", path: rel(root, out.cover_square_preview), sha256: await sha(out.cover_square_preview), ...(sq ? { width: sq.w, height: sq.h } : {}) });
  }
  outputs.push({ kind: "social_copy", path: rel(root, out.social_copy), sha256: await sha(out.social_copy) });
  outputs.push({ kind: "provenance", path: rel(root, out.provenance), sha256: await sha(out.provenance) });
  outputs.push({ kind: "spec", path: rel(root, out.video_spec), sha256: await sha(out.video_spec) });
  if (out.storyboard) outputs.push({ kind: "other", path: rel(root, out.storyboard), sha256: await sha(out.storyboard) });
  for (const t of out.targets) {
    const target = t.id;
    outputs.push({
      kind: "final",
      target,
      path: rel(root, t.video),
      sha256: await sha(t.video),
      width: t.width,
      height: t.height,
      duration_sec: state.duration_ms / 1000,
      ...(t.transcoded ? { transcoded: true } : {}),
      ...c2paFlag(t.video),
    });
    if (t.cover) outputs.push({ kind: "thumbnail", target, path: rel(root, t.cover), sha256: await sha(t.cover) });
    for (const p of [t.captions_srt, t.captions_vtt]) if (p) outputs.push({ kind: "captions", target, path: rel(root, p), sha256: await sha(p) });
    outputs.push({ kind: "post", target, path: rel(root, t.post), sha256: await sha(t.post) });
    outputs.push({ kind: "qa", target, path: rel(root, t.qa), sha256: await sha(t.qa) });
  }

  const statusMap: Record<SceneRenderEntry["status"], SceneRender["status"]> = { rendered: "succeeded", cached: "cached", pending: "pending", failed: "failed" };
  const renders: SceneRender[] = state.scenes.map((s) => ({
    scene_id: s.scene_id,
    provider: s.renderer,
    model: `${s.renderer}@${s.renderer_version}`,
    request_hash: s.cache_key,
    output_path: s.clip,
    output_sha256: s.clip_sha256,
    started_at: s.started_at,
    finished_at: s.finished_at,
    attempts: 1,
    status: statusMap[s.status],
    renderer_version: s.renderer_version,
    ...(s.placeholder ? { placeholder: true, error: `placeholder: ${s.reason ?? "video providers (generated video, avatars) arrive in Phase 7; until then this is a placeholder card"}` } : {}),
    ...(s.warnings.length ? { warnings: s.warnings } : {}),
    ...(s.text_boxes?.length ? { text_boxes: s.text_boxes } : {}),
  }));

  const captionFiles: NonNullable<RenderManifest["captions"]>["files"] = [];
  for (const fmt of ["json", "srt", "vtt", "ass"] as const) {
    const p = state.captions[fmt];
    if (p) captionFiles.push({ format: fmt, path: p, sha256: await sha(join(root, p)) });
  }
  const tracksAbs = join(root, state.voice.tracks_path);
  const project = await readJson<{ id?: string }>(paths.projectFile).catch(() => undefined);
  const projectId = project?.id ?? spec.id ?? (basename(root).replace(/[^A-Za-z0-9_.@:-]/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "project");

  const manifest: RenderManifest = {
    schema_version: "1.0",
    project_id: projectId,
    spec_sha256: state.spec_sha256,
    ...(state.content_ir_sha256 ? { content_ir_sha256: state.content_ir_sha256 } : {}),
    created_at: state.started_at,
    updated_at: now().toISOString(),
    renders,
    ...((await exists(tracksAbs))
      ? {
          voice: {
            provider: state.voice.backend,
            ...(state.voice.voice_id ? { voice_id: state.voice.voice_id } : {}),
            request_hash: state.voice.request_hash,
            output_path: state.voice.tracks_path,
            output_sha256: await sha(tracksAbs),
            ...(state.captions.json ? { alignment_path: state.captions.json } : {}),
            timing_source: (["provider", "aligned", "estimated", "none"].includes(state.voice.timing_source) ? state.voice.timing_source : "estimated") as "provider",
            reason: state.voice.reason,
          },
        }
      : {}),
    ...(captionFiles.length
      ? {
          captions: {
            preset: state.caption_preset,
            burn_in: state.burn_in,
            ...(state.burn_in && state.caption_layout ? { box: state.caption_layout.box, max_lines: state.caption_layout.max_lines } : {}),
            ...(state.sound_events ? { sound_events: state.sound_events } : {}),
            files: captionFiles,
          },
        }
      : {}),
    ...(state.music ? { music: { file: state.music.ref, sha256: state.music.sha256, ...(state.music.title ? { title: state.music.title } : {}), ...(state.music.license ? { license: state.music.license } : {}) } } : {}),
    ...(out.cover && state.cover
      ? {
          cover: {
            path: rel(root, out.cover),
            ...(out.cover_square_preview ? { square_preview: rel(root, out.cover_square_preview) } : {}),
            at_ms: state.cover.at_ms,
            ...(state.cover.headline_box ? { headline_box: state.cover.headline_box } : {}),
            crops: state.cover.crops.map(({ id, targets, x, y, w, h }) => ({ id, targets, rect: { x, y, w, h } })),
          },
        }
      : {}),
    outputs,
    ...(c2pa ? { c2pa } : {}),
    ...(state.qa ? { qa: { status: state.qa.status, checks: state.qa.checks, report_path: "qa/report.json" } } : {}),
    settings: {
      quality: state.quality,
      width: state.target.width,
      height: state.target.height,
      fps: state.target.fps,
      aspect_ratio: state.target.aspect_ratio,
      renderer_preference: state.renderer.preference,
      renderer_reasons: state.renderer.reasons,
    },
    ...(state.timing_adjustments.length ? { timing_adjustments: state.timing_adjustments } : {}),
    ...(state.warnings.length || exportWarnings.length ? { warnings: [...state.warnings, ...exportWarnings] } : {}),
    tool_versions: { ...state.tool_versions, ...(c2pa ? { c2patool: c2pa.tool.replace(/^c2patool\s+/, "") } : {}) },
  };
  // video.lock (before the manifest, which lists it)
  const lock = await lockFromState(root, state, projectId, outputs);
  await writeFile(out.lock, serializeLock(lock));
  // A copy per quality, so diff can compare preview and final after dist/ moved on to the other one.
  await writeFile(join(renderDir(root, state.quality), LOCK_FILE), serializeLock(lock));
  manifest.outputs.push({ kind: "lock", path: rel(root, out.lock), sha256: await sha(out.lock) });

  const parsed = RenderManifest.safeParse(manifest);
  if (!parsed.success) throw new Error(`internal: render manifest failed schema validation: ${parsed.error.message}`);
  await writeJsonAtomic(out.render_manifest, parsed.data);
  return out;
}

/**
 * The lock for an exported render. Assets are the project inputs the render and export read:
 * the ContentIR and source provenance, the brand file, the brief and storyboard, and files under
 * assets/ (except assets/voice/, which the render writes; the voice request hash covers it).
 */
async function lockFromState(root: string, state: RenderState, projectId: string, outputs: RenderManifest["outputs"]) {
  const paths = projectPaths(root);
  const brand = state.brand_path && !state.brand_path.startsWith("external/") ? [state.brand_path] : state.brand_path ? [] : ["brand.yaml", "project/brand.yaml"];
  const inputs = [
    rel(root, projectSpecPaths(root).contentIr),
    rel(root, join(paths.source, "provenance.json")),
    ...brand,
    ...["creative-brief.yaml", "creative-brief.yml", "creative-brief.json", "storyboard.md"].map((n) => `project/${n}`),
    ...(await listFiles(root, "assets", ["assets/voice"])),
    // Footage and sound effects may live outside assets/ (e.g. source/); they are inputs too.
    ...(state.footage ?? []).map((f) => f.path),
    ...(state.sfx ?? []).map((x) => x.file),
  ];
  // Fonts: recorded at render time; older render states are resolved now.
  let fonts = state.fonts;
  if (!fonts) {
    const brandFile = await loadBrand(root).catch(() => undefined);
    const styleId = state.style?.split("@")[0];
    const style = styleId ? await getStyle(findStylesDir(process.env), styleId).catch(() => undefined) : undefined;
    const language = await loadSpecLoose(root).then((r) => r.spec.language).catch(() => undefined);
    const tokens = resolveTokens(brandFile?.brand, {}, style, language ? { language } : {});
    const captionFamily = brandFile?.brand.captions?.family ?? parseFontChain(tokens.font_body)[0];
    fonts = await lockFonts(fontRequests(tokens, captionFamily, state.burn_in), { fontsDir: findFontsDir(process.env) });
  }
  const specsDir = findPlatformSpecsDir();
  const contracts = specsDir ? await loadContracts(specsDir) : [];
  const targetIds = new Set(outputs.flatMap((o) => (o.target ? [o.target] : [])));
  const { "video-studio-engine": _e, ...tools } = state.tool_versions;
  return buildLock({
    schema_version: "1.0",
    project_id: projectId,
    quality: state.quality,
    spec_sha256: state.spec_sha256,
    ...(state.content_ir_sha256 ? { content_ir_sha256: state.content_ir_sha256 } : {}),
    engine: {
      engine: ENGINE_VERSION,
      assembly: String(ASSEMBLY_VERSION),
      cover: String(COVER_VERSION),
      target_package: String(TARGET_PACKAGE_VERSION),
      zones: String(ZONES_VERSION),
      layout: String(LAYOUT_VERSION),
    },
    tools,
    voice: { backend: state.voice.backend, ...(state.voice.voice_id ? { voice_id: state.voice.voice_id } : {}), request_hash: state.voice.request_hash },
    fonts,
    targets: contracts.filter((c) => targetIds.has(c.id)).map((c) => ({ id: c.id, contract_version: c.contract_version, verified: c.verified })),
    scenes: state.scenes.map((s) => ({ scene_id: s.scene_id, renderer: s.renderer, renderer_version: s.renderer_version, cache_key: s.cache_key, clip_sha256: s.clip_sha256 })),
    // A user music file outside assets/ is an input too; a bundled bed is recorded by its ref.
    assets: [
      ...(await lockAssets(root, [...new Set(state.music && !state.music.ref.startsWith("bundled:") ? [...inputs, state.music.ref] : inputs)])),
      ...(state.music?.ref.startsWith("bundled:") ? [{ path: state.music.ref, sha256: state.music.sha256 }] : []),
    ],
    outputs: outputs.map((o) => ({ path: o.path, sha256: o.sha256, ...(o.target ? { target: o.target } : {}) })),
  });
}

/** Spec for export: parsed without re-running semantic validation (the render already did). */
async function loadSpecLoose(root: string): Promise<{ spec: VideoSpec }> {
  const { spec: specPath } = projectSpecPaths(root);
  const parsed = parseYamlOrJson(VideoSpec, await readFile(specPath, "utf8"));
  if (!parsed.ok) throw new Error(`project/video-spec.json is no longer valid: ${parsed.errors.map((e) => e.message).join("; ")}`);
  return { spec: parsed.data };
}

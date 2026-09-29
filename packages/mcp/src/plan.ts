import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@video-studio/core";
import { findStylesDir, getStyle } from "@video-studio/renderer";
import {
  type Acceptance,
  type AspectRatio,
  ContentIR,
  CreativeBrief,
  DETERMINISTIC_PROPS_EXAMPLES,
  PLATFORM_NORMS,
  type Platform,
  type Scene,
  type Template,
  VideoSpec,
  parseYamlOrJson,
  defaultMaster,
  resolveMaster,
  resolveTargets,
  validateCreativeBriefSemantics,
  validateVideoSpecSemantics,
} from "@video-studio/schema";
import { findResearchSpecsDir, loadToneRules } from "./research-specs.js";
import { getTemplate } from "./templates.js";

/** An actionable finding: where, what, and how to fix it. */
export interface PlanIssue {
  path: string;
  message: string;
  fix: string;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

const BRIEF_NAMES = ["creative-brief.yaml", "creative-brief.yml", "creative-brief.json"];

export function planPaths(projectDir: string) {
  return {
    projectDir: join(projectDir, "project"),
    spec: join(projectDir, "project", "video-spec.json"),
    storyboard: join(projectDir, "project", "storyboard.md"),
    contentIr: join(projectDir, "source", "content-ir.json"),
  };
}

async function findBrief(projectDir: string): Promise<{ path: string; text: string } | null> {
  for (const name of BRIEF_NAMES) {
    const path = join(projectDir, "project", name);
    const text = await readIfExists(path);
    if (text !== null) return { path, text };
  }
  return null;
}

async function loadContentIr(path: string): Promise<ContentIR | null> {
  const text = await readIfExists(path);
  if (text === null) return null;
  const r = parseYamlOrJson(ContentIR, text);
  return r.ok ? r.data : null;
}

// ---------------------------------------------------------------- brief_validate

export interface BriefValidationResult {
  ok: boolean;
  brief_path: string;
  errors: PlanIssue[];
  warnings: PlanIssue[];
}

/** Templates whose centrepiece is the product in use; their briefs should carry a product_flow. */
export const PRODUCT_TEMPLATES: ReadonlySet<string> = new Set(["product-demo", "product-ui", "devtool-launch", "product-launch", "product-hero"]);

/** Validate `<project>/project/creative-brief.yaml` (or .yml/.json): schema, then semantic warnings and template fit. */
export async function validateBrief(projectDir: string, templatesDir: string | null): Promise<BriefValidationResult> {
  const found = await findBrief(projectDir);
  if (!found) throw new Error(`no creative brief found: expected ${join(projectDir, "project", BRIEF_NAMES[0]!)}`);
  const result: BriefValidationResult = { ok: false, brief_path: found.path, errors: [], warnings: [] };
  const parsed = parseYamlOrJson(CreativeBrief, found.text);
  if (!parsed.ok) {
    result.errors = parsed.errors.map((e) => ({
      ...e,
      fix: e.message.startsWith("syntax error")
        ? "fix the YAML/JSON syntax at the reported line"
        : `correct ${e.path || "the document"} to match the CreativeBrief schema (schema_get name=creative-brief)`,
    }));
    return result;
  }
  const brief = parsed.data;
  const sem = validateCreativeBriefSemantics(brief);
  result.errors.push(...sem.errors);
  result.warnings.push(...sem.warnings);
  if (brief.tone_preset) {
    const tones = await loadToneRules(findResearchSpecsDir());
    if (tones && !(brief.tone_preset in tones.presets)) {
      result.errors.push({
        path: "tone_preset",
        message: `unknown tone preset "${brief.tone_preset}"`,
        fix: `use one of: ${Object.keys(tones.presets).join(", ")} (research-specs/tones.yaml), and keep free-text direction in tone`,
      });
    }
  }
  if (brief.template && PRODUCT_TEMPLATES.has(brief.template) && !brief.product_flow) {
    result.warnings.push({
      path: "product_flow",
      message: `template "${brief.template}" shows the product in use, but the brief has no product_flow`,
      fix: "add product_flow: the 2–4 steps of using it (entry → key action → result) with evidence refs, and build the centrepiece scenes from them (plan references/product-flow.md)",
    });
  }

  if (brief.template && templatesDir) {
    let tpl: Template | null = null;
    try {
      tpl = await getTemplate(templatesDir, brief.template);
    } catch (err) {
      result.errors.push({
        path: "template",
        message: (err as Error).message,
        fix: "set template to one of the ids from template_list, or remove it",
      });
    }
    if (tpl) {
      if (!tpl.goals.includes(brief.goal)) {
        result.warnings.push({
          path: "template",
          message: `template "${tpl.id}" is meant for goals ${tpl.goals.join(", ")}, not "${brief.goal}"`,
          fix: "pick a template whose goals include the brief's goal (template_list)",
        });
      }
      const { min_sec, max_sec } = tpl.duration_range;
      if (brief.target_duration_sec < min_sec || brief.target_duration_sec > max_sec) {
        result.warnings.push({
          path: "target_duration_sec",
          message: `${brief.target_duration_sec}s is outside template "${tpl.id}" range ${min_sec}–${max_sec}s`,
          fix: `use a duration between ${min_sec} and ${max_sec}s or another template`,
        });
      }
      const chosen = brief.hook_candidates.find((h) => h.text.trim() === brief.chosen_hook.trim());
      if (chosen && !tpl.hook_mechanisms.includes(chosen.mechanism)) {
        result.warnings.push({
          path: "chosen_hook",
          message: `chosen hook uses "${chosen.mechanism}", which template "${tpl.id}" does not list (${tpl.hook_mechanisms.join(", ")})`,
          fix: "consider a hook with a preferred mechanism, or keep it and note why in assumptions",
        });
      }
      checkTemplateInputs(tpl, brief, result);
    }
  }
  result.ok = result.errors.length === 0;
  return result;
}

/**
 * The template's inputs against the brief's answers: a required input with no answer and no default
 * blocks planning; a defaulted one is used but must be surfaced as an assumption.
 */
export function checkTemplateInputs(tpl: Template, brief: CreativeBrief, out: { errors: PlanIssue[]; warnings: PlanIssue[] }): void {
  const answers = brief.inputs ?? {};
  const inputs = tpl.inputs ?? [];
  for (const input of inputs) {
    const answer = answers[input.id]?.trim();
    const path = `inputs.${input.id}`;
    if (!answer) {
      if (!input.required) continue;
      if (input.default === undefined) {
        out.errors.push({
          path,
          message: `template "${tpl.id}" needs input "${input.id}" and the brief has no answer`,
          fix: `ask the user: "${input.prompt}"${input.options ? ` (${input.options.join(" / ")})` : ""}, then set inputs.${input.id} in the brief`,
        });
      } else {
        out.warnings.push({
          path,
          message: `input "${input.id}" was not answered, so the template default "${input.default}" applies`,
          fix: `list it in assumptions ({field: "${path}", value: "${input.default}", reason}) so the user can confirm, or ask: "${input.prompt}"`,
        });
      }
      continue;
    }
    if (input.options && !input.options.includes(answer)) {
      out.warnings.push({
        path,
        message: `answer "${answer}" is not one of the options for "${input.id}" (${input.options.join(", ")})`,
        fix: `use one of: ${input.options.join(", ")}`,
      });
    }
  }
  const known = new Set(inputs.map((i) => i.id));
  for (const id of Object.keys(answers)) {
    if (known.has(id)) continue;
    out.warnings.push({
      path: `inputs.${id}`,
      message: `template "${tpl.id}" has no input "${id}"`,
      fix: known.size ? `use one of the template's input ids (${[...known].join(", ")}) or drop it` : "this template declares no inputs; drop it or keep it as a note",
    });
  }
}

/**
 * The spec's acceptance checks: the template's pacing density fields, overridden field by field by
 * the brief's acceptance. Undefined when neither sets anything (older templates stay unchanged).
 */
export function resolveAcceptance(tpl: Template, brief: CreativeBrief | null): Acceptance | undefined {
  const merged: Acceptance = {
    ...(tpl.pacing.min_changes_per_sec !== undefined ? { min_changes_per_sec: tpl.pacing.min_changes_per_sec } : {}),
    ...(tpl.pacing.max_frozen_pct !== undefined ? { max_frozen_pct: tpl.pacing.max_frozen_pct } : {}),
    ...(brief?.acceptance ?? {}),
  };
  return Object.keys(merged).length ? merged : undefined;
}

export function formatIssues(title: string, r: { ok: boolean; errors: PlanIssue[]; warnings: PlanIssue[] }): string {
  const lines = [`${r.ok ? "VALID" : "INVALID"}: ${title}`];
  for (const e of r.errors) lines.push(`error   ${e.path || "(root)"}: ${e.message}\n        fix: ${e.fix}`);
  for (const w of r.warnings) lines.push(`warning ${w.path || "(root)"}: ${w.message}\n        fix: ${w.fix}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- spec_scaffold

/** Where a scaffolded `motion` scene's page lives, relative to the project folder. */
const motionPage = (sceneId: string) => `motion/${sceneId}.html`;

/** Visual strategies that show real footage (a `footage` block per scene). */
const FOOTAGE_STRATEGIES = new Set<string>(["user_asset", "screen_capture"]);

export interface ScaffoldOptions {
  template_id: string;
  target_duration_sec?: number;
  aspect_ratio?: AspectRatio;
  platform?: Platform;
  /** Platform contract ids; default: the brief's, else the platform's own contract. */
  targets?: string[];
  include_optional?: boolean;
  /** Style pack id (styles/<id>.yaml); default: the template's default_style. */
  style?: string;
  /** Music bed, e.g. `bundled:lofi`; default: the template's default_music. */
  music?: string;
  /** Default: the template's voice_mode (narrated unless the archetype has no speech, or its speech is in the footage). */
  voice_mode?: "narrated" | "none" | "native";
}

export interface SceneGuidance {
  scene_id: string;
  purpose: string;
  duration_sec: number;
  guidance: string;
  /** Maximum voiceover words at the template's pacing. */
  word_budget: number;
  suggested_visual_strategy: string;
  suggested_deterministic_kind?: string;
  /** Minimal valid props for the suggested deterministic kind. */
  props_example?: Record<string, unknown>;
  /** Footage scenes (user_asset / screen_capture): a `footage` block to fill from the ContentIR's video assets. */
  footage_example?: Record<string, unknown>;
}

export interface ScaffoldResult {
  template_id: string;
  spec: VideoSpec;
  scene_guidance: SceneGuidance[];
  rules: string[];
  hook_mechanisms: string[];
  notes: string[];
}

/**
 * Split `total` into parts proportional to `weights`, rounded to 0.1 s, summing exactly to `total`
 * (largest-remainder rounding).
 */
export function allocateDurations(weights: number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const tenths = Math.round(total * 10);
  const raw = weights.map((w) => (w / sum) * tenths);
  const floors = raw.map(Math.floor);
  let rest = tenths - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    floors[i]! += 1;
    rest -= 1;
  }
  return floors.map((t) => t / 10);
}

/** Build (without writing) a skeleton VideoSpec from a template, the project's brief and ContentIR when present. */
export async function scaffoldSpec(projectDir: string, templatesDir: string, opts: ScaffoldOptions): Promise<ScaffoldResult> {
  const tpl = await getTemplate(templatesDir, opts.template_id);
  const notes: string[] = [];
  let brief: CreativeBrief | null = null;
  const found = await findBrief(projectDir);
  if (found) {
    const r = parseYamlOrJson(CreativeBrief, found.text);
    if (r.ok) {
      brief = r.data;
      notes.push(`defaults taken from ${found.path}`);
    } else {
      notes.push(`ignored invalid brief at ${found.path}; run brief_validate`);
    }
  } else {
    notes.push("no creative brief found; using template defaults (fill audience and goal)");
  }
  const ir = await loadContentIr(planPaths(projectDir).contentIr);
  if (!ir) notes.push("no valid source/content-ir.json; claim_refs cannot be suggested");

  const target = opts.target_duration_sec ?? brief?.target_duration_sec ?? tpl.default_duration_sec;
  const platform = opts.platform ?? brief?.platform ?? tpl.platforms[0]!;
  const aspect = opts.aspect_ratio ?? brief?.aspect_ratio ?? tpl.default_aspect_ratio ?? PLATFORM_NORMS[platform].aspect_ratios[0]!;
  const targets = resolveTargets({ platform, targets: opts.targets ?? brief?.targets });
  const { min_sec, max_sec } = tpl.duration_range;
  if (target < min_sec || target > max_sec) notes.push(`target ${target}s is outside template range ${min_sec}–${max_sec}s`);

  const includeOptional = opts.include_optional ?? target >= tpl.default_duration_sec;
  const beats = tpl.beats.filter((b) => includeOptional || !b.optional);
  const dropped = tpl.beats.length - beats.length;
  notes.push(
    "add cover {headline, focal_time_sec}: a short headline (≤ 6 words) and a moment inside the hook scene",
    targets.length
      ? `add publish.<target> {post_caption, hashtags} for ${targets.join(", ")}; post copy is separate from voiceover and captions`
      : "no platform targets: publish copy is optional",
  );
  if (dropped > 0) notes.push(`dropped ${dropped} optional beat(s) because target ${target}s < template default ${tpl.default_duration_sec}s`);
  const durations = allocateDurations(
    beats.map((b) => b.share),
    target,
  );

  const mode = opts.voice_mode ?? tpl.voice_mode ?? "narrated";
  const style = opts.style ?? tpl.default_style;
  // Fail here, not at render time: the error lists the bundled and project style ids.
  if (style) await getStyle(findStylesDir(), style, projectDir);
  const music = opts.music ?? tpl.default_music;
  const footageBeats = beats.some((b) => FOOTAGE_STRATEGIES.has(b.suggested_visual_strategy));
  if (mode === "none") {
    notes.push('voice.mode "none": leave voiceover "" in every scene; put the words on screen (on_screen_text or the props) and keep them short enough to read');
    if (!music && !footageBeats) notes.push('no music bed: add audio.music {file: "bundled:<id>"} or the video is silent');
  }
  if (mode === "native") {
    notes.push('voice.mode "native": leave voiceover "" in every scene; the speech is in the footage and captions come from the asset transcripts (transcribe the video first)');
  }
  // Footage archetypes: each user_asset scene needs footage {asset, in_sec, out_sec?} from the ingested clips.
  const clips = ir?.assets.filter((a) => a.kind === "video" || a.kind === "image") ?? [];
  const sceneAudioMode = mode === "narrated" ? "music" : mode === "none" && music ? "music" : "native";
  if (footageBeats) {
    notes.push(
      clips.length
        ? `footage scenes: fill footage {asset, in_sec, out_sec} for each user_asset scene from the ingested clips (${clips
            .slice(0, 8)
            .map((a) => `${a.id}${a.media?.duration_sec ? ` ${a.media.duration_sec}s` : ""}`)
            .join(", ")})`
        : "footage scenes need ingested video: ingest the clips (video files or a folder of clips) first, then fill footage {asset, in_sec, out_sec} in each user_asset scene",
    );
  }

  const scenes: Scene[] = beats.map((b, i) => {
    const scene: Scene = {
      id: `s${String(i + 1).padStart(2, "0")}`,
      duration_sec: durations[i]!,
      purpose: b.purpose,
      voiceover: "",
      on_screen_text: "",
      visual_strategy: b.suggested_visual_strategy,
      visual_requirements: { continuity_refs: [] },
      claim_refs: [],
    };
    if (b.suggested_deterministic_kind === "motion") {
      // The plan writes the page next to the spec's project folder and fills text[] with every on-screen word.
      scene.deterministic = { kind: "motion", props: { html: motionPage(scene.id), text: [] } };
    } else if (b.suggested_deterministic_kind) scene.deterministic = { kind: b.suggested_deterministic_kind, props: {} };
    if (b.suggested_visual_strategy === "generated_video") scene.visual_requirements = { continuity_refs: [], modality: "video" };
    if (FOOTAGE_STRATEGIES.has(b.suggested_visual_strategy)) scene.audio = { mode: sceneAudioMode };
    return scene;
  });

  const acceptance = resolveAcceptance(tpl, brief);
  if (acceptance) {
    notes.push(
      `acceptance ${JSON.stringify(acceptance)} copied into the spec (${brief?.acceptance ? "the brief's values win over the template's" : "from the template's pacing"}); QA and lint hold the render to it`,
    );
  }
  if (beats.some((b) => b.suggested_deterministic_kind === "motion")) {
    notes.push(
      "motion scenes: write each page at its props.html (see skills/plan/references/code-motion.md), put every on-screen word in props.text, then spec_validate (motion stage) and stills on downbeats before rendering",
    );
  }
  if (music?.startsWith("synth:")) {
    notes.push(`music "${music}" is synthesized locally with an exact beat grid: set audio.beat_sync {enabled: true, snap: "downbeat"} so cuts land on bar starts`);
  }

  const spec: VideoSpec = {
    schema_version: "1.0",
    ...(ir ? { content_ir_id: ir.id } : {}),
    ...(brief?.id ? { brief_id: brief.id } : {}),
    goal: brief?.goal ?? tpl.goals[0]!,
    audience: brief?.audience ?? "TODO: audience",
    platform,
    aspect_ratio: aspect,
    master: acceptance?.loop ? { ...defaultMaster(aspect), loop: true } : defaultMaster(aspect),
    ...(targets.length ? { targets } : {}),
    target_duration_sec: target,
    language: brief?.language ?? "en-US",
    grounding: "strict",
    voice: { ...(mode !== "narrated" ? { mode } : {}), ...(brief?.tone.length ? { style: brief.tone.join(", ") } : {}) },
    // Without speech there are no captions to burn in (native speech is captioned from the transcript).
    captions: { preset: tpl.caption_preset, burn_in: mode !== "none" },
    ...(style ? { style } : {}),
    ...(music ? { audio: { music: { file: music } } } : {}),
    ...(acceptance ? { acceptance } : {}),
    scenes,
  };

  return {
    template_id: tpl.id,
    spec,
    scene_guidance: beats.map((b, i) => ({
      scene_id: scenes[i]!.id,
      purpose: b.purpose,
      duration_sec: durations[i]!,
      guidance: b.guidance,
      // Without narration the budget is on-screen words: ~3 words/s after a 1 s settle (lint's rule).
      // Native speech: the budget is on-screen words too (the spoken words come from the footage).
      word_budget: mode !== "narrated" ? Math.max(3, Math.floor((durations[i]! - 1) * 3)) : Math.floor(durations[i]! * tpl.pacing.max_words_per_sec),
      suggested_visual_strategy: b.suggested_visual_strategy,
      ...(b.suggested_deterministic_kind
        ? {
            suggested_deterministic_kind: b.suggested_deterministic_kind,
            props_example:
              b.suggested_deterministic_kind === "motion"
                ? { ...DETERMINISTIC_PROPS_EXAMPLES.motion, html: motionPage(scenes[i]!.id) }
                : DETERMINISTIC_PROPS_EXAMPLES[b.suggested_deterministic_kind],
          }
        : {}),
      ...(FOOTAGE_STRATEGIES.has(b.suggested_visual_strategy)
        ? {
            footage_example: {
              asset: clips.find((a) => a.kind === "video")?.id ?? clips[0]?.id ?? "<video asset id from source/content-ir.json>",
              in_sec: 0,
              out_sec: durations[i]!,
              fit: "cover",
              ...(b.purpose === "hook" && mode === "native" ? { focus: { x: 0.5, y: 0.35 } } : {}),
            },
          }
        : {}),
    })),
    rules: tpl.rules,
    hook_mechanisms: tpl.hook_mechanisms,
    notes,
  };
}

// ---------------------------------------------------------------- storyboard_render

/** Voiceover pace limits in words per second. */
export const PACE = { max_wps: 3.3, min_wps: 1.5, dead_air_min_sec: 2 } as const;

export interface ScenePace {
  scene_id: string;
  start_sec: number;
  end_sec: number;
  words: number;
  wps: number;
  flag: "too_fast" | "dead_air" | null;
  fix?: string;
}

export interface StoryboardResult {
  storyboard_path: string;
  markdown: string;
  pacing: ScenePace[];
  errors: PlanIssue[];
  warnings: PlanIssue[];
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export function scenePace(scenes: Scene[]): ScenePace[] {
  let t = 0;
  return scenes.map((s) => {
    const start = t;
    t += s.duration_sec;
    const words = countWords(s.voiceover);
    const wps = Math.round((words / s.duration_sec) * 100) / 100;
    const silentEndCard = words === 0 && s.purpose === "end_card";
    let flag: ScenePace["flag"] = null;
    let fix: string | undefined;
    if (wps > PACE.max_wps) {
      flag = "too_fast";
      fix = `cut about ${Math.ceil(words - PACE.max_wps * s.duration_sec)} words or lengthen the scene to ${Math.ceil((words / PACE.max_wps) * 10) / 10}s`;
    } else if (wps < PACE.min_wps && s.duration_sec > PACE.dead_air_min_sec && !silentEndCard) {
      flag = "dead_air";
      fix = `add about ${Math.ceil(PACE.min_wps * s.duration_sec - words)} words or shorten the scene`;
    }
    return { scene_id: s.id, start_sec: round1(start), end_sec: round1(t), words, wps, flag, ...(fix ? { fix } : {}) };
  });
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const cell = (s: string | undefined) => (s && s.trim() ? s.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>") : "—");
const truncate = (s: string, n = 100) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1).trimEnd()}…` : flat;
};

export function renderStoryboardMarkdown(spec: VideoSpec, ir: ContentIR | null): { markdown: string; pacing: ScenePace[]; errors: PlanIssue[]; warnings: PlanIssue[] } {
  const pacing = scenePace(spec.scenes);
  const evidence = new Map(ir?.evidence.map((e) => [e.ref, e.text]) ?? []);
  const claims = new Map(ir?.claims.map((c) => [c.id, c.text]) ?? []);
  const sem = validateVideoSpecSemantics(spec, ir ?? undefined);
  const total = round1(spec.scenes.reduce((a, s) => a + s.duration_sec, 0));

  const claimCell = (refs: string[]) => {
    if (refs.length === 0) return "—";
    return refs
      .map((r) => {
        const text = evidence.get(r) ?? claims.get(r);
        if (text !== undefined) return `\`${r}\`: "${truncate(text)}"`;
        return ir ? `\`${r}\`: (unresolved)` : `\`${r}\``;
      })
      .map(cell)
      .join("<br>");
  };

  const lines: string[] = [];
  lines.push(`# Storyboard: ${spec.title ?? spec.id ?? "untitled"}`, "");
  lines.push("_Generated by storyboard_render from project/video-spec.json. Edit the spec, not this file._", "");
  lines.push(
    `Goal: ${spec.goal} · Audience: ${spec.audience} · Platform: ${spec.platform} (${spec.aspect_ratio}) · Target: ${spec.target_duration_sec}s · Scenes total: ${total}s · Grounding: ${spec.grounding} · Captions: ${spec.captions.preset}`,
    "",
  );
  const master = resolveMaster(spec);
  const targets = resolveTargets(spec);
  lines.push(`Master: ${master.width}×${master.height} @ ${master.fps} fps · Targets: ${targets.join(", ") || "none"}`, "");
  if (spec.cover) lines.push(`Cover: "${spec.cover.headline}" at ${spec.cover.focal_time_sec != null ? `${spec.cover.focal_time_sec}s` : "auto (longest settled hold)"}${spec.cover.bake_first_frame ? ", baked into frame 0" : ""}`, "");
  for (const [id, p] of Object.entries(spec.publish ?? {})) {
    lines.push(`Post (${id}): ${truncate(p.post_caption, 200)}${p.hashtags?.length ? ` ${p.hashtags.join(" ")}` : ""}`, "");
  }
  lines.push("| Scene | Time | Purpose | Voiceover | On-screen text | Visual | Refs |");
  lines.push("|---|---|---|---|---|---|---|");
  spec.scenes.forEach((s, i) => {
    const p = pacing[i]!;
    const offset = s.footage?.av_offset_ms ? ` (sound ${s.footage.av_offset_ms > 0 ? "+" : ""}${s.footage.av_offset_ms} ms)` : "";
    const sfx = s.sfx?.length ? ` · sfx ${s.sfx.map((x) => `${x.file.replace(/^bundled:/, "")}@${x.at_sec}s`).join(", ")}` : "";
    const visual = `${s.deterministic ? `${s.visual_strategy} / ${s.deterministic.kind}` : s.visual_strategy}${offset}${sfx}`;
    // A motion page draws its copy from props.text; show it so the storyboard reads like the reel.
    const motionText = s.deterministic?.kind === "motion" && Array.isArray(s.deterministic.props.text) ? (s.deterministic.props.text as unknown[]).filter((t): t is string => typeof t === "string").join(" / ") : "";
    const onScreen = [s.on_screen_text ?? "", motionText].filter((t) => t.trim()).join(" · ");
    lines.push(
      `| ${s.id} | ${p.start_sec.toFixed(1)}–${p.end_sec.toFixed(1)}s | ${s.purpose} | ${cell(s.voiceover)} | ${cell(onScreen)} | ${visual} | ${claimCell(s.claim_refs)} |`,
    );
  });

  lines.push("", "## Pacing", "");
  lines.push(`Voiceover words per second (flag above ${PACE.max_wps}; below ${PACE.min_wps} on scenes over ${PACE.dead_air_min_sec}s is dead air).`, "");
  lines.push("| Scene | Words | Seconds | WPS | Flag |");
  lines.push("|---|---|---|---|---|");
  for (const p of pacing) {
    lines.push(`| ${p.scene_id} | ${p.words} | ${round1(p.end_sec - p.start_sec)} | ${p.wps} | ${p.flag ? `${p.flag.replace("_", " ")}: ${p.fix}` : "ok"} |`);
  }

  lines.push("", "## Checks", "");
  if (!ir) lines.push("- warning: no valid source/content-ir.json, so claim refs were not resolved.");
  if (sem.errors.length === 0 && sem.warnings.length === 0) lines.push("No semantic errors or warnings.");
  for (const e of sem.errors) lines.push(`- error ${e.path}: ${e.message}. Fix: ${e.fix}.`);
  for (const w of sem.warnings) lines.push(`- warning ${w.path}: ${w.message}. Fix: ${w.fix}.`);
  lines.push("");

  return { markdown: lines.join("\n"), pacing, errors: sem.errors, warnings: sem.warnings };
}

/** Render `<project>/project/storyboard.md` from the project's VideoSpec (and ContentIR when present). */
export async function renderStoryboard(projectDir: string): Promise<StoryboardResult> {
  const paths = planPaths(projectDir);
  const text = await readIfExists(paths.spec);
  if (text === null) throw new Error(`spec file not found: ${paths.spec}`);
  const parsed = parseYamlOrJson(VideoSpec, text);
  if (!parsed.ok) {
    throw new Error(
      `video-spec.json does not match the schema; run spec_validate first. ${parsed.errors
        .slice(0, 5)
        .map((e) => `${e.path || "(root)"}: ${e.message}`)
        .join("; ")}`,
    );
  }
  const ir = await loadContentIr(paths.contentIr);
  const out = renderStoryboardMarkdown(parsed.data, ir);
  await writeFileAtomic(paths.storyboard, out.markdown);
  return { storyboard_path: paths.storyboard, ...out };
}

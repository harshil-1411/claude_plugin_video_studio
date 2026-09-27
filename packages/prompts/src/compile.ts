import type { GenerationMode, ProviderFamily, ProviderModel, ProviderSpec, Scene, ShotCard, VideoSpec } from "@video-studio/schema";
import { type PromptIssue, directorChecks } from "./lint.js";

/**
 * Shot card → one provider family's prompt. Pure and deterministic: the same card, scene, spec
 * and provider spec always give the same text and params. Nothing here generates anything or
 * touches the network; the result is a prompt package a person (or a Phase 7 adapter) uses.
 * Limits and syntax come from the provider spec (provider-specs/<family>.yaml); only phrasing
 * the spec cannot express lives in the family formatters below.
 */

export interface CompileOptions {
  /** Model id from the provider spec; default: the first model that supports the chosen mode. */
  model?: string;
}

export interface CompiledReference {
  /** How the prompt names it, e.g. @Image1. */
  name: string;
  subject: string;
  /** ContentIR asset id. */
  asset: string;
  role: string;
}

export interface CompiledPrompt {
  provider: ProviderFamily;
  model?: string;
  mode: GenerationMode;
  text: string;
  /** Provider-neutral request parameters; a Phase 7 adapter maps them to the API's fields. */
  params: Record<string, unknown>;
  warnings: PromptIssue[];
  /** What the compiler changed to fit the provider (duration snapped, aspect ratio swapped, ...). */
  fixes: string[];
  /** Provider-spec caveats, starting with its verification status. */
  notes: string[];
  verified: boolean;
  verified_on: string;
}

export type SceneLike = Pick<Scene, "id" | "duration_sec">;
export type SpecLike = Pick<VideoSpec, "aspect_ratio">;

/** Where the approved last frame of `sceneId` is expected (a placeholder until it is exported). */
export function lastFramePath(sceneId: string): string {
  return `prompts/frames/${sceneId}-last.png`;
}

// ---------- small text helpers ----------

function clean(s: string): string {
  return s.trim().replace(/\s+/g, " ").replace(/[.;,:\s]+$/, "");
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** One sentence: trimmed, capitalized, ending in a period (unless it already ends in ! ? or a quote). */
export function sentence(s: string | undefined): string {
  const c = clean(s ?? "");
  if (!c) return "";
  return /[!?"'”]$/.test(c) ? capitalize(c) : `${capitalize(c)}.`;
}

function joinText(parts: readonly (string | undefined)[], sep = " "): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join(sep);
}

function unquote(s: string): string {
  return s.trim().replace(/\s+/g, " ").replace(/^["'“”]+|["'“”]+$/g, "").trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LOCKED = /^(locked|locked[- ]off|static|still|fixed|no movement)( camera| shot)?$/i;

export function isLockedCamera(camera: string): boolean {
  return LOCKED.test(clean(camera));
}

// ---------- limits ----------

/** Fit a duration to the provider: nearest allowed step (ties go up), else clamp and round to whole seconds. */
export function fitDuration(sec: number, d: ProviderSpec["duration"]): number {
  if (d.allowed_sec?.length) {
    const steps = [...d.allowed_sec].sort((a, b) => a - b);
    let best = steps[0]!;
    for (const v of steps) if (Math.abs(v - sec) <= Math.abs(best - sec)) best = v;
    return best;
  }
  return Math.min(d.max_sec, Math.max(d.min_sec, Math.round(Math.min(d.max_sec, Math.max(d.min_sec, sec)))));
}

function ratioValue(r: string): number {
  const [w, h] = r.split(":").map(Number);
  return w! / h!;
}

/** The supported ratio closest in shape (log distance; the first listed wins a tie). */
export function nearestAspect(ratio: string, supported: readonly string[]): string {
  if (supported.includes(ratio)) return ratio;
  const v = ratioValue(ratio);
  let best = supported[0]!;
  for (const r of supported) if (Math.abs(Math.log(ratioValue(r) / v)) < Math.abs(Math.log(ratioValue(best) / v))) best = r;
  return best;
}

/** Draft-grade default: the smallest listed resolution of at least 720 lines, else the largest. */
function defaultResolution(ps: ProviderSpec): string | undefined {
  const r = ps.resolutions ?? [];
  const lines = (x: string) => (/^(\d+)p$/i.test(x) ? Number(x.slice(0, -1)) : /^(\d+)k$/i.test(x) ? Number(x.slice(0, -1)) * 540 : 0);
  const sorted = [...r].sort((a, b) => lines(a) - lines(b));
  return sorted.find((x) => lines(x) >= 720) ?? sorted.at(-1);
}

// ---------- exclusions ----------

function stripNegation(s: string): string {
  return clean(s).replace(/^(no|not|don't|do not|never|without|avoid)\s+/i, "");
}

/** Positive rewrites for providers that misread negatives (runway). */
const POSITIVE: readonly [RegExp, string][] = [
  [/camera (movement|motion|moves?)|moving camera/i, "The camera remains still."],
  [/handheld|shak(e|y|ing)|jitter/i, "Smooth, steady camera movement."],
  [/\b(text|logos?|letters|lettering|captions?|subtitles?|watermarks?|signage|words)\b/i, "Surfaces are plain and free of lettering."],
  [/\bcuts?\b|scene changes?|\bedits?\b/i, "One continuous take."],
  [/\b(extra|other|additional|more) (people|characters|persons|figures)\b|\bcrowds?\b/i, "Only the described subjects are in frame."],
  [/\bblur(ry)?\b|out of focus/i, "Crisp, sharp focus throughout."],
  [/\bmorph(ing)?\b|distort(ed|ion)?|warp(ed|ing)?/i, "Faces, hands and shapes stay stable and natural."],
];

// ---------- audio ----------

function hasAudio(card: ShotCard): boolean {
  const a = card.audio;
  return Boolean(a && ((a.dialogue?.length ?? 0) > 0 || (a.sfx?.length ?? 0) > 0 || a.ambience?.trim() || a.music?.trim()));
}

interface AudioStyle {
  line: (speaker: string, line: string) => string;
  sfx: (list: string[]) => string;
  ambience: (s: string) => string;
  music: (s: string) => string;
}

const PLAIN_AUDIO: AudioStyle = {
  line: (sp, l) => `Dialogue: ${sp} says "${l}"`,
  sfx: (l) => sentence(`Sound effects: ${l.map(clean).join(", ")}`),
  ambience: (s) => sentence(`Ambience: ${s}`),
  music: (s) => sentence(`Music: ${s}`),
};

function audioText(card: ShotCard, style: AudioStyle): string {
  const a = card.audio;
  if (!a) return "";
  return joinText([
    ...(a.dialogue ?? []).map((d) => style.line(d.speaker, unquote(d.line))),
    a.sfx?.length ? style.sfx(a.sfx) : "",
    a.ambience?.trim() ? style.ambience(a.ambience) : "",
    a.music?.trim() ? style.music(a.music) : "",
  ]);
}

// ---------- family formatting ----------

interface Ctx {
  card: ShotCard;
  ps: ProviderSpec;
  model: ProviderModel;
  mode: GenerationMode;
  refs: CompiledReference[];
  locked: boolean;
  /** Positive sentences replacing exclusions (positive_only providers). */
  positives: string[];
  warnings: PromptIssue[];
  fixes: string[];
}

/** The action with each bound subject's reference name after its first mention. */
function actionWithRefs(ctx: Ctx): string {
  let text = clean(ctx.card.action);
  for (const r of ctx.refs) {
    const re = new RegExp(`\\b${escapeRe(r.subject)}\\b`, "i");
    if (re.test(text)) text = text.replace(re, (m) => `${m} (${r.name})`);
  }
  return sentence(text);
}

function refLines(ctx: Ctx): string {
  return joinText(ctx.refs.map((r) => sentence(`${r.name} is ${r.subject} (${clean(r.role)})`)));
}

function continuityText(card: ShotCard): string {
  return joinText([
    card.continuity?.length ? sentence(`Keep identical to the previous shot: ${card.continuity.map(clean).join(", ")}`) : "",
    card.end_state?.trim() ? sentence(`The shot ends on ${clean(card.end_state)}`) : "",
  ]);
}

/** image_to_video: the frame already shows the scene, so some providers want motion only. */
function motionOnly(ctx: Ctx): boolean {
  return ctx.mode === "image_to_video" && (ctx.ps.id === "runway" || ctx.ps.id === "wan");
}

function sceneText(ctx: Ctx): string {
  if (motionOnly(ctx)) {
    if (ctx.card.environment || ctx.card.look) ctx.fixes.push(`${ctx.ps.id} image-to-video: environment and look left out (the first frame shows them); the prompt describes motion and camera only`);
    return "";
  }
  return joinText([sentence(ctx.card.environment), sentence(ctx.card.look)]);
}

function isSeedance25(model: ProviderModel): boolean {
  return /2[.-]5/.test(model.id);
}

type Formatter = (ctx: Ctx) => { text: string; params?: Record<string, unknown> };

const FORMATTERS: Record<ProviderFamily, Formatter> = {
  // subject + action first, then scene, style, camera and audio; name each reference and its role.
  seedance: (ctx) => {
    const camera = ctx.locked ? "Static camera." : sentence(`Camera: ${ctx.card.camera}`);
    const audio = isSeedance25(ctx.model)
      ? audioText(ctx.card, {
          line: (sp, l) => `{${sp}: ${l}}`,
          sfx: (l) => l.map((s) => `<${clean(s)}>`).join(" "),
          ambience: (s) => `(${clean(s)})`,
          music: (s) => `(${clean(s)})`,
        })
      : audioText(ctx.card, PLAIN_AUDIO);
    return { text: joinText([actionWithRefs(ctx), sceneText(ctx), camera, audio, continuityText(ctx.card), refLines(ctx)]) };
  },
  // cinematography + subject + action + context + style & ambiance; dialogue in quotes, SFX:, Ambient noise:.
  veo: (ctx) => {
    const camera = ctx.locked ? "Static locked-off shot." : sentence(ctx.card.camera);
    const audio = audioText(ctx.card, {
      line: (sp, l) => `${capitalize(sp)} says, "${l}"`,
      sfx: (l) => sentence(`SFX: ${l.map(clean).join(", ")}`),
      ambience: (s) => sentence(`Ambient noise: ${s}`),
      music: (s) => sentence(`Music: ${s}`),
    });
    return { text: joinText([camera, actionWithRefs(ctx), sceneText(ctx), audio, continuityText(ctx.card), refLines(ctx)]) };
  },
  // A labelled shot (framing/motion first), a direction not an object list, speech after the action.
  kling: (ctx) => {
    const camera = ctx.locked ? "Locked-off static shot." : sentence(`Camera: ${ctx.card.camera}`);
    const audio = audioText(ctx.card, {
      line: (sp, l) => `Then ${sp} says: "${l}"`,
      sfx: (l) => sentence(`Sound: ${l.map(clean).join(", ")}`),
      ambience: (s) => sentence(`Ambience: ${s}`),
      music: (s) => sentence(`Music: ${s}`),
    });
    return { text: joinText([camera, actionWithRefs(ctx), sceneText(ctx), audio, continuityText(ctx.card), refLines(ctx)]), params: { cfg_scale: 0.5 } };
  },
  // entity + scene + motion, then aesthetics; sound as voice / SFX / BGM.
  wan: (ctx) => {
    const camera = ctx.locked ? "The camera stays still." : sentence(`Camera: ${ctx.card.camera}`);
    const audio = audioText(ctx.card, {
      line: (sp, l) => `Voice: ${sp} says "${l}"`,
      sfx: (l) => sentence(`Sound effects: ${l.map(clean).join(", ")}`),
      ambience: (s) => sentence(`Ambient sound: ${s}`),
      music: (s) => sentence(`Background music: ${s}`),
    });
    const scene = motionOnly(ctx) ? sceneText(ctx) : joinText([sentence(ctx.card.environment), camera, sentence(ctx.card.look)]);
    return { text: joinText([actionWithRefs(ctx), scene, motionOnly(ctx) ? camera : "", audio, continuityText(ctx.card), refLines(ctx)]) };
  },
  // [Camera] shot of [subject] [action] in [environment]. [Details]; positive phrasing only.
  runway: (ctx) => {
    const camera = ctx.locked ? "Locked camera. The camera remains still." : sentence(`${clean(ctx.card.camera)} shot`);
    return { text: joinText([camera, actionWithRefs(ctx), sceneText(ctx), continuityText(ctx.card), ...ctx.positives]) };
  },
  // Bracketed camera command first, then subject + action + scene + style.
  hailuo: (ctx) => {
    const cmd = hailuoCamera(ctx);
    return { text: joinText([cmd, actionWithRefs(ctx), sceneText(ctx), continuityText(ctx.card)]), params: { prompt_optimizer: false } };
  },
};

const CAMERA_SYNONYMS: readonly [RegExp, string][] = [
  [/\b(dolly|move|push(es|ing)?)[- ]?(in|forward)\b/i, "push in"],
  [/\b(dolly|move)[- ]?(out|back)\b|\bpull(s|ing)?[- ]?back\b/i, "pull out"],
  [/\b(crane|boom|jib)[- ]?up\b/i, "pedestal up"],
  [/\b(crane|boom|jib)[- ]?down\b/i, "pedestal down"],
  [/\bfollow(s|ing)?\b|\btracking\b/i, "tracking shot"],
  [/\bhandheld\b|\bshak(y|e)\b/i, "shake"],
];

/** The camera move as the provider's bracketed commands (commands parsed from `camera_syntax`). */
function hailuoCamera(ctx: Ctx): string {
  const commands = [...(ctx.ps.camera_syntax ?? "").matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]!.trim());
  if (!commands.length) return sentence(`Camera: ${ctx.card.camera}`);
  const locked = commands.find((c) => /static/i.test(c));
  if (ctx.locked && locked) return `[${locked}]`;
  let text = ` ${clean(ctx.card.camera).toLowerCase()} `;
  for (const [re, canonical] of CAMERA_SYNONYMS) text = text.replace(re, canonical);
  const hits = commands
    .map((c) => ({ c, at: text.indexOf(` ${c.toLowerCase()} `) >= 0 ? text.indexOf(` ${c.toLowerCase()} `) : text.indexOf(c.toLowerCase()) }))
    .filter((h) => h.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((h) => h.c)
    .filter((c, i, all) => all.indexOf(c) === i);
  if (!hits.length) {
    ctx.warnings.push({
      code: "camera_unmapped",
      path: "shot.camera",
      message: `"${ctx.card.camera}" matches none of ${ctx.ps.name}'s camera commands; it is written as plain text`,
      fix: `use one of ${commands.map((c) => `[${c}]`).join(" ")}`,
    });
    return sentence(`Camera: ${ctx.card.camera}`);
  }
  return `[${hits.join(",")}]`;
}

// ---------- compile ----------

function pickModel(ps: ProviderSpec, mode: GenerationMode, requested?: ProviderModel): ProviderModel | undefined {
  return (requested ? [requested] : ps.models).find((m) => m.modes.includes(mode));
}

/** Compile one shot card for one provider family. */
export function compile(card: ShotCard, scene: SceneLike, spec: SpecLike, ps: ProviderSpec, opts: CompileOptions = {}): CompiledPrompt {
  const warnings: PromptIssue[] = [...directorChecks(card)];
  const fixes: string[] = [];

  // Duration.
  const duration = fitDuration(scene.duration_sec, ps.duration);
  if (duration !== scene.duration_sec) {
    const d = ps.duration;
    const range = d.allowed_sec?.length ? d.allowed_sec.join(", ") + " s" : `${d.min_sec}-${d.max_sec} s`;
    warnings.push({
      code: "duration",
      path: "duration_sec",
      message: `${ps.name} takes ${range}; ${scene.duration_sec}s compiles as ${duration}s`,
      fix: scene.duration_sec > d.max_sec ? `split the scene into shots of at most ${d.max_sec}s (chain them with first_frame_from)` : `trim or hold in the edit, or set duration_sec to ${duration}`,
    });
    fixes.push(`duration ${scene.duration_sec}s → ${duration}s`);
  }

  // Model and mode.
  let requested: ProviderModel | undefined;
  if (opts.model) {
    requested = ps.models.find((m) => m.id === opts.model);
    if (!requested) warnings.push({ code: "model_unknown", path: "model", message: `${ps.name} has no model "${opts.model}"`, fix: `use one of ${ps.models.map((m) => m.id).join(", ")}` });
  }
  const bound = (card.subjects ?? []).filter((s): s is typeof s & { asset: string } => Boolean(s.asset));
  const refLimit = ps.references ? (ps.references.max_images ?? 0) + (ps.references.max_videos ?? 0) : 0;
  const firstFrame = card.first_frame_from ? lastFramePath(card.first_frame_from) : undefined;
  let mode: GenerationMode = firstFrame ? "image_to_video" : bound.length && refLimit > 0 ? "reference_to_video" : "text_to_video";
  let model = pickModel(ps, mode, requested);
  if (!model && mode !== "text_to_video") {
    warnings.push({
      code: "mode_unsupported",
      path: firstFrame ? "shot.first_frame_from" : "shot.subjects",
      message: `${requested ? requested.id : ps.name} has no ${mode}; compiled as text_to_video${firstFrame ? " (the shot is not chained to the previous frame)" : ""}`,
      fix: requested ? `use a model with ${mode}: ${ps.models.filter((m) => m.modes.includes(mode)).map((m) => m.id).join(", ") || "(none)"}` : "describe the continuity in words, or pick another provider for this shot",
    });
    mode = "text_to_video";
    model = pickModel(ps, mode, requested);
  }
  if (!model) {
    model = requested ?? ps.models[0]!;
    warnings.push({ code: "mode_unsupported", path: "model", message: `${model.id} needs one of ${model.modes.join(", ")}; this shot has no first frame or references`, fix: "set first_frame_from, or pick a text-to-video model" });
    mode = model.modes[0]!;
  }

  // References.
  let refs: CompiledReference[] = [];
  if (bound.length) {
    if (refLimit === 0) {
      warnings.push({
        code: "cast_unbound",
        path: "shot.subjects",
        message: `${ps.name} cannot bind subject references (${bound.map((s) => s.id).join(", ")})`,
        fix: "chain the shot from an approved identity keyframe (first_frame_from) and describe the subjects in words",
      });
    } else if (mode !== "reference_to_video") {
      if (!firstFrame) warnings.push({ code: "cast_unbound", path: "shot.subjects", message: `references are not sent in ${mode}`, fix: "identity comes from the prompt text; bind references with a reference-to-video model" });
    } else {
      if (bound.length > refLimit) {
        warnings.push({
          code: "cast_limit",
          path: "shot.subjects",
          message: `${bound.length} bound subjects; ${ps.name} takes at most ${refLimit} references`,
          fix: `keep the ${refLimit} that matter most in this shot; ${bound.slice(refLimit).map((s) => s.id).join(", ")} dropped`,
        });
        fixes.push(`references cut to ${refLimit}`);
      }
      const syntax = ps.references!.syntax;
      refs = bound.slice(0, refLimit).map((s, i) => ({ name: syntax.includes("{n}") ? syntax.replaceAll("{n}", String(i + 1)) : `${syntax} ${i + 1}`, subject: s.id, asset: s.asset, role: s.role }));
    }
  }

  // Aspect ratio.
  let aspect: string = nearestAspect(spec.aspect_ratio, ps.aspect_ratios);
  if (ps.id === "runway" && mode === "text_to_video" && aspect !== "16:9") aspect = "16:9"; // Runway text-to-video is 16:9 only.
  if (aspect !== spec.aspect_ratio) {
    warnings.push({
      code: "aspect_ratio",
      path: "aspect_ratio",
      message: `${ps.name}${ps.id === "runway" && mode === "text_to_video" ? " text-to-video" : ""} does not offer ${spec.aspect_ratio}; compiled as ${aspect}`,
      fix: `reframe ${aspect} → ${spec.aspect_ratio} in the edit (crop or pad), or pick a provider with ${spec.aspect_ratio}`,
    });
    fixes.push(`aspect ratio ${spec.aspect_ratio} → ${aspect}`);
  }
  const resolution = defaultResolution(ps);
  if (ps.id === "veo" && refs.length && duration !== 8) warnings.push({ code: "duration", path: "duration_sec", message: "Veo reference images force 8 s clips", fix: "set duration_sec to 8 or drop the references" });

  // Audio.
  const audio = hasAudio(card);
  if (audio && !ps.audio.native) {
    warnings.push({ code: "audio_not_native", path: "shot.audio", message: `${ps.name} generates no sound`, fix: "add the dialogue, sound effects and music in the edit (scene audio and sfx)" });
  }

  // Exclusions.
  const exclusions = (card.exclusions ?? []).map(clean).filter(Boolean);
  const postText = (card.on_screen_text ?? "post") === "post";
  let negative: string | undefined;
  const positives: string[] = [];
  if (ps.negatives === "supported") {
    const items = [...exclusions.map(stripNegation), ...(postText ? ["on-screen text", "logos", "watermarks"] : [])];
    negative = [...new Set(items.filter(Boolean))].join(", ") || undefined;
  } else if (ps.negatives === "positive_only") {
    for (const ex of exclusions) {
      const hit = POSITIVE.find(([re]) => re.test(ex));
      if (hit && isLockedCamera(card.camera) && /camera/.test(hit[1])) {
        fixes.push(`exclusion "${ex}" covered by the locked camera`);
      } else if (hit) {
        if (!positives.includes(hit[1])) positives.push(hit[1]);
        fixes.push(`exclusion "${ex}" rephrased positively: "${hit[1]}"`);
      } else {
        warnings.push({ code: "exclusion_dropped", path: "shot.exclusions", message: `${ps.name} needs positive phrasing; "${ex}" has no positive rewrite and was left out`, fix: "describe the state you want instead (e.g. \"the camera remains still\")" });
      }
    }
  } else if (exclusions.length) {
    warnings.push({ code: "exclusion_dropped", path: "shot.exclusions", message: `${ps.name} takes no negative prompt; ${exclusions.length} exclusion(s) left out`, fix: "describe the wanted state positively in the action or look" });
  }

  const ctx: Ctx = { card, ps, model, mode, refs, locked: isLockedCamera(card.camera), positives, warnings, fixes };
  const formatted = FORMATTERS[ps.id](ctx);
  const text = formatted.text;
  if (ps.prompt_max_chars && text.length > ps.prompt_max_chars) {
    warnings.push({ code: "prompt_too_long", path: "shot", message: `prompt is ${text.length} characters; ${ps.name} takes at most ${ps.prompt_max_chars}`, fix: "shorten the environment and look" });
  }

  const params: Record<string, unknown> = {
    model: model.id,
    mode,
    duration_sec: duration,
    aspect_ratio: aspect,
    ...(resolution ? { resolution } : {}),
    ...(ps.audio.native ? { audio: audio } : {}),
    ...(negative ? { negative_prompt: negative } : {}),
    ...(firstFrame && mode === "image_to_video" ? { first_frame: firstFrame } : {}),
    ...(refs.length ? { references: refs } : {}),
    ...formatted.params,
  };
  if (firstFrame && mode === "image_to_video") fixes.push(`first frame: ${firstFrame} (placeholder: export ${card.first_frame_from}'s approved last frame there)`);

  const notes = [
    ps.verified
      ? `provider spec verified on ${ps.verified_on}`
      : `unverified provider spec (verified: false, read ${ps.verified_on}): re-check the live docs before generating`,
    ...(ps.notes ?? []),
    ...(model.notes ?? []).map((n) => `${model.id}: ${n}`),
  ];
  return { provider: ps.id, model: model.id, mode, text, params, warnings, fixes, notes, verified: ps.verified, verified_on: ps.verified_on };
}

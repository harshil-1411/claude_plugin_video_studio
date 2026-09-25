import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { projectPaths, readJson, writeFileAtomic, writeJsonAtomic } from "@video-studio/core";
import { type LayoutZones, type PxRect, type TargetMask, findPlatformSpecsDir, intersect, layoutZones, loadContracts, maskCollisions } from "@video-studio/platforms";
import {
  Brand,
  type PlatformContract,
  type PxBox,
  type TextBox,
  type TextRole,
  VideoSpec,
  parseYamlOrJson,
  resolveMaster,
  resolveTargets,
} from "@video-studio/schema";
import { projectSpecPaths } from "./spec-validate.js";

/**
 * Platform lint: checks a planned (and ideally rendered) project against the contracts of its
 * targets and the design rules. Read-only apart from `qa/lint.{json,md}`. Every finding carries
 * an actionable `fix` that the lint skill applies to the spec before re-rendering.
 *
 * Platform numbers come only from the contracts (`platform-specs/*.yaml`); the constants below
 * are video-studio design rules, not platform facts.
 */

/** Words per second above which captions get hard to read (design rule). */
export const MAX_WORDS_PER_SEC = 3.3;
/** WCAG 2.x contrast minimums (AA): normal text and large text. */
export const CONTRAST_NORMAL = 4.5;
export const CONTRAST_LARGE = 3;
/**
 * "Large text" is 24 px CSS (18 pt) on a ~533 px-tall phone viewport, i.e. about 4.5% of the
 * frame height once a 9:16 video fills the screen; applied to every aspect as an approximation.
 */
export const LARGE_TEXT_FRACTION = 0.045;
/** Cover headlines longer than this are hard to read in a grid thumbnail (design rule). */
export const COVER_HEADLINE_MAX_WORDS = 7;
export const COVER_HEADLINE_MAX_CHARS = 40;

/** Roles whose overflow or low contrast is an error (v2 design grid: hard failure for hook/caption). */
const CRITICAL_ROLES: ReadonlySet<TextRole> = new Set(["hook", "headline", "caption", "cta"]);

export type LintSeverity = "error" | "warning";
export type LintQuality = "preview" | "final";

export interface LintFinding {
  id: string;
  severity: LintSeverity;
  target?: string;
  scene_id?: string;
  message: string;
  fix: string;
}

export interface LintResult {
  status: "pass" | "warn" | "fail";
  quality: LintQuality;
  targets: string[];
  /** Whether a render of `quality` was found (text boxes, render duration and caption box checked). */
  rendered: boolean;
  counts: { errors: number; warnings: number };
  findings: LintFinding[];
  report_json: string;
  report_md: string;
}

export interface LintOptions {
  quality?: LintQuality;
  /** platform-specs directory (tests); default: the bundled one. */
  specsDir?: string | null;
}

/** The parts of renders/<quality>/render-state.json lint reads (written by the pipeline). */
interface RenderStateView {
  quality?: LintQuality;
  target?: { width: number; height: number; fps: number; aspect_ratio: string };
  duration_ms?: number;
  burn_in?: boolean;
  scenes?: Array<{ scene_id: string; text_boxes?: TextBox[] }>;
  captions?: { box?: PxBox };
  cover?: { headline_box?: TextBox; crops?: Array<{ id: string; targets: string[]; x: number; y: number; w: number; h: number }> };
}

/** A compiled cover's headline and the crops it must survive (from render-state or the manifest). */
interface CoverView {
  headline_box?: TextBox;
  crops: Array<{ id: string; targets: string[]; rect: PxBox }>;
}

/** The parts of dist/render-manifest.json lint reads. */
interface ManifestView {
  settings?: { quality?: LintQuality; width?: number; height?: number };
  captions?: { burn_in?: boolean; box?: PxBox };
  renders?: Array<{ scene_id: string; text_boxes?: TextBox[] }>;
  cover?: CoverView;
}

// ------------------------------------------------------------------------------------ helpers

const round2 = (n: number) => Math.round(n * 100) / 100;

async function readOptionalJson<T>(path: string): Promise<T | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return await readJson<T>(path);
  } catch {
    return undefined;
  }
}

async function loadBrand(root: string): Promise<Brand | undefined> {
  for (const p of [join(root, "brand.yaml"), join(root, "project", "brand.yaml")]) {
    if (!existsSync(p)) continue;
    const parsed = parseYamlOrJson(Brand, await readFile(p, "utf8"));
    if (!parsed.ok) throw new Error(`invalid brand file ${p}: ${parsed.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
    return parsed.data;
  }
  return undefined;
}

/** sRGB relative luminance of `#RRGGBB` (WCAG 2.x). */
export function relativeLuminance(hex: string): number {
  const h = hex.replace(/^#/, "");
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two `#RRGGBB` colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const wordCount = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** Every string inside a props value (deterministic scene props are an open record). */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

function snippet(text: string, max = 40): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

// ------------------------------------------------------------------------------------ checks

function checkEnvelope(spec: VideoSpec, contracts: readonly PlatformContract[], state: RenderStateView | undefined, out: LintFinding[]): void {
  const master = resolveMaster(spec);
  const specTotal = round2(spec.scenes.reduce((a, s) => a + s.duration_sec, 0));
  const renderTotal = state?.duration_ms !== undefined ? round2(state.duration_ms / 1000) : undefined;
  for (const c of contracts) {
    const v = c.video;
    const target = c.id;
    if (!v.aspect_ratios.includes(spec.aspect_ratio)) {
      out.push({
        id: "envelope_aspect",
        severity: "error",
        target,
        message: `${c.name} accepts ${v.aspect_ratios.join(", ")}, but the spec is ${spec.aspect_ratio}`,
        fix: `set aspect_ratio to ${v.aspect_ratios[0]} (and master to match) or remove "${target}" from targets`,
      });
    }
    const { min, max } = v.duration_sec;
    for (const [label, total] of [["spec", specTotal], ["render", renderTotal]] as const) {
      if (total === undefined) continue;
      if (max !== undefined && total > max) {
        out.push({
          id: "envelope_duration",
          severity: "error",
          target,
          message: `${label} duration ${total}s is longer than ${c.name}'s ${max}s limit`,
          fix: `shorten scenes (duration_sec and voiceover) so the video totals at most ${max}s, or remove "${target}" from targets`,
        });
      }
      if (min !== undefined && total < min) {
        out.push({
          id: "envelope_duration",
          severity: "error",
          target,
          message: `${label} duration ${total}s is shorter than ${c.name}'s ${min}s minimum`,
          fix: `lengthen scenes so the video lasts at least ${min}s`,
        });
      }
    }
    if (v.fps && ((v.fps.min !== undefined && master.fps < v.fps.min) || (v.fps.max !== undefined && master.fps > v.fps.max))) {
      out.push({
        id: "envelope_fps",
        severity: "error",
        target,
        message: `master fps ${master.fps} is outside ${c.name}'s ${v.fps.min ?? "?"}–${v.fps.max ?? "?"} fps`,
        fix: `set master.fps to a value in ${v.fps.min ?? 1}–${v.fps.max ?? 60} (24, 30 or 60)`,
      });
    }
    if (v.min && (master.width < v.min.width || master.height < v.min.height)) {
      out.push({
        id: "envelope_size",
        severity: "error",
        target,
        message: `master ${master.width}x${master.height} is smaller than ${c.name}'s minimum ${v.min.width}x${v.min.height}`,
        fix: `set master to ${v.recommended.width}x${v.recommended.height} (or remove master for the default)`,
      });
    }
    if (v.max_long_side && Math.max(master.width, master.height) > v.max_long_side) {
      out.push({
        id: "envelope_size",
        severity: "error",
        target,
        message: `master ${master.width}x${master.height} exceeds ${c.name}'s ${v.max_long_side}px long side`,
        fix: `set master to ${v.recommended.width}x${v.recommended.height}`,
      });
    }
    if (!c.ui_masks.some((m) => m.aspect_ratio === spec.aspect_ratio)) {
      out.push({
        id: "masks_unknown",
        severity: "warning",
        target,
        message: `${c.name} has no UI masks for ${spec.aspect_ratio}; captions and text were not checked against its UI`,
        fix: `check a ${spec.aspect_ratio} frame on ${c.name} by eye, or add ui_masks to platform-specs/${target}.yaml`,
      });
    }
  }
}

function sceneBoxes(state: RenderStateView | undefined, manifest: ManifestView | undefined): Array<{ scene_id: string; box: TextBox }> {
  const src = state?.scenes?.some((s) => s.text_boxes?.length) ? state.scenes : manifest?.renders;
  return (src ?? []).flatMap((s) => (s.text_boxes ?? []).map((box) => ({ scene_id: s.scene_id, box })));
}

function checkOverflow(boxes: Array<{ scene_id: string; box: TextBox }>, out: LintFinding[]): void {
  for (const { scene_id, box } of boxes) {
    if (!box.truncated) continue;
    out.push({
      id: "text_overflow",
      severity: CRITICAL_ROLES.has(box.role) ? "error" : "warning",
      scene_id,
      message: `${box.role} text "${snippet(box.text)}" does not fit its box at the minimum size and is cut off`,
      fix: `shorten that text in scene ${scene_id} (deterministic.props) to about two thirds of its length, or split it across two scenes`,
    });
  }
}

function checkTextMasks(boxes: Array<{ scene_id: string; box: TextBox }>, masks: readonly TargetMask[], W: number, H: number, out: LintFinding[]): void {
  for (const { scene_id, box } of boxes) {
    for (const [target, hits] of byTarget(maskCollisions(box.rect, masks, W, H).map((h) => h.mask))) {
      out.push({
        id: "text_mask",
        severity: box.role === "decorative" ? "warning" : worst(hits),
        target,
        scene_id,
        message: `${box.role} text "${snippet(box.text)}" sits under ${target}'s ${hits.map((m) => m.label).join("; ")}`,
        fix: `re-render so the layout uses the target zones (remove any manual positions), or shorten the text in scene ${scene_id} so it fits the content zone`,
      });
    }
  }
}

/** Top edge (px) of a caption block of height `h` centred at `y` × `H`. */
const captionTop = (y: number, h: number, H: number) => Math.round(y * H - h / 2);

/**
 * Nearest caption centres (fractions of the height, 2 decimals) above and below `cy` at which a
 * box of `box.w`×`box.h` at `box.x` overlaps no error mask; undefined when there is none.
 */
function freeCentres(box: PxRect, cy: number, masks: readonly TargetMask[], W: number, H: number): { up?: number; down?: number } {
  const errors = masks.filter((m) => m.severity === "error");
  const clear = (y: number) => {
    const top = captionTop(y, box.h, H);
    return top >= 0 && top + box.h <= H && maskCollisions({ ...box, y: top }, errors, W, H).length === 0;
  };
  const start = Math.round((cy / H) * 100);
  let up: number | undefined;
  let down: number | undefined;
  for (let p = start; p >= 0 && up === undefined; p--) if (clear(p / 100)) up = p / 100;
  for (let p = start; p <= 100 && down === undefined; p++) if (clear(p / 100)) down = p / 100;
  return { ...(up !== undefined ? { up } : {}), ...(down !== undefined ? { down } : {}) };
}

function checkCaptions(
  spec: VideoSpec,
  zones: LayoutZones,
  manifestBox: PxBox | undefined,
  burnIn: boolean,
  out: LintFinding[],
): void {
  if (!burnIn) return;
  const { width: W, height: H, masks } = zones;
  const position = spec.captions.position;
  let box: PxRect;
  let source: string;
  if (manifestBox) {
    box = manifestBox;
    source = "rendered captions";
  } else if (position) {
    const h = zones.caption.h;
    box = { x: zones.caption.x, y: captionTop(position.y, h, H), w: zones.caption.w, h };
    source = `captions.position.y ${position.y}`;
  } else {
    box = zones.caption;
    source = "the caption zone";
  }
  for (const [target, hits] of byTarget(maskCollisions(box, masks, W, H).map((h) => h.mask))) {
    let fix: string;
    if (position) {
      const cy = position.y * H;
      const { up, down } = freeCentres(box, cy, masks, W, H);
      const pick = up !== undefined && (down === undefined || position.y - up <= down - position.y) ? `set y ≤ ${up}` : down !== undefined ? `set y ≥ ${down}` : undefined;
      fix = pick ? `remove captions.position (auto placement in the caption zone) or ${pick}` : "remove captions.position (auto placement in the caption zone)";
    } else if (manifestBox) {
      fix = "remove captions.position if set and re-render so the caption engine places captions in the targets' caption zone; if it persists, shorten voiceover phrases so captions fit in fewer lines";
    } else {
      fix = `the design caption zone collides with ${target}'s UI: drop a target that shares this aspect ratio or set captions.position.y into a free band`;
    }
    out.push({
      id: "caption_mask",
      severity: worst(hits),
      target,
      message: `captions (${source}, y ${box.y}–${box.y + box.h}px of ${H}) overlap ${target}'s ${hits.map((m) => m.label).join("; ")}`,
      fix,
    });
  }
}

/** Masks grouped by target, in first-seen order. */
function byTarget(masks: readonly TargetMask[]): Map<string, TargetMask[]> {
  const out = new Map<string, TargetMask[]>();
  for (const m of masks) out.set(m.target, [...(out.get(m.target) ?? []), m]);
  return out;
}

const worst = (masks: readonly TargetMask[]): LintSeverity => (masks.some((m) => m.severity === "error") ? "error" : "warning");

function checkContrast(boxes: Array<{ scene_id: string; box: TextBox }>, H: number, out: LintFinding[]): void {
  for (const { scene_id, box } of boxes) {
    if (!box.color || !box.background) continue;
    const large = box.font_px >= LARGE_TEXT_FRACTION * H;
    const need = large ? CONTRAST_LARGE : CONTRAST_NORMAL;
    const ratio = contrastRatio(box.color, box.background);
    if (ratio + 1e-9 >= need) continue;
    out.push({
      id: "contrast",
      severity: CRITICAL_ROLES.has(box.role) ? "error" : "warning",
      scene_id,
      message: `${box.role} text "${snippet(box.text)}" has contrast ${round2(ratio)}:1 (${box.color} on ${box.background}); WCAG needs ${need}:1 for ${large ? "large" : "normal"} text`,
      fix: `change the brand palette (visual.palette text/background/primary) so ${box.color} vs ${box.background} reaches ${need}:1, or enlarge the text`,
    });
  }
}

function checkDensity(spec: VideoSpec, out: LintFinding[]): void {
  for (const s of spec.scenes) {
    const words = wordCount(s.voiceover);
    const wps = words / s.duration_sec;
    if (wps <= MAX_WORDS_PER_SEC) continue;
    const maxWords = Math.floor(MAX_WORDS_PER_SEC * s.duration_sec);
    out.push({
      id: "reading_density",
      severity: "warning",
      scene_id: s.id,
      message: `${words} voiceover words in ${s.duration_sec}s is ${round2(wps)} words/s; captions above ${MAX_WORDS_PER_SEC} words/s are hard to read`,
      fix: `cut scene ${s.id}'s voiceover to at most ${maxWords} words, or raise duration_sec to at least ${Math.ceil((words / MAX_WORDS_PER_SEC) * 10) / 10}`,
    });
  }
}

function checkPostCopy(spec: VideoSpec, contracts: readonly PlatformContract[], out: LintFinding[]): void {
  for (const c of contracts) {
    const copy = spec.publish?.[c.id];
    if (!copy) continue;
    const tags = copy.hashtags ?? [];
    const inline = copy.post_caption.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? [];
    const full = [copy.post_caption, ...tags.filter((t) => !copy.post_caption.includes(t))].join(" ").trim();
    // UTF-16 code units: TikTok counts "UTF-16 runes"; for other platforms it is a close upper bound.
    const length = full.length;
    const lim = c.captions;
    if (lim.post_caption_max_chars !== undefined && length > lim.post_caption_max_chars) {
      out.push({
        id: "post_caption_length",
        severity: "error",
        target: c.id,
        message: `publish.${c.id} post caption with hashtags is ${length} characters; ${c.name} allows ${lim.post_caption_max_chars}`,
        fix: `shorten publish.${c.id}.post_caption (or drop hashtags) by at least ${length - lim.post_caption_max_chars} characters`,
      });
    }
    const hashtagCount = new Set([...tags, ...inline.map((t) => t.trim())].map((t) => t.toLowerCase())).size;
    if (lim.hashtags_max !== undefined && hashtagCount > lim.hashtags_max) {
      out.push({
        id: "post_hashtags",
        severity: "error",
        target: c.id,
        message: `publish.${c.id} has ${hashtagCount} hashtags; ${c.name} allows ${lim.hashtags_max}`,
        fix: `keep at most ${lim.hashtags_max} hashtags in publish.${c.id}`,
      });
    }
    const mentions = (copy.post_caption.match(/(^|\s)@[\p{L}\p{N}_.]+/gu) ?? []).length;
    if (lim.mentions_max !== undefined && mentions > lim.mentions_max) {
      out.push({
        id: "post_mentions",
        severity: "error",
        target: c.id,
        message: `publish.${c.id} mentions ${mentions} accounts; ${c.name} allows ${lim.mentions_max}`,
        fix: `keep at most ${lim.mentions_max} @mentions in publish.${c.id}.post_caption`,
      });
    }
  }
}

function checkCover(spec: VideoSpec, contracts: readonly PlatformContract[], rendered: CoverView | undefined, out: LintFinding[]): void {
  const needing = contracts.filter((c) => c.cover.mode !== "none");
  if (!spec.cover) {
    if (needing.length) {
      out.push({
        id: "cover_missing",
        severity: "warning",
        message: `no cover: ${needing.map((c) => `${c.name} (${c.cover.mode})`).join(", ")} ${needing.length === 1 ? "uses" : "use"} a cover image or frame`,
        fix: 'add cover {headline, focal_time_sec} to the spec, with focal_time_sec inside the hook scene where the headline is on screen',
      });
    }
    return;
  }
  const words = wordCount(spec.cover.headline);
  if (words > COVER_HEADLINE_MAX_WORDS || spec.cover.headline.length > COVER_HEADLINE_MAX_CHARS) {
    out.push({
      id: "cover_headline",
      severity: "warning",
      message: `cover headline "${snippet(spec.cover.headline)}" has ${words} words / ${spec.cover.headline.length} characters; covers read best at ≤ ${COVER_HEADLINE_MAX_WORDS} words and ≤ ${COVER_HEADLINE_MAX_CHARS} characters`,
      fix: `shorten cover.headline to at most ${COVER_HEADLINE_MAX_WORDS} words`,
    });
  }
  const box = rendered?.headline_box;
  if (box) {
    // The compiled cover says where the headline landed: check it against every crop.
    if (box.truncated) {
      out.push({
        id: "cover_overflow",
        severity: "error",
        message: `cover headline "${snippet(spec.cover.headline)}" does not fit the cover frame and was cut`,
        fix: `shorten cover.headline to at most ${COVER_HEADLINE_MAX_WORDS} words`,
      });
    }
    for (const crop of rendered.crops) {
      const inside = intersect(box.rect, crop.rect);
      if (inside && inside.w === box.rect.w && inside.h === box.rect.h) continue;
      out.push({
        id: "cover_crop",
        severity: "error",
        ...(crop.targets.length === 1 ? { target: crop.targets[0]! } : {}),
        message: `the cover headline (${box.rect.x},${box.rect.y} ${box.rect.w}×${box.rect.h}) falls outside the "${crop.id}" crop${crop.targets.length ? ` used by ${crop.targets.join(", ")}` : ""}`,
        fix: "shorten cover.headline so it fits the centre of the frame, then re-render",
      });
    }
    return;
  }
  const crops = needing.flatMap((c) => (c.cover.crops ?? []).map((k) => `${c.name} ${k.aspect_ratio} ${k.anchor}`));
  if (crops.length && words > COVER_HEADLINE_MAX_WORDS / 2 + 1) {
    out.push({
      id: "cover_crop",
      severity: "warning",
      message: `the cover is also cropped to ${crops.join(", ")}; a ${words}-word headline may be cut in the crop`,
      fix: "keep cover.headline to about 4 words so it survives the centre crop, or check the cover preview",
    });
  }
}

function checkBanned(spec: VideoSpec, brand: Brand | undefined, out: LintFinding[]): void {
  const banned = brand?.voice?.banned_phrases ?? [];
  if (banned.length === 0) return;
  const fields: Array<{ where: string; scene_id?: string; text: string }> = [];
  for (const s of spec.scenes) {
    fields.push({ where: `scenes ${s.id} voiceover`, scene_id: s.id, text: s.voiceover });
    if (s.on_screen_text) fields.push({ where: `scenes ${s.id} on_screen_text`, scene_id: s.id, text: s.on_screen_text });
    if (s.deterministic) fields.push({ where: `scenes ${s.id} deterministic.props`, scene_id: s.id, text: strings(s.deterministic.props).join("\n") });
  }
  if (spec.cover) fields.push({ where: "cover.headline", text: spec.cover.headline });
  for (const [id, p] of Object.entries(spec.publish ?? {})) fields.push({ where: `publish.${id}`, text: [p.post_caption, ...(p.hashtags ?? [])].join(" ") });
  for (const phrase of banned) {
    const needle = phrase.toLowerCase();
    for (const f of fields) {
      if (!f.text.toLowerCase().includes(needle)) continue;
      out.push({
        id: "brand_banned_phrase",
        severity: "error",
        ...(f.scene_id ? { scene_id: f.scene_id } : {}),
        message: `banned brand phrase "${phrase}" appears in ${f.where}`,
        fix: `rewrite ${f.where} without "${phrase}" (brand.yaml voice.banned_phrases)`,
      });
    }
  }
}

// ------------------------------------------------------------------------------------ entry

function formatMarkdown(r: Omit<LintResult, "report_json" | "report_md">): string {
  const lines = [
    `# Lint: ${r.status}`,
    "",
    `Targets: ${r.targets.join(", ") || "(none)"}. Render (${r.quality}): ${r.rendered ? "checked" : "not found; render checks skipped"}.`,
    `${r.counts.errors} error(s), ${r.counts.warnings} warning(s).`,
    "",
  ];
  for (const f of r.findings) {
    const where = [f.target, f.scene_id].filter(Boolean).join(" ");
    lines.push(`- **${f.severity}** \`${f.id}\`${where ? ` (${where})` : ""}: ${f.message}`, `  - fix: ${f.fix}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Lint a project: spec + target contracts + (when present) the `quality` render's text boxes,
 * duration and caption box. Writes qa/lint.json and qa/lint.md.
 */
export async function lintProject(projectDir: string, opts: LintOptions = {}): Promise<LintResult> {
  const paths = projectPaths(projectDir);
  const quality = opts.quality ?? "final";
  const specPath = projectSpecPaths(paths.root).spec;
  if (!existsSync(specPath)) throw new Error(`no spec at ${specPath}; plan the video first (the plan skill writes project/video-spec.json)`);
  const parsed = parseYamlOrJson(VideoSpec, await readFile(specPath, "utf8"));
  if (!parsed.ok) throw new Error(`project/video-spec.json does not match the VideoSpec schema; run spec_validate first (${parsed.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join("; ")})`);
  const spec = parsed.data;

  const findings: LintFinding[] = [];
  const wanted = resolveTargets(spec);
  const specsDir = opts.specsDir === undefined ? findPlatformSpecsDir() : opts.specsDir;
  const all = specsDir ? await loadContracts(specsDir) : [];
  const contracts = all.filter((c) => wanted.includes(c.id));
  for (const id of wanted) {
    if (contracts.some((c) => c.id === id)) continue;
    findings.push({
      id: "target_unknown",
      severity: "error",
      target: id,
      message: `no platform contract "${id}" in platform-specs/`,
      fix: `use one of ${all.map((c) => `"${c.id}"`).join(", ") || "(none available)"} in targets, or remove "${id}"`,
    });
  }

  const state = await readOptionalJson<RenderStateView>(join(paths.renders, quality, "render-state.json"));
  const manifestRaw = await readOptionalJson<ManifestView>(join(paths.dist, "render-manifest.json"));
  // dist/ holds the latest export; only trust it when it is the same quality as the render we lint.
  const manifest = manifestRaw?.settings?.quality === quality ? manifestRaw : undefined;
  const master = resolveMaster(spec);
  const W = state?.target?.width ?? manifest?.settings?.width ?? master.width;
  const H = state?.target?.height ?? manifest?.settings?.height ?? master.height;
  const zones = layoutZones({ width: W, height: H, aspect_ratio: spec.aspect_ratio }, contracts);
  const boxes = sceneBoxes(state, manifest);

  checkEnvelope(spec, contracts, state, findings);
  checkOverflow(boxes, findings);
  checkTextMasks(boxes, zones.masks, W, H, findings);
  const burnIn = state?.burn_in ?? manifest?.captions?.burn_in ?? spec.captions.burn_in;
  checkCaptions(spec, zones, state?.captions?.box ?? manifest?.captions?.box, burnIn, findings);
  checkContrast(boxes, H, findings);
  checkDensity(spec, findings);
  checkPostCopy(spec, contracts, findings);
  const coverView: CoverView | undefined = state?.cover
    ? {
        ...(state.cover.headline_box ? { headline_box: state.cover.headline_box } : {}),
        crops: (state.cover.crops ?? []).map(({ id, targets, x, y, w, h }) => ({ id, targets, rect: { x, y, w, h } })),
      }
    : manifest?.cover;
  checkCover(spec, contracts, coverView, findings);
  checkBanned(spec, await loadBrand(paths.root), findings);

  findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.length - errors;
  const core = {
    status: errors ? "fail" : warnings ? "warn" : "pass",
    quality,
    targets: wanted,
    rendered: Boolean(state),
    counts: { errors, warnings },
    findings,
  } as const;
  const reportJson = join(paths.qa, "lint.json");
  const reportMd = join(paths.qa, "lint.md");
  await writeJsonAtomic(reportJson, core);
  await writeFileAtomic(reportMd, formatMarkdown(core));
  return { ...core, findings: [...findings], targets: [...wanted], report_json: reportJson, report_md: reportMd };
}

/** One-screen summary for the tool result. */
export function formatLint(r: LintResult): string {
  return [
    `lint ${r.status}: ${r.counts.errors} error(s), ${r.counts.warnings} warning(s) for ${r.targets.join(", ") || "no targets"} (${r.rendered ? `${r.quality} render checked` : `no ${r.quality} render; spec-only checks`}); report ${r.report_md}`,
    ...r.findings.map((f) => `- ${f.severity} ${f.id}${f.target ? ` [${f.target}]` : ""}${f.scene_id ? ` ${f.scene_id}` : ""}: ${f.message} (fix: ${f.fix})`),
  ].join("\n");
}

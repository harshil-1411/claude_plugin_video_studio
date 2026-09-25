import { z } from "zod";
import {
  AspectRatio,
  DataPolicy,
  Goal,
  Grounding,
  Id,
  LanguageTag,
  NonEmptyString,
  Fps,
  Platform,
  PlatformTargetId,
  PRIMARY_TARGET,
  SchemaVersion,
  UsdAmount,
} from "./common.js";
import type { ContentIR } from "./content-ir.js";

export const ScenePurpose = z.enum([
  "hook",
  "problem",
  "context",
  "point",
  "proof",
  "demo",
  "payoff",
  "cta",
  "end_card",
]);

export const VisualStrategy = z.enum([
  "motion_graphic",
  "generated_video",
  "avatar",
  "screen_capture",
  "user_asset",
  "stock",
]);

export const DeterministicKind = z.enum([
  "typography",
  "code",
  "chart",
  "diagram",
  "screenshot",
  "comparison",
  "cta",
  "end_card",
]);

export const DeterministicScene = z
  .strictObject({
    kind: DeterministicKind,
    props: z.record(z.string(), z.unknown()).describe("Template props passed verbatim to the deterministic renderer."),
  })
  .describe("Deterministic (template-rendered) content for this scene.");

export const RoutingPreference = z.enum(["continuity", "quality", "speed", "cost"]);

export const VisualRequirements = z
  .strictObject({
    subject: z.string().optional(),
    camera: z.string().optional(),
    style: z.string().optional(),
    continuity_refs: z.array(Id).describe("Scene or asset ids this scene must stay visually consistent with."),
    modality: z.enum(["video", "image", "none"]).optional(),
    realism: z.enum(["low", "medium", "high"]).optional(),
    character_reference: z.enum(["required", "optional", "none"]).optional(),
    audio_generation: z.enum(["required", "optional", "none"]).optional(),
    max_cost_usd: UsdAmount.optional(),
    data_policy: DataPolicy.optional(),
    preference: z.array(RoutingPreference).optional().describe("Ordered routing priorities."),
  })
  .describe("Capability requirements for the router. Never names a provider or model.");

export const Transition = z.enum(["cut", "crossfade", "fade_black", "slide", "zoom", "whip"]);

export const SceneId = z.string().regex(/^s\d{2,}$/, "scene id must look like s01, s02, ...");

export const Scene = z.strictObject({
  id: SceneId,
  duration_sec: z.number().positive().max(120),
  purpose: ScenePurpose,
  voiceover: z.string().describe("Narration for this scene; empty string for silent scenes."),
  on_screen_text: z.string().optional(),
  visual_strategy: VisualStrategy,
  deterministic: DeterministicScene.optional(),
  visual_requirements: VisualRequirements,
  claim_refs: z.array(NonEmptyString).describe("Evidence source_refs or ContentIR claim ids backing this scene."),
  transition: Transition.optional(),
});

export const VoiceSettings = z.strictObject({
  provider_preference: z.array(Id).optional().describe("Preferred TTS providers in order; the router may override on policy."),
  voice_id: z.string().optional(),
  style: z.string().optional(),
});

export const CaptionSettings = z.strictObject({
  preset: Id,
  burn_in: z.boolean(),
  position: z
    .strictObject({ y: z.number().min(0).max(1).describe("Vertical centre of the caption block as a fraction of frame height.") })
    .optional()
    .describe("Manual caption placement. Omit to let the caption engine place captions in the platforms' caption zone."),
});

export const MasterCanvas = z
  .strictObject({
    width: z.int().min(2).max(7680),
    height: z.int().min(2).max(7680),
    fps: Fps,
  })
  .describe("Production master canvas every target is compiled from. Defaults to 1080 px on the short side at 30 fps.");

export const Cover = z
  .strictObject({
    headline: NonEmptyString.describe("Cover/thumbnail text; separate from on-screen text, captions and post captions."),
    focal_time_sec: z.number().nonnegative().describe("Video time of the frame the cover is composed from (TikTok uses it as the cover timestamp)."),
  })
  .describe("Cover (thumbnail) text and focal frame.");

export const Hashtag = z.string().regex(/^#[\p{L}\p{N}_]+$/u, "expected a hashtag like #devtools (no spaces)");

export const PublishSettings = z
  .strictObject({
    post_caption: z.string().describe("Text posted with the video on the platform; separate from speech captions."),
    hashtags: z.array(Hashtag).optional(),
    ai_disclosure: z.boolean().optional().describe("Mark the post as AI-generated where the platform supports it."),
  })
  .describe("Per-target post copy.");

export const VideoSpec = z
  .strictObject({
    schema_version: SchemaVersion,
    id: Id.optional(),
    title: z.string().optional(),
    content_ir_id: Id.optional(),
    brief_id: Id.optional(),
    goal: Goal,
    audience: NonEmptyString,
    platform: Platform.describe("Primary platform; with `aspect_ratio` it defines the primary target."),
    aspect_ratio: AspectRatio,
    master: MasterCanvas.optional(),
    targets: z
      .array(PlatformTargetId)
      .optional()
      .describe("Platform contract ids to compile for. Defaults to the primary platform's contract."),
    target_duration_sec: z.number().positive().max(600),
    language: LanguageTag,
    brand_profile: z.string().optional().describe("Brand profile reference, e.g. `acme@3`."),
    policy_profile: z.string().optional(),
    grounding: Grounding,
    voice: VoiceSettings,
    captions: CaptionSettings,
    cover: Cover.optional(),
    publish: z.record(PlatformTargetId, PublishSettings).optional().describe("Post copy keyed by target id."),
    scenes: z.array(Scene).min(1),
  })
  .meta({
    id: "VideoSpec",
    title: "VideoSpec",
    description:
      "What we are making: a provider-independent scene graph that declares capability requirements, never model names.",
  });

export type ScenePurpose = z.infer<typeof ScenePurpose>;
export type VisualStrategy = z.infer<typeof VisualStrategy>;
export type DeterministicKind = z.infer<typeof DeterministicKind>;
export type DeterministicScene = z.infer<typeof DeterministicScene>;
export type RoutingPreference = z.infer<typeof RoutingPreference>;
export type VisualRequirements = z.infer<typeof VisualRequirements>;
export type Transition = z.infer<typeof Transition>;
export type Scene = z.infer<typeof Scene>;
export type VoiceSettings = z.infer<typeof VoiceSettings>;
export type CaptionSettings = z.infer<typeof CaptionSettings>;
export type MasterCanvas = z.infer<typeof MasterCanvas>;
export type Cover = z.infer<typeof Cover>;
export type PublishSettings = z.infer<typeof PublishSettings>;
export type VideoSpec = z.infer<typeof VideoSpec>;

/** Default master for an aspect ratio: 1080 px on the short side, even dimensions, 30 fps. */
export function defaultMaster(aspect: AspectRatio): MasterCanvas {
  const [aw, ah] = aspect.split(":").map(Number) as [number, number];
  const even = (n: number) => Math.round(n / 2) * 2;
  return aw <= ah ? { width: 1080, height: even((1080 * ah) / aw), fps: 30 } : { width: even((1080 * aw) / ah), height: 1080, fps: 30 };
}

/** The spec's master canvas, or the default for its aspect ratio. */
export function resolveMaster(spec: Pick<VideoSpec, "aspect_ratio" | "master">): MasterCanvas {
  return spec.master ?? defaultMaster(spec.aspect_ratio);
}

/** Target contract ids: `targets` when given, else the primary platform's contract (possibly none). */
export function resolveTargets(spec: Pick<VideoSpec, "platform" | "targets">): string[] {
  if (spec.targets?.length) return [...new Set(spec.targets)];
  const primary = PRIMARY_TARGET[spec.platform];
  return primary ? [primary] : [];
}


// ---------------------------------------------------------------- deterministic props per kind

const Label = NonEmptyString;
const Side = z.strictObject({ label: Label, text: NonEmptyString });

/**
 * Props for each deterministic kind. `DeterministicScene.props` stays an open record in the
 * schema; these are enforced by `validateVideoSpecSemantics` with actionable errors.
 */
export const DeterministicProps = {
  typography: z.strictObject({ lines: z.array(NonEmptyString).min(1), emphasis: z.string().optional() }),
  code: z.strictObject({
    language: NonEmptyString,
    code: NonEmptyString,
    highlight_lines: z.array(z.int().positive()).optional(),
  }),
  diagram: z.strictObject({
    nodes: z.array(NonEmptyString).min(1),
    edges: z.array(z.tuple([NonEmptyString, NonEmptyString])),
  }),
  comparison: z.strictObject({ left: Side, right: Side, verdict: z.string().optional() }),
  cta: z.strictObject({
    headline: NonEmptyString,
    action: NonEmptyString,
    command: z.string().optional(),
    url: z.string().optional(),
  }),
  end_card: z.strictObject({ title: z.string().optional(), subtitle: z.string().optional() }),
  chart: z
    .strictObject({
      type: z.enum(["bar", "line", "stat", "pie"]),
      series: z.array(z.strictObject({ label: z.string(), value: z.number() })).min(1).optional(),
      value: z.union([z.number(), z.string().min(1)]).optional(),
      unit: z.string().optional(),
      label: z.string().optional(),
    })
    .refine((p) => p.series !== undefined || p.value !== undefined, { message: "chart needs `series` or `value`" }),
  screenshot: z.strictObject({
    asset: Id.describe("ContentIR asset id"),
    callouts: z.array(z.union([NonEmptyString, z.strictObject({ text: NonEmptyString, x: z.number().optional(), y: z.number().optional() })])).optional(),
  }),
} as const satisfies Record<DeterministicKind, z.ZodType>;

/** Minimal valid props per kind, used in actionable fixes and scaffold guidance. */
export const DETERMINISTIC_PROPS_EXAMPLES: Record<DeterministicKind, Record<string, unknown>> = {
  typography: { lines: ["Key line"], emphasis: "Key" },
  code: { language: "ts", code: "npm install x", highlight_lines: [1] },
  diagram: { nodes: ["A", "B"], edges: [["A", "B"]] },
  comparison: { left: { label: "Before", text: "..." }, right: { label: "After", text: "..." }, verdict: "..." },
  cta: { headline: "Try it", action: "Install", command: "npm install x" },
  end_card: { title: "Name", subtitle: "url" },
  chart: { type: "stat", value: 40, unit: "%", label: "faster builds" },
  screenshot: { asset: "a1", callouts: ["Click here"] },
};

export interface SemanticIssue {
  /** Path into the document, e.g. `scenes.2.deterministic`. */
  path: string;
  message: string;
  /** Concrete instruction for resolving the issue. */
  fix: string;
}

export interface SemanticResult {
  ok: boolean;
  errors: SemanticIssue[];
  /** Non-blocking findings worth surfacing to the user. */
  warnings: SemanticIssue[];
}

/** Allowed deviation of summed scene durations from `target_duration_sec`. */
export const DURATION_TOLERANCE = 0.1;

/** Recommended per-scene duration range (warning outside). */
export const SCENE_DURATION_SOFT = { min: 1, max: 15 } as const;
/** Hard per-scene duration range (error outside). */
export const SCENE_DURATION_HARD = { min: 0.5, max: 30 } as const;

/**
 * Provider and model names that must not appear in scene visual requirements.
 * Scenes declare capabilities; routing picks the provider.
 */
export const FORBIDDEN_PROVIDER_TERMS: readonly string[] = [
  "runway",
  "gen-3",
  "gen-4",
  "heygen",
  "elevenlabs",
  "kling",
  "veo",
  "hailuo",
  "minimax",
  "sora",
  "luma",
  "pika",
  "fal.ai",
  "kokoro",
  "hyperframes",
  "remotion",
];

const forbiddenTermRe = new RegExp(
  `(?:^|[^a-z0-9])(${FORBIDDEN_PROVIDER_TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?:$|[^a-z0-9])`,
  "i",
);

const NUMBER_WORDS =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|dozen|half";
const UNIT_WORDS =
  "percent|per ?cent|times|x|fold|milliseconds?|microseconds?|nanoseconds?|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|dollars?|euros?|pounds?|users?|customers?|downloads?";
const QUANT_PATTERNS: readonly RegExp[] = [
  /\d/, // any digit: 10x, 50%, $5, 3s, 2026
  /[$€£¥₹]/,
  /%/,
  new RegExp(`\\b(?:${NUMBER_WORDS})[\\s-]+(?:${UNIT_WORDS})\\b`, "i"),
  /\b(?:twice|thrice|(?:two|three|four|five|ten|hundred|thousand)fold|percent|millions|billions|thousands|hundreds)\b/i,
  /\b(?:milli|micro|nano)seconds?\b/i,
  /\bin (?:seconds|minutes|hours|days)\b/i,
];

/** First quantitative token in `text` (numbers, %, currency, multipliers, time units), or null. */
export function findQuantitativeToken(text: string): string | null {
  for (const re of QUANT_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      // Expand a bare digit/symbol match to the surrounding token for a readable message.
      const start = text.lastIndexOf(" ", m.index) + 1;
      const endSpace = text.indexOf(" ", m.index + m[0].length);
      const token = m[0].length > 1 ? m[0] : text.slice(start, endSpace === -1 ? text.length : endSpace);
      return token.replace(/^[^\p{L}\p{N}$€£¥₹%]+|[^\p{L}\p{N}%]+$/gu, "") || m[0];
    }
  }
  return null;
}

/** Levenshtein edit distance (iterative, two rows). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/** Up to `n` candidates closest to `target` by normalized edit distance (ties keep input order). */
export function closestMatches(target: string, candidates: Iterable<string>, n = 3): string[] {
  const t = target.toLowerCase();
  return [...new Set(candidates)]
    .map((c, i) => ({ c, i, d: editDistance(t, c.toLowerCase()) / Math.max(t.length, c.length, 1) }))
    .sort((x, y) => x.d - y.d || x.i - y.i)
    .slice(0, n)
    .map((x) => x.c);
}

const LINE_REF_RE = /^([a-z]+:[^#]+)#L(\d+)(?:-L(\d+))?$/;

/**
 * For a line-range ref like `markdown:README.md#L4-L9` or `repo:src/a.ts#L10`, the existing ref
 * in the same file whose line range overlaps most (then is nearest). Null if none or not a line ref.
 */
export function nearestLineBlock(ref: string, candidates: Iterable<string>): string | null {
  const m = LINE_REF_RE.exec(ref);
  if (!m) return null;
  const [file, a, b] = [m[1]!, Number(m[2]), Number(m[3] ?? m[2])];
  let best: { ref: string; overlap: number; gap: number } | null = null;
  for (const c of candidates) {
    const cm = LINE_REF_RE.exec(c);
    if (!cm || cm[1] !== file) continue;
    const [ca, cb] = [Number(cm[2]), Number(cm[3] ?? cm[2])];
    const overlap = Math.max(0, Math.min(b, cb) - Math.max(a, ca) + 1);
    const gap = overlap > 0 ? 0 : Math.min(Math.abs(ca - b), Math.abs(a - cb));
    if (!best || overlap > best.overlap || (overlap === best.overlap && gap < best.gap)) best = { ref: c, overlap, gap };
  }
  return best?.ref ?? null;
}

const LAUNCH_GOALS = new Set(["launch", "promote"]);

/**
 * Cross-field checks that JSON Schema cannot express. Run after `VideoSpec.parse`.
 * Pass the ContentIR to also check that `claim_refs` resolve. Every issue carries a `fix`.
 */
export function validateVideoSpecSemantics(spec: VideoSpec, ir?: ContentIR): SemanticResult {
  const errors: SemanticIssue[] = [];
  const warnings: SemanticIssue[] = [];

  const total = spec.scenes.reduce((sum, s) => sum + s.duration_sec, 0);
  const lo = spec.target_duration_sec * (1 - DURATION_TOLERANCE);
  const hi = spec.target_duration_sec * (1 + DURATION_TOLERANCE);
  if (total < lo || total > hi) {
    const diff = round(spec.target_duration_sec - total);
    errors.push({
      path: "scenes",
      message: `scene durations sum to ${round(total)}s, outside ±${DURATION_TOLERANCE * 100}% of target_duration_sec ${spec.target_duration_sec}s (${round(lo)}–${round(hi)}s)`,
      fix: `${diff > 0 ? "add" : "remove"} about ${Math.abs(diff)}s across scenes (or add/remove a scene), or change target_duration_sec to ${round(total)}`,
    });
  }

  const seen = new Map<string, number>();
  const knownRefs = ir ? [...ir.evidence.map((e) => e.ref), ...ir.claims.map((c) => c.id)] : undefined;
  const knownRefSet = knownRefs ? new Set(knownRefs) : undefined;
  const assetIds = ir ? new Set(ir.assets.map((a) => a.id)) : undefined;
  const sceneIds = new Set(spec.scenes.map((s) => s.id));

  spec.scenes.forEach((scene, i) => {
    const at = `scenes.${i}`;
    const sid = `scene ${scene.id}`;
    const first = seen.get(scene.id);
    if (first !== undefined) {
      errors.push({
        path: `${at}.id`,
        message: `duplicate scene id "${scene.id}" (first used at scenes.${first})`,
        fix: `renumber scenes sequentially (s01, s02, ...); scenes.${i} could be s${String(i + 1).padStart(2, "0")}`,
      });
    } else {
      seen.set(scene.id, i);
    }

    const d = scene.duration_sec;
    if (d < SCENE_DURATION_HARD.min || d > SCENE_DURATION_HARD.max) {
      errors.push({
        path: `${at}.duration_sec`,
        message: `${sid} lasts ${d}s, outside the allowed ${SCENE_DURATION_HARD.min}–${SCENE_DURATION_HARD.max}s`,
        fix: d > SCENE_DURATION_HARD.max ? "split it into several scenes of at most 15s each" : "merge it into a neighbouring scene or lengthen it to at least 1s",
      });
    } else if (d < SCENE_DURATION_SOFT.min || d > SCENE_DURATION_SOFT.max) {
      warnings.push({
        path: `${at}.duration_sec`,
        message: `${sid} lasts ${d}s; scenes usually run ${SCENE_DURATION_SOFT.min}–${SCENE_DURATION_SOFT.max}s`,
        fix: d > SCENE_DURATION_SOFT.max ? "split it into two scenes with one idea each" : "lengthen it to at least 1s or merge it",
      });
    }

    if (scene.visual_strategy === "motion_graphic" && !scene.deterministic) {
      errors.push({
        path: `${at}.deterministic`,
        message: `${sid}: visual_strategy "motion_graphic" requires deterministic {kind, props}`,
        fix: 'add deterministic: {kind: "typography" | "code" | "chart" | "diagram" | "screenshot" | "comparison" | "cta" | "end_card", props: {...}}',
      });
    }
    if (scene.deterministic) {
      const { kind, props } = scene.deterministic;
      const example = JSON.stringify(DETERMINISTIC_PROPS_EXAMPLES[kind]);
      if (kind !== "end_card" && Object.keys(props).length === 0) {
        errors.push({
          path: `${at}.deterministic.props`,
          message: `${sid}: deterministic kind "${kind}" has empty props`,
          fix: `fill props for "${kind}", e.g. ${example}`,
        });
      } else {
        const r = (DeterministicProps[kind] as z.ZodType<Record<string, unknown>>).safeParse(props);
        if (!r.success) {
          for (const issue of r.error.issues) {
            const sub = issue.path.map(String).join(".");
            errors.push({
              path: `${at}.deterministic.props${sub ? `.${sub}` : ""}`,
              message: `${sid}: invalid "${kind}" props: ${issue.message}`,
              fix: `match the "${kind}" props shape, e.g. ${example}`,
            });
          }
        } else if (kind === "diagram") {
          const nodes = new Set(r.data.nodes as string[]);
          (r.data.edges as [string, string][]).forEach(([a, b], j) => {
            for (const end of [a, b]) {
              if (!nodes.has(end)) {
                errors.push({
                  path: `${at}.deterministic.props.edges.${j}`,
                  message: `${sid}: diagram edge references unknown node "${end}"`,
                  fix: `add "${end}" to nodes or use one of ${closestMatches(end, nodes).map((x) => `"${x}"`).join(", ")}`,
                });
              }
            }
          });
        } else if (kind === "screenshot" && assetIds && !assetIds.has(r.data.asset as string)) {
          const near = closestMatches(r.data.asset as string, assetIds);
          errors.push({
            path: `${at}.deterministic.props.asset`,
            message: `${sid}: screenshot asset "${r.data.asset}" is not a ContentIR asset id`,
            fix: near.length ? `use an existing asset id, e.g. ${near.map((x) => `"${x}"`).join(", ")}` : "ingest the image first, or use another kind",
          });
        }
      }
    }
    if (scene.visual_strategy === "generated_video" && !scene.visual_requirements.subject) {
      errors.push({
        path: `${at}.visual_requirements.subject`,
        message: `${sid}: visual_strategy "generated_video" needs a subject to generate`,
        fix: "describe the shot in visual_requirements.subject (and optionally camera and style)",
      });
    }
    if (scene.visual_strategy === "avatar") {
      warnings.push({
        path: `${at}.visual_strategy`,
        message: `${sid}: no avatar provider is available yet, so this scene cannot be produced`,
        fix: 'use "motion_graphic" (e.g. typography) or "generated_video" for now, or keep it and expect routing to fail',
      });
    }

    const vr = scene.visual_requirements;
    for (const key of ["subject", "camera", "style"] as const) {
      const value = vr[key];
      const hit = value ? forbiddenTermRe.exec(value) : null;
      if (hit) {
        errors.push({
          path: `${at}.visual_requirements.${key}`,
          message: `${sid}: scenes must not name providers or models (found "${hit[1]}"); declare capabilities instead`,
          fix: `remove "${hit[1]}" and describe the look; use realism, modality, preference and max_cost_usd to steer routing`,
        });
      }
    }

    vr.continuity_refs.forEach((ref, j) => {
      if (ref === scene.id) {
        errors.push({
          path: `${at}.visual_requirements.continuity_refs.${j}`,
          message: `${sid} cannot reference itself for continuity`,
          fix: `remove "${ref}" from continuity_refs`,
        });
      } else if (!sceneIds.has(ref) && assetIds && !assetIds.has(ref)) {
        const near = closestMatches(ref, [...sceneIds, ...assetIds]);
        errors.push({
          path: `${at}.visual_requirements.continuity_refs.${j}`,
          message: `${sid}: continuity ref "${ref}" is neither a scene id nor a ContentIR asset id`,
          fix: near.length ? `use an existing id, e.g. ${near.map((r) => `"${r}"`).join(", ")}, or remove it` : "remove it",
        });
      }
    });

    if (knownRefs && knownRefSet) {
      scene.claim_refs.forEach((ref, j) => {
        if (!knownRefSet.has(ref)) {
          const near = closestMatches(ref, knownRefs);
          const block = nearestLineBlock(ref, knownRefs);
          const parts: string[] = [];
          if (block) parts.push(`nearest block in the same file: "${block}"`);
          if (near.length) parts.push(`closest existing: ${near.map((r) => `"${r}"`).join(", ")}`);
          errors.push({
            path: `${at}.claim_refs.${j}`,
            message: `${sid}: claim ref "${ref}" does not match any ContentIR evidence ref or claim id`,
            fix: parts.length
              ? `replace it with the correct ref; ${parts.join("; ")}`
              : "the ContentIR has no evidence; ingest a source that supports this scene or remove the claim",
          });
        }
      });
    }

    if (scene.claim_refs.length === 0 && spec.grounding !== "off") {
      const token = findQuantitativeToken(`${scene.voiceover}\n${scene.on_screen_text ?? ""}`);
      if (token) {
        const issue: SemanticIssue = {
          path: `${at}.claim_refs`,
          message: `${sid} states a quantitative claim ("${token}") without claim_refs (grounding: ${spec.grounding})`,
          fix: `add the ContentIR evidence ref or claim id that supports "${token}" to claim_refs, or reword the scene without the number`,
        };
        (spec.grounding === "strict" ? errors : warnings).push(issue);
      }
    }
  });

  if (spec.master) {
    const { width, height } = spec.master;
    const [aw, ah] = spec.aspect_ratio.split(":").map(Number) as [number, number];
    if (Math.abs(width / height - aw / ah) > 0.01 * (aw / ah)) {
      const d = defaultMaster(spec.aspect_ratio);
      errors.push({
        path: "master",
        message: `master ${width}×${height} does not match aspect_ratio ${spec.aspect_ratio}`,
        fix: `use ${d.width}×${d.height} (or another size with ratio ${spec.aspect_ratio}), or change aspect_ratio`,
      });
    }
    if (width % 2 !== 0 || height % 2 !== 0) {
      errors.push({
        path: "master",
        message: `master ${width}×${height} has an odd dimension; H.264 needs even width and height`,
        fix: `use ${width + (width % 2)}×${height + (height % 2)}`,
      });
    }
  }

  if (spec.targets) {
    const seenTargets = new Set<string>();
    spec.targets.forEach((t, i) => {
      if (seenTargets.has(t)) {
        errors.push({ path: `targets.${i}`, message: `duplicate target "${t}"`, fix: `remove the second "${t}"` });
      }
      seenTargets.add(t);
    });
  }

  if (spec.cover && spec.cover.focal_time_sec > total) {
    errors.push({
      path: "cover.focal_time_sec",
      message: `cover focal time ${spec.cover.focal_time_sec}s is after the end of the video (${round(total)}s)`,
      fix: "pick a moment inside the hook scene, where the cover headline is on screen",
    });
  }

  if (spec.publish) {
    const targets = resolveTargets(spec);
    for (const key of Object.keys(spec.publish)) {
      if (!targets.includes(key)) {
        warnings.push({
          path: `publish.${key}`,
          message: `publish copy for "${key}", which is not a target (${targets.length ? targets.join(", ") : "none"})`,
          fix: targets.length ? `add "${key}" to targets, or rename the key to one of ${targets.join(", ")}` : `add "${key}" to targets or remove it`,
        });
      }
    }
  }

  const firstScene = spec.scenes[0];
  if (firstScene && firstScene.purpose !== "hook") {
    warnings.push({
      path: "scenes.0.purpose",
      message: `first scene is "${firstScene.purpose}"; it should be the "hook"`,
      fix: 'open with a hook scene (purpose "hook", 1.5–4s) that states the chosen hook',
    });
  }
  const last = spec.scenes[spec.scenes.length - 1];
  if (last && LAUNCH_GOALS.has(spec.goal) && last.purpose !== "cta" && last.purpose !== "end_card") {
    warnings.push({
      path: `scenes.${spec.scenes.length - 1}.purpose`,
      message: `goal is "${spec.goal}" but the last scene is "${last.purpose}"`,
      fix: 'end with a "cta" or "end_card" scene that states the desired action',
    });
  }

  return { ok: errors.length === 0, errors, warnings };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

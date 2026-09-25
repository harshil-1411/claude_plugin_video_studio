import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DETERMINISTIC_PROPS_EXAMPLES, VideoSpec, validateVideoSpecSemantics } from "@video-studio/schema";
import { initProject } from "@video-studio/core";
import { ingest } from "@video-studio/ingestion";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allocateDurations, renderStoryboard, scaffoldSpec, scenePace, validateBrief } from "./plan.js";
import { createServer } from "./server.js";
import { validateSpecFile } from "./spec-validate.js";
import { findTemplatesDir, getTemplate, loadTemplates } from "./templates.js";

const here = dirname(fileURLToPath(import.meta.url));
const examples = resolve(here, "../../schema/examples");
const EXPECTED_TEMPLATES = [
  "aesthetic-broll",
  "ambient-slice-of-life",
  "animated-explainer",
  "before-after",
  "carousel-story",
  "case-study",
  "devtool-launch",
  "educational",
  "explain",
  "faceless-listicle",
  "listicle",
  "oddly-satisfying",
  "product-demo",
  "product-launch",
  "product-ui",
  "silent-vlog",
  "talking-head",
  "text-over-music",
];

let tmp: string;
let templatesDir: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-plan-"));
  templatesDir = findTemplatesDir({})!;
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Copy the schema examples into a project layout: project/{creative-brief.yaml,video-spec.json}, source/content-ir.json. */
async function exampleProject(name: string, opts: { brief?: string | null } = {}): Promise<string> {
  const root = join(tmp, name);
  await mkdir(join(root, "project"), { recursive: true });
  await mkdir(join(root, "source"), { recursive: true });
  await writeFile(join(root, "project/video-spec.json"), await readFile(join(examples, "explain-vector-db.video-spec.json")));
  await writeFile(join(root, "source/content-ir.json"), await readFile(join(examples, "explain-vector-db.content-ir.json")));
  const brief = opts.brief === undefined ? await readFile(join(examples, "explain-vector-db.creative-brief.json"), "utf8") : opts.brief;
  if (brief !== null) await writeFile(join(root, "project/creative-brief.yaml"), brief);
  return root;
}

async function connect() {
  const server = createServer({ cwd: () => tmp, env: {} });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, close: () => client.close() };
}
const text = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

describe("templates", () => {
  it("finds the bundled templates dir via CLAUDE_PLUGIN_ROOT and by walking up", () => {
    expect(templatesDir).toBeTruthy();
    const root = resolve(templatesDir, "..");
    expect(findTemplatesDir({ CLAUDE_PLUGIN_ROOT: root }, "/")).toBe(join(root, "templates"));
    expect(findTemplatesDir({}, "/")).toBeNull();
  });

  it("all templates load, validate and have beat shares summing to 1", async () => {
    const all = await loadTemplates(templatesDir);
    expect(all.map((t) => t.id)).toEqual(EXPECTED_TEMPLATES);
    for (const t of all) {
      const sum = t.beats.reduce((a, b) => a + b.share, 0);
      expect(Math.abs(sum - 1), t.id).toBeLessThanOrEqual(0.01);
      expect(t.beats[0]!.purpose, t.id).toBe("hook");
      expect(["cta", "end_card"], t.id).toContain(t.beats[t.beats.length - 1]!.purpose);
      expect(t.rules.some((r) => /CTA/.test(r)), t.id).toBe(true);
    }
  });

  it("getTemplate rejects unknown and path-like ids with the available list", async () => {
    await expect(getTemplate(templatesDir, "nope")).rejects.toThrow(/available: aesthetic-broll, ambient-slice-of-life, animated-explainer, before-after/);
    await expect(getTemplate(templatesDir, "../schemas")).rejects.toThrow(/unknown template/);
  });
});

describe("spec_scaffold", () => {
  it("allocates durations that sum exactly to the target", () => {
    const d = allocateDurations([0.12, 0.16, 0.22, 0.2, 0.16, 0.14], 37);
    expect(Math.round(d.reduce((a, b) => a + b, 0) * 10) / 10).toBe(37);
  });

  it("every template scaffolds to the target ±0.5s and passes the schema once placeholders are filled", async () => {
    const root = await exampleProject("scaffold", { brief: null });
    for (const id of EXPECTED_TEMPLATES) {
      for (const target of [20, 30, 45, 60, 90]) {
        const r = await scaffoldSpec(root, templatesDir, { template_id: id, target_duration_sec: target });
        const total = r.spec.scenes.reduce((a, s) => a + s.duration_sec, 0);
        expect(Math.abs(total - target), `${id}@${target}`).toBeLessThanOrEqual(0.5);
        expect(r.spec.content_ir_id).toBe("ir-vector-db");
        expect(VideoSpec.safeParse(r.spec).success, `${id} skeleton`).toBe(true);

        // Fill placeholders the way Claude would, then the spec must pass semantics too.
        const filled = structuredClone(r.spec);
        const silent = filled.voice.mode === "none" || filled.voice.mode === "native";
        for (const s of filled.scenes) {
          s.voiceover = silent ? "" : "A short line of narration for this scene.";
          // Footage scenes get a clip (no IR here, so the asset id isn't cross-checked).
          if (s.visual_strategy === "user_asset" || s.visual_strategy === "screen_capture") s.footage = { asset: "v1", in_sec: 0 };
          s.on_screen_text = "Key idea";
          if (s.deterministic) s.deterministic.props = structuredClone(DETERMINISTIC_PROPS_EXAMPLES[s.deterministic.kind]);
          // Example props carry numbers (e.g. a 40% stat), which strict grounding requires a ref for.
          s.claim_refs = ["ev-1"];
          if (s.visual_strategy === "generated_video") s.visual_requirements.subject = "abstract shapes forming a product";
        }
        expect(VideoSpec.safeParse(filled).success).toBe(true);
        const sem = validateVideoSpecSemantics(filled);
        expect(sem.errors, `${id}@${target}`).toEqual([]);
      }
    }
  });

  it("uses brief defaults, drops optional beats for short cuts and honours overrides", async () => {
    const root = await exampleProject("scaffold-brief");
    const r = await scaffoldSpec(root, templatesDir, { template_id: "explain" });
    expect(r.spec).toMatchObject({ goal: "explain", platform: "instagram_reels", aspect_ratio: "9:16", target_duration_sec: 30, brief_id: "brief-vector-db" });
    expect(r.spec.scenes.map((s) => s.purpose)).toEqual(["hook", "problem", "point", "point", "proof", "cta"]);
    expect(r.scene_guidance[0]!.word_budget).toBeGreaterThan(0);
    const short = await scaffoldSpec(root, templatesDir, { template_id: "explain", target_duration_sec: 20, platform: "youtube", aspect_ratio: "16:9" });
    expect(short.spec.scenes.map((s) => s.purpose)).not.toContain("proof");
    expect(short.spec).toMatchObject({ platform: "youtube", aspect_ratio: "16:9" });
    expect(short.notes.join(" ")).toMatch(/dropped 1 optional beat/);
    expect(r.spec).toMatchObject({ master: { width: 1080, height: 1920, fps: 30 }, targets: ["instagram"] });
    expect(short.spec.master).toEqual({ width: 1920, height: 1080, fps: 30 });
    expect(short.spec.targets).toBeUndefined();
    expect(r.notes.join(" ")).toMatch(/add cover \{headline, focal_time_sec\}/);
  });

  it("text-over-music scaffolds without voice, with the lofi bed and on-screen word budgets", async () => {
    const root = await exampleProject("scaffold-tom", { brief: null });
    const r = await scaffoldSpec(root, templatesDir, { template_id: "text-over-music" });
    expect(r.spec.voice.mode).toBe("none");
    expect(r.spec.audio?.music?.file).toBe("bundled:lofi");
    expect(r.spec.captions.burn_in).toBe(false);
    expect(r.spec.style).toBe("energetic");
    expect(r.spec.scenes.every((s) => s.voiceover === "")).toBe(true);
    for (const g of r.scene_guidance) expect(g.word_budget, g.scene_id).toBe(Math.max(3, Math.floor((g.duration_sec - 1) * 3)));
    expect(r.notes.join(" ")).toMatch(/voice\.mode "none"/);

    // Overrides: another bed, another style, or narration back on.
    const o = await scaffoldSpec(root, templatesDir, { template_id: "text-over-music", music: "bundled:ambient", style: "minimal", voice_mode: "narrated" });
    expect(o.spec.audio?.music?.file).toBe("bundled:ambient");
    expect(o.spec.style).toBe("minimal");
    expect(o.spec.voice.mode).toBeUndefined();
    expect(o.spec.captions.burn_in).toBe(true);
  });

  it("applies each archetype's default style and lets style override it", async () => {
    const root = await exampleProject("scaffold-style", { brief: null });
    const defaults: Record<string, string> = {
      "animated-explainer": "technical",
      "before-after": "energetic",
      "carousel-story": "editorial",
      "case-study": "editorial",
      "faceless-listicle": "energetic",
      "product-demo": "minimal",
      "product-ui": "minimal",
      "text-over-music": "energetic",
    };
    for (const [id, style] of Object.entries(defaults)) {
      const r = await scaffoldSpec(root, templatesDir, { template_id: id });
      expect(r.spec.style, id).toBe(style);
      if (id !== "text-over-music") {
        expect(r.spec.voice.mode, id).toBeUndefined();
        expect(r.spec.audio, id).toBeUndefined();
      }
    }
    const o = await scaffoldSpec(root, templatesDir, { template_id: "case-study", style: "technical" });
    expect(o.spec.style).toBe("technical");
    const legacy = await scaffoldSpec(root, templatesDir, { template_id: "explain" });
    expect(legacy.spec.style).toBeUndefined();
  });

  it("takes explicit targets over the brief", async () => {
    const root = await exampleProject("scaffold-targets");
    const r = await scaffoldSpec(root, templatesDir, { template_id: "explain", targets: ["instagram", "tiktok", "youtube-shorts"] });
    expect(r.spec.targets).toEqual(["instagram", "tiktok", "youtube-shorts"]);
    expect(r.notes.join(" ")).toMatch(/publish\.<target>.*instagram, tiktok, youtube-shorts/);
  });
});

describe("brief_validate", () => {
  it("warns on the example brief (2 hooks) and passes a complete one", async () => {
    const root = await exampleProject("brief-ok");
    const r = await validateBrief(root, templatesDir);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toEqual(["hook_candidates"]);

    const b = JSON.parse(await readFile(join(examples, "explain-vector-db.creative-brief.json"), "utf8"));
    b.hook_candidates.push({ text: "What if search understood you?", mechanism: "question", scores: { clarity: 8 } });
    b.template = "explain";
    await writeFile(join(root, "project/creative-brief.yaml"), JSON.stringify(b));
    const good = await validateBrief(root, templatesDir);
    expect(good.warnings).toEqual([]);
  });

  it("reports YAML briefs with platform, chosen hook, assumption and template warnings", async () => {
    const yaml = `schema_version: "1.0"
goal: explain
audience: engineers
platform: youtube_shorts
aspect_ratio: "9:16"
target_duration_sec: 120
language: en
tone: [clear]
desired_action: Try it
hook_candidates:
  - { text: "One", mechanism: question, scores: {clarity: 5} }
chosen_hook: "Something else"
template: product-launch
assumptions: []
`;
    const root = await exampleProject("brief-warn", { brief: yaml });
    const r = await validateBrief(root, templatesDir);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.path)).toEqual(["chosen_hook"]);
    expect(r.warnings.map((w) => w.path)).toEqual(["hook_candidates", "assumptions", "target_duration_sec", "template", "target_duration_sec"]);
    expect(r.warnings.every((w) => w.fix.length > 0)).toBe(true);

    await writeFile(join(root, "project/creative-brief.yaml"), yaml.replace('"Something else"', '"One"').replace("product-launch", "no-such-template"));
    const unknown = await validateBrief(root, templatesDir);
    expect(unknown.errors.map((e) => e.path)).toEqual(["template"]);
    expect(unknown.errors[0]!.message).toContain("available: aesthetic-broll, ambient-slice-of-life, animated-explainer");
  });

  it("returns schema errors with fixes and throws when no brief exists", async () => {
    const root = await exampleProject("brief-bad", { brief: "goal: explain\n" });
    const r = await validateBrief(root, templatesDir);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.path)).toEqual(expect.arrayContaining(["audience", "hook_candidates"]));
    expect(r.errors[0]!.fix).toMatch(/creative-brief/);
    const none = await exampleProject("brief-none", { brief: null });
    await expect(validateBrief(none, templatesDir)).rejects.toThrow(/no creative brief found/);
  });
});

describe("storyboard_render", () => {
  it("writes a readable storyboard for the example project", async () => {
    const root = await exampleProject("storyboard");
    const r = await renderStoryboard(root);
    expect(r.storyboard_path).toBe(join(root, "project/storyboard.md"));
    expect(await readFile(r.storyboard_path, "utf8")).toBe(r.markdown);
    expect(r.markdown).toContain('`url:https://example.com/vector-db-guide#ann-index`: "approximate nearest-neighbour indexes');
    expect(r.errors).toEqual([]);
    await expect(r.markdown).toMatchFileSnapshot("__snapshots__/storyboard.explain-vector-db.md");
  });

  it("flags too-fast voiceover and dead air", () => {
    const base = { purpose: "point", visual_strategy: "stock", visual_requirements: { continuity_refs: [] }, claim_refs: [] } as const;
    const p = scenePace([
      { ...base, id: "s01", duration_sec: 2, voiceover: "one two three four five six seven eight" },
      { ...base, id: "s02", duration_sec: 4, voiceover: "just two" },
      { ...base, id: "s03", duration_sec: 3, voiceover: "", purpose: "end_card" },
      { ...base, id: "s04", duration_sec: 2, voiceover: "" },
    ]);
    expect(p.map((x) => x.flag)).toEqual(["too_fast", "dead_air", null, null]);
    expect(p[0]!.fix).toMatch(/cut about 2 words/);
    expect(p[3]!.start_sec).toBe(9);
  });
});

describe("strict grounding via spec_validate", () => {
  it("rejects an unsourced number and suggests the closest refs", async () => {
    const root = await exampleProject("grounding");
    const spec = JSON.parse(await readFile(join(root, "project/video-spec.json"), "utf8"));
    spec.scenes[0].voiceover = "Keyword search misses 40% of what you meant.";
    spec.scenes[1].claim_refs = ["url:https://example.com/vector-db-guide#keyword-limit"];
    await writeFile(join(root, "project/video-spec.json"), JSON.stringify(spec));
    const r = await validateSpecFile(join(root, "project/video-spec.json"), join(root, "source/content-ir.json"));
    expect(r.ok).toBe(false);
    const byPath = Object.fromEntries(r.errors.map((e) => [e.path, e]));
    expect(byPath["scenes.0.claim_refs"]!.message).toMatch(/scene s01.*"40%"/);
    expect(byPath["scenes.1.claim_refs.0"]!.fix).toContain('"url:https://example.com/vector-db-guide#keyword-limits"');
    expect(r.errors.every((e) => e.fix && e.stage === "semantic")).toBe(true);
  });
});

describe("platform targets via spec_validate", () => {
  const registry = resolve(here, "../../platforms/src/__fixtures__/specs");

  it("errors on an unknown target and warns on an aspect the contract does not accept", async () => {
    const root = await exampleProject("targets");
    const specPath = join(root, "project/video-spec.json");
    const spec = JSON.parse(await readFile(specPath, "utf8"));
    spec.targets = ["demo-vertical", "demo-vertcal"];
    await writeFile(specPath, JSON.stringify(spec));
    const r = await validateSpecFile(specPath, join(root, "source/content-ir.json"), registry);
    expect(r.errors).toEqual([expect.objectContaining({ path: "targets.1", stage: "platform", fix: 'use one of "demo-vertical"' })]);

    spec.targets = ["demo-vertical"];
    spec.aspect_ratio = "1:1";
    spec.platform = "generic";
    await writeFile(specPath, JSON.stringify(spec));
    const w = await validateSpecFile(specPath, join(root, "source/content-ir.json"), registry);
    expect(w.ok).toBe(true);
    expect(w.warnings.filter((x) => x.stage === "platform").map((x) => x.message)).toEqual([expect.stringMatching(/Demo Vertical expects 9:16/)]);
  });

  it("skips target checks while the registry has no contracts", async () => {
    const root = await exampleProject("targets-empty");
    const empty = join(tmp, "empty-registry");
    await mkdir(empty, { recursive: true });
    const r = await validateSpecFile(join(root, "project/video-spec.json"), join(root, "source/content-ir.json"), empty);
    expect(r.ok).toBe(true);
    expect(r.errors.concat(r.warnings).some((i) => i.stage === "platform")).toBe(false);
  });
});

describe("plan tools over MCP", () => {
  it("template_list, template_get, brief_validate, spec_scaffold, storyboard_render", async () => {
    const root = await exampleProject("mcp");
    const { client, close } = await connect();
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;

    const list = await call("template_list", {});
    expect(list.isError).toBeFalsy();
    const templates = (list.structuredContent as { templates: { id: string; beat_count: number }[] }).templates;
    expect(templates.map((t) => t.id)).toEqual(EXPECTED_TEMPLATES);
    expect(templates.every((t) => t.beat_count >= 5)).toBe(true);

    const got = await call("template_get", { id: "listicle" });
    expect((got.structuredContent as { beats: unknown[] }).beats.length).toBe(7);
    const missing = await call("template_get", { id: "nope" });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("available:");

    const brief = await call("brief_validate", { project_dir: root });
    expect((brief.structuredContent as { ok: boolean }).ok).toBe(true);
    expect(text(brief)).toContain("fix:");

    const scaffold = await call("spec_scaffold", { project_dir: "mcp", template_id: "devtool-launch", target_duration_sec: 45, platform: "x", aspect_ratio: "16:9" });
    expect(scaffold.isError).toBeFalsy();
    const sc = scaffold.structuredContent as { spec: { scenes: { duration_sec: number }[]; aspect_ratio: string } };
    expect(sc.spec.aspect_ratio).toBe("16:9");
    expect(sc.spec.scenes.reduce((a, s) => a + s.duration_sec, 0)).toBeCloseTo(45, 5);
    await expect(readFile(join(root, "project/video-spec.json"), "utf8")).resolves.toContain("explain-vector-db"); // not overwritten

    const board = await call("storyboard_render", { project_dir: root });
    expect(board.isError).toBeFalsy();
    expect(text(board)).toContain("| s01 | 0.0–3.5s | hook |");
    expect(text(board)).toContain("| Scene | Time | Purpose | Voiceover | On-screen text | Visual | Refs |");

    const bad = await call("storyboard_render", { project_dir: join(tmp, "does-not-exist") });
    expect(bad.isError).toBe(true);
    await close();
  });
});

describe("examples/readme-plan end to end", () => {
  it("ingest the frozen README.md, then brief_validate, spec_validate and storyboard_render pass", async () => {
    const repo = resolve(here, "../../..");
    const root = join(tmp, "readme-plan");
    await initProject(root, { name: "readme-plan" });
    for (const f of ["creative-brief.yaml", "video-spec.json"]) {
      await writeFile(join(root, "project", f), await readFile(join(repo, "examples/readme-plan/project", f)));
    }
    // Ingest the frozen copy the example was planned from, so edits to the
    // live root README.md don't invalidate the example's line refs.
    const input = join(repo, "examples/readme-plan/input");
    await ingest([join(input, "README.md")], { cwd: input, env: {}, cacheDir: join(tmp, "readme-cache"), now: "2026-09-25T12:00:00.000Z", projectDir: root });

    const brief = await validateBrief(root, templatesDir);
    expect(brief.errors).toEqual([]);
    expect(brief.warnings).toEqual([]);

    const spec = await validateSpecFile(join(root, "project/video-spec.json"), join(root, "source/content-ir.json"));
    expect(spec.errors).toEqual([]);
    expect(spec.warnings).toEqual([]);

    const board = await renderStoryboard(root);
    expect(board.errors).toEqual([]);
    expect(board.markdown).toContain("`markdown:README.md#L3-L6`: \"");
    expect(board.pacing.filter((p) => p.flag)).toEqual([]);
  });
});

describe("footage archetypes", () => {
  it("talking-head scaffolds native voice, native scene audio and footage hints", async () => {
    const root = await exampleProject("scaffold-th", { brief: null });
    const r = await scaffoldSpec(root, templatesDir, { template_id: "talking-head" });
    expect(r.spec.voice.mode).toBe("native");
    expect(r.spec.captions.burn_in).toBe(true);
    expect(r.spec.scenes.every((s) => s.visual_strategy === "user_asset" && s.audio?.mode === "native" && s.voiceover === "")).toBe(true);
    expect(r.spec.scenes[0]!.deterministic?.kind).toBe("lower_third");
    for (const g of r.scene_guidance) expect(g.footage_example, g.scene_id).toMatchObject({ in_sec: 0, fit: "cover" });
    expect(r.notes.join(" ")).toMatch(/voice\.mode "native"/);
    expect(r.notes.join(" ")).toMatch(/footage scenes/);
  });

  it("aesthetic-broll uses the bed per scene; silent-vlog keeps native sound", async () => {
    const root = await exampleProject("scaffold-broll", { brief: null });
    const b = await scaffoldSpec(root, templatesDir, { template_id: "aesthetic-broll" });
    expect(b.spec.voice.mode).toBe("none");
    expect(b.spec.audio?.music?.file).toBe("bundled:lofi");
    expect(b.spec.scenes.every((s) => s.audio?.mode === "music")).toBe(true);
    expect(b.rules.join(" ")).toMatch(/beat_sync/);
    const v = await scaffoldSpec(root, templatesDir, { template_id: "silent-vlog" });
    expect(v.spec.audio).toBeUndefined();
    expect(v.spec.scenes.every((s) => s.audio?.mode === "native")).toBe(true);
    expect(v.notes.join(" ")).not.toMatch(/no music bed/);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { EMITTED_SCHEMAS, REPO_ROOT, renderJsonSchema, toJsonSchema, type EmittedSchemaName } from "./emit.js";
import {
  Brand,
  CapabilityMatrix,
  ContentIR,
  CreativeBrief,
  Policy,
  RenderManifest,
  SCHEMA_VERSION,
  SceneGenerationRequest,
  VideoSpec,
  DETERMINISTIC_PROPS_EXAMPLES,
  DeterministicProps,
  Template,
  closestMatches,
  nearestLineBlock,
  findQuantitativeToken,
  parseYamlOrJson,
  validateCreativeBriefSemantics,
  validateVideoSpecSemantics,
  defaultMaster,
  resolveMaster,
  resolveTargets,
  type VideoSpec as VideoSpecT,
} from "./index.js";

const EXAMPLES = join(REPO_ROOT, "packages/schema/examples");
const read = (f: string) => readFileSync(join(EXAMPLES, f), "utf8");
const clone = <T>(v: T): T => structuredClone(v);

const FIXTURES: Record<EmittedSchemaName, string> = {
  "content-ir": "explain-vector-db.content-ir.json",
  "creative-brief": "explain-vector-db.creative-brief.json",
  "video-spec": "explain-vector-db.video-spec.json",
  "render-manifest": "explain-vector-db.render-manifest.json",
  brand: "acme.brand.yaml",
  policy: "enterprise.policy.yaml",
  template: "../../../templates/explain/template.yaml",
  "platform-contract": "../../platforms/src/__fixtures__/specs/demo-vertical.yaml",
};

function loadSpec(): VideoSpecT {
  const r = parseYamlOrJson(VideoSpec, read(FIXTURES["video-spec"]));
  if (!r.ok) throw new Error(r.message);
  return r.data;
}

describe("valid examples parse", () => {
  it("exports SCHEMA_VERSION 1.0", () => {
    expect(SCHEMA_VERSION).toBe("1.0");
  });

  for (const [name, file] of Object.entries(FIXTURES) as [EmittedSchemaName, string][]) {
    it(`${file} parses as ${name}`, () => {
      const r = parseYamlOrJson(EMITTED_SCHEMAS[name], read(file));
      if (!r.ok) throw new Error(r.message);
      expect(r.ok).toBe(true);
    });
  }

  it("example VideoSpec is a 30s 9:16 spec with 5-6 scenes and passes semantics", () => {
    const spec = loadSpec();
    expect(spec.aspect_ratio).toBe("9:16");
    expect(spec.target_duration_sec).toBe(30);
    expect(spec.scenes.length).toBeGreaterThanOrEqual(5);
    expect(spec.scenes.length).toBeLessThanOrEqual(6);
    const ir = ContentIR.parse(JSON.parse(read(FIXTURES["content-ir"])));
    const res = validateVideoSpecSemantics(spec, ir);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("CapabilityMatrix and SceneGenerationRequest parse", () => {
    expect(
      CapabilityMatrix.safeParse({
        text_to_video: true,
        image_to_video: true,
        video_to_video: false,
        character_reference: true,
        native_audio: true,
        max_duration_seconds: 15,
        min_duration_seconds: 2,
        aspect_ratios: ["9:16", "16:9"],
        resolutions: ["1080p", "4k"],
        data_regions: ["provider-default"],
      }).success,
    ).toBe(true);
    expect(
      SceneGenerationRequest.safeParse({
        project_id: "p1",
        scene_id: "s03",
        modality: "video",
        prompt: "points clustering",
        duration_sec: 6,
        aspect_ratio: "9:16",
        reference_images: [],
        generate_audio: false,
        data_policy: "external-ok",
      }).success,
    ).toBe(true);
  });
});

describe("invalid documents fail with correct paths", () => {
  const paths = (r: ReturnType<typeof parseYamlOrJson>) => (r.ok ? [] : r.errors.map((e) => e.path));

  it("bad scene id, negative duration, unknown strategy", () => {
    const spec = loadSpec() as unknown as Record<string, any>;
    spec.scenes[1].id = "scene-2";
    spec.scenes[2].duration_sec = -1;
    spec.scenes[3].visual_strategy = "sora_clip";
    const r = parseYamlOrJson(VideoSpec, JSON.stringify(spec));
    expect(r.ok).toBe(false);
    expect(paths(r)).toEqual(
      expect.arrayContaining(["scenes.1.id", "scenes.2.duration_sec", "scenes.3.visual_strategy"]),
    );
  });

  it("rejects provider/model fields on scenes (strict objects)", () => {
    const spec = loadSpec() as unknown as Record<string, any>;
    spec.scenes[2].provider = "runway";
    spec.scenes[2].visual_requirements.model = "gen-4";
    const r = parseYamlOrJson(VideoSpec, JSON.stringify(spec));
    expect(r.ok).toBe(false);
    expect(paths(r)).toEqual(expect.arrayContaining(["scenes.2", "scenes.2.visual_requirements"]));
  });

  it("bad aspect ratio, language and platform", () => {
    const spec = loadSpec() as unknown as Record<string, any>;
    spec.aspect_ratio = "4:3";
    spec.language = "english!";
    spec.platform = "myspace";
    const r = parseYamlOrJson(VideoSpec, JSON.stringify(spec));
    expect(paths(r)).toEqual(expect.arrayContaining(["aspect_ratio", "language", "platform"]));
  });

  it("ContentIR rejects bad source_ref and Date-like created_at", () => {
    const ir = JSON.parse(read(FIXTURES["content-ir"]));
    ir.evidence[0].ref = "README.md#L1";
    ir.created_at = "25/09/2026";
    ir.sources[0].sha256 = "xyz";
    const r = parseYamlOrJson(ContentIR, JSON.stringify(ir));
    expect(paths(r)).toEqual(expect.arrayContaining(["evidence.0.ref", "created_at", "sources.0.sha256"]));
  });

  it("policy rejects bad glob and negative spend; brand rejects bad colour", () => {
    const p = parseYamlOrJson(Policy, "version: 1\nproviders:\n  deny: ['bad glob!']\nspend:\n  scene_limit_usd: -3\n");
    expect(paths(p)).toEqual(expect.arrayContaining(["providers.deny.0", "spend.scene_limit_usd"]));
    const b = parseYamlOrJson(Brand, "brand:\n  name: Acme\nvisual:\n  fonts: {heading: Inter, body: Inter}\n  palette: {primary: blue}\n");
    expect(paths(b)).toEqual(["visual.palette.primary"]);
  });

  it("render manifest rejects unknown status and zero attempts", () => {
    const m = JSON.parse(read(FIXTURES["render-manifest"]));
    m.renders[0].status = "done";
    m.renders[1].attempts = 0;
    const r = parseYamlOrJson(RenderManifest, JSON.stringify(m));
    expect(paths(r)).toEqual(expect.arrayContaining(["renders.0.status", "renders.1.attempts"]));
  });

  it("creative brief requires hook candidates", () => {
    const b = JSON.parse(read(FIXTURES["creative-brief"]));
    b.hook_candidates = [];
    expect(paths(parseYamlOrJson(CreativeBrief, JSON.stringify(b)))).toEqual(["hook_candidates"]);
  });

  it("reports YAML syntax errors without throwing", () => {
    const r = parseYamlOrJson(Policy, "version: 1\n  bad: [indent");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.message).toMatch(/syntax error/);
  });

  it("produces a readable message", () => {
    const r = parseYamlOrJson(Policy, "version: 2\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("version");
  });
});

describe("validateVideoSpecSemantics", () => {
  const errorPaths = (spec: VideoSpecT) => validateVideoSpecSemantics(spec).errors.map((e) => e.path);

  it("catches duration mismatch beyond ±10%", () => {
    const spec = clone(loadSpec());
    spec.target_duration_sec = 45;
    const res = validateVideoSpecSemantics(spec);
    expect(res.ok).toBe(false);
    expect(res.errors[0]?.path).toBe("scenes");
    expect(res.errors[0]?.message).toMatch(/sum to 30s/);
    spec.target_duration_sec = 32; // 30 is within 10% of 32
    expect(validateVideoSpecSemantics(spec).ok).toBe(true);
  });

  it("catches duplicate scene ids", () => {
    const spec = clone(loadSpec());
    spec.scenes[3]!.id = "s02";
    expect(errorPaths(spec)).toContain("scenes.3.id");
  });

  it("requires deterministic props for motion_graphic scenes", () => {
    const spec = clone(loadSpec());
    delete spec.scenes[0]!.deterministic;
    spec.scenes[3]!.deterministic!.props = {};
    expect(errorPaths(spec)).toEqual(expect.arrayContaining(["scenes.0.deterministic", "scenes.3.deterministic.props"]));
  });

  it("rejects provider names in visual requirements", () => {
    const spec = clone(loadSpec());
    spec.scenes[2]!.visual_requirements.style = "Runway Gen-4 cinematic look";
    expect(errorPaths(spec)).toContain("scenes.2.visual_requirements.style");
  });

  it("checks claim_refs and continuity refs against ContentIR", () => {
    const spec = clone(loadSpec());
    const ir = ContentIR.parse(JSON.parse(read(FIXTURES["content-ir"])));
    spec.scenes[1]!.claim_refs = ["url:https://example.com/nowhere"];
    spec.scenes[2]!.visual_requirements.continuity_refs = ["a1", "missing"];
    const res = validateVideoSpecSemantics(spec, ir);
    expect(res.errors.map((e) => e.path)).toEqual(["scenes.1.claim_refs.0", "scenes.2.visual_requirements.continuity_refs.1"]);
  });

  it("rejects unsourced numbers under strict grounding, warns under loose, ignores when off", () => {
    const spec = clone(loadSpec());
    spec.scenes[5]!.on_screen_text = "Part 2 next week";
    const strict = validateVideoSpecSemantics(spec);
    expect(strict.ok).toBe(false);
    expect(strict.errors.map((e) => e.path)).toEqual(["scenes.5.claim_refs"]);
    expect(strict.errors[0]!.message).toContain("scene s06");
    expect(strict.errors[0]!.fix).toMatch(/claim_refs/);
    spec.grounding = "loose";
    const loose = validateVideoSpecSemantics(spec);
    expect(loose.ok).toBe(true);
    expect(loose.warnings.map((w) => w.path)).toEqual(["scenes.5.claim_refs"]);
    spec.grounding = "off";
    expect(validateVideoSpecSemantics(spec).warnings).toEqual([]);
  });

  it("detects quantitative tokens", () => {
    for (const t of ["10x faster", "cuts cost by 40%", "costs $5", "in milliseconds", "saves ten minutes", "twice as fast", "millions of users"]) {
      expect(findQuantitativeToken(t), t).not.toBeNull();
    }
    expect(findQuantitativeToken("10x faster")).toBe("10x");
    for (const t of ["Follow for part two: choosing an index", "Search finds words, not meaning", ""]) {
      expect(findQuantitativeToken(t), t).toBeNull();
    }
  });

  it("suggests the three closest refs for an unresolved claim ref", () => {
    const spec = clone(loadSpec());
    const ir = ContentIR.parse(JSON.parse(read(FIXTURES["content-ir"])));
    spec.scenes[3]!.claim_refs = ["url:https://example.com/vector-db-guide#ann-indx"];
    const res = validateVideoSpecSemantics(spec, ir);
    expect(res.errors).toHaveLength(1);
    const e = res.errors[0]!;
    expect(e.path).toBe("scenes.3.claim_refs.0");
    expect(e.message).toContain("scene s04");
    expect(e.message).toContain("#ann-indx");
    expect(e.fix).toContain("closest existing");
    const suggested = [...e.fix.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(suggested).toHaveLength(3);
    expect(suggested[0]).toBe("url:https://example.com/vector-db-guide#ann-index");
    expect(closestMatches("c2", ["c1", "zzz", "c10"], 2)).toEqual(["c1", "c10"]);
  });

  it("checks scene durations, strategy requirements and scene order", () => {
    const spec = clone(loadSpec());
    spec.scenes[1]!.duration_sec = 0.3;
    spec.scenes[2]!.duration_sec = 16;
    spec.scenes[4]!.visual_strategy = "avatar";
    delete spec.scenes[2]!.visual_requirements.subject;
    spec.scenes[0]!.purpose = "context";
    spec.scenes[5]!.purpose = "payoff";
    spec.goal = "launch";
    spec.target_duration_sec = 36;
    const res = validateVideoSpecSemantics(spec);
    expect(res.errors.map((e) => e.path).sort()).toEqual(["scenes.1.duration_sec", "scenes.2.visual_requirements.subject"]);
    expect(res.warnings.map((w) => w.path).sort()).toEqual([
      "scenes.0.purpose",
      "scenes.2.duration_sec",
      "scenes.4.visual_strategy",
      "scenes.5.purpose",
    ]);
    for (const issue of [...res.errors, ...res.warnings]) expect(issue.fix.length).toBeGreaterThan(5);
  });
});

describe("master, targets, cover and publish (M1/M2)", () => {
  const issues = (spec: VideoSpecT) => {
    const r = validateVideoSpecSemantics(spec);
    return { errors: r.errors.map((e) => e.path), warnings: r.warnings.map((e) => e.path) };
  };

  it("defaults the master to 1080 on the short side at 30 fps", () => {
    expect(defaultMaster("9:16")).toEqual({ width: 1080, height: 1920, fps: 30 });
    expect(defaultMaster("16:9")).toEqual({ width: 1920, height: 1080, fps: 30 });
    expect(defaultMaster("4:5")).toEqual({ width: 1080, height: 1350, fps: 30 });
    expect(resolveMaster({ aspect_ratio: "1:1" })).toEqual({ width: 1080, height: 1080, fps: 30 });
  });

  it("defaults targets to the primary platform's contract", () => {
    expect(resolveTargets({ platform: "instagram_reels" })).toEqual(["instagram"]);
    expect(resolveTargets({ platform: "youtube_shorts" })).toEqual(["youtube-shorts"]);
    expect(resolveTargets({ platform: "generic" })).toEqual([]);
    expect(resolveTargets({ platform: "tiktok", targets: ["tiktok", "instagram", "tiktok"] })).toEqual(["tiktok", "instagram"]);
  });

  it("existing specs without the new fields stay valid", () => {
    expect(validateVideoSpecSemantics(loadSpec()).ok).toBe(true);
  });

  it("accepts a multi-target spec with cover and publish copy", () => {
    const spec = clone(loadSpec());
    Object.assign(spec, {
      master: { width: 1080, height: 1920, fps: 30 },
      targets: ["instagram", "tiktok", "youtube-shorts"],
      cover: { headline: "Search by meaning", focal_time_sec: 1.5 },
      publish: { tiktok: { post_caption: "Vector DBs in 30s", hashtags: ["#ai", "#databases"], ai_disclosure: true } },
    });
    const r = VideoSpec.safeParse(spec);
    expect(r.success).toBe(true);
    expect(issues(spec)).toEqual({ errors: [], warnings: [] });
  });

  it("schema rejects bad fps, hashtags and target ids", () => {
    const spec = loadSpec() as unknown as Record<string, any>;
    spec.master = { width: 1080, height: 1920, fps: 25 };
    spec.targets = ["TikTok"];
    spec.publish = { tiktok: { post_caption: "x", hashtags: ["no hash", "#ok"] } };
    const r = parseYamlOrJson(VideoSpec, JSON.stringify(spec));
    expect(r.ok ? [] : r.errors.map((e) => e.path)).toEqual(expect.arrayContaining(["master.fps", "targets.0", "publish.tiktok.hashtags.0"]));
  });

  it("flags a master that mismatches the aspect ratio or has odd sides", () => {
    const spec = clone(loadSpec());
    spec.master = { width: 1920, height: 1080, fps: 30 };
    expect(issues(spec).errors).toEqual(["master"]);
    spec.master = { width: 1081, height: 1922, fps: 30 };
    expect(validateVideoSpecSemantics(spec).errors.map((e) => e.message).join(" ")).toMatch(/odd dimension/);
  });

  it("flags duplicate targets, a cover after the end, and publish copy for a non-target", () => {
    const spec = clone(loadSpec());
    spec.targets = ["tiktok", "tiktok"];
    spec.cover = { headline: "x", focal_time_sec: 99 };
    spec.publish = { instagram: { post_caption: "x" } };
    expect(issues(spec)).toEqual({ errors: ["targets.1", "cover.focal_time_sec"], warnings: ["publish.instagram"] });
  });
});

describe("Brand v2 (M4)", () => {
  it("parses the v2 blocks and keeps v1 files valid", () => {
    expect(parseYamlOrJson(Brand, read(FIXTURES.brand)).ok).toBe(true);
    const v2 = parseYaml(read(FIXTURES.brand));
    Object.assign(v2, {
      version: 2,
      captions: { family: "Inter", weight: 700, active_word: false, plate_opacity: 0.6, max_lines: 2 },
      motion: { personality: "precise", transition_ms: 250 },
    });
    v2.voice.banned_phrases = ["guaranteed results"];
    Object.assign(v2.visual, {
      weights: { heading: 800, body: 400 },
      font_fallbacks: ["Noto Sans JP"],
      logo_placement: { position: "top_right", max_fraction: 0.12 },
      forbidden: ["drop shadows"],
    });
    const r = Brand.safeParse(v2);
    expect(r.success ? [] : r.error.issues).toEqual([]);
  });

  it("rejects out-of-range v2 values with paths", () => {
    const b = parseYaml(read(FIXTURES.brand));
    b.captions = { weight: 750, plate_opacity: 1.5, max_lines: 4 };
    b.motion = { personality: "wild" };
    const r = parseYamlOrJson(Brand, JSON.stringify(b));
    expect(r.ok ? [] : r.errors.map((e) => e.path)).toEqual(
      expect.arrayContaining(["captions.weight", "captions.plate_opacity", "captions.max_lines", "motion.personality"]),
    );
  });
});

describe("deterministic props and ref suggestions", () => {
  it("validates props per kind with actionable errors", () => {
    const spec = clone(loadSpec());
    spec.scenes[0]!.deterministic!.props = { text: "wrong key" };
    spec.scenes[3]!.deterministic!.props = { nodes: ["a"], edges: [["a", "b"]] };
    spec.scenes[5]!.deterministic!.props = { headline: "Next" };
    const res = validateVideoSpecSemantics(spec);
    const byPath = Object.fromEntries(res.errors.map((e) => [e.path, e]));
    expect(Object.keys(byPath).sort()).toEqual([
      "scenes.0.deterministic.props",
      "scenes.0.deterministic.props.lines",
      "scenes.3.deterministic.props.edges.0",
      "scenes.5.deterministic.props.action",
    ]);
    expect(byPath["scenes.0.deterministic.props.lines"]!.fix).toContain('"lines"');
    expect(byPath["scenes.3.deterministic.props.edges.0"]!.message).toContain('unknown node "b"');
  });

  it("every props example is valid for its kind", () => {
    for (const [kind, example] of Object.entries(DETERMINISTIC_PROPS_EXAMPLES)) {
      expect(DeterministicProps[kind as keyof typeof DeterministicProps].safeParse(example).success, kind).toBe(true);
    }
    expect(DeterministicProps.chart.safeParse({ type: "bar" }).success).toBe(false);
  });

  it("suggests the nearest line block in the same file", () => {
    const refs = ["markdown:README.md#L1", "markdown:README.md#L3-L7", "markdown:README.md#L12-L15", "markdown:OTHER.md#L4-L6", "c1"];
    expect(nearestLineBlock("markdown:README.md#L4-L9", refs)).toBe("markdown:README.md#L3-L7");
    expect(nearestLineBlock("markdown:README.md#L10", refs)).toBe("markdown:README.md#L12-L15");
    expect(nearestLineBlock("repo:x.ts#L1", refs)).toBeNull();
    expect(nearestLineBlock("url:https://x#a", refs)).toBeNull();
  });
});

describe("validateCreativeBriefSemantics", () => {
  const brief = () => CreativeBrief.parse(JSON.parse(read(FIXTURES["creative-brief"])));

  it("warns on too few hooks, unmatched chosen hook, no assumptions, long reels", () => {
    const b = brief();
    const paths = (x: typeof b) => validateCreativeBriefSemantics(x).warnings.map((w) => w.path);
    expect(paths(b)).toEqual(["hook_candidates"]); // example has 2 candidates
    b.hook_candidates.push({ text: "What if search understood you?", mechanism: "question", scores: { clarity: 8 } });
    expect(paths(b)).toEqual([]);
    b.chosen_hook = "Something else entirely";
    b.assumptions = [];
    b.target_duration_sec = 120;
    b.aspect_ratio = "16:9";
    b.hook_candidates[2]!.mechanism = "pain_point";
    expect(paths(b)).toEqual(["hook_candidates", "assumptions", "target_duration_sec", "aspect_ratio"]);
    const res = validateCreativeBriefSemantics(b);
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.path)).toEqual(["chosen_hook"]);
    b.chosen_hook = "  what if search UNDERSTOOD you ";
    expect(validateCreativeBriefSemantics(b).ok).toBe(true);
  });

  it("accepts the new hook mechanisms", () => {
    const b = brief();
    for (const m of ["before_after", "mistake", "contrarian_claim"] as const) b.hook_candidates.push({ text: m, mechanism: m, scores: {} });
    expect(CreativeBrief.safeParse(b).success).toBe(true);
  });
});

describe("Template schema", () => {
  const base = () => parseYaml(read(FIXTURES.template));
  it("rejects beat shares that do not sum to 1 and defaults outside the range", () => {
    const t = base();
    t.beats[0].share += 0.2;
    t.default_duration_sec = 10_000 / 100;
    t.duration_range = { min_sec: 10, max_sec: 60 };
    const r = Template.safeParse(t);
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path.join("."))).toEqual(expect.arrayContaining(["beats", "default_duration_sec"]));
  });
});

describe("generated JSON Schemas", () => {
  // ajv is CommonJS; under NodeNext the default import is the module object, whose `.default` is the class.
  const ajv = new Ajv2020.default({ strict: true, allErrors: true, validateFormats: false });
  const compile = (name: EmittedSchemaName) =>
    ajv.getSchema(`urn:video-studio:schema:${name}`) ?? ajv.compile(toJsonSchema(name));

  for (const [name, file] of Object.entries(FIXTURES) as [EmittedSchemaName, string][]) {
    it(`${name}: ajv accepts the valid fixture and rejects an invalid one`, () => {
      const validate = compile(name);
      const doc = parseYaml(read(file));
      expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
      expect(validate({ ...doc, unexpected_field: true })).toBe(false);
    });
  }

  it("ajv reports the same failing path as zod", () => {
    const validate = compile("video-spec");
    const spec = loadSpec() as unknown as Record<string, any>;
    spec.scenes[1].id = "scene-2";
    expect(validate(spec)).toBe(false);
    expect(validate.errors?.map((e) => e.instancePath)).toContain("/scenes/1/id");
  });

  it("committed schemas/*.schema.json are up to date (run `pnpm schemas`)", () => {
    for (const name of Object.keys(EMITTED_SCHEMAS) as EmittedSchemaName[]) {
      const committed = readFileSync(join(REPO_ROOT, "schemas", `${name}.schema.json`), "utf8");
      expect(committed, name).toBe(renderJsonSchema(name));
    }
  });
});

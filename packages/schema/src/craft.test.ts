import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./emit.js";
import {
  Acceptance,
  CreativeBrief,
  DeterministicProps,
  DETERMINISTIC_PROPS_EXAMPLES,
  ProjectRelativePath,
  Style,
  Template,
  VideoSpec,
  cueItems,
  parseYamlOrJson,
  propsText,
  validateVideoSpecSemantics,
  type VideoSpec as VideoSpecT,
} from "./index.js";

const EXAMPLES = join(REPO_ROOT, "packages/schema/examples");
const read = (f: string) => readFileSync(join(EXAMPLES, f), "utf8");

function loadSpec(): VideoSpecT {
  const r = parseYamlOrJson(VideoSpec, read("explain-vector-db.video-spec.json"));
  if (!r.ok) throw new Error(r.message);
  return structuredClone(r.data);
}

describe("Phase 6.5 contracts: motion kind", () => {
  it("accepts the example props and a spec with a motion scene", () => {
    expect(DeterministicProps.motion.safeParse(DETERMINISTIC_PROPS_EXAMPLES.motion).success).toBe(true);
    const s = loadSpec();
    s.scenes[1]!.visual_strategy = "motion_graphic";
    s.scenes[1]!.deterministic = { kind: "motion", props: { html: "motion/s02.html", text: ["Docs in"], effects: ["flash"], loop: false } };
    expect(VideoSpec.safeParse(s).success).toBe(true);
    const errors = validateVideoSpecSemantics(s).errors.filter((e) => e.path.startsWith("scenes.1.deterministic"));
    expect(errors).toEqual([]);
  });

  it("rejects html outside the project, URLs, non-html files and unknown effects", () => {
    for (const html of ["/etc/passwd.html", "../x.html", "motion/../../x.html", "https://example.com/a.html", "C:\\a.html", "motion/s01.js"]) {
      expect(DeterministicProps.motion.safeParse({ html }).success, html).toBe(false);
    }
    expect(DeterministicProps.motion.safeParse({ html: "a.html", effects: ["sparkles"] }).success).toBe(false);
    expect(DeterministicProps.motion.safeParse({ html: "a.html", script: "x" }).success).toBe(false);
  });

  it("the page's copy is grounded and cued, the file path and effects are not", () => {
    const props = { html: "motion/s01.html", text: ["40% faster", "One command"], effects: ["flash"] };
    expect(propsText(props)).toContain("40% faster");
    expect(propsText(props)).not.toContain("motion/s01.html");
    expect(propsText(props)).not.toContain("flash");
    expect(cueItems("motion", props)).toEqual(["40% faster", "One command"]);
    expect(cueItems("motion", { html: "a.html" })).toEqual([]);
  });

  it("ProjectRelativePath accepts nested relative paths", () => {
    expect(ProjectRelativePath.safeParse("motion/hero/index.html").success).toBe(true);
    expect(ProjectRelativePath.safeParse("./motion/a.html").success).toBe(true);
  });
});

describe("Phase 6.5 contracts: master, audio and acceptance", () => {
  it("accepts loop, downbeat snap, a synth score and acceptance", () => {
    const s = loadSpec();
    s.master = { width: 1080, height: 1920, fps: 30, loop: true };
    s.audio = { music: { file: "synth:pulse", synth: { bpm: 120, key: "Am", progression: ["i", "VI", "III", "VII"], drop_bar: 5, seed: 7 } }, beat_sync: { enabled: true, snap: "downbeat" } };
    s.acceptance = { min_changes_per_sec: 0.8, max_frozen_pct: 10, hold_ms: 400, loop: true };
    expect(VideoSpec.safeParse(s).success).toBe(true);
    expect(validateVideoSpecSemantics(s).warnings.some((w) => w.path === "master.loop")).toBe(false);
  });

  it("warns when acceptance asks for a loop the master doesn't declare", () => {
    const s = loadSpec();
    s.acceptance = { loop: true };
    expect(validateVideoSpecSemantics(s).warnings.some((w) => w.path === "master.loop")).toBe(true);
  });

  it("rejects out-of-range acceptance and synth values", () => {
    expect(Acceptance.safeParse({ max_frozen_pct: 120 }).success).toBe(false);
    const s = loadSpec();
    s.audio = { music: { file: "synth:pulse", synth: { bpm: 300 } } };
    expect(VideoSpec.safeParse(s).success).toBe(false);
    s.audio = { music: { file: "synth:pulse", synth: { bpm: 120, key: "H" } } };
    expect(VideoSpec.safeParse(s).success).toBe(false);
  });

  it("existing specs without the new fields stay valid", () => {
    const s = loadSpec();
    expect(VideoSpec.safeParse(s).success).toBe(true);
    expect(validateVideoSpecSemantics(s).ok).toBe(true);
  });
});

describe("Phase 7 step 0 contract: shot cards", () => {
  const card = { purpose: "plot" as const, action: "She opens the laptop", camera: "slow push-in" };

  it("accepts a shot card on a generated scene and checks chaining", () => {
    const s = loadSpec();
    s.scenes[1]!.visual_strategy = "generated_video";
    delete s.scenes[1]!.deterministic;
    s.scenes[1]!.shot = { ...card, first_frame_from: s.scenes[0]!.id, audio: { sfx: ["keys click"] } };
    expect(VideoSpec.safeParse(s).success).toBe(true);
    expect(validateVideoSpecSemantics(s).errors.filter((e) => e.path.includes(".shot"))).toEqual([]);

    s.scenes[1]!.shot = { ...card, first_frame_from: s.scenes[2]!.id };
    expect(validateVideoSpecSemantics(s).errors.some((e) => e.path === "scenes.1.shot.first_frame_from")).toBe(true);
    s.scenes[1]!.shot = { ...card, first_frame_from: "s99" };
    expect(validateVideoSpecSemantics(s).errors.some((e) => e.path === "scenes.1.shot.first_frame_from")).toBe(true);
  });

  it("warns about a shot card on a non-generated scene; limits SFX to 3; never names a provider", () => {
    const s = loadSpec();
    s.scenes[0]!.shot = card;
    expect(validateVideoSpecSemantics(s).warnings.some((w) => w.path === "scenes.0.shot")).toBe(true);
    s.scenes[0]!.shot = { ...card, audio: { sfx: ["a", "b", "c", "d"] } };
    expect(VideoSpec.safeParse(s).success).toBe(false);
    s.scenes[0]!.shot = { ...card, provider: "x" } as never;
    expect(VideoSpec.safeParse(s).success).toBe(false);
  });
});

describe("Phase 6.5 contracts: style, template and brief", () => {
  it("every style pack still parses, and avoid takes known effects only", () => {
    for (const id of ["minimal", "editorial", "technical", "energetic"]) {
      const raw = parseYaml(readFileSync(join(REPO_ROOT, "styles", `${id}.yaml`), "utf8")) as Record<string, unknown>;
      expect(Style.safeParse(raw).success, id).toBe(true);
      const motion = { ...(raw.motion as object), avoid: ["shake", "lens_flare"] };
      expect(Style.safeParse({ ...raw, motion }).success).toBe(true);
      expect(Style.safeParse({ ...raw, motion: { ...motion, avoid: ["glitter"] } }).success).toBe(false);
    }
  });

  it("templates take inputs and density pacing; choice inputs need options, ids are unique", () => {
    const raw = parseYaml(readFileSync(join(REPO_ROOT, "templates/explain/template.yaml"), "utf8")) as Record<string, unknown>;
    const pacing = { ...(raw.pacing as object), min_changes_per_sec: 0.8, max_frozen_pct: 15 };
    const inputs = [
      { id: "reference", prompt: "A reference video you like?", kind: "file", required: false },
      { id: "music", prompt: "Music?", kind: "choice", required: true, options: ["licensed track", "synthesize one"], default: "synthesize one" },
    ];
    expect(Template.safeParse({ ...raw, pacing, inputs }).success).toBe(true);
    const noOptions = [{ id: "music", prompt: "Music?", kind: "choice", required: true }];
    expect(Template.safeParse({ ...raw, inputs: noOptions }).success).toBe(false);
    expect(Template.safeParse({ ...raw, inputs: [inputs[0], inputs[0]] }).success).toBe(false);
  });

  it("the brief carries acceptance and input answers", () => {
    const raw = JSON.parse(read("explain-vector-db.creative-brief.json")) as Record<string, unknown>;
    const brief = { ...raw, acceptance: { min_changes_per_sec: 1, max_frozen_pct: 5 }, inputs: { reference: "ref/ref.mp4", music: "synthesize one" } };
    expect(CreativeBrief.safeParse(brief).success).toBe(true);
  });
});

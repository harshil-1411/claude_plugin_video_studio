import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./emit.js";
import { ClicheRules, CreativeBrief, ToneRules, VideoSpec, parseYamlOrJson, validateVideoSpecSemantics, type VideoSpec as VideoSpecT } from "./index.js";

// Phase 6.7 contracts: poster on frame 0, automatic cover time, footage A/V offset, tone presets.

function loadSpec(): VideoSpecT {
  const r = parseYamlOrJson(VideoSpec, readFileSync(join(REPO_ROOT, "packages/schema/examples/explain-vector-db.video-spec.json"), "utf8"));
  if (!r.ok) throw new Error(r.message);
  return structuredClone(r.data);
}

describe("cover", () => {
  it("accepts an automatic focal time and a baked poster", () => {
    const s = loadSpec();
    s.cover = { headline: "Docs in, video out", bake_first_frame: true };
    expect(VideoSpec.safeParse(s).success).toBe(true);
    expect(validateVideoSpecSemantics(s).errors).toEqual([]);
  });

  it("refuses a baked poster on a looping piece", () => {
    const s = loadSpec();
    s.master = { width: 1080, height: 1920, fps: 30, loop: true };
    s.cover = { headline: "Loop", focal_time_sec: 1, bake_first_frame: true };
    expect(validateVideoSpecSemantics(s).errors.map((e) => e.path)).toContain("cover.bake_first_frame");
  });
});

describe("footage av_offset_ms", () => {
  it("is bounded to ±2 s", () => {
    const s = loadSpec();
    s.scenes[0]!.footage = { asset: "a1", in_sec: 0, av_offset_ms: 120 };
    expect(VideoSpec.safeParse(s).success).toBe(true);
    s.scenes[0]!.footage.av_offset_ms = 2500;
    expect(VideoSpec.safeParse(s).success).toBe(false);
  });
});

describe("research-specs", () => {
  const read = (f: string) => readFileSync(join(REPO_ROOT, "research-specs", f), "utf8");

  it("tones.yaml and cliches.yaml are valid, and the default tone exists", () => {
    const tones = parseYamlOrJson(ToneRules, read("tones.yaml"));
    expect(tones.ok).toBe(true);
    if (tones.ok) expect(Object.keys(tones.data.presets)).toContain(tones.data.default);
    expect(parseYamlOrJson(ClicheRules, read("cliches.yaml")).ok).toBe(true);
  });
});

describe("CreativeBrief product_flow", () => {
  it("takes 2–4 steps", () => {
    const shape = CreativeBrief.shape.product_flow.unwrap();
    expect(shape.safeParse([{ step: "drops a PDF" }, { step: "sees the reel" }]).success).toBe(true);
    expect(shape.safeParse([{ step: "only one" }]).success).toBe(false);
  });
});

import type { ProviderSpec, ShotCard } from "@video-studio/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { compile, fitDuration, isLockedCamera, lastFramePath, nearestAspect, sentence } from "./compile.js";
import { findProviderSpecsDir, loadProviderSpecs } from "./registry.js";

let specs: Record<string, ProviderSpec>;
beforeAll(async () => {
  specs = Object.fromEntries((await loadProviderSpecs(findProviderSpecsDir({})!)).map((s) => [s.id, s]));
});

const card: ShotCard = {
  purpose: "emotion",
  subjects: [{ id: "hero", role: "identity, wardrobe", asset: "a_hero" }],
  action: "the hero lifts the steaming cup and smiles",
  camera: "slow push in",
  environment: "a rainy cafe window at dusk, one neon sign reflected in the glass",
  look: "35 mm lens, warm tungsten key, soft film grain",
  audio: { dialogue: [{ speaker: "hero", line: "Finally." }], sfx: ["cup clinks on saucer"], ambience: "rain on glass" },
  exclusions: ["no camera shake"],
};
const scene = { id: "s02", duration_sec: 5 };
const spec = { aspect_ratio: "9:16" as const };

describe("helpers", () => {
  it("fits durations to steps or ranges", () => {
    expect(fitDuration(5, { min_sec: 4, max_sec: 8, allowed_sec: [4, 6, 8] })).toBe(6);
    expect(fitDuration(7, { min_sec: 4, max_sec: 8, allowed_sec: [4, 6, 8] })).toBe(8);
    expect(fitDuration(20, { min_sec: 3, max_sec: 15 })).toBe(15);
    expect(fitDuration(5.4, { min_sec: 3, max_sec: 15 })).toBe(5);
    expect(fitDuration(1, { min_sec: 2, max_sec: 10 })).toBe(2);
  });

  it("finds the nearest aspect ratio", () => {
    expect(nearestAspect("9:16", ["16:9", "9:16"])).toBe("9:16");
    expect(nearestAspect("4:5", ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"])).toBe("3:4");
    expect(nearestAspect("9:16", ["16:9"])).toBe("16:9");
  });

  it("formats sentences and recognises a locked camera", () => {
    expect(sentence("  the cup falls ,")).toBe("The cup falls.");
    expect(sentence('she says "no"')).toBe('She says "no"');
    expect(isLockedCamera("Locked")).toBe(true);
    expect(isLockedCamera("static shot")).toBe(true);
    expect(isLockedCamera("slow push in")).toBe(false);
    expect(lastFramePath("s01")).toBe("prompts/frames/s01-last.png");
  });
});

describe("compile", () => {
  it("is deterministic and always carries the verification note", () => {
    for (const id of Object.keys(specs)) {
      const a = compile(card, scene, spec, specs[id]!);
      expect(compile(card, scene, spec, specs[id]!)).toEqual(a);
      expect(a.provider).toBe(id);
      expect(a.verified).toBe(false);
      expect(a.notes[0]).toMatch(/^unverified provider spec \(verified: false, read 2026-09-27\)/);
      expect(a.text.length).toBeGreaterThan(20);
    }
  });

  it("seedance binds references by name and role", () => {
    const r = compile(card, scene, spec, specs.seedance!);
    expect(r.mode).toBe("reference_to_video");
    expect(r.model).toBe("seedance-2.0");
    expect(r.text).toContain("The hero (@Image1) lifts the steaming cup and smiles.");
    expect(r.text).toContain("@Image1 is hero (identity, wardrobe).");
    expect(r.text).toContain('Dialogue: hero says "Finally."');
    expect(r.params).toMatchObject({ duration_sec: 5, aspect_ratio: "9:16", resolution: "720p", audio: true, references: [{ name: "@Image1", subject: "hero", asset: "a_hero" }] });
    expect(r.warnings.map((w) => w.code)).toEqual(["exclusion_dropped"]);
  });

  it("seedance 2.5 uses bracket audio channels", () => {
    const r = compile(card, scene, spec, specs.seedance!, { model: "seedance-2.5" });
    expect(r.text).toContain("{hero: Finally.}");
    expect(r.text).toContain("<cup clinks on saucer>");
    expect(r.text).toContain("(rain on glass)");
  });

  it("veo snaps duration, leads with the camera and compiles negatives", () => {
    const r = compile(card, scene, spec, specs.veo!);
    expect(r.text.startsWith("Slow push in. The hero (reference image 1) lifts")).toBe(true);
    expect(r.text).toContain('Hero says, "Finally."');
    expect(r.text).toContain("SFX: cup clinks on saucer.");
    expect(r.text).toContain("Ambient noise: rain on glass.");
    expect(r.params.duration_sec).toBe(6);
    expect(r.params.negative_prompt).toBe("camera shake, on-screen text, logos, watermarks");
    expect(r.fixes).toContain("duration 5s → 6s");
    expect(r.warnings.map((w) => w.code)).toEqual(["duration", "duration"]); // snapped, and references force 8 s
  });

  it("kling labels the camera first and puts speech after the action", () => {
    const r = compile(card, scene, spec, specs.kling!);
    expect(r.text.startsWith("Camera: slow push in. The hero (@Element1)")).toBe(true);
    expect(r.text.indexOf("lifts")).toBeLessThan(r.text.indexOf('hero says: "Finally."'));
    expect(r.params.cfg_scale).toBe(0.5);
  });

  it("runway rephrases exclusions positively, drops audio and swaps text-to-video to 16:9", () => {
    const r = compile({ ...card, subjects: [], audio: { sfx: ["thunder"] } }, scene, spec, specs.runway!);
    expect(r.mode).toBe("text_to_video");
    expect(r.text.startsWith("Slow push in shot.")).toBe(true);
    expect(r.text).toContain("Smooth, steady camera movement.");
    expect(r.text).not.toMatch(/\bno\b|still/i);
    expect(r.params.aspect_ratio).toBe("16:9");
    expect(r.params.negative_prompt).toBeUndefined();
    expect(r.warnings.map((w) => w.code).sort()).toEqual(["aspect_ratio", "audio_not_native"]);
  });

  it("runway image-to-video from a chained frame describes motion only", () => {
    const r = compile({ ...card, subjects: [], audio: undefined, camera: "locked", first_frame_from: "s01" }, scene, spec, specs.runway!);
    expect(r.mode).toBe("image_to_video");
    expect(r.params.first_frame).toBe("prompts/frames/s01-last.png");
    expect(r.params.aspect_ratio).toBe("9:16");
    expect(r.text).toBe("Locked camera. The camera remains still. The hero lifts the steaming cup and smiles.");
    expect(r.fixes.some((f) => f.includes("motion and camera only"))).toBe(true);
  });

  it("hailuo maps the camera to a bracket command and snaps to 6 or 10 s", () => {
    const r = compile({ ...card, camera: "dolly in slowly" }, { id: "s03", duration_sec: 8 }, { aspect_ratio: "16:9" }, specs.hailuo!);
    expect(r.text.startsWith("[Push in] The hero lifts")).toBe(true);
    expect(r.params.duration_sec).toBe(10);
    expect(r.params.prompt_optimizer).toBe(false);
    expect(r.params.resolution).toBe("768p");
    expect(r.warnings.map((w) => w.code).sort()).toEqual(["audio_not_native", "cast_unbound", "duration", "exclusion_dropped"]);
    expect(compile({ ...card, camera: "locked" }, scene, spec, specs.hailuo!).text.startsWith("[Static shot]")).toBe(true);
    const odd = compile({ ...card, camera: "orbit the table" }, scene, spec, specs.hailuo!);
    expect(odd.warnings.find((w) => w.code === "camera_unmapped")?.fix).toContain("[Truck left]");
  });

  it("wan names characters and warns past the cast limit", () => {
    const crowd: ShotCard = { ...card, subjects: ["a", "b", "c", "d"].map((id) => ({ id, role: "identity", asset: `a_${id}` })), audio: undefined };
    const r = compile(crowd, { id: "s04", duration_sec: 10 }, spec, specs.wan!);
    expect(r.model).toBe("wan2.6-r2v");
    expect((r.params.references as { name: string }[]).map((x) => x.name)).toEqual(["character1", "character2", "character3"]);
    expect(r.warnings.map((w) => w.code)).toContain("cast_limit");
  });

  it("warns when the card breaks director rules, and on an unknown model", () => {
    const r = compile({ ...card, camera: "pan left and then tilt up", action: "the hero holds the logo to the lens" }, scene, spec, specs.kling!, { model: "kling-v9" });
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["camera_compound", "brand_text_in_post", "model_unknown"]));
  });
});

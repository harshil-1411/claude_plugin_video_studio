import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VideoSpec } from "@video-studio/schema";
import { describe, expect, it } from "vitest";
import { PROMPT_PACK_BANNER, formatPromptPack, promptPack } from "./prompt-pack.js";

const EXAMPLE = join(import.meta.dirname, "..", "..", "schema", "examples", "explain-vector-db.video-spec.json");

/** The schema example with scenes 2 and 3 turned into chained generated shots. */
function makeProject(): string {
  const spec = JSON.parse(readFileSync(EXAMPLE, "utf8")) as VideoSpec;
  const [, s2, s3] = spec.scenes;
  for (const s of [s2!, s3!]) {
    s.visual_strategy = "generated_video";
    delete s.deterministic;
  }
  s2!.shot = {
    purpose: "emotion",
    subjects: [{ id: "engineer", role: "identity, wardrobe", asset: "a_engineer" }],
    action: "the engineer leans back from the monitor and exhales",
    camera: "slow push in",
    environment: "a dim office at night, one desk lamp",
    look: "35 mm, warm key, soft grain",
    audio: { sfx: ["chair creaks"] },
    exclusions: ["no camera shake"],
  };
  s3!.shot = { purpose: "plot", action: "the engineer's hand types a short query", camera: "locked", first_frame_from: s2!.id };
  const dir = mkdtempSync(join(tmpdir(), "vs-prompt-pack-"));
  mkdirSync(join(dir, "project"), { recursive: true });
  writeFileSync(join(dir, "project", "video-spec.json"), JSON.stringify(spec, null, 2));
  return dir;
}

describe("promptPack", () => {
  it("writes md + json per family and scene and an index, with credential booleans only", async () => {
    const dir = makeProject();
    const env = { FAL_KEY: "secret-value-123", GEMINI_API_KEY: "${user_config.google_key}" };
    const r = await promptPack(dir, { env });
    expect(r).toMatchObject({ ok: true, kind: "prompt_package", generated: false, spend_usd: 0 });
    expect(r.families.map((f) => f.family)).toEqual(["seedance", "veo", "kling", "wan", "runway", "hailuo"]);
    expect(r.scenes).toEqual(["s02", "s03"]);
    expect(readdirSync(join(dir, "prompts")).sort()).toEqual(["README.md", "hailuo", "kling", "runway", "seedance", "veo", "wan"]);
    expect(readdirSync(join(dir, "prompts", "veo")).sort()).toEqual(["s02.json", "s02.md", "s03.json", "s03.md"]);

    const veo = r.families.find((f) => f.family === "veo")!;
    expect(veo.credentials).toEqual([
      { via: "direct", env: "GEMINI_API_KEY", set: false },
      { via: "fal", env: "FAL_KEY", set: true },
    ]);
    const everything = [readFileSync(r.readme, "utf8"), ...readdirSync(join(dir, "prompts", "veo")).map((f) => readFileSync(join(dir, "prompts", "veo", f), "utf8"))].join("\n");
    expect(everything).not.toContain("secret-value-123");
    expect(everything).toContain(PROMPT_PACK_BANNER);

    const json = JSON.parse(readFileSync(join(dir, "prompts", "kling", "s03.json"), "utf8"));
    expect(json).toMatchObject({ kind: "prompt_package", generated: false, scene_id: "s03", provider: "kling", mode: "image_to_video", verified: false });
    expect(json.params.first_frame).toBe("prompts/frames/s02-last.png");

    const md = readFileSync(join(dir, "prompts", "runway", "s02.md"), "utf8");
    expect(md).toContain("# s02 · Runway Gen-4 / Gen-4.5");
    expect(md).toContain("**unverified**");
    expect(md).toContain("[audio_not_native]");

    const index = readFileSync(r.readme, "utf8");
    expect(index).toContain("## Consistency plan");
    expect(index).toContain("| wan | s03 |");
    expect(index).toContain("FAL_KEY via fal: set");
    expect(formatPromptPack(r)).toMatch(/^Prompt package \(no generation, no spend\): 2 shot\(s\) × 6 families/);
  });

  it("is deterministic and limits families and scenes", async () => {
    const dir = makeProject();
    await promptPack(dir, { families: ["veo", "runway"], scenes: ["s02"] });
    const first = readFileSync(join(dir, "prompts", "veo", "s02.md"), "utf8");
    const r = await promptPack(dir, { families: ["veo", "runway", "veo"], scenes: ["s02"] });
    expect(r.families.map((f) => f.family)).toEqual(["veo", "runway"]);
    expect(readFileSync(join(dir, "prompts", "veo", "s02.md"), "utf8")).toBe(first);
    await expect(promptPack(dir, { scenes: ["s01"] })).rejects.toThrow(/no shot card on scene\(s\) s01; scenes with a shot: s02, s03/);
  });

  it("explains a project without shot cards", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-prompt-pack-"));
    mkdirSync(join(dir, "project"));
    writeFileSync(join(dir, "project", "video-spec.json"), readFileSync(EXAMPLE, "utf8"));
    await expect(promptPack(dir)).rejects.toThrow(/no scene has a shot card/);
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { VideoSpec } from "@video-studio/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkBundledSfx, validateSpecFile } from "./spec-validate.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const EXAMPLE = join(REPO, "examples", "text-to-motion-graphic", "project", "video-spec.json");

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-spec-validate-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const withSfx = (files: string[]) => ({ scenes: [{ id: "s01", sfx: files.map((file) => ({ file, at_sec: 0 })) }] }) as unknown as VideoSpec;

describe("checkBundledSfx", () => {
  it("accepts catalogue ids and project files, and names the closest id for a typo", () => {
    expect(checkBundledSfx(withSfx(["bundled:pop", "assets/sfx/own.wav"]))).toEqual([]);
    const [e] = checkBundledSfx(withSfx(["bundled:pop", "bundled:woosh-soft"]));
    expect(e).toMatchObject({ path: "scenes.0.sfx.1.file", stage: "sfx" });
    expect(e!.message).toMatch(/"bundled:woosh-soft" is not a bundled sound; available: bundled:whoosh-soft/);
    expect(e!.fix).toMatch(/^use "bundled:whoosh-soft"/);
    expect(checkBundledSfx(withSfx(["bundled:pop"]), null)[0]!.message).toMatch(/sfx\/ catalogue, which was not found/);
  });

  it("fails spec validation before the render", async () => {
    const dir = join(tmp, "p", "project");
    await mkdir(dir, { recursive: true });
    const spec = JSON.parse(await readFile(EXAMPLE, "utf8"));
    spec.scenes[0].sfx = [{ file: "bundled:hit-deeep", at_sec: 0 }];
    await writeFile(join(dir, "video-spec.json"), JSON.stringify(spec));
    const r = await validateSpecFile(join(dir, "video-spec.json"), null);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.stage)).toEqual(["sfx"]);
    spec.scenes[0].sfx = [{ file: "bundled:hit-deep", at_sec: 0 }];
    await writeFile(join(dir, "video-spec.json"), JSON.stringify(spec));
    expect((await validateSpecFile(join(dir, "video-spec.json"), null)).errors).toEqual([]);
  });
});

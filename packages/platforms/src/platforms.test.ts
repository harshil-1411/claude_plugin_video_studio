import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkSpecTargets, findPlatformSpecsDir, getContract, intersect, loadContracts, maskCollisions, masksFor, toPx } from "./index.js";

const FIXTURES = join(import.meta.dirname, "__fixtures__", "specs");

describe("contract registry", () => {
  it("loads and validates contracts", async () => {
    const [c, ...rest] = await loadContracts(FIXTURES);
    expect(rest).toHaveLength(0);
    expect(c!.id).toBe("demo-vertical");
    expect(c!.ui_masks).toHaveLength(2);
    expect((await getContract(FIXTURES, "demo-vertical")).name).toBe("Demo Vertical");
  });

  it("names the closest ids for an unknown target", async () => {
    await expect(getContract(FIXTURES, "demo-vert")).rejects.toThrow(/unknown platform target "demo-vert"; available: demo-vertical/);
  });

  it("rejects a contract whose id differs from its file name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-platforms-"));
    writeFileSync(join(dir, "other.yaml"), await readFile(join(FIXTURES, "demo-vertical.yaml"), "utf8"));
    await expect(loadContracts(dir)).rejects.toThrow(/has id "demo-vertical" but is named "other.yaml"/);
  });

  it("rejects invalid contracts with the failing path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-platforms-"));
    const text = (await readFile(join(FIXTURES, "demo-vertical.yaml"), "utf8")).replace("w: 0.15", "w: 0.5");
    writeFileSync(join(dir, "demo-vertical.yaml"), text);
    await expect(loadContracts(dir)).rejects.toThrow(/ui_masks\.0\.rect/);
  });

  it("finds the repo's platform-specs directory", () => {
    expect(findPlatformSpecsDir({})).toMatch(/platform-specs$/);
  });
});

describe("checkSpecTargets", () => {
  it("errors on unknown targets and warns on aspect mismatch", async () => {
    const contracts = await loadContracts(FIXTURES);
    const r = checkSpecTargets({ platform: "tiktok", targets: ["demo-vertical", "demo-vertica1"], aspect_ratio: "16:9" }, contracts);
    expect(r.errors).toEqual([expect.objectContaining({ path: "targets.1", fix: 'use one of "demo-vertical"' })]);
    expect(r.warnings).toEqual([expect.objectContaining({ path: "targets.0", message: expect.stringMatching(/expects 9:16/) })]);
  });

  it("checks the primary platform's contract when targets are absent", () => {
    expect(checkSpecTargets({ platform: "tiktok", aspect_ratio: "9:16" }, []).errors[0]).toMatchObject({ path: "platform" });
    expect(checkSpecTargets({ platform: "generic", aspect_ratio: "9:16" }, [])).toEqual({ errors: [], warnings: [] });
  });
});

describe("geometry", () => {
  it("converts normalized rects to pixels, rounding outward", () => {
    expect(toPx({ x: 0.85, y: 0.4, w: 0.15, h: 0.45 }, 1080, 1920)).toEqual({ x: 918, y: 768, w: 162, h: 864 });
    expect(toPx({ x: 0.1, y: 0.1, w: 0.333, h: 0.333 }, 100, 100)).toEqual({ x: 10, y: 10, w: 34, h: 34 });
  });

  it("intersects rects", () => {
    expect(intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toEqual({ x: 5, y: 5, w: 5, h: 5 });
    expect(intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 })).toBeNull();
  });

  it("finds caption collisions with target masks", async () => {
    const masks = masksFor(await loadContracts(FIXTURES), "9:16");
    expect(masks.map((m) => `${m.target}/${m.id}`)).toEqual(["demo-vertical/rail", "demo-vertical/caption"]);
    expect(masksFor(await loadContracts(FIXTURES), "16:9")).toEqual([]);
    const low = maskCollisions({ x: 90, y: 1600, w: 900, h: 200 }, masks, 1080, 1920);
    expect(low.map((c) => c.mask.id)).toEqual(["rail", "caption"]);
    expect(maskCollisions({ x: 90, y: 1260, w: 800, h: 270 }, masks, 1080, 1920)).toEqual([]);
  });
});

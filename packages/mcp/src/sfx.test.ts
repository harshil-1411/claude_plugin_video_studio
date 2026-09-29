import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashFile } from "@video-studio/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SfxCatalog, bundledSfxIds, findSfxDir, loadSfxCatalog, resolveBundledSfx } from "./sfx.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const IDS = ["whoosh-soft", "whoosh-fast", "riser-1s", "riser-2s", "hit-soft", "hit-deep", "pop", "click", "tick", "key-1", "key-2", "key-3", "chime", "bell-outro", "swipe", "blip-up", "blip-down", "glitch"];

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-sfx-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const catalog = () => loadSfxCatalog(join(REPO, "sfx"))!;

describe("the bundled sfx catalogue", () => {
  it("is found from the module, from a path, and through CLAUDE_PLUGIN_ROOT", () => {
    expect(findSfxDir({})).toBe(join(REPO, "sfx"));
    expect(findSfxDir({ CLAUDE_PLUGIN_ROOT: REPO }, "/")).toBe(join(REPO, "sfx"));
    expect(findSfxDir({}, join(REPO, "dist"))).toBe(join(REPO, "sfx"));
    expect(findSfxDir({ CLAUDE_PLUGIN_ROOT: tmp }, "/")).toBeNull();
    expect(loadSfxCatalog(null)).toBeNull();
    expect(loadSfxCatalog(tmp)).toBeNull();
  });

  it("lists every sound with a CC0 licence, short files and matching hashes", async () => {
    const raw = JSON.parse(await readFile(join(REPO, "sfx", "catalog.json"), "utf8"));
    const c = SfxCatalog.parse(raw);
    expect(c.license.id).toBe("CC0-1.0");
    expect(c.license.source).toMatch(/no samples or third-party recordings/);
    expect(c.sounds.map((s) => s.id).sort()).toEqual([...IDS].sort());
    for (const s of c.sounds) {
      expect(s.duration_ms).toBeLessThanOrEqual(2200);
      expect(s.peak_ms).toBeLessThan(s.duration_ms);
      expect(s.default_db).toBeLessThan(0);
      expect(await hashFile(join(REPO, "sfx", s.file))).toBe(s.sha256);
    }
    expect(bundledSfxIds(c)).toContain("bundled:pop");
  });

  it("has labels that follow the measurements", () => {
    const by = new Map(catalog().sounds.map((s) => [s.id, s]));
    const m = (id: string) => by.get(id)!.measured!;
    expect(by.get("hit-deep")).toMatchObject({ character: "warm", hf_risk: "low", family: "hit" });
    expect(by.get("hit-soft")!.character).toBe("warm");
    for (const bright of ["tick", "glitch"]) {
      expect(by.get(bright)!.character).toBe("bright");
      expect(m(bright).hf_share).toBeGreaterThan(m("hit-deep").hf_share);
      expect(m(bright).high_share).toBeGreaterThan(m("chime").high_share);
    }
    expect(by.get("glitch")!.hf_risk).toBe("high");
    // Risers peak at the end of their swell; hits right at the start.
    expect(by.get("riser-1s")!.peak_ms).toBeGreaterThan(900);
    expect(by.get("riser-2s")!.peak_ms).toBeGreaterThan(1800);
    expect(by.get("hit-soft")!.peak_ms).toBeLessThan(50);
    // Bright, high-risk sounds sit lower than their loudness alone would put them.
    expect(by.get("tick")!.default_db).toBeLessThan(by.get("click")!.default_db);
  });

  it("resolves bundled:<id> and lists the ids for an unknown one", () => {
    const r = resolveBundledSfx("bundled:chime", {}, join(REPO, "sfx"));
    expect(r.path).toBe(join(REPO, "sfx", "chime.wav"));
    expect(r.license.id).toBe("CC0-1.0");
    expect(() => resolveBundledSfx("bundled:nope", {}, join(REPO, "sfx"))).toThrow(/"bundled:nope" is not a bundled sound; use one of bundled:whoosh-soft, bundled:whoosh-fast/);
    expect(() => resolveBundledSfx("bundled:pop", {}, null)).toThrow(/no sfx\/ catalogue found/);
  });
});

describe("scripts/generate-sfx.mjs", () => {
  const run = (out: string) => spawnSync(process.execPath, [join(REPO, "scripts", "generate-sfx.mjs"), "--out", out, "--only", "pop,tick"], { encoding: "utf8" });

  it("is reproducible and measures what it writes", async () => {
    const a = join(tmp, "a");
    const b = join(tmp, "b");
    expect(run(a).status).toBe(0);
    expect(run(b).status).toBe(0);
    const ca = SfxCatalog.parse(JSON.parse(await readFile(join(a, "catalog.json"), "utf8")));
    const cb = SfxCatalog.parse(JSON.parse(await readFile(join(b, "catalog.json"), "utf8")));
    expect(ca.sounds.map((s) => s.id)).toEqual(["pop", "tick"]);
    expect(cb).toEqual(ca);
    for (const s of ca.sounds) {
      expect(await hashFile(join(a, s.file))).toBe(s.sha256);
      expect(await hashFile(join(b, s.file))).toBe(s.sha256);
    }
    // On the ffmpeg build the library was made with, the committed files are reproduced exactly.
    const committed = catalog();
    if (committed.ffmpeg === ca.ffmpeg) {
      for (const s of ca.sounds) expect(s.sha256).toBe(committed.sounds.find((x) => x.id === s.id)!.sha256);
    }
  }, 60_000);
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDENTIALS, ProviderFamily, ProviderSpec, parseYamlOrJson } from "@video-studio/schema";
import { describe, expect, it } from "vitest";
import { findProviderSpecsDir, getProviderSpec, loadProviderSpecs } from "./registry.js";

const dir = findProviderSpecsDir({})!;

describe("provider-specs/", () => {
  it("is found from the package", () => {
    expect(dir).toMatch(/provider-specs$/);
  });

  it("has one spec per family, each a valid ProviderSpec named after its id", async () => {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".yaml")).sort();
    expect(files).toEqual([...ProviderFamily.options].sort().map((f) => `${f}.yaml`));
    for (const file of files) {
      const parsed = parseYamlOrJson(ProviderSpec, await readFile(join(dir, file), "utf8"));
      expect(parsed.ok, `${file}: ${parsed.ok ? "" : parsed.message}`).toBe(true);
      if (parsed.ok) expect(`${parsed.data.id}.yaml`).toBe(file);
    }
  });

  it("uses only registered credentials, stays unverified and never lists Sora", async () => {
    const envs = new Set(CREDENTIALS.map((c) => c.env));
    for (const spec of await loadProviderSpecs(dir)) {
      for (const a of spec.access) expect(envs.has(a.env), `${spec.id}: ${a.env}`).toBe(true);
      expect(spec.verified).toBe(false);
      expect(spec.verified_on).toBe("2026-09-27");
      expect(JSON.stringify(spec).toLowerCase()).not.toContain("sora");
    }
  });

  it("loads specs sorted by id and one by id", async () => {
    const all = await loadProviderSpecs(dir);
    expect(all.map((s) => s.id)).toEqual([...ProviderFamily.options].sort());
    expect((await getProviderSpec(dir, "veo")).duration.allowed_sec).toEqual([4, 6, 8]);
    await expect(getProviderSpec(dir, "sora")).rejects.toThrow(/unknown provider family "sora"/);
  });

  it("rejects a spec whose id does not match its file name", async () => {
    const bad = mkdtempSync(join(tmpdir(), "vs-provider-specs-"));
    writeFileSync(join(bad, "kling.yaml"), (await readFile(join(dir, "veo.yaml"), "utf8")));
    await expect(loadProviderSpecs(bad)).rejects.toThrow(/has id "veo" but is named "kling.yaml"/);
  });
});

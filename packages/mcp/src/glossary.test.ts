import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadProjectGlossary, projectGlossary } from "./glossary.js";

describe("project glossary", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vs-glossary-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("merges the series glossary with the brand's (brand wins a shared term)", async () => {
    await mkdir(join(dir, "project"), { recursive: true });
    await writeFile(join(dir, "project", "video-spec.json"), JSON.stringify({ series: "series.yaml" }));
    await writeFile(join(dir, "series.yaml"), "schema_version: '1.0'\nid: s\nname: S\nglossary:\n  - { term: msb docs, variants: [msp docs] }\n  - { term: RAG }\n");
    await writeFile(join(dir, "brand.yaml"), "version: 2\nbrand: { name: Acme }\nlanguage: { locale: en-US, glossary: [{ term: MSB Docs, variants: [M S B docks] }] }\n");
    const r = await loadProjectGlossary(dir);
    expect(r.warnings).toEqual([]);
    expect(r.glossary).toEqual([{ term: "MSB Docs", variants: ["msp docs", "M S B docks"] }, { term: "RAG" }]);
  });

  it("reports an unreadable series instead of failing, and is empty without brand or series", async () => {
    await writeFile(join(dir, "project", "video-spec.json"), JSON.stringify({ series: "missing.yaml" }));
    const r = await loadProjectGlossary(dir);
    expect(r.warnings.join("\n")).toMatch(/series missing\.yaml not read/);
    expect(projectGlossary(undefined, undefined)).toEqual([]);
  });
});

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "@video-studio/core";
import { ContentIR } from "@video-studio/schema";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { docxExtractor, htmlToBlocks } from "./docx.js";
import { ZipLimitError } from "./office-common.js";
import type { ExtractedSource } from "./types.js";

const fixture = (name: string) => fileURLToPath(new URL(`../../../fixtures/docs/${name}`, import.meta.url));
const docx = fixture("sample.docx");

function asContentIR(ex: ExtractedSource) {
  const source_id = "src_1";
  return ContentIR.parse({
    schema_version: "1.0",
    id: "ir_test",
    created_at: "2026-09-25T00:00:00Z",
    sources: [{ ...ex.source, id: source_id }],
    sections: ex.sections.map((s, i) => ({ ...s, id: `sec_${i + 1}`, source_id })),
    evidence: ex.evidence.map((e) => ({ ...e, source_id })),
    entities: [],
    claims: [],
    assets: ex.assets.map((a, i) => ({ ...a, id: `asset_${i + 1}` })),
    classification: { contains_secrets: false, contains_pii: false, contains_likeness: false, data_class: "public", notes: [] },
    warnings: ex.warnings.map((w) => ({ ...w, source_id })),
  });
}

describe("docxExtractor", () => {
  it("splits sections at headings and keeps pre-heading text", async () => {
    const out = await docxExtractor.extract({ uri: docx, kind: "docx" });
    expect(out.source).toMatchObject({ kind: "docx", title: "Vector DB Notes" });
    expect(out.sections.map((s) => s.heading)).toEqual([undefined, "Overview", "Results"]);
    expect(out.sections[1]?.text).toBe(
      [
        "Vector databases index embeddings.",
        "They answer nearest-neighbour queries quickly.",
        "Fast similarity search",
        "Metadata filtering",
      ].join("\n\n"),
    );
  });

  it("emits paragraph/list/table evidence with para-N refs, selectors and char offsets", async () => {
    const out = await docxExtractor.extract({ uri: docx, kind: "docx" });
    expect(out.evidence.map((e) => e.ref)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => `docx:sample.docx#para-${n}`));
    expect(out.evidence.map((e) => e.locator.selector)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => `#para-${n}`));
    expect(out.evidence[4]?.text).toBe("Metadata filtering");
    expect(out.evidence[6]?.text).toBe("Metric | Value");
    // char offsets index into the owning section's text
    const bySection = [[0], [1, 2, 3, 4], [5, 6, 7]];
    bySection.forEach((idxs, s) => {
      for (const i of idxs) {
        const e = out.evidence[i]!;
        expect(out.sections[s]!.text.slice(e.locator.char_start, e.locator.char_end)).toBe(e.text);
      }
    });
  });

  it("writes embedded images to source/assets with sha256 names when projectDir is given", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vs-docx-"));
    const out = await docxExtractor.extract({ uri: docx, kind: "docx", projectDir });
    expect(out.assets).toHaveLength(1);
    const a = out.assets[0]!;
    expect(a).toMatchObject({ kind: "image", source_ref: "docx:sample.docx#img-1" });
    expect(a.path).toBe(`source/assets/${a.sha256}.png`);
    expect(sha256Hex(await readFile(join(projectDir, a.path)))).toBe(a.sha256);
  });

  it("skips images without a projectDir", async () => {
    const out = await docxExtractor.extract({ uri: docx, kind: "docx" });
    expect(out.assets).toEqual([]);
  });

  it("output conforms to the ContentIR schema", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vs-docx-"));
    const out = await docxExtractor.extract({ uri: docx, kind: "docx", projectDir });
    expect(() => asContentIR(out)).not.toThrow();
  });

  it("rejects an archive with too many entries (zip-bomb guard)", async () => {
    const zip = new JSZip();
    for (let i = 0; i < 5001; i++) zip.file(`x/${i}.xml`, "");
    const path = join(await mkdtemp(join(tmpdir(), "vs-docx-")), "bomb.docx");
    await writeFile(path, await zip.generateAsync({ type: "uint8array", compression: "STORE" }));
    await expect(docxExtractor.extract({ uri: path, kind: "docx" })).rejects.toBeInstanceOf(ZipLimitError);
  });
});

describe("htmlToBlocks", () => {
  it("reads nested lists and never executes markup", () => {
    const blocks = htmlToBlocks(
      '<h2>T</h2><ul><li>a<ul><li>b</li></ul></li></ul><p><script>globalThis.pwned=1</script>c</p>',
    );
    expect(blocks.map((b) => b.text)).toEqual(["T", "a", "b", "globalThis.pwned=1c"]);
    expect((globalThis as Record<string, unknown>)["pwned"]).toBeUndefined();
  });
});

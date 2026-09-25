import { fileURLToPath } from "node:url";
import { ContentIR } from "@video-studio/schema";
import { describe, expect, it } from "vitest";
import { pageParagraphs, pdfExtractor } from "./pdf.js";
import type { ExtractedSource } from "./types.js";

const fixture = (name: string) => fileURLToPath(new URL(`../../../fixtures/docs/${name}`, import.meta.url));

/** Assemble a minimal ContentIR from one ExtractedSource and validate it with the real schema. */
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
    classification: {
      contains_secrets: false,
      contains_pii: false,
      contains_likeness: false,
      data_class: "public",
      notes: [],
    },
    warnings: ex.warnings.map((w) => ({ ...w, source_id })),
  });
}

describe("pdfExtractor", () => {
  it("extracts per-page evidence with page locators and pdf:<file>#pN refs", async () => {
    const out = await pdfExtractor.extract({ uri: fixture("sample.pdf"), kind: "pdf" });
    expect(out.source).toMatchObject({ kind: "pdf", title: "Vector DB Whitepaper" });
    expect(out.source.sha256).toMatch(/^[a-f0-9]{64}$/);

    const refs = out.evidence.map((e) => e.ref);
    expect(refs).toEqual([
      "pdf:sample.pdf#p1.para-1",
      "pdf:sample.pdf#p1.para-2",
      "pdf:sample.pdf#p2.para-1",
      "pdf:sample.pdf#p2.para-2",
    ]);
    expect(out.evidence.map((e) => e.locator.page)).toEqual([1, 1, 2, 2]);
    expect(out.evidence[1]?.text).toBe(
      "Vector databases store embeddings for fast similarity search. They power retrieval for AI apps.",
    );
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("merges consecutive short pages into one section and detects a heading", async () => {
    const out = await pdfExtractor.extract({ uri: fixture("sample.pdf"), kind: "pdf" });
    expect(out.sections).toHaveLength(1);
    expect(out.sections[0]?.heading).toBe("Introduction");
    expect(out.sections[0]?.text).toContain("Benchmarks");
    expect(out.sections[0]?.text).toContain("Query latency dropped 42%");
  });

  it("warns scanned_pdf for pages with (almost) no text", async () => {
    const out = await pdfExtractor.extract({ uri: fixture("sample.pdf"), kind: "pdf" });
    const w = out.warnings.find((x) => x.code === "scanned_pdf");
    expect(w?.message).toMatch(/pages 3\b/);
    expect(out.evidence.some((e) => e.locator.page === 3)).toBe(false);
  });

  it("output conforms to the ContentIR schema", async () => {
    const out = await pdfExtractor.extract({ uri: fixture("sample.pdf"), kind: "pdf" });
    expect(() => asContentIR(out)).not.toThrow();
  });
});

describe("pageParagraphs", () => {
  it("splits on blank lines, rejoins hyphenation and isolates heading lines", () => {
    const raw = "Setup\nInstall the pack-\nage first.\n\nThen run it.";
    expect(pageParagraphs(raw)).toEqual(["Setup", "Install the package first.", "Then run it."]);
  });

  it("returns nothing for whitespace-only pages", () => {
    expect(pageParagraphs("  \n \n")).toEqual([]);
  });
});

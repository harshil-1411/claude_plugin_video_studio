import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "@video-studio/core";
import { ContentIR } from "@video-studio/schema";
import { describe, expect, it } from "vitest";
import { pptxExtractor, readNotesXml, readSlideXml } from "./pptx.js";
import type { ExtractedSource } from "./types.js";

const fixture = (name: string) => fileURLToPath(new URL(`../../../fixtures/docs/${name}`, import.meta.url));
const pptx = fixture("sample.pptx");

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

describe("pptxExtractor", () => {
  it("produces one section per slide in numeric order with title headings", async () => {
    const out = await pptxExtractor.extract({ uri: pptx, kind: "pptx" });
    expect(out.source).toMatchObject({ kind: "pptx", title: "Vector DB Deck" });
    expect(out.sections.map((s) => s.heading)).toEqual(["Vector Databases", "How it works", "Results"]);
    expect(out.sections[1]?.text).toBe("Embed the data\n\nIndex with HNSW\n\nQuery by similarity");
    // non-placeholder text box on slide 3 is captured
    expect(out.sections[2]?.text).toBe("Latency fell 42%");
  });

  it("emits paragraph evidence with slide locators and pptx:<file>#sN refs", async () => {
    const out = await pptxExtractor.extract({ uri: pptx, kind: "pptx" });
    const slide2 = out.evidence.filter((e) => e.locator.slide === 2);
    expect(slide2.map((e) => e.ref)).toEqual([
      "pptx:sample.pptx#s2.para-1",
      "pptx:sample.pptx#s2.para-2",
      "pptx:sample.pptx#s2.para-3",
      "pptx:sample.pptx#s2.para-4",
      "pptx:sample.pptx#s2.notes",
    ]);
    expect(slide2[0]?.text).toBe("How it works");
    const refs = out.evidence.map((e) => e.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("captures speaker notes as separate spans (body placeholder only)", async () => {
    const out = await pptxExtractor.extract({ uri: pptx, kind: "pptx" });
    const notes = out.evidence.filter((e) => e.ref.endsWith(".notes"));
    expect(notes.map((n) => [n.locator.slide, n.text])).toEqual([
      [1, "Open with the problem: keyword search misses meaning."],
      [2, "Mention that HNSW is a graph index."],
      [3, "Close with the call to action."],
    ]);
  });

  it("extracts slide media into source/assets when projectDir is given", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vs-pptx-"));
    const out = await pptxExtractor.extract({ uri: pptx, kind: "pptx", projectDir });
    expect(out.assets).toHaveLength(1);
    const a = out.assets[0]!;
    expect(a).toMatchObject({ kind: "image", source_ref: "pptx:sample.pptx#s2" });
    expect(a.path).toBe(`source/assets/${a.sha256}.png`);
    expect(sha256Hex(await readFile(join(projectDir, a.path)))).toBe(a.sha256);
    expect(() => asContentIR(out)).not.toThrow();
  });

  it("output conforms to the ContentIR schema", async () => {
    const out = await pptxExtractor.extract({ uri: pptx, kind: "pptx" });
    expect(out.assets).toEqual([]);
    expect(() => asContentIR(out)).not.toThrow();
  });
});

describe("slide XML parsing", () => {
  const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
  const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
  const sp = (ph: string, ...runs: string[][]) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:txBody>` +
    runs.map((r) => `<a:p>${r.map((t) => `<a:r><a:t>${t}</a:t></a:r>`).join("")}</a:p>`).join("") +
    `</p:txBody></p:sp>`;
  const wrap = (root: string, body: string) =>
    `<${root} xmlns:a="${A}" xmlns:p="${P}"><p:cSld><p:spTree>${body}</p:spTree></p:cSld></${root}>`;

  it("joins runs within a paragraph and finds the title placeholder anywhere", () => {
    const s = readSlideXml(wrap("p:sld", sp("", ["Bo", "dy"]) + sp('<p:ph type="title"/>', ["Ti", "tle"])));
    expect(s.title).toBe("Title");
    expect(s.paragraphs).toEqual(["Title", "Body"]);
    expect(s.titleParagraphs).toBe(1);
  });

  it("rejects DOCTYPE (no entity expansion)", () => {
    expect(() => readSlideXml(`<!DOCTYPE x [<!ENTITY a "b">]>${wrap("p:sld", "")}`)).toThrow();
  });

  it("notes ignore slide-number placeholders", () => {
    const xml = wrap("p:notes", sp('<p:ph type="body"/>', ["Say this"]) + sp('<p:ph type="sldNum"/>', ["7"]));
    expect(readNotesXml(xml)).toBe("Say this");
  });
});

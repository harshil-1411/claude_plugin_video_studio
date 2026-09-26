import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContentIR } from "@video-studio/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compactJson } from "./output.js";
import { evidenceBySection, formatSourceSection, formatSourceSummary, irSection, sourceSection, summarizeIr, summarizeSource } from "./source-summary.js";

const GOLDEN = resolve(dirname(fileURLToPath(import.meta.url)), "../../../tests/golden/__golden__");
const cases = readdirSync(GOLDEN).filter((f) => f.endsWith(".content-ir.json"));
const load = (f: string) => JSON.parse(readFileSync(join(GOLDEN, f), "utf8")) as ContentIR;

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-source-summary-"));
});
afterAll(() => rm(tmp, { recursive: true, force: true }));

async function project(ir: unknown, name: string): Promise<string> {
  const dir = join(tmp, name);
  await mkdir(join(dir, "source"), { recursive: true });
  await writeFile(join(dir, "source", "content-ir.json"), JSON.stringify(ir));
  return dir;
}

describe("source_summary on the golden ingest fixtures", () => {
  it("covers all 10 fixtures", () => expect(cases).toHaveLength(10));

  for (const f of cases) {
    it(`${f.replace(".content-ir.json", "")}: outline, sections and refs`, async () => {
      const ir = load(f);
      const dir = await project(ir, f);
      const s = await summarizeSource(dir);
      expect(s.counts).toEqual({
        sources: ir.sources.length,
        sections: ir.sections.length,
        evidence: ir.evidence.length,
        entities: ir.entities.length,
        claims: ir.claims.length,
        assets: ir.assets.length,
        warnings: ir.warnings.length,
      });
      expect(s.sections.map((x) => x.id)).toEqual(ir.sections.map((x) => x.id));
      expect(s.claims.map((x) => x.id)).toEqual(ir.claims.map((x) => x.id));
      expect(s.assets.map((x) => x.id)).toEqual(ir.assets.map((x) => x.id));
      expect(s.classification).toEqual(ir.classification);
      // Every listed ref is a real evidence ref, and each section's refs sit inside its text.
      const refs = new Set(ir.evidence.map((e) => e.ref));
      for (const sec of s.sections) {
        for (const r of sec.refs) expect(refs.has(r)).toBe(true);
        const full = ir.sections.find((x) => x.id === sec.id)!;
        expect(sec.chars).toBe(full.text.length);
      }
      for (const c of s.claims) {
        expect(c.text.length).toBeLessThanOrEqual(200);
        for (const r of c.refs) expect(refs.has(r)).toBe(true);
      }
      expect(formatSourceSummary(s)).toMatch(/^ContentIR ir-/);
      // The outline is smaller than the file (except for trivially small IRs).
      if (ir.sections.length > 2) expect(compactJson(s).length).toBeLessThan(JSON.stringify(ir, null, 2).length);

      // source_section returns each section's full text and its evidence.
      for (const sec of ir.sections) {
        const r = await sourceSection(dir, sec.id);
        expect(r.text).toBe(sec.text);
        expect(r.truncated).toBeUndefined();
        expect(formatSourceSection(r)).toContain(sec.id);
      }
      // Looking up by evidence ref lands in the section containing that span.
      const bySec = evidenceBySection(ir);
      for (const e of ir.evidence) {
        const owner = [...bySec.entries()].find(([, list]) => list.includes(e))?.[0];
        if (!owner) continue;
        const r = irSection(ir, e.ref);
        expect(r.id).toBe(owner);
        expect(r.matched_ref).toBe(e.ref);
        expect(r.evidence.map((x) => x.ref)).toContain(e.ref);
      }
    });
  }

  it("maps nearly every evidence span to a section", () => {
    let total = 0;
    let mapped = 0;
    for (const f of cases) {
      const ir = load(f);
      total += ir.evidence.length;
      mapped += [...evidenceBySection(ir).values()].reduce((n, l) => n + l.length, 0);
    }
    expect(mapped / total).toBeGreaterThan(0.95);
  });

  it("markup, headings and speaker notes still land in the right section", () => {
    const deck = load("pptx-deck.content-ir.json");
    expect(irSection(deck, "pptx:sample.pptx#s2.notes").id).toBe("sec-2");
    expect(irSection(deck, "pptx:sample.pptx#s3.para-1").id).toBe("sec-3");
    const md = load("markdown-article.content-ir.json");
    expect(irSection(md, "markdown:article.md#L18").evidence.map((e) => e.ref)).toContain("markdown:article.md#L18");
  });

  it("claims citing a section's evidence come with the section", () => {
    const ir = load("markdown-article.content-ir.json");
    const r = irSection(ir, "sec-2");
    expect(r.claims.map((c) => c.id)).toContain("claim-2");
    expect(r.prev).toBe("sec-1");
    expect(r.next).toBe("sec-3");
  });
});

describe("source_summary limits", () => {
  const big = (): ContentIR => {
    const base = load("markdown-article.content-ir.json");
    const sections = Array.from({ length: 30 }, (_, i) => ({ id: `sec-${i + 1}`, source_id: "src-1", heading: `Part ${i + 1}`, text: `Paragraph ${i + 1} says ${"x".repeat(50)} and more. `.repeat(40) }));
    const evidence = sections.map((s, i) => ({ ref: `markdown:a.md#L${i + 1}`, source_id: "src-1", text: `Paragraph ${i + 1} says`, locator: { line_start: i + 1 } }));
    const claims = sections.map((s, i) => ({ id: `claim-${i + 1}`, text: `Claim ${i + 1} ${"y".repeat(400)}`, kind: "qualitative" as const, evidence_refs: [evidence[i]!.ref] }));
    return { ...base, sections, evidence, claims };
  };

  it("caps sections and claims, cuts claim text, and says how to get the rest", () => {
    const s = summarizeIr(big(), { maxSections: 10, maxClaims: 5, maxEvidencePerSection: 1 });
    expect(s.sections).toHaveLength(10);
    expect(s.sections_omitted).toBe(20);
    expect(s.claims).toHaveLength(5);
    expect(s.claims_omitted).toBe(25);
    expect(s.claims[0]!.text.length).toBeLessThanOrEqual(200);
    expect(s.sections[3]!.refs).toEqual(["markdown:a.md#L4"]);
    expect(s.detail).toMatch(/source_section/);
    expect(s.detail).toMatch(/20 more section/);
  });

  it("pages a long section with offset", () => {
    const ir = big();
    const r = irSection(ir, "sec-1", { max_chars: 1000 });
    expect(r.text).toHaveLength(1000);
    expect(r.truncated).toBe(true);
    const r2 = irSection(ir, "sec-1", { max_chars: 1000, offset: 1000 });
    expect(r2.offset).toBe(1000);
    expect(r.text + r2.text).toBe(ir.sections[0]!.text.slice(0, 2000));
    expect(formatSourceSection(r)).toMatch(/offset 1000/);
  });

  it("filters by source and explains bad ids", async () => {
    const ir = big();
    expect(() => summarizeIr(ir, { source_id: "src-9" })).toThrow(/no source "src-9".*src-1/);
    expect(() => irSection(ir, "sec-99")).toThrow(/no section or evidence ref "sec-99"/);
    await expect(summarizeSource(join(tmp, "missing"))).rejects.toThrow(/ingest the sources first/);
    const bad = await project({ nope: true }, "bad");
    await expect(summarizeSource(bad)).rejects.toThrow(/not a valid ContentIR/);
  });
});

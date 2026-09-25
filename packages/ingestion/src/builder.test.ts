import { describe, expect, it } from "vitest";
import { ContentIR } from "@video-studio/schema";
import { ContentIRValidationError, buildContentIR, isQuantitative, splitSentences } from "./builder.js";
import { markdownExtractor } from "./markdown.js";
import { textExtractor } from "./text.js";
import type { ExtractedSource } from "./types.js";

const NOW = "2026-09-25T00:00:00.000Z";
const MD = `# Widgetron Launch

Widgetron renders videos 3x faster than v1. Setup takes under 5 minutes.

## Pricing

- Pro costs $29 per month.
- Teams save 20% on annual plans.

\`\`\`sh
npx widgetron --workers 16
\`\`\`
`;

async function parts(): Promise<ExtractedSource[]> {
  const a = await markdownExtractor.extract({ uri: "/p/README.md", kind: "markdown", content: MD, projectDir: "/p" });
  const b = await markdownExtractor.extract({ uri: "/p/README.md", kind: "markdown", content: MD, projectDir: "/p" });
  const t = "Contact ops@acme-corp.io for access.\n\nAWS_KEY=" + "AKIA" + "IOSFODNN7EXAMPLE";
  const c = await textExtractor.extract({ uri: t, kind: "text", content: t });
  return [a, b, c];
}

describe("buildContentIR", () => {
  it("produces a schema-valid IR with unique refs, ids, claims and classification", async () => {
    const ir = buildContentIR(await parts(), { now: NOW });
    expect(ContentIR.safeParse(ir).success).toBe(true);
    expect(ir.id).toMatch(/^ir-[0-9a-f]{12}$/);
    expect(ir.sources.map((s) => s.id)).toEqual(["src-1", "src-2", "src-3"]);
    expect(ir.sections[0]).toMatchObject({ id: "sec-1", source_id: "src-1", heading: "Widgetron Launch" });

    const refs = ir.evidence.map((e) => e.ref);
    expect(new Set(refs).size).toBe(refs.length);
    // The duplicate source's refs are suffixed.
    expect(refs).toContain("markdown:README.md#L3");
    expect(refs).toContain("markdown:README.md#L3-2");

    const claims = ir.claims.filter((c) => c.evidence_refs.includes("markdown:README.md#L3"));
    expect(claims.map((c) => c.text)).toEqual([
      "Widgetron renders videos 3x faster than v1.",
      "Setup takes under 5 minutes.",
    ]);
    expect(ir.claims.map((c) => c.text)).toContain("Pro costs $29 per month.");
    expect(ir.claims.map((c) => c.text)).toContain("Teams save 20% on annual plans.");
    expect(ir.claims.some((c) => c.text.includes("npx"))).toBe(false);
    for (const c of ir.claims) for (const r of c.evidence_refs) expect(refs).toContain(r);

    // "Widgetron" is a plain capitalized word, so no product-like entity is derived here.
    expect(ir.entities).toEqual([]);
    expect(ir.classification).toMatchObject({ contains_secrets: true, contains_pii: true, data_class: "restricted" });
    expect(ir.classification.notes.every((n) => n.startsWith("src-3: "))).toBe(true);
    expect(ir).toMatchSnapshot();
  });

  it("is deterministic for the same input and options", async () => {
    const a = buildContentIR(await parts(), { now: NOW });
    const b = buildContentIR(await parts(), { now: NOW });
    expect(a).toEqual(b);
  });

  it("derives product entities from titles and headings", async () => {
    const md = "# Launching ContentIR with GitHub\n\nThe ContentIR format ships today.\n\n## HyperFrames API\n\nRenders scenes.\n";
    const p = await markdownExtractor.extract({ uri: "x.md", kind: "markdown", content: md });
    const ir = buildContentIR([p], { now: NOW, id: "ir-test" });
    expect(ir.entities.map((e) => [e.name, e.kind])).toEqual([
      ["ContentIR", "product"],
      ["GitHub", "product"],
      ["HyperFrames", "product"],
      ["API", "technology"],
    ]);
    expect(ir.entities[0]!.evidence_refs).toEqual(["markdown:x.md#L3"]);
  });

  it("throws readable issues for invalid input", () => {
    const bad: ExtractedSource = {
      source: { kind: "text", uri: "x", sha256: "not-a-hash" },
      sections: [],
      evidence: [],
      assets: [],
      warnings: [],
    };
    expect(() => buildContentIR([bad], { now: NOW })).toThrow(ContentIRValidationError);
    expect(() => buildContentIR([bad], { now: NOW })).toThrow(/sources\.0\.sha256/);
    expect(() => buildContentIR([])).toThrow(/at least one/);
  });
});

describe("claim heuristics", () => {
  it("recognizes quantitative sentences", () => {
    expect(isQuantitative("Latency fell to 12 ms.")).toBe(true);
    expect(isQuantitative("Costs $1,200 per month.")).toBe(true);
    expect(isQuantitative("Recall is 95%.")).toBe(true);
    expect(isQuantitative("Founded in 2019.")).toBe(true);
    expect(isQuantitative("Uses the v2 API with node22.")).toBe(false);
    expect(isQuantitative("A plain qualitative sentence.")).toBe(false);
  });

  it("splits sentences and list items", () => {
    expect(splitSentences("One sentence. Two sentence!\n- item 1\n- item 2")).toEqual(["One sentence.", "Two sentence!", "item 1", "item 2"]);
  });
});

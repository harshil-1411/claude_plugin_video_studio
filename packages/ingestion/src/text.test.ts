import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { textExtractor } from "./text.js";

const SAMPLE = `Quarterly Update

Revenue grew 23% year over year, reaching $4.2 million.
Churn stayed flat.

Next Steps

- Hire two engineers
- Ship the v2 API

Thanks for reading!`;

describe("textExtractor", () => {
  it("splits inline text into heuristic sections with paragraph spans", async () => {
    const out = await textExtractor.extract({ uri: SAMPLE, kind: "text", content: SAMPLE });
    expect(out.source.title).toBe("Quarterly Update");
    expect(out.source.uri).toMatch(/^inline:inline-[0-9a-f]{12}$/);
    expect(out.sections.map((s) => s.heading)).toEqual(["Quarterly Update", "Next Steps"]);
    expect(out.evidence).toHaveLength(3);
    for (const e of out.evidence) {
      expect(SAMPLE.slice(e.locator.char_start, e.locator.char_end)).toBe(e.text);
      expect(e.ref).toMatch(/^text:inline-[0-9a-f]{12}#c\d+-\d+$/);
    }
    expect(out.evidence[0]!.locator).toMatchObject({ line_start: 3, line_end: 4, selector: "#quarterly-update" });
    expect(out.sections[0]!.text).toBe("Revenue grew 23% year over year, reaching $4.2 million. Churn stayed flat.");
    expect(out.sections[1]!.text).toBe("- Hire two engineers\n- Ship the v2 API\n\nThanks for reading!");
    expect(out).toMatchSnapshot();
  });

  it("reads files, normalizes CRLF and uses line refs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-text-"));
    const file = join(dir, "notes.txt");
    writeFileSync(file, "first line\r\nsecond line\r\n\r\nthird paragraph\r\n");
    const out = await textExtractor.extract({ uri: file, kind: "text", projectDir: dir });
    expect(out.source.uri).toBe(file);
    expect(out.evidence.map((e) => e.ref)).toEqual(["text:notes.txt#L1-L2", "text:notes.txt#L4"]);
    expect(out.evidence[0]!.text).toBe("first line\nsecond line");
    expect(out.source.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("warns on empty input", async () => {
    const out = await textExtractor.extract({ uri: "", kind: "text", content: "   \n\n" });
    expect(out.warnings.map((w) => w.code)).toEqual(["empty_source"]);
  });
});

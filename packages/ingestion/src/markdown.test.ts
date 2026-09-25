import { describe, expect, it } from "vitest";
import { markdownExtractor, parseMarkdown, stripInline } from "./markdown.js";

const DOC = `---
title: Widgetron Guide
tags: [video, cli]
---
Intro paragraph with a [link](https://example.com) and **bold** text.

# Overview

Widgetron renders videos 3x faster.
It wraps lines.

Setext Heading
--------------

- item one
- item two

- item three after a blank line

\`\`\`ts
// # not a heading
const x = 1;

console.log(x);
\`\`\`

## Overview ##

> quoted *text*

| a | b |
|---|---|
| 1 | 2 |

~~~
unterminated fence
`;

describe("parseMarkdown", () => {
  it("handles front matter, ATX/setext headings, fences and loose lists", () => {
    const p = parseMarkdown(DOC);
    expect(p.title).toBe("Widgetron Guide");
    expect(p.frontMatter?.data).toEqual({ title: "Widgetron Guide", tags: ["video", "cli"] });
    expect(p.sections.map((s) => [s.heading, s.level, s.slug])).toEqual([
      [undefined, 0, undefined],
      ["Overview", 1, "overview"],
      ["Setext Heading", 2, "setext-heading"],
      ["Overview", 2, "overview-2"],
    ]);
    const setext = p.sections[2]!;
    expect(setext.blocks.map((b) => b.type)).toEqual(["list", "code"]);
    expect(setext.blocks[0]!.raw).toBe("- item one\n- item two\n\n- item three after a blank line");
    const code = setext.blocks[1]!;
    expect(code.raw).toBe("```ts\n// # not a heading\nconst x = 1;\n\nconsole.log(x);\n```");
    expect(code.text).toBe(code.raw);
    const last = p.sections[3]!;
    expect(last.blocks.map((b) => b.type)).toEqual(["quote", "table", "code"]);
    expect(last.blocks[2]!.raw).toBe("~~~\nunterminated fence\n");
    for (const s of p.sections)
      for (const b of s.blocks) expect(DOC.slice(b.charStart, b.charEnd)).toBe(b.raw);
  });

  it("strips inline markdown", () => {
    expect(stripInline("A [link](u) with **bold**, *em*, `code` and snake_case_name ![alt](i.png)")).toBe(
      "A link with bold, em, code and snake_case_name alt",
    );
  });
});

describe("markdownExtractor", () => {
  it("emits sections and line-located evidence", async () => {
    const out = await markdownExtractor.extract({ uri: "/proj/docs/guide.md", kind: "markdown", content: DOC, projectDir: "/proj" });
    expect(out.source).toMatchObject({ kind: "markdown", uri: "/proj/docs/guide.md", title: "Widgetron Guide" });
    expect(out.sections[0]).toEqual({ heading: "Front matter", text: "title: Widgetron Guide\ntags:\n  - video\n  - cli" });
    expect(out.evidence.map((e) => e.ref)).toEqual([
      "markdown:docs/guide.md#L1-L4",
      "markdown:docs/guide.md#L5",
      "markdown:docs/guide.md#L9-L10",
      "markdown:docs/guide.md#L15-L18",
      "markdown:docs/guide.md#L20-L25",
      "markdown:docs/guide.md#L29",
      "markdown:docs/guide.md#L31-L33",
      "markdown:docs/guide.md#L35-L37",
    ]);
    expect(out.evidence[2]!.locator).toEqual({ line_start: 9, line_end: 10, char_start: expect.any(Number), char_end: expect.any(Number), selector: "#overview" });
    expect(out.warnings).toEqual([]);
    expect(out).toMatchSnapshot();
  });

  it("warns on invalid front matter", async () => {
    const out = await markdownExtractor.extract({ uri: "x", kind: "markdown", content: "---\na: [unclosed\n---\n# T\n\nbody\n" });
    expect(out.warnings.map((w) => w.code)).toContain("front_matter_invalid");
    expect(out.source.title).toBe("T");
  });
});

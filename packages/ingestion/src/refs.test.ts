import { describe, expect, it } from "vitest";
import { SourceRef } from "@video-studio/schema";
import { RefRegistry, createSlugger, displayPath, fileRef, inlineKey, repoRef, slugify, textRef, uniquify, urlRef } from "./refs.js";

describe("refs", () => {
  it("builds refs matching the SourceRef schema", () => {
    const refs = [
      repoRef("src/a.ts", 10, 20),
      repoRef("src/a.ts", 7),
      repoRef("src/a.ts", 7, 7),
      urlRef("https://example.com/docs?x=1#old", "install"),
      urlRef("https://example.com/docs"),
      fileRef("pdf", "report.pdf", { page: 3 }),
      fileRef("pptx", "deck.pptx", { slide: 4 }),
      fileRef("markdown", "docs/My File.md", { line_start: 3, line_end: 9 }),
      fileRef("docx", "memo.docx", "para-12"),
      textRef(0, 0, 120),
      textRef(inlineKey("hello"), 5, 9),
    ];
    expect(refs).toEqual([
      "repo:src/a.ts#L10-L20",
      "repo:src/a.ts#L7",
      "repo:src/a.ts#L7",
      "url:https://example.com/docs?x=1#install",
      "url:https://example.com/docs",
      "pdf:report.pdf#p3",
      "pptx:deck.pptx#s4",
      "markdown:docs/My%20File.md#L3-L9",
      "docx:memo.docx#para-12",
      "text:0#c0-120",
      `text:${inlineKey("hello")}#c5-9`,
    ]);
    for (const r of refs) expect(SourceRef.safeParse(r).success, r).toBe(true);
  });

  it("slugifies deterministically", () => {
    expect(slugify("Getting Started!")).toBe("getting-started");
    expect(slugify("  Café & Crème — `v2.0` ")).toBe("cafe-creme-v2-0");
    expect(slugify("***")).toBe("section");
    expect(slugify("日本語 見出し")).toBe("日本語-見出し");
  });

  it("uniquifies slugs and refs with -2, -3", () => {
    const slug = createSlugger();
    expect([slug("Intro"), slug("Intro"), slug("intro"), slug("Other")]).toEqual(["intro", "intro-2", "intro-3", "other"]);
    const reg = new RefRegistry();
    expect([reg.claim("url:a#x"), reg.claim("url:a#x"), reg.claim("url:a#x"), reg.claim("url:a#y")]).toEqual([
      "url:a#x",
      "url:a#x-2",
      "url:a#x-3",
      "url:a#y",
    ]);
    const used = new Set(["a", "a-2"]);
    expect(uniquify("a", used)).toBe("a-3");
  });

  it("uses project-relative or base names for display paths", () => {
    expect(displayPath("/proj/docs/a.md", "/proj")).toBe("docs/a.md");
    expect(displayPath("/elsewhere/a.md", "/proj")).toBe("a.md");
    expect(displayPath("docs/a.md")).toBe("docs/a.md");
  });
});

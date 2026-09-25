import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectKind } from "./detect.js";

describe("detectKind", () => {
  it("detects URLs and GitHub repos", () => {
    expect(detectKind("https://example.com/post")).toBe("url");
    expect(detectKind("http://example.com")).toBe("url");
    expect(detectKind("https://github.com/acme/widgetron")).toBe("repo");
    expect(detectKind("https://github.com/acme/widgetron.git")).toBe("repo");
    expect(detectKind("https://github.com/acme/widgetron/tree/main/docs")).toBe("repo");
    expect(detectKind("https://github.com/acme/widgetron/blob/main/README.md")).toBe("url");
    expect(detectKind("https://github.com/acme")).toBe("url");
  });

  it("detects repo directories and files by extension", () => {
    const root = mkdtempSync(join(tmpdir(), "vs-detect-"));
    const repo = join(root, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "README.md"), "# hi");
    const git = join(root, "git");
    mkdirSync(join(git, ".git"), { recursive: true });
    const plain = join(root, "plain");
    mkdirSync(plain);
    writeFileSync(join(root, "notes.json"), "{}");
    expect(detectKind(repo)).toBe("repo");
    expect(detectKind(git)).toBe("repo");
    expect(() => detectKind(plain)).toThrow(/not a recognizable repository/);
    expect(detectKind(join(repo, "README.md"))).toBe("markdown");
    expect(detectKind(join(root, "notes.json"))).toBe("text");
    expect(detectKind("whitepaper.PDF")).toBe("pdf");
    expect(detectKind("memo.docx")).toBe("docx");
    expect(detectKind("deck.pptx")).toBe("pptx");
    expect(detectKind("notes.txt")).toBe("text");
    expect(detectKind("clip.mp4")).toBe("video");
  });

  it("treats other strings as inline text or markdown", () => {
    expect(detectKind("Explain vector databases in 30 seconds")).toBe("text");
    expect(detectKind("# Title\n\nBody")).toBe("markdown");
    expect(detectKind("see file.pdf for details")).toBe("text");
  });
});

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { EvidenceSpan, Section } from "@video-studio/schema";
import { createSlugger, fileRef } from "./refs.js";
import { lineOffsets, resolveTextInput } from "./text.js";
import type { ExtractInput, ExtractedSource, Extractor } from "./types.js";

export type MdBlockType = "paragraph" | "list" | "code" | "quote" | "table" | "html";

export interface MdBlock {
  type: MdBlockType;
  /** Verbatim source text of the block. */
  raw: string;
  /** Normalized plain text (code blocks are kept verbatim, fences included). */
  text: string;
  /** 1-based inclusive line numbers. */
  lineStart: number;
  lineEnd: number;
  /** Offsets into the LF-normalized document; end is exclusive. */
  charStart: number;
  charEnd: number;
}

export interface MdSection {
  /** Plain-text heading; undefined for content before the first heading. */
  heading?: string;
  /** 0 for the preamble, else 1–6. */
  level: number;
  /** Unique slug within the document (GitHub-style, duplicates get -2, -3…). */
  slug?: string;
  headingLine?: number;
  blocks: MdBlock[];
}

export interface MdFrontMatter {
  raw: string;
  data: unknown;
  error?: string;
  lineStart: number;
  lineEnd: number;
  charStart: number;
  charEnd: number;
}

export interface ParsedMarkdown {
  frontMatter?: MdFrontMatter;
  sections: MdSection[];
  /** Front-matter `title`, else the first level-1 heading. */
  title?: string;
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const THEMATIC = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_START = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
const QUOTE = /^ {0,3}>/;
const TABLE = /^ {0,3}\|/;
const HTML_START = /^ {0,3}<(?:!--|[A-Za-z][A-Za-z0-9-]*[\s>/]|\/[A-Za-z])/;

/** Strip common inline markdown, keeping visible text. */
export function stripInline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, "$1")
    .trim();
}

function blockText(type: MdBlockType, lines: string[], raw: string): string {
  switch (type) {
    case "code":
      return raw;
    case "paragraph":
      return stripInline(lines.map((l) => l.trim()).join(" ").replace(/\s+/g, " "));
    case "quote":
      return lines.map((l) => stripInline(l.replace(/^ {0,3}>\s?/, ""))).join("\n").trim();
    case "html":
      return stripInline(lines.join(" ").replace(/<!--[\s\S]*?-->/g, "")).replace(/\s+/g, " ").trim();
    default:
      return lines.map((l) => stripInline(l.replace(/\s+$/, ""))).filter(Boolean).join("\n");
  }
}

/**
 * Line-based markdown parser: YAML front matter, ATX and setext headings,
 * fenced code blocks (kept verbatim), lists, quotes, tables and paragraphs.
 * Input must be LF-normalized.
 */
export function parseMarkdown(src: string): ParsedMarkdown {
  const lines = src.split("\n");
  const offs = lineOffsets(src);
  const slugger = createSlugger();
  const endOf = (i: number) => offs[i]! + lines[i]!.length;

  let i = 0;
  let frontMatter: MdFrontMatter | undefined;
  if (lines[0]?.trimEnd() === "---") {
    const close = lines.findIndex((l, k) => k > 0 && (l.trimEnd() === "---" || l.trimEnd() === "..."));
    if (close > 0) {
      const raw = lines.slice(1, close).join("\n");
      let data: unknown;
      let error: string | undefined;
      try {
        data = parseYaml(raw);
      } catch (err) {
        error = err instanceof Error ? err.message.split("\n")[0] : String(err);
      }
      frontMatter = {
        raw,
        data,
        ...(error ? { error } : {}),
        lineStart: 1,
        lineEnd: close + 1,
        charStart: 0,
        charEnd: endOf(close),
      };
      i = close + 1;
    }
  }

  const sections: MdSection[] = [{ level: 0, blocks: [] }];
  let section = sections[0]!;
  let open: { type: MdBlockType; start: number; end: number } | undefined;
  let blankSinceLast = false;

  const materialize = (type: MdBlockType, start: number, end: number): MdBlock => {
    const raw = src.slice(offs[start], endOf(end));
    return {
      type,
      raw,
      text: blockText(type, lines.slice(start, end + 1), raw),
      lineStart: start + 1,
      lineEnd: end + 1,
      charStart: offs[start]!,
      charEnd: endOf(end),
    };
  };
  const flush = () => {
    if (open) section.blocks.push(materialize(open.type, open.start, open.end));
    open = undefined;
  };
  const startSection = (heading: string, level: number, line: number) => {
    const text = stripInline(heading);
    section = { heading: text, level, slug: slugger(text), headingLine: line + 1, blocks: [] };
    sections.push(section);
  };

  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE_OPEN.exec(line);
    if (fence && !(fence[1]![0] === "`" && fence[2]!.includes("`"))) {
      flush();
      const marker = fence[1]!;
      const closeRe = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
      let k = i + 1;
      while (k < lines.length && !closeRe.test(lines[k]!)) k++;
      const end = Math.min(k, lines.length - 1);
      section.blocks.push(materialize("code", i, end));
      i = end;
      blankSinceLast = false;
      continue;
    }
    if (line.trim() === "") {
      if (open) {
        flush();
        blankSinceLast = true;
      }
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      flush();
      startSection(atx[2] ?? "", atx[1]!.length, i);
      blankSinceLast = false;
      continue;
    }
    if (open?.type === "paragraph" && SETEXT.test(line)) {
      const heading = lines
        .slice(open.start, open.end + 1)
        .map((l) => l.trim())
        .join(" ");
      open = undefined;
      startSection(heading, line.trim()[0] === "=" ? 1 : 2, i);
      blankSinceLast = false;
      continue;
    }
    if (THEMATIC.test(line)) {
      flush();
      blankSinceLast = false;
      continue;
    }

    const kind: MdBlockType = LIST_START.test(line)
      ? "list"
      : QUOTE.test(line)
        ? "quote"
        : TABLE.test(line)
          ? "table"
          : HTML_START.test(line)
            ? "html"
            : "paragraph";

    if (open) {
      if (kind === "list" && open.type !== "list" && open.type !== "quote") {
        flush();
        open = { type: "list", start: i, end: i };
      } else {
        open.end = i;
      }
      continue;
    }
    // A loose list: blank lines between items or indented continuation paragraphs.
    const last = section.blocks.at(-1);
    if (blankSinceLast && last?.type === "list" && (kind === "list" || /^[ \t]{2,}\S/.test(line))) {
      section.blocks.pop();
      open = { type: "list", start: last.lineStart - 1, end: i };
      blankSinceLast = false;
      continue;
    }
    open = { type: kind, start: i, end: i };
    blankSinceLast = false;
  }
  flush();

  if (sections[0]!.blocks.length === 0) sections.shift();

  let title: string | undefined;
  const fmData = frontMatter?.data;
  if (fmData && typeof fmData === "object" && !Array.isArray(fmData)) {
    const t = (fmData as Record<string, unknown>).title;
    if (typeof t === "string" && t.trim()) title = t.trim();
  }
  title ??= sections.find((s) => s.level === 1)?.heading;
  return { ...(frontMatter ? { frontMatter } : {}), sections, ...(title ? { title } : {}) };
}

type PartialSection = Omit<Section, "id" | "source_id">;
type PartialSpan = Omit<EvidenceSpan, "source_id">;

/** Turn parsed markdown into extractor sections + evidence using `makeRef` per block. */
export function markdownToParts(
  parsed: ParsedMarkdown,
  makeRef: (block: { lineStart: number; lineEnd: number; charStart: number; charEnd: number }, section?: MdSection) => string,
  opts: { includeLocatorLines?: boolean } = {},
): { sections: PartialSection[]; evidence: PartialSpan[] } {
  const withLines = opts.includeLocatorLines ?? true;
  const sections: PartialSection[] = [];
  const evidence: PartialSpan[] = [];
  const fm = parsed.frontMatter;
  if (fm && fm.data && typeof fm.data === "object" && !Array.isArray(fm.data)) {
    const text = stringifyYaml(fm.data, { lineWidth: 0 }).trim();
    if (text) {
      sections.push({ heading: "Front matter", text });
      evidence.push({
        ref: makeRef(fm),
        text: fm.raw,
        locator: withLines
          ? { line_start: fm.lineStart, line_end: fm.lineEnd, char_start: fm.charStart, char_end: fm.charEnd, selector: "front-matter" }
          : { selector: "front-matter" },
      });
    }
  }
  for (const s of parsed.sections) {
    sections.push({
      ...(s.heading !== undefined ? { heading: s.heading } : {}),
      text: s.blocks
        .map((b) => b.text)
        .filter(Boolean)
        .join("\n\n"),
    });
    for (const b of s.blocks) {
      if (!b.text) continue;
      evidence.push({
        ref: makeRef(b, s),
        text: b.raw,
        locator: {
          ...(withLines ? { line_start: b.lineStart, line_end: b.lineEnd, char_start: b.charStart, char_end: b.charEnd } : {}),
          ...(s.slug ? { selector: `#${s.slug}` } : {}),
        },
      });
    }
  }
  return { sections, evidence };
}

export const MARKDOWN_EXTRACTOR_VERSION = "1";

/** Markdown extractor: sections by heading, one evidence span per block with line locators. */
export const markdownExtractor: Extractor = {
  version: MARKDOWN_EXTRACTOR_VERSION,
  kinds: ["markdown"],
  async extract(input: ExtractInput): Promise<ExtractedSource> {
    const ti = await resolveTextInput(input);
    const parsed = parseMarkdown(ti.text);
    const { sections, evidence } = markdownToParts(parsed, (b) =>
      fileRef("markdown", ti.refKey, { line_start: b.lineStart, line_end: b.lineEnd }),
    );
    const warnings: ExtractedSource["warnings"] = [];
    if (parsed.frontMatter?.error) {
      warnings.push({ code: "front_matter_invalid", message: `YAML front matter could not be parsed: ${parsed.frontMatter.error}` });
    }
    if (evidence.length === 0) warnings.push({ code: "empty_source", message: "The markdown source contains no content." });
    return {
      source: { kind: "markdown", uri: ti.uri, sha256: ti.sha256, ...(parsed.title ? { title: parsed.title } : {}) },
      sections,
      evidence,
      assets: [],
      warnings,
    };
  },
};

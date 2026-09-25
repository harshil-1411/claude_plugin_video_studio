import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { EvidenceSpan, Section } from "@video-studio/schema";
import { createSlugger, displayPath, fileRef, inlineKey, textRef } from "./refs.js";
import type { ExtractInput, ExtractedSource, Extractor } from "./types.js";

/** Resolved text input shared by the text and markdown extractors. */
export interface TextInput {
  /** LF-normalized content; every locator offset refers to this string. */
  text: string;
  sha256: string;
  /** Value for Source.uri. */
  uri: string;
  /** Path segment used in refs: display path for files, `inline-<hash>` for inline text. */
  refKey: string;
  inline: boolean;
}

const MAX_TEXT_BYTES = 20 * 1024 * 1024;

/** Read `input.content` or the file at `input.uri`; hash raw bytes; normalize newlines. */
export async function resolveTextInput(input: ExtractInput): Promise<TextInput> {
  let raw: Buffer;
  let inline: boolean;
  if (input.content !== undefined) {
    raw = Buffer.from(input.content, "utf8");
    inline = input.uri === input.content || /\s/.test(input.uri) || input.uri.length > 1024 || input.uri === "";
  } else {
    raw = await readFile(input.uri);
    inline = false;
  }
  if (raw.byteLength > MAX_TEXT_BYTES) {
    throw new Error(`text input too large: ${raw.byteLength} bytes (limit ${MAX_TEXT_BYTES})`);
  }
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const text = raw.toString("utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (inline) {
    const key = inlineKey(text);
    return { text, sha256, uri: `inline:${key}`, refKey: key, inline };
  }
  return { text, sha256, uri: input.uri, refKey: displayPath(input.uri, input.projectDir), inline };
}

/** Offsets of the first char of every line in `text` (LF-separated). */
export function lineOffsets(text: string): number[] {
  const offs = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) offs.push(i + 1);
  return offs;
}

interface Paragraph {
  lineStart: number; // 0-based
  lineEnd: number; // 0-based inclusive
  lines: string[];
}

function splitParagraphs(lines: string[]): Paragraph[] {
  const out: Paragraph[] = [];
  let cur: Paragraph | undefined;
  lines.forEach((line, i) => {
    if (line.trim() === "") {
      cur = undefined;
      return;
    }
    if (!cur) {
      cur = { lineStart: i, lineEnd: i, lines: [] };
      out.push(cur);
    }
    cur.lines.push(line);
    cur.lineEnd = i;
  });
  return out;
}

const UNDERLINE = /^\s*(=+|-+)\s*$/;
const LIST_ITEM = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/;

/**
 * Conservative plain-text heading heuristic: a one-line paragraph of at most
 * 70 chars that starts with an upper-case letter or digit, does not end in
 * sentence punctuation and is followed by more text; or a line underlined with
 * `===`/`---`.
 */
function headingOf(p: Paragraph, next: Paragraph | undefined): string | undefined {
  const first = p.lines[0]!.trim();
  if (p.lines.length === 2 && UNDERLINE.test(p.lines[1]!) && first.length <= 120) return first;
  if (p.lines.length !== 1 || !next) return undefined;
  if (first.length > 70 || (LIST_ITEM.test(first) && !/^\d{1,2}[.)]\s+\p{Lu}/u.test(first))) return undefined;
  if (/[.!?,;]$/.test(first) || !/^[\p{Lu}\p{N}]/u.test(first) || !/\p{L}/u.test(first)) return undefined;
  const nextFirst = next.lines[0]!.trim();
  // Two short heading-like lines in a row are more likely a list than headings.
  if (next.lines.length === 1 && nextFirst.length <= 70 && !/[.!?]$/.test(nextFirst)) return undefined;
  return first.replace(/:$/, "");
}

/** Collapse a paragraph's lines into normalized plain text. */
function paragraphText(p: Paragraph): string {
  if (p.lines.some((l) => LIST_ITEM.test(l))) return p.lines.map((l) => l.trim()).join("\n");
  return p.lines.map((l) => l.trim()).join(" ").replace(/\s+/g, " ");
}

type PartialSection = Omit<Section, "id" | "source_id">;
type PartialSpan = Omit<EvidenceSpan, "source_id">;

export const TEXT_EXTRACTOR_VERSION = "1";

/** Plain-text extractor: paragraph-level evidence spans, heuristic headings. */
export const textExtractor: Extractor = {
  version: TEXT_EXTRACTOR_VERSION,
  kinds: ["text"],
  async extract(input: ExtractInput): Promise<ExtractedSource> {
    const ti = await resolveTextInput(input);
    const lines = ti.text.split("\n");
    const offs = lineOffsets(ti.text);
    const paras = splitParagraphs(lines);
    const slug = createSlugger();

    const sections: PartialSection[] = [];
    const evidence: PartialSpan[] = [];
    let current: { heading?: string; slug?: string; texts: string[] } | undefined;
    const flush = () => {
      if (current && (current.heading !== undefined || current.texts.length > 0)) {
        sections.push({
          ...(current.heading !== undefined ? { heading: current.heading } : {}),
          text: current.texts.join("\n\n"),
        });
      }
    };

    let title: string | undefined;
    paras.forEach((p, idx) => {
      const heading = headingOf(p, paras[idx + 1]);
      if (heading !== undefined) {
        flush();
        current = { heading, slug: slug(heading), texts: [] };
        if (idx === 0) title = heading;
        return;
      }
      current ??= { texts: [] };
      const charStart = offs[p.lineStart]!;
      const charEnd = offs[p.lineEnd]! + lines[p.lineEnd]!.length;
      const lineStart = p.lineStart + 1;
      const lineEnd = p.lineEnd + 1;
      current.texts.push(paragraphText(p));
      evidence.push({
        ref: ti.inline
          ? textRef(ti.refKey, charStart, charEnd)
          : fileRef("text", ti.refKey, { line_start: lineStart, line_end: lineEnd }),
        text: ti.text.slice(charStart, charEnd),
        locator: {
          line_start: lineStart,
          line_end: lineEnd,
          char_start: charStart,
          char_end: charEnd,
          ...(current.slug ? { selector: `#${current.slug}` } : {}),
        },
      });
    });
    flush();

    if (title === undefined) {
      const first = paras[0]?.lines[0]?.trim();
      if (first && first.length <= 100) title = first;
    }

    return {
      source: { kind: "text", uri: ti.uri, sha256: ti.sha256, ...(title ? { title } : {}) },
      sections,
      evidence,
      assets: [],
      warnings: evidence.length === 0 ? [{ code: "empty_source", message: "The text source contains no content." }] : [],
    };
  },
};

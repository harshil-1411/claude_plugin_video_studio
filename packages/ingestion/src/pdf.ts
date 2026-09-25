import { basename } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { makeRef, normalizeInline, readSourceFile, tooLargeResult } from "./office-common.js";
import type { ExtractedSource, ExtractInput, Extractor } from "./types.js";

/** Input caps. Beyond MAX_PAGES only the first pages are extracted (with a warning). */
export const PDF_MAX_BYTES = 50 * 1024 * 1024;
export const PDF_MAX_PAGES = 300;
/** A page with less text than this is treated as scanned/image-only. */
export const PDF_SCANNED_CHARS = 20;
/** Consecutive pages shorter than this are merged into one section. */
const SHORT_PAGE_CHARS = 400;
/** Merged sections stop growing past this. */
const MERGED_SECTION_CHARS = 1200;
/** Paragraphs longer than this are re-split at line boundaries. */
const MAX_PARAGRAPH_CHARS = 1500;

interface PageText {
  page: number;
  paragraphs: string[];
  charCount: number;
}

/**
 * Split one page's raw text (lines joined by `\n`, as unpdf returns them) into
 * normalized paragraphs. Blank lines separate paragraphs; hyphenated line
 * breaks are rejoined; very long blocks are chunked at line boundaries.
 */
export function pageParagraphs(raw: string): string[] {
  const out: string[] = [];
  for (const block of raw.replace(/\r\n?/g, "\n").split(/\n[^\S\n]*\n/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    let buf = "";
    const flush = () => {
      const p = normalizeInline(buf);
      if (p) out.push(p);
      buf = "";
    };
    for (const [i, line] of lines.entries()) {
      // A short unpunctuated line at a paragraph boundary, followed by more
      // text, is taken to be a heading and kept as its own paragraph.
      const atBoundary = buf === "" || /[.!?:]$/.test(buf);
      const next = lines[i + 1];
      if (
        atBoundary &&
        next !== undefined &&
        !/^[a-z]/.test(next) &&
        !/[-,]$/.test(line) &&
        headingCandidate(line) &&
        line.length <= 60
      ) {
        flush();
        buf = line;
        flush();
        continue;
      }
      if (buf.endsWith("-") && /^[a-z]/.test(line)) buf = buf.slice(0, -1) + line;
      else buf = buf ? `${buf} ${line}` : line;
      if (buf.length > MAX_PARAGRAPH_CHARS && /[.!?:]$/.test(line)) flush();
    }
    flush();
  }
  return out;
}

/** A first paragraph that looks like a heading: short, no terminal punctuation. */
function headingCandidate(p: string | undefined): string | undefined {
  if (!p || p.length > 80 || p.length < 2) return undefined;
  if (/[.,;:!?]$/.test(p)) return undefined;
  if (!/[A-Za-z]/.test(p)) return undefined;
  return p;
}

async function readPages(bytes: Uint8Array): Promise<{
  pages: string[];
  totalPages: number;
  title: string | undefined;
}> {
  const pdf = await getDocumentProxy(bytes);
  try {
    let title: string | undefined;
    try {
      const meta = await pdf.getMetadata();
      const t = (meta.info as Record<string, unknown> | undefined)?.["Title"];
      if (typeof t === "string" && t.trim()) title = t.trim();
    } catch {
      /* metadata is optional */
    }
    const totalPages = pdf.numPages;
    let pages: string[];
    if (totalPages <= PDF_MAX_PAGES) {
      pages = (await extractText(pdf, { mergePages: false })).text;
    } else {
      // Same join rule as unpdf's extractText, but only for the first pages, sequentially.
      pages = [];
      for (let i = 1; i <= PDF_MAX_PAGES; i++) {
        const content = await (await pdf.getPage(i)).getTextContent();
        pages.push(
          content.items
            .map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : "") : ""))
            .join(""),
        );
      }
    }
    return { pages, totalPages, title };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

export const pdfExtractor: Extractor = {
  version: "pdf-1",
  kinds: ["pdf"],
  async extract(input: ExtractInput): Promise<ExtractedSource> {
    const read = await readSourceFile(input.uri, PDF_MAX_BYTES);
    if (!read.ok) return tooLargeResult(input, read.sha256, read.size, PDF_MAX_BYTES);
    const sha256 = read.sha256;
    // pdf.js may transfer (detach) the buffer it is given: hand it a copy.
    const { pages, totalPages, title } = await readPages(read.bytes.slice());

    const result: ExtractedSource = {
      source: { kind: "pdf", uri: input.uri, sha256, ...(title ? { title } : {}) },
      sections: [],
      evidence: [],
      assets: [],
      warnings: [],
    };

    if (totalPages > PDF_MAX_PAGES) {
      result.warnings.push({
        code: "pdf_truncated",
        message: `${basename(input.uri)} has ${totalPages} pages; only the first ${PDF_MAX_PAGES} were extracted`,
      });
    }

    const pageTexts: PageText[] = pages.map((raw, i) => {
      const paragraphs = pageParagraphs(raw);
      return { page: i + 1, paragraphs, charCount: paragraphs.join(" ").length };
    });

    const scanned = pageTexts.filter((p) => p.charCount < PDF_SCANNED_CHARS).map((p) => p.page);
    if (scanned.length > 0) {
      result.warnings.push({
        code: "scanned_pdf",
        message:
          `${scanned.length} of ${pageTexts.length} page(s) have little or no extractable text ` +
          `(pages ${compactRanges(scanned)}); they may be scanned images. OCR is not performed.`,
      });
    }

    // Evidence: one span per paragraph, located by page.
    for (const pt of pageTexts) {
      pt.paragraphs.forEach((text, i) => {
        result.evidence.push({
          ref: makeRef("pdf", input.uri, `p${pt.page}.para-${i + 1}`),
          text,
          locator: { page: pt.page },
        });
      });
    }

    // Sections: one per page, consecutive short pages merged.
    let group: PageText[] = [];
    const flush = () => {
      if (group.length === 0) return;
      const paras = group.flatMap((g) => g.paragraphs);
      const heading = headingCandidate(group[0]?.paragraphs[0]);
      result.sections.push({ ...(heading ? { heading } : {}), text: paras.join("\n\n") });
      group = [];
    };
    for (const pt of pageTexts) {
      if (pt.paragraphs.length === 0) {
        flush();
        continue;
      }
      const groupChars = group.reduce((n, g) => n + g.charCount, 0);
      const prevShort = group.length > 0 && group.every((g) => g.charCount < SHORT_PAGE_CHARS);
      const canMerge =
        prevShort && pt.charCount < SHORT_PAGE_CHARS && groupChars + pt.charCount <= MERGED_SECTION_CHARS;
      if (!canMerge) flush();
      group.push(pt);
    }
    flush();

    return result;
  },
};

function compactRanges(nums: number[]): string {
  const parts: string[] = [];
  let start = nums[0];
  let prev = nums[0];
  for (let i = 1; i <= nums.length; i++) {
    const n = nums[i];
    if (n !== undefined && prev !== undefined && n === prev + 1) {
      prev = n;
      continue;
    }
    if (start !== undefined) parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = n;
    prev = n;
  }
  return parts.join(", ");
}

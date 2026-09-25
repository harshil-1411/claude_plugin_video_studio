import { basename } from "node:path";
import { parseHTML } from "linkedom";
import mammoth from "mammoth";
import {
  assetKindForExt,
  extFromContentType,
  joinParagraphs,
  makeRef,
  MAX_OFFICE_BYTES,
  normalizeInline,
  readCoreTitle,
  readSourceFile,
  SafeZip,
  tooLargeResult,
  writeProjectAsset,
} from "./office-common.js";
import type { ExtractedAsset, ExtractedSource, ExtractInput, Extractor } from "./types.js";

interface Block {
  kind: "heading" | "para";
  text: string;
}

/**
 * Flatten mammoth's HTML into headings and text paragraphs. The HTML is only
 * ever read as a DOM for its text — never rendered or served (mammoth does
 * not sanitize).
 */
export function htmlToBlocks(html: string): Block[] {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const blocks: Block[] = [];
  const push = (kind: Block["kind"], raw: string | null | undefined) => {
    const text = normalizeInline(raw ?? "");
    if (text) blocks.push({ kind, text });
  };
  const walkList = (list: Element) => {
    for (const li of Array.from(list.children)) {
      if (li.tagName !== "LI") continue;
      const own = li.cloneNode(true) as Element;
      for (const nested of Array.from(own.querySelectorAll("ul,ol"))) nested.remove();
      push("para", own.textContent);
      for (const nested of Array.from(li.children)) {
        if (nested.tagName === "UL" || nested.tagName === "OL") walkList(nested);
      }
    }
  };
  const walk = (el: Element) => {
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) push("heading", el.textContent);
    else if (tag === "UL" || tag === "OL") walkList(el);
    else if (tag === "TABLE") {
      for (const tr of Array.from(el.querySelectorAll("tr"))) {
        const cells = Array.from(tr.children)
          .filter((c) => c.tagName === "TD" || c.tagName === "TH")
          .map((c) => normalizeInline(c.textContent ?? ""))
          .filter(Boolean);
        push("para", cells.join(" | "));
      }
    } else if (tag === "P" || tag === "PRE" || tag === "BLOCKQUOTE") push("para", el.textContent);
    else if (el.children.length > 0) for (const c of Array.from(el.children)) walk(c);
    else push("para", el.textContent);
  };
  for (const child of Array.from(document.body.children)) walk(child);
  return blocks;
}

export const docxExtractor: Extractor = {
  version: "docx-1",
  kinds: ["docx"],
  async extract(input: ExtractInput): Promise<ExtractedSource> {
    const read = await readSourceFile(input.uri, MAX_OFFICE_BYTES);
    if (!read.ok) return tooLargeResult(input, read.sha256, read.size, MAX_OFFICE_BYTES);

    // Zip-bomb guard before mammoth (which unzips with no limits of its own) sees the bytes.
    const zip = await SafeZip.open(read.bytes);
    const coreTitle = await readCoreTitle(zip);

    const assets: ExtractedAsset[] = [];
    const seen = new Set<string>();
    let imageIndex = 0;
    const projectDir = input.projectDir;
    const convertImage = mammoth.images.imgElement(async (image) => {
      imageIndex += 1;
      if (!projectDir) return { src: "" };
      const ext = extFromContentType(image.contentType);
      const kind = ext ? assetKindForExt(ext) : undefined;
      if (!ext || !kind) return { src: "" };
      const bytes = new Uint8Array(await image.readAsBuffer());
      const asset = await writeProjectAsset(
        projectDir,
        bytes,
        ext,
        kind,
        makeRef("docx", input.uri, `img-${imageIndex}`),
      );
      if (!seen.has(asset.sha256)) {
        seen.add(asset.sha256);
        assets.push(asset);
      }
      return { src: "" };
    });

    const { value: html, messages } = await mammoth.convertToHtml(
      { buffer: Buffer.from(read.bytes) },
      { convertImage, externalFileAccess: false },
    );

    const result: ExtractedSource = {
      source: { kind: "docx", uri: input.uri, sha256: read.sha256 },
      sections: [],
      evidence: [],
      assets,
      warnings: [],
    };

    if (messages.length > 0) {
      const shown = messages.slice(0, 5).map((m) => m.message);
      result.warnings.push({
        code: "docx_conversion_messages",
        message: `mammoth reported ${messages.length} message(s): ${shown.join("; ")}`,
      });
    }

    // Group blocks into sections at headings; paragraphs become evidence.
    let para = 0;
    let heading: string | undefined;
    let paras: Array<{ text: string; n: number }> = [];
    const flush = () => {
      if (heading === undefined && paras.length === 0) return;
      const { text, offsets } = joinParagraphs(paras.map((p) => p.text));
      result.sections.push({ ...(heading !== undefined ? { heading } : {}), text });
      paras.forEach((p, i) => {
        const [start, end] = offsets[i] ?? [0, 0];
        result.evidence.push({
          ref: makeRef("docx", input.uri, `para-${p.n}`),
          text: p.text,
          locator: { selector: `#para-${p.n}`, char_start: start, char_end: end },
        });
      });
      paras = [];
    };
    const blocks = htmlToBlocks(html);
    for (const b of blocks) {
      if (b.kind === "heading") {
        flush();
        heading = b.text;
      } else {
        para += 1;
        paras.push({ text: b.text, n: para });
      }
    }
    flush();

    const firstHeading = blocks.find((b) => b.kind === "heading")?.text;
    const title = coreTitle ?? firstHeading;
    if (title) result.source.title = title;

    if (result.evidence.length === 0) {
      result.warnings.push({
        code: "empty_document",
        message: `${basename(input.uri)} contained no extractable text`,
      });
    }
    return result;
  },
};

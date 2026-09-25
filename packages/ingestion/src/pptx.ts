import { basename, extname } from "node:path";
import type { Element as XmlElement } from "@xmldom/xmldom";
import {
  assetKindForExt,
  elementsNS,
  makeRef,
  MAX_OFFICE_BYTES,
  normalizeInline,
  NS,
  parseRels,
  parseXml,
  readCoreTitle,
  readSourceFile,
  relsPathFor,
  resolvePartPath,
  SafeZip,
  textOfNS,
  tooLargeResult,
  writeProjectAsset,
} from "./office-common.js";
import type { ExtractedAsset, ExtractedSource, ExtractInput, Extractor } from "./types.js";

const TITLE_TYPES = new Set(["title", "ctrTitle"]);
const MEDIA_REL = /\/(image|video|audio|media)$/;

/** Placeholder type of a `p:sp` shape, or undefined when it is not a placeholder. */
function placeholderType(sp: XmlElement): string | undefined {
  const ph = elementsNS(sp, NS.p, "ph")[0];
  if (!ph) return undefined;
  return ph.getAttribute("type") || "body"; // OOXML default placeholder type is "body"
}

/** Non-empty `a:p` paragraph texts under `root`, in document order. */
function paragraphs(root: XmlElement): string[] {
  return elementsNS(root, NS.a, "p")
    .map((p) => normalizeInline(textOfNS(p, NS.a, "t")))
    .filter(Boolean);
}

export interface SlideText {
  title: string | undefined;
  /** All paragraphs on the slide in order, title first when present. */
  paragraphs: string[];
  /** Number of leading entries of `paragraphs` that belong to the title. */
  titleParagraphs: number;
}

/** Extract title and paragraph text from one slide part. */
export function readSlideXml(xml: string): SlideText {
  const doc = parseXml(xml);
  const root = doc.documentElement;
  if (!root) return { title: undefined, paragraphs: [], titleParagraphs: 0 };
  let title: string | undefined;
  let titleParas: string[] = [];
  const titleShape = elementsNS(root, NS.p, "sp").find((sp) => {
    const t = placeholderType(sp);
    return t !== undefined && TITLE_TYPES.has(t);
  });
  if (titleShape) {
    titleParas = paragraphs(titleShape);
    title = titleParas.join(" ") || undefined;
  }
  // Body: every paragraph under the shape tree (text boxes, placeholders, tables,
  // groups) except those inside the title shape.
  const body = elementsNS(root, NS.a, "p")
    .filter((p) => !(titleShape && isDescendant(p, titleShape)))
    .map((p) => normalizeInline(textOfNS(p, NS.a, "t")))
    .filter(Boolean);
  return { title, paragraphs: [...titleParas, ...body], titleParagraphs: titleParas.length };
}

/** Speaker notes text: the body placeholder(s) of a notes slide. */
export function readNotesXml(xml: string): string {
  const root = parseXml(xml).documentElement;
  if (!root) return "";
  const shapes = elementsNS(root, NS.p, "sp");
  const bodies = shapes.filter((sp) => placeholderType(sp) === "body");
  const src = bodies.length > 0 ? bodies : shapes.filter((sp) => placeholderType(sp) === undefined);
  return src.flatMap(paragraphs).join("\n");
}

function isDescendant(node: XmlElement, ancestor: XmlElement): boolean {
  for (let n = node.parentNode; n; n = n.parentNode) if (n === ancestor) return true;
  return false;
}

function slideNumber(name: string): number | undefined {
  const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
  return m ? Number(m[1]) : undefined;
}

export const pptxExtractor: Extractor = {
  version: "pptx-1",
  kinds: ["pptx"],
  async extract(input: ExtractInput): Promise<ExtractedSource> {
    const read = await readSourceFile(input.uri, MAX_OFFICE_BYTES);
    if (!read.ok) return tooLargeResult(input, read.sha256, read.size, MAX_OFFICE_BYTES);
    const zip = await SafeZip.open(read.bytes);

    const result: ExtractedSource = {
      source: { kind: "pptx", uri: input.uri, sha256: read.sha256 },
      sections: [],
      evidence: [],
      assets: [],
      warnings: [],
    };
    const seenAssets = new Set<string>();

    const slides = zip
      .names()
      .map((name) => ({ name, n: slideNumber(name) }))
      .filter((s): s is { name: string; n: number } => s.n !== undefined)
      .sort((a, b) => a.n - b.n);

    let firstTitle: string | undefined;
    for (const { name, n } of slides) {
      const xml = await zip.readText(name);
      if (!xml) continue;
      let slide: SlideText;
      try {
        slide = readSlideXml(xml);
      } catch (err) {
        result.warnings.push({
          code: "pptx_slide_unreadable",
          message: `slide ${n}: ${(err as Error).message}`,
        });
        continue;
      }
      firstTitle ??= slide.title;

      const rels = parseRels(await zip.readText(relsPathFor(name)));

      // Speaker notes via the slide's notesSlide relationship.
      let notes = "";
      for (const rel of rels.values()) {
        if (!rel.type.endsWith("/notesSlide") || rel.external) continue;
        const part = resolvePartPath(name, rel.target);
        const notesXml = part ? await zip.readText(part) : undefined;
        if (notesXml) notes = readNotesXml(notesXml);
        break;
      }

      const bodyParas = slide.paragraphs.slice(slide.titleParagraphs);
      if (slide.title || bodyParas.length > 0 || notes) {
        result.sections.push({
          ...(slide.title ? { heading: slide.title } : {}),
          text: bodyParas.join("\n\n"),
        });
      }
      slide.paragraphs.forEach((text, i) => {
        result.evidence.push({
          ref: makeRef("pptx", input.uri, `s${n}.para-${i + 1}`),
          text,
          locator: { slide: n },
        });
      });
      if (notes) {
        result.evidence.push({
          ref: makeRef("pptx", input.uri, `s${n}.notes`),
          text: notes,
          locator: { slide: n, selector: "notes" },
        });
      }

      // Media referenced by this slide.
      for (const rel of rels.values()) {
        if (rel.external || !MEDIA_REL.test(rel.type)) continue;
        if (!input.projectDir) continue; // media is only extracted into a project
        const part = resolvePartPath(name, rel.target);
        if (!part) continue;
        const ext = extname(part).slice(1).toLowerCase();
        const kind = assetKindForExt(ext);
        if (!kind) continue;
        const bytes = await zip.readBytes(part);
        if (!bytes) continue;
        const asset: ExtractedAsset = await writeProjectAsset(
          input.projectDir,
          bytes,
          ext,
          kind,
          makeRef("pptx", input.uri, `s${n}`),
        );
        if (!seenAssets.has(asset.sha256)) {
          seenAssets.add(asset.sha256);
          result.assets.push(asset);
        }
      }
    }

    const title = (await readCoreTitle(zip)) ?? firstTitle;
    if (title) result.source.title = title;
    if (slides.length === 0) {
      result.warnings.push({
        code: "empty_document",
        message: `${basename(input.uri)} contains no slides`,
      });
    }
    return result;
  },
};

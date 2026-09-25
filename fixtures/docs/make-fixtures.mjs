#!/usr/bin/env node
// Generates the tiny binary fixtures in this directory (committed outputs):
//   sample.pdf   3 pages: two short text pages + one blank ("scanned") page
//   sample.docx  2 headings, paragraphs, a bullet list, a table, a 1x1 PNG
//   sample.pptx  3 slides with titles, speaker notes, one image on slide 2
// The office files are minimal (no themes/masters): enough for the extractors,
// not guaranteed to open in Office. Run: node fixtures/docs/make-fixtures.mjs
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../packages/ingestion/package.json"));
const JSZip = require("jszip");

// Fixed timestamp so outputs are byte-stable across runs.
const DATE = new Date("2026-01-01T00:00:00Z");

// ---------------------------------------------------------------- PNG (1x1)
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png1x1(r, g, b) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from([0, r, g, b]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- PDF
function pdfString(s) {
  return `(${s.replace(/[\\()]/g, (m) => `\\${m}`)})`;
}
function makePdf() {
  const pages = [
    ["Introduction", "", "Vector databases store embeddings for fast similarity search.", "They power retrieval for AI apps."],
    ["Benchmarks", "", "Query latency dropped 42% after enabling HNSW indexes."],
    [], // blank page: simulates a scanned, image-only page
  ];
  const objs = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  pages.forEach((lines, i) => {
    const pageId = 4 + i * 2;
    const contentId = pageId + 1;
    let y = 740;
    const ops = ["BT", "/F1 12 Tf"];
    for (const line of lines) {
      if (line) ops.push(`1 0 0 1 72 ${y} Tm`, `${pdfString(line)} Tj`);
      y -= line ? 16 : 24;
    }
    ops.push("ET");
    const stream = lines.length ? ops.join("\n") : "";
    objs[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objs[contentId] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  const infoId = objs.length;
  objs[infoId] = `<< /Title ${pdfString("Vector DB Whitepaper")} /Producer (make-fixtures) >>`;

  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let id = 1; id < objs.length; id++) {
    offsets[id] = Buffer.byteLength(out);
    out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objs.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// ---------------------------------------------------------------- DOCX
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const xmlHead = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function corePropsXml(title) {
  return (
    xmlHead +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title)}</dc:title></cp:coreProperties>`
  );
}

async function zipBytes(files) {
  const zip = new JSZip();
  for (const [name, data] of files) zip.file(name, data, { date: DATE });
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", platform: "UNIX" });
}

async function makeDocx() {
  const p = (text, style) =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  const li = (text) =>
    `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>` +
    `<w:r><w:t>${esc(text)}</w:t></w:r></w:p>`;
  const cell = (t) => `<w:tc><w:p><w:r><w:t>${esc(t)}</w:t></w:r></w:p></w:tc>`;
  const image =
    `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<wp:extent cx="9525" cy="9525"/><wp:docPr id="1" name="Picture 1" descr="red pixel"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="1" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="rId10"/></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  const body = [
    p("This preface sits before any heading."),
    p("Overview", "Heading1"),
    p("Vector databases index embeddings."),
    p("They answer nearest-neighbour queries quickly."),
    li("Fast similarity search"),
    li("Metadata filtering"),
    image,
    p("Results", "Heading2"),
    p("Recall improved to 0.97 at 10 ms p95 latency."),
    `<w:tbl><w:tr>${cell("Metric")}${cell("Value")}</w:tr><w:tr>${cell("Recall")}${cell("0.97")}</w:tr></w:tbl>`,
  ].join("");
  const documentXml =
    xmlHead + `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}<w:sectPr/></w:body></w:document>`;
  const style = (id, name, type = "paragraph") =>
    `<w:style w:type="${type}" w:styleId="${id}"><w:name w:val="${name}"/></w:style>`;
  const stylesXml =
    xmlHead +
    `<w:styles xmlns:w="${W}">${style("Normal", "Normal")}${style("Heading1", "heading 1")}` +
    `${style("Heading2", "heading 2")}${style("ListParagraph", "List Paragraph")}</w:styles>`;
  const numberingXml =
    xmlHead +
    `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0">` +
    `<w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>` +
    `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  const contentTypes =
    xmlHead +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="png" ContentType="image/png"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `</Types>`;
  const rootRels =
    xmlHead +
    `<Relationships xmlns="${PKG_REL}">` +
    `<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
    `</Relationships>`;
  const docRels =
    xmlHead +
    `<Relationships xmlns="${PKG_REL}">` +
    `<Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId2" Type="${R}/numbering" Target="numbering.xml"/>` +
    `<Relationship Id="rId10" Type="${R}/image" Target="media/image1.png"/>` +
    `</Relationships>`;
  return zipBytes([
    ["[Content_Types].xml", contentTypes],
    ["_rels/.rels", rootRels],
    ["docProps/core.xml", corePropsXml("Vector DB Notes")],
    ["word/document.xml", documentXml],
    ["word/styles.xml", stylesXml],
    ["word/numbering.xml", numberingXml],
    ["word/_rels/document.xml.rels", docRels],
    ["word/media/image1.png", png1x1(255, 0, 0)],
  ]);
}

// ---------------------------------------------------------------- PPTX
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";

function sp(id, phType, paras) {
  const ph = phType === null ? "" : `<p:nvPr><p:ph${phType ? ` type="${phType}"` : ""}/></p:nvPr>`;
  const txt = paras.map((t) => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${esc(t)}</a:t></a:r></a:p>`).join("");
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/>${ph || "<p:nvPr/>"}</p:nvSpPr>` +
    `<p:spPr/><p:txBody><a:bodyPr/>${txt}</p:txBody></p:sp>`
  );
}
function slideXml(shapes) {
  return (
    xmlHead +
    `<p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
    shapes.join("") +
    `</p:spTree></p:cSld></p:sld>`
  );
}
function notesXml(text) {
  return (
    xmlHead +
    `<p:notes xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
    sp(2, "sldImg", []) +
    sp(3, "body", [text]) +
    sp(4, "sldNum", ["1"]) +
    `</p:spTree></p:cSld></p:notes>`
  );
}
async function makePptx() {
  const slides = [
    {
      shapes: [sp(2, "ctrTitle", ["Vector Databases"]), sp(3, "subTitle", ["A 30-second explainer"])],
      notes: "Open with the problem: keyword search misses meaning.",
    },
    {
      shapes: [sp(2, "title", ["How it works"]), sp(3, "", ["Embed the data", "Index with HNSW", "Query by similarity"])],
      notes: "Mention that HNSW is a graph index.",
      image: true,
    },
    {
      shapes: [sp(2, "title", ["Results"]), sp(3, null, ["Latency fell 42%"])],
      notes: "Close with the call to action.",
    },
  ];
  const files = [];
  const overrides = [];
  const presRels = [];
  const sldIds = [];
  // Add slides in reverse so archive order differs from numeric order.
  for (let i = slides.length; i >= 1; i--) {
    const s = slides[i - 1];
    files.push([`ppt/slides/slide${i}.xml`, slideXml(s.shapes)]);
    files.push([`ppt/notesSlides/notesSlide${i}.xml`, notesXml(s.notes)]);
    const rels = [`<Relationship Id="rId2" Type="${R}/notesSlide" Target="../notesSlides/notesSlide${i}.xml"/>`];
    if (s.image) rels.push(`<Relationship Id="rId3" Type="${R}/image" Target="../media/image1.png"/>`);
    files.push([`ppt/slides/_rels/slide${i}.xml.rels`, xmlHead + `<Relationships xmlns="${PKG_REL}">${rels.join("")}</Relationships>`]);
    overrides.push(
      `<Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
      `<Override PartName="/ppt/notesSlides/notesSlide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`,
    );
  }
  for (let i = 1; i <= slides.length; i++) {
    presRels.push(`<Relationship Id="rId${i}" Type="${R}/slide" Target="slides/slide${i}.xml"/>`);
    sldIds.push(`<p:sldId id="${255 + i}" r:id="rId${i}"/>`);
  }
  files.push(["ppt/media/image1.png", png1x1(0, 128, 255)]);
  files.push([
    "ppt/presentation.xml",
    xmlHead + `<p:presentation xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:sldIdLst>${sldIds.join("")}</p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  ]);
  files.push(["ppt/_rels/presentation.xml.rels", xmlHead + `<Relationships xmlns="${PKG_REL}">${presRels.join("")}</Relationships>`]);
  files.push(["docProps/core.xml", corePropsXml("Vector DB Deck")]);
  files.push([
    "_rels/.rels",
    xmlHead +
      `<Relationships xmlns="${PKG_REL}">` +
      `<Relationship Id="rId1" Type="${R}/officeDocument" Target="ppt/presentation.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
      `</Relationships>`,
  ]);
  files.push([
    "[Content_Types].xml",
    xmlHead +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Default Extension="png" ContentType="image/png"/>` +
      `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
      overrides.join("") +
      `</Types>`,
  ]);
  return zipBytes(files);
}

writeFileSync(join(here, "sample.pdf"), makePdf());
writeFileSync(join(here, "sample.docx"), await makeDocx());
writeFileSync(join(here, "sample.pptx"), await makePptx());
console.log("wrote sample.pdf, sample.docx, sample.pptx");

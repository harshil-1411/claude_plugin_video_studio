import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DOMParser, type Document as XmlDocument, type Element as XmlElement } from "@xmldom/xmldom";
import JSZip from "jszip";
import { hashFile, sha256Hex, writeFileAtomic } from "@video-studio/core";
import type { SourceKind } from "@video-studio/schema";
import type { ExtractedAsset, ExtractedSource, ExtractInput } from "./types.js";

/**
 * Shared helpers for the binary document extractors (pdf, docx, pptx).
 * Everything here treats input as hostile: size caps, zip-bomb guards,
 * no external entity resolution, no rendering.
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export interface ZipLimits {
  /** Maximum number of entries in the archive. */
  maxEntries: number;
  /** Maximum total uncompressed size (declared and actually read), bytes. */
  maxUncompressedBytes: number;
}

export const DEFAULT_ZIP_LIMITS: Readonly<ZipLimits> = Object.freeze({
  maxEntries: 5000,
  maxUncompressedBytes: 200 * 1024 * 1024,
});

/** Raw input size cap for office documents (compressed bytes). */
export const MAX_OFFICE_BYTES = 100 * 1024 * 1024;

export class ZipLimitError extends Error {
  override readonly name = "ZipLimitError";
  constructor(
    message: string,
    readonly code: "zip_too_many_entries" | "zip_too_large" | "zip_path_unsafe",
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Safe zip
// ---------------------------------------------------------------------------

/** Declared uncompressed size of an entry; JSZip keeps it on a private field. */
function declaredSize(file: JSZip.JSZipObject): number {
  const data = (file as unknown as { _data?: { uncompressedSize?: number } })._data;
  return typeof data?.uncompressedSize === "number" ? data.uncompressedSize : 0;
}

/**
 * A read-only view of a zip archive that enforces {@link ZipLimits}.
 * Declared sizes are checked on open; actual bytes are counted again on every
 * read so an archive that lies in its headers still cannot exceed the budget.
 */
export class SafeZip {
  private consumed = 0;

  private constructor(
    readonly zip: JSZip,
    readonly limits: ZipLimits,
  ) {}

  static async open(bytes: Uint8Array, limits: Partial<ZipLimits> = {}): Promise<SafeZip> {
    const merged: ZipLimits = { ...DEFAULT_ZIP_LIMITS, ...limits };
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false });
    assertZipWithinLimits(zip, merged);
    return new SafeZip(zip, merged);
  }

  has(name: string): boolean {
    const f = this.zip.file(name);
    return f !== null && !f.dir;
  }

  /** Entry names (files only), in archive order. */
  names(): string[] {
    return Object.values(this.zip.files)
      .filter((f) => !f.dir)
      .map((f) => f.name);
  }

  async readBytes(name: string): Promise<Uint8Array | undefined> {
    const f = this.zip.file(name);
    if (!f || f.dir) return undefined;
    const remaining = this.limits.maxUncompressedBytes - this.consumed;
    if (declaredSize(f) > remaining) throw tooLarge(this.limits);
    const out = await f.async("uint8array");
    this.consumed += out.byteLength;
    if (this.consumed > this.limits.maxUncompressedBytes) throw tooLarge(this.limits);
    return out;
  }

  async readText(name: string): Promise<string | undefined> {
    const bytes = await this.readBytes(name);
    return bytes === undefined ? undefined : new TextDecoder("utf-8").decode(bytes);
  }
}

function tooLarge(limits: ZipLimits): ZipLimitError {
  return new ZipLimitError(
    `archive expands beyond ${limits.maxUncompressedBytes} bytes; refusing (possible zip bomb)`,
    "zip_too_large",
  );
}

/** Throws {@link ZipLimitError} when an opened archive exceeds the limits. Exported for tests. */
export function assertZipWithinLimits(zip: JSZip, limits: ZipLimits = DEFAULT_ZIP_LIMITS): void {
  const entries = Object.values(zip.files);
  if (entries.length > limits.maxEntries) {
    throw new ZipLimitError(
      `archive has ${entries.length} entries (limit ${limits.maxEntries}); refusing`,
      "zip_too_many_entries",
    );
  }
  let total = 0;
  for (const f of entries) {
    total += declaredSize(f);
    if (total > limits.maxUncompressedBytes) throw tooLarge(limits);
  }
}

/** Resolve a relationship target (`../media/image1.png`) against the part that references it. */
export function resolvePartPath(fromPart: string, target: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined; // external URL / file: — never followed
  const baseDir = fromPart.includes("/") ? fromPart.slice(0, fromPart.lastIndexOf("/")) : "";
  const parts = (target.startsWith("/") ? target.slice(1) : `${baseDir}/${target}`).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(p);
  }
  return out.join("/");
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

export const NS = {
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  rel: "http://schemas.openxmlformats.org/package/2006/relationships",
  cp: "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
  dc: "http://purl.org/dc/elements/1.1/",
} as const;

/** Parse XML without DTD/entity expansion beyond the XML builtins. Throws on fatal errors. */
export function parseXml(text: string): XmlDocument {
  if (/<!DOCTYPE/i.test(text)) throw new Error("XML with a DOCTYPE is not accepted in office parts");
  return new DOMParser().parseFromString(text, "application/xml");
}

export function elementsNS(root: XmlDocument | XmlElement, ns: string, local: string): XmlElement[] {
  return Array.from(root.getElementsByTagNameNS(ns, local));
}

/** Concatenated text of every descendant `ns:local` element (e.g. all `a:t` runs). */
export function textOfNS(root: XmlElement, ns: string, local: string): string {
  return elementsNS(root, ns, local)
    .map((e) => e.textContent ?? "")
    .join("");
}

export interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

/** Parse a `_rels/*.rels` part into a map keyed by relationship id. */
export function parseRels(xml: string | undefined): Map<string, Relationship> {
  const map = new Map<string, Relationship>();
  if (!xml) return map;
  for (const el of elementsNS(parseXml(xml), NS.rel, "Relationship")) {
    const id = el.getAttribute("Id");
    const target = el.getAttribute("Target");
    if (!id || !target) continue;
    map.set(id, {
      id,
      type: el.getAttribute("Type") ?? "",
      target,
      external: el.getAttribute("TargetMode") === "External",
    });
  }
  return map;
}

/** `ppt/slides/slide3.xml` → `ppt/slides/_rels/slide3.xml.rels`. */
export function relsPathFor(part: string): string {
  const i = part.lastIndexOf("/");
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
}

/** `dc:title` from `docProps/core.xml`, if present. */
export async function readCoreTitle(zip: SafeZip): Promise<string | undefined> {
  const xml = await zip.readText("docProps/core.xml");
  if (!xml) return undefined;
  try {
    const t = elementsNS(parseXml(xml), NS.dc, "title")[0]?.textContent?.trim();
    return t ? t : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Text + refs
// ---------------------------------------------------------------------------

/** Collapse runs of whitespace to single spaces and trim. */
export function normalizeInline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * File component of a source_ref: the basename, percent-encoded so it never
 * contains whitespace or `#` (SourceRef requires `\S+`).
 */
export function refFileName(uri: string): string {
  return encodeURIComponent(basename(uri)) || "document";
}

export function makeRef(kind: SourceKind, uri: string, fragment: string): string {
  return `${kind}:${refFileName(uri)}#${fragment}`;
}

/**
 * Join paragraphs into section text (separated by a blank line) and record
 * each paragraph's [start,end) offsets within that text.
 */
export function joinParagraphs(paras: string[]): { text: string; offsets: Array<[number, number]> } {
  const offsets: Array<[number, number]> = [];
  let text = "";
  for (const p of paras) {
    if (text.length > 0) text += "\n\n";
    offsets.push([text.length, text.length + p.length]);
    text += p;
  }
  return { text, offsets };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

export type ReadResult =
  | { ok: true; bytes: Uint8Array; sha256: string }
  | { ok: false; sha256: string; size: number };

/** Read a file if it is within `maxBytes`; otherwise only hash it (streaming). */
export async function readSourceFile(path: string, maxBytes: number): Promise<ReadResult> {
  const st = await stat(path);
  if (!st.isFile()) throw new Error(`not a regular file: ${path}`);
  if (st.size > maxBytes) return { ok: false, sha256: await hashFile(path), size: st.size };
  const bytes = new Uint8Array(await readFile(path));
  return { ok: true, bytes, sha256: sha256Hex(bytes) };
}

/** ExtractedSource for an input that was refused as too large. */
export function tooLargeResult(
  input: ExtractInput,
  sha256: string,
  size: number,
  maxBytes: number,
): ExtractedSource {
  return {
    source: { kind: input.kind, uri: input.uri, sha256 },
    sections: [],
    evidence: [],
    assets: [],
    warnings: [
      {
        code: "file_too_large",
        message: `${basename(input.uri)} is ${size} bytes (limit ${maxBytes}); content was not extracted`,
      },
    ],
  };
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/svg+xml": "svg",
  "image/x-emf": "emf",
  "image/x-wmf": "wmf",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
};

const KIND_BY_EXT: Record<string, ExtractedAsset["kind"]> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image",
  tif: "image", tiff: "image", svg: "image", emf: "image", wmf: "image",
  mp4: "video", mov: "video", m4v: "video", webm: "video", avi: "video", wmv: "video",
  mp3: "audio", wav: "audio", m4a: "audio", ogg: "audio", wma: "audio",
};

export function extFromContentType(contentType: string): string | undefined {
  return EXT_BY_TYPE[contentType.toLowerCase()];
}

export function assetKindForExt(ext: string): ExtractedAsset["kind"] | undefined {
  return KIND_BY_EXT[ext.toLowerCase()];
}

/**
 * Content-addressed write of an extracted binary under
 * `<projectDir>/source/assets/<sha256>.<ext>`. Idempotent.
 */
export async function writeProjectAsset(
  projectDir: string,
  bytes: Uint8Array,
  ext: string,
  kind: ExtractedAsset["kind"],
  sourceRef?: string,
): Promise<ExtractedAsset> {
  const safeExt = ext.toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  const sha256 = sha256Hex(bytes);
  const root = resolve(projectDir);
  const abs = join(root, "source", "assets", `${sha256}.${safeExt}`);
  const rel = relative(root, abs);
  if (isAbsolute(rel) || rel.startsWith("..")) throw new Error("asset path escaped project dir");
  try {
    await stat(abs);
  } catch {
    await writeFileAtomic(abs, bytes);
  }
  const asset: ExtractedAsset = { kind, path: rel.split(sep).join("/"), sha256 };
  if (sourceRef) asset.source_ref = sourceRef;
  return asset;
}

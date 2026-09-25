import { createHash } from "node:crypto";
import { basename, isAbsolute, relative, sep } from "node:path";
import type { SourceKind } from "@video-studio/schema";

/**
 * Helpers for stable `source_ref` strings. Every ref matches the schema's
 * SourceRef pattern `^(text|markdown|url|pdf|docx|pptx|repo|video):\S+$`:
 *
 *   repo:src/a.ts#L10-L20        url:https://x.dev/post#install
 *   pdf:report.pdf#p3            pptx:deck.pptx#s4
 *   markdown:README.md#L3-L7     text:3fa9b2c1d4e5#c0-120
 */

/** Percent-encode whitespace (and `%` itself) so a ref never contains `\s`. */
export function encodeRefPart(part: string): string {
  return part.replace(/[%\s]/g, (c) => {
    const bytes = Buffer.from(c, "utf8");
    return [...bytes].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
  });
}

function lineSpan(lineStart: number, lineEnd?: number): string {
  return lineEnd === undefined || lineEnd === lineStart ? `L${lineStart}` : `L${lineStart}-L${lineEnd}`;
}

/** `repo:<path>#L<a>-L<b>` (or `#L<a>` for a single line). Path uses `/` separators. */
export function repoRef(path: string, lineStart?: number, lineEnd?: number): string {
  const p = encodeRefPart(toPosix(path));
  return lineStart === undefined ? `repo:${p}` : `repo:${p}#${lineSpan(lineStart, lineEnd)}`;
}

/** `url:<url-without-fragment>#<anchor>`; an existing fragment is replaced. */
export function urlRef(url: string, anchor?: string): string {
  const hash = url.indexOf("#");
  const base = encodeRefPart(hash >= 0 ? url.slice(0, hash) : url);
  return anchor ? `url:${base}#${encodeRefPart(anchor)}` : `url:${base}`;
}

export interface FileLocator {
  page?: number;
  slide?: number;
  line_start?: number;
  line_end?: number;
  /** Free-form fragment used verbatim, e.g. a heading slug. */
  anchor?: string;
}

/**
 * `<kind>:<path>#<locator>`, e.g. `pdf:report.pdf#p3`, `pptx:deck.pptx#s2`,
 * `markdown:README.md#L4-L9`. A string locator is used verbatim.
 */
export function fileRef(kind: SourceKind, path: string, locator?: string | FileLocator): string {
  const p = encodeRefPart(toPosix(path));
  let frag: string | undefined;
  if (typeof locator === "string") frag = locator;
  else if (locator) {
    const parts: string[] = [];
    if (locator.page !== undefined) parts.push(`p${locator.page}`);
    if (locator.slide !== undefined) parts.push(`s${locator.slide}`);
    if (locator.line_start !== undefined) parts.push(lineSpan(locator.line_start, locator.line_end));
    if (locator.anchor) parts.push(locator.anchor);
    frag = parts.join("-") || undefined;
  }
  return frag ? `${kind}:${p}#${encodeRefPart(frag)}` : `${kind}:${p}`;
}

/**
 * `text:<source>#c<start>-<end>` for inline text. `source` is a source index
 * or (preferably, because it is stable across re-ordering) a content-hash key.
 */
export function textRef(source: number | string, charStart: number, charEnd: number): string {
  return `text:${encodeRefPart(String(source))}#c${charStart}-${charEnd}`;
}

/** Short stable key for inline content with no path: first 12 hex chars of sha256. */
export function inlineKey(content: string): string {
  return `inline-${createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12)}`;
}

/**
 * A short, machine-independent display path for a file source: relative to
 * `projectDir` when inside it, else the basename.
 */
export function displayPath(path: string, projectDir?: string): string {
  if (projectDir && isAbsolute(path)) {
    const rel = relative(projectDir, path);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return toPosix(rel);
  }
  return isAbsolute(path) ? basename(path) : toPosix(path);
}

function toPosix(p: string): string {
  return sep === "\\" ? p.replaceAll("\\", "/") : p;
}

/**
 * Deterministic GitHub-style heading slug: NFKD, strip diacritics and inline
 * markdown, lower-case, runs of non-alphanumerics become `-`. Never empty.
 */
export function slugify(text: string, fallback = "section"): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[`*_~[\]()<>]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  return slug || fallback;
}

/** Returns `base`, or `base-2`, `base-3`… if already used; records the result. */
export function uniquify(base: string, used: Set<string>): string {
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`;
  used.add(candidate);
  return candidate;
}

/** Stateful slugger: unique slugs within one document (`intro`, `intro-2`, …). */
export function createSlugger(): (heading: string, fallback?: string) => string {
  const used = new Set<string>();
  return (heading, fallback) => uniquify(slugify(heading, fallback), used);
}

/** Tracks refs within one ContentIR and suffixes duplicates with `-2`, `-3`…. */
export class RefRegistry {
  private readonly used = new Set<string>();
  /** Reserve `ref`, returning it or a suffixed unique variant. */
  claim(ref: string): string {
    return uniquify(ref, this.used);
  }
  has(ref: string): boolean {
    return this.used.has(ref);
  }
  get size(): number {
    return this.used.size;
  }
}

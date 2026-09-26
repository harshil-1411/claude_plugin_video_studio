import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import type { LookupAddress } from "node:dns";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { Readability } from "@mozilla/readability";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { markdownToParts, parseMarkdown, stripInline, type MdSection } from "./markdown.js";
import { BlockedAddressError, type LookupFn, type ResolvedAddress, checkUrlHost, defaultLookup } from "./net-guard.js";
import { slugify, uniquify, urlRef } from "./refs.js";
import type { ExtractInput, ExtractedSource, Extractor } from "./types.js";

export const USER_AGENT = "video-studio/0.1 (+ingest)";
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_REDIRECTS = 5;
/** Largest saved `.html` page read from disk (S9: a huge file would exhaust memory in the parser). */
export const MAX_LOCAL_HTML_BYTES = 20 * 1024 * 1024;
/** Below this many characters of extracted text, the page counts as thin. */
export const MIN_CONTENT_CHARS = 200;

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface FetchOptions {
  /** Injectable fetch (tests pass a fixture-backed fake). Defaults to global fetch. */
  fetch?: FetchImpl;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
  /**
   * Host resolver for the SSRF guard. Defaults to `dns.lookup(host, {all: true})` when `fetch` is
   * not injected. With an injected `fetch` and no `lookup`, only literal IP hosts and `localhost`
   * names are checked: the injected transport (tests, embedders) owns name resolution.
   */
  lookup?: LookupFn;
  /**
   * Disable the SSRF guard (loopback/private/link-local hosts allowed). Only set from the user's
   * environment (`VS_ALLOW_PRIVATE_URLS=1`), never from tool arguments.
   */
  allowPrivateAddresses?: boolean;
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  /** Lower-cased media type without parameters, e.g. `text/html`. */
  mediaType: string;
  charset?: string;
  body: Uint8Array;
}

export type UrlFetchErrorCode =
  | "invalid_url"
  | "http_error"
  | "too_many_redirects"
  | "too_large"
  | "unsupported_content_type"
  | "timeout"
  | "network_error"
  | "blocked_address";

export class UrlFetchError extends Error {
  constructor(
    readonly code: UrlFetchErrorCode,
    message: string,
    /** The response's media type, for `unsupported_content_type` (lets ingest retry a video/audio URL as `video_url`). */
    readonly mediaType?: string,
  ) {
    super(message);
    this.name = "UrlFetchError";
  }
}

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/x-markdown"]);

/** Parse an http(s) URL; refuses other schemes and embedded credentials. */
export function parseHttpUrl(raw: string, base?: string): URL {
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    throw new UrlFetchError("invalid_url", `not a valid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new UrlFetchError("invalid_url", `only http(s) URLs are supported, got ${u.protocol}`);
  }
  if (u.username || u.password) throw new UrlFetchError("invalid_url", "URLs with embedded credentials are not supported");
  return u;
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new UrlFetchError("too_large", `response is ${declared} bytes (limit ${maxBytes})`);
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new UrlFetchError("too_large", `response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

/**
 * GET over node:http(s) with the connection pinned to addresses the SSRF guard already validated:
 * the socket's `lookup` returns only `pinned`, so a second DNS answer (DNS rebinding) can never
 * redirect the connection to a private address. TLS still verifies the certificate against the
 * URL's host name. Compressed bodies are decoded here (the size cap applies to decoded bytes).
 */
export function pinnedFetch(url: string, init: RequestInit | undefined, pinned: readonly ResolvedAddress[]): Promise<Response> {
  const u = new URL(url);
  const mod = u.protocol === "https:" ? https : http;
  const lookup = (
    _host: string,
    options: { all?: boolean } | number | undefined,
    cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    if (typeof options === "object" && options?.all) cb(null, pinned.map((a) => ({ address: a.address, family: a.family })));
    else cb(null, pinned[0]!.address, pinned[0]!.family);
  };
  return new Promise<Response>((resolvePromise, reject) => {
    const req = mod.request(
      u,
      {
        method: "GET",
        headers: { "accept-encoding": "gzip, deflate, br", ...headersOf(init) },
        agent: false,
        lookup: lookup as unknown as typeof import("node:dns").lookup,
        ...(init?.signal ? { signal: init.signal } : {}),
      },
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
        }
        let stream: Readable = res;
        const enc = (res.headers["content-encoding"] ?? "").toLowerCase().trim();
        const decoder = enc === "gzip" || enc === "x-gzip" ? createGunzip() : enc === "deflate" ? createInflate() : enc === "br" ? createBrotliDecompress() : undefined;
        if (decoder) {
          res.on("error", (e) => decoder.destroy(e));
          stream = res.pipe(decoder);
          headers.delete("content-encoding");
          headers.delete("content-length");
        }
        const status = res.statusCode ?? 0;
        const body = NULL_BODY_STATUS.has(status) ? null : (Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>);
        if (body === null) res.resume();
        try {
          resolvePromise(new Response(body, { status, headers }));
        } catch (err) {
          res.destroy();
          reject(err);
        }
      },
    );
    req.on("error", reject);
    req.end();
  });
}

export interface GuardedGetOptions extends FetchOptions {
  /** Accept header of every request. */
  accept: string;
  /** Aborts the whole request (timeout and/or caller). */
  signal: AbortSignal;
}

/**
 * GET `url` through the SSRF guard with manual redirects (each hop must stay http/https and pass
 * {@link checkUrlHost}; with the default transport the connection is pinned to the validated
 * addresses). Returns the first non-redirect 2xx response with its body unread, and the final URL.
 * Non-2xx statuses and too many redirects throw {@link UrlFetchError}. Timeouts surface as the
 * signal's abort reason; callers map them.
 */
export async function guardedGet(url: string, opts: GuardedGetOptions): Promise<{ response: Response; finalUrl: string }> {
  const injected = opts.fetch;
  const lookup = opts.lookup ?? (injected ? undefined : defaultLookup);
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const { signal } = opts;
  let current = parseHttpUrl(url);
  for (let hop = 0; ; hop++) {
    let pinned: ResolvedAddress[] | undefined;
    try {
      pinned = await raceAbort(checkUrlHost(current, { ...(lookup ? { lookup } : {}), allowPrivate: opts.allowPrivateAddresses === true }), signal);
    } catch (err) {
      if (err instanceof BlockedAddressError) throw new UrlFetchError("blocked_address", err.message);
      if (signal.aborted) throw err;
      throw new UrlFetchError("network_error", `could not resolve ${current.hostname}: ${(err as Error).message}`);
    }
    const doFetch: FetchImpl = injected ?? (pinned ? (u, init) => pinnedFetch(u, init, pinned!) : (globalThis.fetch as FetchImpl));
    let res: Response;
    try {
      res = await doFetch(current.href, {
        redirect: "manual",
        signal,
        headers: { "user-agent": opts.userAgent ?? USER_AGENT, accept: opts.accept },
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new UrlFetchError("network_error", `fetch failed for ${current.href}: ${(err as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      await res.body?.cancel().catch(() => {});
      if (hop >= maxRedirects) throw new UrlFetchError("too_many_redirects", `more than ${maxRedirects} redirects`);
      current = parseHttpUrl(res.headers.get("location")!, current.href);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new UrlFetchError("http_error", `HTTP ${res.status} for ${current.href}`);
    }
    return { response: res, finalUrl: current.href };
  }
}

/**
 * Fetch a page with a timeout, size cap, content-type check and manual
 * redirect handling (each hop must stay http/https). Never executes content.
 *
 * SSRF guard (unless `allowPrivateAddresses`): before the first request and before every redirect
 * hop the host is resolved and refused when any address is loopback, private, link-local, CGNAT,
 * multicast, unspecified or reserved ({@link checkUrlHost}). With the default transport the
 * connection is pinned to the validated addresses ({@link pinnedFetch}), which closes the DNS
 * rebinding window. Residual risk: an injected `fetch` does its own resolution, so a rebinding
 * DNS server could still steer it; production code never injects one.
 */
export async function fetchPage(url: string, opts: FetchOptions = {}): Promise<FetchedPage> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const { response: res, finalUrl } = await guardedGet(url, {
      ...opts,
      signal,
      accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5,text/markdown;q=0.5",
    });
    const ct = res.headers.get("content-type") ?? "";
    const mediaType = ct.split(";")[0]!.trim().toLowerCase();
    if (mediaType && !HTML_TYPES.has(mediaType) && !TEXT_TYPES.has(mediaType)) {
      await res.body?.cancel().catch(() => {});
      throw new UrlFetchError("unsupported_content_type", `unsupported content-type "${mediaType}" for ${finalUrl}`, mediaType);
    }
    const charset = /charset=["']?([\w-]+)/i.exec(ct)?.[1];
    const body = await readCapped(res, maxBytes);
    return { url, finalUrl, status: res.status, mediaType: mediaType || "text/html", ...(charset ? { charset } : {}), body };
  } catch (err) {
    if (signal.aborted && !(err instanceof UrlFetchError)) {
      throw new UrlFetchError("timeout", `timed out after ${timeoutMs} ms fetching ${url}`);
    }
    throw err;
  }
}

/** Reject as soon as `signal` aborts (dns.lookup itself cannot be cancelled). */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((res, rej) => {
    const onAbort = () => rej(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        res(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        rej(e);
      },
    );
  });
}

function decode(body: Uint8Array, charset?: string): string {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

// ---------------------------------------------------------------------------
// HTML → markdown (fallback path for Readability output; defuddle has its own)

const SKIP = new Set(["script", "style", "noscript", "template", "iframe", "svg", "canvas", "form", "button", "nav", "img", "video", "audio", "picture", "source"]);

function inlineText(node: Node): string {
  let out = "";
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) out += child.textContent ?? "";
    else if (child.nodeType === 1) {
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      if (SKIP.has(tag)) return;
      if (tag === "br") out += "\n";
      else if (tag === "code") out += `\`${el.textContent ?? ""}\``;
      else out += inlineText(el);
    }
  });
  return out;
}

function collapse(s: string): string {
  return s.replace(/[ \t\r\f\v]+/g, " ").replace(/ *\n */g, "\n").trim();
}

function listToMd(el: Element, depth: number): string {
  const ordered = el.tagName.toLowerCase() === "ol";
  const lines: string[] = [];
  let n = 1;
  for (const li of Array.from(el.children)) {
    if (li.tagName.toLowerCase() !== "li") continue;
    const nested: string[] = [];
    const clone = li.cloneNode(true) as Element;
    for (const sub of Array.from(clone.querySelectorAll(":scope > ul, :scope > ol"))) {
      nested.push(listToMd(sub, depth + 1));
      sub.remove();
    }
    const marker = ordered ? `${n++}.` : "-";
    lines.push(`${"  ".repeat(depth)}${marker} ${collapse(inlineText(clone)).replace(/\n/g, " ")}`);
    lines.push(...nested.filter(Boolean));
  }
  return lines.join("\n");
}

function blocksToMd(root: Element, out: string[]): void {
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === 3) {
      const t = collapse(child.textContent ?? "");
      if (t) out.push(t);
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) continue;
    const h = /^h([1-6])$/.exec(tag);
    if (h) {
      const t = collapse(inlineText(el)).replace(/\n/g, " ");
      if (t) out.push(`${"#".repeat(Number(h[1]))} ${t}`);
    } else if (tag === "p" || tag === "figcaption" || tag === "dt" || tag === "dd") {
      const t = collapse(inlineText(el));
      if (t) out.push(t);
    } else if (tag === "ul" || tag === "ol") {
      const t = listToMd(el, 0);
      if (t) out.push(t);
    } else if (tag === "pre") {
      const code = (el.textContent ?? "").replace(/\n+$/, "");
      const lang = /language-([\w+-]+)/.exec(el.querySelector("code")?.getAttribute("class") ?? "")?.[1] ?? "";
      out.push("```" + lang + "\n" + code + "\n```");
    } else if (tag === "blockquote") {
      const inner: string[] = [];
      blocksToMd(el, inner);
      if (inner.length) out.push(inner.join("\n\n").split("\n").map((l) => `> ${l}`).join("\n"));
    } else if (tag === "table") {
      const rows = Array.from(el.querySelectorAll("tr")).map(
        (tr) => `| ${Array.from(tr.children).map((c) => collapse(inlineText(c)).replace(/\|/g, "\\|")).join(" | ")} |`,
      );
      if (rows.length) out.push(rows.join("\n"));
    } else if (tag === "hr") {
      continue;
    } else {
      blocksToMd(el, out);
    }
  }
}

/** Minimal HTML → markdown over a DOM element: headings, paragraphs, lists, code, quotes, tables. */
export function htmlToMarkdown(root: Element): string {
  const out: string[] = [];
  blocksToMd(root, out);
  return out.join("\n\n");
}

// ---------------------------------------------------------------------------

export interface HtmlExtraction {
  title?: string;
  markdown: string;
  method: "defuddle" | "readability" | "none";
  /** Length of the extracted plain text. */
  textLength: number;
}

function plainLength(markdown: string): number {
  return stripInline(markdown.replace(/^#{1,6}\s+/gm, "").replace(/^```.*$/gm, ""))
    .replace(/\s+/g, " ")
    .trim().length;
}

const noNetwork: FetchImpl = async () => {
  throw new Error("network access disabled during extraction");
};

/**
 * Extract title + main content as markdown: defuddle first, Readability when
 * defuddle yields fewer than `minChars` characters. Scripts are never run
 * (linkedom does not execute them) and defuddle's async extractors are off.
 */
export async function extractHtml(html: string, url: string, minChars = MIN_CONTENT_CHARS): Promise<HtmlExtraction> {
  const titleFromDoc = (doc: Document) => doc.querySelector("title")?.textContent?.trim() || undefined;

  let best: HtmlExtraction = { markdown: "", method: "none", textLength: 0 };
  try {
    const { document } = parseHTML(html);
    const r = await Defuddle(document as unknown as Document, url, {
      markdown: true,
      useAsync: false,
      fetch: noNetwork as typeof globalThis.fetch,
    });
    const markdown = (r.contentMarkdown ?? r.content ?? "").trim();
    best = {
      ...(r.title?.trim() ? { title: r.title.trim() } : {}),
      markdown,
      method: "defuddle",
      textLength: plainLength(markdown),
    };
  } catch {
    // fall through to Readability
  }
  if (best.textLength >= minChars) return best;

  try {
    const { document } = parseHTML(html);
    const doc = document as unknown as Document;
    const docTitle = titleFromDoc(doc);
    const article = new Readability<Node>(doc, { serializer: (n) => n, charThreshold: 0 }).parse();
    const node = article?.content;
    if (node && node.nodeType === 1) {
      const markdown = htmlToMarkdown(node as Element).trim();
      const textLength = plainLength(markdown);
      if (textLength > best.textLength) {
        const title = article?.title?.trim() || best.title || docTitle;
        best = { ...(title ? { title } : {}), markdown, method: "readability", textLength };
      }
    }
    if (!best.title && docTitle) best = { ...best, title: docTitle };
  } catch {
    // keep whatever defuddle produced
  }
  return best;
}

export interface UrlExtractorOptions extends FetchOptions {
  minContentChars?: number;
}

export const URL_EXTRACTOR_VERSION = "1";

/**
 * A saved web page on disk (`.html`/`.htm`), read like a fetched page. Its "URL" is the file name
 * (refs encode it: `url:MSB%20Docs.html#pricing`), so evidence never carries a machine path. The charset comes from `<meta charset>` when present.
 */
export async function loadLocalPage(path: string, maxBytes = MAX_LOCAL_HTML_BYTES): Promise<FetchedPage> {
  // Stat the open handle before reading, so a multi-GB page is refused without being loaded.
  const fh = await open(path, "r");
  let body: Uint8Array;
  try {
    const { size } = await fh.stat();
    if (size > maxBytes) {
      throw new UrlFetchError("too_large", `${basename(path)} is ${size} bytes; saved web pages are limited to ${maxBytes} bytes (${Math.round(maxBytes / 1024 / 1024)} MB)`);
    }
    // Read at most maxBytes + 1 in case the file grew after the stat.
    const buf = Buffer.alloc(size + 1 > maxBytes + 1 ? maxBytes + 1 : size + 1);
    let off = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
      if (off >= buf.length) break;
    }
    if (off > maxBytes) throw new UrlFetchError("too_large", `${basename(path)} exceeds ${maxBytes} bytes`);
    body = new Uint8Array(buf.buffer, buf.byteOffset, off);
  } finally {
    await fh.close();
  }
  const head = new TextDecoder("latin1").decode(body.subarray(0, 4096));
  const charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]?.toLowerCase();
  const name = basename(path);
  return { url: name, finalUrl: name, status: 200, mediaType: "text/html", ...(charset ? { charset } : {}), body };
}

const isLocalPage = (uri: string) => !/^https?:\/\//i.test(uri) && /\.html?$/i.test(uri) && existsSync(uri);

/** Build a URL extractor; inject `fetch` for tests or custom transports. */
export function createUrlExtractor(options: UrlExtractorOptions = {}): Extractor {
  const minChars = options.minContentChars ?? MIN_CONTENT_CHARS;
  // inputDigest() fetches the page to hash its body; extract() then reuses that
  // response instead of fetching again. Bounded so cache hits cannot leak pages.
  const prefetched = new Map<string, FetchedPage>();
  const remember = (uri: string, page: FetchedPage) => {
    prefetched.set(uri, page);
    while (prefetched.size > 4) prefetched.delete(prefetched.keys().next().value!);
  };
  return {
    version: URL_EXTRACTOR_VERSION,
    kinds: ["url"],
    async inputDigest(input: ExtractInput): Promise<string> {
      const page = isLocalPage(input.uri) ? await loadLocalPage(input.uri) : await fetchPage(input.uri, options);
      remember(input.uri, page);
      return createHash("sha256").update(page.body).digest("hex");
    },
    async extract(input: ExtractInput): Promise<ExtractedSource> {
      const page = prefetched.get(input.uri) ?? (isLocalPage(input.uri) ? await loadLocalPage(input.uri) : await fetchPage(input.uri, options));
      prefetched.delete(input.uri);
      const sha256 = createHash("sha256").update(page.body).digest("hex");
      const body = decode(page.body, page.charset);
      const warnings: ExtractedSource["warnings"] = [];

      let title: string | undefined;
      let markdown: string;
      let textLength: number;
      if (TEXT_TYPES.has(page.mediaType)) {
        markdown = body.replace(/\r\n?/g, "\n");
        textLength = plainLength(markdown);
      } else {
        // A local page's "URL" is its file name; the extractors need an absolute URL to resolve against.
        const docUrl = /^https?:\/\//i.test(page.finalUrl) ? page.finalUrl : `file:///${encodeURIComponent(page.finalUrl)}`;
        const ex = await extractHtml(body, docUrl, minChars);
        title = ex.title;
        markdown = ex.markdown;
        textLength = ex.textLength;
        if (ex.method === "readability") {
          warnings.push({ code: "readability_fallback", message: "defuddle returned too little content; used Readability instead." });
        }
      }
      if (textLength < minChars) {
        warnings.push({
          code: "thin_content",
          message: `Only ${textLength} characters of main content were extracted from ${page.finalUrl}. The page may render client-side; a browser-based fetch would be needed (not implemented yet).`,
        });
      }

      const parsed = parseMarkdown(markdown);
      title ??= parsed.title;
      // Heading anchors are reserved up front so the first span under each
      // heading gets the exact anchor; further spans get -2, -3… suffixes.
      const topAnchor = title ? slugify(title, "top") : "top";
      const anchorOf = (s: MdSection | undefined) => (s ? (s.slug ?? topAnchor) : "front-matter");
      const used = new Set<string>(["front-matter", ...parsed.sections.map(anchorOf)]);
      const anchored = new Set<string>();
      const { sections, evidence } = markdownToParts(
        parsed,
        (_b, s) => {
          const anchor = anchorOf(s);
          if (!anchored.has(anchor)) {
            anchored.add(anchor);
            return urlRef(page.finalUrl, anchor);
          }
          return urlRef(page.finalUrl, uniquify(anchor, used));
        },
        { includeLocatorLines: false },
      );
      return {
        source: { kind: "url", uri: page.finalUrl, sha256, ...(title ? { title } : {}) },
        sections,
        evidence,
        assets: [],
        warnings,
      };
    },
  };
}

/** Default URL extractor using global fetch. */
export const urlExtractor: Extractor = createUrlExtractor();

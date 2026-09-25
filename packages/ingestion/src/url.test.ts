import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SourceRef } from "@video-studio/schema";
import { USER_AGENT, UrlFetchError, createUrlExtractor, extractHtml, fetchPage, type FetchImpl } from "./url.js";

const FIXTURES = join(import.meta.dirname, "../../../fixtures/html");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

interface Route {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

/** Fixture-backed fetch: no network. Records requests for assertions. */
function fakeFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl: FetchImpl = async (url, init) => {
    calls.push({ url, ...(init ? { init } : {}) });
    const r = routes[url];
    if (!r) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    return new Response(r.body ?? "", {
      status: r.status ?? 200,
      headers: { "content-type": "text/html; charset=utf-8", ...r.headers },
    });
  };
  return { impl, calls };
}

describe("fetchPage", () => {
  it("follows redirects manually, sends the user agent and caps size", async () => {
    const { impl, calls } = fakeFetch({
      "https://example.com/a": { status: 301, headers: { location: "/b" } },
      "https://example.com/b": { body: "<p>hi</p>" },
    });
    const page = await fetchPage("https://example.com/a", { fetch: impl });
    expect(page.finalUrl).toBe("https://example.com/b");
    expect(page.mediaType).toBe("text/html");
    expect(page.charset).toBe("utf-8");
    expect(new Headers(calls[0]!.init!.headers).get("user-agent")).toBe(USER_AGENT);
    expect(USER_AGENT).toBe("video-studio/0.1 (+ingest)");
    expect(calls[0]!.init!.redirect).toBe("manual");
  });

  it("rejects redirect loops, non-http redirects, big bodies and bad content types", async () => {
    const loop = fakeFetch({ "https://example.com/l": { status: 302, headers: { location: "https://example.com/l" } } });
    await expect(fetchPage("https://example.com/l", { fetch: loop.impl, maxRedirects: 3 })).rejects.toMatchObject({ code: "too_many_redirects" });
    expect(loop.calls).toHaveLength(4);

    const file = fakeFetch({ "https://example.com/f": { status: 302, headers: { location: "file:///etc/passwd" } } });
    await expect(fetchPage("https://example.com/f", { fetch: file.impl })).rejects.toMatchObject({ code: "invalid_url" });

    const big = fakeFetch({ "https://example.com/big": { body: "x".repeat(2048) } });
    await expect(fetchPage("https://example.com/big", { fetch: big.impl, maxBytes: 1024 })).rejects.toMatchObject({ code: "too_large" });

    const img = fakeFetch({ "https://example.com/i": { body: "GIF89a", headers: { "content-type": "image/gif" } } });
    await expect(fetchPage("https://example.com/i", { fetch: img.impl })).rejects.toMatchObject({ code: "unsupported_content_type" });

    const e404 = fakeFetch({});
    await expect(fetchPage("https://example.com/missing", { fetch: e404.impl })).rejects.toMatchObject({ code: "http_error" });

    await expect(fetchPage("ftp://example.com/x", { fetch: e404.impl })).rejects.toBeInstanceOf(UrlFetchError);
  });

  it("times out", async () => {
    const hang: FetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    await expect(fetchPage("https://example.com/slow", { fetch: hang, timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("extractHtml", () => {
  it("uses defuddle markdown for a normal article", async () => {
    const r = await extractHtml(fixture("blog-vector-db.html"), "https://blog.example.com/vector-dbs");
    expect(r.method).toBe("defuddle");
    expect(r.title).toBe("Why Vector Databases Matter");
    expect(r.markdown).toContain("## How approximate search works");
    expect(r.markdown).toContain("```python\nclient = VectorClient");
    expect(r.markdown).not.toContain("Related posts");
    expect(r.markdown).not.toContain("All rights reserved");
  });

  it("falls back to Readability when defuddle output is below the threshold", async () => {
    const r = await extractHtml(fixture("blog-vector-db.html"), "https://blog.example.com/vector-dbs", 5000);
    expect(r.method).toBe("readability");
    expect(r.markdown).toContain("## Getting started");
    expect(r.markdown).toContain("- HNSW builds a layered proximity graph");
    expect(r.markdown).toMatch(/```\nclient = VectorClient/);
  });
});

describe("urlExtractor", () => {
  it("extracts a blog article into heading-keyed evidence", async () => {
    const url = "https://blog.example.com/vector-dbs";
    const { impl } = fakeFetch({ [url]: { body: fixture("blog-vector-db.html") } });
    const out = await createUrlExtractor({ fetch: impl }).extract({ uri: url, kind: "url" });
    expect(out.source).toMatchObject({ kind: "url", uri: url, title: "Why Vector Databases Matter" });
    expect(out.warnings).toEqual([]);
    expect(out.sections.map((s) => s.heading)).toEqual([undefined, "How approximate search works", "Getting started", "Getting started"]);
    const refs = out.evidence.map((e) => e.ref);
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs).toContain(`url:${url}#why-vector-databases-matter`);
    expect(refs).toContain(`url:${url}#getting-started`);
    expect(refs).toContain(`url:${url}#getting-started-2`);
    for (const r of refs) expect(SourceRef.safeParse(r).success).toBe(true);
    expect(out).toMatchSnapshot();
  });

  it("extracts a docs page (redirected) with code, table and quote", async () => {
    const { impl } = fakeFetch({
      "http://docs.example.com/install": { status: 308, headers: { location: "https://docs.example.com/docs/install" } },
      "https://docs.example.com/docs/install": { body: fixture("docs-install.html") },
    });
    const out = await createUrlExtractor({ fetch: impl }).extract({ uri: "http://docs.example.com/install", kind: "url" });
    expect(out.source.uri).toBe("https://docs.example.com/docs/install");
    expect(out.sections.map((s) => s.heading)).toEqual(["Installation", "Install with npm", "Verify the installation"]);
    expect(out.evidence.find((e) => e.text.includes("npx widgetron doctor"))?.ref).toBe(
      "url:https://docs.example.com/docs/install#verify-the-installation-2",
    );
    expect(out.evidence.some((e) => e.text.includes("Introduction"))).toBe(false);
    expect(out).toMatchSnapshot();
  });

  it("warns thin_content for a client-rendered shell", async () => {
    const url = "https://app.example.com/";
    const { impl } = fakeFetch({ [url]: { body: fixture("spa-shell.html") } });
    const out = await createUrlExtractor({ fetch: impl }).extract({ uri: url, kind: "url" });
    expect(out.source.title).toBe("Dashboard");
    expect(out.evidence).toEqual([]);
    expect(out.warnings.map((w) => w.code)).toEqual(["thin_content"]);
    expect(out.warnings[0]!.message).toMatch(/browser/);
  });

  it("records the Readability fallback as a warning", async () => {
    const url = "https://blog.example.com/vector-dbs";
    const { impl } = fakeFetch({ [url]: { body: fixture("blog-vector-db.html") } });
    const out = await createUrlExtractor({ fetch: impl, minContentChars: 5000 }).extract({ uri: url, kind: "url" });
    expect(out.warnings.map((w) => w.code)).toEqual(["readability_fallback", "thin_content"]);
  });
});

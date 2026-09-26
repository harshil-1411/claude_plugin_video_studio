import { once } from "node:events";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingest } from "./ingest.js";
import { type LookupFn, isPrivateAddress } from "./net-guard.js";
import { MAX_LOCAL_HTML_BYTES, UrlFetchError, fetchPage, loadLocalPage, pinnedFetch, type FetchImpl } from "./url.js";

const PAGE = `<html><head><title>Public page</title></head><body><article><h1>Public page</h1><p>${"Plain public words about vector search. ".repeat(10)}</p></article></body></html>`;

/** Fake DNS: host → addresses. Unknown hosts fail like NXDOMAIN. */
function fakeLookup(table: Record<string, string[]>): LookupFn & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (host: string) => {
    calls.push(host);
    const list = table[host];
    if (!list) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
    return list.map((address) => ({ address, family: address.includes(":") ? (6 as const) : (4 as const) }));
  }) as LookupFn & { calls: string[] };
  fn.calls = calls;
  return fn;
}

/** Fixture fetch; records every URL it was asked for. */
function fakeFetch(routes: Record<string, { status?: number; headers?: Record<string, string>; body?: string }>) {
  const calls: string[] = [];
  const impl: FetchImpl = async (url) => {
    calls.push(url);
    const r = routes[url];
    if (!r) return new Response("nope", { status: 404, headers: { "content-type": "text/plain" } });
    return new Response(r.body ?? "", { status: r.status ?? 200, headers: { "content-type": "text/html", ...r.headers } });
  };
  return { impl, calls };
}

const DNS = fakeLookup({
  "public.example": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
  "evil.example": ["93.184.216.34", "127.0.0.1"], // any private answer is enough to refuse
  "ten.example": ["10.1.2.3"],
  "metadata.example": ["169.254.169.254"],
  "v6loop.example": ["::1"],
  "mapped.example": ["::ffff:127.0.0.1"],
  localhost: ["127.0.0.1"],
});

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1", "127.8.9.10", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0",
    "100.64.0.1", "224.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe", "::127.0.0.1", "[::1]", "not-an-ip",
  ])("refuses %s", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:2800:220:1:248:1893:25c8:1946", "::ffff:8.8.8.8", "64:ff9b::808:808"])(
    "allows %s",
    (ip) => expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe("fetchPage SSRF guard", () => {
  const ok = fakeFetch({
    "https://public.example/a": { body: PAGE },
    "https://public.example/to-private": { status: 302, headers: { location: "http://ten.example/admin" } },
    "https://public.example/to-metadata": { status: 301, headers: { location: "http://169.254.169.254/latest/meta-data/" } },
    "https://public.example/to-localhost": { status: 307, headers: { location: "http://localhost:8888/api/sessions" } },
  });

  it("fetches a host that resolves only to public addresses", async () => {
    const page = await fetchPage("https://public.example/a", { fetch: ok.impl, lookup: DNS });
    expect(page.status).toBe(200);
    expect(DNS.calls).toContain("public.example");
  });

  it.each([
    ["http://127.0.0.1:9/admin", "127.0.0.1"],
    ["http://localhost:8888/api/sessions", "localhost"],
    ["http://app.localhost/", "localhost"],
    ["http://10.0.0.5/", "10.0.0.5"],
    ["http://169.254.169.254/latest/meta-data/iam/security-credentials/", "169.254.169.254"],
    ["http://[::1]:8080/", "::1"],
    ["http://[::ffff:127.0.0.1]/", "::ffff:7f00:1"],
    ["http://0x7f.1/", "127.0.0.1"],
    ["http://ten.example/", "10.1.2.3"],
    ["http://metadata.example/", "169.254.169.254"],
    ["http://v6loop.example/", "::1"],
    ["http://mapped.example/", "::ffff:127.0.0.1"],
    ["http://evil.example/", "127.0.0.1"],
  ])("refuses %s", async (url, ip) => {
    const f = fakeFetch({});
    const err = await fetchPage(url, { fetch: f.impl, lookup: DNS }).catch((e) => e);
    expect(err).toBeInstanceOf(UrlFetchError);
    expect(err.code).toBe("blocked_address");
    expect(err.message).toContain(`refusing to fetch `);
    expect(err.message).toContain(`resolves to a private or local address (${ip})`);
    expect(f.calls).toEqual([]); // nothing was requested
  });

  it("refuses literal private IPs and localhost even when the injected transport resolves names itself", async () => {
    const f = fakeFetch({});
    await expect(fetchPage("http://127.0.0.1/", { fetch: f.impl })).rejects.toMatchObject({ code: "blocked_address" });
    await expect(fetchPage("http://localhost/", { fetch: f.impl })).rejects.toMatchObject({ code: "blocked_address" });
    expect(f.calls).toEqual([]);
  });

  it("re-validates every redirect hop: public → private is refused before the second request", async () => {
    for (const path of ["to-private", "to-metadata", "to-localhost"]) {
      ok.calls.length = 0;
      await expect(fetchPage(`https://public.example/${path}`, { fetch: ok.impl, lookup: DNS })).rejects.toMatchObject({ code: "blocked_address" });
      expect(ok.calls).toEqual([`https://public.example/${path}`]);
    }
  });

  it("refuses non-http(s) schemes", async () => {
    await expect(fetchPage("file:///etc/passwd", { lookup: DNS })).rejects.toMatchObject({ code: "invalid_url" });
    await expect(fetchPage("gopher://public.example/", { lookup: DNS })).rejects.toMatchObject({ code: "invalid_url" });
  });

  it("allowPrivateAddresses (the user's VS_ALLOW_PRIVATE_URLS=1) lets local URLs through", async () => {
    const f = fakeFetch({ "http://127.0.0.1:9/admin": { body: PAGE } });
    const page = await fetchPage("http://127.0.0.1:9/admin", { fetch: f.impl, lookup: DNS, allowPrivateAddresses: true });
    expect(page.status).toBe(200);
  });
});

describe("pinned transport and ingest env override (local server)", () => {
  let server: Server;
  let port: number;
  let tmp: string;
  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "vs-ssrf-"));
    server = createServer((req, res) => {
      if (req.url === "/gz") {
        res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
        res.end(gzipSync(PAGE));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-host": req.headers.host ?? "" });
      res.end(PAGE);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("connects to the pinned address, never re-resolving the host name (DNS rebinding)", async () => {
    // "rebind.invalid" cannot resolve; the request still reaches the pinned address with the original Host header.
    const res = await pinnedFetch(`http://rebind.invalid:${port}/`, undefined, [{ address: "127.0.0.1", family: 4 }]);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-host")).toBe(`rebind.invalid:${port}`);
    expect(await res.text()).toContain("Public page");
    const gz = await pinnedFetch(`http://rebind.invalid:${port}/gz`, undefined, [{ address: "127.0.0.1", family: 4 }]);
    expect(await gz.text()).toBe(PAGE);
  });

  it("ingest refuses a loopback URL by default and allows it with VS_ALLOW_PRIVATE_URLS=1 in env", async () => {
    const url = `http://127.0.0.1:${port}/page`;
    await expect(ingest([url], { projectDir: join(tmp, "p1"), noCache: true, env: {} })).rejects.toThrow(
      `refusing to fetch ${url}: 127.0.0.1 resolves to a private or local address (127.0.0.1)`,
    );
    const { ir } = await ingest([url], { projectDir: join(tmp, "p2"), noCache: true, env: { VS_ALLOW_PRIVATE_URLS: "1" } });
    expect(ir.evidence.map((e) => e.text).join("\n")).toContain("Plain public words");
  });

  it("ingest re-checks a redirect to a private host via the injected resolver", async () => {
    const f = fakeFetch({ "https://public.example/r": { status: 302, headers: { location: "http://metadata.example/latest" } } });
    await expect(ingest(["https://public.example/r"], { projectDir: join(tmp, "p3"), noCache: true, env: {}, fetch: f.impl, lookup: DNS })).rejects.toThrow(
      /metadata\.example resolves to a private or local address \(169\.254\.169\.254\)/,
    );
  });
});

describe("saved .html size cap (S9)", () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "vs-bightml-"));
  });
  afterAll(() => rm(tmp, { recursive: true, force: true }));

  it("refuses a page over the cap without reading it (sparse file)", async () => {
    const file = join(tmp, "huge.html");
    await writeFile(file, "<html>");
    await truncate(file, MAX_LOCAL_HTML_BYTES + 1); // sparse: no real disk or memory used
    const err = await loadLocalPage(file).catch((e) => e);
    expect(err).toBeInstanceOf(UrlFetchError);
    expect(err.code).toBe("too_large");
    expect(err.message).toMatch(/huge\.html is 20971521 bytes; saved web pages are limited to 20971520 bytes \(20 MB\)/);
    await expect(ingest([file], { projectDir: join(tmp, "proj"), noCache: true, cwd: tmp })).rejects.toThrow(/saved web pages are limited/);
  });

  it("reads a page within the cap", async () => {
    const file = join(tmp, "ok.html");
    await writeFile(file, PAGE);
    const page = await loadLocalPage(file, 4096);
    expect(new TextDecoder().decode(page.body)).toBe(await readFile(file, "utf8"));
    await expect(loadLocalPage(file, 16)).rejects.toMatchObject({ code: "too_large" });
  });
});

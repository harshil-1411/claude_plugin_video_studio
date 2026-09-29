import { isLinkLocal } from "@video-studio/ingestion";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type CallToolResult, ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { type FetchImpl, type LookupFn, type PageRenderer, createUrlExtractor, extractHtml } from "@video-studio/ingestion";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readConsents } from "./consent.js";
import {
  LOCKDOWN_SCRIPT,
  OUTER_HTML_SCRIPT,
  OVERLAY_SCRIPT,
  PageBudget,
  type RenderBrowserFactory,
  type RenderRequest,
  createHostCheck,
  forwardHeaders,
  renderChromeArgs,
  renderPage,
  requestVerdict,
  responseHeaders,
  screenshotPicks,
  screenshotViewport,
  sectionScrollPlan,
  waitForQuiet,
} from "./render-page.js";
import { createServer } from "./server.js";

const SPA = resolve(import.meta.dirname, "../../../fixtures/spa");

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-render-page-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const lookup: LookupFn = async (host) => {
  const table: Record<string, string> = { "spa.example": "93.184.216.34", "cdn.example": "151.101.1.1", "evil.example": "192.168.1.10", "meta.example": "169.254.169.254" };
  const ip = table[host];
  if (!ip) throw new Error(`ENOTFOUND ${host}`);
  return [{ address: ip, family: 4 }];
};

describe("request policy", () => {
  const v = (url: string, method = "GET", resourceType = "script") => requestVerdict({ url, method, resourceType });
  it("keeps data: and blob: in the page, fetches http(s), blocks the rest", () => {
    expect(v("data:image/png;base64,AAAA")).toEqual({ action: "local" });
    expect(v("blob:https://spa.example/1234")).toEqual({ action: "local" });
    expect(v("https://spa.example/app.js")).toMatchObject({ action: "fetch" });
    expect(v("file:///etc/passwd")).toEqual({ action: "block", reason: "scheme file:" });
    expect(v("chrome://settings", "GET", "document")).toEqual({ action: "block", reason: "scheme chrome:" });
    expect(v("wss://spa.example/live", "GET", "websocket")).toEqual({ action: "block", reason: "scheme wss:" });
    expect(v("https://spa.example/live", "GET", "websocket")).toEqual({ action: "block", reason: "websocket" });
    expect(v("https://spa.example/clip.mp4", "GET", "media")).toEqual({ action: "block", reason: "media (audio/video)" });
    expect(v("https://spa.example/b", "POST", "ping")).toEqual({ action: "block", reason: "beacon" });
    expect(v("https://u:p@spa.example/")).toEqual({ action: "block", reason: "credentials in URL" });
  });

  it("allows GET, HEAD, POST and CORS preflights only", () => {
    expect(v("https://spa.example/api", "POST", "fetch")).toMatchObject({ action: "fetch" });
    expect(v("https://spa.example/api", "HEAD", "fetch")).toMatchObject({ action: "fetch" });
    expect(v("https://spa.example/api", "DELETE", "fetch")).toEqual({ action: "block", reason: "method DELETE" });
    expect(v("https://spa.example/api", "OPTIONS", "preflight")).toMatchObject({ action: "fetch" });
    expect(v("https://spa.example/api", "OPTIONS", "fetch")).toEqual({ action: "block", reason: "method OPTIONS" });
  });

  it("counts requests and bytes against the budget", () => {
    const b = new PageBudget(2, 1000);
    expect([b.take(), b.take(), b.take()]).toEqual([true, true, false]);
    expect(b.allowance(600)).toBe(600);
    b.addBytes(700);
    expect(b.allowance(600)).toBe(300);
    b.addBytes(300);
    expect(b.allowance()).toBe(0);
    b.block("http://10.0.0.5/", "private address (10.0.0.5)");
    b.block("wss://x/", "scheme wss:");
    b.block("wss://y/", "scheme wss:");
    expect(b.summary()).toBe("2 request(s) made (1 KB), 3 blocked (1 private address (10.0.0.5), 2 scheme wss:)");
  });

  it("checks every host with the SSRF guard; with the opt-out, link-local stays blocked", async () => {
    const strict = createHostCheck({ lookup, allowPrivate: false });
    expect(await strict(new URL("https://spa.example/"))).toEqual({ ok: true, pinned: [{ address: "93.184.216.34", family: 4 }] });
    expect(await strict(new URL("http://10.0.0.5/secret"))).toEqual({ ok: false, reason: "private address (10.0.0.5)" });
    expect(await strict(new URL("http://169.254.169.254/latest/meta-data/"))).toEqual({ ok: false, reason: "private address (169.254.169.254)" });
    expect(await strict(new URL("https://evil.example/"))).toEqual({ ok: false, reason: "private address (192.168.1.10)" });
    expect(await strict(new URL("http://localhost:3000/"))).toEqual({ ok: false, reason: "private address (localhost)" });
    expect(await strict(new URL("https://nowhere.example/"))).toEqual({ ok: false, reason: "unresolvable host" });
    const open = createHostCheck({ lookup, allowPrivate: true });
    expect(await open(new URL("http://127.0.0.1:8080/"))).toEqual({ ok: true, pinned: [{ address: "127.0.0.1", family: 4 }] });
    expect(await open(new URL("http://10.0.0.5/"))).toMatchObject({ ok: true });
    expect(await open(new URL("http://169.254.169.254/"))).toEqual({ ok: false, reason: "link-local address (169.254.169.254)" });
    expect(await open(new URL("http://meta.example/"))).toEqual({ ok: false, reason: "link-local address (169.254.169.254)" });
    expect(await open(new URL("http://[fe80::1]/"))).toEqual({ ok: false, reason: "link-local address (fe80::1)" });
    expect([isLinkLocal("::ffff:169.254.169.254"), isLinkLocal("fe80::abcd"), isLinkLocal("10.0.0.1"), isLinkLocal("::1")]).toEqual([true, true, false, false]);
  });

  it("never forwards cookies or credentials, and hands back decoded, cookie-free responses", () => {
    expect(forwardHeaders({ Cookie: "sid=1", Authorization: "Bearer x", Accept: "*/*", "User-Agent": "Chrome", Referer: "https://spa.example/" })).toEqual({
      accept: "*/*",
      "user-agent": "Chrome",
      referer: "https://spa.example/",
    });
    const h = new Headers({ "content-type": "text/html", "content-encoding": "gzip", "content-length": "10", "set-cookie": "sid=1", location: "/b" });
    expect(responseHeaders(h)).toEqual({ "content-type": "text/html", location: "/b" });
  });

  it("isolates Chrome: dead proxy for everything interception misses, no new windows, no prompts", () => {
    const args = renderChromeArgs();
    expect(args).toEqual(expect.arrayContaining(["--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>", "--block-new-web-contents", "--deny-permission-prompts"]));
    expect(LOCKDOWN_SCRIPT).toMatch(/window, "open"/);
    expect(LOCKDOWN_SCRIPT).toMatch(/serviceWorker\.register/);
  });
});

describe("page scripts and plans", () => {
  it("overlay CSS hides fixed and sticky elements and undoes scroll locks; nothing is clicked", () => {
    expect(OVERLAY_SCRIPT).toMatch(/pos === "fixed" \|\| pos === "sticky"/);
    expect(OVERLAY_SCRIPT).toMatch(/\[data-vs-overlay\] \{ display: none !important; \}/);
    expect(OVERLAY_SCRIPT).toMatch(/overflow: auto !important/);
    for (const src of [OVERLAY_SCRIPT, OUTER_HTML_SCRIPT, LOCKDOWN_SCRIPT]) expect(src).not.toMatch(/\.click\(|dispatchEvent|submit\(/);
    expect(OUTER_HTML_SCRIPT).toMatch(/\[data-vs-overlay\].*remove\(\)/s);
  });

  it("scrolls section by section to the bottom, thinning long pages", () => {
    expect(sectionScrollPlan(3000, 700)).toEqual([0, 630, 1260, 1890, 2300]);
    expect(sectionScrollPlan(500, 700)).toEqual([0]);
    expect(sectionScrollPlan(1330, 700)).toEqual([0, 630]);
    const long = sectionScrollPlan(100_000, 700, 12);
    expect(long).toHaveLength(12);
    expect(long[0]).toBe(0);
    expect(long.at(-1)).toBe(99_300);
  });

  it("screenshots the top and up to three sections", () => {
    expect(screenshotPicks(1)).toEqual([0]);
    expect(screenshotPicks(3)).toEqual([0, 1, 2]);
    expect(screenshotPicks(10)).toEqual([0, 3, 6, 9]);
  });

  it("lays out at the video's aspect with 1080 px on the short side", () => {
    const px = (v: ReturnType<typeof screenshotViewport>) => [Math.round(v.width * v.deviceScaleFactor), Math.round(v.height * v.deviceScaleFactor)];
    expect(screenshotViewport()).toEqual({ width: 390, height: 693, deviceScaleFactor: 2.769 });
    expect(px(screenshotViewport("9:16"))).toEqual([1080, 1919]);
    expect(screenshotViewport("16:9")).toEqual({ width: 1280, height: 720, deviceScaleFactor: 1.5 });
    expect(px(screenshotViewport("1:1"))).toEqual([1080, 1080]);
    // CSS pixels are whole, so the long side can land a pixel off.
    const [w45, h45] = px(screenshotViewport("4:5"));
    expect(w45).toBe(1080);
    expect(Math.abs(h45! - 1350)).toBeLessThanOrEqual(1);
    expect(screenshotViewport("nonsense")).toEqual(screenshotViewport("9:16"));
  });

  it("waits for the network to go quiet, bounded", async () => {
    let t = 0;
    const clock = { now: () => t, sleep: async (ms: number) => void (t += ms) };
    let n = 2;
    const busyUntil = 700;
    const inflight = () => (t < busyUntil ? n : (n = 0));
    expect(await waitForQuiet(inflight, { ...clock, maxMs: 5000 })).toBe(true);
    expect(t).toBe(1200);
    t = 0;
    expect(await waitForQuiet(() => 1, { ...clock, maxMs: 800 })).toBe(false);
    expect(t).toBe(800);
  });
});

// ---------------------------------------------------------------------------------- fake Chrome

interface FakeSpec {
  url: string;
  method?: string;
  type?: string;
  nav?: boolean;
  post?: string;
}

const SHELL = `<!doctype html><html><head><title>Loading…</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>`;
const RENDERED = `<!doctype html><html><head><title>Orbitdesk</title></head><body><div id="root"><article><h1>Orbitdesk: shared inboxes</h1>
<p>Orbitdesk gives a support team of two to twenty people one shared inbox for email, chat and forms. Every conversation gets an owner, a status and a due time, so nothing waits in a personal mailbox.</p>
<h2>Assign in one keystroke</h2><p>Press A to assign the open conversation to yourself or a teammate, and see who is already typing a reply so two people never answer the same customer.</p></article></div></body></html>`;

/** A scripted stand-in for puppeteer: goto fires `requests` (the first is the navigation) through the handler. */
function fakeChrome(requests: FakeSpec[], o: { height?: number; popup?: boolean; html?: string } = {}) {
  const outcomes = new Map<string, { kind: "respond" | "abort" | "continue"; status?: number; headers?: Record<string, string>; body?: string }>();
  const log = { evaluated: [] as string[], newDocument: [] as string[], shots: 0, closed: false, popupClosed: false, viewport: undefined as unknown, userDataDir: "" };
  const factory: RenderBrowserFactory = async ({ viewport, userDataDir }) => {
    log.viewport = viewport;
    log.userDataDir = userDataDir;
    let onRequest: ((r: RenderRequest) => void) | undefined;
    let onTarget: ((t: { type(): string; page(): Promise<{ close(): Promise<void> } | null> }) => void) | undefined;
    const fire = (s: FakeSpec) =>
      new Promise<void>((done) => {
        const req: RenderRequest = {
          url: () => s.url,
          method: () => s.method ?? "GET",
          resourceType: () => s.type ?? "script",
          headers: () => ({ accept: "*/*", "user-agent": "HeadlessChrome", cookie: "sid=secret" }),
          postData: () => s.post,
          isNavigationRequest: () => s.nav === true,
          abort: async () => void (outcomes.set(s.url, { kind: "abort" }), done()),
          continue: async () => void (outcomes.set(s.url, { kind: "continue" }), done()),
          respond: async (r) => void (outcomes.set(s.url, { kind: "respond", status: r.status, headers: r.headers, body: new TextDecoder().decode(r.body) }), done()),
        };
        onRequest!(req);
      });
    return {
      newPage: async () => ({
        setRequestInterception: async () => undefined,
        on: (_e: "request", fn: (r: RenderRequest) => void) => (onRequest = fn),
        evaluateOnNewDocument: async (src: string) => void log.newDocument.push(src),
        setBypassServiceWorker: async () => undefined,
        goto: async () => {
          await fire(requests[0]!);
          if (outcomes.get(requests[0]!.url)?.kind !== "respond") throw new Error("net::ERR_BLOCKED_BY_CLIENT");
          await Promise.all(requests.slice(1).map(fire));
          if (o.popup) onTarget?.({ type: () => "page", page: async () => ({ close: async () => void (log.popupClosed = true) }) });
        },
        evaluate: async <T>(src: string): Promise<T> => {
          log.evaluated.push(src);
          if (src === OUTER_HTML_SCRIPT) return (o.html ?? RENDERED) as T;
          if (src.includes("scrollHeight")) return { h: o.height ?? 2000, vh: 693 } as T;
          return 0 as T;
        },
        screenshot: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ++log.shots]),
        url: () => requests[0]!.url,
      }),
      on: (_e: "targetcreated", fn) => (onTarget = fn),
      close: async () => void (log.closed = true),
    };
  };
  return { factory, outcomes, log };
}

function fakeFetch(routes: Record<string, { status?: number; body?: string; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl: FetchImpl = async (url, init) => {
    calls.push({ url, ...(init ? { init } : {}) });
    const r = routes[url] ?? { status: 404, body: "not found" };
    return new Response(r.body ?? "", { status: r.status ?? 200, headers: { "content-type": "text/html", ...r.headers } });
  };
  return { impl, calls };
}

const fastClock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms, await Promise.resolve()) };
};

describe("renderPage (fake Chrome)", () => {
  const requests: FakeSpec[] = [
    { url: "https://spa.example/app", nav: true, type: "document" },
    { url: "https://spa.example/app.js" },
    { url: "https://cdn.example/logo.png", type: "image" },
    { url: "https://spa.example/api/graphql", method: "POST", type: "fetch", post: '{"query":"{articles}"}' },
    { url: "http://10.0.0.5/secret", type: "fetch" },
    { url: "http://169.254.169.254/latest/meta-data/", type: "fetch" },
    { url: "https://evil.example/x", type: "xhr" },
    { url: "https://spa.example/live", type: "websocket" },
    { url: "https://spa.example/api/item/1", method: "DELETE", type: "fetch" },
    { url: "data:image/png;base64,AAAA", type: "image" },
    { url: "https://spa.example/big.bin", type: "other" },
  ];
  const routes = {
    "https://spa.example/app": { body: SHELL, headers: { "set-cookie": "sid=1", "content-encoding": "identity" } },
    "https://spa.example/app.js": { body: "/* app */", headers: { "content-type": "text/javascript" } },
    "https://cdn.example/logo.png": { body: "png", headers: { "content-type": "image/png" } },
    "https://spa.example/api/graphql": { body: "{}", headers: { "content-type": "application/json" } },
    "https://spa.example/big.bin": { body: "x".repeat(5000) },
  };

  it("fetches through the guard, blocks private hosts, schemes and methods, and returns the rendered DOM", async () => {
    const chrome = fakeChrome(requests, { popup: true });
    const net = fakeFetch(routes);
    const page = await renderPage("https://spa.example/app", { browser: chrome.factory, fetch: net.impl, lookup, env: {}, maxBytes: 4000, ...fastClock() });
    expect(page.html).toBe(RENDERED);
    expect(page.finalUrl).toBe("https://spa.example/app");
    const kinds = Object.fromEntries([...chrome.outcomes].map(([u, x]) => [u, x.kind]));
    expect(kinds).toEqual({
      "https://spa.example/app": "respond",
      "https://spa.example/app.js": "respond",
      "https://cdn.example/logo.png": "respond",
      "https://spa.example/api/graphql": "respond",
      "http://10.0.0.5/secret": "abort",
      "http://169.254.169.254/latest/meta-data/": "abort",
      "https://evil.example/x": "abort",
      "https://spa.example/live": "abort",
      "https://spa.example/api/item/1": "abort",
      "data:image/png;base64,AAAA": "continue",
      "https://spa.example/big.bin": "abort",
    });
    expect(Object.fromEntries((page.blocked ?? []).map((b) => [b.url, b.reason]))).toEqual({
      "http://10.0.0.5/secret": "private address (10.0.0.5)",
      "http://169.254.169.254/latest/meta-data/": "private address (169.254.169.254)",
      "https://evil.example/x": "private address (192.168.1.10)",
      "https://spa.example/live": "websocket",
      "https://spa.example/api/item/1": "method DELETE",
      "https://spa.example/big.bin": "too large",
    });
    // Blocked hosts never reach the transport; cookies are neither sent nor handed back.
    expect(net.calls.map((c) => c.url)).not.toEqual(expect.arrayContaining(["http://10.0.0.5/secret"]));
    expect(net.calls.every((c) => !new Headers(c.init?.headers).has("cookie"))).toBe(true);
    expect(net.calls.every((c) => c.init?.redirect === "manual")).toBe(true);
    expect(net.calls.find((c) => c.url.endsWith("graphql"))?.init).toMatchObject({ method: "POST", body: '{"query":"{articles}"}' });
    expect(chrome.outcomes.get("https://spa.example/app")?.headers).toEqual({ "content-type": "text/html" });
    // Lockdown before any page script; overlays hidden; section scroll with screenshots; popup closed.
    expect(chrome.log.newDocument).toEqual([LOCKDOWN_SCRIPT]);
    expect(chrome.log.evaluated.filter((e) => e === OVERLAY_SCRIPT).length).toBeGreaterThan(1);
    expect(chrome.log.evaluated.filter((e) => e.startsWith("window.scrollTo")).map((e) => e)).toEqual(["window.scrollTo(0, 624)", "window.scrollTo(0, 1248)", "window.scrollTo(0, 1307)", "window.scrollTo(0, 0)"]);
    expect(page.screenshots.map((s) => s.label)).toEqual(["top", "section 2", "section 3", "section 4"]);
    expect(chrome.log.popupClosed).toBe(true);
    expect(page.notes).toEqual([expect.stringMatching(/^5 request\(s\) made .*6 blocked \(1 websocket, 1 method DELETE, 1 private address \(10\.0\.0\.5\)/), "1 popup(s) closed"]);
    expect(chrome.log.viewport).toEqual(screenshotViewport("9:16"));
    // The profile is fresh and deleted afterwards; the browser is closed.
    expect(chrome.log.closed).toBe(true);
    expect(existsSync(chrome.log.userDataDir)).toBe(false);
  });

  it("refuses a private page before starting Chrome, and reports a blocked navigation", async () => {
    const chrome = fakeChrome([{ url: "http://10.0.0.5/", nav: true, type: "document" }]);
    await expect(renderPage("http://10.0.0.5/", { browser: chrome.factory, lookup, env: {} })).rejects.toMatchObject({ code: "blocked_address" });
    expect(chrome.log.userDataDir).toBe("");
    // A redirect hop to a private host: Chrome's next request is refused like the first.
    const hop = fakeChrome([{ url: "https://evil.example/landing", nav: true, type: "document" }]);
    await expect(renderPage("https://spa.example/app", { browser: hop.factory, lookup, env: {}, ...fastClock() })).rejects.toThrow(/refusing to render .*private address \(192\.168\.1\.10\)/);
  });

  it("stops at the request budget", async () => {
    const chrome = fakeChrome(requests.slice(0, 4));
    const page = await renderPage("https://spa.example/app", { browser: chrome.factory, fetch: fakeFetch(routes).impl, lookup, env: {}, maxRequests: 2, ...fastClock() });
    expect((page.blocked ?? []).map((b) => b.reason)).toEqual(["request budget spent", "request budget spent"]);
  });

  it("feeds the rendered DOM through the URL extractor: text, screenshots as image assets, a warning", async () => {
    const chrome = fakeChrome(requests.slice(0, 2), { height: 3000 });
    const renderer: PageRenderer = (url) => renderPage(url, { browser: chrome.factory, fetch: fakeFetch(routes).impl, lookup, env: {}, ...fastClock() });
    const extractor = createUrlExtractor({ renderPage: renderer });
    expect(extractor.version).toBe("1-rendered-1");
    const projectDir = join(tmp, "extract");
    const out = await extractor.extract({ uri: "https://spa.example/app", kind: "url", projectDir });
    expect(out.source).toMatchObject({ kind: "url", uri: "https://spa.example/app", title: "Orbitdesk" });
    expect(out.sections.map((s) => s.heading)).toContain("Assign in one keystroke");
    expect(out.warnings.map((w) => w.code)).toEqual(["js_rendered"]);
    expect(out.warnings[0]!.message).toMatch(/scripts running in an isolated headless Chrome.*4 screenshot\(s\) saved as image assets; 2 request\(s\) made/);
    expect(out.assets).toHaveLength(4);
    expect(out.assets[0]).toMatchObject({ kind: "image", source_ref: "url:https://spa.example/app#screenshot-1-top" });
    for (const a of out.assets) expect(existsSync(join(projectDir, a.path))).toBe(true);
    // The same DOM without rendering would be the thin shell.
    expect((await extractHtml(SHELL, "https://spa.example/app")).textLength).toBe(0);
  });
});

// ---------------------------------------------------------------------------------- ingest tool

describe("ingest render_js (MCP tool)", () => {
  const THIN = "https://app.example.com/dashboard";
  const rendered: string[] = [];
  const fakeRenderer: PageRenderer = async (url) => {
    rendered.push(url);
    return { html: RENDERED, finalUrl: url, screenshots: [{ png: new Uint8Array([1, 2, 3]), label: "top" }], notes: ["3 request(s) made (1 KB)"] };
  };
  const net = fakeFetch({ [THIN]: { body: SHELL } });
  let n = 0;

  async function connect(answer?: ElicitResult) {
    const server = createServer({ cwd: () => tmp, env: { PATH: process.env.PATH }, ingestOptions: { fetch: net.impl, renderPage: fakeRenderer, noCache: true } });
    const client = new Client({ name: "test", version: "0.0.0" }, answer ? { capabilities: { elicitation: {} } } : {});
    const asked: string[] = [];
    if (answer) {
      client.setRequestHandler(ElicitRequestSchema, async (req) => {
        asked.push(req.params.message);
        return answer;
      });
    }
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    const call = async (args: Record<string, unknown>) => (await client.callTool({ name: "ingest", arguments: args })) as CallToolResult;
    return { call, asked, close: () => client.close() };
  }
  const text = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  const data = (r: CallToolResult) => r.structuredContent as Record<string, unknown>;

  it("without an approval dialog, a thin page gets the advice to ask the user and re-run with render_js", async () => {
    const c = await connect();
    try {
      rendered.length = 0;
      const r = await c.call({ project_dir: `p-thin-${++n}`, inputs: [THIN] });
      expect(r.isError).toBeFalsy();
      expect(text(r)).toMatch(/thin_content .*ingest it again with render_js: true/);
      expect(text(r)).toMatch(/Ask the user whether to render it in an isolated headless Chrome .* ingest again with render_js: true/);
      expect(data(r).render_js).toEqual({ rendered: [], declined: [], suggested: [THIN], failed: [] });
      expect(rendered).toEqual([]);
    } finally {
      await c.close();
    }
  });

  it("with an approval dialog, offers rendering a thin page, and re-ingests it rendered once the user accepts", async () => {
    const c = await connect({ action: "accept", content: { approve: true } });
    try {
      rendered.length = 0;
      const dir = join(tmp, `p-offer-${++n}`);
      const r = await c.call({ project_dir: dir, inputs: [THIN] });
      expect(c.asked).toEqual([expect.stringMatching(/^Render https:\/\/app\.example\.com\/dashboard in an isolated headless Chrome/)]);
      expect(rendered).toEqual([THIN]);
      expect(data(r).render_js).toMatchObject({ rendered: [THIN] });
      expect(text(r)).toMatch(/re-ingested .* rendered in an isolated headless Chrome \(approved by the user\)/);
      expect(text(r)).toMatch(/\(rendered in headless Chrome\)/);
      expect((await readConsents(dir)).map((x) => [x.action, x.subject, x.via])).toEqual([["render_js", `render_js:${THIN}`, "elicitation"]]);
      const prov = JSON.parse(await readFile(join(dir, "source", "provenance.json"), "utf8"));
      expect(prov.sources).toEqual([expect.objectContaining({ uri: THIN, method: "rendered", extractor_version: "1-rendered-1" })]);
      const ir = JSON.parse(await readFile(join(dir, "source", "content-ir.json"), "utf8"));
      expect(ir.sources).toHaveLength(1);
      expect(ir.assets).toHaveLength(1);
      expect(ir.warnings.map((w: { code: string }) => w.code)).toEqual(["js_rendered"]);
    } finally {
      await c.close();
    }
  });

  it("a declined offer leaves the fetched page as it was", async () => {
    const c = await connect({ action: "decline" });
    try {
      rendered.length = 0;
      const r = await c.call({ project_dir: `p-decline-${++n}`, inputs: [THIN] });
      expect(rendered).toEqual([]);
      expect(data(r).render_js).toMatchObject({ declined: [THIN] });
      expect(text(r)).toMatch(/not rendered \(the user declined\)/);
    } finally {
      await c.close();
    }
  });

  it("render_js: true without a dialog is the user's recorded approval; with a dialog the user is asked", async () => {
    const flag = await connect();
    try {
      rendered.length = 0;
      const dir = join(tmp, `p-flag-${++n}`);
      const r = await flag.call({ project_dir: dir, inputs: [THIN], render_js: true });
      expect(r.isError).toBeFalsy();
      expect(rendered).toEqual([THIN]);
      expect((await readConsents(dir)).map((x) => [x.action, x.via, x.detail])).toEqual([["render_js", "tool_flag", THIN]]);
      const bad = await flag.call({ project_dir: dir, inputs: ["Just some notes."], render_js: true });
      expect(bad.isError).toBe(true);
      expect(text(bad)).toMatch(/render_js applies to http\(s\) web page URLs only/);
    } finally {
      await flag.close();
    }
    const no = await connect({ action: "decline" });
    try {
      rendered.length = 0;
      const r = await no.call({ project_dir: `p-no-${++n}`, inputs: [THIN], render_js: true });
      expect(r.isError).toBe(true);
      expect(data(r)).toMatchObject({ code: "REFUSED", asked_user: true });
      expect(rendered).toEqual([]);
    } finally {
      await no.close();
    }
  });
});

// ---------------------------------------------------------------------------------- real Chrome

describe.skipIf(process.env.VS_TEST_RENDER !== "1")("render_js in real Chrome (VS_TEST_RENDER=1)", () => {
  let server: Server;
  let base: string;
  const served: string[] = [];
  const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript" };
  beforeAll(async () => {
    server = createHttpServer(async (req, res) => {
      const path = (req.url ?? "/").split("?")[0]!;
      served.push(path);
      const file = join(SPA, path === "/" ? "index.html" : path.slice(1));
      if (!file.startsWith(SPA) || !existsSync(file)) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(await readFile(file));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const env = () => ({ ...process.env, VS_ALLOW_PRIVATE_URLS: "1" });

  it("renders the SPA: its text is extracted, lazy content loads, the cookie banner is gone, metadata is blocked", async () => {
    const page = await renderPage(`${base}/`, { env: env() });
    const ex = await extractHtml(page.html, page.finalUrl);
    expect(ex.markdown).toMatch(/Assign in one keystroke/);
    expect(ex.markdown).toMatch(/Reports that load as you scroll/);
    expect(ex.markdown).not.toMatch(/We use cookies/);
    expect(page.html).toMatch(/probe metadata: blocked/);
    expect(page.blocked).toEqual(expect.arrayContaining([{ url: "http://169.254.169.254/latest/meta-data/", reason: "link-local address (169.254.169.254)" }]));
    expect(page.screenshots.length).toBeGreaterThanOrEqual(2);
    expect([...page.screenshots[0]!.png.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
  }, 60_000);

  it("a page cannot open a popup", async () => {
    served.length = 0;
    const page = await renderPage(`${base}/popup.html`, { env: env() });
    expect(page.html).toMatch(/Popup probe/);
    expect(page.html).toMatch(/data-open="null"/);
    expect(served.filter((p) => p.startsWith("/opened"))).toEqual([]);
  }, 60_000);
});

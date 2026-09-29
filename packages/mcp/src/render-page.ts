import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isIP } from "node:net";
import { join } from "node:path";
import {
  BlockedAddressError,
  type FetchImpl,
  type LookupFn,
  type PageRenderer,
  type RenderedPage,
  type ResolvedAddress,
  UrlFetchError,
  allowPrivateUrls,
  checkUrlHost,
  defaultLookup,
  isLinkLocal,
  parseHttpUrl,
  pinnedFetch,
  readCapped,
} from "@video-studio/ingestion";
import { chromeGate, findChrome } from "@video-studio/renderer";
import { loadPuppeteer } from "./demo.js";

/**
 * render_js: render a web page the user asked to ingest in an isolated headless Chrome, so a page
 * that builds its content with JavaScript can be read. Only after the user approved it (ingest
 * `render_js`, consent.ts). The rendered DOM goes through the ingestion extractors unchanged
 * (defuddle, then Readability) and screenshots become image assets.
 *
 * Isolation:
 * - a fresh temporary profile, deleted afterwards (no cookies, storage or cache survive);
 * - Chrome itself never reaches the network: every request is intercepted and fetched by the
 *   engine through the same SSRF guard as ingest (`checkUrlHost`, connections pinned to the
 *   checked addresses; `VS_ALLOW_PRIVATE_URLS=1` is the only opt-out, and even then link-local
 *   and cloud-metadata addresses stay blocked), and Chrome's own proxy is a
 *   dead local port, so anything interception does not see (popups, workers, WebRTC) fails;
 * - only http(s) (plus data:/blob:, which never leave the page), GET/HEAD/POST and CORS
 *   preflights; websockets, media, beacons and prefetches are blocked; a request budget and a
 *   byte cap; cookies are neither sent nor stored;
 * - service workers bypassed and `register` refused, `window.open` returns null, new windows are
 *   closed, permission prompts denied, downloads denied;
 * - a 20 s budget; nothing is ever clicked or typed. Fixed and sticky overlays (cookie banners,
 *   modals) are hidden for the screenshots and dropped from the extracted DOM.
 *
 * One Chrome at a time: serialized with HyperFrames renders and stills through `chromeGate`.
 */

/** Total time for one page (launch to the rendered DOM). */
export const RENDER_BUDGET_MS = 20_000;
/** Most requests one page may make (further requests are blocked). */
export const MAX_PAGE_REQUESTS = 300;
/** Most bytes one page may download in total. */
export const MAX_PAGE_BYTES = 40 * 1024 * 1024;
/** Largest single response. */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
/** Largest request body a page may send (POST). */
export const MAX_POST_BYTES = 1024 * 1024;
/** Chrome's proxy: a closed local port, so no request can bypass the engine's fetcher. */
export const DEAD_PROXY = "http://127.0.0.1:9";
/** Screenshots: the top of the page and up to this many more sections. */
export const SECTION_SHOTS = 3;

// ------------------------------------------------------------------------------ request policy

export type RequestVerdict = { action: "local" } | { action: "block"; reason: string } | { action: "fetch"; url: URL };

const BLOCKED_TYPES: Record<string, string> = {
  websocket: "websocket",
  media: "media (audio/video)",
  eventsource: "event stream",
  ping: "beacon",
  cspviolationreport: "CSP report",
  prefetch: "prefetch",
  signedexchange: "signed exchange",
};
const METHODS = new Set(["GET", "HEAD", "POST"]);

/**
 * What to do with one request before any host check: data:/blob: stay in the page, other schemes,
 * blocked resource types and methods are refused, http(s) goes to the guarded fetcher.
 */
export function requestVerdict(req: { url: string; method: string; resourceType: string }): RequestVerdict {
  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    return { action: "block", reason: "invalid URL" };
  }
  if (u.protocol === "data:" || u.protocol === "blob:") return { action: "local" };
  if (u.protocol !== "http:" && u.protocol !== "https:") return { action: "block", reason: `scheme ${u.protocol}` };
  if (u.username || u.password) return { action: "block", reason: "credentials in URL" };
  const type = req.resourceType.toLowerCase();
  if (BLOCKED_TYPES[type]) return { action: "block", reason: BLOCKED_TYPES[type]! };
  const method = req.method.toUpperCase();
  if (type === "preflight" ? method !== "OPTIONS" : !METHODS.has(method)) return { action: "block", reason: `method ${method}` };
  return { action: "fetch", url: u };
}

/** Request and byte accounting for one page, and what was blocked (for the warning). */
export class PageBudget {
  requests = 0;
  bytes = 0;
  readonly blocked: Array<{ url: string; reason: string }> = [];
  constructor(
    readonly maxRequests = MAX_PAGE_REQUESTS,
    readonly maxBytes = MAX_PAGE_BYTES,
  ) {}
  /** Count one request that passed the guard; false once the budget is spent. */
  take(): boolean {
    if (this.requests >= this.maxRequests) return false;
    this.requests++;
    return true;
  }
  /** Bytes a response may still use (per-response cap and what is left of the total). */
  allowance(perResponse = MAX_RESPONSE_BYTES): number {
    return Math.max(0, Math.min(perResponse, this.maxBytes - this.bytes));
  }
  addBytes(n: number): void {
    this.bytes += n;
  }
  block(url: string, reason: string): void {
    this.blocked.push({ url, reason });
  }
  /** One line for the ingest warning. */
  summary(): string {
    const reasons = new Map<string, number>();
    for (const b of this.blocked) reasons.set(b.reason, (reasons.get(b.reason) ?? 0) + 1);
    const why = [...reasons.entries()].map(([r, n]) => `${n} ${r}`).join(", ");
    return `${this.requests} request(s) made (${Math.round(this.bytes / 1024)} KB)${this.blocked.length ? `, ${this.blocked.length} blocked (${why})` : ""}`;
  }
}

const DROP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "set-cookie", "set-cookie2", "alt-svc"]);
const FORWARD_REQUEST_HEADERS = new Set(["accept", "accept-language", "user-agent", "referer", "origin", "content-type", "range", "access-control-request-method", "access-control-request-headers"]);

/** Response headers handed back to Chrome: the body is already decoded, and no cookies are stored. */
export function responseHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    if (!DROP_RESPONSE_HEADERS.has(k.toLowerCase())) out[k] = v;
  });
  return out;
}

/** Request headers forwarded from Chrome (never cookies or credentials). */
export function forwardHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (FORWARD_REQUEST_HEADERS.has(k.toLowerCase())) out[k.toLowerCase()] = v;
  return out;
}

export interface HostGuard {
  lookup: LookupFn;
  allowPrivate: boolean;
}

export type HostCheck = { ok: true; pinned?: ResolvedAddress[] } | { ok: false; reason: string };

/**
 * The SSRF check of one host (the same rules as ingest's fetch), cached per host for the page:
 * `{pinned}` to connect to, or the reason it is refused. With the user's `VS_ALLOW_PRIVATE_URLS=1`
 * opt-out (for local dev servers), link-local addresses (cloud metadata) stay blocked: the host is
 * still resolved and the connection pinned, which a page's scripts would otherwise get around.
 */
export function createHostCheck(guard: HostGuard): (u: URL) => Promise<HostCheck> {
  const cache = new Map<string, Promise<HostCheck>>();
  const check = async (u: URL): Promise<HostCheck> => {
    if (!guard.allowPrivate) {
      try {
        const pinned = await checkUrlHost(u, { lookup: guard.lookup });
        return { ok: true, ...(pinned ? { pinned } : {}) };
      } catch (e) {
        return { ok: false, reason: e instanceof BlockedAddressError ? `private address (${e.ip})` : "unresolvable host" };
      }
    }
    const host = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
    const literal = isIP(host);
    let addrs: ResolvedAddress[];
    try {
      addrs = literal ? [{ address: host, family: literal === 6 ? 6 : 4 }] : await guard.lookup(host);
    } catch {
      return { ok: false, reason: "unresolvable host" };
    }
    if (!addrs.length) return { ok: false, reason: "unresolvable host" };
    const bad = addrs.find((a) => isLinkLocal(a.address));
    if (bad) return { ok: false, reason: `link-local address (${bad.address})` };
    return { ok: true, pinned: addrs };
  };
  return (u) => {
    const key = u.hostname.toLowerCase();
    let p = cache.get(key);
    if (!p) cache.set(key, (p = check(u)));
    return p;
  };
}

// ------------------------------------------------------------------------------ page scripts

/** Installed before any page script: no new windows, no service workers, no notification prompts. */
export const LOCKDOWN_SCRIPT = `(() => {
  try { Object.defineProperty(window, "open", { value: function () { return null; }, writable: false, configurable: false }); } catch (e) {}
  try { if (navigator.serviceWorker) navigator.serviceWorker.register = function () { return Promise.reject(new Error("service workers are disabled")); }; } catch (e) {}
  try { if (window.Notification) window.Notification.requestPermission = function () { return Promise.resolve("denied"); }; } catch (e) {}
})()`;

/** Attribute marking overlays (fixed or sticky elements) the engine hid. */
export const OVERLAY_ATTR = "data-vs-overlay";

/**
 * Hide `position: fixed` and `sticky` elements (cookie banners, modals, chat bubbles, sticky bars)
 * and undo scroll locks. Marks and styles only; never clicks.
 */
export const OVERLAY_SCRIPT = `(() => {
  if (!document.getElementById("vs-overlay-css")) {
    const s = document.createElement("style");
    s.id = "vs-overlay-css";
    s.textContent = "[${OVERLAY_ATTR}] { display: none !important; } html, body { overflow: auto !important; }";
    (document.head || document.documentElement).appendChild(s);
  }
  let n = 0;
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    if (el.hasAttribute("${OVERLAY_ATTR}")) continue;
    const pos = getComputedStyle(el).position;
    if (pos === "fixed" || pos === "sticky") { el.setAttribute("${OVERLAY_ATTR}", pos); n++; }
  }
  return n;
})()`;

/** The rendered DOM, without the hidden overlays and the engine's style. */
export const OUTER_HTML_SCRIPT = `(() => {
  document.querySelectorAll("[${OVERLAY_ATTR}], #vs-overlay-css").forEach((e) => e.remove());
  return document.documentElement.outerHTML;
})()`;

/**
 * Scroll positions (px) that walk the page a viewport at a time (90% steps, so nothing falls
 * between two stops), ending at the bottom; more than `maxSteps` are thinned evenly. Starts at 0.
 */
export function sectionScrollPlan(scrollHeight: number, viewportHeight: number, maxSteps = 12): number[] {
  const bottom = Math.max(0, Math.round(scrollHeight - viewportHeight));
  const step = Math.max(1, Math.round(viewportHeight * 0.9));
  const ys: number[] = [];
  for (let y = 0; y < bottom; y += step) ys.push(y);
  if (!ys.length || ys[ys.length - 1] !== bottom) ys.push(bottom);
  if (ys.length <= maxSteps) return ys;
  return Array.from({ length: maxSteps }, (_, i) => ys[Math.round((i * (ys.length - 1)) / (maxSteps - 1))]!);
}

/** Which scroll stops get a screenshot: the top, then up to `sections` more spread over the page. */
export function screenshotPicks(stops: number, sections = SECTION_SHOTS): number[] {
  if (stops <= sections + 1) return Array.from({ length: stops }, (_, i) => i);
  return [0, ...Array.from({ length: sections }, (_, k) => Math.round(((k + 1) * (stops - 1)) / sections))];
}

/**
 * The CSS viewport for screenshots at the video's aspect, 1080 px on the short side: portrait
 * pages are laid out at phone width (390 CSS px), square at 720, landscape at 1280.
 */
export function screenshotViewport(aspect = "9:16"): { width: number; height: number; deviceScaleFactor: number } {
  const [aw, ah] = aspect.split(":").map(Number) as [number, number];
  const ok = aw > 0 && ah > 0;
  const w = ok ? aw : 9;
  const h = ok ? ah : 16;
  const pxW = w <= h ? 1080 : Math.round((1080 * w) / h);
  const pxH = w <= h ? Math.round((1080 * h) / w) : 1080;
  const cssW = w < h ? 390 : w === h ? 720 : 1280;
  const dsf = Math.round((pxW / cssW) * 1000) / 1000;
  return { width: cssW, height: Math.round(pxH / dsf), deviceScaleFactor: dsf };
}

/** Wait until no request has been in flight for `quietMs`, at most `maxMs`. True when it went quiet. */
export async function waitForQuiet(inflight: () => number, o: { quietMs?: number; maxMs: number; now: () => number; sleep: (ms: number) => Promise<void> }): Promise<boolean> {
  const quiet = o.quietMs ?? 500;
  const end = o.now() + Math.max(0, o.maxMs);
  let since: number | undefined;
  for (;;) {
    if (inflight() === 0) {
      since ??= o.now();
      if (o.now() - since >= quiet) return true;
    } else since = undefined;
    if (o.now() >= end) return false;
    await o.sleep(Math.min(100, Math.max(1, end - o.now())));
  }
}

// ------------------------------------------------------------------------------ the driver slice

/** The slice of a puppeteer HTTPRequest this module uses (tests pass fakes). */
export interface RenderRequest {
  url(): string;
  method(): string;
  resourceType(): string;
  headers(): Record<string, string>;
  postData(): string | undefined;
  isNavigationRequest(): boolean;
  abort(errorCode?: "blockedbyclient"): Promise<void>;
  continue(): Promise<void>;
  respond(r: { status: number; headers: Record<string, string>; body: Uint8Array }): Promise<void>;
}
export interface RenderPageHandle {
  setRequestInterception(on: boolean): Promise<void>;
  on(event: "request", fn: (req: RenderRequest) => void): unknown;
  evaluateOnNewDocument(source: string): Promise<unknown>;
  setBypassServiceWorker?(bypass: boolean): Promise<void>;
  goto(url: string, o: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  evaluate<T = unknown>(source: string): Promise<T>;
  screenshot(o: { type: "png" }): Promise<Uint8Array>;
  url(): string;
}
export interface RenderTarget {
  type(): string;
  page(): Promise<{ close(): Promise<void> } | null>;
}
export interface RenderBrowser {
  newPage(): Promise<RenderPageHandle>;
  on(event: "targetcreated", fn: (t: RenderTarget) => void): unknown;
  close(): Promise<void>;
}
export type RenderBrowserFactory = (o: {
  userDataDir: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  env: Record<string, string | undefined>;
}) => Promise<RenderBrowser>;

/** Chrome flags of the isolated render (see the module comment). */
export function renderChromeArgs(): string[] {
  return [
    `--proxy-server=${DEAD_PROXY}`,
    "--proxy-bypass-list=<-loopback>",
    "--block-new-web-contents",
    "--deny-permission-prompts",
    "--disable-notifications",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--dns-prefetch-disable",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-extensions",
    "--disable-default-apps",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication,InterestFeedContentSuggestions",
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--use-mock-keychain",
    "--mute-audio",
    "--hide-scrollbars",
  ];
}

type PageContext = { newPage(): Promise<RenderPageHandle> };

/** Default browser: the system Chrome through the runtime-resolved puppeteer-core, in its own context with downloads denied. */
export const isolatedChrome: RenderBrowserFactory = async ({ userDataDir, viewport, env }) => {
  const chrome = await findChrome(env.CHROME_PATH, env as NodeJS.ProcessEnv);
  if (!chrome.ok) throw new Error(`render_js needs Google Chrome: ${chrome.reason}`);
  let puppeteer: Awaited<ReturnType<typeof loadPuppeteer>>;
  try {
    puppeteer = await loadPuppeteer(env);
  } catch (e) {
    throw new Error((e instanceof Error ? e.message : String(e)).replace(/^demo capture/, "render_js"));
  }
  const browser = (await puppeteer.launch({ executablePath: chrome.path, headless: true, userDataDir, defaultViewport: viewport, args: renderChromeArgs() })) as RenderBrowser & {
    createBrowserContext?(o: Record<string, unknown>): Promise<PageContext>;
  };
  let ctx: PageContext = browser;
  try {
    if (browser.createBrowserContext) ctx = await browser.createBrowserContext({ downloadBehavior: { policy: "deny" } });
  } catch {
    ctx = browser;
  }
  return { newPage: () => ctx.newPage(), on: (e, fn) => browser.on(e, fn), close: () => browser.close() };
};

// ------------------------------------------------------------------------------ rendering

export interface RenderPageOptions {
  /** Video aspect for the screenshots (default 9:16). */
  aspect?: string;
  env?: Record<string, string | undefined>;
  /** Host resolver (tests); default DNS. */
  lookup?: LookupFn;
  /** Transport for the page's requests (tests); default: node:http(s) pinned to the checked addresses. */
  fetch?: FetchImpl;
  browser?: RenderBrowserFactory;
  budgetMs?: number;
  maxRequests?: number;
  maxBytes?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

/** Resolve within `ms`, else reject (a page script can hang an evaluate). */
function bounded<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${what} took longer than ${Math.round(ms)} ms`)), Math.max(1, ms));
    p.then(
      (v) => {
        clearTimeout(t);
        res(v);
      },
      (e) => {
        clearTimeout(t);
        rej(e);
      },
    );
  });
}

/**
 * Render `url` in an isolated headless Chrome and return its DOM, final URL and screenshots.
 * Not serialized: {@link createPageRenderer} puts it behind the Chrome gate.
 */
export async function renderPage(url: string, o: RenderPageOptions = {}): Promise<RenderedPage> {
  const env = o.env ?? process.env;
  const now = o.now ?? (() => Date.now());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = now();
  const budgetMs = o.budgetMs ?? RENDER_BUDGET_MS;
  const left = () => start + budgetMs - now();
  const hostOk = createHostCheck({ lookup: o.lookup ?? defaultLookup, allowPrivate: allowPrivateUrls(env) });
  const top = parseHttpUrl(url);
  const first = await hostOk(top);
  if (!first.ok) throw new UrlFetchError("blocked_address", `refusing to render ${url}: ${first.reason}. Set VS_ALLOW_PRIVATE_URLS=1 in the engine's environment to allow local URLs.`);

  const budget = new PageBudget(o.maxRequests, o.maxBytes);
  let inflight = 0;
  let popups = 0;
  let mainBlocked: string | undefined;
  let mainLoaded = false;
  const abort = AbortSignal.any([AbortSignal.timeout(budgetMs), ...(o.signal ? [o.signal] : [])]);

  const handle = async (req: RenderRequest): Promise<void> => {
    const target = req.url();
    const block = async (reason: string) => {
      budget.block(target, reason);
      if (req.isNavigationRequest() && !mainLoaded && mainBlocked === undefined) mainBlocked = reason;
      await req.abort("blockedbyclient").catch(() => undefined);
    };
    const v = requestVerdict({ url: target, method: req.method(), resourceType: req.resourceType() });
    if (v.action === "local") return void (await req.continue().catch(() => undefined));
    if (v.action === "block") return block(v.reason);
    const host = await hostOk(v.url);
    if (!host.ok) return block(host.reason);
    if (!budget.take()) return block("request budget spent");
    const allowance = budget.allowance();
    if (allowance <= 0) return block("byte cap reached");
    const post = req.postData();
    if (post !== undefined && Buffer.byteLength(post) > MAX_POST_BYTES) return block("request body too large");
    try {
      const init: RequestInit = { method: req.method().toUpperCase(), headers: forwardHeaders(req.headers()), redirect: "manual", signal: abort, ...(post !== undefined ? { body: post } : {}) };
      // Redirects go back to Chrome as 3xx: the next hop is a new request, checked like this one.
      const res = o.fetch ? await o.fetch(v.url.href, init) : host.pinned ? await pinnedFetch(v.url.href, init, host.pinned) : await fetch(v.url.href, init);
      const body = await readCapped(res, allowance);
      budget.addBytes(body.byteLength);
      if (req.isNavigationRequest() && !(res.status >= 300 && res.status < 400)) mainLoaded = true;
      await req.respond({ status: res.status, headers: responseHeaders(res.headers), body });
    } catch (e) {
      await block(e instanceof UrlFetchError && e.code === "too_large" ? "too large" : abort.aborted ? "time budget spent" : "fetch failed");
    }
  };

  const userDataDir = await mkdtemp(join(tmpdir(), "vs-render-js-"));
  let browser: RenderBrowser | undefined;
  // A page that wedges Chrome still ends: the browser is closed shortly after the budget.
  const watchdog = setTimeout(() => void browser?.close().catch(() => undefined), budgetMs + 10_000);
  try {
    browser = await (o.browser ?? isolatedChrome)({ userDataDir, viewport: screenshotViewport(o.aspect), env });
    const page = await browser.newPage();
    // Any later page target is a popup: close it (its requests would hit the dead proxy anyway).
    browser.on("targetcreated", (t) => {
      if (t.type() !== "page") return;
      popups++;
      void t
        .page()
        .then((p) => p?.close())
        .catch(() => undefined);
    });
    await page.setBypassServiceWorker?.(true);
    await page.evaluateOnNewDocument(LOCKDOWN_SCRIPT);
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      inflight++;
      void handle(req).finally(() => inflight--);
    });
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.max(1000, left() - 4000) });
    } catch (e) {
      if (mainBlocked !== undefined) throw new UrlFetchError("blocked_address", `refusing to render ${url}: ${mainBlocked}`);
      throw new UrlFetchError("network_error", `could not load ${url} in the browser: ${e instanceof Error ? e.message : String(e)}`);
    }
    const quiet = { now, sleep };
    await waitForQuiet(() => inflight, { ...quiet, maxMs: Math.min(5000, left() - 5000) });
    const evalFor = <T>(src: string, what: string) => bounded(page.evaluate<T>(src), Math.max(500, Math.min(3000, left())), what);
    await evalFor<number>(OVERLAY_SCRIPT, "hiding overlays").catch(() => 0);
    const m = await evalFor<{ h: number; vh: number }>("({ h: document.documentElement.scrollHeight, vh: window.innerHeight })", "measuring the page");
    const stops = sectionScrollPlan(m.h, m.vh);
    const picks = new Set(screenshotPicks(stops.length));
    const screenshots: RenderedPage["screenshots"] = [];
    let partial = false;
    for (const [i, y] of stops.entries()) {
      if (left() < 3000) {
        partial = true;
        break;
      }
      if (i > 0) {
        // Section by section, so lazy content loads; short, bounded waits.
        await evalFor(`window.scrollTo(0, ${y})`, "scrolling");
        await sleep(200);
        await waitForQuiet(() => inflight, { ...quiet, quietMs: 300, maxMs: Math.min(1000, left() - 3000) });
        await evalFor<number>(OVERLAY_SCRIPT, "hiding overlays").catch(() => 0);
      }
      if (picks.has(i)) {
        const png = await bounded(page.screenshot({ type: "png" }), Math.max(500, Math.min(4000, left())), "screenshot").catch(() => undefined);
        if (png) screenshots.push({ png, label: i === 0 ? "top" : `section ${i + 1}` });
      }
    }
    await evalFor("window.scrollTo(0, 0)", "scrolling").catch(() => undefined);
    const html = await bounded(page.evaluate<string>(OUTER_HTML_SCRIPT), 5000, "reading the rendered page");
    const notes = [budget.summary(), ...(popups ? [`${popups} popup(s) closed`] : []), ...(partial ? ["the time budget ended before the bottom of the page"] : [])];
    return { html, finalUrl: page.url() || url, screenshots, notes, blocked: budget.blocked.slice(0, 50) };
  } finally {
    clearTimeout(watchdog);
    await browser?.close().catch(() => undefined);
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The ingest `renderPage` hook: {@link renderPage} behind the process-wide Chrome gate. */
export function createPageRenderer(o: Omit<RenderPageOptions, "signal"> = {}): PageRenderer {
  return (url, r) => chromeGate(() => renderPage(url, { ...o, ...(r.signal ? { signal: r.signal } : {}) }));
}

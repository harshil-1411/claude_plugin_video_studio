import { createHash } from "node:crypto";
import { realpathSync, statSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

/**
 * Still-frame capture of a composed HyperFrames page, outside the producer's render loop: the
 * `stills` tool (a sheet of chosen moments before the full render) and the determinism and
 * loop-seam checks every `motion` scene passes before the producer renders it.
 *
 * The page is served over loopback HTTP (so its CSP `'self'` resolves exactly as it does under
 * the producer's file server) and opened in Chrome through the pinned producer's own
 * puppeteer-core, with the producer's pixel-relevant launch flags (software GL, sRGB, no font
 * hinting) at the target size with deviceScaleFactor 1. Frames are drawn by seeking the
 * timeline the composition registers on `window.__timelines[<composition id>]`, after readiness
 * (`window.__hf.buildReady[<id>]`, fonts, image decode). Nothing here writes the render.
 *
 * Pure helpers (time planning, hash comparison, PNG decode, pixel diff) are exported for tests.
 */

/** Bump when the check's times, tolerances or verdicts change: cached results are keyed by it. */
export const DETERMINISM_CHECK_VERSION = 1;

/**
 * Loop-seam tolerance. `render(0)` and `render(duration)` are reached through different float
 * paths (e.g. `sin(2π·t/d)` at t = d is -2.4e-16, not 0; a transform can differ by 1e-13 px), and
 * the rasterizer may then round a few antialiased edge pixels by a level or two. Channel
 * differences up to `channel` are ignored; beyond that, at most `fraction` of the pixels may
 * differ (0.05%: about 1000 px of a 1080x1920 frame, a few glyph edges). A real seam moves or
 * recolours whole shapes: tens of thousands of pixels by large amounts.
 */
export const LOOP_SEAM_TOLERANCE = { channel: 2, fraction: 0.0005 } as const;

// ------------------------------------------------------------------------------ pure: times

/** `t` on the frame grid (nearest frame), clamped to [0, last frame]; with `allowEnd`, to [0, duration]. */
export function frameAlignedTime(t: number, fps: number, duration: number, allowEnd = false): number {
  const frames = Math.max(1, Math.round(duration * fps));
  const maxFrame = allowEnd ? frames : frames - 1;
  const f = Math.min(maxFrame, Math.max(0, Math.round((Number.isFinite(t) ? t : 0) * fps)));
  return Math.round((f / fps) * 1e6) / 1e6;
}

export interface DeterminismPlan {
  /** Seek order: every time twice, each time reached from a different predecessor. */
  order: number[];
  /** With `loop`: the times whose frames must match (0 and the duration). */
  loop?: [number, number];
}

/**
 * The seeks of the determinism check: t1 (≈25%), mid (≈50%) and t2 (≈75%), frame-aligned, in the
 * order t1, mid, t2, t1, t2, mid. Each time is drawn twice after different frames, so state
 * carried between seeks (or a clock, or unseeded randomness) shows up as different pixels.
 * Very short scenes fall back to fewer distinct times (0 is added when needed).
 */
export function determinismPlan(duration: number, fps: number, loop = false): DeterminismPlan {
  const at = (f: number) => frameAlignedTime(duration * f, fps, duration);
  let [t1, mid, t2] = [at(0.25), at(0.5), at(0.75)];
  const distinct = [...new Set([t1, mid, t2])];
  if (distinct.length < 2) {
    const other = distinct[0] === 0 ? frameAlignedTime(1 / fps, fps, duration) : 0;
    [t1, mid, t2] = [distinct[0]!, other, distinct[0]!];
  }
  const order = distinct.length === 2 && t1 === t2 ? [t1, mid, t1, mid] : [t1, mid, t2, t1, t2, mid];
  return { order, ...(loop ? { loop: [0, frameAlignedTime(duration, fps, duration, true)] as [number, number] } : {}) };
}

export interface CaptureHash {
  t: number;
  sha256: string;
}

/** Times whose captures do not all hash the same, with the distinct hashes (in capture order). */
export function compareCaptures(captures: readonly CaptureHash[]): Array<{ t: number; hashes: string[] }> {
  const byT = new Map<number, string[]>();
  for (const c of captures) byT.set(c.t, [...(byT.get(c.t) ?? []), c.sha256]);
  const out: Array<{ t: number; hashes: string[] }> = [];
  for (const [t, hs] of byT) {
    const distinct = [...new Set(hs)];
    if (distinct.length > 1) out.push({ t, hashes: distinct });
  }
  return out.sort((a, b) => a.t - b.t);
}

export function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ------------------------------------------------------------------------------ pure: pixels

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel. */
  data: Uint8Array;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Decode an 8-bit, non-interlaced RGB/RGBA/grey PNG (what Chrome's screenshots are) to RGBA.
 * Returns null for anything else (palette, 16-bit, interlaced), so callers fall back to hashes.
 */
export function decodePng(buf: Uint8Array): DecodedImage | null {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 8 || !b.subarray(0, 8).equals(PNG_SIG)) return null;
  let off = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString("latin1", off + 4, off + 8);
    const body = b.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colour = body[9];
      const interlace = body[12];
      channels = colour === 6 ? 4 : colour === 2 ? 3 : colour === 0 ? 1 : colour === 4 ? 2 : 0;
      if (depth !== 8 || interlace !== 0 || !channels) return null;
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
  }
  if (!width || !height || !channels) return null;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]!;
      const a = x >= channels ? px[row + x - channels]! : 0;
      const up = y > 0 ? px[prev + x]! : 0;
      const c = x >= channels && y > 0 ? px[prev + x - channels]! : 0;
      let out: number;
      switch (filter) {
        case 0:
          out = v;
          break;
        case 1:
          out = v + a;
          break;
        case 2:
          out = v + up;
          break;
        case 3:
          out = v + ((a + up) >> 1);
          break;
        case 4: {
          const p = a + up - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - c);
          out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
          break;
        }
        default:
          return null;
      }
      px[row + x] = out & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    const o = i * 4;
    if (channels >= 3) {
      data[o] = px[j]!;
      data[o + 1] = px[j + 1]!;
      data[o + 2] = px[j + 2]!;
      data[o + 3] = channels === 4 ? px[j + 3]! : 255;
    } else {
      data[o] = data[o + 1] = data[o + 2] = px[j]!;
      data[o + 3] = channels === 2 ? px[j + 1]! : 255;
    }
  }
  return { width, height, data };
}

export interface PixelDiff {
  /** Pixels with any channel differing by more than the tolerance. */
  differing: number;
  fraction: number;
  /** Largest channel difference anywhere. */
  max: number;
}

/** Per-pixel comparison of two same-size RGBA images; null when their sizes differ. */
export function pixelDiff(a: DecodedImage, b: DecodedImage, channelTolerance = 0): PixelDiff | null {
  if (a.width !== b.width || a.height !== b.height) return null;
  let differing = 0;
  let max = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    let worst = 0;
    for (let k = 0; k < 4; k++) {
      const d = Math.abs(a.data[i * 4 + k]! - b.data[i * 4 + k]!);
      if (d > worst) worst = d;
    }
    if (worst > max) max = worst;
    if (worst > channelTolerance) differing++;
  }
  return { differing, fraction: n ? differing / n : 0, max };
}

export interface LoopSeamVerdict {
  ok: boolean;
  sha_equal: boolean;
  /** Share of pixels beyond the channel tolerance (absent when the hashes match or decoding failed). */
  differing_fraction?: number;
  max_channel_diff?: number;
}

/** render(0) vs render(duration): equal hashes pass; otherwise the pixel diff must stay within {@link LOOP_SEAM_TOLERANCE}. */
export function judgeLoopSeam(first: Uint8Array, last: Uint8Array): LoopSeamVerdict {
  if (sha256(first) === sha256(last)) return { ok: true, sha_equal: true };
  const a = decodePng(first);
  const b = decodePng(last);
  const d = a && b ? pixelDiff(a, b, LOOP_SEAM_TOLERANCE.channel) : null;
  if (!d) return { ok: false, sha_equal: false };
  return { ok: d.fraction <= LOOP_SEAM_TOLERANCE.fraction, sha_equal: false, differing_fraction: Math.round(d.fraction * 1e6) / 1e6, max_channel_diff: d.max };
}

// ------------------------------------------------------------------------------ determinism check

export interface DeterminismResult {
  version: number;
  ok: boolean;
  /** Seek order used. */
  order: number[];
  /** Times that drew different frames on different seeks. */
  mismatches: Array<{ t: number; hashes: string[] }>;
  /** With `loop`: the seam verdict. */
  loop_seam?: LoopSeamVerdict & { first_t: number; last_t: number };
}

export interface CheckFinding {
  id: "nondeterministic_scene" | "loop_seam";
  severity: "error" | "warning";
  message: string;
  fix: string;
}

/** Run the determinism (and, with `loop`, loop-seam) check through `capture(t)` (a PNG of the frame at t). */
export async function runDeterminismCheck(capture: (t: number) => Promise<Uint8Array>, o: { duration: number; fps: number; loop?: boolean }): Promise<DeterminismResult> {
  const plan = determinismPlan(o.duration, o.fps, o.loop === true);
  const hashes: CaptureHash[] = [];
  for (const t of plan.order) hashes.push({ t, sha256: sha256(await capture(t)) });
  const mismatches = compareCaptures(hashes);
  let loop_seam: DeterminismResult["loop_seam"];
  if (plan.loop) {
    const [a, b] = plan.loop;
    const first = await capture(a);
    const last = await capture(b);
    loop_seam = { ...judgeLoopSeam(first, last), first_t: a, last_t: b };
  }
  return { version: DETERMINISM_CHECK_VERSION, ok: mismatches.length === 0, order: plan.order, mismatches, ...(loop_seam ? { loop_seam } : {}) };
}

/** The check's findings for scene `sceneId` (none when it passed). */
export function determinismFindings(sceneId: string, r: DeterminismResult): CheckFinding[] {
  const out: CheckFinding[] = [];
  if (r.mismatches.length) {
    const times = r.mismatches.map((m) => `${m.t}s (${m.hashes.length} different frames)`).join(", ");
    out.push({
      id: "nondeterministic_scene",
      severity: "error",
      message: `scene ${sceneId}: seeking the same time twice drew different frames at ${times} (seek order ${r.order.join(", ")})`,
      fix: "make window.seek(t) a pure function of t: no clock (Date.now, performance.now, timers, requestAnimationFrame), no unseeded randomness (use vs.rng(seed)), and no state carried between frames (accumulators, deltas from the previous t, physics stepped per call, nodes appended on each seek); rebuild the whole frame from t on every call",
    });
  }
  const seam = r.loop_seam;
  if (seam && !seam.ok) {
    const how = seam.differing_fraction !== undefined ? `${(seam.differing_fraction * 100).toFixed(2)}% of pixels differ (up to ${seam.max_channel_diff} levels)` : "the frames differ";
    out.push({
      id: "loop_seam",
      severity: "warning",
      message: `scene ${sceneId}: props.loop is set but the frame at ${seam.last_t}s does not match the frame at ${seam.first_t}s: ${how}`,
      fix: "with loop, seek(duration) must draw exactly what seek(0) draws: drive each cycle from the phase (t % period) / period with a period that divides the duration, let springs and eases reach their rest value by the end, and return every element to its opening state",
    });
  }
  return out;
}

export function formatCheckFinding(f: CheckFinding): string {
  return `${f.id}: ${f.message}; fix: ${f.fix}`;
}

// ------------------------------------------------------------------------------ chrome

/**
 * Chrome flags for captures: the pixel-relevant subset of the producer's own launch (0.8.78
 * `buildChromeArgs` in screenshot mode with its default software GPU mode). Chrome's sandbox
 * stays on: the page is untrusted, and the sandbox does not change pixels.
 */
export function captureChromeArgs(width: number, height: number): string[] {
  return [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--disable-gpu-compositing",
    "--font-render-hinting=none",
    "--force-color-profile=srgb",
    `--window-size=${Math.round(width)},${Math.round(height)}`,
    "--hide-scrollbars",
    "--mute-audio",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-extensions",
    "--disable-sync",
    "--disable-component-update",
    "--disable-default-apps",
    "--no-pings",
    "--disable-features=Translate,BackForwardCache,IntensiveWakeUpThrottling",
  ];
}

/** The subset of puppeteer-core this module drives. */
export interface CaptureBrowser {
  newPage(): Promise<CapturePageHandle>;
  close(): Promise<void>;
}
export interface CapturePageHandle {
  setViewport(v: { width: number; height: number; deviceScaleFactor: number }): Promise<void>;
  goto(url: string, o: { waitUntil: string; timeout: number }): Promise<unknown>;
  evaluate(script: string): Promise<unknown>;
  screenshot(o: { type: "png" }): Promise<Uint8Array>;
  on(event: string, cb: (x: unknown) => void): unknown;
  close(): Promise<void>;
}
type Launch = (o: object) => Promise<CaptureBrowser>;

/**
 * puppeteer-core as the producer resolves it (`producerEntry`: the resolved producer entry file;
 * default: resolved from this module). Undefined when it cannot be loaded.
 */
export async function loadPuppeteerLaunch(producerEntry?: string): Promise<Launch | undefined> {
  let entry = producerEntry;
  if (!entry) {
    try {
      entry = fileURLToPath(import.meta.resolve("@hyperframes/producer"));
    } catch {
      return undefined;
    }
  }
  try {
    const path = createRequire(entry).resolve("puppeteer-core");
    const mod = (await import(pathToFileURL(path).href)) as { launch?: Launch; default?: { launch?: Launch } };
    const launch = mod.launch ?? mod.default?.launch;
    return launch ? (o: object) => launch.call(mod.default ?? mod, o) : undefined;
  } catch {
    return undefined;
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

/** The file a request path maps to inside `root` (real paths; no escape through `..` or symlinks), or null. */
export function servedFile(root: string, urlPath: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath.split("?")[0]!.split("#")[0]!);
  } catch {
    return null;
  }
  if (rel.includes("\0")) return null;
  if (rel === "/" || rel === "") rel = "/index.html";
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return null;
  }
  const abs = resolve(realRoot, `.${rel.startsWith("/") ? rel : `/${rel}`}`);
  if (abs !== realRoot && !abs.startsWith(realRoot + sep)) return null;
  try {
    const real = realpathSync(abs);
    if (!real.startsWith(realRoot + sep)) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** Serve `root` read-only on 127.0.0.1 (GET/HEAD only), for the capture page. */
export function serveDirectory(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    const file = servedFile(root, req.url ?? "/");
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    const body = readFileSync(file);
    res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store", "content-length": body.length });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      done({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/** Page-side readiness: the registered timeline, `__hf.buildReady[id]`, fonts and image decode. */
export function readinessScript(compositionId: string, timeoutMs: number): string {
  const id = JSON.stringify(compositionId);
  return `(async function () {
  var id = ${id};
  var deadline = Date.now() + ${Math.round(timeoutMs)};
  while (!(window.__timelines && window.__timelines[id])) {
    if (Date.now() > deadline) throw new Error("the page never registered window.__timelines[" + JSON.stringify(id) + "]");
    await new Promise(function (r) { setTimeout(r, 25); });
  }
  var ready = window.__hf && window.__hf.buildReady && window.__hf.buildReady[id];
  if (ready) await ready;
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  var imgs = Array.prototype.slice.call(document.images || []);
  await Promise.all(imgs.map(function (i) { return i.decode ? i.decode().catch(function () {}) : null; }));
  return true;
})()`;
}

/** Page-side seek through the registered timeline, then two animation frames so the frame is painted. */
export function seekScript(compositionId: string, t: number): string {
  return `(async function () {
  var tl = window.__timelines[${JSON.stringify(compositionId)}];
  tl.pause && tl.pause();
  tl.seek(${Number.isFinite(t) ? t : 0});
  await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
  return true;
})()`;
}

export interface PageCapture {
  /** PNG of the frame at `t` (scene-local seconds, sent to the timeline as is). */
  capture(t: number): Promise<Uint8Array>;
  /** Page errors seen so far. */
  errors: string[];
  close(): Promise<void>;
}

export interface CaptureSessionOptions {
  chromePath: string;
  /** Resolved producer entry (its puppeteer-core is used). */
  producerEntry?: string;
  timeoutMs?: number;
  /** Injection point (tests). */
  launch?: Launch;
}

export interface CaptureSession {
  /** Open the composition in `dir` (its index.html) at width×height and wait until it is ready. */
  open(dir: string, compositionId: string, width: number, height: number): Promise<PageCapture>;
  close(): Promise<void>;
}

/**
 * One headless Chrome for a batch of captures (one page per composition). Callers serialize it
 * with the renderer's Chrome gate (`chromeGate`) so it never runs beside a HyperFrames render.
 */
export async function openCaptureSession(o: CaptureSessionOptions & { width: number; height: number }): Promise<CaptureSession> {
  const timeoutMs = o.timeoutMs ?? 60_000;
  const launch = o.launch ?? (await loadPuppeteerLaunch(o.producerEntry));
  if (!launch) throw new Error("puppeteer-core (a dependency of the HyperFrames producer) could not be loaded; run doctor for setup");
  const browser = await launch({ executablePath: o.chromePath, headless: true, args: captureChromeArgs(o.width, o.height), defaultViewport: null, timeout: timeoutMs });
  const pages = new Set<PageCapture>();
  return {
    async open(dir, compositionId, width, height) {
      const server = await serveDirectory(dir);
      let page: CapturePageHandle | undefined;
      try {
        page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e instanceof Error ? e.message : String(e)));
        await page.setViewport({ width: Math.round(width), height: Math.round(height), deviceScaleFactor: 1 });
        await page.goto(`${server.url}/index.html`, { waitUntil: "load", timeout: timeoutMs });
        await page.evaluate(readinessScript(compositionId, timeoutMs));
        const p = page;
        const pc: PageCapture = {
          errors,
          async capture(t) {
            await p.evaluate(seekScript(compositionId, t));
            return new Uint8Array(await p.screenshot({ type: "png" }));
          },
          async close() {
            pages.delete(pc);
            await p.close().catch(() => {});
            await server.close();
          },
        };
        pages.add(pc);
        return pc;
      } catch (e) {
        await page?.close().catch(() => {});
        await server.close();
        throw e;
      }
    },
    async close() {
      for (const p of [...pages]) await p.close();
      await browser.close().catch(() => {});
    },
  };
}

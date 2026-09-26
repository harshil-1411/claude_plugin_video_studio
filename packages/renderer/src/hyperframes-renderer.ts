import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ProducerConfig, ProducerLogger, RenderConfigInput, RenderJob } from "@hyperframes/producer";
import { ffprobe, resolveFfmpeg, type ProbeResult } from "@video-studio/media";
import { buildComposition, HYPERFRAMES_KINDS } from "./hyperframes-compose.js";
import type { Availability, SceneRenderer, SceneRenderRequest, SceneRenderResult } from "./types.js";

/** Exact pinned producer version (package.json pins "@hyperframes/producer": "0.8.78"). */
export const HYPERFRAMES_VERSION = "0.8.78";

/** The subset of @hyperframes/producer 0.8.78 this renderer calls. */
export interface HyperframesProducer {
  createRenderJob(config: RenderConfigInput): RenderJob;
  executeRenderJob(
    job: RenderJob,
    projectDir: string,
    outputPath: string,
    progress?: (job: RenderJob, message: string) => void | Promise<void>,
    abortSignal?: AbortSignal,
  ): Promise<void>;
  resolveConfig(overrides?: Partial<ProducerConfig>): ProducerConfig;
}

export interface HyperframesRendererOptions {
  /** Chrome/Chromium executable. Default: CHROME_PATH / HYPERFRAMES_BROWSER_PATH env, then platform locations. */
  chromePath?: string;
  /** Timeout for the cheap headless launch probe in `available()` (default 20 s). */
  probeTimeoutMs?: number;
  /** Producer encoder preset (default "standard"). */
  quality?: "draft" | "standard" | "high";
  /** Capture workers (default 1: low memory). */
  workers?: number;
  /** Parent directory for per-scene temp dirs (default os.tmpdir()). */
  tmpRoot?: string;
  /** Keep the temp composition dir (debugging). Also enabled by VS_KEEP_HYPERFRAMES_TMP=1. */
  keepTmp?: boolean;
  // ---- injection points (tests)
  loadProducer?: () => Promise<HyperframesProducer>;
  launchProbe?: (chromePath: string, timeoutMs: number) => Promise<Availability>;
  probeOutput?: (path: string, signal?: AbortSignal) => Promise<ProbeResult>;
  /** Check that the producer package is installed (default: import.meta.resolve). */
  producerInstalled?: () => boolean;
}

// ------------------------------------------------------------------------------ chrome lookup

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const MAC_CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
];
const LINUX_CHROME_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"];
const WIN_CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];

export type ChromeLookup = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Locate Chrome: explicit path (must exist), CHROME_PATH, HYPERFRAMES_BROWSER_PATH, then
 * platform locations (macOS app bundles; Linux google-chrome/chromium on PATH; Windows Program Files).
 */
export async function findChrome(explicit: string | undefined, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Promise<ChromeLookup> {
  const configured: Array<[string, string]> = [];
  if (explicit) configured.push(["chromePath option", explicit]);
  if (env.CHROME_PATH?.trim()) configured.push(["CHROME_PATH", env.CHROME_PATH.trim()]);
  if (env.HYPERFRAMES_BROWSER_PATH?.trim()) configured.push(["HYPERFRAMES_BROWSER_PATH", env.HYPERFRAMES_BROWSER_PATH.trim()]);
  const first = configured[0];
  if (first) {
    return (await isExecutable(first[1]))
      ? { ok: true, path: first[1] }
      : { ok: false, reason: `Chrome not found at ${first[1]} (from ${first[0]})` };
  }
  let candidates: string[];
  if (platform === "darwin") candidates = MAC_CHROME;
  else if (platform === "win32") candidates = WIN_CHROME;
  else {
    const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
    candidates = LINUX_CHROME_NAMES.flatMap((n) => dirs.map((d) => join(d, n)));
  }
  for (const c of candidates) if (await isExecutable(c)) return { ok: true, path: c };
  return {
    ok: false,
    reason:
      platform === "linux"
        ? "Chrome/Chromium not found on PATH (google-chrome, chromium); install it or set CHROME_PATH"
        : "Google Chrome not found; install it or set CHROME_PATH to a Chrome/Chromium executable",
  };
}

/**
 * Launch probe that starts Chrome the way the producer does: through the puppeteer-core that
 * @hyperframes/producer depends on. Plain `chrome --headless --dump-dom` can hang for 45 s+
 * on macOS (the updater keeps the process alive) while puppeteer launches in under a second.
 * `producerEntry` is the resolved producer entry file (default: resolved from this module).
 * Falls back to the `--dump-dom` probe when puppeteer-core cannot be resolved.
 */
export async function puppeteerLaunchProbe(chromePath: string, timeoutMs: number, producerEntry?: string): Promise<Availability> {
  let entry = producerEntry;
  if (!entry) {
    try {
      entry = fileURLToPath(import.meta.resolve("@hyperframes/producer"));
    } catch {
      return chromeLaunchProbe(chromePath, timeoutMs);
    }
  }
  let puppeteerPath: string;
  try {
    puppeteerPath = createRequire(entry).resolve("puppeteer-core");
  } catch {
    return chromeLaunchProbe(chromePath, timeoutMs);
  }
  const puppeteer = (await import(pathToFileURL(puppeteerPath).href)) as {
    default?: { launch: (o: object) => Promise<{ newPage(): Promise<unknown>; close(): Promise<void> }> };
    launch?: (o: object) => Promise<{ newPage(): Promise<unknown>; close(): Promise<void> }>;
  };
  const launch = puppeteer.launch ?? puppeteer.default?.launch;
  if (!launch) return chromeLaunchProbe(chromePath, timeoutMs);
  let timer: NodeJS.Timeout | undefined;
  let browser: { newPage(): Promise<unknown>; close(): Promise<void> } | undefined;
  try {
    const launching = launch({ executablePath: chromePath, headless: true, args: ["--disable-gpu"] });
    browser = await Promise.race([
      launching,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`headless Chrome did not start within ${timeoutMs} ms (${chromePath})`)), timeoutMs);
      }),
    ]);
    await browser.newPage();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
    await browser?.close().catch(() => {});
  }
}

/**
 * Cheap launch probe: start headless Chrome with a throwaway profile, dump about:blank and exit.
 * Proves the browser can actually launch here (sandboxes often block it), with a hard timeout.
 */
export function chromeLaunchProbe(chromePath: string, timeoutMs: number): Promise<Availability> {
  return (async () => {
    const profile = await mkdtemp(join(tmpdir(), "vs-chrome-probe-"));
    try {
      return await new Promise<Availability>((done) => {
        const args = [
          "--headless=new",
          "--disable-gpu",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-extensions",
          "--disable-background-networking",
          // A fresh profile makes macOS Chrome open its keychain item, which can hang headless
          // launches; puppeteer passes these flags for the same reason.
          "--use-mock-keychain",
          "--password-store=basic",
          `--user-data-dir=${profile}`,
          "--dump-dom",
          "about:blank",
        ];
        if (process.platform === "linux" && process.getuid?.() === 0) args.unshift("--no-sandbox");
        let settled = false;
        let stdout = "";
        let stderr = "";
        const child = spawn(chromePath, args, { stdio: ["ignore", "pipe", "pipe"] });
        const finish = (a: Availability) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          done(a);
        };
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish({ ok: false, reason: `headless Chrome did not start within ${timeoutMs} ms (${chromePath})` });
        }, timeoutMs);
        child.stdout.on("data", (d: Buffer) => (stdout += d.toString()).length > 1e5 && (stdout = stdout.slice(-1e4)));
        child.stderr.on("data", (d: Buffer) => (stderr += d.toString()).length > 1e5 && (stderr = stderr.slice(-1e4)));
        child.on("error", (e) => finish({ ok: false, reason: `cannot launch Chrome at ${chromePath}: ${e.message}` }));
        child.on("close", (code, sig) => {
          if (code === 0 && /<html/i.test(stdout)) return finish({ ok: true });
          const tail = stderr.trim().split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 300);
          finish({ ok: false, reason: `headless Chrome failed to launch (exit ${code ?? sig})${tail ? `: ${tail}` : ""}` });
        });
      });
    } finally {
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    }
  })();
}

// ------------------------------------------------------------------------------ errors

/** A readable, actionable message for a producer failure. */
export function describeHyperframesError(err: unknown, sceneId: string, job?: RenderJob): string {
  const raw = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  const msg = job?.error && !raw.includes(job.error) ? `${raw} (${job.error})` : raw;
  const stage = job?.failedStage ? ` during ${job.failedStage}` : "";
  const prefix = `HyperFrames render of scene ${sceneId} failed${stage}`;
  if (name === "AbortError" || name === "RenderCancelledError" || /render_cancelled|aborted/i.test(raw)) return `HyperFrames render of scene ${sceneId} was cancelled`;
  if (/Failed to launch the browser|Could not find (Chrome|expected browser)|ProcessSingleton|Browser was not found|Chrome binary not found|spawn .*ENOENT.*chrome/i.test(msg)) {
    return `${prefix}: Chrome could not be launched (${msg.split("\n")[0]}). Set CHROME_PATH to a working Chrome/Chromium, or run outside a restricted sandbox.`;
  }
  if (/ffmpeg|ffprobe/i.test(msg) && /not found|ENOENT/i.test(msg)) {
    return `${prefix}: FFmpeg not found (${msg.split("\n")[0]}). Install FFmpeg or set FFMPEG_PATH/FFPROBE_PATH.`;
  }
  if (/timed? ?out|timeout/i.test(msg)) {
    return `${prefix}: timed out (${msg.split("\n")[0]}). The machine may be overloaded; retry, or use the ffmpeg renderer.`;
  }
  const tail = job?.errorDetails?.browserConsoleTail?.slice(-3).join(" | ");
  return `${prefix}: ${msg.split("\n")[0]}${tail ? ` [browser: ${tail.slice(0, 300)}]` : ""}`;
}

// ------------------------------------------------------------------------------ stdout guard

/**
 * The producer and its browser manager log with console.log. Inside the MCP stdio server stdout
 * is the JSON-RPC channel, so route console.log/info/debug to stderr while a render runs.
 */
let guardDepth = 0;
let saved: Pick<Console, "log" | "info" | "debug"> | undefined;
function guardStdout(): () => void {
  if (guardDepth++ === 0) {
    saved = { log: console.log, info: console.info, debug: console.debug };
    const toErr = (...a: unknown[]) => console.error(...a);
    console.log = toErr;
    console.info = toErr;
    console.debug = () => {};
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--guardDepth === 0 && saved) {
      Object.assign(console, saved);
      saved = undefined;
    }
  };
}

function quietLogger(warnings: string[]): ProducerLogger {
  const verbose = process.env.VS_HYPERFRAMES_VERBOSE === "1";
  const fmt = (m: string, meta?: Record<string, unknown>) => (meta ? `${m} ${JSON.stringify(meta).slice(0, 500)}` : m);
  return {
    error: (m, meta) => console.error(`[hyperframes] ${fmt(m, meta)}`),
    warn: (m, meta) => {
      warnings.push(`hyperframes: ${m}`);
      if (verbose) console.error(`[hyperframes] ${fmt(m, meta)}`);
    },
    info: (m, meta) => verbose && console.error(`[hyperframes] ${fmt(m, meta)}`),
    debug: () => {},
    isLevelEnabled: (level) => level === "error" || level === "warn" || (verbose && level === "info"),
  };
}

// ------------------------------------------------------------------------------ assets

/** ContentIR asset id → absolute path, from `<project>/source/content-ir.json` (if present). */
async function loadAssetIndex(projectDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const ir = JSON.parse(await readFile(join(projectDir, "source", "content-ir.json"), "utf8")) as { assets?: Array<{ id?: unknown; path?: unknown }> };
    for (const a of ir.assets ?? []) {
      if (typeof a.id === "string" && typeof a.path === "string") out.set(a.id, a.path);
    }
  } catch {
    /* no ContentIR: ids that look like paths still resolve */
  }
  return out;
}

function defaultProducerInstalled(): boolean {
  try {
    import.meta.resolve("@hyperframes/producer");
    return true;
  } catch {
    return false;
  }
}

// Non-literal specifier: bundlers must not inline the producer (heavy, Chrome-bound); it is
// loaded lazily at render time only.
const PRODUCER_SPECIFIER = "@hyperframes/producer";
const defaultLoadProducer = async (): Promise<HyperframesProducer> => (await import(PRODUCER_SPECIFIER)) as HyperframesProducer;

const probeCache = new Map<string, Promise<Availability>>();

/** Clear cached launch-probe results (tests). */
export function clearHyperframesProbeCache(): void {
  probeCache.clear();
}

// ------------------------------------------------------------------------------ renderer

export function createHyperframesRenderer(opts: HyperframesRendererOptions = {}): SceneRenderer {
  const probeTimeoutMs = opts.probeTimeoutMs ?? 20_000;
  const launchProbe = opts.launchProbe ?? ((path: string, ms: number) => puppeteerLaunchProbe(path, ms));
  const loadProducer = opts.loadProducer ?? defaultLoadProducer;
  const probeOutput = opts.probeOutput ?? ((p: string, signal?: AbortSignal) => ffprobe(p, signal ? { signal } : {}));
  const producerInstalled = opts.producerInstalled ?? defaultProducerInstalled;

  async function check(env: NodeJS.ProcessEnv): Promise<Availability & { chromePath?: string }> {
    if (!producerInstalled()) return { ok: false, reason: `@hyperframes/producer ${HYPERFRAMES_VERSION} is not installed; run doctor for setup` };
    const chrome = await findChrome(opts.chromePath, env);
    if (!chrome.ok) return { ok: false, reason: chrome.reason };
    try {
      await resolveFfmpeg(env);
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    const key = `${chrome.path}\0${probeTimeoutMs}`;
    let probe = probeCache.get(key);
    if (!probe) {
      probe = launchProbe(chrome.path, probeTimeoutMs).catch((e: unknown) => ({
        ok: false,
        reason: `Chrome launch probe failed: ${e instanceof Error ? e.message : String(e)}`,
      }));
      probeCache.set(key, probe);
    }
    const res = await probe;
    return res.ok ? { ok: true, chromePath: chrome.path } : { ok: false, reason: res.reason ?? "headless Chrome failed to launch" };
  }

  return {
    id: "hyperframes",
    version: HYPERFRAMES_VERSION,
    kinds: HYPERFRAMES_KINDS,

    async available(env) {
      const { ok, reason } = await check(env);
      return ok ? { ok } : { ok, reason };
    },

    async render(req: SceneRenderRequest, ropts: { signal?: AbortSignal } = {}): Promise<SceneRenderResult> {
      const { scene, target } = req;
      const signal = ropts.signal;
      signal?.throwIfAborted();
      const kind = scene.deterministic?.kind;
      if (!kind || !HYPERFRAMES_KINDS.includes(kind)) {
        throw new Error(`HyperFrames renderer cannot draw scene ${scene.id}: ${kind ? `kind "${kind}" unsupported` : "no deterministic content"}`);
      }
      if (![24, 30, 60].includes(target.fps)) {
        throw new Error(`HyperFrames renderer supports 24, 30 or 60 fps (scene ${scene.id} asked for ${target.fps})`);
      }
      const avail = await check(process.env);
      if (!avail.ok || !avail.chromePath) throw new Error(`HyperFrames renderer unavailable: ${avail.reason}`);

      const assetIndex = await loadAssetIndex(req.project_dir);
      const comp = buildComposition(req, { resolveAsset: (id) => assetIndex.get(id) });
      const warnings = [...comp.warnings];

      const keep = opts.keepTmp || process.env.VS_KEEP_HYPERFRAMES_TMP === "1";
      const dir = await mkdtemp(join(opts.tmpRoot ?? tmpdir(), `vs-hf-${scene.id}-`));
      let job: RenderJob | undefined;
      const release = guardStdout();
      try {
        await writeFile(join(dir, "index.html"), comp.html, "utf8");
        for (const a of comp.assets) {
          const dest = resolve(dir, a.dest);
          await mkdir(dirname(dest), { recursive: true });
          try {
            await copyFile(a.src, dest);
          } catch (e) {
            warnings.push(`asset ${a.src} could not be copied: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // The producer finds ffmpeg via HYPERFRAMES_FFMPEG_PATH or PATH; point it at the same
        // binaries the rest of the pipeline uses (FFMPEG_PATH/FFPROBE_PATH, then PATH).
        const tools = await resolveFfmpeg(process.env);
        process.env.HYPERFRAMES_FFMPEG_PATH ||= tools.ffmpeg;
        process.env.HYPERFRAMES_FFPROBE_PATH ||= tools.ffprobe;

        const producer = await loadProducer();
        const producerConfig = producer.resolveConfig({
          chromePath: avail.chromePath,
          enableBrowserPool: false,
          concurrency: opts.workers ?? 1,
          fps: target.fps as 24 | 30 | 60,
          quality: opts.quality ?? "standard",
        });
        job = producer.createRenderJob({
          fps: target.fps,
          quality: opts.quality ?? "standard",
          format: "mp4",
          workers: opts.workers ?? 1,
          entryFile: "index.html",
          hdrMode: "force-sdr",
          strictness: "best-effort",
          producerConfig,
          logger: quietLogger(warnings),
        });
        await mkdir(dirname(req.out_path), { recursive: true });
        await producer.executeRenderJob(job, dir, req.out_path, undefined, signal);
        if (job.status === "failed" || job.status === "cancelled") throw new Error(job.error ?? `render ${job.status}`);
        for (const w of job.warnings ?? []) warnings.push(`hyperframes: ${w.code}: ${w.message}`);
      } catch (e) {
        throw new Error(describeHyperframesError(e, scene.id, job), { cause: e });
      } finally {
        release();
        if (!keep) await rm(dir, { recursive: true, force: true }).catch(() => {});
      }

      let probed: ProbeResult;
      try {
        probed = await probeOutput(req.out_path, signal);
      } catch (e) {
        throw new Error(`HyperFrames output for scene ${scene.id} could not be probed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
      if (!probed.has_video) throw new Error(`HyperFrames output for scene ${scene.id} has no video stream`);
      const diff = Math.abs(probed.duration_s - scene.duration_sec);
      if (diff > 0.5) {
        throw new Error(`HyperFrames output for scene ${scene.id} lasts ${probed.duration_s.toFixed(3)}s, expected ${scene.duration_sec}s`);
      }
      if (diff > Math.max(0.1, 2 / target.fps)) warnings.push(`duration ${probed.duration_s.toFixed(3)}s differs from ${scene.duration_sec}s`);
      if (probed.width !== target.width || probed.height !== target.height) {
        warnings.push(`output is ${probed.width}x${probed.height}, expected ${target.width}x${target.height}`);
      }
      return {
        scene_id: scene.id,
        out_path: req.out_path,
        duration_ms: Math.round(probed.duration_s * 1000),
        renderer: "hyperframes",
        renderer_version: HYPERFRAMES_VERSION,
        warnings,
        text_boxes: comp.text_boxes,
      };
    },
  };
}

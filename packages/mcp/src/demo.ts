import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hashFile, projectPaths, readJson, resolveInsideProject, writeJsonAtomic } from "@video-studio/core";
import { ffprobe, runFfmpeg } from "@video-studio/media";
import { findChrome } from "@video-studio/renderer";
import { ContentIR, DemoScript, type DemoStep, type IrAsset, parseYamlOrJson } from "@video-studio/schema";
import { findPluginRoot, resolveHyperframesProducer } from "./hyperframes.js";
import { projectSpecPaths } from "./spec-validate.js";

/**
 * demo: record a scripted walk through an app the USER started (project/demo.json, DemoScript)
 * with the system Chrome, and add the recording to the ContentIR as a video asset whose evidence
 * spans are the steps actually performed ("actual UI only": screen_capture scenes cite them).
 *
 * Safety: the plugin never starts the app; the caller must pass `confirm: true` after the user
 * approved the URL and steps. Every input, textarea, select and contenteditable is blurred in
 * the page (plus `mask_selectors`), so typed text and secrets never reach the recording.
 * Chrome is driven through puppeteer-core resolved at runtime (the HyperFrames producer's copy,
 * or one installed next to it); nothing is downloaded.
 */

export const DEMO_FILE = "demo.json";
/** Blur applied to masked elements (CSS). */
export const MASK_CSS_BLUR = "blur(8px)";

// ---- the small slice of puppeteer this module uses (tests inject fakes)

export interface DemoBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface DemoElement {
  boundingBox(): Promise<DemoBox | null>;
}
export interface DemoRecorder {
  stop(): Promise<void>;
}
export interface DemoPage {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  $(selector: string): Promise<DemoElement | null>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string, opts?: { delay?: number }): Promise<void>;
  hover(selector: string): Promise<void>;
  evaluate<T>(fn: string | ((...args: never[]) => T), ...args: unknown[]): Promise<T>;
  mouse: { move(x: number, y: number, opts?: { steps?: number }): Promise<void> };
  screencast(opts: { path: string }): Promise<DemoRecorder>;
}
export interface DemoBrowser {
  newPage(): Promise<DemoPage>;
  close(): Promise<void>;
}
/** CSS viewport handed to the browser: width/height in CSS px plus the device scale factor. */
export interface DemoViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}
export type BrowserFactory = (opts: { viewport: DemoViewport; env: Record<string, string | undefined> }) => Promise<DemoBrowser>;

/** CSS width a phone-sized page is laid out at when recording a portrait reel. */
export const PHONE_CSS_WIDTH = 390;

/**
 * CSS viewport for a recording size: portrait recordings wider than 600 px lay the page out at
 * phone width (390 CSS px) and render at the full resolution; everything else at 1:1, unless
 * the script sets device_scale_factor.
 */
export function cssViewport(v: DemoScript["viewport"]): DemoViewport {
  const dsf = v.device_scale_factor ?? (v.height > v.width && v.width > 600 ? v.width / PHONE_CSS_WIDTH : 1);
  return { width: Math.round(v.width / dsf), height: Math.round(v.height / dsf), deviceScaleFactor: Math.round(dsf * 1000) / 1000 };
}

export interface RecordDemoOptions {
  /** The user approved the URL and the steps. Required. */
  confirm?: boolean;
  /** DemoScript path, project-relative (default project/demo.json). */
  script?: string;
  env?: Record<string, string | undefined>;
  browser?: BrowserFactory;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DemoStepRecord {
  index: number;
  action: DemoStep["action"];
  detail: string;
  at_sec: number;
}

export interface RecordDemoResult {
  asset: string;
  path: string;
  duration_sec: number;
  steps: DemoStepRecord[];
  evidence_refs: string[];
  warnings: string[];
}

/** Resolve puppeteer-core without bundling it: next to the HyperFrames producer, then the plugin root. */
export async function loadPuppeteer(env: Record<string, string | undefined>): Promise<{ launch: (o: Record<string, unknown>) => Promise<unknown> }> {
  const tried: string[] = [];
  const attempt = async (from: string) => {
    try {
      const path = createRequire(from).resolve("puppeteer-core");
      const mod = (await import(pathToFileURL(path).href)) as { launch?: unknown; default?: { launch?: unknown } };
      const launch = (mod.launch ?? mod.default?.launch) as ((o: Record<string, unknown>) => Promise<unknown>) | undefined;
      return launch ? { launch } : null;
    } catch {
      tried.push(from);
      return null;
    }
  };
  const producer = resolveHyperframesProducer(env);
  if (producer.ok) {
    const p = await attempt(producer.entry);
    if (p) return p;
  }
  const root = findPluginRoot(env);
  if (root) {
    const p = await attempt(join(root, "package.json"));
    if (p) return p;
  }
  throw new Error(
    "demo capture needs puppeteer-core, which comes with the optional HyperFrames install (see the doctor / render skill): " +
      'cd "${CLAUDE_PLUGIN_DATA}" && PUPPETEER_SKIP_DOWNLOAD=1 npm i @hyperframes/producer --prefix deps',
  );
}

/** Default browser: the system Chrome through puppeteer-core, headless, fixed viewport. */
export const systemChrome: BrowserFactory = async ({ viewport, env }) => {
  const chrome = await findChrome(env.CHROME_PATH, env as NodeJS.ProcessEnv);
  if (!chrome.ok) throw new Error(`demo capture needs Google Chrome: ${chrome.reason}`);
  const puppeteer = await loadPuppeteer(env);
  const browser = (await puppeteer.launch({
    executablePath: chrome.path,
    headless: true,
    defaultViewport: viewport,
    args: ["--hide-scrollbars", "--mute-audio", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain"],
  })) as DemoBrowser;
  return browser;
};

/** CSS that blurs every input-like element and the extra selectors, and draws the demo cursor. */
export function maskCss(selectors: readonly string[] = []): string {
  const masked = ["input", "textarea", "select", '[contenteditable="true"]', '[contenteditable=""]', ...selectors].join(",\n");
  return `${masked} { filter: ${MASK_CSS_BLUR} !important; }
#vs-cursor { position: fixed; z-index: 2147483647; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%;
  background: rgba(255,255,255,0.85); border: 3px solid rgba(20,20,20,0.85); pointer-events: none; transition: transform 120ms ease-out; }
#vs-cursor.down { transform: scale(0.7); }`;
}

/** Script injected after each navigation: the mask stylesheet and the cursor element. */
function setupScript(css: string): string {
  return `(() => {
  if (!document.getElementById("vs-mask")) {
    const s = document.createElement("style"); s.id = "vs-mask"; s.textContent = ${JSON.stringify(css)};
    document.documentElement.appendChild(s);
  }
  if (!document.getElementById("vs-cursor")) {
    const c = document.createElement("div"); c.id = "vs-cursor"; c.style.left = "-40px"; c.style.top = "-40px";
    document.documentElement.appendChild(c);
  }
})()`;
}

const cursorTo = (x: number, y: number, down = false) =>
  `(() => { const c = document.getElementById("vs-cursor"); if (c) { c.style.left = "${Math.round(x)}px"; c.style.top = "${Math.round(y)}px"; c.classList.toggle("down", ${down}); } })()`;

async function center(page: DemoPage, selector: string): Promise<{ x: number; y: number; box: DemoBox }> {
  const el = await page.$(selector);
  const box = el ? await el.boundingBox() : null;
  if (!box) throw new Error(`demo step: selector "${selector}" was not found or is not visible`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

function describeStep(s: DemoStep): string {
  switch (s.action) {
    case "goto":
      return `opened ${s.url}`;
    case "click":
      return `clicked ${s.selector}`;
    case "type":
      return `typed ${s.text.length} characters into ${s.selector} (masked)`;
    case "hover":
      return `hovered ${s.selector}`;
    case "scroll":
      return `scrolled ${s.y > 0 ? "down" : "up"} ${Math.abs(s.y)} px`;
    case "zoom":
      return `zoomed into ${s.selector}`;
    case "wait":
      return `waited ${s.ms} ms`;
  }
}

async function loadScript(root: string, rel?: string): Promise<DemoScript> {
  // Inside the project only (the script drives a browser; it must be the project's own file).
  let path: string;
  try {
    path = await resolveInsideProject(projectPaths(root), rel ?? join("project", DEMO_FILE));
  } catch {
    throw new Error(`demo script must be a path inside the project: ${rel}`);
  }
  if (!existsSync(path)) {
    throw new Error(`no ${rel ?? `project/${DEMO_FILE}`}; write a DemoScript first (schema_get demo-script): {schema_version, id, url, viewport, steps}`);
  }
  const r = parseYamlOrJson(DemoScript, await readFile(path, "utf8"));
  if (!r.ok) throw new Error(`demo script is invalid: ${r.errors.slice(0, 5).map((e) => `${e.path}: ${e.message}`).join("; ")}`);
  return r.data;
}

/** Add (or replace) the recording in source/content-ir.json: a source, a section, one evidence span per step, the video asset. */
async function recordInIr(root: string, script: DemoScript, asset: IrAsset, steps: DemoStepRecord[], duration: number): Promise<string[]> {
  const irPath = projectSpecPaths(root).contentIr;
  const sourceId = `demo-${script.id}`;
  const file = asset.path.split("/").pop()!;
  const refs = steps.map((s) => `video:${file}#step-${s.index + 1}`);
  const evidence = steps.map((s, i) => ({
    ref: refs[i]!,
    source_id: sourceId,
    text: `${s.detail} (at ${s.at_sec.toFixed(1)} s of the recording)`,
    locator: { time_start_sec: s.at_sec, time_end_sec: steps[i + 1]?.at_sec ?? duration },
  }));
  const source = { id: sourceId, kind: "video" as const, uri: script.url, sha256: asset.sha256, title: `Demo recording of ${script.url}` };
  const section = { id: `${sourceId}-steps`, source_id: sourceId, heading: "Demo steps", text: steps.map((s) => `${s.index + 1}. ${s.detail}`).join("\n") };
  let ir: ContentIR;
  if (existsSync(irPath)) {
    ir = ContentIR.parse(await readJson(irPath));
    ir.sources = [...ir.sources.filter((s) => s.id !== sourceId), source];
    ir.sections = [...ir.sections.filter((s) => s.source_id !== sourceId), section];
    ir.evidence = [...ir.evidence.filter((e) => e.source_id !== sourceId), ...evidence];
    ir.assets = [...ir.assets.filter((a) => a.id !== asset.id), asset];
  } else {
    ir = {
      schema_version: "1.0",
      id: `ir-${sourceId}`,
      created_at: new Date().toISOString(),
      sources: [source],
      sections: [section],
      evidence,
      entities: [],
      claims: [],
      assets: [asset],
      classification: { contains_secrets: false, contains_pii: false, contains_likeness: false, data_class: "internal", notes: [] },
      warnings: [],
    };
  }
  const note = `demo ${script.id}: screen recording of ${script.url}; inputs and ${script.mask_selectors?.length ?? 0} extra selector(s) were blurred`;
  ir.classification.notes = [...ir.classification.notes.filter((n) => !n.startsWith(`demo ${script.id}:`)), note];
  await writeJsonAtomic(irPath, ContentIR.parse(ir));
  return refs;
}

export async function recordDemo(projectDir: string, opts: RecordDemoOptions = {}): Promise<RecordDemoResult> {
  if (opts.confirm !== true) {
    throw new Error("demo capture drives a browser against a URL: show the user the URL and steps, and call again with confirm: true once they approve");
  }
  const root = projectPaths(projectDir).root;
  const env = opts.env ?? process.env;
  const script = await loadScript(root, opts.script);
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const warnings: string[] = [];
  const start = new URL(script.url);
  // goto steps stay on the app the user started (same origin); anything else is refused up front.
  for (const s of script.steps) {
    if (s.action !== "goto") continue;
    let to: URL;
    try {
      to = new URL(s.url, start);
    } catch {
      throw new Error(`demo: goto step has an invalid URL: ${s.url}`);
    }
    if (to.origin !== start.origin) throw new Error(`demo: goto ${to.href} leaves ${start.origin}; demo steps must stay on the app you started`);
  }
  const host = start.hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) && !host.endsWith(".localhost")) {
    warnings.push(`${script.url} is not a local address; make sure you may record it and that no real customer data is on screen`);
  }

  const work = await mkdtemp(join(tmpdir(), "vs-demo-"));
  const webm = join(work, "demo.webm");
  const browser = await (opts.browser ?? systemChrome)({ viewport: cssViewport(script.viewport), env });
  const steps: DemoStepRecord[] = [];
  const setup = setupScript(maskCss(script.mask_selectors));
  let recorder: DemoRecorder | undefined;
  try {
    const page = await browser.newPage();
    await page.goto(script.url, { waitUntil: "networkidle2", timeout: 30_000 });
    await page.evaluate(setup);
    recorder = await page.screencast({ path: webm });
    const t0 = now();
    const limit = (script.max_duration_sec ?? 120) * 1000;
    for (const [index, step] of script.steps.entries()) {
      if (now() - t0 > limit) {
        warnings.push(`stopped after ${index} step(s): max_duration_sec ${script.max_duration_sec ?? 120} reached`);
        break;
      }
      steps.push({ index, action: step.action, detail: describeStep(step), at_sec: Math.round((now() - t0) / 100) / 10 });
      switch (step.action) {
        case "goto":
          await page.goto(step.url, { waitUntil: "networkidle2", timeout: 30_000 });
          await page.evaluate(setup);
          if (step.wait_ms) await sleep(step.wait_ms);
          break;
        case "click": {
          const c = await center(page, step.selector);
          await page.mouse.move(c.x, c.y, { steps: 20 });
          await page.evaluate(cursorTo(c.x, c.y, true));
          await page.click(step.selector);
          await page.evaluate(cursorTo(c.x, c.y));
          await page.evaluate(setup); // the click may have navigated
          await sleep(step.wait_ms ?? 600);
          break;
        }
        case "type": {
          const c = await center(page, step.selector);
          await page.mouse.move(c.x, c.y, { steps: 15 });
          await page.evaluate(cursorTo(c.x, c.y));
          await page.type(step.selector, step.text, { delay: step.delay_ms ?? 60 });
          await sleep(300);
          break;
        }
        case "hover": {
          const c = await center(page, step.selector);
          await page.mouse.move(c.x, c.y, { steps: 20 });
          await page.evaluate(cursorTo(c.x, c.y));
          await page.hover(step.selector);
          await sleep(500);
          break;
        }
        case "scroll":
          await page.evaluate(`window.scrollBy({ top: ${step.y}, behavior: "${step.smooth === false ? "auto" : "smooth"}" })`);
          await sleep(800);
          break;
        case "zoom": {
          const c = await center(page, step.selector);
          const s = step.scale ?? 1.8;
          await page.evaluate(
            `(() => { const d = document.documentElement; d.style.transition = "transform 500ms ease-in-out"; d.style.transformOrigin = "${Math.round(c.x)}px ${Math.round(c.y)}px"; d.style.transform = "scale(${s})"; })()`,
          );
          await sleep(step.hold_ms ?? 1500);
          await page.evaluate(`(() => { document.documentElement.style.transform = ""; })()`);
          await sleep(500);
          break;
        }
        case "wait":
          await sleep(step.ms);
          break;
      }
    }
    await sleep(500);
  } finally {
    await recorder?.stop().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  try {
    if (!existsSync(webm)) throw new Error("the browser produced no recording (screencast needs ffmpeg on PATH)");
    const id = `demo-${script.id}`;
    const rel = `source/assets/${id}.mp4`;
    const out = join(root, rel);
    await mkdir(join(root, "source", "assets"), { recursive: true });
    // H.264 + a constant frame rate, so the footage renderer can trim it frame-accurately.
    // Exactly the requested size, whatever the screencast delivered (it may be CSS or device pixels).
    const { width: W, height: H } = script.viewport;
    await runFfmpeg(["-y", "-i", webm, "-vf", `fps=30,scale=${W - (W % 2)}:${H - (H % 2)}:flags=lanczos,setsar=1`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", out]);
    const p = await ffprobe(out);
    const asset: IrAsset = {
      id,
      kind: "video",
      path: rel,
      sha256: await hashFile(out),
      media: { duration_sec: p.duration_s, ...(p.width ? { width: p.width } : {}), ...(p.height ? { height: p.height } : {}), ...(p.fps ? { fps: p.fps } : {}), has_video: true, has_audio: false },
      ...(steps.length ? { source_ref: `video:${id}.mp4#step-1` } : {}),
    };
    const refs = await recordInIr(root, script, asset, steps, p.duration_s);
    return { asset: id, path: rel, duration_sec: p.duration_s, steps, evidence_refs: refs, warnings };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export function formatDemo(r: RecordDemoResult): string {
  return [
    `recorded ${r.asset} (${r.duration_sec.toFixed(1)} s) → ${r.path}`,
    ...r.steps.map((s) => `- ${s.at_sec.toFixed(1)}s ${s.detail} [${r.evidence_refs[s.index]}]`),
    ...r.warnings.map((w) => `warning: ${w}`),
    "use it in screen_capture scenes: footage {asset, in_sec, out_sec} with claim_refs of the steps shown",
  ].join("\n");
}

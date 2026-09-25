import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffprobe, type ProbeResult } from "@video-studio/media";
import type { Scene } from "@video-studio/schema";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  chromeLaunchProbe,
  clearHyperframesProbeCache,
  createHyperframesRenderer,
  describeHyperframesError,
  findChrome,
  type HyperframesProducer,
} from "./hyperframes-renderer.js";
import type { SceneRenderRequest, VisualTokens } from "./types.js";

const TOKENS: VisualTokens = {
  font_heading: "Helvetica, Arial, sans-serif",
  font_body: "Helvetica, Arial, sans-serif",
  font_mono: "Menlo, monospace",
  color_background: "#0B0F19",
  color_text: "#F5F7FA",
  color_primary: "#4F8CFF",
  color_secondary: "#22C55E",
};

function scene(duration = 1): Scene {
  return {
    id: "s01",
    duration_sec: duration,
    purpose: "hook",
    voiceover: "",
    visual_strategy: "motion_graphic",
    deterministic: { kind: "typography", props: { lines: ["Vector DBs", "in 30 seconds"], emphasis: "Vector" } },
    visual_requirements: { continuity_refs: [] },
    claim_refs: [],
  };
}

let dir: string;
let fakeChrome: string;
const envBackup = { ...process.env };

async function script(name: string, body: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, `#!/bin/sh\n${body}\n`);
  await chmod(p, 0o755);
  return p;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vs-hf-test-"));
  fakeChrome = await script("fake-chrome", 'echo "<html><head></head><body></body></html>"');
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterEach(() => {
  clearHyperframesProbeCache();
  for (const k of ["HYPERFRAMES_FFMPEG_PATH", "HYPERFRAMES_FFPROBE_PATH", "FFMPEG_PATH", "FFPROBE_PATH"]) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

describe("findChrome", () => {
  it("honours an explicit path and reports a missing one", async () => {
    expect(await findChrome(fakeChrome, {})).toEqual({ ok: true, path: fakeChrome });
    const missing = await findChrome("/nope/chrome", {});
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.reason).toMatch(/Chrome not found at \/nope\/chrome/);
  });
  it("uses CHROME_PATH, then platform lookups", async () => {
    expect(await findChrome(undefined, { CHROME_PATH: fakeChrome })).toEqual({ ok: true, path: fakeChrome });
    const linux = await findChrome(undefined, { PATH: dir }, "linux");
    expect(linux.ok).toBe(false);
    await script("chromium", "exit 0");
    expect(await findChrome(undefined, { PATH: dir }, "linux")).toEqual({ ok: true, path: join(dir, "chromium") });
  });
});

describe("chromeLaunchProbe", () => {
  it("succeeds when the browser dumps a DOM", async () => {
    expect(await chromeLaunchProbe(fakeChrome, 5000)).toEqual({ ok: true });
  });
  it("reports launch failures with stderr", async () => {
    const bad = await script("bad-chrome", 'echo "ProcessSingleton: socket dir error" >&2; exit 1');
    const r = await chromeLaunchProbe(bad, 5000);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/failed to launch \(exit 1\): ProcessSingleton/);
  });
  it("times out a hung browser", async () => {
    const hung = await script("hung-chrome", "sleep 5");
    const r = await chromeLaunchProbe(hung, 150);
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/did not start within 150 ms/) });
  });
});

describe("available()", () => {
  it("is false with a reason when the injected chrome path does not exist", async () => {
    const r = createHyperframesRenderer({ chromePath: join(dir, "missing-chrome") });
    const a = await r.available(process.env);
    expect(a.ok).toBe(false);
    expect(a.reason).toContain("missing-chrome");
  });
  it("is false when the producer package is missing", async () => {
    const r = createHyperframesRenderer({ chromePath: fakeChrome, producerInstalled: () => false });
    expect(await r.available(process.env)).toEqual({ ok: false, reason: expect.stringMatching(/@hyperframes\/producer 0\.8\.75/) });
  });
  it("runs the launch probe once and caches its result", async () => {
    let calls = 0;
    const r = createHyperframesRenderer({
      chromePath: fakeChrome,
      launchProbe: async () => {
        calls++;
        return { ok: false, reason: "sandboxed" };
      },
    });
    expect(await r.available(process.env)).toEqual({ ok: false, reason: "sandboxed" });
    expect(await r.available(process.env)).toEqual({ ok: false, reason: "sandboxed" });
    expect(calls).toBe(1);
  });
  it("is ok when chrome launches, ffmpeg resolves and the producer is installed", async () => {
    const ff = await script("ff-ok", "exit 0");
    const r = createHyperframesRenderer({ chromePath: fakeChrome, launchProbe: async () => ({ ok: true }) });
    expect(await r.available({ ...process.env, FFMPEG_PATH: ff, FFPROBE_PATH: ff })).toEqual({ ok: true });
    expect(r.id).toBe("hyperframes");
    expect(r.version).toBe("0.8.75");
    expect(r.kinds).toContain("diagram");
  });
});

describe("render() with an injected producer", () => {
  async function setup(producer: Partial<HyperframesProducer>, probe?: Partial<ProbeResult>) {
    const tmpRoot = await mkdtemp(join(dir, "tmproot-"));
    const project = await mkdtemp(join(dir, "project-"));
    await mkdir(join(project, "source", "assets"), { recursive: true });
    await writeFile(join(project, "source", "assets", "shot.png"), "png");
    await writeFile(join(project, "source", "content-ir.json"), JSON.stringify({ assets: [{ id: "a1", path: "source/assets/shot.png" }] }));
    const ffbin = await script("ff", "exit 0");
    process.env.FFMPEG_PATH = ffbin;
    process.env.FFPROBE_PATH = ffbin;
    delete process.env.HYPERFRAMES_FFMPEG_PATH;
    delete process.env.HYPERFRAMES_FFPROBE_PATH;
    const seen: { html?: string; files?: string[]; config?: any; producerConfig?: any; projectDir?: string } = {};
    const full: HyperframesProducer = {
      resolveConfig: (o) => ((seen.producerConfig = o), { ...o }) as any,
      createRenderJob: (config) => ((seen.config = config), { id: "j", config, status: "queued", warnings: [] }) as any,
      executeRenderJob: async (job, projectDir, out) => {
        seen.projectDir = projectDir;
        seen.html = await readFile(join(projectDir, "index.html"), "utf8");
        seen.files = (await readdir(projectDir, { recursive: true })).map(String).sort();
        await writeFile(out, "mp4");
        (job as any).status = "complete";
      },
      ...producer,
    };
    const r = createHyperframesRenderer({
      chromePath: fakeChrome,
      tmpRoot,
      launchProbe: async () => ({ ok: true }),
      loadProducer: async () => full,
      probeOutput: async () => ({ duration_s: 1, width: 180, height: 320, has_video: true, ...probe }) as ProbeResult,
    });
    return { r, seen, tmpRoot, project };
  }

  function request(project: string, over: Partial<SceneRenderRequest> = {}): SceneRenderRequest {
    return {
      scene: scene(1),
      target: { width: 180, height: 320, fps: 30, aspect_ratio: "9:16" },
      tokens: TOKENS,
      out_path: join(project, "renders", "s01.mp4"),
      project_dir: project,
      ...over,
    };
  }

  it("writes the composition, calls the producer API and cleans up", async () => {
    const { r, seen, tmpRoot, project } = await setup({});
    const shot = { ...scene(1), deterministic: { kind: "screenshot" as const, props: { asset: "a1", callouts: ["Here"] } } };
    const res = await r.render(request(project, { scene: shot }));
    expect(res).toEqual({ scene_id: "s01", out_path: join(project, "renders", "s01.mp4"), duration_ms: 1000, renderer: "hyperframes", renderer_version: "0.8.75", warnings: [], text_boxes: expect.any(Array) });
    expect(res.text_boxes!.length).toBeGreaterThan(0);
    expect(seen.html).toContain('data-composition-id="vs-s01"');
    expect(seen.files).toEqual(["assets", "assets/screenshot-1.png", "index.html"]);
    expect(seen.config).toMatchObject({ fps: 30, format: "mp4", quality: "standard", workers: 1, entryFile: "index.html", hdrMode: "force-sdr" });
    expect(seen.producerConfig).toMatchObject({ chromePath: fakeChrome, enableBrowserPool: false, concurrency: 1 });
    expect(process.env.HYPERFRAMES_FFMPEG_PATH).toBe(process.env.FFMPEG_PATH);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it("maps producer failures to readable errors and still cleans up", async () => {
    const { r, tmpRoot, project } = await setup({
      executeRenderJob: async (job) => {
        (job as any).failedStage = "capture";
        throw new Error("Failed to launch the browser process!\nstack...");
      },
    });
    await expect(r.render(request(project))).rejects.toThrow(/scene s01 failed during capture: Chrome could not be launched .*CHROME_PATH/);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it("rejects output whose duration is off by more than 0.5 s", async () => {
    const { r, project } = await setup({}, { duration_s: 2 });
    await expect(r.render(request(project))).rejects.toThrow(/lasts 2\.000s, expected 1s/);
  });

  it("refuses unsupported fps and missing deterministic content", async () => {
    const { r, project } = await setup({});
    await expect(r.render(request(project, { target: { width: 180, height: 320, fps: 25, aspect_ratio: "9:16" } }))).rejects.toThrow(/24, 30 or 60 fps/);
    const s = scene(1);
    delete s.deterministic;
    await expect(r.render(request(project, { scene: s }))).rejects.toThrow(/no deterministic content/);
  });

  it("fails fast when unavailable", async () => {
    const r = createHyperframesRenderer({ chromePath: join(dir, "missing-chrome") });
    await expect(r.render(request(dir))).rejects.toThrow(/HyperFrames renderer unavailable: Chrome not found/);
  });
});

describe("describeHyperframesError", () => {
  it("classifies common failures", () => {
    expect(describeHyperframesError(new Error("spawn ffmpeg ENOENT"), "s02")).toMatch(/FFmpeg not found/);
    expect(describeHyperframesError(Object.assign(new Error("x"), { name: "AbortError" }), "s02")).toMatch(/was cancelled/);
    expect(describeHyperframesError(new Error("Timed out waiting for __renderReady"), "s02")).toMatch(/timed out/);
    expect(describeHyperframesError(new Error("boom"), "s02", { errorDetails: { browserConsoleTail: ["a", "b"] } } as any)).toBe(
      "HyperFrames render of scene s02 failed: boom [browser: a | b]",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Real render (needs Chrome + FFmpeg; cannot run inside the Claude Code sandbox).
//   VS_TEST_RENDER=1 npx vitest run packages/renderer/src/hyperframes
// ---------------------------------------------------------------------------------------------
describe.skipIf(process.env.VS_TEST_RENDER !== "1")("real HyperFrames render (VS_TEST_RENDER=1)", () => {
  it(
    "renders a 180x320 1 s typography clip that ffprobe accepts",
    async () => {
      const out = await mkdtemp(join(tmpdir(), "vs-hf-real-"));
      try {
        const r = createHyperframesRenderer({ quality: "draft" });
        const avail = await r.available(process.env);
        expect(avail, avail.reason).toEqual({ ok: true });
        const outPath = join(out, "s01.mp4");
        const res = await r.render({
          scene: scene(1),
          target: { width: 180, height: 320, fps: 30, aspect_ratio: "9:16" },
          tokens: TOKENS,
          out_path: outPath,
          project_dir: out,
        });
        const p = await ffprobe(outPath);
        expect(p.has_video).toBe(true);
        expect(p.width).toBe(180);
        expect(p.height).toBe(320);
        expect(p.video_codec).toBe("h264");
        expect(Math.abs(p.duration_s - 1)).toBeLessThanOrEqual(0.1);
        expect(res.duration_ms).toBeGreaterThan(900);
        console.error(`[hyperframes real render] ${outPath}: ${JSON.stringify(p)} warnings=${JSON.stringify(res.warnings)}`);
      } finally {
        if (process.env.VS_KEEP_HYPERFRAMES_TMP !== "1") await rm(out, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

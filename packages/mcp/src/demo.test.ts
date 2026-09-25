import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFfmpeg } from "@video-studio/media";
import { ContentIR, type DemoScript } from "@video-studio/schema";
import { type BrowserFactory, type DemoPage, cssViewport, maskCss, recordDemo } from "./demo.js";

let tmp: string;

const script: DemoScript = {
  schema_version: "1.0",
  id: "signup",
  url: "http://localhost:3000",
  viewport: { width: 640, height: 360 },
  steps: [
    { action: "click", selector: "#start" },
    { action: "type", selector: "#email", text: "ada@example.com" },
    { action: "zoom", selector: "#plan", scale: 2, hold_ms: 10 },
    { action: "scroll", y: 400 },
    { action: "wait", ms: 10 },
  ],
  mask_selectors: [".api-key"],
};

/** A fake page that logs calls; its screencast writes a real 1 s clip when stopped. */
function fakeBrowser(log: string[], opts: { missing?: string } = {}): BrowserFactory {
  return async ({ viewport }) => {
    const page: DemoPage = {
      goto: async (url) => void log.push(`goto ${url}`),
      $: async (sel) => (sel === opts.missing ? null : { boundingBox: async () => ({ x: 100, y: 50, width: 80, height: 20 }) }),
      click: async (sel) => void log.push(`click ${sel}`),
      type: async (sel, text) => void log.push(`type ${sel} ${text.length}`),
      hover: async (sel) => void log.push(`hover ${sel}`),
      evaluate: async (fn) => {
        const src = String(fn);
        if (src.includes("vs-mask")) log.push("setup");
        else if (src.includes("scale(")) log.push("zoom");
        return undefined as never;
      },
      mouse: { move: async (x, y) => void log.push(`move ${x},${y}`) },
      screencast: async ({ path }) => ({
        stop: async () => {
          log.push("stop");
          await runFfmpeg(["-y", "-f", "lavfi", "-i", `testsrc=size=${viewport.width}x${viewport.height}:rate=15:duration=1`, "-c:v", "libx264", "-preset", "ultrafast", "-f", "matroska", path]);
        },
      }),
    };
    return { newPage: async () => page, close: async () => void log.push("close") };
  };
}

async function project(name: string): Promise<string> {
  const dir = join(tmp, name);
  await mkdir(join(dir, "project"), { recursive: true });
  await writeFile(join(dir, "project", "demo.json"), JSON.stringify(script));
  return dir;
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-demo-test-"));
});
afterAll(() => rm(tmp, { recursive: true, force: true }));

describe("demo capture", () => {
  it("refuses without confirmation, before touching a browser", async () => {
    const log: string[] = [];
    await expect(recordDemo(await project("noconfirm"), { browser: fakeBrowser(log) })).rejects.toThrow(/confirm: true/);
    expect(log).toEqual([]);
  });

  it("masks inputs, drives the steps with a visible cursor, and adds the recording and its steps to the ContentIR", async () => {
    const log: string[] = [];
    let t = 0;
    const dir = await project("ok");
    const r = await recordDemo(dir, { confirm: true, browser: fakeBrowser(log), now: () => (t += 250), sleep: async () => undefined });
    expect(log[0]).toBe("goto http://localhost:3000");
    expect(log[1]).toBe("setup");
    expect(log).toContain("click #start");
    expect(log).toContain("type #email 15");
    expect(log).toContain("zoom");
    expect(log.slice(-2)).toEqual(["stop", "close"]);
    expect(log.some((l) => l.startsWith("move 140,60"))).toBe(true);
    expect(r.steps.map((s) => s.action)).toEqual(["click", "type", "zoom", "scroll", "wait"]);
    expect(r.steps[1]!.detail).toBe("typed 15 characters into #email (masked)");
    expect(r.warnings).toEqual([]);

    const ir = ContentIR.parse(JSON.parse(await readFile(join(dir, "source", "content-ir.json"), "utf8")));
    const asset = ir.assets.find((a) => a.id === "demo-signup")!;
    expect(asset).toMatchObject({ kind: "video", path: "source/assets/demo-signup.mp4", source_ref: "video:demo-signup.mp4#step-1", media: { has_video: true, has_audio: false, width: 640, height: 360 } });
    expect(ir.evidence.map((e) => e.ref)).toEqual([1, 2, 3, 4, 5].map((n) => `video:demo-signup.mp4#step-${n}`));
    const starts = ir.evidence.map((e) => e.locator.time_start_sec!);
    expect(starts.every((t, i) => i === 0 || t > starts[i - 1]!)).toBe(true);
    expect(ir.evidence[4]!.locator.time_end_sec).toBe(asset.media!.duration_sec);
    expect(JSON.stringify(ir)).not.toContain("ada@example.com");
    expect(ir.classification.notes.join(" ")).toMatch(/inputs and 1 extra selector\(s\) were blurred/);
  }, 30_000);

  it("fails clearly when a selector is missing, and still closes the browser", async () => {
    const log: string[] = [];
    await expect(recordDemo(await project("missing"), { confirm: true, browser: fakeBrowser(log, { missing: "#email" }), sleep: async () => undefined })).rejects.toThrow(/"#email" was not found/);
    expect(log).toContain("close");
  }, 30_000);

  it("warns about non-local URLs", async () => {
    const dir = await project("remote");
    await writeFile(join(dir, "project", "demo.json"), JSON.stringify({ ...script, url: "https://example.com", steps: [{ action: "wait", ms: 1 }] }));
    const r = await recordDemo(dir, { confirm: true, browser: fakeBrowser([]), sleep: async () => undefined });
    expect(r.warnings.join(" ")).toMatch(/not a local address/);
  }, 30_000);

  it("lays portrait recordings out at phone width and records at the full size", async () => {
    expect(cssViewport({ width: 1080, height: 1920 })).toEqual({ width: 390, height: 693, deviceScaleFactor: 2.769 });
    expect(cssViewport({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    expect(cssViewport({ width: 1080, height: 1920, device_scale_factor: 1 })).toEqual({ width: 1080, height: 1920, deviceScaleFactor: 1 });
    const dir = await project("portrait");
    await writeFile(join(dir, "project", "demo.json"), JSON.stringify({ ...script, viewport: { width: 1080, height: 1920 }, steps: [{ action: "wait", ms: 1 }] }));
    let seen: unknown;
    const inner = fakeBrowser([]);
    const r = await recordDemo(dir, { confirm: true, sleep: async () => undefined, browser: async (o) => ((seen = o.viewport), inner(o)) });
    expect(seen).toEqual({ width: 390, height: 693, deviceScaleFactor: 2.769 });
    const ir = ContentIR.parse(JSON.parse(await readFile(join(dir, "source", "content-ir.json"), "utf8")));
    expect(ir.assets.find((a) => a.id === r.asset)!.media).toMatchObject({ width: 1080, height: 1920 });
  }, 30_000);

  it("mask CSS covers inputs and extra selectors", () => {
    const css = maskCss([".api-key"]);
    for (const sel of ["input", "textarea", "select", ".api-key"]) expect(css).toContain(sel);
    expect(css).toContain("blur(8px)");
  });
});

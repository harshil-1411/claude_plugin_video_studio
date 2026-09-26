import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HYPERFRAMES_VERSION } from "@video-studio/renderer";
import { HYPERFRAMES_INSTALL_COMMAND, findPluginRoot, hyperframesOptions, resolveHyperframesProducer } from "./hyperframes.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-hf-resolve-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function fakeProducer(nodeModules: string, version: string): Promise<void> {
  const dir = join(nodeModules, "@hyperframes", "producer");
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@hyperframes/producer", version, type: "module", exports: { ".": { import: "./dist/index.js" } } }));
  await writeFile(join(dir, "dist", "index.js"), "export const createRenderJob = () => ({}); export const marker = 'fake';\n");
}

describe("resolveHyperframesProducer", () => {
  it("reports not installed with a doctor hint when nothing is found", () => {
    const r = resolveHyperframesProducer({ CLAUDE_PLUGIN_DATA: join(tmp, "empty-data") }, { pluginRoot: join(tmp, "empty-root") });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe(`@hyperframes/producer ${HYPERFRAMES_VERSION} is not installed; run doctor for setup`);
      expect(r.searched[0]).toBe(join(tmp, "empty-data", "deps", "node_modules"));
    }
  });

  it("finds the manual install under ${CLAUDE_PLUGIN_DATA}/deps first and loads it", async () => {
    const data = join(tmp, "data");
    await fakeProducer(join(data, "deps", "node_modules"), HYPERFRAMES_VERSION);
    await fakeProducer(join(tmp, "root", "node_modules"), HYPERFRAMES_VERSION);
    const r = resolveHyperframesProducer({ CLAUDE_PLUGIN_DATA: data }, { pluginRoot: join(tmp, "root") });
    expect(r).toMatchObject({ ok: true, source: "plugin-data", version: HYPERFRAMES_VERSION });
    const o = hyperframesOptions({ CLAUDE_PLUGIN_DATA: data });
    // no pluginRoot override here: plugin-data still wins
    expect(o.resolution.ok).toBe(true);
    expect(o.producerInstalled?.()).toBe(true);
    const mod = (await o.loadProducer!()) as unknown as { marker: string };
    expect(mod.marker).toBe("fake");
  });

  it("falls back to the plugin root's node_modules (createRequire paths)", () => {
    const r = resolveHyperframesProducer({ CLAUDE_PLUGIN_DATA: join(tmp, "empty-data") }, { pluginRoot: join(tmp, "root") });
    expect(r).toMatchObject({ ok: true, source: "plugin-root", dir: join(tmp, "root", "node_modules", "@hyperframes", "producer") });
  });

  it("rejects a different version than the pinned one", async () => {
    await fakeProducer(join(tmp, "old", "node_modules"), "0.8.1");
    const r = resolveHyperframesProducer({ CLAUDE_PLUGIN_DATA: join(tmp, "empty-data") }, { pluginRoot: join(tmp, "old") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/0\.8\.1 found .* pins 0\.8\.75/);
  });

  it("finds the repo root as plugin root and documents the install command", () => {
    expect(findPluginRoot({})).toMatch(/plugin_knowledge_to_video$|[^/]+$/);
    expect(HYPERFRAMES_INSTALL_COMMAND).toBe('cd "${CLAUDE_PLUGIN_DATA}" && PUPPETEER_SKIP_DOWNLOAD=1 npm i @hyperframes/producer@0.8.78 --prefix deps');
  });
});

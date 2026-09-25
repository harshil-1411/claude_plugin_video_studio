/**
 * Golden-frame regression test for the committed examples: renders a tiny copy of each example
 * (180x320, 6 x 0.5 s = 3 s, 15 fps, silent voice, ffmpeg renderer, x264 ultrafast) and runs the
 * `test` tool's testProject against the golden frames committed in
 * tests/golden-frames/<example>/<quality>/.
 *
 * Gated because it renders: run with
 *   VS_TEST_GOLDEN=1 npx vitest run tests/golden-frames
 * and record (after looking at the frames by eye) with
 *   VS_TEST_GOLDEN=1 VS_UPDATE_GOLDEN=1 npx vitest run tests/golden-frames
 * Renders run one at a time.
 */
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatGolden, testProject } from "../../packages/mcp/src/golden.js";
import { renderProject } from "../../packages/mcp/src/pipeline.js";
import { createFfmpegRenderer } from "../../packages/renderer/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const RUN = process.env.VS_TEST_GOLDEN === "1";
const UPDATE = process.env.VS_UPDATE_GOLDEN === "1";
const T = 300_000;
const QUALITY = "preview" as const;
/** Each scene of the tiny copy lasts this long (the schema's hard minimum), so 6 scenes = 3 s. */
const SCENE_SEC = 0.5;

const EXAMPLES = ["text-to-motion-graphic"];

let tmp: string;
let env: Record<string, string | undefined>;

beforeAll(async () => {
  if (!RUN) return;
  tmp = await mkdtemp(join(tmpdir(), "vs-golden-frames-"));
  env = { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_PLUGIN_DATA: join(tmp, "data") };
});
afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

/** Copy the example's inputs (no renders) and shorten every scene so the render stays tiny. */
async function tinyCopy(name: string): Promise<string> {
  const src = join(REPO_ROOT, "examples", name);
  const dir = join(tmp, name);
  for (const sub of ["input", "source", "project"]) {
    if (existsSync(join(src, sub))) await cp(join(src, sub), join(dir, sub), { recursive: true });
  }
  if (existsSync(join(src, "brand.yaml"))) await cp(join(src, "brand.yaml"), join(dir, "brand.yaml"));
  const specPath = join(dir, "project", "video-spec.json");
  const spec = JSON.parse(await readFile(specPath, "utf8")) as { target_duration_sec: number; scenes: Array<{ duration_sec: number }> };
  for (const s of spec.scenes) s.duration_sec = SCENE_SEC;
  spec.target_duration_sec = spec.scenes.length * SCENE_SEC;
  await writeFile(specPath, JSON.stringify(spec, null, 2));
  return dir;
}

describe.skipIf(!RUN)("golden frames of the examples", () => {
  for (const name of EXAMPLES) {
    it(
      name,
      async () => {
        const dir = await tinyCopy(name);
        await renderProject(dir, {
          quality: QUALITY,
          voice: "silent",
          renderer: "ffmpeg",
          renderers: [createFfmpegRenderer({ encodePreset: "ultrafast" })],
          target: { shortSide: 180, fps: 15 },
          encodePreset: "ultrafast",
          env,
          voiceCacheDir: join(tmp, "voice-cache"),
        });

        const committed = join(here, name, QUALITY);
        const projectGolden = join(dir, "golden", QUALITY);
        if (UPDATE) {
          const r = await testProject(dir, { quality: QUALITY, update: true });
          expect(r.status, formatGolden(r)).toBe("updated");
          await rm(committed, { recursive: true, force: true });
          await mkdir(dirname(committed), { recursive: true });
          await cp(projectGolden, committed, { recursive: true });
          return;
        }
        if (existsSync(committed)) await cp(committed, projectGolden, { recursive: true });
        const r = await testProject(dir, { quality: QUALITY });
        if (r.status !== "pass") {
          // Keep the report and failing frames (outside the repo) where a human can look at them.
          const keep = join(tmpdir(), `vs-golden-failures-${name}`);
          await rm(keep, { recursive: true, force: true });
          if (existsSync(join(dir, "qa"))) await cp(join(dir, "qa"), keep, { recursive: true });
        }
        expect(r.status, `${formatGolden(r)}\nfailing frames copied to ${join(tmpdir(), `vs-golden-failures-${name}`)}\n(record with VS_TEST_GOLDEN=1 VS_UPDATE_GOLDEN=1 after checking the frames by eye)`).toBe("pass");
      },
      T,
    );
  }
});

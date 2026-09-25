import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFfmpeg } from "@video-studio/media";
import { GOLDEN_SSIM_THRESHOLD, formatGolden, sampleTimes, testProject } from "./golden.js";

// Fake rendered projects: a render-state plus a tiny lavfi reel (160x90, 2 s, 15 fps). No real render.
const T = 60_000;
let tmp: string;

const enc = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
const testsrc = (out: string) => runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=15:duration=2", ...enc, out]);
const mandel = (out: string) => runFfmpeg(["-y", "-f", "lavfi", "-i", "mandelbrot=size=160x90:rate=15", "-t", "2", ...enc, out]);

async function fakeProject(name: string, scenes = [{ scene_id: "s01", duration_ms: 1000 }, { scene_id: "s02", duration_ms: 1000 }]): Promise<string> {
  const dir = join(tmp, name);
  await mkdir(join(dir, "renders", "preview"), { recursive: true });
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(
    join(dir, "renders", "preview", "render-state.json"),
    JSON.stringify({ quality: "preview", spec_sha256: "a".repeat(64), target: { width: 160, height: 90, fps: 15 }, duration_ms: 2000, scenes }),
  );
  await testsrc(join(dir, "dist", "reel.mp4"));
  return dir;
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-golden-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("sampleTimes", () => {
  it("samples the first frame, each scene midpoint and the last frame at frame centres", () => {
    const s = sampleTimes({ duration_ms: 2000, fps: 15, scenes: [{ scene_id: "s01", duration_ms: 1000 }, { scene_id: "s02", duration_ms: 1000 }] });
    expect(s).toEqual([
      { label: "first", at_sec: 0.033 },
      { label: "s01", scene_id: "s01", at_sec: 0.5 },
      { label: "s02", scene_id: "s02", at_sec: 1.5 },
      { label: "last", at_sec: 1.9 },
    ]);
  });
  it("falls back to quartiles without scenes and merges samples closer than a frame", () => {
    expect(sampleTimes({ duration_ms: 1000, fps: 10 }).map((x) => x.label)).toEqual(["first", "p25", "p50", "p75", "last"]);
    expect(sampleTimes({ duration_ms: 100, fps: 10, scenes: [{ scene_id: "s01", duration_ms: 100 }] }).map((x) => x.label)).toEqual(["first"]);
  });
});

describe("testProject", () => {
  it(
    "reports missing goldens, records them, passes, then fails when the reel changes",
    async () => {
      const dir = await fakeProject("p1");

      const missing = await testProject(dir);
      expect(missing.status).toBe("missing");
      expect(missing.fix).toMatch(/by eye.*update: true/);
      expect(formatGolden(missing)).toContain("test missing");

      const rec = await testProject(dir, { update: true });
      expect(rec.status).toBe("updated");
      expect(rec.quality).toBe("preview");
      expect(rec.golden_dir).toBe("golden/preview");
      const files = (await readdir(join(dir, "golden", "preview"))).sort();
      expect(files).toEqual(["00-first.png", "01-s01.png", "02-s02.png", "03-last.png", "golden.json"]);
      const golden = JSON.parse(await readFile(join(dir, "golden", "preview", "golden.json"), "utf8"));
      expect(golden).toMatchObject({ quality: "preview", width: 160, threshold: GOLDEN_SSIM_THRESHOLD, spec_sha256: "a".repeat(64), target: { width: 160, height: 90, fps: 15 } });
      expect(golden.reel_sha256).toMatch(/^[0-9a-f]{64}$/);

      const pass = await testProject(dir, { quality: "preview" });
      expect(pass.status).toBe("pass");
      expect(pass.reel_identical).toBe(true);
      expect(pass.frames.every((f) => f.pass && (f.ssim ?? 0) >= GOLDEN_SSIM_THRESHOLD)).toBe(true);
      expect(existsSync(join(dir, "qa", "test-frames"))).toBe(false);
      const report = JSON.parse(await readFile(join(dir, "qa", "test.json"), "utf8"));
      expect(report.status).toBe("pass");
      expect(await readFile(join(dir, "qa", "test.md"), "utf8")).toContain("Status: **pass**");

      await mandel(join(dir, "dist", "reel.mp4"));
      const fail = await testProject(dir);
      expect(fail.status).toBe("fail");
      expect(fail.reel_identical).toBe(false);
      const bad = fail.frames.filter((f) => !f.pass);
      expect(bad.length).toBeGreaterThan(0);
      for (const f of bad) {
        expect(f.ssim).toBeLessThan(GOLDEN_SSIM_THRESHOLD);
        expect(existsSync(join(dir, f.actual!))).toBe(true);
        expect(existsSync(join(dir, f.diff!))).toBe(true);
        expect(f.diff).toMatch(/^qa\/test-frames\/\d\d-.+\.diff\.png$/);
      }
      expect(fail.fix).toMatch(/update: true/);
      expect(formatGolden(fail)).toMatch(/test fail/);
    },
    T,
  );

  it(
    "fails with a clear message when the sampled times change",
    async () => {
      const dir = await fakeProject("p2");
      await testProject(dir, { update: true });
      await writeFile(
        join(dir, "renders", "preview", "render-state.json"),
        JSON.stringify({ quality: "preview", target: { width: 160, height: 90, fps: 15 }, duration_ms: 2000, scenes: [{ scene_id: "s01", duration_ms: 2000 }] }),
      );
      const r = await testProject(dir);
      expect(r.status).toBe("fail");
      expect(r.message).toMatch(/sampled frames changed/);
      expect(r.fix).toMatch(/update: true/);
    },
    T,
  );

  it("errors when there is no render", async () => {
    const dir = join(tmp, "empty");
    await mkdir(dir, { recursive: true });
    await expect(testProject(dir)).rejects.toThrow(/no render found/);
  });
});

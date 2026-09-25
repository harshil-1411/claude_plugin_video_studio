import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFfmpeg } from "@video-studio/media";
import { VideoLock } from "@video-studio/schema";
import { diffJson, diffProjects, formatDiff } from "./diff.js";

// Fake rendered projects: hand-written spec + render-state and tiny lavfi reels (160x90, 2 s, 15 fps). No real render.
const T = 60_000;
let tmp: string;
let reelTest: string;
let reelMandel: string;

const enc = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];

const baseSpec = {
  schema_version: "1.0",
  id: "tiny",
  title: "Tiny",
  scenes: [
    { id: "s01", duration_sec: 1, voiceover: "Search finds words.", deterministic: { kind: "typography", props: { lines: ["Search finds words"] } } },
    { id: "s02", duration_sec: 1, voiceover: "Vectors find meaning.", deterministic: { kind: "cta", props: { headline: "Try it" } } },
  ],
};

async function fakeProject(name: string, opts: { reel: string; spec?: unknown; quality?: "preview" | "final" }): Promise<string> {
  const dir = join(tmp, name);
  const q = opts.quality ?? "preview";
  await mkdir(join(dir, "renders", q), { recursive: true });
  await mkdir(join(dir, "project"), { recursive: true });
  await writeFile(join(dir, "project", "video-spec.json"), JSON.stringify(opts.spec ?? baseSpec, null, 2));
  await writeFile(
    join(dir, "renders", q, "render-state.json"),
    JSON.stringify({
      quality: q,
      target: { width: 160, height: 90, fps: 15 },
      duration_ms: 2000,
      reel: `renders/${q}/reel.mp4`,
      scenes: [
        { scene_id: "s01", duration_ms: 1000 },
        { scene_id: "s02", duration_ms: 1000 },
      ],
    }),
  );
  await copyFile(opts.reel, join(dir, "renders", q, "reel.mp4"));
  await writeFile(join(dir, "renders", "latest.json"), JSON.stringify({ quality: q }));
  return dir;
}

const sha = (c: string) => c.repeat(64);
function lock(overrides: Partial<VideoLock> = {}): VideoLock {
  return VideoLock.parse({
    schema_version: "1.0",
    project_id: "tiny",
    quality: "preview",
    spec_sha256: sha("a"),
    engine: { engine: "0.1.0", assembly: "2" },
    tools: { ffmpeg: "8.1.2", "ffmpeg-drawtext": "0.2.0" },
    voice: { backend: "silent", request_hash: sha("b") },
    fonts: [{ family: "Inter", weight: 700, file: "fonts/inter/Inter-Bold.ttf", sha256: sha("c") }],
    targets: [{ id: "youtube-shorts", contract_version: 1, verified: "2026-09-25" }],
    scenes: [{ scene_id: "s01", renderer: "ffmpeg-drawtext", renderer_version: "0.2.0", cache_key: sha("d"), clip_sha256: sha("e") }],
    assets: [],
    outputs: [{ path: "dist/reel.mp4", sha256: sha("f") }],
    ...overrides,
  });
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-diff-"));
  reelTest = join(tmp, "testsrc.mp4");
  reelMandel = join(tmp, "mandel.mp4");
  await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=15:duration=2", ...enc, reelTest]);
  await runFfmpeg(["-y", "-f", "lavfi", "-i", "mandelbrot=size=160x90:rate=15", "-t", "2", ...enc, reelMandel]);
}, T);
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("diffJson", () => {
  it("matches id-keyed arrays by id and reports added, removed, changed and reordered", () => {
    const b = {
      ...baseSpec,
      title: "Tiny v2",
      scenes: [{ ...baseSpec.scenes[1]!, voiceover: "Vectors find meaning fast." }, baseSpec.scenes[0]!, { id: "s03", duration_sec: 1, voiceover: "Bye." }],
    };
    const changes = diffJson(baseSpec, b);
    expect(changes).toEqual(
      expect.arrayContaining([
        { kind: "changed", path: "title", before: '"Tiny"', after: '"Tiny v2"' },
        { kind: "changed", path: "scenes[s02].voiceover", before: '"Vectors find meaning."', after: '"Vectors find meaning fast."' },
        { kind: "added", path: "scenes[s03]", after: expect.stringContaining('"id":"s03"') },
        { kind: "reordered", path: "scenes", before: '["s01","s02"]', after: '["s02","s01"]' },
      ]),
    );
    expect(diffJson(baseSpec, structuredClone(baseSpec))).toEqual([]);
  });
  it("truncates long values and diffs primitive arrays as a whole", () => {
    const [c] = diffJson({ a: "x".repeat(500) }, { a: "y" });
    expect(c!.before!.length).toBeLessThanOrEqual(120);
    expect(c!.before!.endsWith("…")).toBe(true);
    expect(diffJson({ t: ["a", "b"] }, { t: ["a", "c"] })).toEqual([{ kind: "changed", path: "t", before: '["a","b"]', after: '["a","c"]' }]);
  });
});

describe("diffProjects", () => {
  it(
    "reports identical renders; a missing lock is skipped, not a failure",
    async () => {
      const a = await fakeProject("same-a", { reel: reelTest });
      const b = await fakeProject("same-b", { reel: reelTest });
      const r = await diffProjects(a, b);
      expect(r.identical).toBe(true);
      expect(r.spec).toMatchObject({ compared: true, changes: [] });
      expect(r.lock.compared).toBe(false);
      expect(r.lock.reason).toMatch(/no dist\/video\.lock/);
      expect(r.frames.compared).toBe(true);
      expect(r.frames.samples.map((f) => f.label)).toEqual(["first", "s01", "s02", "last"]);
      expect(r.frames.samples.every((f) => f.pass && f.ssim! > 0.99)).toBe(true);
      expect(existsSync(join(b, "qa", "diff.json"))).toBe(true);
      expect(await readFile(join(b, "qa", "diff.md"), "utf8")).toContain("Identical: **yes**");
      expect(existsSync(join(a, "qa", "diff.json"))).toBe(false);
      expect(formatDiff(r)).toMatch(/^diff: identical/);
    },
    T,
  );

  it(
    "reports spec changes and flags differing frames with a side-by-side image",
    async () => {
      const a = await fakeProject("chg-a", { reel: reelTest });
      const specB = { ...baseSpec, scenes: [baseSpec.scenes[0]!, { ...baseSpec.scenes[1]!, voiceover: "Vectors find meaning fast." }, { id: "s03", duration_sec: 1 }] };
      const b = await fakeProject("chg-b", { reel: reelMandel, spec: specB });
      const r = await diffProjects(a, b);
      expect(r.identical).toBe(false);
      expect(r.spec.scenes_added).toEqual(["s03"]);
      expect(r.spec.scenes_changed).toEqual(["s02"]);
      const flagged = r.frames.samples.filter((f) => !f.pass);
      expect(flagged.length).toBeGreaterThan(0);
      for (const f of flagged) {
        expect(f.image).toMatch(/^qa\/diff-frames\/\d\d-.+\.png$/);
        expect(existsSync(join(b, f.image!))).toBe(true);
      }
      const md = await readFile(join(b, "qa", "diff.md"), "utf8");
      expect(md).toContain("scenes[s02].voiceover");
      expect(md).toContain("DIFFERS");
      expect(formatDiff(r)).toMatch(/added s03/);
    },
    T,
  );

  it(
    "compares preview and final of the same folder",
    async () => {
      const dir = await fakeProject("pf", { reel: reelTest, quality: "preview" });
      await mkdir(join(dir, "renders", "final"), { recursive: true });
      const st = JSON.parse(await readFile(join(dir, "renders", "preview", "render-state.json"), "utf8"));
      await writeFile(join(dir, "renders", "final", "render-state.json"), JSON.stringify({ ...st, quality: "final", reel: "renders/final/reel.mp4" }));
      await copyFile(reelMandel, join(dir, "renders", "final", "reel.mp4"));
      const r = await diffProjects(dir, dir, { quality_a: "preview", quality_b: "final" });
      expect(r.a).toMatchObject({ quality: "preview", reel: "renders/preview/reel.mp4" });
      expect(r.b).toMatchObject({ quality: "final", reel: "renders/final/reel.mp4" });
      expect(r.spec.changes).toEqual([]);
      expect(r.identical).toBe(false);
    },
    T,
  );

  // Needs the real readLock/diffLocks from lock.ts.
  it(
    "classifies a video.lock change",
    async () => {
      const a = await fakeProject("lock-a", { reel: reelTest });
      const b = await fakeProject("lock-b", { reel: reelTest });
      await mkdir(join(a, "dist"), { recursive: true });
      await mkdir(join(b, "dist"), { recursive: true });
      await writeFile(join(a, "dist", "video.lock"), `${JSON.stringify(lock(), null, 2)}\n`);
      await writeFile(join(b, "dist", "video.lock"), `${JSON.stringify(lock({ tools: { ffmpeg: "8.2.0", "ffmpeg-drawtext": "0.2.0" } }), null, 2)}\n`);
      const r = await diffProjects(a, b);
      expect(r.lock.compared).toBe(true);
      expect(r.lock.changes).toEqual([expect.objectContaining({ class: "renderer", path: "tools.ffmpeg", before: "8.1.2", after: "8.2.0" })]);
      expect(r.identical).toBe(false);
      expect(formatDiff(r)).toMatch(/lock: 1 change\(s\) \(renderer\)/);
    },
    T,
  );
});

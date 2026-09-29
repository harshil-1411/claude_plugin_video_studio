import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg } from "@video-studio/media";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareVideos, formatCompare, metricRows } from "./compare.js";

let dir: string;
let other: string;

async function clip(path: string, size: string, dur: number, color: string): Promise<void> {
  await runFfmpeg(["-y", "-f", "lavfi", "-i", `color=c=${color}:s=${size}:r=15:d=${dur}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path]);
}

async function render(root: string, quality: "preview" | "final", size: string, dur: number, color: string): Promise<void> {
  const rdir = join(root, "renders", quality);
  await mkdir(rdir, { recursive: true });
  await clip(join(rdir, "reel.mp4"), size, dur, color);
  const [w, h] = size.split("x").map(Number);
  await writeFile(
    join(rdir, "render-state.json"),
    JSON.stringify({ quality, reel: `renders/${quality}/reel.mp4`, target: { width: w, height: h, fps: 15 }, duration_ms: dur * 1000, scenes: [{ scene_id: "s01", duration_ms: dur * 1000 }] }),
  );
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vs-compare-"));
  other = await mkdtemp(join(tmpdir(), "vs-compare-other-"));
  await render(dir, "preview", "90x160", 2, "red");
  await render(dir, "final", "180x320", 1.5, "blue");
  await render(other, "preview", "90x160", 1, "green");
  await mkdir(join(dir, "assets", "supplied"), { recursive: true });
  await clip(join(dir, "assets", "supplied", "talk.mp4"), "160x90", 2, "gray");
  await clip(join(dir, "assets", "supplied", "talk-tight.mp4"), "160x90", 1.2, "white");
  // A lively reference: a new flat colour every 0.5 s (5 cuts in 3 s), with a tone.
  const colours = ["red", "blue", "green", "white", "black", "yellow"];
  const graph = colours.map((c, i) => `color=c=${c}:s=90x160:r=15:d=0.5[c${i}]`).join(";") + `;${colours.map((_, i) => `[c${i}]`).join("")}concat=n=6`;
  await mkdir(join(dir, "ref"), { recursive: true });
  await runFfmpeg(["-y", "-f", "lavfi", "-i", graph, "-f", "lavfi", "-i", "sine=f=440:d=3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(dir, "ref", "lively.mp4")]);
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(other, { recursive: true, force: true });
});

describe("compare", () => {
  it("default: preview against final, as a self-contained page", async () => {
    const r = await compareVideos(dir);
    expect(r.html_rel).toBe(join("qa", "compare", "index.html"));
    expect((await readdir(r.dir)).sort()).toEqual(["a.mp4", "b.mp4", "index.html"]);
    expect(r.a).toMatchObject({ label: "preview", width: 90, height: 160, source: "renders/preview", has_audio: false });
    expect(r.b).toMatchObject({ label: "final", width: 180, height: 320 });
    expect(r.a.duration_sec).toBeCloseTo(2, 1);
    expect(r.b.duration_sec).toBeCloseTo(1.5, 1);
    expect(r.notes).toEqual([expect.stringMatching(/durations differ/)]);
    const html = await readFile(r.html, "utf8");
    // No network: no absolute URLs at all, no external scripts or stylesheets.
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<link\b|<script[^>]+src=/);
    expect(html).toMatch(/src="a\.mp4"/);
    expect(html).toMatch(/src="b\.mp4"/);
    for (const text of ["preview", "final", "Side by side", "Stacked", "Wipe", 'data-mode="side"', 'data-mode="stacked"', 'data-mode="wipe"', "prefers-color-scheme: dark", 'name="viewport"']) {
      expect(html).toContain(text);
    }
    // A is muted by default; B plays sound.
    expect(html).toMatch(/<video id="va"[^>]* muted>/);
    expect(html).not.toMatch(/<video id="vb"[^>]* muted>/);
    expect(formatCompare(r)).toMatch(/give the user this path to open/);
  }, 60_000);

  it("files in the project and another project's render, with labels", async () => {
    const r = await compareVideos(dir, { a: { file: "assets/supplied/talk.mp4", label: "Original <raw>" }, b: { file: "assets/supplied/talk-tight.mp4" } });
    expect(r.a.label).toBe("Original <raw>");
    expect(r.b).toMatchObject({ label: "talk-tight.mp4", source: "assets/supplied/talk-tight.mp4", width: 160, height: 90 });
    const html = await readFile(r.html, "utf8");
    expect(html).toContain("Original &lt;raw&gt;");
    expect(html).not.toContain("<raw>");

    const v = await compareVideos(dir, { a: { quality: "final" }, b: { project_dir: other, quality: "preview", label: "variant" } });
    expect(v.b).toMatchObject({ label: "variant", width: 90 });
    expect(v.b.source).toMatch(/renders\/preview$/);
    expect(existsSync(v.b.copy)).toBe(true);
  }, 60_000);

  it("explains a missing render, a missing file and a file outside the project", async () => {
    await expect(compareVideos(other)).rejects.toThrow(/only a preview render exists.*Pass a and b/);
    await expect(compareVideos(other, { a: { quality: "preview" }, b: { quality: "final" } })).rejects.toThrow(/b: .*no final reel found/);
    await expect(compareVideos(dir, { a: { file: "assets/supplied/nope.mp4" }, b: { quality: "final" } })).rejects.toThrow(/a\.file "assets\/supplied\/nope\.mp4" not found/);
    await expect(compareVideos(dir, { a: { quality: "preview" }, b: { file: "../elsewhere.mp4" } })).rejects.toThrow(/outside the project/);
    await expect(compareVideos(dir, { a: { quality: "preview" }, b: { file: join(other, "renders", "preview", "reel.mp4") } })).rejects.toThrow(/outside the project/);
    await symlink(join(other, "renders", "preview", "reel.mp4"), join(dir, "assets", "supplied", "link.mp4"));
    await expect(compareVideos(dir, { a: { quality: "preview" }, b: { file: "assets/supplied/link.mp4" } })).rejects.toThrow(/resolves outside the project/);
  }, 60_000);

  it("a reference side: metrics for both, and a verdict per metric for ours", async () => {
    // b defaults to this project's latest render when a is the reference.
    const r = await compareVideos(dir, { a: { quality: "preview" }, b: { reference: "ref/lively.mp4" } });
    expect(r.b).toMatchObject({ label: "reference (lively.mp4)", reference: true, has_audio: true });
    expect(r.b.metrics).toMatchObject({ cuts_per_sec: expect.closeTo(5 / 3, 1), changes_per_sec: expect.closeTo(5 / 3, 1), frozen_pct: 0 });
    expect(r.b.metrics!.integrated_lufs).not.toBeNull();
    expect(r.a.metrics).toMatchObject({ changes_per_sec: 0, integrated_lufs: null });
    expect(r.a.metrics!.frozen_pct).toBeGreaterThan(50);
    const row = (id: string) => r.metrics.find((m) => m.id === id)!;
    expect(row("changes_per_sec")).toMatchObject({ meets: false, verdict: expect.stringMatching(/^misses: fewer big changes/) });
    expect(row("cuts_per_sec")).toMatchObject({ meets: false });
    expect(row("frozen_pct")).toMatchObject({ meets: false, verdict: expect.stringMatching(/more frozen/) });
    expect(row("longest_static_sec")).toMatchObject({ meets: false });
    // Still preview vs a lively reference: the picture sits still more of the time.
    expect(r.a.metrics!.moving_pct).toBeLessThan(r.b.metrics!.moving_pct!);
    expect(row("moving_pct")).toMatchObject({ meets: false, verdict: expect.stringMatching(/^misses: the picture sits still/) });
    expect(row("duration_sec")).toMatchObject({ meets: false, verdict: expect.stringMatching(/shorter than the reference/) });
    expect(row("integrated_lufs")).toMatchObject({ meets: null });
    const html = await readFile(r.html, "utf8");
    expect(html).toContain("Ours vs the reference");
    expect(html).toContain("Big changes per second");
    expect(html).toContain("Moving (% of frames)");
    expect(html).toMatch(/class="misses">misses: fewer big changes/);
    expect(formatCompare(r)).toMatch(/Cuts per second: a 0, b 1\.\d+; misses/);

    // An absolute path the user passes is allowed; a relative one is confined to the project.
    const abs = await compareVideos(other, { a: { reference: join(dir, "ref", "lively.mp4") } });
    expect(abs.a.reference).toBe(true);
    expect(abs.b.label).toBe("preview");
    await expect(compareVideos(dir, { a: { quality: "preview" }, b: { reference: "../nope.mp4" } })).rejects.toThrow(/b\.reference "\.\.\/nope\.mp4" is outside the project/);
    await expect(compareVideos(dir, { a: { reference: join(dir, "ref", "missing.mp4") } })).rejects.toThrow(/a\.reference .* not found/);
    await expect(compareVideos(dir, { a: { reference: "ref/lively.mp4" }, b: { reference: "ref/lively.mp4" } })).rejects.toThrow(/both sides are references/);
  }, 60_000);

  it("verdicts compare ours against the reference with tolerances; no verdict without one", () => {
    const m = { duration_sec: 10, frozen_sec: 0.5, frozen_pct: 5, changes_per_sec: 1, cuts_per_sec: 0.5, moving_pct: 60, longest_static_sec: 2, integrated_lufs: -14 };
    const ours = { metrics: { ...m, duration_sec: 10.5, frozen_pct: 6, changes_per_sec: 0.95, moving_pct: 56, integrated_lufs: -15 } };
    const rows = metricRows(ours, { metrics: m, reference: true });
    expect(rows.every((x) => x.meets === true)).toBe(true);
    expect(metricRows({ metrics: m }, { metrics: m }).every((x) => x.meets === null && x.verdict === "")).toBe(true);
    const still = metricRows({ metrics: { ...m, moving_pct: 50 } }, { metrics: m, reference: true }).find((x) => x.id === "moving_pct")!;
    expect(still).toMatchObject({ meets: false, a: 50, b: 60 });
    // An older analysis without the moving share: not measurable.
    expect(metricRows({ metrics: { ...m, moving_pct: null } }, { metrics: m, reference: true }).find((x) => x.id === "moving_pct")!.meets).toBeNull();
  });
});

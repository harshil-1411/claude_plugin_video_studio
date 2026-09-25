import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextBox } from "@video-studio/schema";
import { describe, expect, it } from "vitest";
import { contrastRatio, lintProject } from "./lint.js";

const FIXTURE = join(import.meta.dirname, "__fixtures__", "lint", "tiktok-low-captions");

/** Copy the fixture project to a temp dir, optionally editing its spec. */
function project(edit?: (spec: Record<string, any>) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "vs-lint-"));
  cpSync(FIXTURE, dir, { recursive: true });
  if (edit) {
    const p = join(dir, "project", "video-spec.json");
    const spec = JSON.parse(readFileSync(p, "utf8"));
    edit(spec);
    writeFileSync(p, JSON.stringify(spec, null, 2));
  }
  return dir;
}

function writeState(dir: string, state: Record<string, unknown>, quality = "final"): void {
  mkdirSync(join(dir, "renders", quality), { recursive: true });
  writeFileSync(join(dir, "renders", quality, "render-state.json"), JSON.stringify({ quality, ...state }));
}

const box = (over: Partial<TextBox>): TextBox => ({
  role: "headline",
  text: "Hello",
  rect: { x: 100, y: 300, w: 800, h: 200 },
  font_px: 90,
  truncated: false,
  color: "#F5F7FA",
  background: "#0B0F19",
  ...over,
});

describe("lint golden: captions under the TikTok UI", () => {
  it("fails when captions.position.y 0.9 puts captions under TikTok's footer", async () => {
    const dir = project();
    const r = await lintProject(dir);
    const mask = r.findings.filter((f) => f.id === "caption_mask");
    expect(mask).toEqual([
      expect.objectContaining({ severity: "error", target: "tiktok", fix: expect.stringMatching(/^remove captions\.position \(auto placement.*\) or set y ≤ 0\.\d+$/) }),
    ]);
    expect(r.status).toBe("fail");
    expect(r.rendered).toBe(false);
    // The suggested y really clears the mask.
    const y = Number(/y ≤ (0\.\d+)/.exec(mask[0]!.fix)![1]);
    const fixed = await lintProject(project((s) => (s.captions.position.y = y)));
    expect(fixed.findings.filter((f) => f.id === "caption_mask")).toEqual([]);
    const report = JSON.parse(readFileSync(join(dir, "qa", "lint.json"), "utf8"));
    expect(report.findings).toEqual(r.findings);
    expect(readFileSync(join(dir, "qa", "lint.md"), "utf8")).toMatch(/# Lint: fail/);
  });

  it("passes the mask check with automatic caption placement", async () => {
    const r = await lintProject(project((s) => delete s.captions.position));
    expect(r.findings.filter((f) => f.id === "caption_mask" || f.id === "text_mask")).toEqual([]);
    expect(r.findings.filter((f) => f.severity === "error")).toEqual([]);
  });
});

describe("lint checks", () => {
  it("checks envelopes against every target contract", async () => {
    const r = await lintProject(
      project((s) => {
        s.targets = ["facebook-page-api", "youtube-shorts", "nope"];
        s.master = { width: 360, height: 640, fps: 30 };
        s.scenes[0].duration_sec = 100;
        s.scenes[1].duration_sec = 100;
        delete s.captions.position;
        s.publish = {};
      }),
    );
    const ids = r.findings.map((f) => `${f.id}:${f.target ?? ""}`);
    expect(ids).toContain("target_unknown:nope");
    expect(ids).toContain("envelope_duration:facebook-page-api");
    expect(ids).toContain("envelope_duration:youtube-shorts");
    expect(ids).toContain("envelope_size:facebook-page-api");
    expect(r.findings.find((f) => f.id === "envelope_size")!.fix).toMatch(/1080x1920/);
    const aspect = await lintProject(project((s) => ((s.aspect_ratio = "16:9"), (s.targets = ["youtube-shorts"]), delete s.captions.position)));
    expect(aspect.findings.map((f) => f.id)).toContain("envelope_aspect");
  });

  it("reads text boxes from the render: overflow, masks and contrast", async () => {
    const dir = project((s) => delete s.captions.position);
    writeState(dir, {
      target: { width: 1080, height: 1920, fps: 30, aspect_ratio: "9:16" },
      duration_ms: 8000,
      burn_in: true,
      scenes: [
        { scene_id: "s01", text_boxes: [box({ role: "hook", truncated: true }), box({ role: "decorative", truncated: true, text: "tiny" })] },
        {
          scene_id: "s02",
          text_boxes: [
            box({ role: "cta", rect: { x: 100, y: 1600, w: 800, h: 100 } }),
            box({ role: "body", font_px: 30, color: "#777777", background: "#666666" }),
            box({ role: "label", font_px: 100, color: "#949494", background: "#FFFFFF" }),
          ],
        },
      ],
    });
    const r = await lintProject(dir);
    expect(r.rendered).toBe(true);
    const by = (id: string) => r.findings.filter((f) => f.id === id);
    expect(by("text_overflow").map((f) => [f.scene_id, f.severity])).toEqual([
      ["s01", "error"],
      ["s01", "warning"],
    ]);
    expect(by("text_mask")).toEqual([expect.objectContaining({ severity: "error", target: "tiktok", scene_id: "s02" })]);
    // body at 30px is normal text (needs 4.5:1); the 100px label is large (3:1; #949494 on white is ~3.03).
    expect(by("contrast")).toEqual([expect.objectContaining({ severity: "warning", scene_id: "s02", message: expect.stringMatching(/needs 4\.5:1/) })]);
  });

  it("uses the rendered caption box from the manifest of the same quality", async () => {
    const dir = project((s) => delete s.captions.position);
    writeState(dir, { target: { width: 1080, height: 1920, fps: 30, aspect_ratio: "9:16" }, duration_ms: 8000, burn_in: true, scenes: [] });
    mkdirSync(join(dir, "dist"), { recursive: true });
    const manifest = { settings: { quality: "final", width: 1080, height: 1920 }, captions: { burn_in: true, box: { x: 90, y: 1600, w: 900, h: 200 } } };
    writeFileSync(join(dir, "dist", "render-manifest.json"), JSON.stringify(manifest));
    const r = await lintProject(dir);
    expect(r.findings.filter((f) => f.id === "caption_mask")).toEqual([expect.objectContaining({ severity: "error", fix: expect.stringMatching(/re-render/) })]);
    // A preview lint ignores the final manifest.
    writeState(dir, { target: { width: 540, height: 960, fps: 15, aspect_ratio: "9:16" }, duration_ms: 8000, burn_in: true, scenes: [] }, "preview");
    expect((await lintProject(dir, { quality: "preview" })).findings.filter((f) => f.id === "caption_mask")).toEqual([]);
  });

  it("warns on reading density, post copy limits, cover and banned phrases", async () => {
    const dir = project((s) => {
      delete s.captions.position;
      s.scenes[0].voiceover = "one two three four five six seven eight nine ten eleven twelve";
      s.publish.tiktok.post_caption = "x".repeat(2300);
      s.cover.headline = "A very long cover headline that keeps going on and on";
    });
    writeFileSync(join(dir, "brand.yaml"), "version: 2\nbrand: { name: Acme }\nvoice: { personality: [plain], avoid: [], banned_phrases: [\"safe zone\"] }\n");
    const r = await lintProject(dir);
    const ids = r.findings.map((f) => f.id);
    expect(r.findings.find((f) => f.id === "reading_density")).toMatchObject({ severity: "warning", scene_id: "s01", fix: expect.stringMatching(/at most 9 words/) });
    expect(r.findings.find((f) => f.id === "post_caption_length")).toMatchObject({ severity: "error", target: "tiktok" });
    expect(ids).toContain("cover_headline");
    expect(r.findings.find((f) => f.id === "brand_banned_phrase")).toMatchObject({ severity: "error", scene_id: "s02", message: expect.stringMatching(/voiceover/) });
    const noCover = await lintProject(project((s) => (delete s.cover, delete s.captions.position)));
    expect(noCover.findings.map((f) => f.id)).toContain("cover_missing");
  });

  it("checks the compiled cover headline against every crop", async () => {
    const dir = project((s) => delete s.captions.position);
    const square = { id: "square-preview", targets: ["instagram"], x: 0, y: 420, w: 1080, h: 1080 };
    const state = (rect: TextBox["rect"], truncated = false) => ({
      target: { width: 1080, height: 1920, fps: 30, aspect_ratio: "9:16" },
      duration_ms: 8000,
      burn_in: true,
      scenes: [],
      cover: { headline_box: box({ role: "headline", rect, truncated }), crops: [square] },
    });
    writeState(dir, state({ x: 90, y: 200, w: 900, h: 300 }, true));
    const bad = (await lintProject(dir)).findings.filter((f) => f.id.startsWith("cover_"));
    expect(bad.map((f) => [f.id, f.severity])).toEqual([
      ["cover_overflow", "error"],
      ["cover_crop", "error"],
    ]);
    expect(bad[1]).toMatchObject({ target: "instagram", message: expect.stringMatching(/"square-preview" crop/) });
    writeState(dir, state({ x: 90, y: 700, w: 900, h: 300 }));
    expect((await lintProject(dir)).findings.filter((f) => f.id.startsWith("cover_"))).toEqual([]);
  });

  it("computes WCAG contrast", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
  });
});

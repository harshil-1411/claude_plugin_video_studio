import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scene, VideoSpec } from "@video-studio/schema";
import { describe, expect, it } from "vitest";
import { type LintFinding, checkBannedEffect, checkRevealPace, lintProject } from "./lint.js";

const LINT_FIXTURE = join(import.meta.dirname, "__fixtures__", "lint", "tiktok-low-captions");
const EIGHT = "Every render is cached by its scene hash";

const scene = (id: string, duration: number, det: Scene["deterministic"], extra: Partial<Scene> = {}): Scene => ({
  id,
  duration_sec: duration,
  purpose: "point",
  voiceover: "",
  visual_strategy: "motion_graphic",
  deterministic: det,
  visual_requirements: { continuity_refs: [] },
  claim_refs: [],
  ...extra,
});
const specOf = (scenes: Scene[], beatSync = false) => ({ scenes, ...(beatSync ? { audio: { beat_sync: { enabled: true } } } : {}) }) as unknown as VideoSpec;

/** A project dir with motion pages: good.html reads vs.revealAt, bad.html does not. */
function pages(): string {
  const root = mkdtempSync(join(tmpdir(), "vs-lint-reveal-"));
  mkdirSync(join(root, "motion"));
  writeFileSync(join(root, "motion", "bad.html"), "<p id=a></p><script>window.seek = function (t) { var i = vs.beatIndex(t); document.getElementById('a').textContent = window.__vs.text[Math.max(0, i) % 2]; };</script>");
  writeFileSync(join(root, "motion", "good.html"), '<p id=a></p><script src="good.js"></script>');
  writeFileSync(join(root, "motion", "good.js"), "window.seek = function (t) { var i = t >= vs.revealAt(1) ? 1 : 0; document.getElementById('a').textContent = window.__vs.text[i]; };");
  return root;
}
const motion = (id: string, duration: number, html: string, text: string[]) => scene(id, duration, { kind: "motion", props: { html, text } });
const run = async (root: string, spec: VideoSpec, state?: Parameters<typeof checkRevealPace>[2]) => {
  const out: LintFinding[] = [];
  await checkRevealPace(root, spec, state, out);
  return out.filter((f) => f.id === "reveal_too_fast");
};

describe("lint reveal_too_fast: motion pages", () => {
  it("leaves a page that times its own copy to stills and review, even when short", async () => {
    // Several labels on screen together (a UI morph) are not read one after another.
    expect(await run(pages(), specOf([motion("s01", 3, "motion/bad.html", [EIGHT, EIGHT])]))).toEqual([]);
  });

  it("good: the page reads vs.revealAt (in a script file); one item never needs it", async () => {
    const root = pages();
    expect(await run(root, specOf([motion("s01", 4, "motion/good.html", ["Docs in.", "Video out."])]))).toEqual([]);
    expect(await run(root, specOf([motion("s01", 4, "motion/bad.html", ["Docs in."])]))).toEqual([]);
  });

  it("bad: too short for its items' floors, even with vs.revealAt", async () => {
    const f = await run(pages(), specOf([motion("s01", 3, "motion/good.html", [EIGHT, EIGHT])]));
    expect(f).toEqual([expect.objectContaining({ message: expect.stringMatching(/need about 5\.7s/), fix: expect.stringMatching(/at least 5\.7/) })]);
  });
});

describe("lint reveal_too_fast: deterministic kinds", () => {
  const typo = (lines: string[], duration = 6) => scene("s01", duration, { kind: "typography", props: { lines } });
  const state = (cues: Array<[number, number]>, duration = 6000) => ({
    scenes: [{ scene_id: "s01", duration_ms: duration }],
    cues: cues.map(([item, at]) => ({ scene_id: "s01", word: "w", item, at_ms: at, status: "placed" })),
  });

  it("bad: word cues half a second apart", async () => {
    const f = await run(pages(), specOf([typo(["Docs in.", "Video out.", "Ship."])]), state([[0, 500], [1, 1000], [2, 1500]]));
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toMatch(/item 0 "Docs in\." is readable for 0\.1s of its 0\.8s; item 1/);
  });

  it("good: word cues far enough apart, or on items that are not consecutive", async () => {
    expect(await run(pages(), specOf([typo(["Docs in.", "Video out.", "Ship."])]), state([[0, 500], [1, 1800], [2, 3100]]))).toEqual([]);
    expect(await run(pages(), specOf([typo(["Docs in.", "Video out.", "Ship."])]), state([[0, 500], [2, 1000]]))).toEqual([]);
    // Kinds whose items are not reading lines are not checked.
    const cta = scene("s01", 6, { kind: "cta", props: { headline: "Try it", action: "Install" } });
    expect(await run(pages(), specOf([cta]), state([[0, 500], [1, 600]]))).toEqual([]);
  });

  const beatState = (duration: number) => ({
    scenes: [{ scene_id: "s01", duration_ms: duration * 1000 }],
    beat_sync: { bpm: 120, beat_times_ms: Array.from({ length: duration * 2 }, (_, i) => i * 500) },
  });

  it("bad: beat sync on and the scene too short for the readable schedule", async () => {
    const f = await run(pages(), specOf([typo([EIGHT, EIGHT, EIGHT], 3)], true), beatState(3));
    expect(f).toEqual([expect.objectContaining({ message: expect.stringMatching(/need about 8\.4s to be read one after another on the beat/) })]);
  });

  it("good: long enough, or beat sync off, or a grid-only grid", async () => {
    expect(await run(pages(), specOf([typo([EIGHT, EIGHT, EIGHT], 9)], true), beatState(9))).toEqual([]);
    expect(await run(pages(), specOf([typo([EIGHT, EIGHT, EIGHT], 3)], false), beatState(3))).toEqual([]);
    const gridOnly = { ...beatState(3), beat_sync: { ...beatState(3).beat_sync, grid_only: true } };
    expect(await run(pages(), specOf([typo([EIGHT, EIGHT, EIGHT], 3)], true), gridOnly)).toEqual([]);
  });
});

describe("lint reveal_too_fast: in lintProject", () => {
  it("reports a scheduled motion page too short for its lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-lint-reveal-proj-"));
    cpSync(LINT_FIXTURE, dir, { recursive: true });
    cpSync(join(pages(), "motion"), join(dir, "motion"), { recursive: true });
    const p = join(dir, "project", "video-spec.json");
    const spec = JSON.parse(readFileSync(p, "utf8"));
    spec.scenes[0].deterministic = { kind: "motion", props: { html: "motion/good.html", text: [EIGHT, EIGHT, EIGHT, EIGHT] } };
    writeFileSync(p, JSON.stringify(spec, null, 2));
    const r = await lintProject(dir);
    expect(r.findings.filter((f) => f.id === "reveal_too_fast").map((f) => f.scene_id)).toContain("s01");
  });
});

describe("banned effect eq_bars", () => {
  it("flows through banned_effect like the other declared effects", () => {
    const s = scene("s01", 4, { kind: "motion", props: { html: "motion/a.html", text: ["Beat."], effects: ["eq_bars"] } });
    const out: LintFinding[] = [];
    checkBannedEffect(specOf([s]), { id: "minimal", avoid: ["eq_bars"] }, undefined, out);
    expect(out).toEqual([expect.objectContaining({ id: "banned_effect", severity: "error", scene_id: "s01", message: expect.stringMatching(/"eq_bars"/) })]);
    const none: LintFinding[] = [];
    checkBannedEffect(specOf([s]), { id: "energetic", avoid: ["shake"] }, undefined, none);
    expect(none).toEqual([]);
  });
});

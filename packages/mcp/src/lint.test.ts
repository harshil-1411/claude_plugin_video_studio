import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextBox } from "@video-studio/schema";
import { describe, expect, it } from "vitest";
import { type LintFinding, checkCues, contrastRatio, lintProject } from "./lint.js";

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

  it("prefers the render state's caption box over a stale manifest (lint during export)", async () => {
    const dir = project((s) => delete s.captions.position);
    // The previous export put captions under the footer mask; the new render moved them up.
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "render-manifest.json"), JSON.stringify({ settings: { quality: "final", width: 1080, height: 1920 }, captions: { burn_in: true, box: { x: 90, y: 1600, w: 900, h: 200 } } }));
    writeState(dir, { target: { width: 1080, height: 1920, fps: 30, aspect_ratio: "9:16" }, duration_ms: 8000, burn_in: true, scenes: [], caption_layout: { box: { x: 90, y: 1200, w: 800, h: 200 }, max_lines: 2, font_size: 60 } });
    expect((await lintProject(dir)).findings.filter((f) => f.id === "caption_mask")).toEqual([]);
  });

  it("without narration, checks on-screen reading speed instead of voiceover", async () => {
    const dir = project((s) => {
      delete s.captions.position;
      s.voice = { mode: "none" };
      for (const sc of s.scenes) sc.voiceover = "";
      s.scenes[0].duration_sec = 2;
      s.scenes[0].on_screen_text = "one two three four five six seven eight nine ten";
    });
    const r = await lintProject(dir);
    const d = r.findings.filter((f) => f.id === "reading_density");
    expect(d).toEqual([expect.objectContaining({ scene_id: "s01", message: expect.stringMatching(/on-screen words/) })]);
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

describe("lint: reading density for CJK, Devanagari and Arabic", () => {
  const density = async (edit: (s: Record<string, any>) => void) => {
    const r = await lintProject(project((s) => (delete s.captions.position, edit(s))));
    return r.findings.filter((f) => f.id === "reading_density" && f.scene_id === "s01");
  };

  it("counts Japanese by characters against 9 characters/s", async () => {
    const tooDense = await density((s) => {
      s.language = "ja";
      s.scenes[0].duration_sec = 3;
      s.scenes[0].voiceover = "ベクトルデータベースは埋め込みを保存して意味の近いものを素早く見つけます。"; // 36 characters
    });
    expect(tooDense).toEqual([expect.objectContaining({ severity: "warning", message: expect.stringMatching(/36 voiceover characters \(cjk\) in 3s is 12 characters\/s; captions above 9 characters\/s/), fix: expect.stringMatching(/at most 27 characters/) })]);
    const ok = await density((s) => {
      s.language = "ja";
      s.scenes[0].duration_sec = 3;
      s.scenes[0].voiceover = "ベクトルデータベースは意味で検索します。"; // 19 characters
    });
    expect(ok).toEqual([]);
  });

  it("counts Hindi and Arabic by words with their own limits", async () => {
    const hi = await density((s) => {
      s.language = "hi";
      s.scenes[0].duration_sec = 3;
      s.scenes[0].voiceover = "वेक्टर डेटाबेस अर्थ से खोजते हैं और बहुत तेज़ी से सही जवाब देते हैं";
    });
    expect(hi).toEqual([expect.objectContaining({ message: expect.stringMatching(/14 voiceover words \(devanagari\).*above 3 words\/s/) })]);
    const ar = await density((s) => {
      s.language = "ar";
      s.scenes[0].duration_sec = 3;
      s.scenes[0].voiceover = "قواعد البيانات المتجهة تبحث بالمعنى وتجد النتائج القريبة بسرعة كبيرة";
    });
    expect(ar).toEqual([expect.objectContaining({ message: expect.stringMatching(/10 voiceover words \(arabic\).*above 2\.8 words\/s/) })]);
  });

  it("checks silent on-screen Japanese at 8 characters/s and CJK cover headlines by characters", async () => {
    const r = await lintProject(
      project((s) => {
        delete s.captions.position;
        s.language = "ja";
        s.voice = { mode: "none" };
        for (const sc of s.scenes) sc.voiceover = "";
        s.scenes[0].duration_sec = 2;
        s.scenes[0].on_screen_text = "ベクトルデータベースは意味で検索します";
        if (s.scenes[0].deterministic) s.scenes[0].deterministic = { kind: "typography", props: { lines: ["意味で検索"] } };
        s.cover.headline = "ベクトルデータベースは意味で検索します";
      }),
    );
    expect(r.findings.find((f) => f.id === "reading_density" && f.scene_id === "s01")).toMatchObject({ message: expect.stringMatching(/on-screen characters \(cjk\).*8 characters\/s/) });
    expect(r.findings.find((f) => f.id === "cover_headline")).toMatchObject({ message: expect.stringMatching(/19 characters; CJK covers read best at ≤ 16/) });
  });
});

describe("lint: caption, beat and on-screen timing", () => {
  /** Word timings for `text`, `step` ms apart from `from` (scene-relative), each `len` ms long. */
  const timed = (text: string, from: number, step = 400, len = 350) => text.split(/\s+/).map((word, i) => ({ word, start_ms: from + i * step, end_ms: from + i * step + len }));
  const S1 = "Your captions hide under the app.";
  const S2 = "Let lint place them in the safe zone.";

  /**
   * A rendered project: s01 (3 s) + s02 (5 s), voice tracks with the given word times and a
   * captions.json whose lines are `[scene, first word, word count, start, end]` over those words
   * placed on the video timeline.
   */
  function rendered(opts: {
    tracks?: Array<{ scene_id: string; words: Array<{ word: string; start_ms: number; end_ms: number }> }>;
    lines: Array<[string, number, number, number, number]>;
    timing_source?: string;
    edit?: (spec: Record<string, any>) => void;
    extra?: Record<string, unknown>;
  }): string {
    const dir = project((s) => (delete s.captions.position, opts.edit?.(s)));
    const tracks = opts.tracks ?? [
      { scene_id: "s01", words: timed(S1, 200) },
      { scene_id: "s02", words: timed(S2, 200) },
    ];
    const start: Record<string, number> = { s01: 0, s02: 3000 };
    const words = tracks.flatMap((t) => t.words.map((w) => ({ word: w.word, start_ms: w.start_ms + start[t.scene_id]!, end_ms: w.end_ms + start[t.scene_id]!, scene_id: t.scene_id })));
    const offset = (scene: string) => words.findIndex((w) => w.scene_id === scene);
    const lines = opts.lines.map(([scene, first, count, s, e]) => {
      const f = offset(scene) + first;
      return { start_ms: s, end_ms: e, text: words.slice(f, f + count).map((w) => w.word).join(" "), first_word: f, word_count: count, rows: [], emphasis: [] };
    });
    mkdirSync(join(dir, "renders", "final", "captions"), { recursive: true });
    mkdirSync(join(dir, "assets", "voice"), { recursive: true });
    writeFileSync(join(dir, "renders", "final", "captions", "captions.json"), JSON.stringify({ version: 1, words, lines }));
    writeFileSync(join(dir, "assets", "voice", "voice-tracks.json"), JSON.stringify(tracks.map((t) => ({ ...t, duration_ms: t.scene_id === "s01" ? 3000 : 5000, timing_source: "estimated", provider: "system-say" }))));
    writeState(dir, {
      target: { width: 1080, height: 1920, fps: 30, aspect_ratio: "9:16" },
      duration_ms: 8000,
      burn_in: true,
      scenes: [
        { scene_id: "s01", duration_ms: 3000 },
        { scene_id: "s02", duration_ms: 5000 },
      ],
      captions: { json: "renders/final/captions/captions.json" },
      voice: { timing_source: opts.timing_source ?? "estimated", tracks_path: "assets/voice/voice-tracks.json" },
      ...opts.extra,
    });
    return dir;
  }
  const ids = (r: { findings: Array<{ id: string }> }, id: string) => r.findings.filter((f) => f.id === id);
  const timingIds = ["caption_too_brief", "caption_sync", "caption_gap", "cut_off_beat", "onscreen_too_brief"];

  // In sync: s01 words 200–2550 ms (400 ms apart), s02 3200–6350 ms; one caption per scene over its words.
  const good: Array<[string, number, number, number, number]> = [
    ["s01", 0, 6, 200, 2550],
    ["s02", 0, 8, 3200, 6350],
  ];

  it("passes captions that match the voice", async () => {
    const r = await lintProject(rendered({ lines: good }));
    expect(r.findings.filter((f) => timingIds.includes(f.id))).toEqual([]);
  });

  it("caption_too_brief: a caption shorter than its reading time, with fewer-lines and rate fixes", async () => {
    // 6 words need 6 × 0.25 + 0.3 = 1.8 s; shown 0.9 s.
    const r = await lintProject(rendered({ lines: [["s01", 0, 6, 200, 1100], good[1]!], tracks: [{ scene_id: "s01", words: timed(S1, 200, 150, 140) }, { scene_id: "s02", words: timed(S2, 200) }] }));
    expect(ids(r, "caption_too_brief")).toEqual([
      expect.objectContaining({ severity: "warning", scene_id: "s01", message: expect.stringMatching(/shows for 0\.9s but needs 1\.8s/), fix: expect.stringMatching(/captions\.max_lines to 1.*voice\.rate_wpm 200 or lower/) }),
    ]);
    expect(ids(r, "caption_sync")).toEqual([]);
  });

  it("caption_too_brief counts CJK captions by characters", async () => {
    const ja = [{ word: "意味で検索します。", start_ms: 200, end_ms: 700 }];
    const r = await lintProject(rendered({ edit: (s) => (s.language = "ja"), tracks: [{ scene_id: "s01", words: ja }, { scene_id: "s02", words: timed(S2, 200) }], lines: [["s01", 0, 1, 200, 900], good[1]!] }));
    // 8 characters / 9 per s + 0.3 = 1.19 s > 0.7 s shown.
    expect(ids(r, "caption_too_brief")).toEqual([expect.objectContaining({ scene_id: "s01", message: expect.stringMatching(/needs 1\.19s \(1\/9 s per character/) })]);
  });

  it("caption_sync: early captions and speech with no caption", async () => {
    const r = await lintProject(
      rendered({
        lines: [
          ["s01", 0, 3, 200, 1350],
          ["s01", 3, 3, 700, 2550], // first word at 1400: 700 ms early
          ["s02", 0, 2, 3200, 3950], // s02 words 3..8 (4000–6350) have no caption
        ],
      }),
    );
    expect(ids(r, "caption_sync")).toEqual([
      expect.objectContaining({ scene_id: "s01", message: expect.stringMatching(/1 caption\(s\) in s01 .*"under the app\." starts 700 ms before its first word/) }),
      expect.objectContaining({ scene_id: "s02", message: "speech from 4s to 6.35s (2.35s) has no caption on screen" }),
    ]);
  });

  it("caption_sync: late captions; short uncaptioned speech is fine; skipped for timing_source none", async () => {
    // s02 words 7–8 (5600–6350, 0.75 s) are uncaptioned: under 1.5 s. The s01 caption stays 650 ms after its last word.
    const r = await lintProject(rendered({ lines: [["s01", 0, 6, 200, 3000], ["s02", 0, 6, 3200, 5550]] }));
    expect(ids(r, "caption_sync")).toEqual([expect.objectContaining({ scene_id: "s01", message: expect.stringMatching(/stays 450 ms after its last word/) })]);
    const none = await lintProject(rendered({ lines: [["s01", 0, 6, 0, 3000], ["s02", 0, 2, 3000, 3500]], timing_source: "none" }));
    expect(ids(none, "caption_sync")).toEqual([]);
  });

  it("caption_gap: flags captions separated by under 120 ms", async () => {
    const r = await lintProject(rendered({ lines: [["s01", 0, 3, 200, 1340], ["s01", 3, 3, 1400, 2550], good[1]!] }));
    expect(ids(r, "caption_gap")).toEqual([expect.objectContaining({ severity: "warning", scene_id: "s01", message: expect.stringMatching(/^minor: 1 caption change\(s\).*1\.34s \+60 ms/) })]);
  });

  it("cut_off_beat: a cut beat sync could not move, with the spec's tolerance", async () => {
    const beats = [400, 1400, 2400, 3400, 4400, 5400, 6400, 7400];
    const audio = (tol?: number) => (s: Record<string, any>) =>
      (s.audio = { music: { file: "assets/m.wav", license: { id: "user-owned" } }, beat_sync: { enabled: true, ...(tol ? { tolerance_ms: tol } : {}) } });
    const extra = { beat_sync: { bpm: 60, beats: 8, moved_cuts: 0, beat_times_ms: beats } };
    const r = await lintProject(rendered({ lines: good, edit: audio(), extra }));
    expect(ids(r, "cut_off_beat")).toEqual([
      expect.objectContaining({ severity: "warning", scene_id: "s01", message: expect.stringMatching(/at 3s is 400 ms from the nearest beat \(3\.4s\); tolerance 250 ms/), fix: expect.stringMatching(/duration_sec to 3\.4/) }),
    ]);
    expect(ids(await lintProject(rendered({ lines: good, edit: audio(500), extra })), "cut_off_beat")).toEqual([]);
    // Without recorded beat times (older renders) the check is skipped.
    expect(ids(await lintProject(rendered({ lines: good, edit: audio(), extra: { beat_sync: { bpm: 60, beats: 8, moved_cuts: 0 } } })), "cut_off_beat")).toEqual([]);
  });

  it("onscreen_too_brief: unspoken on-screen text in a narrated scene; spoken text is fine", async () => {
    const r = await lintProject(
      project((s) => {
        delete s.captions.position;
        s.scenes[1].duration_sec = 2;
        s.scenes[1].on_screen_text = "Seven unrelated words appear here for viewers";
      }),
    );
    expect(ids(r, "onscreen_too_brief")).toEqual([
      expect.objectContaining({ severity: "warning", scene_id: "s02", message: expect.stringMatching(/^13 on-screen words in 2s that the voiceover does not say/), fix: expect.stringMatching(/at most 3 words.*duration_sec to at least 5\.4$/) }),
    ]);
    const spoken = await lintProject(
      project((s) => {
        delete s.captions.position;
        s.scenes[1].duration_sec = 2;
        s.scenes[1].on_screen_text = "Let lint place them";
        s.scenes[1].deterministic = { kind: "typography", props: { lines: ["in the safe zone"] } };
      }),
    );
    expect(ids(spoken, "onscreen_too_brief")).toEqual([]);
  });

  it("does not double-report a silent scene reading_density already flagged", async () => {
    const r = await lintProject(
      project((s) => {
        delete s.captions.position;
        s.voice = { mode: "none" };
        for (const sc of s.scenes) sc.voiceover = "";
        s.scenes[0].duration_sec = 2;
        s.scenes[0].on_screen_text = "one two three four five six seven eight nine ten";
      }),
    );
    expect(ids(r, "reading_density").map((f) => (f as { scene_id?: string }).scene_id)).toEqual(["s01"]);
    expect(ids(r, "onscreen_too_brief")).toEqual([]);
  });

  it("story_structure: no early tension and no payoff before the CTA", async () => {
    const scene = (id: string, purpose: string) => ({ id, duration_sec: 3, purpose, voiceover: "Plain words here.", visual_strategy: "motion_graphic", visual_requirements: { continuity_refs: [] }, claim_refs: [] });
    const weak = await lintProject(project((s) => (delete s.captions.position, (s.scenes = [scene("s01", "hook"), scene("s02", "point"), scene("s03", "point"), scene("s04", "cta")]))));
    expect(ids(weak, "story_structure")).toEqual([
      expect.objectContaining({ severity: "warning", message: expect.stringMatching(/no scene after the hook.*sets up tension.*last scene before the CTA \(s03\) is "point"/), fix: expect.stringMatching(/storytelling\.md/) }),
    ]);
    const strong = await lintProject(
      project((s) => (delete s.captions.position, (s.scenes = [scene("s01", "hook"), scene("s02", "question"), scene("s03", "point"), scene("s04", "payoff"), scene("s05", "cta"), scene("s06", "end_card")]))),
    );
    expect(ids(strong, "story_structure")).toEqual([]);
    // Two-scene videos have no room for an arc: not checked.
    expect(ids(await lintProject(project((s) => delete s.captions.position)), "story_structure")).toEqual([]);
  });
});

describe("word cue checks", () => {
  it("reports unplaced cues and cues too close together", () => {
    const out: LintFinding[] = [];
    checkCues(
      {
        cues: [
          { scene_id: "s01", word: "ingest", item: 0, at_ms: 200, status: "placed" },
          { scene_id: "s01", word: "plan", item: 1, at_ms: 450, status: "placed" },
          { scene_id: "s01", word: "render", item: 2, status: "unmatched" },
          { scene_id: "s02", word: "later", item: 0, at_ms: 5000, status: "late" },
          { scene_id: "s03", word: "a", item: 0, at_ms: 100, status: "placed" },
          { scene_id: "s03", word: "b", item: 1, at_ms: 900, status: "placed" },
        ],
      },
      out,
    );
    expect(out.map((f) => `${f.id}:${f.scene_id}`)).toEqual(["cue_unmatched:s01", "cue_unmatched:s02", "cue_too_close:s01"]);
    expect(out[2]!.message).toMatch(/250 ms apart/);
  });
});

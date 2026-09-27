import type { VideoSpec } from "@video-studio/schema";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextBox } from "@video-studio/schema";
import { describe, expect, it } from "vitest";
import {
  type LintFinding,
  checkAcceptance,
  checkBannedEffect,
  checkCues,
  checkCutaways,
  checkForbidden,
  checkInserts,
  checkLogo,
  checkLoopSeam,
  checkTextRepeatsCaptions,
  checkTitleLength,
  contrastRatio,
  INSERT_EARLY_MAX_S,
  INSERT_TAIL_MAX_S,
  lintProject,
  SENTENCE_GAP_MS,
} from "./lint.js";
import { findResearchSpecsDir, loadTitleRules } from "./research-specs.js";

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

  it("cut_off_beat: with snap downbeat, cuts are measured against bar starts", async () => {
    const beats = [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000];
    const audio = (snap?: string) => (s: Record<string, any>) =>
      (s.audio = { music: { file: "assets/m.wav", license: { id: "user-owned" } }, beat_sync: { enabled: true, ...(snap ? { snap } : {}) } });
    const extra = { beat_sync: { bpm: 60, beats: 8, moved_cuts: 0, beat_times_ms: beats, downbeat_times_ms: [0, 4000], snap: "downbeat" } };
    // The cut at 3 s is on a beat, so snapping to any beat is satisfied.
    expect(ids(await lintProject(rendered({ lines: good, edit: audio(), extra: { beat_sync: { ...extra.beat_sync, snap: "beat" } } })), "cut_off_beat")).toEqual([]);
    const r = await lintProject(rendered({ lines: good, edit: audio("downbeat"), extra }));
    expect(ids(r, "cut_off_beat")).toEqual([
      expect.objectContaining({ scene_id: "s01", message: expect.stringMatching(/at 3s is 1000 ms from the nearest downbeat \(4s\)/), fix: expect.stringMatching(/duration_sec to 4\b/) }),
    ]);
    // Downbeats asked for but not found (the render fell back to beats): measured against beats.
    const fell = { beat_sync: { bpm: 60, beats: 8, moved_cuts: 0, beat_times_ms: beats, snap: "beat" } };
    expect(ids(await lintProject(rendered({ lines: good, edit: audio("downbeat"), extra: fell })), "cut_off_beat")).toEqual([]);
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

describe("cutaway rhythm", () => {
  const sc = (id: string, dur: number, cut = false) =>
    ({ id, duration_sec: dur, purpose: "point", voiceover: "", visual_strategy: "user_asset", footage: { asset: "v1", in_sec: 0, ...(cut ? { cutaway: true } : {}) }, visual_requirements: {}, claim_refs: [] }) as VideoSpec["scenes"][number];
  const run = (scenes: VideoSpec["scenes"]) => {
    const out: LintFinding[] = [];
    checkCutaways({ scenes } as VideoSpec, out);
    return out;
  };

  it("passes a face-cutaway-face rhythm and merges consecutive cutaway scenes", () => {
    expect(run([sc("s1", 3), sc("s2", 2, true), sc("s3", 2, true), sc("s4", 3), sc("s5", 5, true), sc("s6", 2)])).toEqual([]);
  });

  it("flags a cutaway in the hook, bad lengths and too little face between", () => {
    const out = run([sc("s1", 2, true), sc("s2", 1), sc("s3", 12, true), sc("s4", 3)]);
    expect(out.map((f) => f.scene_id)).toEqual(["s1", "s3"]);
    expect(out[0]!.message).toMatch(/inside the hook's first second.*lasts 2s/);
    expect(out[1]!.message).toMatch(/lasts 12s.*only 1s of the speaker/);
  });
});

describe("brand logo and forbidden treatments", () => {
  it("warns when text sits under the corner logo (captions excluded)", () => {
    const out: LintFinding[] = [];
    const box = (role: string, x: number, y: number) => ({ role, text: "t", rect: { x, y, w: 200, h: 80 }, font_px: 40, truncated: false }) as never;
    checkLogo(
      { logo: { path: "assets/logo.png", box: { x: 900, y: 60, w: 120, h: 60 }, scenes: ["s01", "s02"] } },
      [
        { scene_id: "s01", box: box("headline", 850, 80) },
        { scene_id: "s01", box: box("caption", 850, 80) },
        { scene_id: "s02", box: box("body", 100, 800) },
        { scene_id: "s03", box: box("headline", 850, 80) },
      ],
      out,
    );
    expect(out.map((f) => `${f.id}:${f.scene_id}`)).toEqual(["logo_overlap:s01"]);
    expect(out[0]!.message).toMatch(/overlaps the headline text box/);
  });

  it("flags scenes that use a forbidden treatment", () => {
    const out: LintFinding[] = [];
    const scenes = [
      { id: "s01", transition: "zoom", motion: { pattern: "push_in" }, deterministic: { kind: "kinetic_text", props: {} }, visual_requirements: { style_notes: "soft drop shadows on cards" } },
      { id: "s02", transition: "cut", visual_requirements: {} },
    ] as unknown as VideoSpec["scenes"];
    checkForbidden({ scenes } as VideoSpec, { visual: { forbidden: ["drop shadow", "zoom transitions", "Kinetic text", "gradients"] } } as never, out);
    expect(out.map((f) => f.message.match(/uses "(.+?)"/)![1])).toEqual(["drop shadow", "zoom transitions", "Kinetic text"]);
    expect(out.every((f) => f.scene_id === "s01")).toBe(true);
  });
});

describe("on-screen text repeating the captions", () => {
  const scene = (id: string, voiceover: string, kind: string, props: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ id, voiceover, deterministic: { kind, props }, ...extra }) as unknown as VideoSpec["scenes"][number];
  const run = (scenes: VideoSpec["scenes"], burnIn = true, mode?: string) => {
    const out: LintFinding[] = [];
    checkTextRepeatsCaptions({ scenes, voice: mode ? { mode } : {} } as VideoSpec, burnIn, out);
    return out;
  };

  it("flags word-for-word repeats (kinetic text included), not summaries", () => {
    const out = run([
      scene("s01", "I gave Claude a new superpower.", "kinetic_text", { text: "I gave Claude a new superpower." }),
      scene("s02", "Every claim on screen cites a line in your sources.", "typography", { lines: ["Every claim", "cites a source."] }),
      scene("s03", "Right now, that's an editor and checklists.", "typography", { lines: ["Creating videos", "is still painful."] }),
      scene("s04", "It is fast because it caches every scene.", "typography", { lines: ["It caches every scene"] }),
    ]);
    expect(out.map((f) => f.scene_id)).toEqual(["s01", "s04"]);
    expect(out[0]!.message).toMatch(/"I gave Claude a new superpower\."/);
    expect(out[0]!.fix).toMatch(/set burn_captions: false on scene s01/);
    expect(out[1]!.fix).toMatch(/put something else on screen/);
  });

  it("skips CTAs, quotes, hidden captions, no burn-in and unnarrated specs", () => {
    const s = [
      scene("s01", "Try it on your own README.", "cta", { headline: "Try it on your own README", action: "Install" }),
      scene("s02", "It just works, a user said.", "quote", { text: "It just works, a user said." }),
      scene("s03", "I gave Claude a new superpower.", "kinetic_text", { text: "I gave Claude a new superpower." }, { burn_captions: false }),
    ];
    expect(run(s)).toEqual([]);
    const k = [scene("s01", "I gave Claude a new superpower.", "kinetic_text", { text: "I gave Claude a new superpower." })];
    expect(run(k, false)).toEqual([]);
    expect(run(k, true, "native")).toEqual([]);
  });
});

describe("taste guard, acceptance and loop seam", () => {
  const motionScene = (id: string, effects: string[]) =>
    ({ id, deterministic: { kind: "motion", props: { html: "motion/a.html", text: ["Hi"], effects } }, visual_requirements: {} }) as unknown as VideoSpec["scenes"][number];

  it("banned_effect: declared effects against the style's avoid list and brand.visual.forbidden", () => {
    const out: LintFinding[] = [];
    const scenes = [motionScene("s01", ["shake", "rgb_split"]), motionScene("s02", ["flash"]), motionScene("s03", [])];
    checkBannedEffect({ scenes, style: "calm" } as VideoSpec, { id: "calm", avoid: ["shake", "lens_flare"] }, { visual: { forbidden: ["RGB split", "Flashes"] } } as never, out);
    expect(out.map((f) => `${f.id}:${f.scene_id}:${f.severity}`)).toEqual(["banned_effect:s01:error", "banned_effect:s01:error", "banned_effect:s02:error"]);
    expect(out[0]!.message).toMatch(/"shake".*style "calm" avoids/);
    expect(out[0]!.fix).toMatch(/remove "shake" from scene s01's props\.effects/);
    expect(out[1]!.message).toMatch(/"rgb_split".*brand\.yaml.*"RGB split"/);
    expect(out[2]!.message).toMatch(/"flash"/);
    // No style and no brand: nothing to check.
    const none: LintFinding[] = [];
    checkBannedEffect({ scenes } as VideoSpec, undefined, undefined, none);
    expect(none).toEqual([]);
  });

  it("banned_effect through lintProject, with the active style pack", async () => {
    const stylesDir = mkdtempSync(join(tmpdir(), "vs-lint-styles-"));
    writeFileSync(join(stylesDir, "README.md"), "styles\n");
    const raw = readFileSync(join(import.meta.dirname, "..", "..", "..", "styles", "minimal.yaml"), "utf8");
    // The shipped minimal pack avoids every stock effect, neon_glow included.
    expect(raw).toMatch(/\n  avoid: \[[^\]]*neon_glow/);
    writeFileSync(join(stylesDir, "minimal.yaml"), raw);
    const dir = project((s) => {
      s.style = "minimal";
      s.scenes[0].deterministic = { kind: "motion", props: { html: "motion/a.html", text: ["Captions hide"], effects: ["neon_glow"] } };
    });
    const r = await lintProject(dir, { stylesDir });
    expect(r.findings.filter((f) => f.id === "banned_effect")).toEqual([expect.objectContaining({ severity: "error", scene_id: "s01", message: expect.stringMatching(/neon_glow/) })]);
  });

  it("acceptance_unmet: every acceptance number the render misses, with the measured value", () => {
    const motion = { changes: 10, changes_per_sec: 0.5, cuts: 4, cuts_per_sec: 0.2, longest_static_s: 6.2, frozen_s: 5, frozen_pct: 25 };
    const out: LintFinding[] = [];
    checkAcceptance({ acceptance: { min_changes_per_sec: 1, max_frozen_pct: 10, max_static_sec: 3, hold_ms: 400 } } as VideoSpec, { qa: { motion } }, out);
    expect(out.map((f) => f.severity)).toEqual(["error", "error", "error"]);
    expect(out.map((f) => f.message)).toEqual([
      expect.stringMatching(/0\.5 big changes\/s.*minimum 1/),
      expect.stringMatching(/25% of the runtime frozen.*maximum 10%/),
      expect.stringMatching(/6\.2s without a big change.*maximum 3s/),
    ]);
    // Met, or no QA metrics yet: nothing.
    const quiet: LintFinding[] = [];
    checkAcceptance({ acceptance: { min_changes_per_sec: 0.4 } } as VideoSpec, { qa: { motion } }, quiet);
    checkAcceptance({ acceptance: { min_changes_per_sec: 5 } } as VideoSpec, {}, quiet);
    checkAcceptance({} as VideoSpec, { qa: { motion } }, quiet);
    expect(quiet).toEqual([]);
  });

  it("loop_seam: surfaces QA's seam measurement when master.loop is set", () => {
    const spec = { master: { width: 1080, height: 1920, fps: 30, loop: true } } as VideoSpec;
    const out: LintFinding[] = [];
    checkLoopSeam(spec, { qa: { loop_seam: { ssim: 0.91, audio_jump_db: 9.5 } } }, out);
    expect(out).toEqual([expect.objectContaining({ id: "loop_seam", severity: "error", message: expect.stringMatching(/SSIM 0\.91.*9\.5 dB/) })]);
    const ok: LintFinding[] = [];
    checkLoopSeam(spec, { qa: { loop_seam: { ssim: 0.995, audio_jump_db: 1 } } }, ok);
    checkLoopSeam({ master: { width: 1080, height: 1920, fps: 30 } } as VideoSpec, { qa: { loop_seam: { ssim: 0.5, audio_jump_db: 20 } } }, ok);
    expect(ok).toEqual([]);
    // Rendered but not measured (QA ran without loop): a warning to re-run QA.
    const stale: LintFinding[] = [];
    checkLoopSeam(spec, { qa: {} }, stale);
    expect(stale).toEqual([expect.objectContaining({ id: "loop_seam", severity: "warning", fix: expect.stringMatching(/qa_run/) })]);
  });
});

describe("insert sync", () => {
  /** Voice-track words for `text`, one every 300 ms (250 ms long) from `from` ms. */
  const words = (text: string, from = 0) => text.split(" ").map((word, i) => ({ word, start_ms: from + i * 300, end_ms: from + i * 300 + 250 }));
  const scene = (id: string, duration_sec: number, voiceover: string, kind: string, props: Record<string, unknown>) =>
    ({ id, duration_sec, voiceover, deterministic: { kind, props }, visual_requirements: {}, claim_refs: [] }) as unknown as VideoSpec["scenes"][number];
  const run = (scenes: VideoSpec["scenes"], cues: Array<{ scene_id: string; word: string; item: number; at_ms?: number; status: string }> = [], timing = "estimated") => {
    const out: LintFinding[] = [];
    const state = { voice: { timing_source: timing }, scenes: scenes.map((s) => ({ scene_id: s.id, duration_ms: s.duration_sec * 1000 })), cues };
    const tracks = scenes.map((s) => ({ scene_id: s.id, duration_ms: s.duration_sec * 1000, words: words(s.voiceover) }));
    checkInserts({ scenes } as VideoSpec, state, tracks, out);
    return out;
  };
  const STAT = { value: 40, unit: "%", label: "faster builds" };
  const VO = "Builds used to crawl. Now they are 40 percent faster.";

  it("insert_early: an uncued stat on screen from the scene start while the voice says its number at 2.1 s", () => {
    const out = run([scene("s05", 3.5, VO, "stat", STAT)]);
    expect(out).toEqual([
      expect.objectContaining({
        id: "insert_early",
        severity: "warning",
        scene_id: "s05",
        message: expect.stringMatching(/"40".*2\.1s before the voice says it.*limit 1s/),
        fix: 'add cues: [{word: "40"}] to scene s05 so the insert lands on its word',
      }),
    ]);
    expect(INSERT_EARLY_MAX_S).toBe(1);
  });

  it("insert_early: quiet when a placed cue lands the value on its word, or the number is said early", () => {
    expect(run([scene("s05", 3.5, VO, "stat", STAT)], [{ scene_id: "s05", word: "40", item: 0, at_ms: 2100, status: "placed" }])).toEqual([]);
    expect(run([scene("s05", 3.5, "40 percent faster builds, every day.", "stat", STAT)])).toEqual([]);
    // A number the voice never says is not guessed at.
    expect(run([scene("s05", 3.5, "Builds got much faster.", "stat", STAT)])).toEqual([]);
  });

  it("insert_early: a cue on the wrong word is named, and numbers outside cue items enter with the scene", () => {
    const cued = run([scene("s05", 3.5, VO, "stat", STAT)], [{ scene_id: "s05", word: "Builds", item: 0, at_ms: 0, status: "placed" }]);
    expect(cued).toEqual([expect.objectContaining({ id: "insert_early", fix: 'move scene s05\'s cue for item 0 to {word: "40"} so the insert lands on its word' })]);
    const map = run([scene("s06", 4, "It runs in more places than you think: 3 regions today.", "map", { title: "Live in 3 regions", points: [{ label: "EU", x: 0.2, y: 0.3 }] })]);
    expect(map).toEqual([expect.objectContaining({ id: "insert_early", scene_id: "s06", fix: expect.stringMatching(/say "3" within 1s of scene s06's start, or move it into a cued item/) })]);
  });

  it("insert_overstays: a single insert whose sentence ends long before the scene does, while another sentence plays", () => {
    const vo = `${VO} Here is how the cache makes that happen for every team.`;
    const out = run([scene("s05", 8, vo, "stat", STAT)], [{ scene_id: "s05", word: "40", item: 0, at_ms: 2100, status: "placed" }]);
    expect(out).toEqual([
      expect.objectContaining({
        id: "insert_overstays",
        severity: "warning",
        scene_id: "s05",
        message: expect.stringMatching(/stays 5\.05s after its sentence \("Now they are 40 percent faster\."\) ends.*"Here is how the cache/),
        fix: expect.stringMatching(/^split scene s05 after "…40 percent faster\." .*or end it sooner/),
      }),
    ]);
    expect(INSERT_TAIL_MAX_S).toBe(2.5);
    // The sentence ends the voiceover (a silent tail is a hold, not a new statement), or the tail is short.
    expect(run([scene("s05", 8, VO, "stat", STAT)], [{ scene_id: "s05", word: "40", item: 0, at_ms: 2100, status: "placed" }])).toEqual([]);
    expect(run([scene("s05", 5, `${VO} Nice.`, "stat", STAT)], [{ scene_id: "s05", word: "40", item: 0, at_ms: 2100, status: "placed" }])).toEqual([]);
  });

  it("sentences also break on long pauses when the transcript has no punctuation", () => {
    const out: LintFinding[] = [];
    const s = scene("s05", 8, "now they are 40 percent faster here is how", "stat", STAT);
    const ws = [...words("now they are 40 percent faster"), ...words("here is how", 1800 + SENTENCE_GAP_MS)];
    checkInserts({ scenes: [s] } as VideoSpec, { voice: { timing_source: "native" }, scenes: [{ scene_id: "s05", duration_ms: 8000 }], cues: [{ scene_id: "s05", word: "40", item: 0, at_ms: 900, status: "placed" }] }, [{ scene_id: "s05", duration_ms: 8000, words: ws }], out);
    expect(out.map((f) => f.id)).toEqual(["insert_overstays"]);
  });

  it("insert_crowded: two data items cued inside one sentence; quiet when they land in separate sentences", () => {
    const chart = { type: "bar", series: [{ label: "2024", value: 12 }, { label: "2025", value: 40 }] };
    const one = "Revenue went from 12 to 40 million this year.";
    const out = run([scene("s07", 4, one, "chart", chart)], [
      { scene_id: "s07", word: "12", item: 0, at_ms: 900, status: "placed" },
      { scene_id: "s07", word: "40", item: 1, at_ms: 1500, status: "placed" },
    ]);
    expect(out).toEqual([
      expect.objectContaining({
        id: "insert_crowded",
        severity: "warning",
        scene_id: "s07",
        message: expect.stringMatching(/one sentence \("Revenue went from 12 to 40 million this year\."\) triggers 2 data items/),
        fix: expect.stringMatching(/one insert per statement: cue item 1 \("40"\) on a word in a later sentence, or split scene s07/),
      }),
    ]);
    const two = "Last year revenue was 12 million. This year it hit 40 million.";
    expect(run([scene("s07", 5, two, "chart", chart)], [
      { scene_id: "s07", word: "12", item: 0, at_ms: 1200, status: "placed" },
      { scene_id: "s07", word: "40", item: 1, at_ms: 3000, status: "placed" },
    ])).toEqual([]);
  });

  it("is skipped without speech timing: never guesses", () => {
    expect(run([scene("s05", 8, `${VO} More words here after it.`, "stat", STAT)], [], "none")).toEqual([]);
    const out: LintFinding[] = [];
    checkInserts({ scenes: [scene("s05", 3.5, VO, "stat", STAT)] } as VideoSpec, { voice: { timing_source: "estimated" }, scenes: [{ scene_id: "s05", duration_ms: 3500 }] }, undefined, out);
    checkInserts({ scenes: [scene("s05", 3.5, VO, "stat", STAT)] } as VideoSpec, undefined, [], out);
    expect(out).toEqual([]);
  });
});

describe("title_length", () => {
  const rules = { schema_version: "1.0", id: "titles", title_length: { min_chars: 24, max_chars: 58 }, basis: "heuristic", verified: false } as const;
  const base = { platform: "youtube_shorts", goal: "explain", scenes: [{ id: "s01", purpose: "hook", voiceover: "Hello there." }] } as unknown as VideoSpec;

  it("loads research-specs/titles.yaml from the plugin root, and skips when it is missing", async () => {
    const dir = findResearchSpecsDir();
    expect(dir).toBeTruthy();
    expect((await loadTitleRules(dir))?.title_length).toEqual({ min_chars: 24, max_chars: 58 });
    expect(await loadTitleRules(null)).toBeUndefined();
    expect(await loadTitleRules(mkdtempSync(join(tmpdir(), "vs-rs-")))).toBeUndefined();
  });

  it("warns on a short or long generated title, labelled a heuristic, with a direction", () => {
    const out: LintFinding[] = [];
    checkTitleLength({ ...base, title: "Fast builds" } as VideoSpec, undefined, rules, out);
    checkTitleLength({ ...base, title: "Why every single one of your builds is slow and what to do about it today" } as VideoSpec, undefined, rules, out);
    expect(out).toEqual([
      expect.objectContaining({ id: "title_length", severity: "warning", message: expect.stringMatching(/"Fast builds" is 11 characters.*24–58.*heuristic.*unverified/), fix: expect.stringMatching(/^expand spec\.title by at least 13 characters/) }),
      expect.objectContaining({ id: "title_length", severity: "warning", message: expect.stringMatching(/is 73 characters/), fix: expect.stringMatching(/^trim spec\.title by at least 15 characters/) }),
    ]);
  });

  it("checks the brief's hook when the spec has no title, and multi-line publish headlines; quiet in band or without rules", () => {
    const out: LintFinding[] = [];
    checkTitleLength(base, { chosen_hook: "Builds" } as never, rules, out);
    checkTitleLength({ ...base, title: "Why your builds are slow (and the fix)", publish: { youtube: { post_caption: "Slow?\nThe long description.", hashtags: [] }, instagram: { post_caption: "One line caption that is long enough anyway, fine for a caption and not a title at all." } } } as unknown as VideoSpec, undefined, rules, out);
    checkTitleLength({ ...base, title: "Tiny" } as VideoSpec, undefined, undefined, out);
    expect(out).toEqual([
      expect.objectContaining({ id: "title_length", fix: expect.stringMatching(/^set spec\.title to a title of 24–58 characters/) }),
      expect.objectContaining({ id: "title_length", target: "youtube", message: expect.stringMatching(/publish\.youtube headline "Slow\?" is 5 characters/), fix: expect.stringMatching(/first line of publish\.youtube\.post_caption/) }),
    ]);
  });

  it("checks publish.<target>.title when it is set, instead of the caption's first line", () => {
    const out: LintFinding[] = [];
    checkTitleLength({ ...base, title: "Why your builds are slow (and the fix)", publish: { youtube: { title: "Slow", post_caption: "A fine first line of a long enough caption\nmore" } } } as unknown as VideoSpec, undefined, rules, out);
    expect(out).toEqual([expect.objectContaining({ id: "title_length", target: "youtube", message: expect.stringMatching(/publish\.youtube\.title "Slow" is 4 characters/) })]);
  });

  it("lintProject reports it from the bundled research-specs, and skips it when there are none", async () => {
    const long = (s: Record<string, any>) => (s.title = "A title that goes on and on well past the point where phones cut it off");
    expect((await lintProject(project(long))).findings.filter((f) => f.id === "title_length")).toHaveLength(1);
    expect((await lintProject(project(long), { researchSpecsDir: null })).findings.filter((f) => f.id === "title_length")).toEqual([]);
    expect((await lintProject(project())).findings.filter((f) => f.id === "title_length")).toEqual([]);
  });
});

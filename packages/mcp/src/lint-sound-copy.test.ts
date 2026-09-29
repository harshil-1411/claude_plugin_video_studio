import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Brand, ClicheRules, CreativeBrief, VideoSpec } from "@video-studio/schema";
import { describe, expect, it } from "vitest";
import {
  BUSY_TEXT_WORDS,
  CLICHE_FIX,
  type LintFinding,
  checkBanned,
  checkBusyCrossfade,
  checkCliche,
  checkSfxHarshRepeat,
  checkSfxLicense,
  checkSfxOverVoice,
  generatedCopy,
  lintProject,
  phraseIn,
} from "./lint.js";
import { findSfxDir, loadSfxCatalog } from "./sfx.js";

const catalog = loadSfxCatalog(findSfxDir({}));
const rules: ClicheRules = { schema_version: "1.0", id: "cliches", phrases: ["game-changer", "excited to share", "in today's fast-paced world", "supercharge"] };

type SceneIn = Partial<VideoSpec["scenes"][number]> & { id: string };
const spec = (scenes: SceneIn[], extra: Partial<VideoSpec> = {}) =>
  ({ platform: "youtube_shorts", goal: "explain", targets: ["youtube_shorts"], scenes: scenes.map((s) => ({ duration_sec: 2, voiceover: "", purpose: "explain", ...s })), ...extra }) as unknown as VideoSpec;
const ids = (out: LintFinding[]) => out.map((f) => f.id);

describe("phraseIn", () => {
  it("matches whole words, any case, straight or curly apostrophes", () => {
    expect(phraseIn("A total Game-Changer.", "game-changer")).toBe(true);
    expect(phraseIn("In today’s fast-paced world", "in today's fast-paced world")).toBe(true);
    expect(phraseIn("supercharged batteries", "supercharge")).toBe(false);
    expect(phraseIn("endgame-changer", "game-changer")).toBe(false);
  });
});

describe("lint cliche", () => {
  it("warns in voiceover, on-screen, graphic and publish text, and stays silent on concrete copy", () => {
    const out: LintFinding[] = [];
    const bad = spec(
      [
        { id: "s01", voiceover: "This is a game-changer.", on_screen_text: "Supercharge your builds" },
        { id: "s02", deterministic: { kind: "stat", props: { value: "3x", label: "Excited to share" } } as never },
      ],
      { cover: { headline: "In today's fast-paced world" }, publish: { youtube_shorts: { post_caption: "A game-changer for CI" } } } as never,
    );
    checkCliche(bad, rules, generatedCopy(bad, undefined), out);
    expect(ids(out)).toEqual(["cliche", "cliche", "cliche", "cliche", "cliche"]);
    expect(out.every((f) => f.severity === "warning" && f.fix.endsWith(CLICHE_FIX))).toBe(true);
    expect(out[0]).toMatchObject({ scene_id: "s01", message: expect.stringMatching(/"game-changer" in scene s01 voiceover/) });
    expect(out.find((f) => f.target === "youtube_shorts")!.message).toMatch(/publish\.youtube_shorts/);

    const fixed: LintFinding[] = [];
    const good = spec([{ id: "s01", voiceover: "Builds finish in 40 seconds instead of 4 minutes.", on_screen_text: "40 s builds" }], {
      cover: { headline: "4-minute builds, now 40 s" },
    } as never);
    checkCliche(good, rules, generatedCopy(good, undefined), fixed);
    expect(fixed).toEqual([]);
  });

  it("checks the generated social-copy draft only where no publish override exists", () => {
    const brief = { chosen_hook: "Excited to share our new CLI", key_messages: ["It is fast"] } as unknown as CreativeBrief;
    const s = spec([{ id: "s01", voiceover: "Builds in 40 seconds." }]);
    const out: LintFinding[] = [];
    checkCliche(s, rules, generatedCopy(s, brief), out);
    expect(out).toEqual([
      expect.objectContaining({ id: "cliche", target: "youtube_shorts", message: expect.stringMatching(/"excited to share" in the generated post copy for youtube_shorts/), fix: expect.stringMatching(/^write publish\.youtube_shorts\.post_caption/) }),
    ]);
    // An override replaces the draft for that target.
    const overridden = spec([{ id: "s01", voiceover: "Builds in 40 seconds." }], { publish: { youtube_shorts: { post_caption: "Our CLI builds in 40 s" } } } as never);
    expect(generatedCopy(overridden, brief)).toBeUndefined();
    const none: LintFinding[] = [];
    checkCliche(overridden, rules, generatedCopy(overridden, brief), none);
    expect(none).toEqual([]);
    // A phrase already reported in the spec is not repeated for the draft built from it.
    const vo = spec([{ id: "s01", purpose: "hook", voiceover: "Excited to share this." }]);
    const once: LintFinding[] = [];
    checkCliche(vo, rules, generatedCopy(vo, undefined), once);
    expect(once).toHaveLength(1);
  });
});

describe("brand banned phrases in the generated social-copy draft", () => {
  const brand = { voice: { banned_phrases: ["synergy"] } } as unknown as Brand;
  const brief = { key_messages: ["Synergy across your team"] } as unknown as CreativeBrief;

  it("is an error when the draft carries a banned phrase and no override replaces it", () => {
    const s = spec([{ id: "s01", voiceover: "Builds in 40 seconds." }]);
    const out: LintFinding[] = [];
    checkBanned(s, brand, out, generatedCopy(s, brief));
    expect(out).toEqual([expect.objectContaining({ id: "brand_banned_phrase", severity: "error", target: "youtube_shorts", message: expect.stringMatching(/"synergy" appears in the generated post copy/) })]);
    const fixed: LintFinding[] = [];
    const o = spec([{ id: "s01", voiceover: "Builds in 40 seconds." }], { publish: { youtube_shorts: { post_caption: "Builds in 40 s" } } } as never);
    checkBanned(o, brand, fixed, generatedCopy(o, brief));
    expect(fixed).toEqual([]);
  });
});

describe("lint busy_crossfade", () => {
  const dense = "Seven words of dense text on screen";
  it("warns on a crossfade between two text-dense scenes or two motion pages", () => {
    expect(dense.split(" ").length).toBeGreaterThanOrEqual(BUSY_TEXT_WORDS);
    const out: LintFinding[] = [];
    checkBusyCrossfade(spec([{ id: "s01", on_screen_text: dense }, { id: "s02", on_screen_text: dense, transition: "crossfade" }]), undefined, out);
    expect(out).toEqual([expect.objectContaining({ id: "busy_crossfade", scene_id: "s02", fix: expect.stringMatching(/fade_black.*cut.*stagger: old content out, then new in/) })]);
    const motion = { kind: "motion", props: { html: "motion/a.html" } } as never;
    const m: LintFinding[] = [];
    checkBusyCrossfade(spec([{ id: "s01", deterministic: motion }, { id: "s02", deterministic: motion }]), "crossfade", m);
    expect(m[0]!.message).toMatch(/style's default transition.*motion pages/);
  });

  it("is silent for fade_black, a cut, or one light scene", () => {
    const out: LintFinding[] = [];
    checkBusyCrossfade(spec([{ id: "s01", on_screen_text: dense }, { id: "s02", on_screen_text: dense, transition: "fade_black" }]), "crossfade", out);
    checkBusyCrossfade(spec([{ id: "s01", on_screen_text: dense }, { id: "s02", on_screen_text: dense }]), "cut", out);
    checkBusyCrossfade(spec([{ id: "s01", on_screen_text: dense }, { id: "s02", on_screen_text: "40 s", transition: "crossfade" }]), undefined, out);
    expect(out).toEqual([]);
  });
});

describe("lint sfx rules", () => {
  it("sfx_license_missing: a project file without a licence; bundled sounds carry CC0", () => {
    const out: LintFinding[] = [];
    checkSfxLicense(spec([{ id: "s01", sfx: [{ file: "assets/sfx/whoosh.wav", at_sec: 0 }, { file: "bundled:pop", at_sec: 1 }] }]), out);
    expect(out).toEqual([expect.objectContaining({ id: "sfx_license_missing", severity: "warning", scene_id: "s01", message: expect.stringMatching(/assets\/sfx\/whoosh\.wav/) })]);
    const fixed: LintFinding[] = [];
    checkSfxLicense(
      spec([
        { id: "s01", sfx: [{ file: "assets/sfx/whoosh.wav", at_sec: 0, license: { id: "user-owned" } }] },
        { id: "s02", sfx: [{ file: "assets/sfx/whoosh.wav", at_sec: 0 }] },
      ]),
      fixed,
    );
    expect(fixed).toEqual([]);
  });

  it("sfx_harsh_repeat: a bright bundled sound more than 3 times, or two starts under 250 ms apart", () => {
    const ticks = (n: number) => spec([{ id: "s01", duration_sec: 4, sfx: Array.from({ length: n }, (_, k) => ({ file: "bundled:tick", at_sec: k * 0.5 })) }]);
    const out: LintFinding[] = [];
    checkSfxHarshRepeat(ticks(4), catalog, undefined, out);
    expect(out).toEqual([expect.objectContaining({ id: "sfx_harsh_repeat", message: expect.stringMatching(/bundled:tick \(bright, hf_risk high\) plays 4 times/) })]);
    const three: LintFinding[] = [];
    checkSfxHarshRepeat(ticks(3), catalog, undefined, three);
    expect(three).toEqual([]);

    const close: LintFinding[] = [];
    checkSfxHarshRepeat(spec([{ id: "s01", sfx: [{ file: "bundled:pop", at_sec: 1 }] }, { id: "s02", sfx: [{ file: "assets/sfx/x.wav", at_sec: 0.1 }] }]), catalog, undefined, close);
    // Scene s02 starts at 2 s: pop starts at 1 s minus its peak; x.wav at 2.1 s. Far apart:
    expect(close).toEqual([]);
    checkSfxHarshRepeat(spec([{ id: "s01", sfx: [{ file: "bundled:pop", at_sec: 1 }, { file: "bundled:hit-soft", at_sec: 1.1 }] }]), catalog, undefined, close);
    expect(close).toEqual([expect.objectContaining({ id: "sfx_harsh_repeat", message: expect.stringMatching(/start \d+ ms apart/) })]);

    const fine: LintFinding[] = [];
    // Typing runs are exempt; a riser swelling into a hit starts a second earlier.
    checkSfxHarshRepeat(
      spec([
        { id: "s01", sfx: [{ file: "bundled:key-1", at_sec: 0.2 }, { file: "bundled:key-2", at_sec: 0.32 }, { file: "bundled:key-3", at_sec: 0.44 }] },
        { id: "s02", sfx: [{ file: "bundled:riser-1s", at_sec: 1.5 }, { file: "bundled:hit-deep", at_sec: 1.5 }] },
      ]),
      catalog,
      undefined,
      fine,
    );
    expect(fine).toEqual([]);
  });

  it("sfx_over_voice: a peak inside a spoken word, only with voice timings", () => {
    const state = { voice: { timing_source: "aligned" }, scenes: [{ scene_id: "s01", duration_ms: 2000 }] };
    const tracks = [{ scene_id: "s01", duration_ms: 2000, words: [{ word: "hello", start_ms: 500, end_ms: 900 }] }];
    const under = spec([{ id: "s01", sfx: [{ file: "bundled:pop", at_sec: 0.7 }] }]);
    const out: LintFinding[] = [];
    checkSfxOverVoice(under, state, tracks, catalog, out);
    expect(out).toEqual([expect.objectContaining({ id: "sfx_over_voice", scene_id: "s01", message: expect.stringMatching(/during "hello"/), fix: expect.stringMatching(/bundled:pop to at_sec 0\.9 \(after "hello"\)/) })]);
    const clear: LintFinding[] = [];
    checkSfxOverVoice(spec([{ id: "s01", sfx: [{ file: "bundled:pop", at_sec: 1.2 }] }]), state, tracks, catalog, clear);
    checkSfxOverVoice(under, { ...state, voice: { timing_source: "none" } }, tracks, catalog, clear);
    checkSfxOverVoice(under, undefined, undefined, catalog, clear);
    expect(clear).toEqual([]);
  });
});

describe("lintProject wiring", () => {
  it("reports clichés from research-specs/cliches.yaml and busy crossfades", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-lint-sc-"));
    cpSync(join(import.meta.dirname, "__fixtures__", "lint", "tiktok-low-captions"), dir, { recursive: true });
    const p = join(dir, "project", "video-spec.json");
    const s = JSON.parse(readFileSync(p, "utf8"));
    s.scenes[0].voiceover = "Honestly, this is a game-changer.";
    writeFileSync(p, JSON.stringify(s, null, 2));
    mkdirSync(join(dir, "qa"), { recursive: true });
    const r = await lintProject(dir);
    expect(r.findings.filter((f) => f.id === "cliche")).toEqual([expect.objectContaining({ scene_id: s.scenes[0].id })]);
  });
});

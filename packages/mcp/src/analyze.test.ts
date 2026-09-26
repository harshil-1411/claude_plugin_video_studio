import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type TimedWord, runFfmpeg } from "@video-studio/media";
import { type ContentIR, SCHEMA_VERSION, ShortCandidates } from "@video-studio/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeVideo, aspectRatioOf, findCaptionBand, findShorts, formatGrammar, formatShorts, pacingFor } from "./analyze.js";
import { makeShortProjects } from "./shorts.js";
import { hookScore, scoreShorts } from "./shorts.js";
import { applyTranscript } from "./transcribe.js";

const FONT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fonts/Inter/Inter-Bold.ttf");

let dir: string;

function ff(args: string[]): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vs-analyze-"));
  ff([
    "-f", "lavfi", "-i", "testsrc=size=160x120:rate=15:duration=2",
    "-f", "lavfi", "-i", "mandelbrot=size=160x120:rate=15",
    "-f", "lavfi", "-i", "smptebars=size=160x120:rate=15:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
    "-filter_complex", "[1:v]trim=duration=2,setpts=PTS-STARTPTS[m];[0:v][m][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]",
    "-map", "[v]", "-map", "3:a", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", join(dir, "three.mp4"),
  ]);
  const base = "color=c=0x336699:size=180x320:rate=15:duration=2";
  ff(["-f", "lavfi", "-i", base, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", join(dir, "plain.mp4")]);
  ff([
    "-f", "lavfi", "-i", base,
    "-vf", `drawtext=fontfile=${FONT.replace(/:/g, "\\:")}:text='SAY IT LOUD':fontsize=26:fontcolor=white:x=(w-tw)/2:y=h*0.72`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", join(dir, "text.mp4"),
  ]);
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("analyze helpers", () => {
  it("maps pacing and aspect ratios", () => {
    expect(pacingFor(1.5)).toBe("fast");
    expect(pacingFor(3)).toBe("medium");
    expect(pacingFor(6)).toBe("slow");
    expect(aspectRatioOf(1080, 1920)).toBe("9:16");
    expect(aspectRatioOf(160, 120)).toBe("4:3");
    expect(aspectRatioOf(1000, 300)).toBe("10:3");
  });

  it("finds a dense multi-row band in the lower two-thirds and ignores lone lines", () => {
    const rows = new Array(100).fill(0.01);
    for (let y = 70; y < 80; y++) rows[y] = 0.3;
    expect(findCaptionBand(rows)).toEqual({ y_from: 0.7, y_to: 0.8 });
    const line = new Array(100).fill(0.01);
    line[60] = 1;
    expect(findCaptionBand(line)).toBeNull();
    const top = new Array(100).fill(0.01);
    for (let y = 5; y < 15; y++) top[y] = 0.3;
    expect(findCaptionBand(top)).toBeNull();
  });
});

describe("analyzeVideo", () => {
  it("measures shots, pacing, speech share and loudness of a 3-shot video; writes qa/analysis", async () => {
    const project = join(dir, "proj");
    const g = await analyzeVideo(join(dir, "three.mp4"), { projectDir: project });
    expect(g.duration_sec).toBeCloseTo(6, 0);
    expect(g.aspect_ratio).toBe("4:3");
    expect(g.shots.length).toBeGreaterThanOrEqual(2);
    expect(g.shots.length).toBeLessThanOrEqual(4);
    expect(g.pacing).toBe(g.avg_shot_sec < 2 ? "fast" : "medium");
    expect(g.hook_shot_sec).toBeCloseTo(g.shots[0]!.end_sec, 3);
    expect(g.cuts_per_10s).toBeCloseTo(((g.shots.length - 1) / g.duration_sec) * 10, 2);
    expect(g.speech_ratio).toBeGreaterThan(0.8);
    expect(g.loudness_lufs).toBeTypeOf("number");
    const json = JSON.parse(await readFile(join(project, "qa", "analysis.json"), "utf8"));
    expect(json.report_md).toBeUndefined();
    expect(json.shots).toEqual(g.shots);
    expect(await readFile(join(project, "qa", "analysis.md"), "utf8")).toContain("# Format grammar");
    expect(formatGrammar(g)).toMatch(/pacing \*\*(fast|medium)\*\*/);
  }, 60_000);

  it("finds the caption band of burned-in text, and none on a plain video", async () => {
    const withText = await analyzeVideo(join(dir, "text.mp4"));
    expect(withText.caption_band).not.toBeNull();
    expect(withText.caption_band!.y_from).toBeGreaterThan(0.6);
    expect(withText.caption_band!.y_to).toBeLessThan(0.9);
    expect(withText.has_speech).toBe(false);
    const plain = await analyzeVideo(join(dir, "plain.mp4"));
    expect(plain.caption_band).toBeNull();
    expect(plain.aspect_ratio).toBe("9:16");
  }, 60_000);
});

// ---------------------------------------------------------------------------------- shorts

/** Words of `text` from `t0` (ms), 350 ms each with 100 ms gaps; returns words and the end time. */
function say(text: string, t0: number): { words: TimedWord[]; end: number } {
  const words: TimedWord[] = [];
  let t = t0;
  for (const w of text.split(" ")) {
    words.push({ word: w, start_ms: t, end_ms: t + 350 });
    t += 450;
  }
  return { words, end: t - 100 };
}

const FILLER = [
  "and then we kept going with the plan for a while.",
  "so the team met every week to talk it through.",
  "it was a slow and steady kind of process for us.",
  "but nothing much changed in the numbers that year.",
];

async function syntheticProject(): Promise<{ project: string; questionStart: number; cut: number }> {
  const project = join(dir, "shorts");
  const words: TimedWord[] = [];
  let t = 0;
  let questionStart = 0;
  const sentences: string[] = [];
  for (let i = 0; i < 12; i++) sentences.push(FILLER[i % FILLER.length]!);
  sentences.splice(5, 0, "Why do most startups fail in their first year?", "The answer is that they run out of cash too early.", "Here is how to avoid that.");
  for (const [i, s] of sentences.entries()) {
    if (i === 5) questionStart = t;
    const r = say(s, t);
    words.push(...r.words);
    t = r.end + 600;
    if (i === 9) t += 4000; // dead air
  }
  const cut = (questionStart - 300) / 1000;
  const sha = "a".repeat(64);
  const ir: ContentIR = {
    schema_version: SCHEMA_VERSION,
    id: "ir-shorts",
    created_at: "2026-09-25T00:00:00.000Z",
    sources: [{ id: "src-1", kind: "video", uri: "/x/talk.mp4", sha256: sha, title: "talk" }],
    sections: [],
    evidence: [],
    entities: [],
    claims: [],
    assets: [
      {
        id: "asset-1",
        kind: "video",
        path: "source/assets/talk.mp4",
        sha256: sha,
        source_ref: "video:talk.mp4",
        media: {
          duration_sec: t / 1000,
          has_video: true,
          has_audio: true,
          shots: [
            { start_sec: 0, end_sec: cut },
            { start_sec: cut, end_sec: t / 1000 },
          ],
        },
      },
    ],
    classification: { contains_secrets: false, contains_pii: false, contains_likeness: true, data_class: "internal", notes: [] },
    warnings: [],
  };
  const path = "source/transcripts/asset-1.json";
  const applied = applyTranscript(ir, "asset-1", words, { path, source: "srt" });
  await mkdir(join(project, "source", "transcripts"), { recursive: true });
  await writeFile(join(project, path), JSON.stringify(words));
  await writeFile(join(project, "source", "content-ir.json"), JSON.stringify(applied.ir));
  return { project, questionStart, cut };
}

describe("shorts", () => {
  it("scores hooks", () => {
    expect(hookScore("Why do most startups fail?").score).toBe(1);
    expect(hookScore("We grew 40% in a year.").score).toBe(0.9);
    expect(hookScore("and then we kept going.").score).toBeLessThan(0.3);
  });

  it("returns sentence-aligned, non-overlapping, scored spans snapped to shot cuts", async () => {
    const { project, cut } = await syntheticProject();
    const r = await findShorts(project, "asset-1", { min_sec: 8, max_sec: 16, count: 3 });
    expect(r.candidates.length).toBeGreaterThanOrEqual(2);
    expect(r.candidates.length).toBeLessThanOrEqual(3);
    const ir = JSON.parse(await readFile(join(project, "source", "content-ir.json"), "utf8")) as ContentIR;
    const sentenceStarts = ir.evidence.map((e) => e.locator.time_start_sec!);
    const sentenceEnds = ir.evidence.map((e) => e.locator.time_end_sec!);
    for (const c of r.candidates) {
      const d = c.end_sec - c.start_sec;
      expect(d).toBeGreaterThanOrEqual(8);
      expect(d).toBeLessThanOrEqual(16);
      // Starts at or just before a sentence start; ends at or just after a sentence end.
      expect(sentenceStarts.some((s) => s >= c.start_sec && s - c.start_sec <= 1.0)).toBe(true);
      expect(sentenceEnds.some((e) => e <= c.end_sec && c.end_sec - e <= 1.0)).toBe(true);
      expect(r.evidence_refs[c.id]!.length).toBeGreaterThan(0);
      expect(c.hook).toBe(ir.evidence.find((e) => e.ref === r.evidence_refs[c.id]![0])!.text);
    }
    for (const a of r.candidates) for (const b of r.candidates) if (a !== b) expect(a.end_sec <= b.start_sec || b.end_sec <= a.start_sec).toBe(true);
    const scores = r.candidates.map((c) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);

    const top = r.candidates[0]!;
    expect(top.hook).toBe("Why do most startups fail in their first year?");
    expect(top.start_sec).toBeCloseTo(cut, 3);
    expect(top.reasons.join(" ")).toMatch(/question[\s\S]*snapped to shot cut/);
    // The span across the 4 s pause is penalised as dead air if picked at all.
    for (const c of r.candidates) if (/dead air/.test(c.reasons.join()) && !/no dead air/.test(c.reasons.join())) expect(c.score).toBeLessThan(top.score);

    const file = ShortCandidates.parse(JSON.parse(await readFile(join(project, "qa", "shorts.json"), "utf8")));
    expect(file.candidates).toEqual(r.candidates);
    expect(formatShorts(r)).toMatch(/short-1 .* score[\s\S]*claim_refs: video:talk\.mp4#t=/);
  });

  it("turns chosen candidates into valid talking-head projects under shorts/<id>/, copying only their span", async () => {
    const { project } = await syntheticProject();
    const ir = JSON.parse(await readFile(join(project, "source", "content-ir.json"), "utf8")) as ContentIR;
    const full = ir.assets[0]!.media!.duration_sec;
    // A real (tiny) recording for the trim: the transcript timeline is synthetic.
    await mkdir(join(project, "source", "assets"), { recursive: true });
    await runFfmpeg(["-y", "-f", "lavfi", "-i", `color=c=gray:s=160x90:r=10:d=${full}`, "-f", "lavfi", "-i", `sine=frequency=220:sample_rate=48000:duration=${full}`, "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", join(project, "source", "assets", "talk.mp4")]);
    const r = await findShorts(project, "asset-1", { min_sec: 8, max_sec: 16, count: 2 });
    const made = await makeShortProjects(project, r, { ids: [r.candidates[0]!.id] });
    expect(made).toHaveLength(1);
    const m = made[0]!;
    expect(m.errors).toEqual([]);
    expect(m.valid).toBe(true);
    const spec = JSON.parse(await readFile(join(project, m.project_dir, "project", "video-spec.json"), "utf8"));
    expect(spec.voice).toEqual({ mode: "native" });
    expect(spec.scenes[0]).toMatchObject({ purpose: "hook", visual_strategy: "user_asset", voiceover: "", audio: { mode: "native" } });
    const offset = Math.max(0, r.candidates[0]!.start_sec - 1);
    expect(spec.scenes[0].footage.in_sec).toBeCloseTo(r.candidates[0]!.start_sec - offset, 2);
    expect(spec.scenes.at(-1).footage.out_sec).toBeCloseTo(r.candidates[0]!.end_sec - offset, 2);
    expect(spec.scenes.every((sc: { duration_sec: number }) => sc.duration_sec <= 12.5)).toBe(true);
    expect(spec.scenes.flatMap((sc: { claim_refs: string[] }) => sc.claim_refs)).toEqual(r.evidence_refs[r.candidates[0]!.id]);
    // Only the span (± 1 s) was copied, as the short's single asset; footage times are relative to it.
    const shortIr = JSON.parse(await readFile(join(project, m.project_dir, "source", "content-ir.json"), "utf8")) as ContentIR;
    expect(shortIr.assets).toHaveLength(1);
    const a = shortIr.assets[0]!;
    expect(a.path).toBe(`source/assets/asset-1-${m.id}.mp4`);
    const span = r.candidates[0]!.end_sec - r.candidates[0]!.start_sec;
    expect(a.media!.duration_sec).toBeLessThan(span + 2.5);
    expect(a.media!.duration_sec).toBeLessThan(full / 2);
    expect(spec.scenes[0].footage.in_sec).toBeLessThanOrEqual(1.01);
    await expect(readFile(join(project, m.project_dir, "source", "assets", "talk.mp4"))).rejects.toThrow();
    const words = JSON.parse(await readFile(join(project, m.project_dir, "source", "transcripts", "asset-1.json"), "utf8")) as Array<{ start_ms: number }>;
    expect(words[0]!.start_ms).toBeLessThan(1500);
  });

  it("needs a transcript", async () => {
    const { project } = await syntheticProject();
    const irPath = join(project, "source", "content-ir.json");
    const ir = JSON.parse(await readFile(irPath, "utf8")) as ContentIR;
    delete ir.assets[0]!.media!.transcript;
    await writeFile(irPath, JSON.stringify(ir));
    await expect(findShorts(project, "asset-1")).rejects.toThrow(/run transcribe/);
  });
});

describe("shorts with speaker labels", () => {
  /** Alternating speakers: each sentence by S1 or S2 as given. */
  function dialogue(parts: Array<[string, string]>): TimedWord[] {
    const words: TimedWord[] = [];
    let t = 0;
    for (const [speaker, text] of parts) {
      const r = say(text, t);
      words.push(...r.words.map((w) => ({ ...w, speaker })));
      t = r.end + 600;
    }
    return words;
  }
  const parts: Array<[string, string]> = [
    ["S1", "Why do most startups fail in their first year?"],
    ["S1", "The answer is that they run out of cash too early."],
    ["S2", "So what should a founder do about that?"],
    ["S1", "Here is how to avoid that problem for good."],
    ["S2", "and then we kept going with the plan for a while."],
    ["S2", "so the team met every week to talk it through."],
  ];

  it("reports the speakers of each span and keeps one speaker's spans with speaker", () => {
    const words = dialogue(parts);
    const all = scoreShorts(words, [], { min_sec: 3, max_sec: 12, count: 5 });
    expect(all.every((c) => c.speakers && c.speakers.length >= 1)).toBe(true);
    expect(all.some((c) => c.reasons.some((r) => /single speaker|2 speakers/.test(r)))).toBe(true);
    const s2 = scoreShorts(words, [], { min_sec: 3, max_sec: 12, count: 5, speaker: "S2" });
    expect(s2.length).toBeGreaterThan(0);
    for (const c of s2) {
      expect(c.speakers).toEqual(["S2"]);
      expect(words.slice(c.sentences[0]!.first, c.sentences.at(-1)!.last + 1).every((w) => w.speaker === "S2")).toBe(true);
    }
  });

  it("prefers a single speaker over the same span with a speaker change", () => {
    const three = parts.slice(0, 3);
    const one = dialogue(three.map(([, t]) => ["S1", t] as [string, string]));
    const mixed = dialogue(three);
    const total = one.at(-1)!.end_ms / 1000;
    const opts = { min_sec: total - 0.5, max_sec: total + 1, count: 1 };
    const a = scoreShorts(one, [], opts)[0]!;
    const b = scoreShorts(mixed, [], opts)[0]!;
    expect([a.start_sec, a.end_sec]).toEqual([b.start_sec, b.end_sec]);
    expect(a.speakers).toEqual(["S1"]);
    expect(b.speakers).toEqual(["S1", "S2"]);
    expect(b.score).toBeCloseTo(a.score - 0.05, 6);
  });

  it("leaves candidates unchanged without speaker data and refuses a speaker filter", async () => {
    const plain = scoreShorts(dialogue(parts).map(({ speaker: _s, ...w }) => w), [], { min_sec: 3, max_sec: 12, count: 3 });
    expect(plain.every((c) => c.speakers === undefined && !c.reasons.some((r) => /speaker/.test(r)))).toBe(true);
    const { project } = await syntheticProject();
    await expect(findShorts(project, "asset-1", { min_sec: 8, max_sec: 16, speaker: "S1" })).rejects.toThrow(/no speaker labels[\s\S]*speakers: true/);
  });
});

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TimedWord, ffprobe, runFfmpeg } from "@video-studio/media";
import { ContentIR, SCHEMA_VERSION } from "@video-studio/schema";
import { checkJoins, compareJoinAsr, planTighten, retimeWords, tightenAsset } from "./tighten.js";
import { applyTranscript } from "./transcribe.js";

/** Words at a steady 300 ms each, with an optional gap before some. */
function say(text: string, startMs: number, gapBefore: Record<number, number> = {}): { words: TimedWord[]; end: number } {
  let t = startMs;
  const words = text.split(" ").map((w, i) => {
    t += gapBefore[i] ?? 0;
    const word = { word: w, start_ms: t, end_ms: t + 300 };
    t += 320;
    return word;
  });
  return { words, end: t };
}

describe("planTighten (pure)", () => {
  it("shortens long pauses, keeps short ones, and trims the edges", () => {
    const a = say("First point here.", 1500);
    const b = say("Second point there.", a.end + 2000);
    const c = say("Third one now.", b.end + 400);
    const words = [...a.words, ...b.words, ...c.words];
    const p = planTighten(words, c.end + 3000);
    const silences = p.cuts.filter((x) => x.reason === "silence");
    expect(silences).toHaveLength(3); // leading 1.5 s, the 2 s pause, trailing 3 s; the 400 ms pause stays
    expect(p.result_ms).toBeLessThan(p.source_ms - 5000);
    const moved = retimeWords(words, p.keep);
    expect(moved).toHaveLength(words.length);
    expect(moved[0]!.start_ms).toBeLessThanOrEqual(150); // leading silence trimmed to half a kept pause
    const gap = moved[3]!.start_ms - moved[2]!.end_ms; // "here." → "Second"
    expect(gap).toBeGreaterThan(250);
    expect(gap).toBeLessThan(400); // 2 s pause shortened to about 300 ms
  });

  it("cuts fillers and drops false starts and explicit retakes", () => {
    const a = say("So um the pipeline has.", 0);
    const b = say("So the pipeline has three stages.", a.end + 300);
    const c = say("Sorry, let me start again.", b.end + 300);
    const d = say("It ingests, plans and renders.", c.end + 300);
    const words = [...a.words, ...b.words, ...c.words, ...d.words];
    const p = planTighten(words, d.end + 200);
    expect(p.cuts.filter((x) => x.reason === "retake").map((x) => x.text)).toEqual(["So um the pipeline has.", "Sorry, let me start again."]);
    const kept = retimeWords(words, p.keep).map((w) => w.word).join(" ");
    expect(kept).toBe("So the pipeline has three stages. It ingests, plans and renders.");
  });

  it("keeps everything when every rule is off", () => {
    const a = say("Um hello.", 2000);
    const p = planTighten(a.words, a.end + 2000, { silences: false, fillers: false, retakes: false });
    expect(p.cuts).toEqual([]);
    expect(p.result_ms).toBe(p.source_ms);
  });
});

describe("checkJoins (pure)", () => {
  const words = say("we built the the engine today", 0).words; // each word 300 ms, 20 ms gaps

  it("flags a cut inside a word with the nearest word gap as the fix", () => {
    // "built" is 320–620: the left part ends at 400, inside it.
    const joins = checkJoins(words, [{ start_ms: 0, end_ms: 400 }, { start_ms: 1300, end_ms: 1900 }]);
    expect(joins).toHaveLength(1);
    const f = joins[0]!.findings.find((x) => x.kind === "partial_word")!;
    expect(f).toMatchObject({ words: ["built"], boundary: "out", suggested_ms: 320 });
    expect(f.fix).toMatch(/inside "built"[\s\S]*320 ms \(before the word\)/);
    expect(joins[0]).toMatchObject({ index: 0, out_ms: 400, in_ms: 1300, at_ms: 400 });
  });

  it("flags the same content word on both sides of a join (fillers and case ignored)", () => {
    const w = [...say("we built the", 0).words, { word: "um", start_ms: 960, end_ms: 1200 }, ...say("The engine", 1300).words];
    // Cut the filler only: "the" | "The".
    const joins = checkJoins(w, [{ start_ms: 0, end_ms: 950 }, { start_ms: 1250, end_ms: 1900 }]);
    const f = joins[0]!.findings;
    expect(f.map((x) => x.kind)).toEqual(["repeated_word"]);
    expect(f[0]).toMatchObject({ words: ["the", "The"], boundary: "out", suggested_ms: 640 });
  });

  it("reports a clean join with no findings", () => {
    const joins = checkJoins(words, [{ start_ms: 0, end_ms: 630 }, { start_ms: 1270, end_ms: 1900 }]);
    expect(joins[0]).toMatchObject({ left: "built", right: "engine", findings: [] });
  });

  it("compares what whisper heard around a join", () => {
    const expected = say("one two three four five six", 0).words;
    const win = { start_ms: 0, end_ms: 1920 };
    expect(compareJoinAsr(expected, expected, win)).toBeUndefined();
    expect(compareJoinAsr(expected, say("won to tree for", 0).words, win)).toMatchObject({ kind: "join_mismatch" });
    expect(compareJoinAsr(expected, say("one two three three four five six", 0).words, win)?.fix).toMatch(/heard twice/);
  });
});

describe("tightenAsset (tiny ffmpeg)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vs-tighten-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("dry run lists the cuts; apply writes a shorter new asset with a re-timed transcript", async () => {
    const a = say("Um welcome to the demo.", 1200);
    const b = say("Here is the first feature.", a.end + 2500);
    const words = [...a.words, ...b.words];
    const dur = (b.end + 1500) / 1000;
    await mkdir(join(dir, "source", "assets"), { recursive: true });
    await mkdir(join(dir, "source", "transcripts"), { recursive: true });
    const video = join(dir, "source", "assets", "talk.mp4");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", `testsrc2=s=160x90:r=10:d=${dur}`, "-f", "lavfi", "-i", `sine=frequency=220:sample_rate=48000:duration=${dur}`, "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", video]);
    await writeFile(join(dir, "source", "transcripts", "asset-1.json"), JSON.stringify(words));
    const sha = "b".repeat(64);
    const base: ContentIR = {
      schema_version: SCHEMA_VERSION,
      id: "ir-t",
      created_at: "2026-09-26T00:00:00.000Z",
      sources: [{ id: "src-1", kind: "video", uri: "talk.mp4", sha256: sha }],
      sections: [],
      evidence: [],
      entities: [],
      claims: [],
      assets: [{ id: "asset-1", kind: "video", path: "source/assets/talk.mp4", sha256: sha, source_ref: "video:talk.mp4", media: { duration_sec: dur, has_video: true, has_audio: true } }],
      classification: { contains_secrets: false, contains_pii: false, contains_likeness: true, data_class: "internal", notes: [] },
      warnings: [],
    };
    const { ir } = applyTranscript(base, "asset-1", words, { path: "source/transcripts/asset-1.json", source: "srt" });
    await writeFile(join(dir, "source", "content-ir.json"), JSON.stringify(ir));

    const dry = await tightenAsset(dir, "asset-1");
    expect(dry.dry_run).toBe(true);
    expect(dry.counts).toMatchObject({ filler: 1, silence: 3 });
    expect(dry.new_asset).toBeUndefined();

    const r = await tightenAsset(dir, "asset-1", { apply: true });
    expect(r.new_asset).toBe("asset-1-tight");
    const p = await ffprobe(join(dir, r.path!));
    expect(p.has_video && p.has_audio).toBe(true);
    expect(Math.abs(p.duration_s * 1000 - r.plan.result_ms)).toBeLessThan(200);
    expect(p.duration_s).toBeLessThan(dur - 3);
    const next = ContentIR.parse(JSON.parse(await readFile(join(dir, "source", "content-ir.json"), "utf8")));
    const asset = next.assets.find((x) => x.id === "asset-1-tight")!;
    expect(asset.media?.transcript?.words).toBe(words.length - 1); // "Um" is gone
    expect(next.evidence.some((e) => e.ref.startsWith("video:asset-1-tight.mp4#t="))).toBe(true);
    expect(next.assets.find((x) => x.id === "asset-1")).toBeDefined(); // the original stays
    const tw = JSON.parse(await readFile(join(dir, "source", "transcripts", "asset-1-tight.json"), "utf8")) as TimedWord[];
    expect(tw[0]!.word).toBe("welcome");
    expect(tw[0]!.start_ms).toBeLessThan(400);
  }, 60_000);
});

describe("tightenAsset joins, refusal, pacing_from and the whisper check", () => {
  let dir: string;
  const sha = "c".repeat(64);
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vs-tighten-joins-"));
    await mkdir(join(dir, "source", "assets"), { recursive: true });
    await mkdir(join(dir, "source", "transcripts"), { recursive: true });
    // 6.4 s: sine bursts 0.5–1.5, 1.9–2.9, 3.1–4.1, 4.9–5.9 (pauses 400, 200, 800 ms).
    const on = "between(t,0.5,1.5)+between(t,1.9,2.9)+between(t,3.1,4.1)+between(t,4.9,5.9)";
    await runFfmpeg(["-y", "-f", "lavfi", "-i", `aevalsrc='if(${on},0.5*sin(2*PI*440*t),0)':s=48000:d=6.4`, "-c:a", "aac", join(dir, "source", "assets", "talk.m4a")]);
  }, 60_000);
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const setup = async (words: TimedWord[]) => {
    const base: ContentIR = {
      schema_version: SCHEMA_VERSION,
      id: "ir-j",
      created_at: "2026-09-27T00:00:00.000Z",
      sources: [{ id: "src-1", kind: "audio", uri: "talk.m4a", sha256: sha }],
      sections: [],
      evidence: [],
      entities: [],
      claims: [],
      assets: [{ id: "asset-1", kind: "audio", path: "source/assets/talk.m4a", sha256: sha, source_ref: "audio:talk.m4a", media: { duration_sec: 6.4, has_video: false, has_audio: true } }],
      classification: { contains_secrets: false, contains_pii: false, contains_likeness: false, data_class: "internal", notes: [] },
      warnings: [],
    };
    await writeFile(join(dir, "source", "transcripts", "asset-1.json"), JSON.stringify(words));
    const { ir } = applyTranscript(base, "asset-1", words, { path: "source/transcripts/asset-1.json", source: "srt" });
    await writeFile(join(dir, "source", "content-ir.json"), JSON.stringify(ir));
  };

  it("refuses to apply a join inside a word unless forced; the plan lists every join", async () => {
    // Overlapping timings (hand-edited or merged transcripts): cutting the filler "um" cuts into "second".
    const words: TimedWord[] = [
      { word: "First", start_ms: 500, end_ms: 1500 },
      { word: "um", start_ms: 1900, end_ms: 2600 },
      { word: "second", start_ms: 2400, end_ms: 4100 },
      { word: "third.", start_ms: 4900, end_ms: 5900 },
    ];
    await setup(words);
    const dry = await tightenAsset(dir, "asset-1", { max_pause_ms: 250, keep_pause_ms: 100 });
    expect(dry.asr_check).toMatchObject({ status: "not_run", reason: expect.stringMatching(/dry run/) });
    const edl = JSON.parse(await readFile(join(dir, dry.edl_path), "utf8"));
    expect(edl.joins).toEqual(dry.joins);
    const partial = dry.joins.flatMap((j) => j.findings).filter((f) => f.kind === "partial_word");
    expect(partial.length).toBeGreaterThan(0);
    await expect(tightenAsset(dir, "asset-1", { max_pause_ms: 250, keep_pause_ms: 100, apply: true })).rejects.toThrow(/refusing to apply: \d+ join\(s\) cut inside a word[\s\S]*"second"[\s\S]*force: true/);
    const forced = await tightenAsset(dir, "asset-1", { max_pause_ms: 250, keep_pause_ms: 100, apply: true, force: true }, { whisper: async () => [] });
    expect(forced.new_asset).toBe("asset-1-tight");
  }, 60_000);

  it("derives pause limits from pacing_from (analysis.json or an asset) and records them", async () => {
    const words: TimedWord[] = [
      { word: "One", start_ms: 500, end_ms: 1500 },
      { word: "two", start_ms: 1900, end_ms: 2900 },
      { word: "three", start_ms: 3100, end_ms: 4100 },
      { word: "four.", start_ms: 4900, end_ms: 5900 },
    ];
    await setup(words);
    await mkdir(join(dir, "qa"), { recursive: true });
    const grammar = { schema_version: SCHEMA_VERSION, duration_sec: 10, aspect_ratio: "9:16", shots: [], avg_shot_sec: 10, cuts_per_10s: 0, hook_shot_sec: 10, caption_band: null, pacing: "slow", notes: [], speech_pacing: { silence_share: 0.1, pauses_analyzed: 5, pause_median_ms: 180, pause_p95_ms: 350 } };
    await writeFile(join(dir, "qa", "ref-analysis.json"), JSON.stringify(grammar));
    const r = await tightenAsset(dir, "asset-1", { pacing_from: "qa/ref-analysis.json" });
    expect(r.pacing).toMatchObject({ from: "qa/ref-analysis.json", max_pause_ms: 350, keep_pause_ms: 180 });
    // 400 and 800 ms pauses are over 350: shortened; the 200 ms pause stays.
    expect(r.plan.cuts.filter((c) => c.reason === "silence").length).toBe(4); // + lead-in and tail
    expect(JSON.parse(await readFile(join(dir, r.edl_path), "utf8")).pacing.max_pause_ms).toBe(350);
    // An asset measures its own pauses: 400/200/800 → p95 800, median 400.
    const self = await tightenAsset(dir, "asset-1", { pacing_from: "asset-1" });
    expect(self.pacing!.max_pause_ms).toBeGreaterThan(700);
    expect(self.pacing!.keep_pause_ms).toBeGreaterThan(300);
    await expect(tightenAsset(dir, "asset-1", { pacing_from: "../x.json" })).rejects.toThrow(/inside the project/);
    await expect(tightenAsset(dir, "asset-1", { pacing_from: "nope" })).rejects.toThrow(/neither/);
  }, 60_000);

  it("re-transcribes around each join after apply: ok, mismatch, or not_run without whisper", async () => {
    const words: TimedWord[] = [
      { word: "One", start_ms: 500, end_ms: 1500 },
      { word: "two", start_ms: 1900, end_ms: 2900 },
      { word: "three", start_ms: 3100, end_ms: 4100 },
      { word: "four.", start_ms: 4900, end_ms: 5900 },
    ];
    await setup(words);
    const opts = { max_pause_ms: 300, keep_pause_ms: 100, apply: true };
    const ranges: Array<{ start_ms: number; end_ms: number }> = [];
    let newWords: TimedWord[] = [];
    const echo = async (_p: string, range: { start_ms: number; end_ms: number }) => {
      ranges.push(range);
      return newWords.filter((w) => w.end_ms > range.start_ms && w.start_ms < range.end_ms);
    };
    // First pass to learn the re-timed words the stand-in whisper should "hear".
    const first = await tightenAsset(dir, "asset-1", opts, { whisper: async () => [] });
    newWords = JSON.parse(await readFile(join(dir, "source", "transcripts", "asset-1-tight.json"), "utf8"));
    await setup(words);
    const ok = await tightenAsset(dir, "asset-1", opts, { whisper: echo });
    expect(ok.asr_check).toEqual({ status: "ok", checked: ok.joins.length });
    expect(ranges).toHaveLength(ok.joins.length);
    expect(ranges[0]!.end_ms - ranges[0]!.start_ms).toBeLessThanOrEqual(4000);
    expect(first.joins.length).toBe(ok.joins.length);

    await setup(words);
    const bad = await tightenAsset(dir, "asset-1", opts, { whisper: async () => [{ word: "static", start_ms: 0, end_ms: 100 }] });
    expect(bad.asr_check.status).toBe("mismatch");
    expect(bad.joins.some((j) => j.findings.some((f) => f.kind === "join_mismatch"))).toBe(true);

    await setup(words);
    const none = await tightenAsset(dir, "asset-1", opts, { env: { CLAUDE_PLUGIN_DATA: join(dir, "no-data") } });
    expect(none.asr_check).toMatchObject({ status: "not_run", reason: expect.stringMatching(/no whisper model/) });
  }, 60_000);
});

const WHISPER_MODEL = process.env.VS_TEST_WHISPER_MODEL;
describe.skipIf(!WHISPER_MODEL || !existsSync(WHISPER_MODEL))("tighten join check with whisper.cpp (VS_TEST_WHISPER_MODEL)", () => {
  it("re-transcribes the joins of tightened speech", async () => {
    const wav = process.env.VS_TEST_WHISPER_AUDIO ?? join(dirname(WHISPER_MODEL!), "jfk.wav");
    const dir = await mkdtemp(join(tmpdir(), "vs-tighten-whisper-"));
    try {
      const { ingest } = await import("@video-studio/ingestion");
      const { transcribeAsset } = await import("./transcribe.js");
      const { ir } = await ingest([wav], { projectDir: dir, noCache: true });
      const id = ir.assets[0]!.id;
      const env = { VS_WHISPER_MODEL: WHISPER_MODEL };
      await transcribeAsset(dir, id, { env });
      const r = await tightenAsset(dir, id, { max_pause_ms: 250, keep_pause_ms: 120, apply: true, force: true }, { env });
      expect(r.asr_check.status).not.toBe("not_run");
      expect(r.asr_check.checked).toBe(Math.min(r.joins.length, 40));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});

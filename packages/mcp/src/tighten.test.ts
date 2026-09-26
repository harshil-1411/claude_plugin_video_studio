import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TimedWord, ffprobe, runFfmpeg } from "@video-studio/media";
import { ContentIR, SCHEMA_VERSION } from "@video-studio/schema";
import { planTighten, retimeWords, tightenAsset } from "./tighten.js";
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

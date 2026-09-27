import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg } from "@video-studio/media";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { measureSpeechPacing, pacingLimits, parseSilences, soundShareOf, speechPacing } from "./speech-pacing.js";

describe("speech pacing (pure)", () => {
  it("parses silencedetect output; an open silence runs to the end", () => {
    const stderr = "[silencedetect @ 0x1] silence_start: 0\n[silencedetect @ 0x1] silence_end: 0.5 | silence_duration: 0.5\nsilence_start: 1.5\nsilence_end: 1.9 | x\nsilence_start: 5.2\n";
    expect(parseSilences(stderr, 6000)).toEqual([
      { start_ms: 0, end_ms: 500 },
      { start_ms: 1500, end_ms: 1900 },
      { start_ms: 5200, end_ms: 6000 },
    ]);
  });

  it("keeps only pauses inside speech and reports median/p95 (nearest rank)", () => {
    const sil = [
      { start_ms: 0, end_ms: 500 }, // lead-in
      { start_ms: 1500, end_ms: 1900 },
      { start_ms: 2900, end_ms: 3100 },
      { start_ms: 4100, end_ms: 4900 },
      { start_ms: 5900, end_ms: 6400 }, // tail
    ];
    const p = speechPacing(sil, 6400);
    expect(p).toEqual({ silence_share: Math.round((1400 / 5400) * 1000) / 1000, pauses_analyzed: 3, pause_median_ms: 400, pause_p95_ms: 800 });
    // speech_ratio counts silences of 300 ms or more only (the 200 ms pause is sound).
    expect(soundShareOf(sil, 6400)).toBeCloseTo(1 - 2200 / 6400, 5);
    expect(speechPacing([], 3000)).toEqual({ silence_share: 0, pauses_analyzed: 0, pause_median_ms: null, pause_p95_ms: null });
    expect(speechPacing([{ start_ms: 0, end_ms: 3000 }], 3000).silence_share).toBe(1);
  });

  it("turns pacing into tighten limits with clamps", () => {
    expect(pacingLimits({ silence_share: 0.2, pauses_analyzed: 3, pause_median_ms: 400, pause_p95_ms: 800 })).toEqual({ max_pause_ms: 800, keep_pause_ms: 400 });
    expect(pacingLimits({ silence_share: 0.5, pauses_analyzed: 9, pause_median_ms: 1200, pause_p95_ms: 4000 })).toEqual({ max_pause_ms: 1500, keep_pause_ms: 600 });
    expect(pacingLimits({ silence_share: 0.05, pauses_analyzed: 9, pause_median_ms: 60, pause_p95_ms: 110 })).toEqual({ max_pause_ms: 250, keep_pause_ms: 120 });
    expect(() => pacingLimits({ silence_share: 0, pauses_analyzed: 0, pause_median_ms: null, pause_p95_ms: null })).toThrow(/no pauses/);
  });
});

describe("measureSpeechPacing (synthetic speech/silence track)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vs-pacing-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("finds the known gaps between sine bursts", async () => {
    // 0.5 s lead-in, 1 s bursts separated by 400, 200 and 800 ms, 0.5 s tail.
    const on = "between(t,0.5,1.5)+between(t,1.9,2.9)+between(t,3.1,4.1)+between(t,4.9,5.9)";
    const wav = join(dir, "bursts.wav");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", `aevalsrc='if(${on},0.5*sin(2*PI*440*t),0)':s=16000:d=6.4`, "-c:a", "pcm_s16le", wav]);
    const p = await measureSpeechPacing(wav);
    expect(p.pauses_analyzed).toBe(3);
    expect(p.pause_median_ms).toBeGreaterThan(350);
    expect(p.pause_median_ms).toBeLessThan(450);
    expect(p.pause_p95_ms).toBeGreaterThan(750);
    expect(p.pause_p95_ms).toBeLessThan(850);
    expect(p.silence_share).toBeGreaterThan(0.2);
    expect(p.silence_share).toBeLessThan(0.3);
  });
});

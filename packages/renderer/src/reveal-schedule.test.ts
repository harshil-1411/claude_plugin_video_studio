import { describe, expect, it } from "vitest";
import { readingFloor, revealSchedule, revealShortfalls, revealWords } from "./reveal-schedule.js";

const grid = (bpm: number, dur: number) => Array.from({ length: Math.ceil((dur * bpm) / 60) }, (_, i) => Math.round(((i * 60) / bpm) * 1000) / 1000).filter((t) => t < dur);
const ONE = "Ship.";
const EIGHT = "Every render is cached by its scene hash";

describe("reading floors", () => {
  it("0.8 s for 1-3 words, else max(1.2 s, 0.3 s per word)", () => {
    expect(revealWords(EIGHT)).toBe(8);
    expect(readingFloor(ONE)).toBe(0.8);
    expect(readingFloor("Docs in, video")).toBe(0.8);
    expect(readingFloor("Docs in, video out")).toBe(1.2);
    expect(readingFloor(EIGHT)).toBe(2.4);
    expect(revealWords("動画を作る仕組み")).toBe(4);
  });
});

describe("revealSchedule", () => {
  it("120 BPM, 1-word items: every 3rd beat (1.5 s), never 0.5 s apart", () => {
    const r = revealSchedule({ texts: [ONE, ONE, ONE], beats: grid(120, 6), duration: 6 });
    expect(r).toEqual({ times: [0, 1.5, 3], floors: [0.8, 0.8, 0.8], too_dense: false });
  });

  it("174 BPM, 1-word items: every 4th beat", () => {
    const r = revealSchedule({ texts: [ONE, ONE, ONE], beats: grid(174, 6), duration: 6 });
    expect(r.times).toEqual([0, 1.379, 2.759]);
    expect(r.too_dense).toBe(false);
  });

  it("120 BPM, 8-word items: every 6th beat (3 s)", () => {
    const r = revealSchedule({ texts: [EIGHT, EIGHT], beats: grid(120, 6), duration: 6 });
    expect(r.times).toEqual([0, 3]);
    expect(r.floors).toEqual([2.4, 2.4]);
    expect(r.too_dense).toBe(false);
  });

  it("174 BPM, 8-word items: every 9th beat", () => {
    const r = revealSchedule({ texts: [EIGHT, EIGHT], beats: grid(174, 6.5), duration: 6.5 });
    expect(r.times).toEqual([0, 3.103]);
    expect(r.too_dense).toBe(false);
  });

  it("mixed lengths land on the first beat after each floor", () => {
    const r = revealSchedule({ texts: [EIGHT, ONE, ONE], beats: grid(120, 8), duration: 8 });
    expect(r.times).toEqual([0, 3, 4.5]);
  });

  it("without a grid, items land when their floor allows; downbeats serve when there are no beats", () => {
    expect(revealSchedule({ texts: [ONE, ONE], duration: 4 }).times).toEqual([0, 1.2]);
    expect(revealSchedule({ texts: [ONE, ONE], downbeats: [0, 2], duration: 4 }).times).toEqual([0, 2]);
    expect(revealSchedule({ texts: [ONE, ONE], beats: [0, 0.5, 1], duration: 4 }).times).toEqual([0, 1.2]);
  });

  it("too short for every floor: a quick reveal, all in early, too_dense", () => {
    const r = revealSchedule({ texts: [EIGHT, EIGHT, EIGHT], beats: grid(120, 3), duration: 3 });
    expect(r.too_dense).toBe(true);
    expect(r.times).toEqual([0, 0.2, 0.4]);
    const one = revealSchedule({ texts: [ONE, ONE, ONE, ONE], beats: grid(174, 2), duration: 2 });
    expect(one.too_dense).toBe(true);
    expect(one.times.at(-1)!).toBeLessThanOrEqual(0.8);
  });

  it("a schedule that is not too dense has no shortfalls; one that is does", () => {
    for (const bpm of [120, 174]) {
      for (const texts of [[ONE, ONE, ONE], [EIGHT, EIGHT]]) {
        const r = revealSchedule({ texts, beats: grid(bpm, 7), duration: 7 });
        expect(r.too_dense).toBe(false);
        expect(revealShortfalls(texts, r.times, 7)).toEqual([]);
      }
    }
    expect(revealShortfalls([ONE, ONE], [0, 0.5], 4)).toEqual([{ item: 0, visible: 0.1, floor: 0.8 }]);
    expect(revealShortfalls([ONE, EIGHT], [0, 2], 3)).toEqual([{ item: 1, visible: 0.6, floor: 2.4 }]);
  });
});

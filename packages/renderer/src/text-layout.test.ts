import { layoutZones } from "@video-studio/platforms";
import { describe, expect, it } from "vitest";
import { estimateTextWidth, fitText, placeLines, safeArea, splitH, splitV, wrapText } from "./text-layout.js";

describe("estimateTextWidth", () => {
  it("uses 0.55 em proportional and 0.6 em mono", () => {
    expect(estimateTextWidth("abcd", 10)).toBeCloseTo(22);
    expect(estimateTextWidth("abcd", 10, { mono: true })).toBeCloseTo(24);
    expect(estimateTextWidth("😀😀", 10)).toBeCloseTo(11);
  });
});

describe("wrapText", () => {
  it("wraps greedily on words within the width", () => {
    // 10 px font → 5.5 px per char → 100 px fits 18 chars.
    expect(wrapText("the quick brown fox jumps over the lazy dog", 10, 100)).toEqual(["the quick brown", "fox jumps over the", "lazy dog"]);
  });
  it("keeps explicit newlines and hard-breaks long words", () => {
    expect(wrapText("a\nb", 10, 100)).toEqual(["a", "b"]);
    expect(wrapText("abcdefghij", 10, 30)).toEqual(["abcde", "fghij"]);
  });
  it("never produces a line wider than the box", () => {
    const lines = wrapText("Vector databases store embeddings and find nearest neighbours fast", 20, 200);
    for (const l of lines) expect(estimateTextWidth(l, 20)).toBeLessThanOrEqual(200);
  });
});

describe("fitText", () => {
  it("keeps the max size when the text fits", () => {
    const f = fitText("Hi", { w: 500, h: 200 }, { maxSize: 80, minSize: 20 });
    expect(f.fontSize).toBe(80);
    expect(f.lines).toEqual(["Hi"]);
    expect(f.truncated).toBe(false);
  });
  it("shrinks until the wrapped block fits", () => {
    const text = "Explain vector databases in thirty seconds flat";
    const box = { w: 300, h: 120 };
    const f = fitText(text, box, { maxSize: 100, minSize: 10 });
    expect(f.fontSize).toBeLessThan(100);
    expect(f.fontSize).toBeGreaterThanOrEqual(10);
    expect(f.width).toBeLessThanOrEqual(box.w);
    expect(f.height).toBeLessThanOrEqual(box.h);
    expect(f.truncated).toBe(false);
    expect(f.lines.join(" ")).toBe(text);
  });
  it("truncates with an ellipsis at the minimum size", () => {
    const f = fitText("word ".repeat(200), { w: 100, h: 40 }, { maxSize: 20, minSize: 12 });
    expect(f.truncated).toBe(true);
    expect(f.fontSize).toBe(12);
    expect(f.lines.length).toBe(2);
    expect(f.lines.at(-1)!.endsWith("…")).toBe(true);
  });
  it("does not wrap in noWrap mode (code) and respects maxLines", () => {
    const f = fitText(["const a = 1;", "  return a;"], { w: 1000, h: 1000 }, { mono: true, noWrap: true, maxSize: 30, minSize: 10 });
    expect(f.lines).toEqual(["const a = 1;", "  return a;"]);
    const one = fitText("a b c d e f g h", { w: 40, h: 1000 }, { maxSize: 30, minSize: 10, maxLines: 1 });
    expect(one.lines.length).toBe(1);
  });
});

describe("placeLines", () => {
  it("centres a block in the box", () => {
    const f = fitText(["ab", "abcd"], { w: 200, h: 200 }, { maxSize: 20, minSize: 20 });
    const lines = placeLines(f, { x: 0, y: 0, w: 200, h: 200 });
    expect(lines.map((l) => l.y)).toEqual([Math.round((200 - f.height) / 2), Math.round((200 - f.height) / 2 + 25)]);
    expect(lines[0]!.cx).toBe(100);
    expect(lines[1]!.x).toBe(Math.round(100 - estimateTextWidth("abcd", 20) / 2));
    const left = placeLines(f, { x: 10, y: 5, w: 200, h: 200 }, "left", "top");
    expect(left.map((l) => [l.x, l.y])).toEqual([
      [10, 5],
      [10, 30],
    ]);
  });
});

describe("safeArea", () => {
  it("uses the design-grid content rect without zones", () => {
    expect(safeArea({ width: 1080, height: 1920, aspect_ratio: "9:16" })).toEqual({ x: 72, y: 180, w: 936, h: 1060 });
    const s = safeArea({ width: 1920, height: 1080, aspect_ratio: "16:9" });
    expect(s.x).toBe(134);
    expect(s.y + s.h).toBeLessThan(1080);
  });
  it("keeps content above the caption zone for every aspect", () => {
    for (const [width, height, aspect_ratio] of [[1080, 1920, "9:16"], [1920, 1080, "16:9"], [1080, 1080, "1:1"], [1080, 1350, "4:5"]] as const) {
      const s = safeArea({ width, height, aspect_ratio });
      expect(s.y + s.h).toBeLessThanOrEqual(layoutZones({ width, height, aspect_ratio }).caption.y);
    }
  });
  it("returns the zones' content rect, scaled to the target", () => {
    const zones = layoutZones({ width: 1080, height: 1920, aspect_ratio: "9:16" });
    const custom = { ...zones, content: { x: 100, y: 200, w: 800, h: 1000 } };
    expect(safeArea({ width: 1080, height: 1920, aspect_ratio: "9:16" }, custom)).toEqual({ x: 100, y: 200, w: 800, h: 1000 });
    expect(safeArea({ width: 540, height: 960, aspect_ratio: "9:16" }, custom)).toEqual({ x: 50, y: 100, w: 400, h: 500 });
  });
  it("splits rects", () => {
    expect(splitV({ x: 0, y: 0, w: 10, h: 110 }, [1, 1], 10)).toEqual([
      { x: 0, y: 0, w: 10, h: 50 },
      { x: 0, y: 60, w: 10, h: 50 },
    ]);
    expect(splitH({ x: 0, y: 0, w: 100, h: 10 }, [3, 1]).map((r) => r.w)).toEqual([75, 25]);
  });
});

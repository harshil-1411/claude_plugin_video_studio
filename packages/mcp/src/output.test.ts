import { describe, expect, it } from "vitest";
import { compactJson, compactValue, resultBytes, toolResult } from "./output.js";

describe("toolResult", () => {
  it("one text block: summary plus compact JSON; structuredContent is the full object", () => {
    const data = { a: 1, b: null, c: undefined, d: [], e: {}, f: "x", g: [1, 2] };
    const r = toolResult("done", data);
    expect(r.content).toEqual([{ type: "text", text: 'done\n{"a":1,"f":"x","g":[1,2]}' }]);
    expect(r.structuredContent).toBe(data);
    expect(r.isError).toBeUndefined();
  });

  it("summary only when there is no data or nothing survives", () => {
    expect(toolResult("hi").content).toEqual([{ type: "text", text: "hi" }]);
    expect(toolResult("hi").structuredContent).toBeUndefined();
    expect(toolResult("hi", { x: null, y: [] }).content[0]).toEqual({ type: "text", text: "hi" });
  });

  it("isError and project-relative paths", () => {
    const r = toolResult("failed", { reel: "/p/proj/dist/reel.mp4", other: "/elsewhere/x", root: "/p/proj" }, { relativeTo: "/p/proj/", isError: true });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toBe('failed\n(paths relative to /p/proj)\n{"reel":"dist/reel.mp4","other":"/elsewhere/x","root":"."}');
    expect((r.structuredContent as { reel: string }).reel).toBe("/p/proj/dist/reel.mp4");
  });
});

describe("compactValue", () => {
  it("truncates long arrays with a marker and where to find them in full", () => {
    const v = compactValue({ findings: Array.from({ length: 25 }, (_, i) => i), tiles: [1, 2, 3, 4] }, { maxArray: 3, hints: { findings: "qa/lint.json" } }) as Record<string, unknown[]>;
    expect(v.findings).toEqual([0, 1, 2, "…22 more (full list: qa/lint.json)"]);
    expect(v.tiles).toEqual([1, 2, 3, "…1 more (full list: structuredContent)"]);
    const w = compactValue({ tiles: [1, 2, 3, 4] }, { maxArray: 3, maxArrayFor: { tiles: 10 } });
    expect(w).toEqual({ tiles: [1, 2, 3, 4] });
  });

  it("cuts long strings, rounds floats, omits keys, keeps booleans and zero", () => {
    const v = compactValue({ s: "a".repeat(30), n: 1.23456, i: 7, z: 0, f: false, request: { big: true } }, { maxString: 10, omit: ["request"] });
    expect(v).toEqual({ s: `${"a".repeat(10)}…(+20 chars)`, n: 1.235, i: 7, z: 0, f: false });
  });

  it("dropEmpty: false keeps empty containers", () => {
    expect(compactJson({ a: [], b: {} }, { dropEmpty: false })).toBe('{"a":[],"b":{}}');
    expect(compactJson(null)).toBe("");
  });

  it("is much smaller than the old pretty-printed double payload", () => {
    const data = { tiles: Array.from({ length: 18 }, (_, i) => ({ index: i, time_sec: i * 0.5, scene_id: `s0${i % 6}`, label: `s0${i % 6} mid ${i}.00s`, flags: undefined })) };
    const old = Buffer.byteLength("summary") + Buffer.byteLength(JSON.stringify(data, null, 2));
    expect(resultBytes(toolResult("summary", data))).toBeLessThan(old * 0.8);
    expect(resultBytes(toolResult("summary", data), true)).toBeGreaterThan(resultBytes(toolResult("summary", data)));
  });
});

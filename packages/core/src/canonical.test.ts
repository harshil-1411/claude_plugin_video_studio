import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cacheKey, canonicalJson, hashFile, sha256Hex } from "./canonical.js";

describe("canonicalJson", () => {
  it("sorts keys recursively and has no whitespace", () => {
    const a = { b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } };
    const b = { a: { c: "x", d: [3, { y: 2, z: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("rejects undefined, functions, NaN, Infinity, bigint, Date, cycles", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson([1, undefined])).toThrow(/undefined/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/function/);
    expect(() => canonicalJson({ n: NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson(Infinity)).toThrow(/non-finite/);
    expect(() => canonicalJson(1n)).toThrow(/bigint/);
    expect(() => canonicalJson({ d: new Date() })).toThrow(/non-plain/);
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => canonicalJson(cyc)).toThrow(/circular/);
  });

  it("allows repeated (non-circular) references and null", () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared, c: null })).toBe('{"a":{"x":1},"b":{"x":1},"c":null}');
  });
});

describe("hashing", () => {
  it("sha256Hex matches known vector; hashFile matches sha256Hex", async () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const dir = await mkdtemp(join(tmpdir(), "vs-core-"));
    const p = join(dir, "f.bin");
    const data = new Uint8Array(200_000).map((_, i) => i % 251);
    await writeFile(p, data);
    expect(await hashFile(p)).toBe(sha256Hex(data));
  });

  it("cacheKey is stable across option key order and sensitive to each field", () => {
    const base = { kind: "ingest.url", inputDigest: "ab", extractorVersion: "1", irSchemaVersion: 1 };
    const k1 = cacheKey({ ...base, options: { a: 1, b: 2 } });
    const k2 = cacheKey({ ...base, options: { b: 2, a: 1 } });
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey({ ...base, extractorVersion: "2", options: { a: 1, b: 2 } })).not.toBe(k1);
    expect(cacheKey({ ...base, irSchemaVersion: 2, options: { a: 1, b: 2 } })).not.toBe(k1);
  });
});

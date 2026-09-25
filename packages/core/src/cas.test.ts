import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./canonical.js";
import { ContentStore } from "./cas.js";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "vs-core-"));
  return { dir, cas: new ContentStore(join(dir, "cache")) };
}

describe("ContentStore", () => {
  it("stores bytes sharded by hash and dedupes", async () => {
    const { dir, cas } = await setup();
    const bytes = new TextEncoder().encode("hello");
    const a = await cas.put(bytes);
    const h = sha256Hex(bytes);
    expect(a.sha256).toBe(h);
    expect(a.path).toBe(join(dir, "cache", h.slice(0, 2), h.slice(2, 4), h));
    const src = join(dir, "hello.txt");
    await writeFile(src, "hello");
    const b = await cas.put(src);
    expect(b).toEqual(a);
    expect(await readdir(join(dir, "cache", h.slice(0, 2), h.slice(2, 4)))).toEqual([h]);
    // no leftover temp files at the store root
    expect((await readdir(join(dir, "cache"))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(await cas.has(h)).toBe(true);
    expect(await cas.get(h)).toEqual({ sha256: h, path: a.path, bytes: 5 });
    expect(await cas.has("0".repeat(64))).toBe(false);
    expect(await cas.get("0".repeat(64))).toBeUndefined();
    expect(() => cas.pathFor("../etc")).toThrow(TypeError);
  });

  it("put(filePath) streams large files", async () => {
    const { dir, cas } = await setup();
    const data = new Uint8Array(3_000_000).map((_, i) => (i * 7) % 256);
    const src = join(dir, "big.bin");
    await writeFile(src, data);
    const e = await cas.put(src);
    expect(e.sha256).toBe(sha256Hex(data));
    expect(e.bytes).toBe(data.length);
  });

  it("materializes by hardlink (or copy) and replaces existing files", async () => {
    const { dir, cas } = await setup();
    const e = await cas.put(new TextEncoder().encode("asset"));
    const dest = join(dir, "project", "assets", "a.bin");
    await writeFile(join(dir, "x"), "x");
    const how = await cas.materialize(e.sha256, dest);
    expect(["link", "copy"]).toContain(how);
    expect(await readFile(dest, "utf8")).toBe("asset");
    if (how === "link") expect((await stat(dest)).ino).toBe((await stat(e.path)).ino);
    await cas.materialize(e.sha256, dest); // idempotent overwrite
    expect(await readFile(dest, "utf8")).toBe("asset");
    await expect(cas.materialize("f".repeat(64), dest)).rejects.toThrow(/not found/);
  });
});

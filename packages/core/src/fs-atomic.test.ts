import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDir, readJson, writeFileAtomic, writeJsonAtomic } from "./fs-atomic.js";

describe("atomic writes", () => {
  it("writes, replaces, and leaves no temp files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vs-core-"));
    const p = join(dir, "nested", "a.txt");
    await writeFileAtomic(p, "one");
    await writeFileAtomic(p, "two");
    expect(await readFile(p, "utf8")).toBe("two");
    expect(await readdir(join(dir, "nested"))).toEqual(["a.txt"]);
  });

  it("does not clobber the target when the write fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vs-core-"));
    const p = join(dir, "a.json");
    await writeFile(p, "original");
    await expect(writeJsonAtomic(p, undefined)).rejects.toThrow();
    // Invalid data type for handle.writeFile
    await expect(writeFileAtomic(p, 123 as unknown as string)).rejects.toThrow();
    expect(await readFile(p, "utf8")).toBe("original");
    expect(await readdir(dir)).toEqual(["a.json"]);
  });

  it("round-trips JSON and ensureDir is idempotent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vs-core-"));
    await ensureDir(join(dir, "x", "y"));
    await ensureDir(join(dir, "x", "y"));
    const p = join(dir, "x", "y", "v.json");
    await writeJsonAtomic(p, { a: [1, 2], b: "c" });
    expect(await readJson(p)).toEqual({ a: [1, 2], b: "c" });
  });
});

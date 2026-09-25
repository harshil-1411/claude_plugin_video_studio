import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IngestError, formatIngestSummary, ingest, resolveIngestInput } from "./ingest.js";

const FIXTURES = resolve(import.meta.dirname, "../../../fixtures");
const NOW = "2026-09-25T12:00:00.000Z";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-ingest-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("resolveIngestInput", () => {
  it("treats multi-line or non-path strings as inline text", () => {
    expect(resolveIngestInput("Hello world.\n\nSecond paragraph.", tmp)).toMatchObject({ kind: "text", content: "Hello world.\n\nSecond paragraph." });
    expect(resolveIngestInput("# Title\n\nBody", tmp)).toMatchObject({ kind: "markdown", content: "# Title\n\nBody" });
  });

  it("resolves relative file paths against cwd and keeps URLs", () => {
    expect(resolveIngestInput("golden/article.md", FIXTURES)).toEqual({ uri: join(FIXTURES, "golden/article.md"), kind: "markdown" });
    expect(resolveIngestInput("https://example.com/a", tmp)).toEqual({ uri: "https://example.com/a", kind: "url" });
    expect(resolveIngestInput({ uri: "notes", content: "plain words" }, tmp)).toMatchObject({ kind: "text", content: "plain words" });
  });

  it("rejects missing binary documents", () => {
    expect(() => resolveIngestInput("missing.pdf", tmp)).toThrow(/input not found/);
  });
});

describe("ingest", () => {
  it("writes content-ir.json and provenance.json and reports failures as warnings", async () => {
    const projectDir = join(tmp, "p1");
    const { summary, provenance } = await ingest(
      ["Edge caching cut latency by 40% in 2026.\n\nIt also saved money.", "missing.pdf", "https://github.com/o/r"],
      { projectDir, now: NOW, noCache: true, cwd: tmp },
    );
    expect(summary.sources).toHaveLength(1);
    expect(summary.claims).toBeGreaterThan(0);
    expect(summary.warnings.filter((w) => w.code === "ingest_failed").map((w) => w.message)).toEqual([
      expect.stringContaining("missing.pdf"),
      expect.stringContaining("clone the repo locally first"),
    ]);
    expect(provenance.failures).toHaveLength(2);
    const ir = JSON.parse(await readFile(join(projectDir, "source/content-ir.json"), "utf8"));
    expect(ir.id).toBe(summary.ir_id);
    const prov = JSON.parse(await readFile(join(projectDir, "source/provenance.json"), "utf8"));
    expect(prov.sources[0]).toMatchObject({ source_id: "src-1", kind: "text", cache_hit: false, fetched_at: NOW, extractor_version: "1" });
    expect(formatIngestSummary(summary)).toContain("ingest_failed");
  });

  it("throws IngestError when nothing could be ingested", async () => {
    await expect(ingest(["missing.pdf"], { projectDir: join(tmp, "p2"), noCache: true, cwd: tmp })).rejects.toBeInstanceOf(IngestError);
  });

  it("caches extraction keyed on content, and misses after the file changes", async () => {
    const cacheDir = join(tmp, "cache");
    const file = join(tmp, "note.md");
    await writeFile(file, "# Note\n\nVersion one.\n");
    const run = (p: string) => ingest([file], { projectDir: join(tmp, p), now: NOW, cacheDir });
    expect((await run("c1")).provenance.sources[0]!.cache_hit).toBe(false);
    expect((await run("c2")).provenance.sources[0]!.cache_hit).toBe(true);
    await writeFile(file, "# Note\n\nVersion two.\n");
    const third = await run("c3");
    expect(third.provenance.sources[0]!.cache_hit).toBe(false);
    expect(third.ir.sections[0]!.text).toBe("Version two.");
  });
});

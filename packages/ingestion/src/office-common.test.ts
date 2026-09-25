import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  assertZipWithinLimits,
  joinParagraphs,
  makeRef,
  readSourceFile,
  resolvePartPath,
  SafeZip,
  ZipLimitError,
} from "./office-common.js";

describe("zip-bomb guard", () => {
  it("rejects archives whose declared uncompressed size exceeds the limit (mocked header)", async () => {
    const zip = new JSZip();
    zip.file("a.xml", "<a/>");
    const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: "uint8array" }));
    // Simulate a 300 MB declared entry without allocating it.
    (loaded.files["a.xml"] as unknown as { _data: { uncompressedSize: number } })._data.uncompressedSize =
      300 * 1024 * 1024;
    expect(() => assertZipWithinLimits(loaded)).toThrow(ZipLimitError);
  });

  it("rejects a highly compressible payload over a (lowered) limit on open", async () => {
    const zip = new JSZip();
    zip.file("zeros.bin", new Uint8Array(1024 * 1024));
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    expect(bytes.byteLength).toBeLessThan(10_000);
    await expect(SafeZip.open(bytes, { maxUncompressedBytes: 64 * 1024 })).rejects.toMatchObject({
      code: "zip_too_large",
    });
  });

  it("rejects too many entries and accepts small archives", async () => {
    const zip = new JSZip();
    for (let i = 0; i < 4; i++) zip.file(`${i}.xml`, "<x/>");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(SafeZip.open(bytes, { maxEntries: 3 })).rejects.toMatchObject({ code: "zip_too_many_entries" });
    const ok = await SafeZip.open(bytes);
    expect(await ok.readText("0.xml")).toBe("<x/>");
    expect(await ok.readText("missing.xml")).toBeUndefined();
  });
});

describe("helpers", () => {
  it("resolves relationship targets and refuses escapes/external URLs", () => {
    expect(resolvePartPath("ppt/slides/slide1.xml", "../media/image1.png")).toBe("ppt/media/image1.png");
    expect(resolvePartPath("ppt/slides/slide1.xml", "/ppt/media/x.png")).toBe("ppt/media/x.png");
    expect(resolvePartPath("a.xml", "../../etc/passwd")).toBeUndefined();
    expect(resolvePartPath("ppt/slides/slide1.xml", "https://evil.example/x.png")).toBeUndefined();
  });

  it("makes schema-valid refs even for file names with spaces or #", () => {
    expect(makeRef("pdf", "/tmp/My Report #2.pdf", "p3")).toBe("pdf:My%20Report%20%232.pdf#p3");
  });

  it("joinParagraphs records offsets", () => {
    const { text, offsets } = joinParagraphs(["ab", "cde"]);
    expect(text).toBe("ab\n\ncde");
    expect(offsets).toEqual([
      [0, 2],
      [4, 7],
    ]);
  });

  it("readSourceFile only hashes files over the cap", async () => {
    const p = join(await mkdtemp(join(tmpdir(), "vs-oc-")), "f.bin");
    await writeFile(p, "hello world");
    const r = await readSourceFile(p, 5);
    expect(r).toMatchObject({ ok: false, size: 11 });
    expect(r.sha256).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });
});

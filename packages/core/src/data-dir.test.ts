import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DataDirError, ensureDataDir, resolveDataDir } from "./data-dir.js";

describe("data dir", () => {
  it("prefers CLAUDE_PLUGIN_DATA, then VIDEO_STUDIO_DATA, then ~/.video-studio", () => {
    expect(resolveDataDir({ CLAUDE_PLUGIN_DATA: "/a", VIDEO_STUDIO_DATA: "/b" }, "/home/u").root).toBe(resolve("/a"));
    expect(resolveDataDir({ VIDEO_STUDIO_DATA: "/b" }, "/home/u").root).toBe(resolve("/b"));
    const d = resolveDataDir({ CLAUDE_PLUGIN_DATA: "" }, "/home/u");
    expect(d).toEqual({
      root: resolve("/home/u/.video-studio"),
      cache: resolve("/home/u/.video-studio/cache"),
      db: resolve("/home/u/.video-studio/db"),
      deps: resolve("/home/u/.video-studio/deps"),
    });
  });

  it("refuses to resolve inside CLAUDE_PLUGIN_ROOT", () => {
    expect(() => resolveDataDir({ CLAUDE_PLUGIN_ROOT: "/p", VIDEO_STUDIO_DATA: "/p/data" })).toThrow(DataDirError);
    expect(() => resolveDataDir({ CLAUDE_PLUGIN_ROOT: "/p", VIDEO_STUDIO_DATA: "/p" })).toThrow(DataDirError);
    expect(resolveDataDir({ CLAUDE_PLUGIN_ROOT: "/p", VIDEO_STUDIO_DATA: "/p2" }).root).toBe(resolve("/p2"));
  });

  it("ensureDataDir creates subdirectories", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "vs-core-")), "data");
    const d = await ensureDataDir({ VIDEO_STUDIO_DATA: root });
    for (const p of [d.cache, d.db, d.deps]) expect((await stat(p)).isDirectory()).toBe(true);
  });
});

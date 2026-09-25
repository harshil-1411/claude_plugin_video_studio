import { mkdir, mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initProject, openProject, PathTraversalError, ProjectError, resolveInsideProject } from "./project.js";

async function tmp() {
  return mkdtemp(join(tmpdir(), "vs-core-"));
}

describe("project", () => {
  it("initializes the standard layout and reopens it", async () => {
    const dir = await tmp();
    const p = await initProject(dir, { name: "Demo" });
    for (const d of ["source", "project", "assets/generated", "assets/supplied", "assets/voice", "assets/music", "renders", "dist", "qa"]) {
      expect((await stat(join(dir, d))).isDirectory()).toBe(true);
    }
    expect(p.meta.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.meta.schema_version).toBe(1);
    expect(new Date(p.meta.created_at).toISOString()).toBe(p.meta.created_at);
    const opened = await openProject(dir);
    expect(opened.meta).toEqual(p.meta);
    await expect(initProject(dir, { name: "Again" })).rejects.toBeInstanceOf(ProjectError);
  });

  it("openProject rejects non-projects", async () => {
    await expect(openProject(await tmp())).rejects.toBeInstanceOf(ProjectError);
  });

  it("resolveInsideProject accepts inner paths and rejects traversal", async () => {
    const dir = await tmp();
    const p = await initProject(dir, { name: "Demo" });
    expect(await resolveInsideProject(p, "assets/voice/a.wav")).toBe(join(p.paths.root, "assets/voice/a.wav"));
    expect(await resolveInsideProject(p, "./dist/new/deep/file.mp4")).toBe(join(p.paths.root, "dist/new/deep/file.mp4"));
    for (const bad of ["../x", "a/../../x", "assets/../..", "/etc/passwd", "", "a\0b", "..\\x"]) {
      await expect(resolveInsideProject(p, bad), bad).rejects.toBeInstanceOf(PathTraversalError);
    }
  });

  it("rejects symlink escapes", async () => {
    const dir = await tmp();
    const outside = await tmp();
    await writeFile(join(outside, "secret.txt"), "s");
    const p = await initProject(dir, { name: "Demo" });
    await symlink(outside, join(dir, "source", "link"));
    await symlink(join(outside, "secret.txt"), join(dir, "source", "file-link"));
    await expect(resolveInsideProject(p, "source/link/secret.txt")).rejects.toThrow(/symlink/);
    await expect(resolveInsideProject(p, "source/link/not-yet/x")).rejects.toThrow(/symlink/);
    await expect(resolveInsideProject(p, "source/file-link")).rejects.toThrow(/symlink/);
    // Symlink staying inside the project is fine.
    await mkdir(join(dir, "source", "real"));
    await symlink(join(dir, "source", "real"), join(dir, "source", "inner"));
    await expect(resolveInsideProject(p, "source/inner/x")).resolves.toBe(join(p.paths.root, "source/inner/x"));
  });
});

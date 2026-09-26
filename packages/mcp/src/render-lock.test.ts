import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RENDER_LOCK_STALE_MS, RenderLockedError, acquireRenderLock } from "./render-lock.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vs-lock-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("render lock", () => {
  it("allows one holder and releases", async () => {
    const lock = join(dir, "a", "renders", ".render.lock");
    const release = await acquireRenderLock(lock, "preview", { pid: 111, host: "h", alive: () => true });
    expect(JSON.parse(await readFile(lock, "utf8"))).toMatchObject({ pid: 111, host: "h", quality: "preview" });
    const err = await acquireRenderLock(lock, "final", { pid: 222, host: "h", alive: () => true }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(RenderLockedError);
    expect((err as Error).message).toMatch(/another render of this project is running \(pid 111 on h, preview/);
    await release();
    expect(existsSync(lock)).toBe(false);
    const again = await acquireRenderLock(lock, "final", { pid: 222, host: "h", alive: () => true });
    await again();
  });

  it("takes over a lock whose process is gone, or that is too old", async () => {
    const lock = join(dir, "b", ".render.lock");
    await acquireRenderLock(lock, "preview", { pid: 111, host: "h" , alive: () => true });
    const release = await acquireRenderLock(lock, "preview", { pid: 222, host: "h", alive: (pid) => pid !== 111 });
    expect(JSON.parse(await readFile(lock, "utf8")).pid).toBe(222);
    await release();

    const old = new Date(Date.now() - RENDER_LOCK_STALE_MS - 1000).toISOString();
    await writeFile(lock, JSON.stringify({ pid: 333, host: "other", started_at: old }));
    const r2 = await acquireRenderLock(lock, "final", { pid: 444, host: "h", alive: () => true });
    expect(JSON.parse(await readFile(lock, "utf8")).pid).toBe(444);
    await r2();
  });

  it("respects a live lock from another host, and a corrupt lock counts as stale", async () => {
    const lock = join(dir, "c", ".render.lock");
    await acquireRenderLock(lock, "preview", { pid: 1, host: "laptop", alive: () => false });
    // Another host: can't check its pid, so it holds until it goes stale.
    await expect(acquireRenderLock(lock, "preview", { pid: 2, host: "desktop", alive: () => false })).rejects.toThrow(RenderLockedError);
    await writeFile(lock, "{not json");
    const r = await acquireRenderLock(lock, "preview", { pid: 3, host: "desktop" });
    await r();
  });

  it("release never removes someone else's lock", async () => {
    const lock = join(dir, "d", ".render.lock");
    const release = await acquireRenderLock(lock, "preview", { pid: 1, host: "h" });
    await writeFile(lock, JSON.stringify({ pid: 9, host: "h", started_at: new Date().toISOString() }));
    await release();
    expect(existsSync(lock)).toBe(true);
  });
});

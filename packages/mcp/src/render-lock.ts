import { mkdir, open, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

/**
 * One render per project at a time, across processes (two Claude sessions, the MCP server and the
 * dev CLI). The lock is `renders/.render.lock`, created atomically; a lock whose process is gone
 * (same host) or that is older than RENDER_LOCK_STALE_MS is taken over.
 */

export const RENDER_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

export interface RenderLockInfo {
  pid: number;
  host: string;
  started_at: string;
  quality?: string;
}

export class RenderLockedError extends Error {
  constructor(
    readonly holder: RenderLockInfo,
    lockPath: string,
  ) {
    super(
      `another render of this project is running (pid ${holder.pid} on ${holder.host}, ${holder.quality ?? "?"} quality, started ${holder.started_at}); wait for it to finish (job_status), or if it crashed, delete ${lockPath}`,
    );
    this.name = "RenderLockedError";
  }
}

export interface RenderLockDeps {
  pid?: number;
  host?: string;
  now?: () => Date;
  /** Whether a process of this host is alive (default: signal 0). */
  alive?: (pid: number) => boolean;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isStale(info: RenderLockInfo | undefined, host: string, now: Date, alive: (pid: number) => boolean): boolean {
  if (!info || typeof info.pid !== "number") return true;
  const age = now.getTime() - Date.parse(info.started_at);
  if (!Number.isFinite(age) || age > RENDER_LOCK_STALE_MS) return true;
  return info.host === host && !alive(info.pid);
}

async function readLock(path: string): Promise<RenderLockInfo | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as RenderLockInfo;
  } catch {
    return undefined;
  }
}

/** Take the lock at `lockPath`, or throw RenderLockedError. Returns the release function. */
export async function acquireRenderLock(lockPath: string, quality?: string, deps: RenderLockDeps = {}): Promise<() => Promise<void>> {
  const pid = deps.pid ?? process.pid;
  const host = deps.host ?? hostname();
  const now = deps.now ?? (() => new Date());
  const alive = deps.alive ?? processAlive;
  const info: RenderLockInfo = { pid, host, started_at: now().toISOString(), ...(quality ? { quality } : {}) };
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(lockPath, "wx");
      await fh.writeFile(`${JSON.stringify(info)}\n`);
      await fh.close();
      return async () => {
        // Only remove our own lock (a stale-takeover may have replaced it).
        const held = await readLock(lockPath);
        if (held?.pid === pid && held.host === host && held.started_at === info.started_at) await rm(lockPath, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const held = await readLock(lockPath);
      if (!isStale(held, host, now(), alive)) throw new RenderLockedError(held!, lockPath);
      await rm(lockPath, { force: true });
    }
  }
  throw new RenderLockedError((await readLock(lockPath)) ?? info, lockPath);
}

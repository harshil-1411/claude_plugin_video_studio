import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/** Temp path in the same directory as `path`, so rename() stays on one filesystem. */
export function tempPathFor(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
}

/** fsync a directory so a rename inside it is durable. Best effort: not supported everywhere. */
export async function fsyncDir(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch {
    // Some platforms/filesystems refuse fsync on directories; the rename is still atomic.
  } finally {
    await handle?.close().catch(() => {});
  }
}

export interface WriteAtomicOptions {
  /** File mode for the new file (default 0o666 & ~umask). */
  mode?: number;
}

/**
 * Atomically replace `path` with `data`: write a temp file in the same directory,
 * fsync it, then rename over the target. Readers see either the old or the new file.
 */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  options: WriteAtomicOptions = {},
): Promise<void> {
  const dir = dirname(path);
  await ensureDir(dir);
  const tmp = tempPathFor(path);
  const handle = await open(tmp, "wx", options.mode ?? 0o666);
  try {
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  await fsyncDir(dir);
}

/** Pretty-printed JSON with trailing newline, written atomically. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) throw new TypeError("value is not JSON-serializable");
  await writeFileAtomic(path, `${text}\n`);
}

export async function readJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

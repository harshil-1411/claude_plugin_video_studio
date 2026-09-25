import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, link, lstat, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { sha256Hex } from "./canonical.js";
import { ensureDir, fsyncDir, tempPathFor, writeFileAtomic } from "./fs-atomic.js";

const SHA256_RE = /^[0-9a-f]{64}$/;

export interface CasEntry {
  sha256: string;
  path: string;
  bytes: number;
}

function assertSha(sha256: string): void {
  if (!SHA256_RE.test(sha256)) throw new TypeError(`invalid sha256: ${sha256}`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Content-addressed store. Objects live at `<root>/<ab>/<cd>/<sha256>` and are
 * made read-only, since `materialize` may hardlink them into project folders.
 */
export class ContentStore {
  constructor(readonly root: string) {}

  pathFor(sha256: string): string {
    assertSha(sha256);
    return join(this.root, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }

  /** Store bytes, or the contents of a file when given a path string. Dedupes by hash. */
  async put(input: Uint8Array | string): Promise<CasEntry> {
    return typeof input === "string" ? this.putFile(input) : this.putBytes(input);
  }

  private async putBytes(bytes: Uint8Array): Promise<CasEntry> {
    const sha256 = sha256Hex(bytes);
    const path = this.pathFor(sha256);
    if (!(await fileExists(path))) {
      await writeFileAtomic(path, bytes, { mode: 0o444 });
    }
    return { sha256, path, bytes: bytes.byteLength };
  }

  private async putFile(src: string): Promise<CasEntry> {
    // Single pass: hash while copying into a temp file, so a file changing
    // underneath us can never be stored under the wrong hash.
    await ensureDir(this.root);
    const tmp = tempPathFor(join(this.root, "incoming"));
    const hash = createHash("sha256");
    let bytes = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        bytes += chunk.length;
        cb(null, chunk);
      },
    });
    try {
      await pipeline(createReadStream(src), tap, createWriteStream(tmp, { flags: "wx", mode: 0o444, flush: true }));
      const sha256 = hash.digest("hex");
      const path = this.pathFor(sha256);
      if (await fileExists(path)) {
        await unlink(tmp);
      } else {
        await ensureDir(dirname(path));
        await rename(tmp, path);
        await fsyncDir(dirname(path));
      }
      return { sha256, path, bytes };
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  async has(sha256: string): Promise<boolean> {
    return fileExists(this.pathFor(sha256));
  }

  /** Path and size of a stored object, or undefined if absent. */
  async get(sha256: string): Promise<CasEntry | undefined> {
    const path = this.pathFor(sha256);
    try {
      const s = await stat(path);
      return { sha256, path, bytes: s.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  /**
   * Place a stored object at `destPath` (atomically replacing any existing file).
   * Hardlinks when possible, falling back to a copy (e.g. across filesystems).
   * Returns how it was materialized.
   */
  async materialize(sha256: string, destPath: string): Promise<"link" | "copy"> {
    const src = this.pathFor(sha256);
    if (!(await fileExists(src))) throw new Error(`CAS object not found: ${sha256}`);
    await ensureDir(dirname(destPath));
    const tmp = tempPathFor(destPath);
    let method: "link" | "copy" = "link";
    try {
      try {
        await link(src, tmp);
      } catch {
        method = "copy";
        await copyFile(src, tmp);
        await chmod(tmp, 0o444);
      }
      await rename(tmp, destPath);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    return method;
  }
}

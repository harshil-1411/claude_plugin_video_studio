import type { LockChange, VideoLock } from "@video-studio/schema";

/**
 * dist/video.lock: built at export from the render state (see VideoLock in @video-studio/schema),
 * and diffed to classify what changed between two renders.
 *
 * STUB (coordinator): signatures are the contract with diff.ts; the lock agent implements them.
 */

export const LOCK_FILE = "video.lock";

/** Read and validate a lock file; undefined when it does not exist. Throws on an invalid lock. */
export async function readLock(_path: string): Promise<VideoLock | undefined> {
  throw new Error("not implemented: readLock");
}

/** Changes from `before` to `after`, each classified; empty when the locks are equal. Sorted by class then path. */
export function diffLocks(_before: VideoLock, _after: VideoLock): LockChange[] {
  throw new Error("not implemented: diffLocks");
}

/** Short markdown list of changes grouped by class. */
export function formatLockChanges(_changes: readonly LockChange[]): string {
  throw new Error("not implemented: formatLockChanges");
}

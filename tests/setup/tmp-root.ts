import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every test run gets its own temp root: TMPDIR points at it before the workers start (they
 * inherit the environment, and os.tmpdir() reads TMPDIR), and it is removed when the run ends.
 * Tests can then mkdtemp freely without leaking folders into the system temp dir.
 */
export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), "vs-test-run-"));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = root;
  return () => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    // Retries: a browser a timed-out test left behind can still be writing its profile here.
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      console.warn(`could not remove the test temp root ${root}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}

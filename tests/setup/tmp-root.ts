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
    rmSync(root, { recursive: true, force: true });
  };
}

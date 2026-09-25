/**
 * diff: compare two renders (two project folders, or the same folder's preview vs final):
 * a spec diff, a video.lock diff (diffLocks in lock.ts) and a sampled frame diff.
 *
 * STUB (coordinator): the golden/diff agent implements it and may extend DiffResult.
 */

export interface DiffResult {
  identical: boolean;
  report_json: string;
  report_md: string;
}

export async function diffProjects(
  _a: string,
  _b: string,
  _opts: { quality_a?: "preview" | "final"; quality_b?: "preview" | "final" } = {},
): Promise<DiffResult> {
  throw new Error("not implemented: diffProjects");
}

export function formatDiff(_r: DiffResult): string {
  throw new Error("not implemented: formatDiff");
}

import { createHash } from "node:crypto";
import type { RenderJobView } from "./render-jobs.js";

/**
 * Delta polling for job_status. Every response carries a `cursor`; passing it back as `since`
 * returns only what changed since that poll:
 * - queued/running: status plus `progress` when it moved (else `unchanged: true`) and any
 *   warnings added since the cursor;
 * - finished (succeeded/failed/cancelled/interrupted): the full view exactly once; a later poll
 *   with the terminal cursor gets a one-line reminder instead of the payload again.
 * Without `since` (or with a cursor this function did not issue) the full view is returned, so
 * old callers behave exactly as before. Stateless: the cursor holds everything.
 */

/** A job view, optionally with warnings collected while it runs (appended only). */
export type JobViewLike = RenderJobView & { warnings?: readonly string[] };

export interface JobStatusViewOptions {
  /** The `cursor` from the previous job_status response. */
  since?: string;
}

export interface JobStatusViewResult {
  /** true: `data` is the whole view (first poll, unknown cursor, or the first poll after it finished). */
  full: boolean;
  /** What to return as structuredContent (and as compact JSON in the text). Always has `cursor`. */
  data: Record<string, unknown>;
  /** A one-line summary for delta responses; for `full` responses format the view as before. */
  summary?: string;
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const CURSOR_RE = /^j1\.([a-z]+)\.([0-9a-f]{8})\.(\d+)$/;

function progressKey(v: JobViewLike): string {
  const p = v.progress;
  return createHash("sha256")
    .update(JSON.stringify([v.status, v.queue_position ?? null, p.stage, p.scene_index ?? null, p.scene_count ?? null, p.scene_id ?? null, p.message]))
    .digest("hex")
    .slice(0, 8);
}

/** The cursor for this state of the job. */
export function jobCursor(v: JobViewLike): string {
  return `j1.${v.status}.${progressKey(v)}.${v.warnings?.length ?? 0}`;
}

function parseCursor(c: string | undefined): { status: string; key: string; warnings: number } | undefined {
  const m = c ? CURSOR_RE.exec(c) : null;
  return m ? { status: m[1]!, key: m[2]!, warnings: Number(m[3]) } : undefined;
}

export function isTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

export function jobStatusView(view: JobViewLike, opts: JobStatusViewOptions = {}): JobStatusViewResult {
  const cursor = jobCursor(view);
  const prev = parseCursor(opts.since);
  const terminal = isTerminal(view.status);

  if (!prev || (terminal && !isTerminal(prev.status)) || (terminal && prev.status !== view.status)) {
    return { full: true, data: { ...(view as unknown as Record<string, unknown>), cursor } };
  }

  if (terminal) {
    return {
      full: false,
      data: { job_id: view.job_id, status: view.status, cursor, delivered: true },
      summary: `job ${view.job_id}: ${view.status} (full result already returned; call job_status without since to see it again)`,
    };
  }

  const moved = prev.key !== progressKey(view) || prev.status !== view.status;
  const warnings = view.warnings ?? [];
  const fresh = prev.warnings < warnings.length ? warnings.slice(prev.warnings) : [];
  const p = view.progress;
  const data: Record<string, unknown> = {
    job_id: view.job_id,
    status: view.status,
    ...(view.queue_position !== undefined ? { queue_position: view.queue_position } : {}),
    ...(moved ? { progress: p } : { unchanged: true }),
    ...(fresh.length ? { new_warnings: fresh } : {}),
    cursor,
  };
  const where = p.scene_count ? ` (scene ${p.scene_index ?? 0}/${p.scene_count})` : "";
  const summary =
    `job ${view.job_id}: ${view.status}${view.queue_position ? ` (${view.queue_position} ahead in queue)` : ""}` +
    (moved ? `; ${p.stage}${where}: ${p.message}` : "; no change since last poll") +
    (fresh.length ? `\n${fresh.map((w) => `warning: ${w}`).join("\n")}` : "");
  return { full: false, data, summary };
}

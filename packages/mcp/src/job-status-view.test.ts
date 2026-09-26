import { describe, expect, it } from "vitest";
import { type JobViewLike, isTerminal, jobCursor, jobStatusView } from "./job-status-view.js";

const base = (over: Partial<JobViewLike> = {}): JobViewLike =>
  ({
    job_id: "job-1",
    project_dir: "/p",
    status: "running",
    progress: { stage: "scenes", message: "rendering s01", scene_index: 1, scene_count: 4 },
    submitted_at: "2026-09-26T00:00:00Z",
    request: {},
    ...over,
  }) as JobViewLike;

describe("jobStatusView", () => {
  it("first poll (no since) returns the full view with a cursor", () => {
    const v = base();
    const r = jobStatusView(v);
    expect(r.full).toBe(true);
    expect(r.data).toMatchObject({ job_id: "job-1", status: "running", request: {}, cursor: jobCursor(v) });
    expect(r.summary).toBeUndefined();
  });

  it("an unchanged running job returns only status, unchanged and the cursor", () => {
    const v = base();
    const r = jobStatusView(v, { since: jobCursor(v) });
    expect(r.full).toBe(false);
    expect(r.data).toEqual({ job_id: "job-1", status: "running", unchanged: true, cursor: jobCursor(v) });
    expect(r.summary).toMatch(/no change since last poll/);
  });

  it("progress that moved is returned, with warnings added since the cursor", () => {
    const v1 = base({ warnings: ["w1"] });
    const v2 = base({ progress: { stage: "scenes", message: "rendering s02", scene_index: 2, scene_count: 4 }, warnings: ["w1", "w2", "w3"] });
    const r = jobStatusView(v2, { since: jobCursor(v1) });
    expect(r.data).toEqual({ job_id: "job-1", status: "running", progress: v2.progress, new_warnings: ["w2", "w3"], cursor: jobCursor(v2) });
    expect(r.summary).toBe("job job-1: running; scenes (scene 2/4): rendering s02\nwarning: w2\nwarning: w3");
    expect(r.data).not.toHaveProperty("request");
  });

  it("queued → running reports the move and the queue position", () => {
    const q = base({ status: "queued", queue_position: 1, progress: { stage: "queued", message: "waiting" } as JobViewLike["progress"] });
    const r0 = jobStatusView(q, { since: jobCursor(q) });
    expect(r0.data).toMatchObject({ status: "queued", queue_position: 1, unchanged: true });
    const r = jobStatusView(base(), { since: jobCursor(q) });
    expect(r.data).toMatchObject({ status: "running", progress: { stage: "scenes" } });
  });

  it("completion returns the full result exactly once", () => {
    const running = base();
    const done = base({ status: "succeeded", progress: { stage: "done", message: "done" } as JobViewLike["progress"], result: { summary: true, qa_status: "pass" } });
    const first = jobStatusView(done, { since: jobCursor(running) });
    expect(first.full).toBe(true);
    expect(first.data).toMatchObject({ status: "succeeded", result: { qa_status: "pass" }, cursor: jobCursor(done) });
    const again = jobStatusView(done, { since: first.data.cursor as string });
    expect(again.full).toBe(false);
    expect(again.data).toEqual({ job_id: "job-1", status: "succeeded", cursor: jobCursor(done), delivered: true });
    expect(again.summary).toMatch(/already returned/);
    // Without since, the full view comes back again.
    expect(jobStatusView(done).full).toBe(true);
  });

  it("failed jobs deliver the error once; unknown cursors fall back to the full view", () => {
    const failed = base({ status: "failed", error: "boom", error_code: "ERROR" });
    expect(jobStatusView(failed, { since: jobCursor(base()) }).data).toMatchObject({ error: "boom", error_code: "ERROR" });
    expect(jobStatusView(base(), { since: "garbage" }).full).toBe(true);
    expect(jobStatusView(base(), { since: "" }).full).toBe(true);
  });

  it("isTerminal", () => {
    expect(["succeeded", "failed", "cancelled", "interrupted"].every(isTerminal)).toBe(true);
    expect(isTerminal("running") || isTerminal("queued")).toBe(false);
  });
});

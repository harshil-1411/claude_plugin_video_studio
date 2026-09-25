import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IllegalTransitionError, JobNotFoundError, SqliteLedger } from "./ledger.js";

async function dbPath() {
  return join(await mkdtemp(join(tmpdir(), "vs-core-")), "db", "ledger.sqlite");
}

const newJob = (key: string, projectId = "p1") => ({
  projectId,
  sceneId: "s1",
  kind: "video",
  provider: "mock",
  idempotencyKey: key,
  request: { prompt: "x", b: 1, a: 2 },
});

describe("SqliteLedger", () => {
  it("creates jobs idempotently by key", async () => {
    const l = new SqliteLedger(await dbPath());
    const a = l.createJob(newJob("k1"));
    const b = l.createJob({ ...newJob("k1"), request: { other: true } });
    expect(b.id).toBe(a.id);
    expect(b.request).toEqual({ prompt: "x", b: 1, a: 2 });
    expect(a.status).toBe("queued");
    expect(a.attempts).toBe(0);
    expect(l.listJobs()).toHaveLength(1);
    expect(l.getJobByKey("k1")?.id).toBe(a.id);
    l.close();
  });

  it("validates status transitions; terminal states are final", async () => {
    const l = new SqliteLedger(await dbPath());
    const j = l.createJob(newJob("k1"));
    expect(l.updateJob(j.id, { status: "submitted", providerTaskId: "t1" }).providerTaskId).toBe("t1");
    expect(() => l.updateJob(j.id, { status: "queued" })).toThrow(IllegalTransitionError);
    l.updateJob(j.id, { status: "running", attempts: 1 });
    const done = l.updateJob(j.id, { status: "succeeded", result: { ok: true }, costUsd: 0.25 });
    expect(done).toMatchObject({ status: "succeeded", result: { ok: true }, costUsd: 0.25, attempts: 1 });
    expect(() => l.updateJob(j.id, { status: "failed" })).toThrow(IllegalTransitionError);
    expect(() => l.updateJob(j.id, { error: "late" })).toThrow(IllegalTransitionError);
    expect(() => l.updateJob("nope", { status: "failed" })).toThrow(JobNotFoundError);
    l.close();
  });

  it("rejects unknown statuses via the CHECK constraint", async () => {
    const l = new SqliteLedger(await dbPath());
    const j = l.createJob(newJob("k1"));
    expect(() => l.updateJob(j.id, { status: "bogus" as never })).toThrow();
    l.close();
  });

  it("lists by project and status, records assets, and persists across reopen", async () => {
    const path = await dbPath();
    let l = new SqliteLedger(path);
    const j1 = l.createJob(newJob("k1"));
    l.createJob(newJob("k2"));
    l.createJob(newJob("k3", "p2"));
    l.updateJob(j1.id, { status: "submitted", providerTaskId: "t1" });
    const asset = { sha256: "a".repeat(64), path: "/x", kind: "video", bytes: 10, sourceJobId: j1.id };
    l.recordAsset(asset);
    expect(l.recordAsset({ ...asset, path: "/y" }).path).toBe("/x");
    l.close();

    l = new SqliteLedger(path);
    expect((l as SqliteLedger).schemaVersion()).toBe(1);
    expect(l.listJobs({ projectId: "p1" })).toHaveLength(2);
    expect(l.listJobs({ projectId: "p1", status: "submitted" }).map((j) => j.id)).toEqual([j1.id]);
    expect(l.listJobs({ status: ["queued"] })).toHaveLength(2);
    expect(l.getJob(j1.id)).toMatchObject({ status: "submitted", providerTaskId: "t1" });
    expect(l.getAsset("a".repeat(64))).toMatchObject({ sourceJobId: j1.id, bytes: 10 });
    l.close();
    l.close(); // idempotent
  });
});

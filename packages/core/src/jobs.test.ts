import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JobRunner, type JobHandler, type PollResult } from "./jobs.js";
import { SqliteLedger, type JobRecord } from "./ledger.js";

async function dbPath() {
  return join(await mkdtemp(join(tmpdir(), "vs-core-")), "ledger.sqlite");
}

function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

interface FakeHandler extends JobHandler {
  calls: { submit: number; poll: number; download: number };
}

/** Provider fake: task succeeds after `pollsUntilDone` polls. */
function fakeHandler(opts: { pollsUntilDone?: number; pollScript?: (n: number) => PollResult | Error } = {}): FakeHandler {
  const calls = { submit: 0, poll: 0, download: 0 };
  return {
    calls,
    async submit(job: JobRecord) {
      calls.submit++;
      return { providerTaskId: `task-${job.idempotencyKey}` };
    },
    async poll(job: JobRecord) {
      calls.poll++;
      if (!job.providerTaskId) throw new Error("poll without task id");
      if (opts.pollScript) {
        const r = opts.pollScript(calls.poll);
        if (r instanceof Error) throw r;
        return r;
      }
      return calls.poll >= (opts.pollsUntilDone ?? 2) ? { status: "succeeded", costUsd: 0.5 } : { status: "running" };
    },
    async download(job: JobRecord) {
      calls.download++;
      return [{ sha256: "b".repeat(63) + String(calls.download % 10), path: `/cas/${job.id}`, kind: "video", bytes: 42 }];
    },
  };
}

const newJob = (key: string) => ({ projectId: "p1", kind: "video", provider: "mock", idempotencyKey: key, request: { key } });

describe("JobRunner", () => {
  it("runs submit -> poll (with backoff) -> download -> succeeded", async () => {
    const ledger = new SqliteLedger(await dbPath());
    const clock = fakeClock();
    const handler = fakeHandler({ pollsUntilDone: 4 });
    const runner = new JobRunner({
      ledger,
      handlers: { video: handler },
      now: clock.now,
      sleep: clock.sleep,
      polling: { initialDelayMs: 100, factor: 2, maxDelayMs: 300 },
    });
    const out = await runner.submit(newJob("k1"));
    expect(out.outcome).toBe("succeeded");
    expect(out.job).toMatchObject({ status: "succeeded", providerTaskId: "task-k1", attempts: 1, costUsd: 0.5 });
    expect(handler.calls).toEqual({ submit: 1, poll: 4, download: 1 });
    expect(clock.sleeps).toEqual([100, 200, 300]);
    expect(ledger.getAsset(out.assets[0]!.sha256)?.sourceJobId).toBe(out.job.id);

    // Re-submitting the same idempotency key does not pay twice.
    const again = await runner.submit(newJob("k1"));
    expect(again.outcome).toBe("succeeded");
    expect(handler.calls.submit).toBe(1);
    ledger.close();
  });

  it("enforces concurrency", async () => {
    const ledger = new SqliteLedger(await dbPath());
    let active = 0;
    let peak = 0;
    const handler: JobHandler = {
      async submit(job) {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return { providerTaskId: job.id };
      },
      async poll() {
        return { status: "succeeded" };
      },
      async download() {
        return [];
      },
    };
    const runner = new JobRunner({ ledger, handlers: { video: handler }, concurrency: 2 });
    const outs = await Promise.all([1, 2, 3, 4, 5].map((i) => runner.submit(newJob(`k${i}`))));
    expect(outs.every((o) => o.outcome === "succeeded")).toBe(true);
    expect(peak).toBe(2);
    ledger.close();
  });

  it("marks provider failures and submit errors as failed", async () => {
    const ledger = new SqliteLedger(await dbPath());
    const clock = fakeClock();
    const failing = fakeHandler({ pollScript: () => ({ status: "failed", error: "moderation" }) });
    const badSubmit: JobHandler = { ...fakeHandler(), submit: async () => { throw new Error("402"); } };
    const runner = new JobRunner({ ledger, handlers: { video: failing, bad: badSubmit }, now: clock.now, sleep: clock.sleep });
    const a = await runner.submit(newJob("k1"));
    expect(a).toMatchObject({ outcome: "failed", job: { status: "failed", error: "moderation" } });
    const b = await runner.submit({ ...newJob("k2"), kind: "bad" });
    expect(b).toMatchObject({ outcome: "failed", job: { status: "failed", error: "submit: 402", attempts: 1 } });
    ledger.close();
  });

  it("bounded polling: times out leaving the job resumable", async () => {
    const ledger = new SqliteLedger(await dbPath());
    const clock = fakeClock();
    const handler = fakeHandler({ pollScript: () => ({ status: "running" }) });
    const runner = new JobRunner({
      ledger,
      handlers: { video: handler },
      now: clock.now,
      sleep: clock.sleep,
      polling: { initialDelayMs: 1000, factor: 2, maxDelayMs: 4000, maxDurationMs: 10_000 },
    });
    const out = await runner.submit(newJob("k1"));
    expect(out.outcome).toBe("timeout");
    expect(out.job.status).toBe("running");
    expect(clock.now()).toBeGreaterThanOrEqual(10_000);
    expect(clock.now()).toBeLessThan(10_000 + 4000 + 1);
    ledger.close();
  });

  it("stops polling when the job is cancelled externally", async () => {
    const ledger = new SqliteLedger(await dbPath());
    const clock = fakeClock();
    let jobId = "";
    const handler = fakeHandler({
      pollScript: (n) => {
        if (n === 2) ledger.updateJob(jobId, { status: "cancelled" });
        return { status: "running" };
      },
    });
    const runner = new JobRunner({ ledger, handlers: { video: handler }, now: clock.now, sleep: clock.sleep });
    jobId = ledger.createJob(newJob("k1")).id;
    const out = await runner.enqueue(jobId);
    expect(out.outcome).toBe("cancelled");
    expect(handler.calls.poll).toBe(2);
    ledger.close();
  });

  it("crash/resume: a job left in `submitted` resumes by polling, never re-submitting", async () => {
    const path = await dbPath();
    const clock = fakeClock();

    // Process 1: submits, then polling keeps failing (simulated crash/network loss).
    let ledger = new SqliteLedger(path);
    const h1 = fakeHandler({ pollScript: () => new Error("ECONNRESET") });
    const r1 = new JobRunner({
      ledger,
      handlers: { video: h1 },
      now: clock.now,
      sleep: clock.sleep,
      polling: { maxConsecutiveErrors: 2 },
    });
    const first = await r1.submit(newJob("k1"));
    expect(first.outcome).toBe("interrupted");
    expect(first.job).toMatchObject({ status: "submitted", providerTaskId: "task-k1", attempts: 1 });
    expect(h1.calls.submit).toBe(1);
    // A second job that was only queued when the "crash" happened.
    const queued = ledger.createJob(newJob("k2"));
    ledger.close();

    // Process 2: fresh ledger handle and runner; resume.
    ledger = new SqliteLedger(path);
    const h2 = fakeHandler({ pollsUntilDone: 1 });
    const r2 = new JobRunner({ ledger, handlers: { video: h2 }, now: clock.now, sleep: clock.sleep });
    const outs = await r2.resumeIncomplete("p1");
    expect(outs.map((o) => o.outcome)).toEqual(["succeeded", "succeeded"]);
    const resumed = outs.find((o) => o.job.idempotencyKey === "k1")!;
    expect(resumed.job).toMatchObject({ status: "succeeded", providerTaskId: "task-k1", attempts: 1 });
    // Only the queued job was submitted; the already-submitted one was polled.
    expect(h2.calls.submit).toBe(1);
    expect(ledger.getJob(queued.id)?.providerTaskId).toBe("task-k2");
    expect(h2.calls.poll).toBe(2);
    expect(await r2.resumeIncomplete("p1")).toEqual([]);
    ledger.close();
  });

  it("download failure leaves the job resumable and a resume re-downloads without re-submitting", async () => {
    const path = await dbPath();
    const clock = fakeClock();
    let ledger = new SqliteLedger(path);
    const h1 = fakeHandler({ pollsUntilDone: 1 });
    h1.download = async () => {
      throw new Error("URL expired?");
    };
    const r1 = new JobRunner({ ledger, handlers: { video: h1 }, now: clock.now, sleep: clock.sleep });
    const first = await r1.submit(newJob("k1"));
    expect(first).toMatchObject({ outcome: "interrupted", job: { status: "submitted" } });
    ledger.close();

    ledger = new SqliteLedger(path);
    const h2 = fakeHandler({ pollsUntilDone: 1 });
    const r2 = new JobRunner({ ledger, handlers: { video: h2 }, now: clock.now, sleep: clock.sleep });
    const [out] = await r2.resumeIncomplete("p1");
    expect(out).toMatchObject({ outcome: "succeeded", job: { error: null } });
    expect(h2.calls).toEqual({ submit: 0, poll: 1, download: 1 });
    ledger.close();
  });

  it("dedupes concurrent enqueue of the same job and rejects unknown kinds", async () => {
    const ledger = new SqliteLedger(await dbPath());
    const clock = fakeClock();
    const handler = fakeHandler({ pollsUntilDone: 1 });
    const runner = new JobRunner({ ledger, handlers: { video: handler }, now: clock.now, sleep: clock.sleep });
    const id = ledger.createJob(newJob("k1")).id;
    const [a, b] = await Promise.all([runner.enqueue(id), runner.enqueue(id)]);
    expect(a).toBe(b);
    expect(handler.calls.submit).toBe(1);
    const other = ledger.createJob({ ...newJob("k2"), kind: "nope" });
    await expect(runner.enqueue(other.id)).rejects.toThrow(/no job handler/);
    ledger.close();
  });
});

import PQueue from "p-queue";
import { isTerminal, type JobRecord, type Ledger, type NewJob, INCOMPLETE_STATUSES } from "./ledger.js";

/** An output a handler has downloaded (usually already put into the CAS). */
export interface DownloadedAsset {
  sha256: string;
  path: string;
  kind: string;
  bytes: number;
}

export interface PollResult {
  /** `pending`/`running`: keep polling. */
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  result?: unknown;
  error?: string;
  costUsd?: number;
}

export interface JobHandlerContext {
  /** Pass to the provider as its idempotency key where supported. */
  idempotencyKey: string;
  /** Aborted when the runner is stopped. */
  signal: AbortSignal;
}

/**
 * Per-kind provider handler. `submit` is called at most once per successful
 * submission: once a provider task id is persisted, the runner only polls.
 */
export interface JobHandler {
  submit(job: JobRecord, ctx: JobHandlerContext): Promise<{ providerTaskId: string; costUsd?: number }>;
  poll(job: JobRecord, ctx: JobHandlerContext): Promise<PollResult>;
  download(job: JobRecord, ctx: JobHandlerContext): Promise<DownloadedAsset[]>;
}

export interface PollingOptions {
  initialDelayMs: number;
  maxDelayMs: number;
  factor: number;
  /** Stop polling (leaving the job resumable) after this long. */
  maxDurationMs: number;
  /** Stop polling (leaving the job resumable) after this many consecutive poll errors. */
  maxConsecutiveErrors: number;
}

export const DEFAULT_POLLING: PollingOptions = {
  initialDelayMs: 2_000,
  maxDelayMs: 30_000,
  factor: 1.5,
  maxDurationMs: 30 * 60_000,
  maxConsecutiveErrors: 5,
};

export interface JobRunnerOptions {
  ledger: Ledger;
  handlers: Record<string, JobHandler>;
  concurrency?: number;
  polling?: Partial<PollingOptions>;
  /** Injectable for tests. */
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * - `succeeded` / `failed` / `cancelled`: job reached that terminal state.
 * - `timeout`: polling budget exhausted; job left in submitted/running, resumable.
 * - `interrupted`: repeated poll/download errors or runner stopped; job resumable.
 */
export type JobOutcomeKind = "succeeded" | "failed" | "cancelled" | "timeout" | "interrupted";

export interface JobOutcome {
  outcome: JobOutcomeKind;
  job: JobRecord;
  assets: DownloadedAsset[];
  error?: string;
}

export class NoHandlerError extends Error {
  constructor(readonly kind: string) {
    super(`no job handler registered for kind "${kind}"`);
    this.name = "NoHandlerError";
  }
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Executes ledger jobs through per-kind handlers with bounded concurrency.
 * Every state change is persisted to the ledger before the next step, so a
 * crash at any point can be resumed with `resumeIncomplete` without
 * re-submitting a job that already has a provider task id.
 */
export class JobRunner {
  private readonly ledger: Ledger;
  private readonly handlers: Record<string, JobHandler>;
  private readonly queue: PQueue;
  private readonly polling: PollingOptions;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly inFlight = new Map<string, Promise<JobOutcome>>();
  private readonly abort = new AbortController();

  constructor(options: JobRunnerOptions) {
    this.ledger = options.ledger;
    this.handlers = options.handlers;
    this.queue = new PQueue({ concurrency: options.concurrency ?? 2 });
    this.polling = { ...DEFAULT_POLLING, ...options.polling };
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Create (idempotently) and run a job. */
  submit(job: NewJob): Promise<JobOutcome> {
    return this.enqueue(this.ledger.createJob(job).id);
  }

  /** Run an existing ledger job. Enqueueing a job already in flight returns the same promise. */
  enqueue(jobId: string): Promise<JobOutcome> {
    const existing = this.inFlight.get(jobId);
    if (existing) return existing;
    const p = this.queue
      .add(() => this.run(jobId), { throwOnTimeout: true })
      .finally(() => this.inFlight.delete(jobId));
    this.inFlight.set(jobId, p);
    return p;
  }

  /** Re-enqueue every queued/submitted/running job for a project. */
  resumeIncomplete(projectId: string): Promise<JobOutcome[]> {
    const jobs = this.ledger.listJobs({ projectId, status: INCOMPLETE_STATUSES });
    return Promise.all(jobs.map((j) => this.enqueue(j.id)));
  }

  onIdle(): Promise<void> {
    return this.queue.onIdle();
  }

  /** Stop polling; in-flight jobs finish as `interrupted` and stay resumable. */
  async stop(): Promise<void> {
    this.queue.clear();
    this.abort.abort();
    await Promise.allSettled([...this.inFlight.values()]);
  }

  private async run(jobId: string): Promise<JobOutcome> {
    let job = this.ledger.getJob(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    const handler = this.handlers[job.kind];
    if (!handler) throw new NoHandlerError(job.kind);
    const ctx: JobHandlerContext = { idempotencyKey: job.idempotencyKey, signal: this.abort.signal };

    if (isTerminal(job.status)) return this.terminalOutcome(job);
    if (this.abort.signal.aborted) return { outcome: "interrupted", job, assets: [] };

    // Step 1: submit only if no provider task exists yet.
    if (job.status === "queued" || !job.providerTaskId) {
      // Record the attempt *before* calling out, so a crash mid-submit is visible.
      job = this.ledger.updateJob(job.id, { attempts: job.attempts + 1 });
      let submitted: { providerTaskId: string; costUsd?: number };
      try {
        submitted = await handler.submit(job, ctx);
      } catch (err) {
        job = this.ledger.updateJob(job.id, { status: "failed", error: `submit: ${errMsg(err)}` });
        return { outcome: "failed", job, assets: [], error: job.error ?? undefined };
      }
      job = this.ledger.updateJob(job.id, {
        status: "submitted",
        providerTaskId: submitted.providerTaskId,
        ...(submitted.costUsd !== undefined ? { costUsd: submitted.costUsd } : {}),
      });
    }

    // Step 2: bounded polling with exponential backoff.
    const started = this.now();
    let delay = this.polling.initialDelayMs;
    let errors = 0;
    for (;;) {
      const fresh = this.ledger.getJob(job.id);
      if (!fresh) throw new Error(`job vanished: ${job.id}`);
      job = fresh;
      if (isTerminal(job.status)) return this.terminalOutcome(job); // e.g. cancelled externally
      if (this.abort.signal.aborted) return { outcome: "interrupted", job, assets: [] };

      let res: PollResult | undefined;
      try {
        res = await handler.poll(job, ctx);
        errors = 0;
      } catch (err) {
        errors++;
        if (errors >= this.polling.maxConsecutiveErrors) {
          job = this.ledger.updateJob(job.id, { error: `poll: ${errMsg(err)}` });
          return { outcome: "interrupted", job, assets: [], error: job.error ?? undefined };
        }
      }

      if (res) {
        const cost = res.costUsd !== undefined ? { costUsd: res.costUsd } : {};
        if (res.status === "succeeded") return this.finish(handler, job, ctx, res);
        if (res.status === "failed" || res.status === "cancelled") {
          job = this.ledger.updateJob(job.id, {
            status: res.status,
            error: res.error ?? null,
            ...(res.result !== undefined ? { result: res.result } : {}),
            ...cost,
          });
          return { outcome: res.status, job, assets: [], error: job.error ?? undefined };
        }
        if (res.status === "running" && job.status !== "running") {
          job = this.ledger.updateJob(job.id, { status: "running", ...cost });
        }
      }

      if (this.now() - started >= this.polling.maxDurationMs) {
        return { outcome: "timeout", job, assets: [], error: "polling exceeded maxDurationMs" };
      }
      await this.sleep(delay, this.abort.signal);
      delay = Math.min(this.polling.maxDelayMs, delay * this.polling.factor);
    }
  }

  /** Step 3: download immediately (provider URLs expire), record assets, then mark succeeded. */
  private async finish(
    handler: JobHandler,
    job: JobRecord,
    ctx: JobHandlerContext,
    res: PollResult,
  ): Promise<JobOutcome> {
    let assets: DownloadedAsset[];
    try {
      assets = await handler.download(job, ctx);
    } catch (err) {
      // Leave non-terminal: a resume will poll (succeeded again) and retry the download.
      const updated = this.ledger.updateJob(job.id, { error: `download: ${errMsg(err)}` });
      return { outcome: "interrupted", job: updated, assets: [], error: updated.error ?? undefined };
    }
    for (const a of assets) {
      this.ledger.recordAsset({ sha256: a.sha256, path: a.path, kind: a.kind, bytes: a.bytes, sourceJobId: job.id });
    }
    const updated = this.ledger.updateJob(job.id, {
      status: "succeeded",
      error: null,
      result: res.result ?? { assets: assets.map((a) => ({ sha256: a.sha256, kind: a.kind })) },
      ...(res.costUsd !== undefined ? { costUsd: res.costUsd } : {}),
    });
    return { outcome: "succeeded", job: updated, assets };
  }

  private terminalOutcome(job: JobRecord): JobOutcome {
    return {
      outcome: job.status as "succeeded" | "failed" | "cancelled",
      job,
      assets: [],
      ...(job.error ? { error: job.error } : {}),
    };
  }
}

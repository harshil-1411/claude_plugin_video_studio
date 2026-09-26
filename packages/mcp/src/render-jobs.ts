import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type Ledger, openLedger, resolveDataDir } from "@video-studio/core";
import { type RenderProgress, type RenderProjectOptions, type RenderProjectResult, SpecInvalidError, renderProject } from "./pipeline.js";

type Env = Record<string, string | undefined>;

export type RenderJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

/** Statuses of a job that still holds (or waits for) the render slot. */
export function isActiveJob(status: RenderJobStatus): boolean {
  return status === "queued" || status === "running";
}

export interface RenderJobView {
  job_id: string;
  project_dir: string;
  status: RenderJobStatus;
  /** Jobs ahead of this one (queued only). */
  queue_position?: number;
  progress: RenderProgress;
  submitted_at: string;
  started_at?: string;
  finished_at?: string;
  request: RenderJobRequest;
  /**
   * The render result. After an engine restart it is read back from the ledger: the full result
   * for jobs recorded by this version, or a {@link RenderJobSummary} for older records.
   */
  result?: RenderProjectResult | RenderJobSummary;
  error?: string;
  /** Machine-readable error code of a failed job (see {@link errorCode}). */
  error_code?: ErrorCode;
  /** Spec validation errors when the render was refused. */
  spec_errors?: SpecInvalidError["errors"];
}

/** Machine-readable codes on tool error results (and failed render jobs). */
export type ErrorCode = "RENDER_LOCKED" | "SPEC_INVALID" | "MODEL_MISSING" | `FFMPEG_${string}` | "NOT_FOUND" | "REFUSED" | "CANCELLED" | "ERROR";

const REFUSED_RE = /^refusing\b|\brefusing to\b|\bmust be (a path |a file )?inside the project|\b(is|resolves) outside the project|\bescaped the project|^path "[^"]*" rejected:|embedded credentials/i;
const NOT_FOUND_RE = /\bnot found\b|\bdoes not exist\b|^unknown job\b|\bno such file\b|\bENOENT\b/i;

/** Code for a plain message (used for each failure of an ingest). */
function messageCode(message: string): ErrorCode {
  if (REFUSED_RE.test(message)) return "REFUSED";
  if (NOT_FOUND_RE.test(message)) return "NOT_FOUND";
  return "ERROR";
}

/**
 * Classify an error for skills to branch on: RENDER_LOCKED, SPEC_INVALID, MODEL_MISSING,
 * FFMPEG_<KIND> (FfmpegError kinds, e.g. FFMPEG_MISSING_ENCODER; FFMPEG_NOT_INSTALLED),
 * REFUSED (path confinement, private-address URLs, credential files), NOT_FOUND, CANCELLED, else ERROR.
 * Matches on error names, not classes, so copies of a class from another bundle chunk still match.
 */
export function errorCode(err: unknown): ErrorCode {
  if (!(err instanceof Error)) return "ERROR";
  const e = err as Error & { kind?: string; code?: string; failures?: Array<{ error?: string }> };
  switch (e.name) {
    case "RenderLockedError":
      return "RENDER_LOCKED";
    case "SpecInvalidError":
      return "SPEC_INVALID";
    case "FfmpegError":
      return `FFMPEG_${(e.kind ?? "unknown").toUpperCase()}`;
    case "MediaToolError":
      return "FFMPEG_NOT_INSTALLED";
    case "AbortError":
      return "CANCELLED";
    case "PathTraversalError":
    case "BlockedAddressError":
      return "REFUSED";
    case "UrlFetchError":
      if (e.code === "blocked_address") return "REFUSED";
      break;
    case "TranscribeError":
      if (/^no whisper model at |^VS_WHISPER_MODEL points at /.test(e.message)) return "MODEL_MISSING";
      break;
    case "IngestError": {
      const codes = new Set((e.failures ?? []).map((f) => messageCode(f.error ?? "")));
      return codes.size === 1 ? [...codes][0]! : "ERROR";
    }
  }
  if (e.code === "ENOENT") return "NOT_FOUND";
  return messageCode(e.message);
}

/** What older ledgers recorded for a succeeded job (before the full result was persisted). */
export interface RenderJobSummary {
  summary: true;
  dist?: RenderProjectResult["dist"];
  qa_status?: string;
  voice_backend?: string;
  renderers_used?: string[];
}

/** Ledger copy of a result: the full result, JSON-safe, with the warning list capped. */
function ledgerResult(result: RenderProjectResult): unknown {
  return JSON.parse(JSON.stringify({ ...result, warnings: result.warnings.slice(0, 100) }));
}

/** A ledger result back as a view result: a full result as is, an old summary tagged as one. */
function restoredResult(raw: unknown): RenderProjectResult | RenderJobSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.qa && typeof r.qa === "object" && r.voice && typeof r.voice === "object" && r.renderer && typeof r.renderer === "object") return raw as RenderProjectResult;
  return {
    summary: true,
    ...(r.dist && typeof r.dist === "object" ? { dist: r.dist as RenderProjectResult["dist"] } : {}),
    ...(typeof r.qa === "string" ? { qa_status: r.qa } : {}),
    ...(typeof r.voice === "string" ? { voice_backend: r.voice } : {}),
    ...(Array.isArray(r.renderer) ? { renderers_used: r.renderer.filter((x): x is string => typeof x === "string") } : {}),
  };
}

export type RenderJobRequest = Pick<RenderProjectOptions, "voice" | "renderer" | "quality" | "placeholder" | "brandPath"> & { burn_in_captions?: boolean };

export interface RenderJobManagerOptions {
  env?: Env;
  /** Ledger file; null disables persistence. Default `<data dir>/db/ledger.sqlite`. */
  ledgerPath?: string | null;
  /** Extra options merged into every render (tests: tiny targets, fake backends). */
  renderDefaults?: Partial<RenderProjectOptions>;
  /** Injectable render function (tests). */
  run?: (projectDir: string, o: RenderProjectOptions) => Promise<RenderProjectResult>;
}

/**
 * In-process render jobs. Renders run one at a time (memory), in submission order, in the
 * background so the MCP call returns a job id immediately. State lives in memory and is mirrored
 * to the ledger (best effort), so `job_status` after a server restart reports `interrupted`
 * instead of "unknown". Re-submitting resumes cheaply: every stage is cached on disk.
 */
export class RenderJobManager {
  private readonly jobs = new Map<string, RenderJobView>();
  private readonly order: string[] = [];
  private tail: Promise<void> = Promise.resolve();
  private readonly env: Env;
  private ledger: Ledger | null | undefined;
  private readonly ledgerPath: string | null;
  /** Aborted by close(): every job stops. */
  private readonly abort = new AbortController();
  /** Per-job controllers (cancel) and the promise of the job's execution. */
  private readonly controllers = new Map<string, AbortController>();
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly o: RenderJobManagerOptions = {}) {
    this.env = o.env ?? process.env;
    if (o.ledgerPath === null) this.ledgerPath = null;
    else {
      try {
        this.ledgerPath = o.ledgerPath ?? join(resolveDataDir(this.env).db, "ledger.sqlite");
      } catch {
        this.ledgerPath = null;
      }
    }
  }

  private getLedger(): Ledger | null {
    if (this.ledger !== undefined) return this.ledger;
    try {
      this.ledger = this.ledgerPath ? openLedger(this.ledgerPath) : null;
    } catch (e) {
      console.error(`video-studio: render jobs are not persisted (ledger unavailable: ${e instanceof Error ? e.message : String(e)})`);
      this.ledger = null;
    }
    return this.ledger;
  }

  private persist(fn: (l: Ledger) => void): void {
    const l = this.getLedger();
    if (!l) return;
    try {
      fn(l);
    } catch (e) {
      console.error(`video-studio: ledger write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  submit(projectDir: string, request: RenderJobRequest): RenderJobView {
    const job_id = `render-${randomUUID()}`;
    const view: RenderJobView = {
      job_id,
      project_dir: projectDir,
      status: "queued",
      progress: { stage: "queued", message: "waiting for the render slot" },
      submitted_at: new Date().toISOString(),
      request,
    };
    this.jobs.set(job_id, view);
    this.order.push(job_id);
    this.controllers.set(job_id, new AbortController());
    this.persist((l) =>
      l.createJob({ id: job_id, projectId: projectDir, kind: "render", provider: "local", idempotencyKey: job_id, request: { project_dir: projectDir, ...request } }),
    );
    this.tail = this.tail.then(() => {
      const p = this.execute(view);
      this.running.set(job_id, p);
      return p.finally(() => this.running.delete(job_id));
    });
    return this.status(job_id)!;
  }

  private async execute(view: RenderJobView): Promise<void> {
    const own = this.controllers.get(view.job_id)!;
    if (this.abort.signal.aborted || view.status !== "queued") {
      if (view.status === "queued") {
        view.status = "interrupted";
        view.progress = { stage: "queued", message: "the engine shut down before this job started; submit it again" };
      }
      this.controllers.delete(view.job_id);
      return;
    }
    view.status = "running";
    view.started_at = new Date().toISOString();
    view.progress = { stage: "validate", message: "starting" };
    this.persist((l) => l.updateJob(view.job_id, { status: "running", attempts: 1 }));
    const run = this.o.run ?? renderProject;
    const r = view.request;
    try {
      const result = await run(view.project_dir, {
        ...this.o.renderDefaults,
        env: this.env,
        signal: AbortSignal.any([this.abort.signal, own.signal]),
        ...(r.voice ? { voice: r.voice } : {}),
        ...(r.renderer ? { renderer: r.renderer } : {}),
        ...(r.quality ? { quality: r.quality } : {}),
        ...(r.placeholder !== undefined ? { placeholder: r.placeholder } : {}),
        ...(r.brandPath ? { brandPath: r.brandPath } : {}),
        ...(r.burn_in_captions !== undefined ? { captions: { burn_in: r.burn_in_captions } } : {}),
        onProgress: (p) => {
          view.progress = p;
        },
      });
      view.status = "succeeded";
      view.result = result;
      view.progress = { stage: "done", message: "done" };
      this.persist((l) =>
        l.updateJob(view.job_id, {
          status: "succeeded",
          result: ledgerResult(result),
        }),
      );
    } catch (e) {
      if (own.signal.aborted) {
        view.status = "cancelled";
        view.progress = { stage: "done", message: "cancelled; submit again to resume (cached work is reused)" };
        this.persist((l) => l.updateJob(view.job_id, { status: "cancelled" }));
      } else if (this.abort.signal.aborted) {
        // Engine shutdown: the ledger keeps "running", so job_status after a restart says interrupted.
        view.status = "interrupted";
        view.progress = { stage: "done", message: "the engine shut down before this job finished; submit it again (cached work is reused)" };
      } else {
        view.status = "failed";
        view.error = e instanceof Error ? e.message : String(e);
        view.error_code = errorCode(e);
        if (e instanceof SpecInvalidError) view.spec_errors = e.errors;
        this.persist((l) => l.updateJob(view.job_id, { status: "failed", error: view.error!.slice(0, 4000) }));
      }
    } finally {
      view.finished_at = new Date().toISOString();
      this.controllers.delete(view.job_id);
    }
  }

  /**
   * Cancel a queued or running job. A queued job is dropped at once; a running one is aborted
   * (its ffmpeg/TTS children are killed, the render lock released, temp files removed) and this
   * waits up to `waitMs` for it to stop. Returns the job's view, or undefined for an unknown id.
   * Finished jobs are returned unchanged.
   */
  async cancel(jobId: string, waitMs = 10_000): Promise<RenderJobView | undefined> {
    const view = this.jobs.get(jobId);
    if (!view) return this.status(jobId);
    if (view.status === "queued") {
      view.status = "cancelled";
      view.finished_at = new Date().toISOString();
      view.progress = { stage: "done", message: "cancelled before it started" };
      this.controllers.get(jobId)?.abort(new Error("render job cancelled"));
      this.controllers.delete(jobId);
      this.persist((l) => l.updateJob(jobId, { status: "cancelled" }));
      return this.status(jobId);
    }
    if (view.status !== "running") return this.status(jobId);
    view.progress = { ...view.progress, message: "cancelling" };
    this.controllers.get(jobId)?.abort(new Error("render job cancelled"));
    const p = this.running.get(jobId);
    if (p) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([p.catch(() => {}), new Promise<void>((r) => (timer = setTimeout(r, waitMs)))]);
      clearTimeout(timer);
    }
    return this.status(jobId);
  }

  status(jobId: string): RenderJobView | undefined {
    const v = this.jobs.get(jobId);
    if (v) {
      if (v.status !== "queued") return { ...v };
      const ahead = this.order.filter((id) => {
        const j = this.jobs.get(id)!;
        return id !== jobId && (j.status === "running" || (j.status === "queued" && this.order.indexOf(id) < this.order.indexOf(jobId)));
      }).length;
      return { ...v, queue_position: ahead };
    }
    const rec = this.getLedger()?.getJob(jobId);
    if (!rec || rec.kind !== "render") return undefined;
    const req = (rec.request ?? {}) as RenderJobRequest & { project_dir?: string };
    const terminal = rec.status === "succeeded" || rec.status === "failed" || rec.status === "cancelled";
    const result = terminal ? restoredResult(rec.result) : undefined;
    return {
      job_id: rec.id,
      project_dir: req.project_dir ?? rec.projectId,
      status: terminal ? (rec.status as "succeeded" | "failed" | "cancelled") : "interrupted",
      progress: { stage: terminal ? "done" : "queued", message: terminal ? rec.status : "the engine restarted before this job finished; submit it again (cached work is reused)" },
      submitted_at: rec.createdAt,
      request: req,
      ...(rec.error ? { error: rec.error } : {}),
      ...(terminal ? { finished_at: rec.updatedAt } : {}),
      ...(result ? { result } : {}),
    };
  }

  /** Wait for every queued job (tests). */
  idle(): Promise<void> {
    return this.tail;
  }

  /** Jobs that are queued or running. */
  activeJobs(): RenderJobView[] {
    return this.order.map((id) => this.jobs.get(id)!).filter((v) => isActiveJob(v.status));
  }

  /**
   * Abort every job and wait (up to `waitMs`) for the running one to unwind: its children are
   * killed (SIGTERM, then SIGKILL), the render lock is released and temp files are removed.
   */
  async close(waitMs = 15_000): Promise<void> {
    this.abort.abort(new Error("render engine shutting down"));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.tail.catch(() => {}), new Promise<void>((r) => (timer = setTimeout(r, waitMs)))]);
    clearTimeout(timer);
    this.ledger?.close();
    this.ledger = null;
  }
}

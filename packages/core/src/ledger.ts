import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { canonicalJson } from "./canonical.js";

export const JOB_STATUSES = ["queued", "submitted", "running", "succeeded", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(["succeeded", "failed", "cancelled"]);
export const INCOMPLETE_STATUSES: readonly JobStatus[] = ["queued", "submitted", "running"];

/** Allowed status transitions. Same-status updates of non-terminal jobs are allowed (e.g. bump attempts). */
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["queued", "submitted", "running", "failed", "cancelled"],
  submitted: ["submitted", "running", "succeeded", "failed", "cancelled"],
  running: ["running", "succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface JobRecord {
  id: string;
  projectId: string;
  sceneId: string | null;
  kind: string;
  provider: string;
  idempotencyKey: string;
  status: JobStatus;
  providerTaskId: string | null;
  request: unknown;
  result: unknown;
  error: string | null;
  attempts: number;
  costUsd: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewJob {
  id?: string;
  projectId: string;
  sceneId?: string | null;
  kind: string;
  provider: string;
  idempotencyKey: string;
  request?: unknown;
}

export interface JobPatch {
  status?: JobStatus;
  providerTaskId?: string | null;
  result?: unknown;
  error?: string | null;
  attempts?: number;
  costUsd?: number | null;
}

export interface AssetRecord {
  sha256: string;
  path: string;
  kind: string;
  bytes: number;
  sourceJobId: string | null;
  createdAt: string;
}

export interface NewAsset {
  sha256: string;
  path: string;
  kind: string;
  bytes: number;
  sourceJobId?: string | null;
}

export interface ListJobsFilter {
  projectId?: string;
  status?: JobStatus | readonly JobStatus[];
}

export class IllegalTransitionError extends Error {
  constructor(readonly jobId: string, readonly from: JobStatus, readonly to: JobStatus) {
    super(`job ${jobId}: illegal status transition ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export class JobNotFoundError extends Error {
  constructor(readonly jobId: string) {
    super(`job not found: ${jobId}`);
    this.name = "JobNotFoundError";
  }
}

/** Storage-agnostic DAO so node:sqlite could be swapped for better-sqlite3 later. */
export interface Ledger {
  /** Idempotent by `idempotencyKey`: returns the existing job if one exists. */
  createJob(job: NewJob): JobRecord;
  /** Validates the status transition; terminal jobs cannot be updated. */
  updateJob(id: string, patch: JobPatch): JobRecord;
  getJob(id: string): JobRecord | undefined;
  getJobByKey(idempotencyKey: string): JobRecord | undefined;
  listJobs(filter?: ListJobsFilter): JobRecord[];
  /** Idempotent by sha256: returns the existing row if present. */
  recordAsset(asset: NewAsset): AssetRecord;
  getAsset(sha256: string): AssetRecord | undefined;
  close(): void;
}

interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE jobs (
        id               TEXT PRIMARY KEY,
        project_id       TEXT NOT NULL,
        scene_id         TEXT,
        kind             TEXT NOT NULL,
        provider         TEXT NOT NULL,
        idempotency_key  TEXT NOT NULL UNIQUE,
        status           TEXT NOT NULL CHECK (status IN ('queued','submitted','running','succeeded','failed','cancelled')),
        provider_task_id TEXT,
        request_json     TEXT,
        result_json      TEXT,
        error            TEXT,
        attempts         INTEGER NOT NULL DEFAULT 0,
        cost_usd         REAL,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE INDEX jobs_project_status ON jobs(project_id, status);
      CREATE TABLE assets (
        sha256        TEXT PRIMARY KEY,
        path          TEXT NOT NULL,
        kind          TEXT NOT NULL,
        bytes         INTEGER NOT NULL,
        source_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX assets_source_job ON assets(source_job_id);
    `,
  },
];

export interface SqliteLedgerOptions {
  /** Milliseconds to wait on a locked database (default 5000). */
  busyTimeoutMs?: number;
  /** Injectable clock for timestamps. */
  now?: () => Date;
}

type Row = Record<string, SQLInputValue>;

function toJson(value: unknown): string | null {
  return value === undefined ? null : canonicalJson(value);
}

function fromJson(text: unknown): unknown {
  return typeof text === "string" ? JSON.parse(text) : null;
}

function rowToJob(r: Row): JobRecord {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    sceneId: (r.scene_id as string | null) ?? null,
    kind: r.kind as string,
    provider: r.provider as string,
    idempotencyKey: r.idempotency_key as string,
    status: r.status as JobStatus,
    providerTaskId: (r.provider_task_id as string | null) ?? null,
    request: fromJson(r.request_json),
    result: fromJson(r.result_json),
    error: (r.error as string | null) ?? null,
    attempts: Number(r.attempts),
    costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function rowToAsset(r: Row): AssetRecord {
  return {
    sha256: r.sha256 as string,
    path: r.path as string,
    kind: r.kind as string,
    bytes: Number(r.bytes),
    sourceJobId: (r.source_job_id as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

/** Ledger backed by the built-in `node:sqlite` module. */
export class SqliteLedger implements Ledger {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(path: string, options: SqliteLedgerOptions = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.now = options.now ?? (() => new Date());
    this.db.exec(`PRAGMA busy_timeout = ${Math.trunc(options.busyTimeoutMs ?? 5000)}`);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const row = this.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as Row | undefined;
    const current = Number(row?.v ?? 0);
    const latest = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
    if (current > latest) {
      throw new Error(`ledger schema version ${current} is newer than this build supports (${latest})`);
    }
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      this.tx(() => {
        this.db.exec(m.sql);
        this.db
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(m.version, this.now().toISOString());
      });
    }
  }

  /** Current schema version (highest applied migration). */
  schemaVersion(): number {
    const row = this.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as Row | undefined;
    return Number(row?.v ?? 0);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  createJob(job: NewJob): JobRecord {
    const ts = this.now().toISOString();
    return this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO jobs (id, project_id, scene_id, kind, provider, idempotency_key, status,
                             request_json, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?)
           ON CONFLICT(idempotency_key) DO NOTHING`,
        )
        .run(
          job.id ?? randomUUID(),
          job.projectId,
          job.sceneId ?? null,
          job.kind,
          job.provider,
          job.idempotencyKey,
          toJson(job.request),
          ts,
          ts,
        );
      const existing = this.getJobByKey(job.idempotencyKey);
      if (!existing) throw new Error(`failed to create job ${job.idempotencyKey}`);
      return existing;
    });
  }

  updateJob(id: string, patch: JobPatch): JobRecord {
    return this.tx(() => {
      const job = this.getJob(id);
      if (!job) throw new JobNotFoundError(id);
      const to = patch.status ?? job.status;
      if (isTerminal(job.status) || !canTransition(job.status, to)) {
        throw new IllegalTransitionError(id, job.status, to);
      }
      const sets: string[] = ["status = ?", "updated_at = ?"];
      const values: SQLInputValue[] = [to, this.now().toISOString()];
      if (patch.providerTaskId !== undefined) (sets.push("provider_task_id = ?"), values.push(patch.providerTaskId));
      if (patch.result !== undefined) (sets.push("result_json = ?"), values.push(toJson(patch.result)));
      if (patch.error !== undefined) (sets.push("error = ?"), values.push(patch.error));
      if (patch.attempts !== undefined) (sets.push("attempts = ?"), values.push(patch.attempts));
      if (patch.costUsd !== undefined) (sets.push("cost_usd = ?"), values.push(patch.costUsd));
      values.push(id);
      this.db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
      return this.getJob(id)!;
    });
  }

  getJob(id: string): JobRecord | undefined {
    const r = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToJob(r) : undefined;
  }

  getJobByKey(idempotencyKey: string): JobRecord | undefined {
    const r = this.db.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(idempotencyKey) as
      | Row
      | undefined;
    return r ? rowToJob(r) : undefined;
  }

  listJobs(filter: ListJobsFilter = {}): JobRecord[] {
    const where: string[] = [];
    const values: SQLInputValue[] = [];
    if (filter.projectId !== undefined) (where.push("project_id = ?"), values.push(filter.projectId));
    if (filter.status !== undefined) {
      const statuses: readonly JobStatus[] = typeof filter.status === "string" ? [filter.status] : filter.status;
      if (statuses.length === 0) return [];
      where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      values.push(...statuses);
    }
    const sql = `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, rowid`;
    return (this.db.prepare(sql).all(...values) as Row[]).map(rowToJob);
  }

  recordAsset(asset: NewAsset): AssetRecord {
    return this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO assets (sha256, path, kind, bytes, source_job_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING`,
        )
        .run(asset.sha256, asset.path, asset.kind, asset.bytes, asset.sourceJobId ?? null, this.now().toISOString());
      return this.getAsset(asset.sha256)!;
    });
  }

  getAsset(sha256: string): AssetRecord | undefined {
    const r = this.db.prepare("SELECT * FROM assets WHERE sha256 = ?").get(sha256) as Row | undefined;
    return r ? rowToAsset(r) : undefined;
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

export function openLedger(path: string, options?: SqliteLedgerOptions): Ledger {
  return new SqliteLedger(path, options);
}

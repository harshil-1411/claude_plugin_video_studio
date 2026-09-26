import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PathTraversalError, openLedger } from "@video-studio/core";
import { FfmpegError, MediaToolError } from "@video-studio/media";
import { BlockedAddressError } from "@video-studio/ingestion";
import { SpecInvalidError, type RenderProjectOptions, type RenderProjectResult } from "./pipeline.js";
import { RenderJobManager, errorCode } from "./render-jobs.js";
import { RenderLockedError, acquireRenderLock } from "./render-lock.js";
import { createServer } from "./server.js";
import { TranscribeError, missingModelError } from "./transcribe.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-cancel-"));
});
afterAll(() => rm(tmp, { recursive: true, force: true }));

/** A fake render that behaves like renderProject: takes the render lock, waits for the signal, releases the lock. */
function lockingRun(started: (dir: string) => void) {
  return async (dir: string, o: RenderProjectOptions): Promise<RenderProjectResult> => {
    const release = await acquireRenderLock(join(dir, "renders", ".render.lock"), o.quality ?? "preview");
    try {
      started(dir);
      await new Promise<void>((_, reject) => {
        const fail = () => reject(o.signal!.reason ?? new Error("aborted"));
        if (o.signal!.aborted) fail();
        o.signal!.addEventListener("abort", fail, { once: true });
      });
      throw new Error("unreachable");
    } finally {
      await release();
    }
  };
}

async function connect(jobs: RenderJobManager) {
  const server = createServer({ cwd: () => tmp, jobs });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

const text = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

describe("render cancel", () => {
  it("cancels a running job: status cancelled, lock released, ledger updated", async () => {
    const project = join(tmp, "p-running");
    const ledgerPath = join(tmp, "ledger-cancel.sqlite");
    let onStart!: () => void;
    const startedP = new Promise<void>((r) => (onStart = r));
    const jobs = new RenderJobManager({ ledgerPath, env: {}, run: lockingRun(() => onStart()) });
    const { job_id } = jobs.submit(project, {});
    await startedP;
    expect(jobs.status(job_id)!.status).toBe("running");
    expect(existsSync(join(project, "renders", ".render.lock"))).toBe(true);

    const t0 = Date.now();
    const v = await jobs.cancel(job_id);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(v!.status).toBe("cancelled");
    expect(existsSync(join(project, "renders", ".render.lock"))).toBe(false);
    await jobs.close();

    // After a restart the ledger still says cancelled.
    expect(openLedger(ledgerPath).getJob(job_id)!.status).toBe("cancelled");
    const after = new RenderJobManager({ ledgerPath, env: {} });
    expect(after.status(job_id)!.status).toBe("cancelled");
    await after.close();
  });

  it("cancels a queued job without running it; the next job still runs", async () => {
    const ran: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const jobs = new RenderJobManager({
      ledgerPath: null,
      env: {},
      run: async (dir) => {
        ran.push(dir);
        if (dir.endsWith("a")) await gate;
        return {} as RenderProjectResult;
      },
    });
    const a = jobs.submit(join(tmp, "q-a"), {});
    const b = jobs.submit(join(tmp, "q-b"), {});
    const c = jobs.submit(join(tmp, "q-c"), {});
    expect((await jobs.cancel(b.job_id))!.status).toBe("cancelled");
    release();
    await jobs.idle();
    expect(ran).toEqual([join(tmp, "q-a"), join(tmp, "q-c")]);
    expect(jobs.status(a.job_id)!.status).toBe("succeeded");
    expect(jobs.status(b.job_id)!.status).toBe("cancelled");
    expect(jobs.status(c.job_id)!.status).toBe("succeeded");
    // Cancelling a finished job changes nothing.
    expect((await jobs.cancel(a.job_id))!.status).toBe("succeeded");
    expect(await jobs.cancel("render-nope")).toBeUndefined();
    await jobs.close();
  });

  it("close() aborts the running job and releases its lock (engine shutdown)", async () => {
    const project = join(tmp, "p-close");
    let onStart!: () => void;
    const startedP = new Promise<void>((r) => (onStart = r));
    const jobs = new RenderJobManager({ ledgerPath: null, env: {}, run: lockingRun(() => onStart()) });
    const { job_id } = jobs.submit(project, {});
    const queued = jobs.submit(join(tmp, "p-close-2"), {});
    await startedP;
    await jobs.close(5000);
    expect(existsSync(join(project, "renders", ".render.lock"))).toBe(false);
    expect(jobs.status(job_id)!.status).toBe("interrupted");
    expect(jobs.status(queued.job_id)!.status).toBe("interrupted");
    expect(jobs.activeJobs()).toEqual([]);
  });

  it("render_cancel over MCP", async () => {
    const project = join(tmp, "p-mcp");
    let onStart!: () => void;
    const startedP = new Promise<void>((r) => (onStart = r));
    const jobs = new RenderJobManager({ ledgerPath: null, env: {}, run: lockingRun(() => onStart()) });
    const client = await connect(jobs);
    const { job_id } = jobs.submit(project, {});
    await startedP;
    const r = (await client.callTool({ name: "render_cancel", arguments: { job_id } })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain(`job ${job_id}: cancelled`);
    expect(r.structuredContent).toMatchObject({ status: "cancelled", cancel: "cancelled" });
    const again = (await client.callTool({ name: "render_cancel", arguments: { job_id } })) as CallToolResult;
    expect(again.structuredContent).toMatchObject({ status: "cancelled", cancel: "already cancelled" });
    const s = (await client.callTool({ name: "job_status", arguments: { job_id } })) as CallToolResult;
    expect(s.structuredContent).toMatchObject({ status: "cancelled" });
    const unknown = (await client.callTool({ name: "render_cancel", arguments: { job_id: "render-nope" } })) as CallToolResult;
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(/^\[NOT_FOUND\] error: unknown job render-nope/);
    expect(unknown.structuredContent).toMatchObject({ ok: false, code: "NOT_FOUND" });
    await client.close();
    await jobs.close();
  });
});

describe("tool annotations", () => {
  it("match what each tool does", async () => {
    const jobs = new RenderJobManager({ ledgerPath: null, env: {} });
    const client = await connect(jobs);
    const { tools } = await client.listTools();
    const a = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]));
    expect(a.lint).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(a.verify).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    for (const name of ["export", "test", "variants", "shorts", "ingest"]) expect(a[name], name).toMatchObject({ destructiveHint: true });
    expect(a.render_submit).toMatchObject({ openWorldHint: true, idempotentHint: false });
    expect(a.variants).toMatchObject({ openWorldHint: true });
    expect(a.render_cancel).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    await client.close();
    await jobs.close();
  });
});

describe("error codes", () => {
  it("classifies engine errors", () => {
    expect(errorCode(new RenderLockedError({ pid: 1, host: "h", started_at: "t" }, "/p/renders/.render.lock"))).toBe("RENDER_LOCKED");
    expect(errorCode(new SpecInvalidError([]))).toBe("SPEC_INVALID");
    expect(errorCode(missingModelError("/data/models/ggml.bin"))).toBe("MODEL_MISSING");
    expect(errorCode(new TranscribeError("asset x has no transcript"))).toBe("ERROR");
    expect(errorCode(new FfmpegError("x", "ffmpeg", [], 1, "", "missing_encoder"))).toBe("FFMPEG_MISSING_ENCODER");
    expect(errorCode(new FfmpegError("x", "ffmpeg", [], 1, ""))).toBe("FFMPEG_UNKNOWN");
    expect(errorCode(new MediaToolError("ffmpeg not found on PATH"))).toBe("FFMPEG_NOT_INSTALLED");
    expect(errorCode(new PathTraversalError("../x", "'..' segments are not allowed"))).toBe("REFUSED");
    expect(errorCode(new BlockedAddressError("http://127.0.0.1/", "127.0.0.1", "127.0.0.1"))).toBe("REFUSED");
    expect(errorCode(new Error("refusing to ingest a credential file: ~/.aws/credentials (aws)"))).toBe("REFUSED");
    expect(errorCode(new Error("demo script must be a path inside the project: ../x.json"))).toBe("REFUSED");
    expect(errorCode(Object.assign(new Error("open failed"), { code: "ENOENT" }))).toBe("NOT_FOUND");
    expect(errorCode(new Error("file not found: /x.md"))).toBe("NOT_FOUND");
    expect(errorCode(new Error("boom"))).toBe("ERROR");
    expect(errorCode("boom")).toBe("ERROR");
  });

  it("tool errors carry [CODE] and structuredContent.code", async () => {
    const jobs = new RenderJobManager({ ledgerPath: null, env: {} });
    const client = await connect(jobs);
    // SPEC_INVALID: render_submit refuses an invalid spec.
    const bad = join(tmp, "bad-spec");
    await mkdir(join(bad, "project"), { recursive: true });
    await writeFile(join(bad, "project", "video-spec.json"), JSON.stringify({ schema_version: "1.0" }));
    const r1 = (await client.callTool({ name: "render_submit", arguments: { project_dir: bad } })) as CallToolResult;
    expect(r1.isError).toBe(true);
    expect(text(r1)).toMatch(/^\[SPEC_INVALID\] render refused/);
    expect(r1.structuredContent).toMatchObject({ ok: false, code: "SPEC_INVALID" });
    // NOT_FOUND: ingest of a missing file.
    const r2 = (await client.callTool({ name: "ingest", arguments: { project_dir: join(tmp, "ing"), inputs: [join(tmp, "nope.md")] } })) as CallToolResult;
    expect(r2.isError).toBe(true);
    expect(r2.structuredContent).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(text(r2)).toMatch(/^\[NOT_FOUND\] error: /);
    // REFUSED: ingest of a credential file.
    const creds = join(tmp, "creds", ".aws");
    await mkdir(creds, { recursive: true });
    await writeFile(join(creds, "credentials"), "[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\n");
    const r3 = (await client.callTool({ name: "ingest", arguments: { project_dir: join(tmp, "ing2"), inputs: [join(creds, "credentials")] } })) as CallToolResult;
    expect(r3.isError).toBe(true);
    expect(r3.structuredContent).toMatchObject({ ok: false, code: "REFUSED" });
    await client.close();
    await jobs.close();
  });

  it("a failed job reports error_code in job_status", async () => {
    const jobs = new RenderJobManager({
      ledgerPath: null,
      env: {},
      run: async () => {
        throw new RenderLockedError({ pid: 7, host: "h", started_at: "t" }, "/p/renders/.render.lock");
      },
    });
    const client = await connect(jobs);
    const { job_id } = jobs.submit(join(tmp, "locked"), {});
    await jobs.idle();
    const r = (await client.callTool({ name: "job_status", arguments: { job_id } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ status: "failed", error_code: "RENDER_LOCKED" });
    expect(text(r)).toContain("error [RENDER_LOCKED]: another render");
    await client.close();
    await jobs.close();
  });
});

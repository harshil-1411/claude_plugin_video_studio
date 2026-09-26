import { existsSync } from "node:fs";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ExperimentManifest, ExperimentPlan, Scene } from "@video-studio/schema";
import type { RenderProjectResult } from "./pipeline.js";
import { RenderJobManager } from "./render-jobs.js";
import { acquireRenderLock } from "./render-lock.js";
import { createServer } from "./server.js";
import { type JobLookup, experimentStatus, needsRender, prepareVariants } from "./variants.js";

const EXAMPLE = join(import.meta.dirname, "..", "..", "..", "examples", "text-to-motion-graphic");

const hook = (text: string): Scene => ({
  id: "s01",
  duration_sec: 3.5,
  purpose: "hook",
  voiceover: text,
  visual_strategy: "motion_graphic",
  deterministic: { kind: "kinetic_text", props: { text } },
  visual_requirements: { continuity_refs: [] },
  claim_refs: ["markdown:input/vector-databases.md#L3"],
});

const plan: ExperimentPlan = {
  schema_version: "1.0",
  id: "hooks-2",
  hypothesis: "A question hook keeps more viewers past 3 s than a statement hook.",
  hooks: [
    { id: "statement", scene: hook("Keyword search finds words, not meaning.") },
    { id: "question", scene: hook("Why does search miss what you meant?") },
  ],
};

const roots: string[] = [];
let base: string;
beforeEach(async () => {
  const tmp = await mkdtemp(join(tmpdir(), "vs-variants-jobs-"));
  roots.push(tmp);
  base = join(tmp, "base");
  for (const part of ["project", "source", "input"]) await cp(join(EXAMPLE, part), join(base, part), { recursive: true }).catch(() => undefined);
  await writeFile(join(base, "project", "variants.json"), JSON.stringify(plan, null, 2));
});
afterAll(() => Promise.all(roots.map((r) => rm(r, { recursive: true, force: true }))));

const byId = (m: ExperimentManifest, id: string) => m.variants.find((v) => v.id === id)!;

describe("variant status follows its render job", () => {
  it("rendering only while queued/running; failed and cancelled jobs show as failed and can be resubmitted", async () => {
    await prepareVariants(base);
    const jobs: Record<string, { status: "queued" | "running" | "failed" | "cancelled" | "succeeded"; error?: string }> = {
      "job-a": { status: "running" },
      "job-b": { status: "queued" },
    };
    const lookup: JobLookup = (id) => jobs[id];
    let m = await experimentStatus(base, { statement: "job-a", question: "job-b" }, lookup);
    expect(byId(m, "statement")).toMatchObject({ status: "rendering", job_id: "job-a" });
    expect(byId(m, "question")).toMatchObject({ status: "rendering", job_id: "job-b" });
    expect(m.variants.some(needsRender)).toBe(false);

    jobs["job-a"] = { status: "failed", error: "ffmpeg exited with code 1\nmore" };
    jobs["job-b"] = { status: "cancelled" };
    m = await experimentStatus(base, {}, lookup);
    expect(byId(m, "statement")).toMatchObject({ status: "failed", error: expect.stringContaining("render job job-a failed: ffmpeg exited with code 1;") });
    expect(byId(m, "question")).toMatchObject({ status: "failed", error: expect.stringContaining("was cancelled") });
    expect(m.variants.every(needsRender)).toBe(true);

    // A resubmitted job replaces the failure.
    jobs["job-c"] = { status: "queued" };
    m = await experimentStatus(base, { statement: "job-c" }, lookup);
    expect(byId(m, "statement")).toMatchObject({ status: "rendering", job_id: "job-c" });
    expect(byId(m, "statement").error).toBeUndefined();

    // Re-preparing keeps the job link and its state.
    const r = await prepareVariants(base, undefined, { jobs: lookup });
    expect(byId(r.manifest, "statement")).toMatchObject({ status: "rendering", job_id: "job-c" });
    expect(byId(r.manifest, "question")).toMatchObject({ status: "failed", job_id: "job-b" });

    // A job this engine does not know (e.g. lost) is just prepared again.
    delete jobs["job-c"];
    m = await experimentStatus(base, {}, lookup);
    expect(byId(m, "statement").status).toBe("prepared");
  });
});

describe("re-preparing skips variants that are being rendered", () => {
  it("leaves a locked variant folder untouched and says so", async () => {
    await prepareVariants(base);
    const locked = join(base, "variants", "statement");
    const free = join(base, "variants", "question");
    await writeFile(join(locked, "project", "marker.txt"), "keep");
    await writeFile(join(free, "project", "marker.txt"), "gone");
    const release = await acquireRenderLock(join(locked, "renders", ".render.lock"), "preview");
    try {
      const r = await prepareVariants(base);
      expect(r.skipped.map((s) => s.id)).toEqual(["statement"]);
      expect(r.skipped[0]!.reason).toMatch(/is being rendered \(render lock held by pid \d+/);
      expect(existsSync(join(locked, "project", "marker.txt"))).toBe(true);
      expect(existsSync(join(free, "project", "marker.txt"))).toBe(false);
      expect(byId(r.manifest, "statement").status).toBe("rendering");
    } finally {
      await release();
    }
    const again = await prepareVariants(base);
    expect(again.skipped).toEqual([]);
    expect(existsSync(join(locked, "project", "marker.txt"))).toBe(false);
  });
});

describe("variants tool with render: true", () => {
  it("does not queue duplicates, and resubmits cancelled renders", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runs: string[] = [];
    const jobs = new RenderJobManager({
      ledgerPath: null,
      env: {},
      run: async (dir, o) => {
        runs.push(dir);
        await new Promise<void>((resolve, reject) => {
          o.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          void gate.then(resolve);
        });
        return {} as RenderProjectResult;
      },
    });
    const server = createServer({ cwd: () => base, jobs });
    const client = new Client({ name: "test", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const call = async () => (await client.callTool({ name: "variants", arguments: { project_dir: base, render: true } })) as CallToolResult;
    try {
      const first = await call();
      expect(first.isError).toBeFalsy();
      const m1 = first.structuredContent as unknown as ExperimentManifest;
      expect(m1.variants.map((v) => v.status)).toEqual(["rendering", "rendering"]);
      expect(jobs.activeJobs()).toHaveLength(2);

      const second = await call();
      const m2 = second.structuredContent as unknown as ExperimentManifest;
      expect(m2.variants.map((v) => v.job_id)).toEqual(m1.variants.map((v) => v.job_id));
      expect(jobs.activeJobs()).toHaveLength(2);

      // Cancel both: they show as failed and the next call resubmits them.
      for (const v of m2.variants) await jobs.cancel(v.job_id!);
      const status = (await client.callTool({ name: "variants", arguments: { project_dir: base, status_only: true } })) as CallToolResult;
      expect((status.structuredContent as unknown as ExperimentManifest).variants.map((v) => v.status)).toEqual(["failed", "failed"]);
      const third = await call();
      const m3 = third.structuredContent as unknown as ExperimentManifest;
      expect(m3.variants.map((v) => v.status)).toEqual(["rendering", "rendering"]);
      expect(m3.variants.every((v, i) => v.job_id !== m1.variants[i]!.job_id)).toBe(true);
      expect(jobs.activeJobs()).toHaveLength(2);
    } finally {
      release();
      await client.close();
      await jobs.close();
    }
  });
});

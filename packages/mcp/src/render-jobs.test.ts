import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openLedger } from "@video-studio/core";
import type { RenderProjectResult } from "./pipeline.js";
import { RenderJobManager } from "./render-jobs.js";
import { createServer } from "./server.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-jobs-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function fakeResult(projectDir: string): RenderProjectResult {
  const dist = join(projectDir, "dist");
  return {
    project_dir: projectDir,
    quality: "preview",
    width: 180,
    height: 320,
    fps: 15,
    duration_sec: 3,
    dist: {
      dir: dist,
      reel: join(dist, "reel.mp4"),
      clean_master: join(dist, "clean-master.mp4"),
      thumbnail: join(dist, "thumbnail.png"),
      social_copy: join(dist, "social-copy.md"),
      render_manifest: join(dist, "render-manifest.json"),
      lock: join(dist, "video.lock"),
      provenance: join(dist, "provenance.json"),
      video_spec: join(dist, "video-spec.json"),
      targets: [],
    },
    qa: { status: "warn", report_json: join(projectDir, "qa", "report.json"), report_md: join(projectDir, "qa", "report.md"), findings: [{ id: "loudness", status: "warn" } as never] },
    voice: { requested: "auto", backend: "system", reason: "auto: say", timing_source: "estimate", has_audio: true },
    renderer: { preference: "auto", used: ["ffmpeg-drawtext"], reasons: ["auto: ffmpeg-drawtext"] },
    timing_adjustments: [],
    placeholders: [],
    warnings: ["w1"],
    cache: { voice_hits: [], scenes_cached: [], scenes_rendered: ["s01"], assembly: "assembled" },
  };
}

async function jobStatus(jobs: RenderJobManager, job_id: string): Promise<CallToolResult> {
  const server = createServer({ cwd: () => tmp, jobs });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    return (await client.callTool({ name: "job_status", arguments: { job_id } })) as CallToolResult;
  } finally {
    await client.close();
  }
}

const text = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

describe("job_status after an engine restart", () => {
  it("reports a succeeded job in full from the ledger", async () => {
    const ledgerPath = join(tmp, "ledger-a.sqlite");
    const project = join(tmp, "proj");
    const before = new RenderJobManager({ ledgerPath, env: {}, run: async (dir) => fakeResult(dir) });
    const { job_id } = before.submit(project, { voice: "auto" });
    await before.idle();
    await before.close();

    // A new engine process: a fresh manager over the same ledger.
    const after = new RenderJobManager({ ledgerPath, env: {} });
    const r = await jobStatus(after, job_id);
    await after.close();
    const t = text(r);
    expect(r.isError).toBeFalsy();
    expect(t).toContain(`job ${job_id}: succeeded`);
    expect(t).toContain(`reel: ${join(project, "dist", "reel.mp4")} (180x320, 15 fps, 3s, preview)`);
    expect(t).toContain("QA: warn (loudness warn)");
    expect(t).toContain("voice: system (auto: say)");
    expect(t).toContain("renderer: ffmpeg-drawtext");
    expect((r.structuredContent as { result?: { width?: number } }).result?.width).toBe(180);
  });

  it("tolerates the summary older engines recorded", async () => {
    const ledgerPath = join(tmp, "ledger-b.sqlite");
    const project = join(tmp, "proj");
    const res = fakeResult(project);
    const l = openLedger(ledgerPath);
    l.createJob({ id: "render-old", projectId: project, kind: "render", provider: "local", idempotencyKey: "render-old", request: { project_dir: project } });
    l.updateJob("render-old", { status: "running", attempts: 1 });
    l.updateJob("render-old", { status: "succeeded", result: { dist: res.dist, qa: "pass", voice: "silent", renderer: ["ffmpeg-drawtext"] } });
    l.close();

    const after = new RenderJobManager({ ledgerPath, env: {} });
    const r = await jobStatus(after, "render-old");
    await after.close();
    const t = text(r);
    expect(r.isError).toBeFalsy();
    expect(t).toContain("job render-old: succeeded");
    expect(t).toContain(`reel: ${res.dist.reel}`);
    expect(t).toContain("QA: pass");
    expect(t).toContain("voice: silent");
    expect(t).toContain("renderer: ffmpeg-drawtext");
  });
});

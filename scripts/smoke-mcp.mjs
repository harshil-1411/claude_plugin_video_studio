#!/usr/bin/env node
// Smoke test for the bundled engine: spawn dist/mcp.mjs, send initialize + tools/list
// over stdio and check the expected tools; then call `ingest` on local fixtures
// (pdf, docx, pptx, repo; no network) to prove the bundled extractors load, and
// `template_list` to prove templates/ is found from dist/; then renders a tiny 3-scene,
// 3 s project (silent voice, ffmpeg renderer, preview quality) through render_submit/job_status.
// Exits non-zero on failure or after 90 s.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { materializeSampleLib } from "../fixtures/repos/materialize-sample-lib.mjs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(root, "dist/mcp.mjs");
const expected = [
  "adapt",
  "analyze",
  "brief_validate",
  "demo",
  "diff",
  "doctor",
  "export",
  "ingest",
  "job_status",
  "lint",
  "localize",
  "project_init",
  "qa_run",
  "render_submit",
  "schema_get",
  "shorts",
  "spec_scaffold",
  "spec_validate",
  "storyboard_render",
  "template_get",
  "template_list",
  "test",
  "transcribe",
  "variants",
  "verify",
];
const tmp = mkdtempSync(join(tmpdir(), "vs-smoke-"));
const marker = join(tmp, "EXEC_MARKER");
const child = spawn(process.execPath, [bundle], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, CLAUDE_PLUGIN_DATA: join(tmp, "data"), VS_EXEC_MARKER: marker },
});
const inputs = [
  ...["fixtures/docs/sample.pdf", "fixtures/docs/sample.docx", "fixtures/docs/sample.pptx"].map((p) => join(root, p)),
  materializeSampleLib(tmp),
];
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

let buf = "";
const timer = setTimeout(() => fail("timed out"), 90_000);
const renderProj = join(tmp, "render");
let jobId;
let renderStarted;

function writeTinyProject() {
  mkdirSync(join(renderProj, "project"), { recursive: true });
  const scene = (id, purpose, voiceover, deterministic) => ({
    id,
    duration_sec: 1,
    purpose,
    voiceover,
    visual_strategy: "motion_graphic",
    deterministic,
    visual_requirements: { continuity_refs: [] },
    claim_refs: [],
  });
  const spec = {
    schema_version: "1.0",
    title: "Smoke render",
    goal: "explain",
    audience: "developers",
    platform: "youtube_shorts",
    aspect_ratio: "9:16",
    target_duration_sec: 3,
    language: "en-US",
    grounding: "off",
    voice: {},
    captions: { preset: "minimal", burn_in: true },
    scenes: [
      scene("s01", "hook", "Search finds words.", { kind: "typography", props: { lines: ["Search finds words"] } }),
      scene("s02", "point", "Vectors find meaning.", { kind: "diagram", props: { nodes: ["text", "vector"], edges: [["text", "vector"]] } }),
      scene("s03", "cta", "Try it.", { kind: "cta", props: { headline: "Try it", action: "Embed your docs" } }),
    ],
  };
  writeFileSync(join(renderProj, "project", "video-spec.json"), JSON.stringify(spec));
}

function fail(msg) {
  console.error(`smoke-mcp: FAIL: ${msg}`);
  child.kill();
  process.exit(1);
}

child.on("exit", (code) => {
  if (code !== null && code !== 0) fail(`server exited with code ${code}`);
});

child.stdout.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(`non-JSON output on stdout: ${line.slice(0, 200)}`);
    }
    if (msg.id === 2) {
      const names = (msg.result?.tools ?? []).map((t) => t.name).sort();
      if (JSON.stringify(names) !== JSON.stringify(expected)) fail(`unexpected tools: ${names.join(", ")}`);
      console.log(`smoke-mcp: tools ok (${names.join(", ")})`);
      send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ingest", arguments: { project_dir: join(tmp, "proj"), inputs } } });
    } else if (msg.id === 3) {
      const r = msg.result;
      if (!r || r.isError) fail(`ingest failed: ${JSON.stringify(r?.content ?? msg.error)}`);
      const kinds = r.structuredContent.sources.map((s) => s.kind).join(",");
      if (kinds !== "pdf,docx,pptx,repo") fail(`unexpected source kinds: ${kinds}`);
      if (!r.structuredContent.classification.contains_secrets) fail("fixture repo secret was not flagged");
      if (existsSync(marker)) fail("a config file from the fixture repo was executed");
      console.log(`smoke-mcp: ingest ok (${kinds}; ${r.structuredContent.evidence} spans, ${r.structuredContent.claims} claims)`);
      send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "template_list", arguments: {} } });
    } else if (msg.id === 4) {
      const r = msg.result;
      if (!r || r.isError) fail(`template_list failed: ${JSON.stringify(r?.content ?? msg.error)}`);
      const ids = r.structuredContent.templates.map((t) => t.id).join(",");
      if (ids !== "aesthetic-broll,ambient-slice-of-life,animated-explainer,before-after,carousel-story,case-study,devtool-launch,educational,explain,faceless-listicle,listicle,oddly-satisfying,product-demo,product-launch,product-ui,silent-vlog,talking-head,text-over-music") fail(`unexpected templates: ${ids}`);
      console.log(`smoke-mcp: templates ok (${ids})`);
      writeTinyProject();
      renderStarted = Date.now();
      send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "render_submit", arguments: { project_dir: renderProj, voice: "silent", renderer: "ffmpeg" } } });
    } else if (msg.id === 5) {
      const r = msg.result;
      if (!r || r.isError) fail(`render_submit failed: ${JSON.stringify(r?.content ?? msg.error)}`);
      jobId = r.structuredContent.job_id;
      send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "job_status", arguments: { job_id: jobId } } });
    } else if (msg.id === 6) {
      const r = msg.result;
      const st = r?.structuredContent?.status;
      if (st === "queued" || st === "running") {
        setTimeout(() => send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "job_status", arguments: { job_id: jobId } } }), 500);
        return;
      }
      if (st !== "succeeded") fail(`render job ${st}: ${JSON.stringify(r?.content ?? msg.error)}`);
      const res = r.structuredContent.result;
      for (const f of ["reel.mp4", "clean-master.mp4", "captions.srt", "thumbnail.png", "render-manifest.json"]) {
        if (!existsSync(join(renderProj, "dist", f)) || statSync(join(renderProj, "dist", f)).size === 0) fail(`dist/${f} missing`);
      }
      clearTimeout(timer);
      child.kill();
      console.log(
        `smoke-mcp: render ok (${res.width}x${res.height} ${res.duration_sec}s, QA ${res.qa.status}, voice ${res.voice.backend}, renderer ${res.renderer.used.join(",")}, ${((Date.now() - renderStarted) / 1000).toFixed(1)}s)`,
      );
      process.exit(0);
    }
  }
});

const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
});
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

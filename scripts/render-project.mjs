#!/usr/bin/env node
// Dev CLI: render a project through the bundled engine (dist/mcp.mjs) exactly as Claude Code
// would: render_submit, then poll job_status and print progress and the result.
//
//   node scripts/render-project.mjs <project_dir> [--voice auto|system|elevenlabs|silent]
//        [--renderer auto|hyperframes|ffmpeg] [--quality preview|final] [--no-burn-in]
//
// Uses CLAUDE_PLUGIN_DATA if set, else ~/.video-studio. Exits non-zero if the job fails.
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const projectDir = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.match(/^--(voice|renderer|quality)$/));
if (!projectDir) {
  console.error("usage: node scripts/render-project.mjs <project_dir> [--voice v] [--renderer r] [--quality q] [--no-burn-in]");
  process.exit(2);
}
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const args = { project_dir: resolve(projectDir) };
for (const k of ["voice", "renderer", "quality"]) if (opt(k)) args[k] = opt(k);
if (argv.includes("--no-burn-in")) args.burn_in_captions = false;

const child = spawn(process.execPath, [join(root, "dist/mcp.mjs")], { stdio: ["pipe", "pipe", "inherit"], env: process.env });
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
const poll = (job_id) => send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "job_status", arguments: { job_id } } });
let buf = "";
let jobId;
let last = "";

child.stdout.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === 2) {
      const r = msg.result;
      console.log(r?.content?.map((c) => c.text).join("\n") ?? JSON.stringify(msg.error));
      if (!r || r.isError) finish(1);
      jobId = r.structuredContent.job_id;
      poll(jobId);
    } else if (msg.id === 3) {
      const r = msg.result;
      const s = r?.structuredContent;
      const text = r?.content?.[0]?.text ?? "";
      if (s?.status === "queued" || s?.status === "running") {
        const progress = text.split("\n")[1] ?? s.status;
        if (progress !== last) console.log(`[${secs()}] ${progress}`);
        last = progress;
        setTimeout(() => poll(jobId), 1000);
      } else {
        console.log(`[${secs()}]\n${text}`);
        finish(s?.status === "succeeded" ? 0 : 1);
      }
    }
  }
});

function finish(code) {
  child.kill();
  process.exit(code);
}

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "render-project", version: "0" } } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "render_submit", arguments: args } });

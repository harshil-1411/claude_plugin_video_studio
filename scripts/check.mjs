#!/usr/bin/env node
// Every check that gates a push (there is no CI): typecheck, tests, bundle (and that the committed
// bundle is up to date), smoke, plugin validation and the example golden frames. Stops at the
// first failure. `--quick` runs only typecheck and tests. `--push` (the pre-push hook) also fails
// when the rebuilt bundle differs from the committed one; otherwise that is only a reminder.
//
//   node scripts/check.mjs [--quick] [--push]     (pnpm check / pnpm check:quick)
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const quick = process.argv.includes("--quick");
const push = process.argv.includes("--push");
const bin = (name) => join(root, "node_modules", ".bin", name);

const has = (cmd) => spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;

const steps = [
  { name: "typecheck", cmd: bin("tsc"), args: ["-b"] },
  { name: "tests", cmd: bin("vitest"), args: ["run"] },
];
if (!quick) {
  steps.push(
    { name: "bundle", cmd: bin("tsdown"), args: [], cwd: join(root, "packages", "mcp") },
    ...(push
      ? [
          {
            name: "bundle committed",
            cmd: "git",
            args: ["diff", "--quiet", "--", "dist/mcp.mjs"],
            hint: "dist/mcp.mjs changed when rebuilt: commit the rebuilt bundle (the plugin runs it), then push again",
          },
        ]
      : []),
    { name: "smoke", cmd: process.execPath, args: [join(root, "scripts", "smoke-mcp.mjs")] },
  );
  if (has("claude")) {
    steps.push(
      { name: "plugin validate", cmd: "claude", args: ["plugin", "validate", "--strict", ".claude-plugin/plugin.json"] },
      { name: "marketplace validate", cmd: "claude", args: ["plugin", "validate", "--strict", "."] },
    );
  } else {
    console.log("check: `claude` is not on PATH; skipping plugin validation");
  }
  steps.push({ name: "golden frames", cmd: bin("vitest"), args: ["run", "tests/golden-frames"], env: { VS_TEST_GOLDEN: "1" } });
}

const summary = [];
for (const s of steps) {
  const t0 = Date.now();
  console.log(`\ncheck: ${s.name} …`);
  const r = spawnSync(s.cmd, s.args, { cwd: s.cwd ?? root, stdio: "inherit", env: { ...process.env, ...(s.env ?? {}) } });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status !== 0) {
    console.error(`\ncheck: FAILED at ${s.name} (${secs}s)${s.hint ? `: ${s.hint}` : ""}`);
    for (const line of summary) console.error(`  ok  ${line}`);
    process.exit(r.status ?? 1);
  }
  summary.push(`${s.name} (${secs}s)`);
}
console.log(`\ncheck: all ${summary.length} passed${quick ? " (quick)" : ""}`);
if (!quick && !push && spawnSync("git", ["diff", "--quiet", "--", "dist/mcp.mjs"], { cwd: root }).status !== 0) {
  console.log("check: note: dist/mcp.mjs was rebuilt and differs from the last commit; commit it with your changes");
}
for (const line of summary) console.log(`  ok  ${line}`);

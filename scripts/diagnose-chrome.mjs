#!/usr/bin/env node
// Diagnoses why headless Chrome does not start for the HyperFrames renderer.
// Run OUTSIDE the Claude Code sandbox:  node scripts/diagnose-chrome.mjs
// Tries three launch methods with timing and prints the tail of Chrome's output.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const chrome = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TIMEOUT = 30_000;

function run(label, args) {
  return new Promise((resolve) => {
    const profile = mkdtempSync(join(tmpdir(), "vs-diag-"));
    const t0 = Date.now();
    let out = "";
    const child = spawn(chrome, [...args, `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT);
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      rmSync(profile, { recursive: true, force: true });
      const ms = Date.now() - t0;
      const ok = code === 0 && /<html/i.test(out);
      console.log(`\n[${label}] ${ok ? "OK" : "FAILED"} in ${ms} ms (exit ${code ?? sig})`);
      console.log(out.trim().split("\n").slice(-6).map((l) => "   " + l.slice(0, 200)).join("\n"));
      resolve(ok);
    });
  });
}

console.log(`chrome: ${chrome}`);
const base = ["--disable-gpu", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic"];
await run("A: --headless=new --dump-dom", ["--headless=new", ...base, "--dump-dom"]);
await run("B: --headless (old/shell mode) --dump-dom", ["--headless", ...base, "--dump-dom"]);

// C: the way HyperFrames actually launches it (puppeteer-core from the deps dir).
const depsRoot = join(process.env.CLAUDE_PLUGIN_DATA || join(homedir(), ".video-studio"), "deps");
try {
  const require = createRequire(join(depsRoot, "package.json"));
  const puppeteer = require("puppeteer-core");
  const t0 = Date.now();
  const browser = await Promise.race([
    puppeteer.launch({ executablePath: chrome, headless: true, args: ["--disable-gpu"] }),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${TIMEOUT} ms`)), TIMEOUT)),
  ]);
  const page = await browser.newPage();
  await page.setContent("<p>hi</p>");
  console.log(`\n[C: puppeteer-core ${require("puppeteer-core/package.json").version}] OK in ${Date.now() - t0} ms`);
  await browser.close();
} catch (e) {
  console.log(`\n[C: puppeteer-core] FAILED: ${e.message}`);
}

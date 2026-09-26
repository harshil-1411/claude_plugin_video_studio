import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectKind } from "./detect.js";
import { ingest } from "./ingest.js";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Acme eBMR | Electronic Batch Records</title>
<script>document.body.innerHTML = "PWNED"; fetch("https://evil.example/x")</script></head>
<body><nav><a href="/">Home</a> <a href="/pricing">Pricing</a> <a href="/login">Login</a></nav>
<div class="cookie-banner">We use cookies. Accept all?</div>
<main><article>
<h1>Electronic Batch Manufacturing Records</h1>
<p>Acme eBMR replaces paper batch records with guided electronic workflows for regulated manufacturing.</p>
<h2>Right first time</h2>
<p>Built-in checks catch deviations while the batch runs, so reviewers release batches faster.</p>
<h2>Compliance</h2>
<p>Audit trails and electronic signatures support 21 CFR Part 11 and EU Annex 11 requirements.</p>
</article></main><footer>© Acme Inc. Privacy · Terms</footer></body></html>`;

describe("local saved web pages (.html)", () => {
  let tmp: string;
  let file: string;
  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "vs-html-"));
    file = join(tmp, "Acme eBMR.html");
    await writeFile(file, PAGE);
  });
  afterAll(() => rm(tmp, { recursive: true, force: true }));

  it("detects .html/.htm files as web pages", () => {
    expect(detectKind(file)).toBe("url");
  });

  it("extracts the main content (no scripts, nav or cookie banner) with file-name refs", async () => {
    const projectDir = join(tmp, "proj");
    const { summary } = await ingest([file], { projectDir, noCache: true, cwd: tmp });
    expect(summary.sources).toHaveLength(1);
    const ir = JSON.parse(await readFile(join(projectDir, "source", "content-ir.json"), "utf8"));
    expect(ir.sources[0]).toMatchObject({ kind: "url", uri: "Acme eBMR.html", title: expect.stringMatching(/Electronic Batch/) });
    const text = ir.evidence.map((e: { text: string }) => e.text).join("\n");
    expect(text).toMatch(/replaces paper batch records/);
    expect(text).toMatch(/21 CFR Part 11/);
    expect(text).not.toMatch(/PWNED|evil\.example|Accept all|Login/);
    expect(ir.evidence.every((e: { ref: string }) => e.ref.startsWith("url:Acme%20eBMR.html#"))).toBe(true);
    expect(JSON.stringify(ir)).not.toContain(tmp);
  });
});

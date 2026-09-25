# Node.js/TypeScript Core Libraries for the "video-studio" CLI (ingest → JSON IR, schemas, local job DB)

Research date: 2026-09-25. Target: Node 22/24 LTS, Apache-2.0 project (prefer MIT/Apache/BSD deps).
Note on method: items marked "(prior knowledge, not re-verified)" come from the researcher's training data and were not confirmed against a live source this session; treat them as to-verify.

---

## 1. URL → clean main-content text/markdown (Readability, defuddle, turndown, trafilatura; JS-rendered pages)

### Takeaway
Use **defuddle** (MIT, Node-capable, built-in markdown output, works with jsdom or linkedom) as the primary extractor, with **@mozilla/readability** as a fallback; fetch with plain HTTP first and escalate to Playwright only when the static HTML yields too little text. Trafilatura is the benchmark leader and now Apache-2.0, but it is Python, so it fits only as an optional sidecar.

### Cited Findings
- defuddle: MIT license. Extracts main content (removes comments, sidebars, headers, footers). Built for Obsidian Web Clipper — [GitHub kepano/defuddle](https://github.com/kepano/defuddle)
- defuddle vs Readability: "More forgiving, removes fewer uncertain elements", gives consistent output for footnotes, math and code blocks, and uses mobile styles to spot clutter — [GitHub kepano/defuddle](https://github.com/kepano/defuddle)
- defuddle in Node works with JSDOM or linkedom, and has markdown output through a `markdown: true` option or the `--markdown` CLI flag — [GitHub kepano/defuddle](https://github.com/kepano/defuddle)
- defuddle activity: about 9.5k stars, 762 commits, about 50 open issues and 35 open PRs. It is actively developed — [GitHub kepano/defuddle](https://github.com/kepano/defuddle)
- trafilatura: Apache-2.0 from v1.8.0 ("Versions prior to v1.8.0 are under GPLv3+"). Outputs Markdown, JSON, CSV, TXT, HTML, XML and XML-TEI — [GitHub adbar/trafilatura](https://github.com/adbar/trafilatura)
- trafilatura quality: "Most efficient open-source library in ScrapingHub's article extraction benchmark" and "Best single tool by ROUGE-LSum Mean F1 Page Scores" (Bevendorff et al. 2023). Used by HuggingFace, IBM, Microsoft Research and Stanford — [GitHub adbar/trafilatura](https://github.com/adbar/trafilatura)
- Playwright can drive the machine's installed Chrome or Edge through the `channel` option. This avoids downloading a browser — [Playwright docs: Browsers](https://playwright.dev/docs/browsers)

### Inferences
- Suggested pipeline: `fetch` (undici, built into Node) → HTML → linkedom (fast, light) or jsdom (more faithful) → defuddle `{markdown:true}` → normalized IR. If the extracted word count falls below a threshold (for example under 200 words) or the page is a JS app shell (such as an empty `<div id="root">`), re-render with Playwright and extract again.
- @mozilla/readability is Apache-2.0 and in maintenance mode but stable; turndown (MIT) is the standard HTML→Markdown converter to pair with Readability, and turndown-plugin-gfm adds tables — (prior knowledge, not re-verified). Since defuddle already emits markdown, turndown is only needed on the Readability fallback path.
- Playwright for JS-rendered pages is worth it only as a lazy, optional path, because of the roughly 281 MB Chromium download (see section 8). Make it an opt-in `--render` flag or an automatic fallback that runs only when Playwright is installed.
- Trafilatura could run as an optional Python sidecar (`uvx trafilatura`) when Python is available. A Node-only core is simpler to ship as a Claude Code plugin.

### Gaps
- No independent head-to-head benchmark of defuddle vs Readability vs trafilatura was found. The quality claims come from each project's own README.
- Current release numbers and last-commit dates for @mozilla/readability, turndown and linkedom were not verified this session.

---

## 2. Document extraction: PDF, DOCX, PPTX, Markdown

### Takeaway
PDF: **unpdf** (MIT, wraps PDF.js v5, modern, Node 22+). DOCX: **mammoth** (convert to HTML, then HTML→MD with turndown; do not use its deprecated markdown mode). PPTX (and a catch-all for office formats): **officeparser** (MIT). Markdown: **unified/remark** (remark-parse + remark-gfm + remark-frontmatter) to get an mdast AST that maps cleanly to IR.

### Cited Findings
- unpdf: MIT. Ships a serverless build of PDF.js v5.6.205, with the option to use the official or legacy PDF.js builds. Offers `extractText`, `getDocumentProxy`, `extractImages` and `renderPageAsImage`. Runs on Node, browsers and edge runtimes. Node 22+ recommended because of `Promise.withResolvers` in PDF.js v5 — [GitHub unjs/unpdf](https://github.com/unjs/unpdf)
- pdf-parse was revived by a new maintainer (mehmet-kozan) with a v2 class-based API (`new PDFParse(...)` then `getText()`), plus `getTable()`, image extraction and a CLI. The latest version cited is 2.4.5 — [GitHub mehmet-kozan/pdf-parse](https://github.com/mehmet-kozan/pdf-parse); [npm pdf-parse](https://www.npmjs.com/package/pdf-parse)
- mammoth: converts .docx to semantic HTML and has `extractRawText()`. "Markdown output is no longer recommended; converting to HTML first, then using a separate library is preferred." Handles headings, lists, tables, footnotes, images, links, text boxes and comments — [GitHub mwilliamson/mammoth.js](https://github.com/mwilliamson/mammoth.js)
- mammoth security: "performs no sanitisation of the source document, and should therefore be used extremely carefully with untrusted user input" (javascript: links; crafted files can cause performance problems) — [GitHub mwilliamson/mammoth.js](https://github.com/mwilliamson/mammoth.js)
- officeparser: MIT. Parses docx, pptx, xlsx, odt, odp, ods, pdf, rtf, csv, md, html and epub into an AST. Outputs Markdown, HTML, plain text and RAG chunks. Latest version referenced is 7.4.0 — [GitHub harshankur/officeParser](https://github.com/harshankur/officeParser); [Libraries.io officeparser](https://libraries.io/npm/officeparser)
- office-text-extractor (ISC) is an alternative for plain text from pptx and other office files — [npm office-text-extractor](https://www.npmjs.com/package/office-text-extractor)

### Inferences
- Pick unpdf over raw pdfjs-dist because it smooths over PDF.js's worker and polyfill setup in Node. `renderPageAsImage` can also make page thumbnails for video visuals, though it needs a canvas implementation such as @napi-rs/canvas (prior knowledge, not re-verified).
- pdfjs-dist itself is Apache-2.0 (Mozilla) (prior knowledge, not re-verified). unpdf bundles it, so keep its NOTICE/attribution in the project.
- For DOCX, mammoth HTML → turndown gives better heading and list fidelity than officeparser. Use officeparser for PPTX, where slide-by-slide structure (slide text plus notes) matters for videos.
- unified/remark (MIT) is the standard choice for Markdown. Its mdast maps directly onto IR "section/paragraph/code/list" nodes (prior knowledge, not re-verified).
- Scanned PDFs need OCR (for example tesseract.js, Apache-2.0). This is out of scope for v1 and should be flagged in the IR as `needs_ocr`.

### Gaps
- No quality benchmark comparing unpdf and pdf-parse v2 text output was found. Both are built on PDF.js, so baseline quality should be similar.
- officeparser's PPTX speaker-notes support and its maintenance cadence were not verified in detail. Note that search results showed two GitHub repos (harshankur and brennanbutler01) with the same description, so confirm which is canonical.

---

## 3. Repo ingestion (.gitignore, summarization, secret scanning)

### Takeaway
Use **repomix** as a library (MIT, about 28.5k stars): it already respects .gitignore/.ignore/.repomixignore, runs **secretlint** internally, counts tokens, compresses code with tree-sitter and supports remote repos. Add an explicit secretlint pass (MIT, Node 22+) as a hard gate before anything leaves the machine, and allow **gitleaks** (MIT, Go binary) as an optional stronger scan when it is on PATH.

### Cited Findings
- repomix: MIT. "Automatically respects your .gitignore, .ignore, and .repomixignore files". Uses Secretlint to detect credential patterns. Counts tokens (o200k_base / cl100k_base). Tree-sitter compression cuts tokens by about 70%. Supports `--remote` GitHub repos, outputs XML/Markdown/JSON/plain, has a programmatic Node API (`npm install repomix`), MCP server mode and output splitting. About 28.5k stars — [GitHub yamadashy/repomix](https://github.com/yamadashy/repomix)
- gitingest: MIT, but a Python package/CLI (PyPI). Turns a repo or local dir into a digest with summary, file tree and token count — [PyPI gitingest](https://pypi.org/project/gitingest/); [Libraries.io](https://libraries.io/pypi/gitingest)
- secretlint: Node 22+ required for the npm install. Rules are opt-in via `@secretlint/secretlint-rule-preset-recommend`. Masks secrets in its output by default, respects .gitignore since v13, outputs JSON and SARIF, and ships as Docker or a single-executable binary — [GitHub secretlint/secretlint](https://github.com/secretlint/secretlint)
- gitleaks core scanner is MIT. gitleaks-action v2+ is not MIT and needs a commercial license for organizations. The CLI itself remains MIT — [gitleaks LICENSE](https://github.com/gitleaks/gitleaks/blob/master/LICENSE); [gitleaks-action](https://github.com/gitleaks/gitleaks-action); [gitleaks-action commercial license](https://gitleaks.io/gitleaks-action/commercial-license.html)

### Inferences
- repomix's JSON output (or its programmatic `pack` API) can feed the IR directly: file tree, per-file content and token counts. Its tree-sitter "compress" mode fits "summarize a repo for narration" well, since it keeps signatures and structure.
- Defense in depth: (1) repomix plus its built-in secretlint check. (2) Refuse or redact any file secretlint flags, and record `redactions[]` in the IR. (3) Optionally run `gitleaks dir` when the binary is present. Never send raw content to an external LLM or TTS service before the scan passes.
- gitingest is Python and adds nothing repomix lacks for a Node CLI. Skip it.
- secretlint is MIT (prior knowledge; the README fetch did not state the license explicitly — verify in its LICENSE file).

### Gaps
- The secretlint license was not explicitly confirmed from the fetched page.
- repomix's programmatic API stability (whether it is semver-guaranteed) was not verified.

---

## 4. Schema tooling: zod v4 (z.toJSONSchema) vs TypeBox vs JSON Schema + ajv

### Takeaway
Use **zod v4** as the single source of truth. Generate published `.schema.json` files at build time with `z.toJSONSchema()` (Draft 2020-12, `.meta()` ids, registries for cross-`$ref`s), and keep zod for runtime validation and TS inference. Choose TypeBox 1.x only if JSON Schema is the primary artifact and every construct must round-trip with zero loss.

### Cited Findings
- `z.toJSONSchema()` targets Draft 2020-12 (default), Draft 7, Draft 4 and OpenAPI 3.0. `io: "input"|"output"` picks which side of transforms to describe. `unrepresentable: "throw"` (the default) or `"any"` handles bigint, date, map, set, transform and custom types — [zod.dev JSON Schema](https://zod.dev/json-schema)
- Metadata set with `.meta()` is copied into the output and "takes precedence over the keywords Zod generates". Registries create multiple interlinked schemas with `$ref`s, but every schema needs a registered `id` — [zod.dev JSON Schema](https://zod.dev/json-schema)
- TypeBox: now published as `typebox` (1.x, ESM only, targets TypeScript 6.0–7.0+), MIT. Its schemas are literally JSON Schema (Draft 3 → 2020-12). The optional `typebox/schema` JIT compiler validates both TypeBox and plain JSON Schema, and it claims faster compilation than AJV8 — [GitHub sinclairzx81/typebox](https://github.com/sinclairzx81/typebox)

### Inferences
- For a published IR contract, zod v4's generator is enough if the IR types avoid unrepresentable constructs. Use ISO-string dates (`z.iso.datetime()`) instead of `z.date()` and avoid transforms in the IR schemas. Add a CI test that regenerates the `.schema.json` files and diffs them against the committed copies.
- Validate the emitted JSON Schema with ajv (MIT; ajv/dist/2020 for Draft 2020-12; prior knowledge, not re-verified) in tests, so the published schemas are known-good for third-party consumers.
- Hand-writing JSON Schema plus ajv plus `json-schema-to-ts` is the most portable approach but the most ergonomically costly. It is not recommended.
- zod has the broadest ecosystem (the Claude Agent SDK and MCP SDK tool schemas use zod; prior knowledge, not re-verified). That favors zod for a Claude Code plugin.

### Gaps
- Exact zod 4.x current version and TypeBox's Standard Schema support were not verified.

---

## 5. SQLite: better-sqlite3 vs node:sqlite vs libsql (native-build concerns for a Claude Code plugin)

### Takeaway
Prefer built-in **node:sqlite** (no native build, zero install risk). It is Stability 1.2 "Release candidate" in Node 24.15+ and 25.7+, and unflagged since 22.13, so it works on both LTS lines without a flag. Wrap it in a thin repository layer so **better-sqlite3** (MIT, faster and more mature) can be swapped in. Avoid libsql unless Turso sync is needed.

### Cited Findings
- node:sqlite (Node v24.21.0 docs): "Stability: 1.2 – Release candidate". History: added v22.5.0; "no longer behind `--experimental-sqlite` but still experimental" in v23.4.0/v22.13.0; "SQLite is now a release candidate" in v24.15.0 — [Node v24 docs: sqlite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)
- Current docs (Node v26.10.0) still list Stability 1.2 Release candidate; RC reached in v25.7.0 — [Node docs: sqlite](https://nodejs.org/api/sqlite.html)
- better-sqlite3: MIT. Synchronous API, full transactions, 64-bit ints. Prebuilt binaries for major platforms. Without a matching prebuild it needs node-gyp, Python and a C++ compiler. About 7.5k stars — [GitHub WiseLibs/better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- @libsql/client: MIT, has per-platform native dependencies. Turso positions `@tursodatabase/serverless` as the zero-native-dependency option (remote, not a local file) — [GitHub tursodatabase/libsql-client-ts](https://github.com/tursodatabase/libsql-client-ts)

### Inferences
- A plugin installed by Claude Code typically runs `node bin/cli.js` with whatever Node the user has. A native addon must match that Node's ABI (better-sqlite3 prebuilds are per-ABI), cannot be bundled into a single-file esbuild output, and fails badly on unusual platforms or new Node majors before prebuilds land. node:sqlite avoids all of this.
- Caveat: on Node 22 LTS, node:sqlite is unflagged but still marked experimental (1.1) rather than RC. Whether it prints an ExperimentalWarning on 22.x was not confirmed (see Gaps). Set a minimum of Node ≥ 22.13 (ideally 24.15+) in `engines`.
- Job-tracking needs (a jobs table, steps, artifacts, content hashes) are modest. The performance gap to better-sqlite3 does not matter here. Use WAL mode and `STRICT` tables.
- Optional: Drizzle ORM (Apache-2.0) supports multiple SQLite drivers, but raw SQL plus zod-validated rows is enough and keeps the bundle small (prior knowledge, not re-verified).

### Gaps
- Whether Node 22.x prints an `ExperimentalWarning` on `require('node:sqlite')` was not verified. One fetch said no warning on v24, but that was the summarizing model's interpretation, not quoted text. Test empirically on 22.x and 24.x.
- Whether node:sqlite reached Stable (1.0) on any line was not found; as of Node 26.10 docs it is still RC.

---

## 6. CLI framework and bundling (commander / citty / clipanion / oclif; tsup/esbuild; pnpm + vitest)

### Takeaway
Use **commander** (zero-dep, ubiquitous, MIT) or **citty** (UnJS, TS-first, tiny). Either bundles cleanly into one file. Avoid **oclif** for a single-file plugin bin, because its plugin/manifest architecture expects a multi-file package layout. Bundle with **tsdown** (tsup's recommended successor) or plain esbuild. Do not start new work on tsup, which is officially unmaintained.

### Cited Findings
- tsup: "This project is not actively maintained anymore. Please consider using tsdown instead." MIT — [GitHub egoist/tsup](https://github.com/egoist/tsup)
- Commander: about 50M weekly downloads, minimal, zero dependencies — [PkgPulse: Commander vs Yargs 2026](https://www.pkgpulse.com/guides/commander-vs-yargs-2026)
- Citty: lightweight UnJS framework written in TS, infers types automatically from arg definitions, `defineCommand()` plain objects, zero dependencies. Clipanion is class-based and powers Yarn — [Stricli: Alternatives Considered](https://bloomberg.github.io/stricli/docs/getting-started/alternatives); [CrustJS comparisons](https://crustjs.com/docs/comparisons/)
- Oclif (Salesforce) provides plugin systems, help generation and update notifications beyond Commander — [Grizzly Peak Software comparison](https://www.grizzlypeaksoftware.com/library/cli-framework-comparison-commander-vs-yargs-vs-oclif-utxlf9v9)

### Inferences
- Recommended: commander plus `@commander-js/extra-typings` for typed options (prior knowledge, not re-verified), or citty if you prefer UnJS style. Both are MIT (prior knowledge, not re-verified).
- Bundling: `tsdown` or `esbuild --bundle --platform=node --format=esm --target=node22` → `bin/video-studio.mjs` with a `#!/usr/bin/env node` banner. Mark optional heavy dependencies as external and load them through lazy `import()`: playwright, @napi-rs/canvas, and better-sqlite3 if used. Using node:sqlite keeps the core fully bundleable.
- Some deps need care in a bundle: jsdom has dynamic requires and large assets (prefer linkedom in the bundle), and PDF.js workers (unpdf's serverless build avoids worker files). Treat this as a risk to test.
- Monorepo: pnpm workspaces (`packages/core`, `packages/cli`, `packages/schemas`) plus vitest (MIT) for unit and snapshot tests of IR output, with golden files for extractor regressions.

### Gaps
- Could not verify current citty maintenance cadence or version (it historically sat at 0.1.x for a long time).
- tsdown's maturity and version as of 2026-09 were not fetched.

---

## 7. Content-addressed caching and local job queues

### Takeaway
Hash normalized inputs with `node:crypto` sha256. The key covers source bytes (or canonical URL plus fetched body), extractor name and version, options and IR schema version. Store artifacts at `.cache/<sha256[0:2]>/<sha256>`. Use **p-queue** (MIT, in-memory, concurrency/rate/priority/timeout/AbortSignal) for execution and the SQLite jobs table for durability and resume.

### Cited Findings
- p-queue: MIT, native ESM only (no CJS export). Supports `concurrency`, `interval`/`intervalCap` rate limiting, priority, per-task timeout (`TimeoutError`), AbortSignal cancellation, backpressure (`onSizeLessThan`) and events (`active`, `completed`, `error`, `idle`). Not persistent: "For servers, you probably want a Redis-backed job queue instead." — [GitHub sindresorhus/p-queue](https://github.com/sindresorhus/p-queue)

### Inferences
- Persistence pattern: on start, insert `jobs(id, kind, input_hash, status='queued', attempts, created_at)`. The worker claims rows with `UPDATE … SET status='running' WHERE id=? AND status='queued'`, then pushes the work into p-queue. On crash or restart, re-queue rows left in `running`. This avoids Redis-backed queues (BullMQ), which are unsuitable for a local CLI.
- Cache key discipline: `sha256(JSON.stringify(canonicalize({kind, inputDigest, extractor:{name,version}, options, irSchemaVersion})))`. Canonical JSON (sorted keys) matters; a small RFC 8785 JCS implementation such as the `canonicalize` npm package works (prior knowledge, not re-verified). For URLs, cache both the fetch (keyed by URL plus ETag/Last-Modified) and the extraction (keyed by body hash).
- Write atomically (write to tmp, then `rename`) so a crashed job cannot leave half-written cached artifacts.

### Gaps
- Did not survey alternatives such as `fastq` or SQLite-backed queue libraries (e.g., `better-queue-sqlite`, `plainjob`) for maintenance status.

---

## 8. Screenshotting URLs/repo pages (Playwright): license and install weight

### Takeaway
Playwright (Apache-2.0, prior knowledge) is the right tool, but make it an **optional peer dependency** because of the browser download. Install only the Chromium headless shell (`--only-shell`), or reuse the user's installed Chrome via `channel: 'chrome'` to download nothing.

### Cited Findings
- Browser download sizes: Chromium about 281 MB, Firefox about 187 MB, WebKit about 180 MB — [Playwright docs: Browsers](https://playwright.dev/docs/browsers)
- `npx playwright install --with-deps --only-shell` skips the full Chromium when running headless only. `PLAYWRIGHT_BROWSERS_PATH` relocates binaries, and `=0` stores them under `node_modules/playwright-core/.local-browsers` — [Playwright docs: Browsers](https://playwright.dev/docs/browsers)
- Playwright can use the branded Google Chrome or Microsoft Edge already installed, via `channel` — [Playwright docs: Browsers](https://playwright.dev/docs/browsers)

### Inferences
- Use `playwright-core` (no auto browser download) with `channel: 'chrome'` first, fall back to a prompt to run `npx playwright install chromium --only-shell`, and degrade gracefully (no screenshots) when neither is available.
- For GitHub repo visuals, rendering a README to HTML locally (remark → HTML → screenshot) or using GitHub's social preview image may beat screenshotting github.com, which is dynamic and rate-limited.
- One Playwright install serves both screenshots and the JS-render fallback from section 1.

### Gaps
- The exact on-disk size of the headless-shell-only download was not stated on the fetched page.
- Playwright's license (Apache-2.0) was not re-verified this session.

---

## Summary shortlist (for the report writer)

| Concern | Pick | License | Status / note |
|---|---|---|---|
| URL extraction | defuddle (+ @mozilla/readability + turndown fallback) | MIT (Readability Apache-2.0, turndown MIT: prior knowledge) | Active; about 9.5k stars |
| DOM | linkedom (bundle-friendly) / jsdom (fidelity) | ISC / MIT (prior knowledge) | — |
| JS-rendered pages | playwright-core, optional | Apache-2.0 (prior knowledge) | Chromium about 281 MB |
| PDF | unpdf (alt: pdf-parse v2) | MIT | PDF.js v5; Node 22+ |
| DOCX | mammoth → turndown | BSD-2-Clause (prior knowledge) | MD output deprecated; no sanitization |
| PPTX / office | officeparser | MIT | v7.x |
| Markdown | unified / remark | MIT (prior knowledge) | — |
| Repo packing | repomix (library) | MIT | about 28.5k stars; .gitignore + secretlint built in |
| Secret scan | secretlint (+ optional gitleaks) | MIT (secretlint: prior knowledge) / MIT | secretlint needs Node 22+ |
| Schemas | zod v4 + z.toJSONSchema (+ ajv in tests) | MIT | Draft 2020-12 |
| DB | node:sqlite (fallback better-sqlite3) | Node core / MIT | RC (1.2) in 24.15+ |
| CLI | commander (or citty) | MIT | — |
| Bundler | tsdown or esbuild | MIT | tsup unmaintained |
| Queue | p-queue + SQLite jobs table | MIT | ESM-only, in-memory |
| Tests / workspace | vitest + pnpm workspaces | MIT | — |

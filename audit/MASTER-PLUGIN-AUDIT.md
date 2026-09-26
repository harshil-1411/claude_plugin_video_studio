# video-studio · Master plugin audit

Repository: https://github.com/harshil-1411/claude_plugin_video_studio · commit `b6fd8ea` (2026-09-26) · 439 tracked files (396 excluding binary media, fonts and snapshots) · 16 detailed reports in `audit/01…16`.

**Method.** The structural reviews (01–04, 07, 08) are code-cited. Quality, pipeline, security, performance, tests and edge cases (05, 06, 10–14) were reproduced hands-on where feasible: hostile media, path-traversal projects, SIGTERM mid-render, concurrent renders, and a custom MCP stdio client. DX, competition and open-source quality are 09, 15 and 16. The top findings were spot-checked a second time against the code before inclusion. Anything not executed is marked as read from code in the detailed reports.

---

## Executive summary

**Plugin purpose.** A *knowledge-to-video compiler* for Claude Code:
- **Input:** text, docs, URLs, repos, footage.
- **Pipeline:** `ContentIR` (grounded evidence) → Claude writes a `VideoSpec` → a deterministic local engine (a bundled stdio MCP server, 28 tools) renders with FFmpeg or HyperFrames.
- **Checks:** 31 lint rules and technical QA.
- **Output:** per-platform packages (video, cover, captions, post copy, QA, `video.lock`).

Claude is the creative engine and the engine never calls an LLM. It is **not** a video-understanding plugin, although several audit-brief items assume one (see "Missing capabilities").

**Current maturity.** A solid **beta for local, narrated or motion-graphic reels**. The core compile → render → lint → package path is implemented, tested (~880 tests) and has been used on real projects. It is **alpha for footage workflows** (shorts, tighten, cutaways, demo) and **not started** for paid providers and publishing.

Feature catalogue (04): 58 IMPLEMENTED · 9 PARTIAL · 1 BROKEN · 2 EXPERIMENTAL · 8 DOCUMENTED_ONLY · 14 MISSING.

**Strengths:**
1. Grounding and provenance end to end (`verify`, strict `claim_refs`).
2. A platform compiler: `platform-specs/*.yaml` as data, UI-mask lint, per-target packages.
3. Reproducibility: `video.lock`, content-hash caches, golden frames, classified `diff`.
4. Safe command execution: argv-only processes, `textfile` + `expansion=none`, two-level filtergraph escaping.
5. Craft: word cues, reading-time captions, beat sync, the story-arc lint, and a `review`/`compare` self-check.
6. Local-first and no LLM key.

**Weaknesses:**
1. **Docs promise more than the code does.** Provider keys, a `VideoProviderAdapter`, policy enforcement and spend limits are in config, schema or CLAUDE.md but not in the code (8 DOCUMENTED_ONLY entries).
2. **Robustness gaps under real conditions:**
   - The cache misses screenshot and logo file changes.
   - Transcription is English-only, and non-English speech silently becomes garbled English.
   - Re-ingesting replaces all evidence.
   - Renders can't be cancelled, and a server kill orphans ffmpeg.
   - `job_status` crashes after a restart.
3. **Path confinement is inconsistent:** strong for footage, music, sfx and the logo overlay; missing for the end-card logo, `captions_file`, `ingest`, `demo` scripts and URL fetches (SSRF).
4. **Token-heavy tool outputs** (every result carries its JSON twice), and one 577-line pipeline function.

**Biggest opportunities.**
- Make the footage workflow production-grade: video URL input, subject-aware reframing, multilingual transcription, diarization, and a "see this footage" tool.
- Honour the promises already in the schema: spend policy, provider adapters starting with ElevenLabs.
- Publish and version it properly: marketplace-first install, changelog, releases.

---

## Architecture summary (02, 03)

```
Claude Code ──loads──▶ .claude-plugin/plugin.json ─┬─▶ skills/*/SKILL.md (21, /video-studio:<name>)
                                                   ├─▶ agents/*.md (source-researcher, creative-director)
                                                   └─▶ .mcp.json → node dist/mcp.mjs  (stdio MCP, 28 tools)
dist/mcp.mjs = packages/mcp (server, pipeline, lint, jobs) ─▶ renderer (ffmpeg, HyperFrames, footage)
                                                           ─▶ media (ffmpeg/ffprobe, captions, audio, QA, ASR)
                                                           ─▶ voice (say/espeak, ElevenLabs, silent)
                                                           ─▶ ingestion (text/pdf/docx/pptx/url/html/repo/media)
                                                           ─▶ platforms (contracts, zones, masks) · core (cache, ledger, paths)
                                                           ─▶ schema (zod v4 → schemas/*.json)
State: project folder (durable) · ${CLAUDE_PLUGIN_DATA} (cache, SQLite ledger, deps, models; disposable)
```

The layering is clean and mostly one-directional, and the contracts between stages are real zod schemas. The main concentration of risk is `packages/mcp/src/pipeline.ts`: `renderProjectLocked` is one 577-line function (05). It absorbs every new feature (voice, cues, logo, captions, music, footage, QA, export), and most regressions this session originated there.

**Scalability:** the architecture scales to more scene kinds, platforms, lint rules and styles (each is data or a registry entry). Rendering is serial and single-threaded by design (`select.ts:324`, `-threads 1`), so it doesn't scale to long-form or batch work (11).

---

## Current feature capability matrix (condensed from 04)

| Area | Status | Notes |
|---|---|---|
| Ingest: md/txt/pdf/docx/pptx/url/local html/repo (secret-scanned) | IMPLEMENTED | SSRF gap (S1); mistyped path ingested as literal text (13) |
| Ingest: video/audio/clip folders, shots, keyframes, loudness, letterbox | IMPLEMENTED | No rotation/HDR probe; a PNG renamed `.mp4` becomes a 0-second video (13) |
| Video URL input (YouTube etc.) | MISSING | 15 G1 |
| Transcription (whisper.cpp, SRT/VTT import) | PARTIAL | English-forced with the offered model (06, High) |
| Planning: 18 templates, briefs, grounded spec, storyboard, story lint | IMPLEMENTED | |
| Render: 15 scene kinds × 2 renderers, footage, 4 styles, transitions, motion, cues, count-up | IMPLEMENTED | Cache misses image-byte changes (High) |
| Voice: say/espeak + natural voice pick, whisper alignment, ElevenLabs | IMPLEMENTED / PARTIAL | ElevenLabs failure skips system voice → silent; placeholder key accepted (08, 03) |
| Captions: phrase engine, reading time, plates, zones, emphasis, per-scene burn | IMPLEMENTED | |
| Audio: music beds, ducking, beat sync, scene audio, sfx, loudness | IMPLEMENTED | |
| Lint (31 rules), QA, verify, test, diff, review, compare | IMPLEMENTED | `lint`/`verify` mis-annotated read-only (07) |
| Packages per platform, lock, provenance, C2PA (test cert) | IMPLEMENTED | |
| shorts, tighten, cutaways, analyze, demo, localize, variants, adapt | IMPLEMENTED / EXPERIMENTAL | `variants` re-render duplicates and deletes under a running render (07) |
| Job status after engine restart | **BROKEN** | `render-jobs.ts:135,170` + `server.ts:78` |
| Render cancel | MISSING | only `close()`, never called; no signal handlers (13) |
| Providers: Runway, HeyGen, fal, Kling, adapter interface, routing | DOCUMENTED_ONLY | config and doctor only |
| Policy, spend limits, consent enforcement | DOCUMENTED_ONLY | `policy.ts:78` "Enforced in engine code", never loaded |
| Vision: objects, faces, OCR, emotion, diarization, language detection | MISSING | by design so far; see below |
| Publishing, scheduling, analytics | MISSING | Phase 9 |

---

## Code quality assessment (05)

- **Good:**
  - Strict TypeScript.
  - zod contracts with emitted JSON Schema.
  - Consistent atomic writes.
  - Cache keys versioned by explicit constants (`LAYOUT_VERSION`, `ASSEMBLY_VERSION`, `QA_VERSION`, renderer versions).
  - Tests colocated with every package.
- **Hot spots:**
  - `renderProjectLocked` (577 lines, `pipeline.ts:418`) and `validateVideoSpecSemantics` (396 lines, `video-spec.ts:621`) should be split into stage functions.
  - The two renderers duplicate per-kind layout logic. Shared helpers (`cue-timing`, `count-up`, `entrance`) are the right pattern and should be extended.
  - Casts cluster in tests (`as never`, `as unknown as`).
- **Hygiene:**
  - The test suite leaks temp dirs: about 3,900 `vs-*` dirs and 859 MB found (12).
  - No signal handling, so a crash leaves temp files behind (S12).
  - The voice process runner has no timeout (`voice/src/exec.ts:20`).

## Security findings (10)

No Critical or High findings. The execution layer is well engineered. Medium findings:
- **S1 SSRF:** URL ingest fetches loopback and private hosts, including through redirects.
- **S2 Spend and consent advisory only:** `policy.yaml` is never loaded; `voice: auto` silently uses a paid ElevenLabs key; consent flags are model-supplied booleans; no skill sets `disable-model-invocation`, contrary to `.claude/CLAUDE.md`.
- **S3 Secrets kept:** secrets in non-repo inputs are flagged but stored verbatim in `content-ir.json` and could be narrated to ElevenLabs.
- **S4 Logo bypass:** the ffmpeg end-card logo accepts absolute paths (`ffmpeg-renderer.ts:2220`), unlike the overlay path.

Low findings (S5–S13): demo masking race and unchecked `goto` hosts; symlink escape in HyperFrames image confinement; unconfined `captions_file`; any absolute path accepted by `ingest`; no cap on local HTML size; `%{}` expansion in review labels; transitive deps of the HyperFrames install unpinned; crash leftovers; a literal `~` directory.

## Performance findings (11)

- Tiny preview 4.4 s; cached re-render 2.4 s; 9 s final at 1080×1920 in about 9 s. Caching works.
- Scenes render serially with `-threads 1`, and the reel passes through 3–4 lossy H.264 encodes (concat → logo overlay → burn-in → per-target transcode).
- **Tokens:**
  - `jsonResult` returns summary + pretty JSON + `structuredContent`, about 50% whitespace.
  - `tools/list` is 36 KB.
  - `job_status` repeats the whole payload on every poll.
  - The plan skill says to Read `content-ir.json` (1.1 MB when this repo is ingested).
  - `review` sheets past about 16 scenes exceed the ~1568 px vision limit.

## Testing findings (12, 13, 14)

- **Coverage:** about 880 unit and integration tests, golden ingest snapshots, one golden-frame example, and a stdio smoke test. Real `say`, HyperFrames and Chrome paths are env-gated and never run automatically. There's no CI by the owner's choice, and the pre-push hook isn't installed (`core.hooksPath` empty).
- **Handled well:** negative tests found good behaviour for empty, truncated and random files, missing ffmpeg, a missing model, concurrent renders (lock), and odd containers.
- **Silently wrong results:**
  - Mistyped paths are ingested as text.
  - A PNG is ingested as text.
  - Footage pointing at an audio asset renders "succeeded" with a misleading "Phase 7" placeholder.
- **Crashes and gaps:**
  - `job_status` crashes after a restart.
  - Missing tests: the MCP-level `job_status` restart path, `variants` re-entrancy, and cache invalidation on image-byte changes.

## UX findings (09)

- **Install:**
  - The Quick start is the developer path. End users need no pnpm, since the bundle has only `node:*` imports.
  - Provider keys that do nothing are offered in `/plugin` config.
  - Windows voice silently falls back to silent.
- **Messages:**
  - Errors are good where written by hand (the missing model, validation `fix`, the render lock).
  - Raw ffmpeg failures leak as `ffmpeg exited with code N` plus stderr.
  - No machine-readable error codes.
- **Stale skill text:**
  - `create` says talking-head "not available yet" (`skills/create/SKILL.md:37`).
  - `compare` points at the wrong tighten output path.

## Missing capabilities (15, 06)

**For this product's purpose**, ranked:
1. Video URL input (YouTube and similar, reusing existing subtitles).
2. Multilingual ASR with a language option and detection.
3. Subject- and face-aware reframing for 16:9 → 9:16.
4. Speaker diarization for interviews and podcasts.
5. A cheap "see this footage" tool: scene-change frames plus a transcript window for a time range, built on the `review` machinery.
6. Automatic self-evaluate → fix → re-render loop (video-use has up to 3 passes).
7. Natural multilingual voice (Phase 7 ElevenLabs).
8. Footage colour correction.
9. Publishing and analytics (Phase 9).

**Not for this plugin:** a general video QA or perception engine (objects, emotions), embeddings and a semantic video knowledge base, enterprise multi-tenant video intelligence. They conflict with local-first and deterministic, and belong to different products (15 §4).

---

## Recommended product roadmap

Each item lists problem → approach (components) · complexity · dependencies. Details are in the cited report.

### P0 Critical (correctness, trust, safety; about 1 week total)

| # | Item | Problem → approach | Cx | Refs |
|---|---|---|---|---|
| P0.1 | **Cache keys include asset bytes** | Replaced screenshot or logo ships stale pixels → hash every referenced image (screenshot assets, logo, brand files) into `sceneCacheKey` (`select.ts:155`) as footage already is. | S | 05, 13 |
| P0.2 | **Fix `job_status` after restart** | Crash for succeeded jobs → persist a result shape `formatJob` can read, or make it tolerate the summary (`render-jobs.ts:135`, `server.ts:78`); add an MCP-level test. | S | 07 |
| P0.3 | **Voice fallback order** | ElevenLabs failure → silent, even with `say` available; unexpanded `${user_config…}` treated as a key → on synthesis failure, fall back to `system` before `silent`; reject placeholder keys like `media/ffmpeg.ts:37` does. | S | 03, 08 |
| P0.4 | **Confine every path input** | End-card logo (absolute, S4), `captions_file` (S7), `demo` script (`demo.ts:202`), `ingest` absolute paths (S8) → route all through `resolveInsideProject`, or explicit user-confirmed external inputs. | S | 10 |
| P0.5 | **SSRF guard on URL ingest** | Resolve the host and block loopback, private and link-local ranges, before and after each redirect; add a size cap for local HTML (S9). | S | 10 |
| P0.6 | **Ingest merges instead of replacing** | Re-ingest wipes evidence and breaks `claim_refs` → merge sources by sha256 into the existing ContentIR, and annotate the tool honestly. | M | 07 |
| P0.7 | **Honest config and docs** | Mark or remove the Runway, HeyGen, fal and Kling keys; fix "Enforced in engine code" in `policy.ts:78`; fix stale skill text (`create:37`, `compare:22`). | S | 04, 08, 09 |

### P1 Important (reliability and workflow; 2–4 weeks)

| # | Item | Problem → approach | Cx |
|---|---|---|---|
| P1.1 | **Cancel and shutdown** | Add a `render_cancel` tool (the job `AbortController`), SIGTERM/SIGINT handlers in `main.ts` that abort jobs and kill ffmpeg child processes, and timeouts in `voice/src/exec.ts`. | M |
| P1.2 | **Spend and consent enforcement** | Load `policy.yaml`; `voice: auto` uses paid providers only with policy or explicit opt-in; `disable-model-invocation` on spend skills; consent recorded in the project, not a model boolean. Prerequisite for Phase 7. | M |
| P1.3 | **Multilingual transcription** | Add `language` to `transcribe`, offer a multilingual model (`ggml-base`/`small`) on consent, auto-detect otherwise, warn on mismatch with `spec.language`. | S–M |
| P1.4 | **Video URL input** | `ingest` accepts video URLs via yt-dlp (runtime-resolved, never bundled, consent like the model); prefer existing subtitles over ASR. Also covers Loom and Vimeo. | M |
| P1.5 | **Split `renderProjectLocked`** | Stage functions (validate, voice, align, footage, scenes, captions, logo, assemble, cover, QA, export) with typed inputs and outputs; the pipeline becomes a sequence. Unblocks everything else in the pipeline. | M |
| P1.6 | **Leaner tool outputs** | Compact JSON (or `structuredContent` only plus a one-line summary); `job_status` returns deltas while running; the plan skill reads a ContentIR *summary* tool, not the 1 MB file; `review` auto-splits sheets above ~16 scenes. | S–M |
| P1.7 | **Tool annotation audit** | Correct readOnly, destructive and openWorld hints (`lint`, `verify`, `export`, `test update`, `variants`, `shorts make_projects`, `render_submit`). Guard `variants` re-prepare against running renders and duplicate submits. | S |
| P1.8 | **Actionable ffmpeg errors and error codes** | Classify common `FfmpegError` causes (missing encoder or filter, unreadable input, disk full); add `code` to tool results. | S |
| P1.9 | **Marketplace-first install, versioning, SECURITY.md, CHANGELOG** | See 09 and 16. | S |

### P2 Enhancement (footage quality and craft)

| # | Item | Approach | Cx |
|---|---|---|---|
| P2.1 | **Subject-aware reframing** | Per-shot face/subject centre (a small local detector, runtime-resolved and opt-in, or Claude marking focus on keyframes via `review` crops) → animated `footage.focus` keyframes. | M–L |
| P2.2 | **"See this footage" tool** | `footage_look {asset, from, to}` returns scene-change frames (deduped, 512 px) plus the transcript window, reusing `review` and ingest shots. Claude writes scene notes into ContentIR, keyed by asset sha256 (the "video memory" idea, done per asset). | M |
| P2.3 | **Automatic review loop** | After a render: `review` + lint, then Claude fixes spec-level findings and re-renders, with at most 2 passes; stop on no change. | S–M |
| P2.4 | **Diarization** | whisper.cpp `-tdrz` (tinydiarize) or a pyannote-free heuristic; speaker labels in the transcript; `shorts` can filter by speaker. | M |
| P2.5 | **Footage QA** | Exposure, contrast and noise via `signalstats`, speech clarity via `astats`/SNR, rotation and HDR probe with tonemap (13 edge cases). | S–M |
| P2.6 | **Render performance** | Render 2–3 scenes in parallel when RAM allows; drop `-threads 1`; merge the logo overlay and burn-in into one encode pass. | M |

### P3 Future vision

- **Phase 7 providers:** ElevenLabs first, then generative b-roll behind a real `VideoProviderAdapter` with dry-run cost, idempotent submits and a mock conformance suite, as `.claude/CLAUDE.md` already specifies.
- **Phase 9 publishing and analytics:** closing the loop on `variants` experiments.
- **Localization with dubbing:** multilingual TTS, lip-sync out of scope.
- An X/Twitter platform contract, once verified from first-party docs.

---

## Final recommendation

1. **Is the architecture scalable?** Yes for breadth: new kinds, platforms, rules and styles are data or registries, with clean package boundaries. Not yet for depth. The pipeline is one monolithic function and rendering is serial, so long-form footage and batch work need P1.5 and P2.6 first.
2. **Is the plugin production-ready?**
   - **For narrated or motion-graphic reels from documents: nearly.** P0.1–P0.5 and P0.7 are small fixes; after them, the correctness, reproducibility and lint story is stronger than any comparable tool.
   - **For footage repurposing: not yet.** English-only ASR, no URL input, no reframing, no cancel, and ingest overwrites.
   - **For paid providers: no.** The adapters and spend enforcement exist only in docs.
3. **What prevents best-in-class?** Mainly the *inputs and footage handling*: URL video, multilingual ASR, reframing, diarization. Also *trust gaps* where the docs promise more than the code (policy, providers), and *operational robustness* (cancel, restart, cache correctness). The creative and compile half is already ahead of the field (15 §2).
4. **Top 10 differentiating features:**
   1. Cache and path correctness (P0.1, P0.4), the foundation of "reproducible".
   2. Multilingual transcription (P1.3).
   3. Video URL input (P1.4).
   4. Subject-aware reframing (P2.1).
   5. The "see this footage" tool with per-asset scene notes (P2.2).
   6. The automatic review → fix loop (P2.3).
   7. Real spend and consent enforcement (P1.2).
   8. Diarization for interviews and podcasts (P2.4).
   9. ElevenLabs voice plus provider adapters (P3).
   10. Publishing with variant analytics (P3).
5. **What to build next:** the **P0 block** first (about a week, mostly small, removes every verified wrong-result and trust issue). Then **P1.5 (split the pipeline)** together with **P1.1 (cancel and shutdown)**. Then **P1.3 + P1.4**, which make the footage workflow real for the owner's own content: interviews and talks on YouTube, in any language.

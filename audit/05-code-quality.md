# 05 — Code quality and architecture

Audited at `b6fd8ea` (2026-09-26). All line numbers refer to that commit. Measurements were taken with `wc -l`, a brace-matching function-size script (top-level `function` / `const x = (` declarations), and `grep` counts over `packages/*/src/**/*.ts`, excluding `*.test.ts` unless stated.

## 1. Package layout and separation of concerns

| Package | Src lines | Role | Assessment |
|---|---:|---|---|
| `schema` | 2,780 | zod v4 contracts: VideoSpec, ContentIR, RenderManifest, Brand, Policy, lock, etc. | Clean, dependency-free apart from zod/yaml. However `video-spec.ts:621` `validateVideoSpecSemantics` is a single **396-line** function holding every semantic rule. |
| `core` | 1,186 | Project layout, path confinement, CAS, canonical JSON, SQLite ledger, jobs | Small and well-factored, with no type escapes. |
| `ingestion` | 3,596 | Extractors (md, txt, url/html, pdf, docx, pptx, repo, media) → ContentIR | Good: extractor registry (`extractors.ts`), versioned per extractor, hostile-input caps in `office-common.ts`. It depends on `media` for ffprobe and shots, through the hand-made symlink (see §4). |
| `media` | 3,015 | ffmpeg process layer, escaping, captions (ASS), compose/assemble, QA, ASR, beats, letterbox | Cohesive. `captions.ts` is 955 lines. |
| `platforms` | 283 | Registry of `platform-specs/*.yaml`, geometry, zones | Small and data-driven, as intended. |
| `renderer` | 7,237 | ffmpeg-drawtext renderer, HyperFrames compose and renderer, footage renderer, tokens, text layout, scene selection and cache | Two very large files (below). |
| `voice` | 1,466 | say/espeak/ElevenLabs/silent backends, estimates | Has its **own** process runner and ffmpeg helpers; both carry TODOs to switch to `media` (`voice/src/exec.ts:56-60`, `voice/src/ffmpeg.ts:1-4`). |
| `mcp` | 11,274 | MCP server with 28 tools, plus pipeline, lint, review, export, targets, lock, shorts, tighten, localize, demo, c2pa, etc. | This package is the "everything else" bucket: orchestration, product features and presentation live together. |

The direction of dependencies is sound: schema ← core ← media ← renderer/voice/ingestion ← mcp, with no cycles found. The weak point is `mcp`: 29 modules, several of them product features (shorts, tighten, localize, variants, demo) rather than server glue. Adding a feature means adding to `mcp/src` plus a tool registration in `server.ts`.

### Largest files and functions (measured)

| File | Lines | Largest functions (lines) |
|---|---:|---|
| `packages/renderer/src/ffmpeg-renderer.ts` | 2,290 | `buildFilterGraph@1758` (138), `createFfmpegRenderer@2168` (123), `diagram@669` (115), `timeline@1032` (89), `chart@584` (84), `map@1287` (76); 70 top-level functions |
| `packages/mcp/src/pipeline.ts` | 1,986 | **`renderProjectLocked@418` (577)**, **`exportFromState@1551` (296)**, `planLogo@1925` (62), `beatSyncDurations@1343` (61), `lockFromState@1853` (55) |
| `packages/renderer/src/hyperframes-compose.ts` | 1,981 | `buildComposition@1829` (153), `renderChart@521` (147), `renderDiagram@711` (111), `renderMap@1369` (86) |
| `packages/mcp/src/lint.ts` | 1,257 | `checkEnvelope@227` (86), `lintProject@1172` (78), `checkCover@557` (66), `checkCaptionSync@810` (65) |
| `packages/schema/src/video-spec.ts` | 1,038 | **`validateVideoSpecSemantics@621` (396)** |
| `packages/media/src/captions.ts` | 955 | `groupCaptionLines@250` (89), `toAss@817` (83) |
| `packages/mcp/src/server.ts` | 814 | `createServer@101` (714): 28 inline `registerTool` blocks |

**Complexity hot spot 1: `renderProjectLocked` (`pipeline.ts:418-994`).** A 577-line procedural function runs validation, brand/style/token resolution, voice synthesis with fallback, whisper alignment, footage and music resolution, timing adjustments, beat sync, frame-boundary slotting, native transcripts, word cues, scene rendering with an ffmpeg retry, captions and sound-event cues, scene audio, the assembly cache key, assembly, thumbnail, QA and state writes. Stages communicate through about 40 local variables (`adjusted`, `slotMs`, `bounds`, `nativeTracks`, `sceneCues`, `placements`, …). The consequence is that no stage can be unit-tested without running the whole function: `pipeline.test.ts` (929 lines) drives it end to end with real ffmpeg. A change to timing (for example beat sync, lines 522-547) cannot be tested apart from rendering.

**Hot spot 2: `validateVideoSpecSemantics` (`video-spec.ts:621`, 396 lines).** Every semantic rule sits in one function, so adding a rule means editing it. There is no rule table, no per-rule id and no per-rule tests.

**Hot spot 3: `createServer` (`server.ts:101-814`).** The 714-line function is mostly declarative schema, which is acceptable, but the tool descriptions are embedded prose. Several run to 700+ characters (for example `spec_validate` at `server.ts:183`), and `tools/list` totals 36 KB (see 11-performance).

## 2. Modularity and extensibility: cost of common changes

| Change | Files that must change (verified with grep) | Difficulty |
|---|---|---|
| **New scene kind** | `schema/src/video-spec.ts` (DeterministicKind enum, props schema, semantic checks, `propsText`), `schema/src/cues.ts` (cue items), `renderer/src/ffmpeg-renderer.ts` (`FFMPEG_RENDERER_KINDS@69` plus a draw function plus the `case` in the dispatch), `renderer/src/hyperframes-compose.ts` (a render function, CSS and dispatch), `mcp/src/localize.ts` (translatable text paths), templates and skill docs | **High.** Every kind is implemented twice, with different geometry: pixel math in ffmpeg (`diagram@669`, 115 lines) and CSS/SVG in HyperFrames (`renderDiagram@711`, 111 lines). Kinds `split_screen` and `stat` are referenced in 5–6 files each. |
| **New platform** | `platform-specs/<id>.yaml` (data), `schema/src/common.ts:41` `Platform` enum and `:65` `PRIMARY_TARGET` map | **Low.** Facts are data, as the architecture rules require. The platform enum is still code, so a new platform needs a schema release and a `pnpm schemas` run. |
| **New provider** (Phase 7) | No `VideoProviderAdapter` interface exists yet (grep: 0 hits in src). `select.ts:152` hard-codes `PENDING_REASON` for all non-deterministic strategies. | **Unknown / not built.** CLAUDE.md promises an adapter and a conformance suite, but neither exists. |
| **New lint rule** | `mcp/src/lint.ts`: write a `checkX(spec, …, findings)` function and call it from `lintProject@1172` | **Low**, but there is no rule registry, no severity configuration and no suppression mechanism (grep for `suppress\|ignore` finds 0 hits). 31 distinct rule ids are hard-coded strings. A warning the user has accepted (for example `reading_density` on a deliberate fast cut) re-appears on every lint and review run. |
| **New voice backend** | `voice/src/<x>.ts` implementing `VoiceBackend`, plus `synthesize.ts` `defaultBackends`/`BackendChoice` | **Low to medium.** It is a clean interface, but `BackendChoice` is a closed union (`synthesize.ts:23`). |

**Cross-renderer coupling.** `hyperframes-compose.ts:7` imports `sceneMotionParams` from `ffmpeg-renderer.ts`. Shared timing already lives in neutral modules (`count-up.ts`, `cue-timing.ts`, `entrance.ts`, `text-layout.ts`), and this one helper should move there too. As it stands, loading the HyperFrames composer pulls in the whole 2,290-line ffmpeg renderer.

## 3. Duplication

- **Two renderers per kind** (above). The duplication is inherent to the design, since there are two back ends. Shared timing modules mitigate it, but layout and visual parity are enforced only by golden frames for the ffmpeg path (`tests/golden-frames`). HyperFrames goldens require `VS_TEST_RENDER=1` outside the sandbox.
- **Two process runners.** `media/src/ffmpeg.ts:179` `runProcess` has timeouts, abort, stderr tail capping and SIGKILL escalation. `voice/src/exec.ts:20` `defaultRunner` has **no timeout** and unbounded stdout/stderr buffers. `say`, `espeak-ng` and the voice package's ffmpeg calls all go through the weaker runner, so a hung `say` hangs the render job forever, and there is no cancel tool (see §6).
- **Two ffmpeg locators.** `media/src/ffmpeg.ts` `getTools` and `voice/src/exec.ts:61` `resolveFfTool` (whose own comment says "TODO: swap for @video-studio/media's resolver"). The doctor has a third `execFile` path (`mcp/src/doctor.ts:76`).
- **Colour helpers, written 4 to 6 times:** `captions.ts:574/583` (`assColor`, `assTagColor`), `ffmpeg-renderer.ts:206/212/224/1900` (`rgb`, `toHex`, `ffColor`, `assTagColour`), `tokens.ts:34` (`normalizeHex`), `hyperframes-compose.ts:304` (`mixHex`), `lint.ts:194` (`relativeLuminance`), `qa.ts:48` (`lumaOf`). Lint's contrast check and QA's luma check can disagree because they use different formulas.

## 4. Dependency management

- **Workspace symlinks.** `packages/ingestion/node_modules/@video-studio/media` is a hand-made symlink (created 2026-09-25 22:29, per `ls -la`), as HANDOFF notes. `pnpm-lock.yaml` now lists `@video-studio/media` under `packages/ingestion`, so a fresh `pnpm install` recreates it. The residual risk is procedural: the sandbox cannot run `pnpm install`, so every new workspace edge needs a manual symlink. A contributor who clones and runs `pnpm install` is fine.
- **Runtime-resolved dependencies.** HyperFrames is resolved from `${CLAUDE_PLUGIN_DATA}/deps/node_modules` or the plugin root (`mcp/src/hyperframes.ts`). Only `package.json.version === "0.8.78"` is checked (`hyperframes.ts` `inspect`). The documented install command (`HYPERFRAMES_INSTALL_COMMAND`) is a bare `npm i @hyperframes/producer@0.8.78` with no lockfile, so **transitive dependencies are unpinned**. Two users on the same "pinned" version can get different puppeteer-core or Chrome-protocol code, which undermines the determinism claim for HyperFrames renders.
- **Bundle.** `packages/mcp/tsdown.config.ts` inlines everything into an 8.4 MB `dist/mcp.mjs` and aliases `repomix` to its file-search module, which is well reasoned. The bundle is committed and checked by the `--push` mode of `scripts/check.mjs`. The pre-push hook lives in `.githooks/pre-push`, but `git config core.hooksPath` is **empty** in this checkout, so the hook is not active until `pnpm hooks` is run.
- **Pinned model.** The whisper model sha256 is pinned (`mcp/src/transcribe.ts:25`) and verified on download only. A model placed via `VS_WHISPER_MODEL` or already on disk is never re-hashed, which is acceptable.

## 5. Type safety

| Package | `as never` | `as unknown as` | `any` | `@ts-ignore` / `@ts-expect-error` | `TODO`/`FIXME` |
|---|---:|---:|---:|---:|---:|
| core | 0 | 0 | 0 | 0 | 0 |
| ingestion | 0 | 5 | 0 | 0 | 1 |
| mcp | 0 | 26 | 0* | 0 | 1 |
| media | 0 | 0 | 0 | 0 | 0 |
| platforms | 0 | 0 | 0 | 0 | 0 |
| renderer | 0 | 1 | 0* | 0 | 0 |
| schema | 0 | 0 | 0 | 0 | 0 |
| voice | 0 | 0 | 0 | 0 | 2 |

\*The two regex hits for "any" are prose inside strings or comments (`server.ts:183`, `script.ts:10`), not the type.

All 26 `as unknown as` casts in `mcp` are in `server.ts` and have the same form: `r as unknown as Record<string, unknown>` for `jsonResult` (`server.ts:91`). They exist because typed results are not declared as `outputSchema`, so the MCP `structuredContent` is untyped. The ingestion casts are all at third-party boundaries: the repomix config (`repo.ts:109`), the secretlint config (`repo.ts:183`) and the JSZip private field (`office-common.ts`). `tsconfig.base.json` has `strict` and `noUncheckedIndexedAccess`, but `exactOptionalPropertyTypes: false`, which is why the code is full of `...(x ? { x } : {})` spreads (hundreds of them). The type discipline is excellent.

## 6. Engineering practices

**Error boundaries.** Every tool handler is wrapped by `safe()` (`server.ts:55`), which converts exceptions into `isError` tool results. `renderScenes` never throws for a scene (`select.ts:305-311`); instead it returns `failed` and the pipeline retries with ffmpeg (`pipeline.ts:636-643`). This is good. The counterpart is that per-stage failures can become **successful renders with a placeholder**, where the real reason is visible only in `render-state.json` (see 13-negative, cases N12/N20).

**Swallowed errors.** There are 63 `catch {` blocks without a bound error and 33 `.catch(() => {}|undefined|null|false)`. Most are legitimate best-effort cases (caches, ledger). Two hide real user-visible problems:
- `ingestion/src/media.ts:139`: `/* a keyframe is optional */`. The keyframe fails silently for a 1-frame video and for a 1-fps 4000×4000 clip (verified: no keyframe asset and no warning).
- `ffmpeg-renderer.ts:2221`: `catch { path = null }` hides *why* a logo was rejected. The warning says "could not be read" even when the real reason is "escapes the project via symlink".

**Logging.** `main.ts:5-7` routes `console.log` to stderr (correct for stdio). There are 18 `console.*` calls in src and no levels, no log file and no correlation with job ids. Diagnostics reach the user only through tool results and the ledger. If a render hangs, nothing records which ffmpeg command was running.

**Retries.** The only retries are ffmpeg re-rendering failed HyperFrames scenes (`pipeline.ts:636`), whisper retried on CPU after a GPU crash (`media/src/asr.ts:62-71`), and review frame extraction stepping back up to 3 frames (`review.ts:296`). There is no network retry for URL ingest or ElevenLabs, which is acceptable for a local-first tool.

**Temp directories and cleanup.** Runtime code uses `mkdtemp` plus `try/finally rm` consistently (about 30 sites; see 10-security §1.3). Three gaps:
1. **No signal handling.** `main.ts` installs no SIGTERM/SIGINT handler, and `RenderJobManager.close()` (`render-jobs.ts:179`) is only called by tests. Verified: a SIGTERM 1.5 s into a render left `renders/.render.lock` behind (recovered on the next run because the pid was dead), a `.s01.<pid>.tmp.mp4` in the scenes directory that is **never cleaned**, and a `vs-ffr-*` temp dir. The orphaned ffmpeg **kept running after the server died**: the tmp file grew from 48 B to 46 KB after the kill.
2. **Test suites leak temp dirs.** `$TMPDIR` holds **3,879 `vs-*` directories (859 MB)** from the last two days: 1,650 `vs-core-*` and 1,284 `vs-lint-*`. `core/src/*.test.ts` (7 files) and `mcp/src/lint.test.ts` call `mkdtemp` with no `rm`. On this low-RAM, low-disk laptop, `pnpm test` leaks about 400 MB per day.
3. There is no MCP tool to cancel a render. The only abort path is killing the server.

**Resource management.** Encodes run single-threaded (`-threads 1`: `ffmpeg-renderer.ts:2065`, `footage.ts:262`), scenes render one at a time (`select.ts:324`, where `concurrency` defaults to 1 and the pipeline never sets it, `pipeline.ts:621-634`), and the job queue runs one render at a time (`render-jobs.ts:40`). This is deliberate for a low-RAM machine but not configurable. See 11-performance.

**Cache invalidation via version constants.** There are 16 version constants (`ENGINE_VERSION`, `QA_VERSION=3`, `ASSEMBLY_VERSION=5`, `COVER_VERSION=3`, `LAYOUT_VERSION=10`, `FFMPEG_RENDERER_VERSION=0.5.0`, `FOOTAGE_RENDERER_VERSION=0.3.0`, `ZONES_VERSION=2`, `VOICE_CACHE_VERSION`, `ALIGN_VERSION`, extractor versions, and more). The scheme is sound but depends on the author remembering to bump them, and nothing enforces it (no test hashes renderer source against its version). **A concrete invalidation bug exists:** the scene clip key (`renderer/src/select.ts:155-180`) hashes the scene JSON, tokens, target, zones, renderer and footage sha, but **not the bytes of referenced images**. The screenshot asset file and the brand logo are keyed by path only. Verified: after replacing `source/assets/shot.png` (a screenshot scene) and the logo file, a re-render reported `cached` and shipped the old pixels (13-negative N16/N17).

**Config handling.** Configuration comes from 18 environment variables (`CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `VIDEO_STUDIO_DATA`, `FFMPEG_PATH`, `FFPROBE_PATH`, `CHROME_PATH`, `HYPERFRAMES_*` (4), `WHISPER_CPP_PATH`, `VS_WHISPER_MODEL`, `ELEVENLABS_*`, `C2PATOOL_PATH`, `FC_MATCH_PATH`, `VS_KEEP_HYPERFRAMES_TMP`, `VS_HYPERFRAMES_VERBOSE`) plus per-project `brand.yaml`, `styles/` and the spec. There is no central config module, and each package reads `process.env` itself. `resolveInputPath` (`mcp/src/paths.ts:9-13`) does not expand `~`: `project_init {dir: "~/x"}` created a literal `./~/x` directory in the server's cwd (verified). **`policy.yaml` has a zod schema whose description says "Enforced in engine code"** (`schema/src/policy.ts:78`), but no module loads or enforces it (grep for `Policy`/`policy` in `mcp` and `voice` src finds only the schema name list). The CLAUDE.md rule "spend limits, policy and consent are enforced in engine code" is not implemented.

**Comments and naming.** Module headers are consistently excellent: every analysis module opens with a doc block explaining the method and its limits (`letterbox.ts`, `beats.ts`, `voice-align.ts`, `analyze.ts`). Names are domain-accurate (`slotMs`, `planScenes`, `cutawayPicture`). One stale claim: `compose.ts:272` says "the reel is only one generation away from the master", which is true, but the master is already the second generation (scene clip → concat), and a logo overlay adds another (see 06).

## 7. Summary of code-quality findings

| # | Finding | Where | Consequence |
|---|---|---|---|
| CQ1 | 577-line orchestration function | `pipeline.ts:418` | Stages cannot be tested or reused on their own; any timing change needs a full render test |
| CQ2 | Scene cache ignores the bytes of referenced images | `select.ts:155-180` | Stale screenshots and logos ship after the files are replaced (verified) |
| CQ3 | No signal handling, `close()` unused, no cancel tool | `main.ts`, `render-jobs.ts:179` | Orphan ffmpeg keeps running and tmp clips leak (verified) |
| CQ4 | Voice runner has no timeout | `voice/src/exec.ts:20` | A hung `say`/`espeak-ng` blocks the single render slot forever |
| CQ5 | Policy schema claims engine enforcement; none exists | `schema/src/policy.ts:78` | False assurance about spend and consent controls |
| CQ6 | Tests leak temp dirs | `core/src/*.test.ts`, `mcp/src/lint.test.ts` | 859 MB and 3,879 dirs in `$TMPDIR` |
| CQ7 | Semantic validation is one 396-line function; lint has no registry or suppression | `video-spec.ts:621`, `lint.ts:1172` | Rules are hard to add or test in isolation, and accepted warnings recur |
| CQ8 | Duplicated runner, locator and colour math | `voice/src/exec.ts`, `voice/src/ffmpeg.ts`, 6 colour helpers | Behaviour drift (the timeout gap in CQ4 is a direct result) |
| CQ9 | HyperFrames transitive dependencies unpinned | `hyperframes.ts` install command | "Pinned" renderer is not reproducible |
| CQ10 | Pre-push gate not active | `.githooks/pre-push`, `core.hooksPath` empty | With no CI, nothing runs the checks before a push |

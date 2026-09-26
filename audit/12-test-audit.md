# 12 — Test audit

**Counting method:** test files are `*.test.ts` under `packages/*/src` and `tests/`. "Tests" means `it(`/`test(` call sites counted with grep, so `it.each` rows are not expanded. HANDOFF reports 873 passing and 5 skipped under `pnpm check`. The full suite was **not run** (machine load, per instructions). Two files were run as a sanity check: `render-lock.test.ts` and `project.test.ts` → 8/8 passed in 353 ms.

## 1. Inventory

| Package | Test files | Test sites | Test lines | Src lines | Test:src |
|---|---:|---:|---:|---:|---:|
| core | 7 | 30 | 542 | 1,186 | 0.46 |
| ingestion | 15 | 87 | 1,353 | 3,596 | 0.38 |
| mcp | 23 | 217 | 4,943 | 11,274 | 0.44 |
| media | 9 | 84 | 1,234 | 3,015 | 0.41 |
| platforms | 2 | 19 | 196 | 283 | 0.69 |
| renderer | 14 | 237 | 3,580 | 7,237 | 0.49 |
| schema | 2 | 54 | 668 | 2,780 | 0.24 |
| voice | 5 | 45 | 775 | 1,466 | 0.53 |
| `tests/golden` | 1 | 10 fixtures | – | – | ingest snapshots (`__golden__/*.content-ir.json`) |
| `tests/golden-frames` | 1 | – | – | – | example PNG goldens (`text-to-motion-graphic/preview/*.png`) |
| **Total** | **79** | **~773 sites (873 with `.each`)** | **13,291** (+249 in `tests/`) | **30,837** | **0.43** |

Configuration: `vitest.config.ts` uses `pool: "forks"` and `maxWorkers: 2`, which suits a low-RAM machine.

### Environment-gated tests
| Gate | Files | What it unlocks | Runnable in the sandbox? |
|---|---|---|---|
| `VS_TEST_SAY=1` | `voice/src/system.test.ts` (2 sites) | real macOS `say` | No (sandbox writes an empty file) |
| `VS_TEST_RENDER=1` | `renderer/src/hyperframes-renderer.test.ts` (3) | real HyperFrames plus Chrome render | No (Chrome blocked) |
| `VS_TEST_GOLDEN=1` | `tests/golden-frames/examples.test.ts` (4) | golden-frame SSIM of the example project | Yes |
| `VS_TEST_WHISPER` | `media/src/asr.test.ts`, `mcp/src/transcribe.test.ts` (3 each) | real whisper-cli plus model | Needs the model (not downloaded) |
| `VS_TEST_FRAMES` | `renderer/src/ffmpeg-renderer.test.ts` (3), `footage.test.ts` (2) | writes frame PNGs for inspection | Yes |

HANDOFF mentions only three gates. `VS_TEST_WHISPER` and `VS_TEST_FRAMES` are undocumented there, so **whisper-based alignment and transcription are never exercised against a real binary** in any routine run.

### Integration coverage that exists
- **Real ffmpeg:** most media, renderer and pipeline tests spawn the system ffmpeg on lavfi inputs (for example `pipeline.test.ts:607-640` builds a 4 s 320×240 clip, a transcript and an sfx file). This is strong. The pipeline is tested end to end with real encodes.
- **MCP over stdio:** `scripts/smoke-mcp.mjs` spawns the bundle, checks the 28 tool names, ingests PDF/DOCX/PPTX/repo fixtures, lists templates and renders a 3-scene project through `render_submit`/`job_status`. There is **one** render scenario and no negative calls.
- **Path confinement:** `core/src/project.test.ts:36-45` covers `..`, absolute paths and symlink escapes for `resolveInsideProject`.
- **Security-relevant units:** `url.test.ts` (redirects, timeouts, size cap, content-type), `repo.test.ts` (secret exclusion, symlinks, binaries), `office` tests (zip-bomb guards), `render-lock.test.ts`, `demo.test.ts` (with a fake browser), `c2pa.test.ts`, `transcribe.test.ts` (download sha mismatch).
- **Golden ingest snapshots** for 10 source types, with the extractor version bump documented.

## 2. Important behaviour without tests (verified gaps)

Each row below was verified by grep over `*.test.ts`, and most are backed by a failing hands-on case in 13-negative-testing.

| Function or behaviour | Location | Gap | Evidence |
|---|---|---|---|
| Scene cache invalidates when **image bytes** change | `renderer/src/select.ts:155` | `select.test.ts` tests key stability, not screenshot or logo byte changes | N16/N17 show stale output |
| Absolute logo path confinement in the ffmpeg renderer | `ffmpeg-renderer.ts:2220` | `logo_path` tests exist only in `tokens.test.ts` and `hyperframes-compose.test.ts` | N25 composites an outside file |
| `resolveMusic` path rejection | `mcp/src/music.ts:84` | no direct test (grep `resolveMusic` → 0) | N18/N19 pass by construction |
| sfx / symlink rejection through the pipeline | `pipeline.ts:1312` | pipeline tests only use valid sfx | N21 |
| `detectKind` on a **missing** `.txt`/`.md` path | `ingestion/src/detect.ts:106`, `ingest.ts:142` | no test that a typo path errors | N29: the path string becomes the content |
| Unknown extension or binary file → text | `detect.ts:104` | none | N9, N30 |
| Review drawtext with `%` in cue words | `review.ts:166-168` | `review.test.ts` tests `tileDecor` strings, not ffmpeg output | N15 |
| SSRF: private or loopback targets and redirects into them | `url.ts` | no test (none expected, since there is no guard) | N27 |
| `captions_file` confinement | `transcribe.ts:263` | none | N34 |
| Signal handling, orphaned children, tmp cleanup after abort | `main.ts`, `select.ts:283-311` | only in-process `AbortSignal` tests | N38 |
| `voice/src/exec.ts` runner timeout | `exec.ts:20` | none (no timeout exists) | – |
| Footage from an **audio** asset surfacing as an error | `pipeline.ts:1161` | the placeholder path is tested; the user-facing message is not | N13 |
| Image-as-video (duration 0) | `ingestion/src/media.ts:114` | none | N8 |
| Rotated or HDR media | `media/src/ffmpeg.ts:318` | none | N23/N24 |
| `project_init` or `ingest` with `~` | `mcp/src/paths.ts:9` | none | N39 |
| Schema modules | `schema/src/{content-ir,creative-brief,brand,render-manifest,footage,policy,…}.ts` | only indirectly, through `schema.test.ts` (54 sites for 2,780 lines, the lowest ratio) | – |
| `validateVideoSpecSemantics` per rule | `video-spec.ts:621` | exercised through `schema.test.ts` and `spec-validate.test.ts`, not rule by rule | – |
| `policy.yaml` enforcement | none | nothing to test, because the feature does not exist | S2 in 10-security |

## 3. End-to-end gaps
- **No CI** (the user's choice). The only gate is `scripts/check.mjs`, which runs typecheck, all tests, bundle, smoke, both plugin validations and golden frames. `.githooks/pre-push` exists, but **`git config core.hooksPath` is empty** in this checkout, so the pre-push gate is not installed (`pnpm hooks` has not been run). In practice, nothing runs before a push unless someone remembers to.
- **The interactive flow is never automated.** `/video-studio:create` (skills → MCP → files) was verified once by hand. No test drives a skill with a scripted model, and no eval asserts that the plan skill produces a valid spec for a given IR.
- **HyperFrames, `say`, whisper and demo capture** run only on the user's machine, outside the sandbox, by hand (USER_CHECKLIST). Their regressions surface only when the user renders.
- **Temp-dir hygiene.** The core and lint tests leak about 3.9k directories (859 MB), which makes local runs slower and fills the disk over time.
- **Smoke covers only the happy path.** It includes no failing call, no concurrency and no cancel.

## 4. Recommended testing strategy

### 4.1 Unit and property tests (cheap, in the sandbox)
1. `sceneCacheKey` must change when any file that affects the picture changes: screenshot, logo, fonts. Parametrize over each kind that references a file.
2. A table-driven path-confinement test covering every spec or brand field that names a file (`footage` via IR, `sfx`, `music`, `brand.visual.logo` in **both** renderers and the overlay, `captions_file`, `screenshot` assets), with `../`, absolute paths, symlink-out and `~` inputs.
3. `detectKind` and `resolveIngestInput`: a missing `.txt`/`.md` must throw, and binary content must be refused or routed to an image extractor.
4. drawtext fuzz: run random Unicode, `%`, `:`, `'`, `\`, `,`, `;`, `[`, `]` and `{}` through every drawtext site (renderer, cover, review), render one frame, and assert exit 0 **and** no `Stray %` / `Error` in stderr.
5. Split `validateVideoSpecSemantics` and the lint checks into rule units, with one fixture per rule id (31 lint ids).
6. Add `afterAll(() => rm(dir, {recursive: true}))` to every test that calls `mkdtemp`.

### 4.2 Integration (real ffmpeg, tiny media, in the sandbox)
1. **Media matrix:** for each of {mp4/h264, mov, webm/vp8/vp9, mkv/mpeg4+mp3, 1-frame, zero-length, PNG-as-mp4, audio-only, rotated 90°, 10-bit PQ, 4000×4000, VFR, interlaced}, run ingest → footage render → QA and assert either success with the expected metadata or a named, actionable error. 13-negative already scripts most of these (`$TMPDIR/vsaudit/mkfoot.mjs`).
2. **Failure surfacing:** any scene that falls back to a placeholder for a reason other than "provider needed" must fail the render, or at least put the true reason in the job summary.
3. **Abort and crash:** spawn the bundle, submit a render, send SIGTERM after 1 s, restart, re-render, and assert no `*.tmp.mp4` remains, no `vs-*` temp dir leaks and no ffmpeg process survives (`killtest.mjs` in the audit folder does the first half).
4. **Lock:** two bundles render the same project, so exactly one should succeed and the other gets `RenderLockedError`. Also assert that `export` during a render is refused (it currently is not locked).

### 4.3 MCP contract tests
Extend `smoke-mcp.mjs` into a table of `{tool, args, expect: ok|isError|rpcError, text contains}` covering all 28 tools, with at least one negative case each: the bad-JSON spec, schema violations, unknown template, unknown job, invalid enum and missing required argument cases from N28–N44. Also assert response size budgets (for example `job_status` ≤ 2 KB) to catch token regressions.

### 4.4 E2E scenarios (outside the sandbox, run before each release by `scripts/check.mjs --e2e`)
| # | Scenario | Asserts |
|---|---|---|
| E1 | Markdown doc → explain template → HyperFrames plus `say` render → export for instagram and youtube-shorts | lint has 0 errors, QA passes, loudness −14 ±1 LUFS, `video.lock` verifies, captions are aligned (whisper present) within 150 ms |
| E2 | 90 s talking-head mp4 → transcribe → tighten → shorts (3 candidates) → render each short | each short 15–60 s, cuts on sentence boundaries, no filler words in captions |
| E3 | Screen recording via `demo` against a local fixture app with a form and a table | inputs blurred in every frame (SSIM against a masked reference), `goto` to a non-local URL warns |
| E4 | Non-English (Hindi) voiceover and footage | captions in Devanagari are shaped, and whisper transcribes with the right language (currently expected to fail: P2) |
| E5 | Re-render after editing one scene's text, then after replacing a screenshot | exactly one scene re-renders in each case |
| E6 | `localize` en→es → render | the source project is untouched and assets/voice are not copied |
| E7 | Kill the server mid-final-render, restart, re-render | the lock is recovered, no orphans remain, and the output is identical to a clean render (lock hash) |
| E8 | Brand with a logo overlay, both renderers | logo in the right corner and absent from covers, per brand rules |

## 5. Verdict
The unit and integration coverage is **broad and real**: it uses real ffmpeg rather than mocks and does not rely on snapshots of internals. The type discipline removes whole bug classes. The weaknesses are that (a) negative and adversarial inputs are thin, which is exactly where 13-negative found the silent-wrong-result bugs, (b) the external binaries that shape quality (Chrome, `say`, whisper) are untested in routine runs, and (c) nothing enforces running the checks, because there is no CI and the hook is not installed.

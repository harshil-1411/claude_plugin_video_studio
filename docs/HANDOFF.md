# Handoff: video-studio (2026-09-25)

**Git:** branch `master`, no remote. Latest commits:
- `3ce0b90` Phase 4 step 2: platform contracts, zones, lint, captions, fonts, covers
- `111aa77` Phase 4: shared interfaces for step 2 (layout zones, text boxes, caption position)
- `72aa29c` Phase 4 step 1: master/targets/cover/publish, Brand v2, platform contracts

The tree is clean except `vector-dbs-explainer/`, which is untracked on purpose: it is the Phase 3 exit-check output, kept as a sample.

Read this together with `.claude/CLAUDE.md` (architecture rules and commands) and `docs/PLAN.md` (the roadmap, including M1–M9). This file covers only the current state and the next steps.

## Where things stand

| Phase | State | Verified |
|---|---|---|
| 0 Foundation | Done: pnpm/TS monorepo, zod schemas → `schemas/*.json`, core (cache, SQLite ledger, job runner), MCP server bundled to `dist/mcp.mjs` | tests, `plugin validate --strict` |
| 1 Ingestion | Done: text/markdown/URL/PDF/DOCX/PPTX/repo → ContentIR, secret scanning, 10 golden fixtures | golden snapshots |
| 2 Planning | Done: 5 templates, `plan`/`create` skills, `brief_validate`, strict-grounding `spec_validate`, `storyboard_render` | `examples/readme-plan` end to end |
| 3 Local render | Done: voice (`say`/silent/ElevenLabs), FFmpeg + HyperFrames renderers, captions, assembly, QA, `dist/` export, job tools | User's machine: `/video-studio:create "Explain vector DBs in 30s"` → `vector-dbs-explainer/dist/reel.mp4` |
| 4 Platform compiler | **Steps 1–2 done.** Step 3 next | tests, smoke, visual check |

- **Tests:** 456 pass, 2 skipped. The skipped ones are env-gated (`VS_TEST_SAY=1`, `VS_TEST_RENDER=1`) and must run outside the sandbox.
- **Smoke:** `node scripts/smoke-mcp.mjs` passes: 15 tools, ingest, templates, and a tiny render.
- **MCP tools (15):** doctor, project_init, ingest, schema_get, template_list, template_get, spec_scaffold, brief_validate, spec_validate, storyboard_render, render_submit, job_status, qa_run, export, **lint**.
- **Skills:** create, plan, ingest, validate, render, qa, export, doctor, **lint**.
- **Agents:** source-researcher, creative-director.

## What Phase 4 has built so far

**Spec and brand (step 1)**
- **`VideoSpec`:**
  - `master {width, height, fps: 24|30|60}`. Omitted: `resolveMaster()` gives 1080 px on the short side at 30 fps. Final renders use it; preview renders at half size.
  - `targets[]` of platform contract ids. Omitted: `resolveTargets()` gives `PRIMARY_TARGET[platform]` (`instagram_reels`→`instagram`, `tiktok`→`tiktok`, `youtube_shorts`→`youtube-shorts`, `linkedin`→`linkedin`; `youtube`, `x` and `generic` get none).
  - `cover {headline, focal_time_sec}`.
  - `publish.<target> {post_caption, hashtags[], ai_disclosure}`.
  - `captions.position {y}`: manual placement, the golden lint case.
  - The brief has optional `targets`.
  - The plan skill documents the four separate text channels: voiceover, on-screen text, cover headline and post copy.
- **Brand v2:** `visual.weights`, `visual.font_fallbacks`, `visual.logo_placement`, `visual.forbidden`, `captions {family, weight, active_word, plate_opacity, max_lines}`, `motion {personality, transition_ms}` and `voice.banned_phrases`. v1 files stay valid.
  - **Used so far:** `font_fallbacks`, `captions.*` and `banned_phrases` (checked by lint).
  - **Not used yet:** `motion` and `weights` (Phase 5), `logo_placement`, and `forbidden`.
- **`spec_scaffold`** takes `targets` and emits `master` and `targets`. **`spec_validate`** checks targets against the registry (stage `platform`).

**Platforms (steps 1–2)**
- **`platform-specs/*.yaml`:** instagram, tiktok, youtube-shorts, linkedin, facebook-page-api. Each validates against `schemas/platform-contract.schema.json` (zod source: `packages/schema/src/platform-contract.ts`).
  - Instagram, Facebook Page API, LinkedIn and YouTube Shorts were re-verified against first-party pages on 2026-09-25.
  - **TikTok was not re-verified** (developers.tiktok.com returned 503). Its values come from `deep-research-report_v2.md`, and its notes say so.
  - The UI masks are approximations of each app's UI, not official safe zones.
- **`packages/platforms`:**
  - registry (`findPlatformSpecsDir`, `loadContracts`, `getContract`, `checkSpecTargets`)
  - geometry (`toPx`, `intersect`, `masksFor`, `maskCollisions`)
  - `layoutZones(target, contracts)` returns `content`, `caption` and `hook` rects, shrunk away from error masks (`ZONES_VERSION = 2`).
- **Renderers:** both lay out inside `zones.content` (`safeArea(target, zones?)`, `LAYOUT_VERSION = 3`). They return `text_boxes` (role, rect, font_px, truncated, colours), which flow through the scene sidecar into the manifest `renders[].text_boxes`. `zones` is part of the scene cache key.

**Captions, fonts, covers (step 2)**
- **Caption engine** (`packages/media/src/captions.ts`):
  - phrases of 3–7 words on at most 2 rows (brand `max_lines`), with punctuation-aware breaks
  - a plate behind each row (default opacity 0.55) and keyword emphasis; karaoke only with `active_word: true`
  - placed in `zones.caption`, or centred on `captions.position.y`
  - the manifest records `captions.box` and `max_lines`
- **Fonts:** `fonts/` holds Inter 4.1, Noto Sans 2.015 and JetBrains Mono 2.304 (Regular and Bold, OFL, 2.5 MB; source URLs and sha256 in `fonts/README.md`).
  - `resolveFontFile(family, …, weight)` prefers the bundled files.
  - `fontFaceCss()` feeds HyperFrames, which copies the files in as `assets/fonts/*`.
  - libass gets the fonts through `fontsdir`.
  - FFmpeg headings use weight 700 (`FFMPEG_RENDERER_VERSION` 0.2.0).
- **Cover compiler** (`packages/mcp/src/cover.ts`, `COVER_VERSION = 2`): with `spec.cover`, it writes `cover.jpg` and `cover-square-preview.jpg`. The frame at `focal_time_sec` is blurred and dimmed, and the headline sits on an opaque plate where the hook zone overlaps every crop.
  - The files go to `renders/<q>/`, and export copies them to `dist/`.
  - The manifest records `cover {path, square_preview, at_ms, headline_box, crops}`.
  - Without a cover, the old thumbnail at the hook midpoint is kept.
- **Lint** (`packages/mcp/src/lint.ts`, tool and skill `lint`) writes `qa/lint.json` and `qa/lint.md`. It checks:
  - platform envelopes and text overflow
  - text or captions under masks (golden fixture: `packages/mcp/src/__fixtures__/lint/tiktok-low-captions`)
  - WCAG contrast and reading density (> 3.3 words/s)
  - post-copy limits
  - the cover headline against every crop
  - brand banned phrases

  It reads `renders/<q>/render-state.json`, and `dist/render-manifest.json` only when the qualities match.
- **Visual check** (a copy of `vector-dbs-explainer` with 3 targets, 540×960, silent voice + FFmpeg): captions sit on plates above the bottom UI with emphasis, headings are bold Inter, and the cover is clean inside the square crop. Lint passes for instagram, tiktok and youtube-shorts.

## Next: Phase 4 step 3 (all local, no keys)

Suggested as one agent or the coordinator alone, because it all runs through `packages/mcp/src/pipeline.ts` export:
1. **Per-platform dist (M7):** `dist/<target>/{video.mp4, cover.jpg, captions.srt, captions.vtt, post.json, qa.json}`, plus top-level `video-spec.json`, `video.lock`, `provenance.json` and `storyboard.md`.
   - `post.json` comes from `publish.<target>` and replaces `social-copy.md`; keep `social-copy.md` for a transition period.
   - `qa.json` is the lint findings filtered to that target.
   - Re-mux or copy by default; transcode only where a contract envelope differs (fps, size, bitrate).
   - The manifest lists outputs per target (it may need a `target` field on `FinalOutput`: a schema change the coordinator makes first).
2. **`video.lock`:** renderer, ffmpeg, voice and font versions (the sha256 values in `fonts/README.md`), each target contract's `contract_version` and `verified` date, and asset hashes. Built from `render-manifest.json` and the scene sidecars. A diff classifies changes as creative, renderer, spec, asset or metadata.
3. **Tools and skills:**
   - `verify`: a claim-coverage report reusing `validateVideoSpecSemantics`.
   - `test`: golden frames per example, sampled and perceptually diffed.
   - `diff`: a spec diff plus a frame diff between two renders.
4. **CI:** a GitHub Action that renders the examples with the silent voice and FFmpeg, runs lint and golden frames, and uploads artifacts. No paid keys.
5. **Phase 4 exit (the user runs this, outside the sandbox):** `claude --plugin-dir .` → `/video-studio:create README.md` with targets instagram, tiktok and youtube-shorts should produce three packages. A caption deliberately placed under the TikTok mask must be caught by lint, the fix loop must clear it, and the CI golden test must pass.

Then Phase 5 (reel grammar, archetypes, style packs, variants; see `docs/PLAN.md`).

## Environment facts that shape everything

- **No provider keys** (ElevenLabs, Runway, HeyGen, fal). The user declined large model downloads (Kokoro, whisper models), so any download must be asked for first. The bundled fonts were part of the planned M8.
- **Low-RAM laptop.** Run at most 2 agents at once, and check `memory_pressure | tail -1` and `uptime` before spawning. Use tiny media in tests: ≤ 320 px, ≤ 3 s, 15 fps. Never run two renders at once.
- **The Claude Code Bash sandbox blocks:**
  - macOS `say` (it writes an empty file)
  - headless Chrome
  - pnpm installs of packages that contain `.gitmodules` (give the user a `!` command)
  - `pnpm install` in general, so new workspace packages get hand-made symlinks in `packages/*/node_modules/@video-studio/`; `pnpm install` recreates them
  - writes to the Claude memory dir via Bash (use Edit/Write)
  - writes to `~/.video-studio`: the dev CLI `scripts/render-project.mjs` then prints `ledger write failed … readonly database`. It is harmless and the render succeeds.
- **Rendering in the sandbox:** use `--voice silent --renderer ffmpeg`. The plugin's MCP server runs outside the sandbox for the user, so `say` and Chrome work there.
- **Chrome on macOS:** plain `chrome --headless --dump-dom` hangs for 45 s or more. The HyperFrames probe launches Chrome through the producer's `puppeteer-core` instead (about 0.6 s). The diagnostic is `node scripts/diagnose-chrome.mjs`.
- **HyperFrames:** never bundled. It is installed at `~/.video-studio/deps` (dev) or `${CLAUDE_PLUGIN_DATA}/deps` (plugin) with `PUPPETEER_SKIP_DOWNLOAD=1 npm i @hyperframes/producer@0.8.75 --prefix deps`.
- **Duplicate "engine" MCP server:** the repo root is also the plugin root. `plugin:video-studio:engine` works. The project-scope `engine` fails with CONNECTION_CLOSED and is harmless; keep it in `disabledMcpjsonServers` in `.claude/settings.local.json`.
- **pnpm:** the store is pinned in the repo (`storeDir: .pnpm-store`) so sandboxed and unsandboxed installs agree.

## Open issues

1. **TikTok contract not re-verified.** Re-check `platform-specs/tiktok.yaml` against developers.tiktok.com and bump `contract_version`/`verified`.
2. **Deprecated caption helpers.** `captionReserveFraction` and `defaultMarginV` in `packages/media/src/captions.ts` are no longer used by the renderer; remove them.
3. **Brand v2 fields not used yet:** `motion` and `weights` (Phase 5 motion work), `logo_placement`, and `forbidden` (no lint check yet).
4. **HyperFrames 404.** HyperFrames logs a non-blocking 404 for one resource, probably a favicon or font lookup. Re-check now that fonts are embedded.
5. **QA noise in silent mode.** Silent-voice renders report `silence`/`loudness` warnings in `qa/report.md`; they are labelled "expected" only in `job_status`.
6. **No render lock.** There is no cross-process lock, so two Claude sessions could render at the same time.
7. **Scenes open empty.** Scenes fade in from an empty first frame (Phase 5 motion work).
8. **Spec vs. actual timing.** The render plan lengthens scenes to fit the voiceover and records `timing_adjustments`; the spec is left unchanged by design.
9. **Stale lockfile entries.** `pnpm-lock.yaml` has 2 orphan `@secretlint/node` entries, and it doesn't yet list `@video-studio/platforms`. Run `pnpm install` outside the sandbox and commit the lockfile.
10. **Warnings.** Node prints an `ExperimentalWarning` for `node:sqlite`. It is harmless.

## How work is run

- **Coordinator + at most 2 `general-purpose` agents.** Each agent gets exact file ownership (no two edit the same file), "no `pnpm install`", targeted tests only, and a short final report. The coordinator writes and commits any shared interface (schema, types, stubs) before agents start. Agents never commit.
- **After agents finish:** `npx tsc -b`, the full `npx vitest run`, rebuild the bundle (`cd packages/mcp && ../../node_modules/.bin/tsdown`), `node scripts/smoke-mcp.mjs`, `claude plugin validate --strict .claude-plugin/plugin.json` and `claude plugin validate --strict .`, then commit.
- **Visual checks:** render a copy of a project in the scratchpad (`node scripts/render-project.mjs <dir> --voice silent --renderer ffmpeg --quality preview`), extract frames (`ffmpeg -ss T -i dist/reel.mp4 -frames:v 1 x.png`) and look at them. This is how the cover-headline overlap was found in step 2.
- **Regenerate schemas** after any zod change: `npx tsc -b && node packages/schema/dist/emit.js` (a test fails if they are stale).

## Commands the user runs outside the sandbox

```
pnpm install && git add pnpm-lock.yaml                                                                  # refresh the lockfile (issue 9)
node scripts/render-project.mjs examples/text-to-motion-graphic --voice system --renderer hyperframes   # real voice + HyperFrames
VS_TEST_SAY=1 npx vitest run packages/voice/src/system.test.ts
VS_TEST_RENDER=1 npx vitest run packages/renderer/src/hyperframes
node scripts/diagnose-chrome.mjs
claude --plugin-dir .    # then /video-studio:doctor, /video-studio:create ..., /video-studio:lint
```

## Document map

- `docs/PLAN.md`: the roadmap, including the gap analysis and M1–M9.
- `.claude/CLAUDE.md`: rules and commands for Claude sessions.
- `deep-research-report_v2.md`: v2 strategy (platform compiler, lint, grammar).
- `deep-research-report.md`: v1 strategy (provider-neutral compiler).
- `reports/Video studio implementation specs.md`: verified API and plugin facts. Where they conflict, it overrides v1.
- `platform-specs/README.md`: contract rules. `fonts/README.md`: font sources and hashes.
- `packages/renderer/README.md`: the two renderers and their gated tests.

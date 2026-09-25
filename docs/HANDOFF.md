# Handoff: video-studio (2026-09-25)

**Git:** repo initialized on `master`. Initial commit `aa729d5`, "Phases 0–3: ingest, plan, local render pipeline" (241 files, clean tree). No remote yet.

Read with `.claude/CLAUDE.md` (architecture rules and commands) and `docs/PLAN.md` (the roadmap, revised local-first after `deep-research-report_v2.md`). This file covers only the current state and the next steps.

## Where things stand

Phases 0–3 are built. A planned project renders to a finished, captioned 9:16 MP4 using only local tools.

| Phase | State | Verified |
|---|---|---|
| 0 Foundation | Done: pnpm/TS7 monorepo, zod schemas → `schemas/*.json`, core (cache, SQLite ledger, job runner), MCP server bundled to `dist/mcp.mjs` | tests, `claude plugin validate --strict` |
| 1 Ingestion | Done: text/markdown/URL/PDF/DOCX/PPTX/repo → ContentIR, secret scanning, 10 golden fixtures | tests (golden snapshots) |
| 2 Planning | Done: 5 templates, `plan`/`create` skills, `brief_validate`, strict-grounding `spec_validate`, `storyboard_render` | tests incl. `examples/readme-plan` end to end |
| 3 Local render | Done: voice (`say`/silent/ElevenLabs), FFmpeg + HyperFrames renderers, captions, assembly, QA, `dist/` export, job tools | Sandbox: silent + FFmpeg. **User's machine: `say` + HyperFrames render `examples/text-to-motion-graphic` end to end.** |

- **Tests:** 391 pass, 2 skipped. The skipped ones are env-gated: `VS_TEST_SAY=1` and `VS_TEST_RENDER=1`, which must be run outside the sandbox.
- **Smoke:** `pnpm smoke` passes, including a tiny render through the bundle.
- **MCP tools (14):** doctor, project_init, ingest, schema_get, template_list, template_get, spec_scaffold, brief_validate, spec_validate, storyboard_render, render_submit, job_status, qa_run, export.
- **Skills:** create, plan, ingest, validate, render, qa, export, doctor.
- **Agents:** source-researcher, creative-director.

**Phase 3 exit check:** the plugin loads in Claude Code, and its tools resolve as `mcp__plugin_video-studio_engine__*`. Still to confirm: a full interactive `/video-studio:create "Explain vector DBs in 30s"` run ending in `dist/reel.mp4`.

## Environment facts that shape everything

- **No provider keys.** No ElevenLabs, Runway, HeyGen or fal. The user also declined large model downloads (Kokoro, whisper models), so any download must be asked for first.
- **Low-RAM laptop.** Run at most 2 agents at once, and check `memory_pressure` and `uptime` before spawning. Use tiny media in tests: ≤ 320 px, ≤ 3 s, 15 fps. Never run two renders at once.
- **The Claude Code Bash sandbox blocks:**
  - `git init` (there is **no git repo yet**; the user should run `! git init`)
  - macOS `say` (it writes an empty file)
  - headless Chrome
  - pnpm installs of packages that contain `.gitmodules` (give the user a `!` command)
  - writes to the Claude memory dir via Bash (use the Edit/Write tools)
- **The plugin's MCP server runs outside the sandbox** for the user, so `say` and Chrome work there.
- **Chrome on macOS:** plain `chrome --headless --dump-dom` hangs for 45 s or more (the updater keeps it alive). The HyperFrames probe therefore launches Chrome through the producer's own `puppeteer-core`, which takes about 0.6 s (`puppeteerLaunchProbe` in `packages/renderer/src/hyperframes-renderer.ts`). The diagnostic is `node scripts/diagnose-chrome.mjs`.
- **HyperFrames install:** it is never bundled. It is installed at `~/.video-studio/deps` for dev runs, or at `${CLAUDE_PLUGIN_DATA}/deps` for the plugin: `PUPPETEER_SKIP_DOWNLOAD=1 npm i @hyperframes/producer@0.8.75 --prefix deps`. It uses the system Chrome.
- **Duplicate "engine" MCP server:** the repo root is also the plugin root, so Claude Code loads `.mcp.json` twice.
  - The plugin copy, `plugin:video-studio:engine`, works.
  - The project-scope copy, `engine`, fails with CONNECTION_CLOSED because `${CLAUDE_PLUGIN_ROOT}` isn't substituted.
  - That notice is harmless. Keep `engine` in `disabledMcpjsonServers` in `.claude/settings.local.json`.
  - Debug logs are in `~/.claude-msbector/debug/`.
- **pnpm:** the store is pinned inside the repo (`storeDir: .pnpm-store` in `pnpm-workspace.yaml`) so sandboxed and unsandboxed installs agree. Some `node_modules/@video-studio/*` workspace symlinks were created by hand while installs were blocked; `pnpm install` recreates them.

## Open issues (small)

1. **Unexplained warning.** HyperFrames logs a non-blocking 404 for one resource, probably a favicon or font lookup. Revisit when fonts are bundled (Phase 4, M8).
2. **QA noise in silent mode.** Silent-voice renders still report `silence`/`loudness` warnings in `qa/report.md`. They are labelled "expected" only in `job_status`.
3. **No render lock.** There is no cross-process lock, so two Claude sessions could render at the same time.
4. **Scenes open empty.** Scenes fade in from an empty first frame. Start them partly visible (Phase 5 motion work).
5. **Spec vs. actual timing.** The example's scenes s05 and s06 get lengthened in the render plan to fit the `say` voiceover. The spec is left unchanged by design; the manifest records `timing_adjustments`.
6. **Stale lockfile entries.** `pnpm-lock.yaml` contains 2 orphan `@secretlint/node` entries. They are harmless.
7. **Duplicate MCP notice.** The project-scope `engine` fails as described above. Candidate fix for Phase 4: have the doctor and docs explain it, or give `.mcp.json` a path that also works without `${CLAUDE_PLUGIN_ROOT}`.
8. **SQLite warning.** Node prints an `ExperimentalWarning` for `node:sqlite`. It is harmless.

## Next: Phase 4, the platform compiler (all local, no keys)

The full spec is in `docs/PLAN.md` (items M1–M9 plus lint/verify/test/`video.lock`). M9, the Chrome probe fix, is already done.

Dependency order:
1. **Coordinator, sequential and small.** These are schema changes that everything else builds on:
   - **M1:** `VideoSpec` gains `master {width,height,fps}` (default 1080×1920@30) and `targets[]` (platform ids). Keep `platform`/`aspect_ratio` as the primary target for back-compat.
   - **M2:** add `cover {headline, focal_time_sec}` and `publish.<platform> {post_caption, hashtags[], ai_disclosure}`.
   - **M4:** Brand v2 fields (captions, motion, logo placement, forbidden, banned_phrases). Back-compatible.
   - Scaffold `packages/platforms` and the contract YAML format (source URL, verified date, envelopes, cover spec, caption limits, UI masks as normalized rects).
   - Re-emit schemas and update `spec_scaffold` and the plan skill references.
2. **Two agents in parallel:**
   - **A:** `platform-specs/*.yaml` for instagram, tiktok, youtube-shorts, linkedin and facebook-page-api. Use the numbers in `deep-research-report_v2.md` §Platform contracts, re-verified where possible. Also: safe area = design grid ∩ masks, replacing `SAFE_MARGINS` + `captionReserveFraction` in `packages/renderer/src/text-layout.ts` and bumping `LAYOUT_VERSION` to 3; and a `lint` tool + skill (envelopes, overflow via `fitText().truncated`, mask collisions, WCAG contrast, reading density, cover crops).
   - **B:** the caption engine (M5: phrase-level, max 2 lines, plate, keyword emphasis by default, karaoke only if `brand.captions.active_word`); bundled OFL fonts in `fonts/` (M8: Inter, Noto Sans, JetBrains Mono) wired into both renderers and libass `fontsdir`; the cover compiler (M6).
3. **One agent after both:** per-platform `dist/<target>/` (M7), `video.lock`, `verify`/`test`/`diff` tools + skills, golden-frame regression, and a GitHub Action.

**Phase 4 exit:** `/video-studio:create README.md` with targets instagram, tiktok and youtube-shorts yields three packages. Lint catches a caption under the TikTok UI mask, the fix loop clears it, and the CI golden test passes.

## How work has been run

- **Agents:** the coordinator spawns `general-purpose` agents with exact file ownership (no two agents edit the same files), fixed tool names and contracts, "no `pnpm install`", and targeted tests.
- **Before an agent starts:** the coordinator writes any shared interface (types, schema) first.
- **After each agent:** the coordinator re-runs `npx tsc -b`, the full `npx vitest run`, `node scripts/smoke-mcp.mjs` and `claude plugin validate --strict .claude-plugin/plugin.json`, and rebuilds `dist/mcp.mjs` (`cd packages/mcp && npx tsdown`).
- **Visual checks:** extract frames from rendered MP4s (`ffmpeg -ss T -i reel.mp4 -frames:v 1 x.png`) and look at them. This is how the caption/diagram overlap bug was found.

## Commands the user runs outside the sandbox

```
node scripts/render-project.mjs examples/text-to-motion-graphic --voice system --renderer hyperframes   # real voice + HyperFrames
VS_TEST_SAY=1 npx vitest run packages/voice/src/system.test.ts
VS_TEST_RENDER=1 npx vitest run packages/renderer/src/hyperframes
node scripts/diagnose-chrome.mjs
claude --plugin-dir .    # then /video-studio:doctor, /video-studio:create ...
```

## Document map

- `deep-research-report.md`: v1 strategy (provider-neutral compiler).
- `deep-research-report_v2.md`: v2 strategy (platform compiler, lint, grammar).
- `reports/Video studio implementation specs.md`: verified API and plugin facts. Where they conflict, it overrides v1.
- `docs/PLAN.md`: the roadmap, including the gap analysis and M1–M9.
- `.claude/CLAUDE.md`: rules and commands for Claude sessions.
- `packages/renderer/README.md`: the two renderers and their gated tests.

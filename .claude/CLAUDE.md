# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Planning documents:
- `docs/HANDOFF.md`: **start here.** Current state, environment limits, open issues, and the exact next steps.
- `docs/PLAN.md`: the roadmap (solo developer + Claude), revised local-first after `deep-research-report_v2.md`. Work proceeds phase by phase, and each phase has explicit exit criteria.
- `deep-research-report_v2.md`: v2 strategy (platform compiler, lint, reel grammar).
- `reports/Video studio implementation specs.md`: verified implementation facts as of 2026-09-25 (plugin format, providers, renderers, libraries). **Where the two conflict, this report overrides `deep-research-report.md`.**
- `deep-research-report.md`: the original product strategy.
- `research_notes/`: the raw research behind the report.

Phases 0–2 are done: ingestion → ContentIR, then planning (templates in `templates/`, `plan`/`create` skills, brief and spec validation, storyboard). Phase 3 (local render) is wired end to end: `packages/mcp/src/pipeline.ts` (`renderProject`: validate → voice → scene clips → captions → assemble → thumbnail → QA → `dist/`, every stage cached), background jobs in `render-jobs.ts` (one render at a time, mirrored to the ledger), MCP tools `render_submit`/`job_status`/`qa_run`/`export`, skills `render`/`qa`/`export`, and `examples/text-to-motion-graphic/`. Fallbacks are reported, never silent: voice auto → elevenlabs → system → silent (also when synthesis fails), renderer auto → HyperFrames → ffmpeg. HyperFrames is resolved at runtime from `${CLAUDE_PLUGIN_DATA}/deps/node_modules` or the plugin root (`packages/mcp/src/hyperframes.ts`); it is never bundled or auto-installed. Phase 3 is verified outside the sandbox: `say` voice + HyperFrames render the example end to end (the Chrome probe launches through the producer's own puppeteer-core; plain `chrome --headless --dump-dom` hangs 45 s+ on macOS). The interactive `/video-studio:create` exit check passed (`vector-dbs-explainer/`). **Phase 4 steps 1–2 are done** (spec `master`/`targets`/`cover`/`publish`, Brand v2, `platform-specs/*.yaml` + `packages/platforms` zones, `lint` tool, caption engine, bundled `fonts/`, cover compiler); Phase 4 step 3 is done except CI, which is deferred: per-platform `dist/<target>/` packages (`targets.ts`), `dist/video.lock` (`lock.ts`), and the `verify`/`test`/`diff` tools (golden frames in `<project>/golden/`; example goldens gated by `VS_TEST_GOLDEN=1`); **Phases 4 and 5 are done** (exits passed 2026-09-25): per-platform packages, lock, verify/test/diff, 15 scene kinds, `styles/`, `music/` beds, `voice.mode: none`, 13 templates, `variants`/`adapt`. **Phase 6 is done**: footage ingest, whisper `transcribe`, `analyze`, `shorts`, the footage renderer, scene audio, beat sync, native voice and `demo` capture. **Phase 8 (local subset) is done**: script fonts and layout, `localize`, sound-event captions, C2PA signing, contributor docs. Version 0.2.0 (2026-09-26) closes the forensic audit (`audit/`): P0–P2 fixed, plus footage features (video URLs via yt-dlp, multilingual ASR + speaker turns, `footage_look`/`footage_focus` reframing, footage QA), engine-enforced policy/spend/consent (MCP elicitation), `render_cancel`, compact tool outputs, parallel scene renders. Next (the user's call): the user checklist, real reels, then Phase 7 (ElevenLabs) or Phase 9. See "Start here" in `docs/HANDOFF.md`; paid providers moved to Phase 7. See `docs/PLAN.md` (revised after `deep-research-report_v2.md`). This file lives in `.claude/CLAUDE.md` because the repo root is also the plugin root, and `claude plugin validate --strict` rejects a root `CLAUDE.md`.

## Commands

- `pnpm check` runs every check before a push (typecheck, tests, bundle + stale-bundle check, smoke, both plugin validations, golden frames; `--quick` = typecheck + tests); `pnpm hooks` makes it the pre-push hook (the user runs it: the sandbox can't write `.git/config`).
- `pnpm install`, `pnpm typecheck` (`tsc -b`), `pnpm test` (vitest; on a busy machine run one package: `npx vitest run packages/mcp`).
- `pnpm schemas`: regenerate `schemas/*.schema.json` from zod.
- `pnpm bundle`: build the engine into `dist/mcp.mjs` (committed; the plugin runs it). If pnpm tries to reinstall first (offline/sandbox), run `npx tsc -b && cd packages/mcp && ../../node_modules/.bin/tsdown`. `pnpm smoke` spawns it, checks the tool list and runs `ingest` on local fixtures.
- `node scripts/render-project.mjs <project> [--voice silent|system|auto] [--renderer ffmpeg|hyperframes|auto] [--quality preview|final]` renders a project through the bundle (e.g. `examples/text-to-motion-graphic`). Inside the sandbox neither `say` nor headless Chrome works: use `--voice silent --renderer ffmpeg`. Render tests use ≤ 320 px, ≤ 3 s, 15 fps, x264 ultrafast; never run two renders at once.
- Golden ingest snapshots: `npx vitest run tests/golden` (update with `-u` after an intentional extractor change, and bump that extractor's `version` so caches invalidate).
- `claude plugin validate --strict .claude-plugin/plugin.json` (plugin, incl. skills) and `claude plugin validate --strict .` (marketplace).
- `claude --plugin-dir .` loads the plugin locally; `/video-studio:doctor` runs the doctor.

## What is being built

**video-studio**: a Claude Code plugin that works as a provider-neutral "knowledge-to-video compiler". It turns text, URLs, documents, repos or existing reels into a finished, reproducible package (MP4, clean master, captions, thumbnail, social copy, manifest, provenance).

Pipeline: `ingest → ContentIR → CreativeBrief → VideoSpec → route → assets → FFmpeg assemble → QA → dist/`.

## Architectural rules

- **The engine is a bundled stdio MCP server** (`dist/mcp.mjs`, declared in `.mcp.json`), **not a `bin/` CLI**. claude.ai and Cowork reject plugins that have a top-level `bin/`. `userConfig` secrets (`sensitive: true`) only reach the MCP server's `env` through `${user_config.KEY}`, never Bash. The dev/CI CLI lives in `scripts/` and reads standard env vars.
- **Claude is the creative engine.** Skills instruct the host session to write the brief and spec. The MCP server validates, persists, routes, renders and runs QA. The plugin needs no LLM API key.
- **Three canonical objects are the contract between stages:**
  - `ContentIR`: source material plus `source_ref` provenance.
  - `VideoSpec`: a provider-independent scene graph that declares capability requirements, never model names.
  - `RenderManifest`: exactly what happened.

  All are defined in zod v4 in `packages/schema`, with generated `schemas/*.schema.json`.
- **State:** durable project artifacts live in the user's project folder. The SQLite ledger (`node:sqlite`), cache and lazily installed dependencies live in `${CLAUDE_PLUGIN_DATA}`, which is deleted on uninstall, so a project must never depend on it. Never write to `${CLAUDE_PLUGIN_ROOT}`.
- **Providers** implement `VideoProviderAdapter` (`capabilities / estimate / validate / submit / status / download / cancel?`) and must pass the mock conformance suite. Download outputs as soon as a job succeeds, because provider URLs expire (Runway 24–48 h). Persist task IDs immediately. Submissions are idempotent, keyed on the scene hash.
- **Rendering:** HyperFrames is the default for deterministic scenes. Pin its exact version behind the `Renderer` interface, because it is pre-1.0 and changes fast. Remotion is opt-in only, because of its license.
- **FFmpeg:** use the system `ffmpeg`/`ffprobe` first. `ffmpeg-static` is GPL-3.0 and only an opt-in fallback. `doctor` checks the build for libass and libx264.
- **Providers in scope:** Runway (Model Router `dryRun` for estimates), HeyGen **v3 only** (v1/v2 retire 2026-10-31), ElevenLabs (character alignment grouped into words), fal.ai for Kling/Veo/Hailuo (all Phase 7), macOS `say`/espeak-ng for local TTS, and whisper.cpp for local ASR. Model downloads (Kokoro, whisper models) are opt-in only: ask the user first. **Never add Sora**: its API was removed 2026-09-24.
- **Safety:** ingested content is untrusted data. Never execute code from ingested repos or pages. Repo demo capture (Phase 6) records an app the **user** started and gave a URL for; the plugin never starts it. The repo extractor uses only repomix's `searchFiles` with an in-memory config (never `loadFileConfig`/CLI, which evaluate `repomix.config.*` via jiti) and `@secretlint/core` with the preset passed in memory (never `@secretlint/node`'s config/rule loading). The bundle aliases `repomix` to its file-search module (see `packages/mcp/tsdown.config.ts`). Spend limits, policy and consent are enforced in engine code; hooks are advisory only, because managed settings can disable them.
- **Platform facts are data:** platform limits, safe-zone masks and cover specs live in versioned `platform-specs/*.yaml` with a source URL and verified date, never as numbers in skill prose or code.
- **Skill portability:** core skills use only the portable frontmatter fields (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`). Spend-incurring skills set `disable-model-invocation: true`.

## Planned tooling

- Build: pnpm workspaces, TypeScript, vitest, and tsdown (not tsup, which is unmaintained) producing a single-file ESM bundle. Requires Node >= 22.13. Apache-2.0.
- Checks: `claude plugin validate --strict` on both the plugin dir and the marketplace root.
- Local testing: `claude --plugin-dir .`.
- `examples/` and tests must run without paid API keys, using mock providers. There is no CI (the user removed it); run the checks locally before committing.

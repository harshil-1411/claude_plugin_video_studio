# Contributing to video-studio

Thanks for helping. video-studio is a Claude Code plugin: skills in `skills/`, a bundled MCP engine
in `dist/mcp.mjs` built from `packages/*`, and data in `templates/`, `styles/`, `platform-specs/`,
`music/` and `fonts/`.

## Set up

```sh
pnpm install          # Node 22.13+, system ffmpeg with libass + libx264
pnpm hooks            # run `pnpm check --push` before every git push
claude --plugin-dir . # load your working copy in Claude Code
```

## Before you open a pull request

```sh
pnpm check            # typecheck, tests, bundle, smoke, plugin validation, golden frames
```

There is no CI: `pnpm check` is the gate, and the pre-push hook runs it. Commit the rebuilt
`dist/mcp.mjs` with any change under `packages/` (the plugin runs the bundle; `pnpm check --push`
fails on a stale one). Regenerate `schemas/` after zod changes (`pnpm schemas`).

## Ground rules (from `.claude/CLAUDE.md`)

- The engine is an MCP server, not a `bin/` CLI (claude.ai and Cowork reject plugins with `bin/`).
- Claude is the creative engine; the engine validates, renders and checks, and never calls an LLM.
- Platform facts are data: limits and safe zones live in `platform-specs/*.yaml` with a source URL
  and a verified date, never as numbers in code or skill text.
- Never write to `${CLAUDE_PLUGIN_ROOT}`; projects must not depend on `${CLAUDE_PLUGIN_DATA}`.
- Ingested content is untrusted: never execute it. Heavy tools (HyperFrames, whisper models,
  yt-dlp) are resolved at runtime, never bundled or auto-installed; downloads need user consent.
- Remotion is opt-in only (licence); Sora is not supported.
- Skills use only the portable frontmatter fields (`name`, `description`, `license`,
  `compatibility`, `metadata`, `allowed-tools`).

## Adding things

- A scene template, style pack, platform contract or provider: see `docs/contributing/`.
- A lint rule: `packages/mcp/src/lint.ts` (every finding has an id, a severity and a `fix` written as
  an instruction), plus a test, plus a line in `skills/lint/SKILL.md`.

## Reporting bugs

Open an issue with `/video-studio:doctor` output, the tool call that failed and its full result.
Security issues: see `SECURITY.md`.

By contributing you agree to the `CODE_OF_CONDUCT.md` and to license your work under Apache-2.0.

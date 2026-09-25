# video-studio

A Claude Code plugin that compiles knowledge into video. It turns text, URLs, documents or repos into a
finished, reproducible package: MP4, captions, thumbnail, social copy, manifest and provenance.
Claude writes the creative brief and scene spec. A bundled MCP server (`engine`) validates, persists,
routes, renders and runs QA. The plugin needs no LLM API key.

## Status: Phase 0 (foundation)

What works today:

- `/video-studio:doctor` checks Node (22.13+), `node:sqlite`, system ffmpeg/ffprobe (libass, libx264),
  Chrome, whisper.cpp, which provider keys are configured (presence only) and the data directory.
- `/video-studio:validate` validates a `video-spec.json` against the schema and semantic rules.
- MCP tools: `doctor`, `project_init`, `spec_validate`, `schema_get`.

Rendering, ingestion and providers come in later phases (see `docs/PLAN.md`).

## Install

Requires Node.js 22.13+ on `PATH` and, for rendering, a system FFmpeg built with libass and libx264
(macOS: `brew install ffmpeg`).

Local checkout:

```sh
claude --plugin-dir .
```

From the marketplace in this repo:

```
/plugin marketplace add <owner>/<repo>
/plugin install video-studio@video-studio-marketplace
```

Provider API keys (Runway, ElevenLabs, HeyGen, fal.ai, Kling) are optional. Set them in
`/plugin` → video-studio → Configure; they are stored in the OS credential store and passed only to
the MCP server's environment. Shell installs never prompt, so pass `--config KEY=VALUE` to
`claude plugin install` instead.

## Development

```sh
pnpm install
pnpm typecheck        # tsc -b
pnpm test             # vitest
pnpm schemas          # regenerate schemas/*.schema.json
pnpm bundle           # build dist/mcp.mjs (single-file ESM, committed)
pnpm smoke            # start dist/mcp.mjs over stdio and check its tool list
claude plugin validate --strict .claude-plugin/plugin.json   # plugin + skills
claude plugin validate --strict .                            # marketplace
```

Run the engine directly with `node dist/mcp.mjs`. It speaks MCP over stdio and logs to stderr.
After changing anything under `packages/`, rerun `pnpm bundle` and commit `dist/mcp.mjs`. CI fails
if the committed bundle or schemas are stale.

Layout: `packages/schema` (zod models, JSON Schemas), `packages/core` (project folders, cache,
SQLite ledger, jobs), `packages/mcp` (MCP server, bundled to `dist/mcp.mjs`), `skills/` (thin
SKILL.md files that call the MCP tools).

## License

Apache-2.0. See `LICENSE`.

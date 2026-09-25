# video-studio

A Claude Code plugin that compiles knowledge into video. It turns text, URLs, documents or repos into a
finished, reproducible package: MP4, captions, thumbnail, social copy, manifest and provenance.
Claude writes the creative brief and scene spec. A bundled MCP server (`engine`) validates, persists,
routes, renders and runs QA. The plugin needs no LLM API key.

## Status: Phase 3 (local render)

What works today, with local tools only (no keys needed):

- `/video-studio:create "Explain vector DBs in 30s"`: ingest → plan (brief, grounded spec, storyboard)
  → approval → local render (preview, then final) → QA → `dist/` export.
- `/video-studio:ingest`, `/video-studio:plan`, `/video-studio:validate`, `/video-studio:render`,
  `/video-studio:qa`, `/video-studio:export`, `/video-studio:doctor`.
- Rendering: voice from ElevenLabs (if a key is configured), system TTS (macOS `say`, `espeak-ng`) or
  silent; motion-graphic scenes drawn by HyperFrames (optional install, see the render skill) or
  ffmpeg; captions (SRT, VTT, burned-in ASS karaoke), loudness normalised to -14 LUFS, thumbnail,
  technical QA, render manifest and provenance.
- MCP tools: `doctor`, `project_init`, `ingest`, `template_list`, `template_get`, `spec_scaffold`,
  `brief_validate`, `spec_validate`, `storyboard_render`, `schema_get`, `render_submit`, `job_status`,
  `qa_run`, `export`.

Generative video providers (Runway, HeyGen, fal.ai) arrive in Phase 4 (see `docs/PLAN.md`); until
then such scenes render as placeholder cards. Example: `examples/text-to-motion-graphic/`.

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

# 02 — Plugin architecture

## 1. Discovery and loading by Claude Code

```
marketplace.json ──source "./"──▶ plugin root
                                   ├─ .claude-plugin/plugin.json   name, version, userConfig (5 secrets)
                                   ├─ skills/<name>/SKILL.md       21 skills → /video-studio:<name>, model-invocable
                                   ├─ agents/*.md                  2 subagents (Read/Grep/Glob only)
                                   └─ .mcp.json                    server "engine": node ${CLAUDE_PLUGIN_ROOT}/dist/mcp.mjs
                                                                   env ← ${user_config.*} (5 provider keys)
```

- **Manifest** (`.claude-plugin/plugin.json:1-46`) declares only metadata and `userConfig`. Skills, agents and the MCP server are found by convention (the `skills/`, `agents/` and `.mcp.json` locations). There is no `commands/` or `hooks/` directory.
- **MCP server:** `.mcp.json:3-12` launches the committed bundle with `node`. Secrets reach the engine only through `${user_config.KEY}` → env, as `.claude/CLAUDE.md` intends. The engine code acknowledges that an unset `${user_config.X}` "may arrive empty or as the literal placeholder" (`packages/media/src/ffmpeg.ts:37-42`). Only some readers apply that guard (see §5).
- **Tool names in skills** use `mcp__plugin_video-studio_engine__<tool>` (for example `skills/create/SKILL.md:6`). This matches Claude Code's `plugin_<plugin>_<server>` naming. The user's memory reports that `plugin:video-studio:engine` works. I did not verify it live.
- **Dual role of `.mcp.json`:** the repo root is also the plugin root, so opening Claude Code in this repo loads `.mcp.json` a second time as a project server. There, `${CLAUDE_PLUGIN_ROOT}` is not defined, so that copy fails. This is a development-only nuisance.

## 2. How users invoke it

| Path | Mechanism |
|---|---|
| `/video-studio:create` (and 20 other skills) | Slash invocation of a skill. Skills are also model-invocable from their `description` triggers, because none sets `disable-model-invocation` |
| Natural language ("make a reel from this README") | The model picks a skill by description (`skills/create/SKILL.md:3`) |
| Direct tool calls | Claude may call any of the 28 tools without a skill. Tools listed in a skill's `allowed-tools` are pre-approved while that skill is active; any other tool call goes through the normal permission prompt |
| Dev CLI | `scripts/render-project.mjs` (outside Claude) |

## 3. What Claude gets

- **Tools:** 28 MCP tools (`packages/mcp/src/server.ts:108-811`), with no resources or prompts. Each result is a text summary, a pretty-printed JSON copy and `structuredContent` (`server.ts:91-99`). See `07-mcp-tool-audit.md` for the size cost.
- **Context:** the skill body on invocation. Plan references load on demand (`skills/plan/SKILL.md:16-23`). Subagents run with Read/Grep/Glob only.
- **Files:** Claude writes `project/creative-brief.yaml`, `project/video-spec.json`, `project/variants.json`, `project/demo.json` and `project/translation.json` itself with Write/Edit. The engine validates them.
- **Images:** `review` writes contact sheets and strips that Claude then Reads. This is the only "vision" loop in the system (`server.ts:522-548`).

## 4. "Claude is the creative engine; the engine validates and renders"

| Rule aspect | Where it holds | Evidence |
|---|---|---|
| No LLM calls in the engine | No Anthropic/OpenAI SDK in any `package.json`. The only outbound calls are ElevenLabs, URL ingest and the model download | §8 of `01-repository-inventory.md` |
| The engine never writes the creative spec | `spec_scaffold` returns a skeleton and does **not** write it (`server.ts:282`, `readOnlyHint: true` at `:301`). Claude writes `video-spec.json` | `skills/plan/SKILL.md:121-203` |
| Validation is a hard gate before render | `render_submit` calls `loadValidSpec` and refuses on errors (`server.ts:379-390`). The pipeline re-validates (`pipeline.ts:434`, `366-374`) | enforced in code |
| Grounding of facts | Spec semantic checks: numbers without `claim_refs` are an error under `strict` (`server.ts:183`; `spec-validate.ts:42`). `verify` reports coverage | enforced in code, but `grounding: "loose"` or `"off"` relaxes it (see `skills/create/SKILL.md:38-45`) |
| No provider names in specs | `FORBIDDEN_PROVIDER_TERMS` (`packages/schema/src/video-spec.ts:513-530`) | enforced in code |
| Exceptions where the engine writes creative content | `shorts make_projects` writes complete talking-head specs (`packages/mcp/src/shorts.ts:276-352`). `variants`, `adapt` and `localize apply` derive specs mechanically (`variants.ts:52`, `adapt.ts:51-125`, `localize.ts:378+`). `export` writes a generated social-copy draft (`pipeline.ts:1506-1549`) | deterministic, not LLM, so the rule still holds in spirit |

## 5. Runtime lifecycle

```
Claude Code start ─▶ spawn `node dist/mcp.mjs` (stdio)            main.ts:9-13
                       │ createServer(): 28 tools; RenderJobManager is created lazily   server.ts:105-106
                       ▼
 render_submit ─▶ loadValidSpec (sync gate) ─▶ jobs.submit() → job_id returned at once  server.ts:378-404
                                                   │ ledger.createJob (best effort)       render-jobs.ts:99-101
                                                   ▼  promise chain `tail` = one render at a time per process   :102
                                          execute(): status=running → renderProject(...)   :106-146
                                                   │   acquireRenderLock(renders/.render.lock)  pipeline.ts:410
                                                   │   validate→voice→align→footage/music→timing→cues→scenes→captions→scene audio→assemble→cover→QA→export
                                                   ▼
                                          succeeded|failed → in-memory view + ledger row   render-jobs.ts:129-145
 job_status ─▶ in-memory view, else ledger row (after a restart: "interrupted" when non-terminal)   render-jobs.ts:148-172
```

- **Concurrency:** within one engine process, `RenderJobManager` serialises every render through a single promise chain (`render-jobs.ts:48,102`). Across processes, `acquireRenderLock` makes one render per *project* by creating `renders/.render.lock` with `wx`. A stale lock (dead pid on the same host, or older than 6 h) is taken over (`render-lock.ts:11,50-55,66-91`).
- **Not locked:** `export`, `qa_run`, `lint`, `review`, `test` and `diff` read `renders/<q>/` and rewrite `dist/` without taking the render lock (`pipeline.ts:1452-1477`). Running `export` while a render of the same project is in flight in another session can copy half-updated state.
- **Abort:** `RenderJobManager` owns an `AbortController`, and the pipeline passes its `signal` to ffmpeg (`render-jobs.ts:52,118`; `media/src/ffmpeg.ts:212-219`). Only `close()` aborts it (`render-jobs.ts:179-184`). `main.ts` never calls `close()` and installs no `SIGTERM`/stdin-end handler (`main.ts:1-19`; no `process.on` anywhere in `packages/*/src`). No MCP tool cancels a job either. In production, jobs cannot be cancelled, and killing the server leaves any in-flight ffmpeg child to the OS.
- **Ledger:** `node:sqlite` in WAL mode with a 5 s busy timeout (`ledger.ts:213-216`). If it cannot open, jobs are not persisted and a message goes to stderr (`render-jobs.ts:66-75`). The ledger stores only a *summary* of the result (`render-jobs.ts:132-137`), and that summary does not match the shape `formatJob` expects after a restart. **Bug:** `job_status` for a job that succeeded before a restart throws inside `formatJob` at `r.qa.findings.length` (`server.ts:78`), because `qa` is stored as a string (`render-jobs.ts:135`) and cast back as the full result (`render-jobs.ts:170`). The test only checks `manager.status()`, not the tool output (`pipeline.test.ts:551-553`).
- **Memory:** finished jobs, including the full `RenderProjectResult` with all warnings, stay in the `jobs` Map for the life of the process (`render-jobs.ts:46,130`). This is unbounded, though small in practice.

## 6. Package architecture

```
                         ┌──────────────────────── @video-studio/mcp ────────────────────────┐
                         │ server.ts (28 tools) · pipeline.ts · render-jobs.ts · render-lock │
                         │ lint · verify · review · compare · diff · golden · lock · targets │
                         │ cover · c2pa · analyze · transcribe · tighten · shorts · demo     │
                         │ localize · variants · adapt · plan · templates · doctor · music   │
                         └──┬──────────┬──────────┬───────────┬───────────┬──────────┬───────┘
                            │          │          │           │           │          │
                            ▼          ▼          ▼           ▼           ▼          ▼
                     ingestion     renderer     voice      platforms    media       core
                        │  │        │ │ │ │       │ │           │         │ │        │
                        │  └──▶ media ◀┘ │ │       │ └──▶ core   │         │ └──▶ core│
                        │         ▲      │ └──▶ platforms        │         │          │
                        └──▶ core │      └──▶ core                │         ▼          ▼
                                  │                               ▼       schema ◀── schema
                          (all depend on) ──────────────────▶  schema
 External at runtime: ffmpeg/ffprobe · whisper-cli · say/espeak-ng · Chrome + puppeteer-core + @hyperframes/producer (optional) · c2patool (optional)
```

Edges from `package.json`: ingestion → core, media, schema (`packages/ingestion/package.json:20-22`); renderer → core, schema, media, platforms, `@hyperframes/producer` (`packages/renderer/package.json:16-22`); voice → schema, core; media → schema, core; platforms → schema; core → schema; mcp → everything (`packages/mcp/package.json:11-21`). The graph is acyclic, and `schema` is the leaf.

## 7. Architectural rules from `.claude/CLAUDE.md`, checked against code

| Rule | Status | Evidence |
|---|---|---|
| Engine is a bundled stdio MCP server, no `bin/` | Holds | `.mcp.json`; no `bin/` tracked |
| Secrets only via `${user_config}` → MCP env | Holds | `.mcp.json:6-12` |
| Never write to `CLAUDE_PLUGIN_ROOT` | Holds for the data dir | `data-dir.ts:29-35` |
| Providers implement `VideoProviderAdapter` + mock conformance suite; idempotent on scene hash | **Not implemented** (no interface, no adapters). The render ledger's idempotency key is the random job id, not a scene hash | `render-jobs.ts:88,100` |
| "Spend limits, policy and consent are enforced in engine code" | **Not implemented.** The `Policy` schema exists, and its description even says "Enforced in engine code" (`packages/schema/src/policy.ts:61-78`), but nothing loads or reads a `policy.yaml` (no import outside `schema/src`) | grep |
| Spend-incurring skills set `disable-model-invocation: true` | **Violated:** `render`, `create`, `lint` and `variants` can trigger paid ElevenLabs synthesis through `voice: auto` (`synthesize.ts:67-71`). None sets the flag | `skills/*/SKILL.md` frontmatter |
| HyperFrames pinned behind `Renderer`, never bundled | Holds | `renderer/package.json:17`; `hyperframes.ts:67-111` |
| System ffmpeg first, `ffmpeg-static` opt-in only | ffmpeg-static is never used at all | `media/src/ffmpeg.ts:69` |
| Platform facts as data | Holds (`platform-specs/*.yaml`; lint quotes contracts) | `pipeline.ts:380-384` |
| Skill frontmatter portability | Mostly holds. `lint` lacks `license`/`compatibility` | `skills/lint/SKILL.md:1-5` |

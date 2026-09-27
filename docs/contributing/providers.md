# Contributing a provider adapter (Phase 7)

The render path is local today. Scenes that need a model (`generated_video`, `avatar`) render as
titled placeholder cards and say why. Provider adapters arrive in Phase 7 (`docs/PLAN.md`). This
page is the contract they must meet. Only the schemas below exist in code so far.

## What exists

- `CapabilityMatrix` and `SceneGenerationRequest` (`packages/schema/src/capabilities.ts`). An
  adapter describes itself in capabilities (text-to-video, image-to-video, character reference,
  native audio, duration range, aspect ratios, resolutions and data regions), never in model
  names. A spec scene declares `visual_requirements` the same way. `spec_validate` rejects
  provider or model names in them (`FORBIDDEN_PROVIDER_TERMS`).
- `SceneRender` in the render manifest (`packages/schema/src/render-manifest.ts`), with
  `provider`, `model`, `task_id` (persisted as soon as it is known) and `request_hash` (the
  canonical-JSON hash of the request and the idempotency key), plus cost and attempts.
- The SQLite job ledger and runner (`packages/core/src/ledger.ts`, `jobs.ts`). Jobs are
  idempotent by `idempotencyKey`, which is handed to the provider where it supports one.

## The adapter interface

`VideoProviderAdapter` is planned with these methods:

| Method | Contract |
|---|---|
| `capabilities()` | Returns a `CapabilityMatrix`. The router matches scene requirements against it. |
| `estimate(req)` | Cost and duration before anything is spent, for example Runway's Model Router `dryRun`. The spend limits in the engine use this estimate. |
| `validate(req)` | Rejects requests outside the adapter's capabilities with an actionable reason. |
| `submit(req, {idempotencyKey})` | Starts a job and returns the task id. The ledger persists it immediately. Submitting the same scene hash twice must not pay twice. |
| `status(taskId)` | Maps the provider's states onto queued, running, succeeded, failed and cancelled. Treat unknown states as running. |
| `download(taskId, dir)` | Called **as soon as** a job succeeds, because provider URLs expire (Runway: 24–48 h). Writes the file into the project and returns its path and sha256. |
| `cancel?(taskId)` | Optional. |

## Rules

- **The mock conformance suite is mandatory.** Every adapter passes the same suite against a
  mock HTTP server: capabilities are well-formed, submit is idempotent, task ids are
  persisted before polling, downloads happen immediately, expired URLs fail cleanly, and
  cancel/retry works. CI and `examples/` run without paid keys, using mock providers only.
- **Secrets** reach the engine only through `userConfig` (`sensitive: true`) mapped into the
  MCP server's `env`. Never read keys through Bash or from project files.
- **Policy and consent live in engine code.** That covers spend limits, data policy
  (confidential or source-code material stays local) and avatar/likeness consent. Hooks are
  advisory only.
- **AI disclosure:** a generated scene makes the render AI-generated. `export {sign: true}`
  then writes `compositeWithTrainedAlgorithmicMedia` (or `trainedAlgorithmicMedia` when every
  scene is generated) into the C2PA manifest (`packages/mcp/src/c2pa.ts`, `classifySource`).
  Local renderer ids start with `hyperframes`, `ffmpeg` or `remotion`. Any other renderer id
  counts as generated.
- **Providers in scope:**
  - Runway (Model Router, `dryRun` estimates)
  - HeyGen **v3 only**, because v1 and v2 retire on 2026-10-31
  - fal.ai for Kling, Veo and Hailuo
  - ElevenLabs for voice, which is already coded; characters are grouped into words
- **Sora is excluded.** OpenAI removed the API on 2026-09-24. Do not add a compatibility adapter.
- Verify every endpoint, status name and price against first-party docs before you write an
  adapter (`reports/Video studio implementation specs.md` lists what is still unverified).
  Put unverified fields behind a feature flag.

## Provider specs and prompt packs (Phase 7 step 0)

Before any adapter exists, each model family's prompt rules are data:
`provider-specs/<family>.yaml`, validated by `ProviderSpec`
(`packages/schema/src/provider-spec.ts`, JSON Schema in `schemas/provider-spec.schema.json`).
The families are seedance, veo, kling, wan, runway and hailuo (`ProviderFamily`). The
`prompt_pack` tool compiles every shot card (`scene.shot`) into each family's syntax with
`packages/prompts` (`compile`, `directorChecks`) and writes `prompts/<family>/<scene>.{md,json}`.
It makes no network call and spends nothing.

### Add a family

1. Add the family to `ProviderFamily` (a schema change, landed by the lead), then write
   `provider-specs/<family>.yaml`. `id` must equal the file name.
2. Fill in the fields from the provider's own docs. Use the host's model page too (for
   example fal.ai) when that is how users reach the model:
   - `models[]`: the ids as documented and the `modes` each supports. Preview ids change, so
     say so in `notes`.
   - `duration`: the `min_sec`/`max_sec` range and `allowed_sec` when the provider only takes
     fixed steps.
   - `aspect_ratios`, `resolutions`.
   - `references`: the limits and the in-prompt `syntax`, where `{n}` is replaced by the
     number (`@Image{n}` → `@Image1`).
   - `audio.native`, `audio.syntax`, `negatives` (`supported`, `unsupported` or
     `positive_only`), `multi_shot`, `camera_syntax` (bracketed commands are parsed from it),
     `prompt_max_chars`, `prompt_formula`.
   - `access[]`: `via` (direct, fal or replicate), the `env` var and its docs URL. Every `env`
     must exist in `CREDENTIALS` (`packages/schema/src/credentials.ts`). Adding one is a
     schema change, and `plugin.json` and `.mcp.json` must list it too.
3. Record where each fact came from in `source_urls` (https only), set `verified_on` to the
   date you read them, and keep `verified: false`.
4. Write every disagreement between hosts, and every number you could not confirm, into
   `notes`. The compiler copies the notes into each pack.
5. Add a family formatter in `packages/prompts/src/compile.ts` (`FORMATTERS`) only for
   phrasing the spec cannot express. Limits, reference names and negatives stay in the YAML.
6. Run `npx vitest run packages/prompts`. The registry test checks that every YAML parses,
   that `id` matches the file name, and that every `access[].env` is registered.

### Re-verify a spec

Re-check a spec when Phase 7 starts, before any adapter uses it, and whenever a provider
ships a new model:

1. Open every URL in `source_urls` and the provider's current API reference. Check the model
   ids, modes, durations, ratios, resolutions, reference limits, audio and negative-prompt
   support.
2. Fix what changed, update or replace the sources, and set `verified_on` to today.
3. Set `verified: true` only after you have checked every field against the live docs, not
   against this file, a blog post or a model's memory. If any field is still a guess, leave
   `verified: false` and say which field in `notes`.
4. Never add Sora. Its API was shut down on 2026-09-24.

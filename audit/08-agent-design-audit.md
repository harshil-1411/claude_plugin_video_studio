# 08 — Skill and agent design audit

Scope: the 21 `skills/*/SKILL.md` files, 5 plan references and 2 `agents/*.md`, read as instructions to Claude. Line counts come from `wc -l`: 1,207 lines of skills, 630 of references and 115 of agents.

## 1. Scorecard

Columns:
- **Plan / Verify / Retry / Ask**: does the skill tell Claude to plan, to verify its output, to retry with a bound, or to ask for clarification or approval?
- **Fail**: does the skill have explicit failure handling?

✓ = yes, ~ = partial, ✗ = no.

| Skill | Lines | Clarity / determinism | Plan | Verify | Retry (bounded) | Ask | Fail | Notes |
|---|---|---|---|---|---|---|---|---|
| create | 111 | Clear orchestration; delegates to plan/render | ✓ | ✓ (review) | ~ (inherits) | ✓ approval gate | ~ | Stale line 37; see §3 |
| plan | 240 | Very detailed; deterministic template table | ✓ | ✓ | ✓ (3 passes) | ✓ (1–2 questions) | ✓ | Longest; references loaded lazily (`:16-23`) |
| render | 111 | Clear; stage-by-stage | ✓ | ✓ (review before presenting) | ~ | ✓ (before final) | ✓ (`:107-111`) | No explicit spend check |
| lint | 91 | Very precise per finding id | ✓ | ✓ | ✓ (3 passes, stop on repeat) | ✓ (before dropping targets/restructuring) | ✓ | Missing `license`/`compatibility` |
| verify | 51 | Precise | ✓ | ✓ | ✓ (3 passes) | ✓ | ✓ | "Do not change grounding" (`:50`) is good |
| ingest | 88 | Clear; strong safety preamble | — | ~ | ✗ | ✓ (model download consent) | ✓ | — |
| shorts | 87 | Clear | ✓ | ✓ (spec_validate) | ✗ | ✓ (which clips; rights) | ~ | No warning that `make_projects` overwrites earlier edits |
| localize | 61 | Clear, language-specific rules | ✓ | ✓ | ~ | ✓ (region) | ✓ | — |
| demo | 32 | Clear | ✓ | ~ | ✗ | ✓ (URL, steps, masks) | ✓ | Relies on the model-set `confirm` |
| tighten | 30 | Clear | ✓ | ~ | ✗ | ✓ (adjust before apply) | ✗ | — |
| variants | 41 | Clear | ✓ | ~ (lint optional) | ✗ | ~ (only "what to test") | ~ | No confirm before up to 24 renders |
| adapt | 26 | Clear | ✓ | ✓ | ~ ("until clean", unbounded) | ✗ | ~ | — |
| export | 46 | Clear | — | ✓ | ✗ | ✗ | ✓ | C2PA test-cert caveat explained |
| review | 56 | Clear; checklist | ✓ | ✓ | — | — | — | "Don't claim a render looks right without having Read the image" (`:54-55`) is excellent |
| test | 48 | Clear | — | ✓ | — | ✓ (before `update`) | ✓ | Good destructive-op guard |
| diff | 42 | Clear | — | ✓ | — | — | ✓ | — |
| compare | 51 | Clear | — | — | — | — | ✓ | Wrong example path (§3) |
| analyze | 43 | Clear; clean-room rules | — | — | — | ✓ (licensed copy) | ✓ | — |
| qa | 24 | Clear | — | — | — | — | ✓ | — |
| validate | 34 | Clear | — | ✓ | ~ ("until it passes", unbounded) | ✓ (offer fixes) | ✓ | — |
| doctor | 34 | Clear | — | — | — | — | ✓ | "Never ask the user to paste a key" (`:25-27`) is good |

Agents:
- `source-researcher` (37 lines; `agents/source-researcher.md`): read-only tools, an output budget of about 400 words, a fixed 6-part structure, and a cite-or-omit rule. Good.
- `creative-director` (78 lines; `agents/creative-director.md`): read-only, a P1/P2/P3 rubric with a Now/Try/Why format, and at most about 8 suggestions. Good. It is the only place that *checks* whether the evidence text actually says the claim (`:33-37`). The engine checks only that refs resolve.

## 2. Frontmatter portability and the spend rule

| Check | Result | Evidence |
|---|---|---|
| Only portable fields (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`) | ✓ in all 21 | frontmatter dump |
| `license` + `compatibility` present | ✗ in `lint` | `skills/lint/SKILL.md:1-5` |
| Spend-incurring skills set `disable-model-invocation: true` | **✗ none do.** `render`, `create`, `lint` (re-render loop) and `variants` (up to 24 renders) all call `render_submit`, whose default `voice: auto` uses **paid ElevenLabs** whenever a key is set (`packages/voice/src/synthesize.ts:52-71`). `transcribe`/`ingest`/`shorts`/`tighten` can trigger a 148 MB download, but only with the consent flag | `.claude/CLAUDE.md` rule; `skills/*/SKILL.md` |
| Tool names match the server | ✓ all `mcp__plugin_video-studio_engine__<tool>` names exist in `server.ts` | cross-check script |
| Tools a skill tells Claude to call but not in its `allowed-tools` | `create` delegates to `plan` and `render` through the Skill tool. Its documented fallback, "Read `../plan/SKILL.md` and follow it" (`create:60-62`, `:82-84`), would need `template_list`, `template_get`, `spec_scaffold`, `brief_validate`, `storyboard_render`, `schema_get` and `Agent`, none of which are in create's list (`create:6`). `qa` "offer the render skill"; `export` "offer the lint skill's fix loop" | `skills/create/SKILL.md:6,60-62,82-84` |

## 3. Concrete issues

| # | Severity | Issue | Evidence |
|---|---|---|---|
| 1 | High | **No engine-side spend gate, and the skill-level gate is soft.** `create` says "Never start anything that costs money without an explicit approval… it only calls ElevenLabs if the user configured a key (then say so before rendering)". But `create`'s `allowed-tools` has no `doctor`, so Claude cannot check whether a key exists before rendering. `render`, `lint` and `variants` have no such instruction at all. No skill passes `voice` explicitly, so the paid backend is the silent default whenever a key exists | `skills/create/SKILL.md:6,76-78`; `skills/render/SKILL.md:11-12,23-26`; `skills/lint/SKILL.md:82-84`; `skills/variants/SKILL.md:32-35` |
| 2 | High | **Contradiction inside `create`.** Lines 21-25 say to ingest clips and plan with `talking-head`/`aesthetic-broll`. Line 37 says "Talking-head videos need footage and are not available yet." | `skills/create/SKILL.md:21-25,37` |
| 3 | Medium | **Wrong path example for tightened assets.** `compare` shows `assets/supplied/talk.mp4` vs `assets/supplied/talk-tight.mp4 after tighten`, and so does the tool description. `tighten` writes `source/assets/<asset>-tight.<ext>`, and ingested media also lives in `source/assets/`. The `tighten` skill gets it right | `skills/compare/SKILL.md:22-24`; `packages/mcp/src/server.ts:556`; `packages/mcp/src/tighten.ts:171`; `skills/tighten/SKILL.md:27-30` |
| 4 | Medium | **`shorts` make_projects overwrites refined specs silently.** The skill says "Then refine each `shorts/<id>/project/video-spec.json`" (`:60`) but never warns that calling `make_projects` again (e.g. for another id, or with other `min_sec`/`max_sec` that re-number candidates) rewrites that file and `project.json` | `skills/shorts/SKILL.md:45-80`; `packages/mcp/src/shorts.ts:290-347` |
| 5 | Medium | **`variants` has no approval step and no warning about duplicates.** The default is 3 × 2 = 6 renders (`:17`). Re-calling `render: true` resubmits in-flight variants (engine bug, see 07). The skill tells Claude to poll `status_only`, which reports "rendering" forever for a failed job | `skills/variants/SKILL.md:17-35`; `packages/mcp/src/variants.ts:80`; `server.ts:632` |
| 6 | Medium | **Re-ingest wipes evidence and no skill warns about it.** `plan` step 1.2 says to call `ingest` when "the user gave new inputs". `ingest` replaces `content-ir.json`, so previous sources, transcripts (`media.transcript`) and demo step evidence disappear, and existing `claim_refs` then fail validation. Skills should say to pass *all* inputs again, or the engine should merge | `skills/plan/SKILL.md:43-45`; `packages/ingestion/src/ingest.ts:303-314` |
| 7 | Medium | **The demo consent gate is only as strong as the model.** The skill does ask (`demo:23-24`), and the engine requires `confirm: true` (`demo.ts:255`). But nothing ties `confirm` to a user turn, and the skill does not say to refuse non-localhost URLs or `file://` (the engine only warns) | `skills/demo/SKILL.md:13-24`; `packages/mcp/src/demo.ts:264-267` |
| 8 | Medium | **Unbounded loops.** `validate` ("validate again until it passes", `:31-32`) and `adapt` ("Call spec_validate until it is clean", `:25`) have no pass limit, unlike plan, lint and verify (3 passes) | `skills/validate/SKILL.md:31-32`; `skills/adapt/SKILL.md:25` |
| 9 | Low | **Ambiguous step reference.** `create` step 6 says "scene edits (back to the plan rules and step 4)". Step 4 of `create` is the approval gate, and step 4 of `plan` is Hooks, so the target is unclear. The other cross-references resolve correctly: create → "render skill's step 4" = Look at it (`render:37`); "render skill's step 6" = Final render and export (`render:81`) | `skills/create/SKILL.md:92-97,103` |
| 10 | Low | **The plan instructs Claude to create scenes that only become placeholders.** "B-roll and visual metaphors → `generated_video`" (`plan:186-189`) is still the guidance, although no provider exists and these render as titled cards (`select.ts:191-201`). The storyboard hand-off mentions it (`plan:236-238`), but the scene-writing step does not say to prefer deterministic kinds or footage until Phase 7 | `skills/plan/SKILL.md:186-189,236-238` |
| 11 | Low | **Pacing thresholds differ.** Plan and creative-director target 2.3–2.8 words/s and flag > 3.0. Storyboard, lint and adapt use 3.3 | `agents/creative-director.md:45-47`; `skills/plan/SKILL.md:180`; `packages/mcp/src/plan.ts:348`; `lint.ts:33`; `adapt.ts:34` |
| 12 | Low | **`qa` skill omits side effects.** The skill says QA updates `dist/render-manifest.json`, but `qa_run` rebuilds the whole `dist/` (re-lint, packages) | `skills/qa/SKILL.md:23-24`; `packages/mcp/src/pipeline.ts:1452-1459` |
| 13 | Low | **Agent references are not namespaced.** `plan` says to delegate to "the `source-researcher` agent" and "the `creative-director` agent". Plugin agents are exposed with a plugin prefix, and no fallback is given if the agent is not found | `skills/plan/SKILL.md:48,216` |
| 14 | Low | **Examples.** Most skills show call shapes (`{project_dir, …}`) but few show a *result* example. `plan` relies on references for field enums, `brief-and-spec-fields.md` (111 lines). There is no worked minimal spec in any skill; `examples/*/project/video-spec.json` exist but are not referenced from `plan` | `skills/plan/SKILL.md:16-23` |

## 4. Destructive-operation safety

| Operation | Engine behaviour | Skill guard | Verdict |
|---|---|---|---|
| Re-ingest | Replaces the IR (`ingest.ts:303-314`) | none | **Gap** |
| `tighten apply` | New asset; original kept (`tighten.ts:171`) | Dry run first, user adjusts (`tighten:13-21`) | Good |
| Whisper model download | Only with `download_model: true`; sha256-pinned | "Never pass download_model: true without that yes" (`ingest:50-55`; `shorts:23-25`; `tighten:11-12`) | Good (model-enforced) |
| Demo capture | `confirm` required; blurs inputs | Show URL, steps and masks, then confirm (`demo:23-24`) | Good; URL policy weak |
| `test update` | Clears goldens (`golden.ts:230`) | "Never record goldens without looking first" (`test:32-41`) | Good |
| `export` | Deletes dropped-target packages; overwrites dist; C2PA in place | "Editing the spec is durable; dist/ files are regenerated" (`export:46`) | Acceptable (dist is engine-owned) |
| C2PA signing | Test cert → warns validators show it as untrusted | Explained (`export:25-27`) | Good |
| `variants` | rm + re-copy variant folders on each call (`variants.ts:104-108`) | none | **Gap** |
| `shorts make_projects` | Overwrites `shorts/<id>/project/*` | none | **Gap** |
| `adapt` / `localize` | Refuse a non-empty `out_dir` (`adapt.ts:54-55`; `localize.ts:381-395`) | "The source is never changed" | Good |
| Render overwrites | `renders/<q>/`, `dist/` | — | Engine-owned; fine |

## 5. External APIs in skills

- ElevenLabs is mentioned in `create:76-78` and `render:11-12,69-72`. Keys are only pointed to `/plugin` configure, never pasted into chat (`doctor:25-27`). Good.
- No skill mentions Runway, HeyGen or fal. `plan` references say "routing picks providers later" (`plan:32-33`), which is accurate as a future promise.
- `render` and `doctor` give the HyperFrames install command for the user to run; "Do not try to install anything yourself unless the user asks" (`doctor:34`). Good.

## 6. Verbosity

The heaviest always-loaded text is not in the skills but in the 28 tool descriptions: several run over 1,000 characters (`server.ts:150,183,356,471,526,609,749,768,791`). They load into context every session, whether or not a skill runs. The skills themselves are appropriately scoped. Only `plan` (240 lines + 630 in references) is large, and it defers the references until the step that needs them.

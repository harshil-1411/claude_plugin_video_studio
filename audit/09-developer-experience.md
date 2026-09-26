# 09 · Developer and user experience audit

Perspective: a developer who finds the repo on GitHub and wants a reel from their README, then a creator using footage. Evidence is from `b6fd8ea`. Error behaviour under hostile inputs is covered in `13-negative-testing.md`.

## 1. Installation

| Aspect | Finding | Evidence | Impact |
|---|---|---|---|
| Runtime needs | Node 22.13+ (for `node:sqlite`) and a system ffmpeg with libass and libx264. Everything else is optional: HyperFrames + Chrome, whisper.cpp + model, c2patool, ElevenLabs key. | README "Quick start"; `packages/mcp/src/doctor.ts` checks `node`, `sqlite`, `ffmpeg_libass`, `ffmpeg_libx264`, `ffmpeg_text_shaping`, `system_voice`, `whisper_cpp`, `chrome`, `data_dir`, `provider_keys` | Good: small hard requirements, and a doctor that names what's missing. |
| **Quick start asks end users to `pnpm install`** | The plugin runs the committed single-file bundle `dist/mcp.mjs` (`.mcp.json`). Its only imports are Node built-ins (`node:*`), checked by scanning the bundle. So end users need **neither pnpm nor `pnpm install`**. The clone + `pnpm install` path is the *developer* path. | README Quick start; `.mcp.json` | **P1 DX.** It adds a tool (pnpm) and a slow install to a first run that doesn't need them. It also fails in restricted environments (the Claude sandbox blocks `pnpm install`; HANDOFF). |
| Marketplace install | Documented in a collapsed `<details>`: `/plugin marketplace add harshil-1411/claude_plugin_video_studio` then `/plugin install video-studio@video-studio-marketplace`. | README | Should be the *primary* path, with clone + `--plugin-dir` for contributors. |
| Cross-platform | macOS-first. `say` voice and the Premium/Enhanced voice picker (`packages/voice/src/system.ts`). Linux falls back to espeak-ng. Windows is not handled in code: no `process.platform` branches in `packages/*/src` besides the path escaping in `escapeFilterPath`; `say` and espeak aren't present on Windows, so voice falls back to silent. | grep of `packages/*/src` | Windows users get silent reels unless they have an ElevenLabs key; the README doesn't say so. |
| **Provider keys that do nothing** | `userConfig` offers `runway_key`, `heygen_key`, `fal_key`, `kling_key` ("for generative video", "for presenter videos"). No provider code reads them; only `doctor.ts` does. Generative scenes render as placeholder cards (README "Limits"). | `.claude-plugin/plugin.json` userConfig; `.mcp.json` env; grep: only `packages/mcp/src/doctor.ts` references those env vars | **P1 honesty/DX.** A user can pay for and enter a Runway key and get placeholders. The config descriptions should say "(Phase 7, not used yet)", or the fields should be removed until the adapters ship. |
| Optional heavy deps | HyperFrames is never bundled or auto-installed; the render skill prints the exact `npm i @hyperframes/producer@0.8.78 --prefix deps` command; whisper model downloads only with consent (`transcribe download_model: true`). | `skills/render/SKILL.md` "Optional: HyperFrames renderer"; `packages/mcp/src/transcribe.ts:84` `missingModelError` | Good: explicit and consent-based. The whisper model now also powers alignment (`voice-align.ts`), but no skill *offers* the download when a narrated render has estimated timings; it's only noted in the voice reason. |

## 2. First experience

- **What it does** is clear within the first screen of the README: a hero video made by the plugin (`docs/media/hero.mp4`), a "Why" list, and a `dist/` tree of what you get.
- **One command to start:** `/video-studio:create README.md as a 30-second 9:16 reel …`. The create skill has an explicit approval gate before rendering (step 4), matching what users expect from agentic tools.
- **Examples:** `examples/readme-hero`, `text-to-motion-graphic`, `reel-grammar`, `demo-app`, each with a README and the command that renders it.
- **Friction points seen in practice (this project's own history):**
  - The first narrated render sounded robotic until the natural-voice picker and `rate_wpm` were added. It's fixed, but the quality of the default voice depends on which macOS voices the user has downloaded, and nothing tells them how to add a Premium voice. The `system_voice` doctor check reports it, but no skill points to System Settings → Accessibility → Spoken Content.
  - Word timings are estimated with `say`. In the user's reels this ran at an effective ~260 wpm against a configured 155 wpm, which made captions and cues land early (see `15-…` and HANDOFF). Alignment fixes it only after the whisper model is downloaded.

## 3. Commands (skills)

21 skills are exposed as `/video-studio:<name>`: adapt, analyze, compare, create, demo, diff, doctor, export, ingest, lint, localize, plan, qa, render, review, shorts, test, tighten, validate, variants, verify.

| Criterion | Assessment |
|---|---|
| Memorable | Mostly single verbs (`render`, `review`, `lint`, `tighten`). `adapt` vs `variants` vs `localize` need the README table to tell apart. |
| Consistent | Consistent naming; each skill maps to one MCP tool of the same name, except `create` and `plan` (orchestration) and `validate` (tool `spec_validate`). |
| Discoverable | README "Commands" table (grouped rows). Claude also picks skills from their descriptions, so users rarely need the names: `/video-studio:create` is the entry point and chains the rest. |
| Overlap risk | `review` vs `qa` vs `lint` vs `verify` vs `test` are five "check" commands. The README explains each in one line, but a newcomer needs a "which check when" line. |

## 4. Errors

Good patterns found:
- **Missing model:** `missingModelError` says what's missing, where it looked, the size, and the three ways out: download with consent, `VS_WHISPER_MODEL`, or pass an SRT/VTT (`packages/mcp/src/transcribe.ts:84-94`).
- **Validation:** every semantic issue carries `path`, `message` and a concrete `fix` (`SemanticIssue` in `packages/schema/src/video-spec.ts`), and the plan and validate skills loop on them.
- **Render lock:** it names the holder pid, host, quality and start time, and says what to do if the holder crashed (`packages/mcp/src/render-lock.ts`).
- **Fallbacks are reported, never silent:** voice auto → ElevenLabs → system → silent with `voice.reason`; renderer auto → HyperFrames → ffmpeg with `renderer.reasons`.
- **Lint findings:** each has a `fix` string written as an instruction (all 31 rule ids in `packages/mcp/src/lint.ts`).

Weak spots:
- **Raw ffmpeg failures** surface as `FfmpegError: ffmpeg exited with code N:` plus the tail of stderr (`packages/media/src/ffmpeg.ts:238`). That's the "bad example" pattern from the audit brief. Classifying common causes into an actionable line would help, e.g. missing encoder, unknown filter (libass/drawtext missing), unreadable input, or disk full. `13-negative-testing.md` has the concrete cases.
- **Tool errors are strings.** `safe()` in `server.ts` wraps exceptions as text results. That suits Claude, but there's no machine-readable error code, so skills can't branch reliably. For example, `render_submit` → lock held → "wait and poll" relies on Claude reading prose.

## 5. Recommendations (DX), each tied to code

| Priority | Change | Where | Value |
|---|---|---|---|
| P1 | Make marketplace install the primary Quick start; move clone + `pnpm install` to "Develop". State that end users need only Node 22.13+ and ffmpeg. | README | Removes pnpm and an install step from every new user's first run. |
| P1 | Mark or remove the unused provider keys in `userConfig` until the Phase 7 adapters exist. | `.claude-plugin/plugin.json`, `.mcp.json` | Stops users configuring keys that have no effect. |
| P1 | Offer the whisper model download (with consent) when a narrated render used estimated timings. | `skills/render/SKILL.md` step 5 ("Voice and renderer used"), using `voice.reason` from `pipeline.ts` c1 | One question gets every later render exact caption and cue timing. |
| P2 | Classify common ffmpeg failures into actionable messages. | `packages/media/src/ffmpeg.ts` (`FfmpegError`) | Turns the most common opaque failure into a fix. |
| P2 | Add an error `code` field to tool results (e.g. `RENDER_LOCKED`, `SPEC_INVALID`, `MODEL_MISSING`) alongside the text. | `packages/mcp/src/server.ts` `safe()`/`jsonResult` | Lets skills branch deterministically. |
| P2 | A "which check when" line: lint (platform and craft rules), qa (technical file checks), verify (grounding), review (look at it), test (regression). | README Commands, `skills/create` | Cuts confusion between five check commands. |
| P2 | Say how to get a natural voice: download a Premium voice in macOS settings, or use ElevenLabs; and what Windows users get. | README Limits, doctor `system_voice` detail | Voice quality is the first thing users judge. |

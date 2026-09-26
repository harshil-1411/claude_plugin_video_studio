# 03 — Execution flows

Notation: **S** = skill instruction (what Claude is told), **T** = MCP tool, **C** = engine code. "Writes" lists files relative to the project unless noted.

---

## (a) `/video-studio:create` from a README

| # | Stage | Input → processing | Tools | Writes | Failure handling / fallback | Evidence |
|---|---|---|---|---|---|---|
| 1 | Parse request | S: split inputs and creative direction. GitHub URL → ask the user to clone. An idea with no sources → Claude writes 5–8 statements to `input/notes.md` and plans with `grounding: "loose"` | — | `input/notes.md` (idea-only case) | — | `skills/create/SKILL.md:14-49` |
| 2 | Ingest | `ingest {project_dir, inputs}`. C: creates the project if missing; `detectKind` per input (URL, repo dir, extension, else inline text); per-kind extractor; extraction cache under `<data>/cache/ingest`; classification (secrets/PII/likeness) | `ingest` | `project/project.json` (new project), `source/content-ir.json`, `source/provenance.json`, `source/assets/*` (media) | Per-input failures become `ingest_failed` warnings, not a thrown error (`ingest.ts:299-301`). **The IR is overwritten, not merged** (`ingest.ts:303-314`) | `server.ts:161-175`; `ingestion/src/detect.ts:74+`; `ingest.ts:149,223` |
| 3 | Plan | S: invoke the `plan` skill (fallback: Read `../plan/SKILL.md`). Plan: read the IR → optional `source-researcher` agent → infer brief values (ask 2 questions or fewer) → `template_list`/`template_get` → 3 or more hooks scored → write `creative-brief.yaml` → `brief_validate` → `spec_scaffold` (returned, not written) → Claude fills the spec → write `video-spec.json` → `spec_validate` loop (3 passes or fewer) → optional `creative-director` → `storyboard_render` | `template_list`, `template_get`, `brief_validate`, `spec_scaffold`, `spec_validate`, `storyboard_render`, `schema_get`, Agent | `project/creative-brief.yaml`, `project/video-spec.json`, `project/storyboard.md` | The validation loop stops after 3 passes and lists the rest. "Never fix grounding by inventing a ref" | `skills/plan/SKILL.md:40-240`; `server.ts:261-349` |
| 4 | Approval gate | S: Approve / Revise (edit, re-validate, re-storyboard, back to the gate) / Stop. "Never start anything that costs money without explicit approval." If an ElevenLabs key is configured, say so before rendering | — | — | Relies on Claude. No engine-side gate | `skills/create/SKILL.md:65-78` |
| 5 | Preview render | S: follow the `render` skill: `render_submit {quality: "preview"}`, poll `job_status` every 10–20 s | `render_submit`, `job_status` | see renderProject stages below | Invalid spec → `isError` with `structuredContent.errors` (`server.ts:379-390`) | `skills/render/SKILL.md:21-35` |
| 6 | Self-review | S: `review` contact sheet, then Read the JPEG; strips and crops as needed; fix the spec and re-render | `review` | `qa/review/<mode>-<quality>[-scene].jpg`, `qa/lint.{json,md}` | — | `skills/render/SKILL.md:37-51`; `server.ts:522-548` |
| 7 | Final + export | S: on approval, `render_submit {quality: "final"}`. Claude refines `publish.<target>` in the spec, then calls `export` | `render_submit`, `job_status`, `export` | `dist/**` | — | `skills/create/SKILL.md:100-111`; `skills/render/SKILL.md:81-93` |
| 8 | Lint | Not called explicitly by `create`. `lint` runs inside every export (`pipeline.ts:1604-1609`) and its findings land in `dist/<target>/qa.json` | (implicit) | `qa/lint.{json,md}` | A lint crash becomes `lintError` in the package; export still succeeds (`pipeline.ts:1607-1609`) | `pipeline.ts:1551-1650` |

### renderProject stages (`packages/mcp/src/pipeline.ts`)

| Stage | What happens | Line |
|---|---|---|
| lock | `acquireRenderLock(renders/.render.lock, quality)`; released in `finally` | 408-416 |
| a. validate | `loadValidSpec` (schema + semantics + IR cross-check); load `brand.yaml` (any path when `brand_path` is given), style pack, tokens, bundled fonts status | 432-455, 323-335 |
| b. target | Probe renderer availability on `typography` to decide whether HyperFrames draws (preview: half resolution, 15 fps for ffmpeg or 24 fps for HyperFrames) | 457-464, 387-393 |
| c. voice | `selectBackend(voiceChoice)` → `synthesizeSpec` (content-addressed cache in `<data>/cache/voice`) | 466-497 |
| c1. align | If system TTS produced estimated timings and whisper is installed, align words to the audio (`<data>/cache/align`); rewrites `assets/voice/voice-tracks.json` | 498-510 |
| c0. footage/music | `resolveFootage` via `resolveInsideProject`; `resolveMusic` (bundled bed or project file) | 515-517, 1157-1204 |
| c'. overruns | A scene whose voiceover is longer than the scene is extended in the render plan only | 519-527 |
| c''. beat sync | `detectBeats` + snap cuts (render plan only) | 529-551 |
| slots | Frame-exact slot boundaries | 555-563 |
| native tracks + cues | Transcript words for `voice.mode: native`; word cues matched to spoken words (unmatched or late → warning) | 564-604 |
| d. scenes | `renderScenes` (sequential, concurrency 1). In `auto`, failed scenes are retried with ffmpeg. Any scene still failing or without a clip → throw | 605-658 |
| e. captions | Word timeline + sound-event cues → SRT/VTT/ASS/TXT/JSON; `burn_captions: false` scenes are excluded from burn-in | 660-731 |
| e'/e''. audio | Speech intervals for ducking; per-scene footage audio and sfx | 733-741 |
| f. assemble | `assemblyKey` hash over segment shas, audio, music, scene audio, burn, logo, ASS, fonts. Reuse when it matches `render-state.json` and master/reel exist | 743-830 |
| g. cover/thumbnail | `thumbnailKey`; `renderCover` when `spec.cover`, else `makeThumbnail` at the hook midpoint | 832-870 |
| state | Tool versions, locked fonts, `RenderState` | 872-952 |
| f'. QA | `technicalQa`, reused when the reel sha and `QA_VERSION` match | 954-963 |
| persist | `render-state.json`, `renders/latest.json` | 964-966 |
| g'. export | `exportFromState`: copies to `dist/`, social copy, lint, per-target packages (transcode only when the contract requires it), optional C2PA, `video.lock`, manifest, provenance | 968-971, 1551-1700 |

### Fallback chains (as implemented)

| Chain | Actual behaviour | Evidence |
|---|---|---|
| Voice selection `auto` | ElevenLabs if `ELEVENLABS_API_KEY` is non-empty and ffmpeg is present → system TTS (`say` on darwin, `espeak-ng` on linux) → silent | `voice/src/synthesize.ts:52-75`; `elevenlabs.ts:152-177`; `system.ts:150-154` |
| Voice synthesis failure | With `auto` narrated: **falls straight to silent, not to system TTS**. Explicit backend, or non-narrated mode: throw | `pipeline.ts:490-497` |
| Placeholder key | `apiKey()` treats a literal `${user_config.elevenlabs_key}` as a real key (`elevenlabs.ts:152-155`), unlike `hasEnvValue` used elsewhere (`media/src/ffmpeg.ts:37-42`). If Claude Code passes the placeholder unexpanded, `auto` picks ElevenLabs, fails with 401, then renders **silent** even on a Mac with `say` | combination of the two rows above |
| Renderer `auto` | Rank HyperFrames first if it passes its probe (producer resolvable, Chrome launches), else ffmpeg. Per-scene failure → retry that scene with ffmpeg | `renderer/src/select.ts:42-60`; `pipeline.ts:639-645` |
| Renderer explicit (`hyperframes`/`ffmpeg`) | No retry; a failed scene → throw with the hint "re-run with renderer ffmpeg" | `pipeline.ts:647-654` |
| Non-deterministic scenes | `placeholder: true` (default) → titled `end_card` card; otherwise status `pending` → render fails | `select.ts:191-201,238-245`; `pipeline.ts:650-652` |
| Footage unresolved | Placeholder card with the reason | `select.ts:236-243` |
| whisper GPU crash | Retry on CPU | `media/src/asr.ts:62-70` (comment at :66) |
| Fonts missing | Host fonts, with a warning | `pipeline.ts:449-455` |
| C2PA missing | Export unsigned, with a warning | `c2pa.ts:186-196` |

### Caching

| Cache | Key | Where | Evidence |
|---|---|---|---|
| Ingest extraction | `cacheKey` over input and extractor version | `<data>/cache/ingest/<ab>/<key>.json` | `ingestion/src/ingest.ts:149` |
| Voice | `cacheKey({backend, voice, text, options, inputDigest})` | `<data>/cache/voice/{cas,index}` | `voice/src/synthesize.ts:140-170` |
| Alignment | per track | `<data>/cache/align` | `pipeline.ts:501` |
| Scene clip | `sceneCacheKey` = canonical scene JSON + tokens + target + zones + renderer id/version + placeholder + footage sha + cues | `renders/<q>/scenes/<id>.json` sidecar | `renderer/src/select.ts:155-181,264-285` |
| Assembly | `assemblyKey` | `renders/<q>/render-state.json` | `pipeline.ts:766-788` |
| Thumbnail/cover | `thumbnailKey` | same | `pipeline.ts:837-849` |
| QA | reel sha + `QA_VERSION` | same | `pipeline.ts:957` |

**Cache gap:** the scene key hashes the scene JSON, which contains only the *id/path* of a screenshot asset (`props.asset`) and the logo *path* (`tokens.logo_path`), not the file contents (`select.ts:155-181`, called at `:264`). Replacing `assets/supplied/shot.png` or the brand logo in place, under the same name, re-uses the stale scene clip. (The assembly key does hash the corner logo overlay, `pipeline.ts:777`, but end-card logos are drawn inside the scene clip, `ffmpeg-renderer.ts:2215-2229`.)

### Render lock and abort

- Lock: `renders/.render.lock`, exclusive create, stale after a dead pid (same host) or 6 h. The error message tells the user to delete it (`render-lock.ts:11,26,50-55`).
- Abort: `signal.throwIfAborted()` between stages (`pipeline.ts:464,535,661,790,960`). ffmpeg children get SIGTERM, then SIGKILL after 2 s (`media/src/ffmpeg.ts:212-219`). **Only `RenderJobManager.close()` triggers the signal, and production never calls it** (`main.ts`; `render-jobs.ts:179-184`). There is no cancel tool. After a server restart, a queued or running job reads as `interrupted`, and the advice is to resubmit (`render-jobs.ts:161-166`).

---

## (b) Footage / talking head: ingest video → transcribe → tighten → shorts → render

| Stage | Processing | Tool | Writes | Failure / validation | Evidence |
|---|---|---|---|---|---|
| Ingest video | Copy into `source/assets/`; ffprobe; ffmpeg scene detection (`select='gt(scene,T)'` on a 160 px decode) → shots; one keyframe JPEG per shot (capped); loudness; letterbox `cropdetect` → `content_box`; `contains_likeness: true` for every video | `ingest` | `source/assets/*`, IR asset with `media.{duration, shots, keyframes, content_box}` | `needs_transcript` warning | `ingestion/src/media.ts:13-23,60-68,121,151-155,199-202` |
| Transcribe | whisper-cli (`-ml 1`, per-word JSON) on 16 kHz mono WAV, or import `.srt/.vtt` (20 MB cap). Missing model → error asking for consent; `download_model: true` → download + sha256 verify | `transcribe` | `source/transcripts/<asset>.json`; IR `media.transcript` + `video:<file>#t=a-b` evidence spans | No audio → error. Model is `base.en` only (English), unless `VS_WHISPER_MODEL` is set | `mcp/src/transcribe.ts:20-27,76-128,253-300`; `media/src/asr.ts:40-100` |
| Tighten (dry run) | `planTighten`: pauses over `max_pause_ms` shortened to `keep_pause_ms`, fillers, retakes | `tighten` | `qa/tighten-<asset>.json` | — | `mcp/src/tighten.ts:59,152-165` |
| Tighten (apply) | ffmpeg `atrim`/`trim` + 15 ms `afade` per kept span → new asset `<asset>-tight`; transcript re-timed; new evidence refs | `tighten apply:true` | `source/assets/<asset>-tight.*`, IR updated | Nothing kept → error | `tighten.ts:166-229` |
| Shorts | Score spans (sentence-complete, hook score, speech density, shot snapping, no overlap) | `shorts` | `qa/shorts.json` | — | `mcp/src/shorts.ts:41,83,141-180` |
| make_projects | Per candidate: `shorts/<id>/` with a trimmed source copy (only its span), its own IR, and a talking-head spec (`voice.mode: native`, footage scenes of 12 s or less, transcript `claim_refs`) validated | `shorts make_projects:true` | `shorts/<id>/{source,project,brand.yaml}` | Invalid specs are reported per project. **Overwrites** `project/video-spec.json` and `project.json` on every call, with no guard for existing edits (`shorts.ts:290-347`) | `shorts.ts:203-352` |
| Render | As in (a). Native tracks from the transcript; scene audio mix; captions from transcript words | `render_submit` | as in (a) | No transcript words → warning, no captions | `pipeline.ts:564-576,731` |

The skill order is tighten first, then shorts (`skills/shorts/SKILL.md:42-43`; `skills/tighten/SKILL.md:24`).

---

## (c) Demo capture

| Stage | Processing | Evidence |
|---|---|---|
| S: ask for the URL; Claude writes `project/demo.json`; show the URL, steps and masks; ask to confirm | `skills/demo/SKILL.md:13-24` |
| T `demo {project_dir, confirm: true}`. C: refuses without `confirm === true` (a boolean the model supplies) | `demo.ts:254-257` |
| Load the script from `join(root, script ?? "project/demo.json")`. The path is **not** confined (see 07) | `demo.ts:202-209` |
| A non-local start host gives a **warning only**. `goto` steps are unchecked strings, and any scheme is accepted | `demo.ts:264-267,289-290`; `schema/src/footage.ts:10,28` |
| Launch system Chrome headless via runtime `puppeteer-core`; inject mask CSS (inputs, textarea, select, contenteditable, `mask_selectors`) and a cursor; `screencast` to webm; run steps with a `max_duration_sec` (default 120) cap | `demo.ts:137-148,151-157,269-344` |
| ffmpeg → H.264 CFR 30 fps at the viewport size → `source/assets/demo-<id>.mp4`; IR updated with one evidence span per step (`video:demo-<id>.mp4#step-N`) | `demo.ts:346-366,213-252` |
| Failure: missing selector → throw; browser/recorder always closed in `finally`; temp dir removed | `demo.ts:176-181,341-344,367-369` |

---

## (d) Localize

| Stage | Processing | Evidence |
|---|---|---|
| Step 1 `localize {project_dir, language}` | `out = out_dir ?? <root>/localized/<lang>`; refuses the same folder, the same language, or a non-empty folder without a matching sheet. Copies the project parts except `assets/voice`. Writes `project/translation.json` (every voiceover, on-screen text, text props, cover headline, post copy, with notes and budgets) and `source_spec_sha256`. Re-running keeps existing targets | `mcp/src/localize.ts:378-429` |
| S: Claude fills `target` per entry with Edit (meaning, budgets, no code, RTL/CJK rules) | `skills/localize/SKILL.md:22-46` |
| Step 2 `apply: true` | Refuses when the source spec sha changed. Rebuilds the localized spec from the source spec + sheet, re-times scenes per language rate, switches fonts to Noto script families, drops `voice_id`, validates | `localize.ts:430-560`; `localize.ts:92-125` |
| Then `storyboard_render`, the `render` skill, `lint` | `skills/localize/SKILL.md:57-61` |

---

## (e) Variants / adapt

**Variants:** Claude writes `project/variants.json` → `variants` builds each hook × cover pair into `variants/<id>/`. It `rm`s and re-copies `source`, `project`, etc. on every call, so manual edits inside a variant folder are lost (`variants.ts:99-108`). Base scene clips are seeded into each variant's `renders/<q>/scenes`. The variant spec is validated. `variants/experiment.json` is written (`variants.ts:88-151`). `render: true` queues one job per prepared variant on the shared manager (`server.ts:629-640`), up to 6 × 4 = 24 renders (`schema/src/experiment.ts:32-33`) with no spend or approval gate.

**Adapt:** refuses the same or a non-empty `out_dir`; applies platform/aspect/targets/duration changes, scales durations (0.5 s minimum each, rounding remainder on the longest scene), scales cover time, notes narration overflows at 3.3 words/s; copies `source`, `input`, `assets`, `brand.yaml`, `project` (including `project.json`, so **the adapted project keeps the same project `id`**); writes the new spec and validates (`adapt.ts:51-125`).

---

## (f) Review / compare / verify / test / diff

| Tool | Flow | Writes | Evidence |
|---|---|---|---|
| `review` | Loads the render state, runs lint for flags, extracts frames per mode (sheet/strip/crop), tiles and labels them, adds red/amber borders and cue labels | `qa/review/*.jpg`, `qa/lint.*` | `mcp/src/review.ts:105-334` |
| `compare` | Resolves two sides (quality / other project / project-relative file, realpath-confined), copies them as `a.mp4`/`b.mp4`, writes a self-contained HTML player | `qa/compare/{index.html,a.mp4,b.mp4}` | `mcp/src/compare.ts:55-137,157` |
| `verify` | Reuses spec semantic validation; per-scene cited refs, uncovered key claims, ungrounded scenes | `qa/verify.{json,md}` | `mcp/src/verify.ts:109-287` |
| `test` | Samples first frame, scene midpoints and last frame; SSIM against `golden/<q>/` with threshold 0.97; `update: true` clears and re-records the goldens | `qa/test.*`, `golden/<q>/*.png` (update) | `mcp/src/golden.ts:20,120-145,207-270` |
| `diff` | JSON diff of the specs, `video.lock` diff classified (creative/renderer/spec/asset/metadata), sampled frame SSIM with diff images | `<project_b>/qa/diff.{json,md}` + images | `mcp/src/diff.ts:18-19,88,170-271`; `lock.ts:182` |

Retries: none of these tools retry. The skills cap fix loops at 3 passes (`skills/lint/SKILL.md:22-87`, `skills/verify/SKILL.md:26-48`, `skills/plan/SKILL.md:205-212`).

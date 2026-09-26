# Handoff: video-studio (2026-09-26)

**Git:** branch `main`, pushed to https://github.com/harshil-1411/claude_plugin_video_studio (the only branch; no CI, by the user's choice). Latest commits:
- `187e302` README: storytelling in plan, pronunciation overrides; re-rendered narrated hero video
- `f3119eb` readme-hero: caption LLM as one word, spell it out for the voice via brand terminology
- `309f3f9` Motion vocabulary, caption/beat/story lint, storytelling guidance
- `c746147` Schema: scene motion vocabulary

Untracked on purpose: `msb-docs-ebmr-explainer/` (the user's own reel project) and `t.sh` (the user's local helper script). Don't commit them unless asked.

Read this together with `.claude/CLAUDE.md` (architecture rules and commands) and `docs/PLAN.md` (the roadmap). The sections below the status table are the history of how each phase was built.

## Start here: next steps (the user chooses)

1. **The first real reel:** the MSB Docs eBMR page for Instagram, `/video-studio:create ~/Downloads/"MSB Docs eBMR.html" as an Instagram reel`, run by the user in their own terminal (the sandbox can't read `~/Downloads`). Real runs have found a bug every time, so fix whatever it surfaces. Local `.html` ingest was fixed for this.
2. **The one open user-checklist item:** a HyperFrames render with `scene.motion` (`docs/USER_CHECKLIST.md`).
3. **Phase 7**, paid providers, ElevenLabs first (needs the user's API key).
4. **Phase 9**, publishing (needs platform developer accounts). Default targets are Instagram and YouTube Shorts: the user is in India, where TikTok is banned.

## Where things stand

| Phase | State |
|---|---|
| 0 Foundation | Done: pnpm/TS monorepo, zod schemas → `schemas/*.json`, core (cache, SQLite ledger, jobs), MCP server bundled to `dist/mcp.mjs` |
| 1 Ingestion | Done: text, markdown, URL, local `.html`, PDF, DOCX, PPTX, repo, video/audio, clip folders → ContentIR |
| 2 Planning | Done: 18 templates, `plan`/`create`, brief and strict-grounding spec validation, storyboard |
| 3 Local render | Done: `say`/silent voice, FFmpeg + HyperFrames (0.8.78) + footage renderers, captions, assembly, QA, export |
| 4 Platform compiler | Done: per-platform `dist/<target>/`, `video.lock`, lint, verify/test/diff, covers (CI removed by the user) |
| 5 Reel grammar | Done: 15 scene kinds, style packs, CC0 music beds, `voice.mode: none`, variants/adapt |
| 6 Footage | Done: transcribe (whisper.cpp), analyze, shorts, beat sync, scene audio, demo capture, redaction, letterbox crop, tighten |
| 7 Paid providers | **Not started** (needs keys) |
| 8 Localization/launch (local) | Done: script fonts, `localize`, sound-event captions, C2PA, contributor docs, README hero video |
| 9 Publishing | **Not started** (needs accounts) |

Since the loop (2026-09-26): scene transitions, natural macOS voices with `voice.rate_wpm`, `tighten`, camera moves (`scene.motion`), lint timing and story checks (`caption_too_brief`, `caption_sync`, `caption_gap`, `cut_off_beat`, `onscreen_too_brief`, `story_structure`), `skills/plan/references/storytelling.md`, and the narrated hero video. Details are in "Loop state" below.

- **Checks (all green at `187e302`):** 784 tests pass, 5 skipped (env-gated: `VS_TEST_SAY=1` and `VS_TEST_RENDER=1` need outside the sandbox; `VS_TEST_GOLDEN=1` runs anywhere and passes), smoke, both `plugin validate --strict`.
- **MCP tools (26):** adapt, analyze, brief_validate, demo, diff, doctor, export, ingest, job_status, lint, localize, project_init, qa_run, render_submit, schema_get, shorts, spec_scaffold, spec_validate, storyboard_render, template_get, template_list, test, tighten, transcribe, variants, verify.
- **Skills (19):** adapt, analyze, create, demo, diff, doctor, export, ingest, lint, localize, plan, qa, render, shorts, test, tighten, validate, variants, verify.
- **Agents:** source-researcher, creative-director.

## What Phase 4 has built so far

**Spec and brand (step 1)**
- **`VideoSpec`:**
  - `master {width, height, fps: 24|30|60}`. Omitted: `resolveMaster()` gives 1080 px on the short side at 30 fps. Final renders use it; preview renders at half size.
  - `targets[]` of platform contract ids. Omitted: `resolveTargets()` gives `PRIMARY_TARGET[platform]` (`instagram_reels`→`instagram`, `tiktok`→`tiktok`, `youtube_shorts`→`youtube-shorts`, `linkedin`→`linkedin`; `youtube`, `x` and `generic` get none).
  - `cover {headline, focal_time_sec}`.
  - `publish.<target> {post_caption, hashtags[], ai_disclosure}`.
  - `captions.position {y}`: manual placement, the golden lint case.
  - The brief has optional `targets`.
  - The plan skill documents the four separate text channels: voiceover, on-screen text, cover headline and post copy.
- **Brand v2:** `visual.weights`, `visual.font_fallbacks`, `visual.logo_placement`, `visual.forbidden`, `captions {family, weight, active_word, plate_opacity, max_lines}`, `motion {personality, transition_ms}` and `voice.banned_phrases`. v1 files stay valid.
  - **Used so far:** `font_fallbacks`, `captions.*` and `banned_phrases` (checked by lint).
  - **Not used yet:** `motion` and `weights` (Phase 5), `logo_placement`, and `forbidden`.
- **`spec_scaffold`** takes `targets` and emits `master` and `targets`. **`spec_validate`** checks targets against the registry (stage `platform`).

**Platforms (steps 1–2)**
- **`platform-specs/*.yaml`:** instagram, tiktok, youtube-shorts, linkedin, facebook-page-api. Each validates against `schemas/platform-contract.schema.json` (zod source: `packages/schema/src/platform-contract.ts`).
  - Instagram, Facebook Page API, LinkedIn and YouTube Shorts were re-verified against first-party pages on 2026-09-25.
  - **TikTok was not re-verified** (developers.tiktok.com returned 503). Its values come from `deep-research-report_v2.md`, and its notes say so.
  - The UI masks are approximations of each app's UI, not official safe zones.
- **`packages/platforms`:**
  - registry (`findPlatformSpecsDir`, `loadContracts`, `getContract`, `checkSpecTargets`)
  - geometry (`toPx`, `intersect`, `masksFor`, `maskCollisions`)
  - `layoutZones(target, contracts)` returns `content`, `caption` and `hook` rects, shrunk away from error masks (`ZONES_VERSION = 2`).
- **Renderers:** both lay out inside `zones.content` (`safeArea(target, zones?)`, `LAYOUT_VERSION = 3`). They return `text_boxes` (role, rect, font_px, truncated, colours), which flow through the scene sidecar into the manifest `renders[].text_boxes`. `zones` is part of the scene cache key.

**Captions, fonts, covers (step 2)**
- **Caption engine** (`packages/media/src/captions.ts`):
  - phrases of 3–7 words on at most 2 rows (brand `max_lines`), with punctuation-aware breaks
  - a plate behind each row (default opacity 0.55) and keyword emphasis; karaoke only with `active_word: true`
  - placed in `zones.caption`, or centred on `captions.position.y`
  - the manifest records `captions.box` and `max_lines`
- **Fonts:** `fonts/` holds Inter 4.1, Noto Sans 2.015 and JetBrains Mono 2.304 (Regular and Bold, OFL, 2.5 MB; source URLs and sha256 in `fonts/README.md`).
  - `resolveFontFile(family, …, weight)` prefers the bundled files.
  - `fontFaceCss()` feeds HyperFrames, which copies the files in as `assets/fonts/*`.
  - libass gets the fonts through `fontsdir`.
  - FFmpeg headings use weight 700 (`FFMPEG_RENDERER_VERSION` 0.2.0).
- **Cover compiler** (`packages/mcp/src/cover.ts`, `COVER_VERSION = 2`): with `spec.cover`, it writes `cover.jpg` and `cover-square-preview.jpg`. The frame at `focal_time_sec` is blurred and dimmed, and the headline sits on an opaque plate where the hook zone overlaps every crop.
  - The files go to `renders/<q>/`, and export copies them to `dist/`.
  - The manifest records `cover {path, square_preview, at_ms, headline_box, crops}`.
  - Without a cover, the old thumbnail at the hook midpoint is kept.
- **Lint** (`packages/mcp/src/lint.ts`, tool and skill `lint`) writes `qa/lint.json` and `qa/lint.md`. It checks:
  - platform envelopes and text overflow
  - text or captions under masks (golden fixture: `packages/mcp/src/__fixtures__/lint/tiktok-low-captions`)
  - WCAG contrast and reading density (> 3.3 words/s)
  - post-copy limits
  - the cover headline against every crop
  - brand banned phrases

  It reads `renders/<q>/render-state.json`, and `dist/render-manifest.json` only when the qualities match.
- **Visual check** (a copy of `vector-dbs-explainer` with 3 targets, 540×960, silent voice + FFmpeg): captions sit on plates above the bottom UI with emphasis, headings are bold Inter, and the cover is clean inside the square crop. Lint passes for instagram, tiktok and youtube-shorts.

## Step 3 item 1: per-platform dist (done)

- `packages/mcp/src/targets.ts` (`packageTargets`, `planTargetVideo`, `TARGET_PACKAGE_VERSION = 1`), called from `exportFromState` in `pipeline.ts`.
- `dist/<target>/{video.mp4, cover.jpg, captions.srt, captions.vtt, post.json, qa.json}`, plus top-level `video-spec.json` and `storyboard.md` (when `project/storyboard.md` exists). Packages of targets dropped from the spec are removed on export.
- **Video:** copied from the reel unless the contract needs lower fps, a smaller long side, a lower bitrate or a smaller file; then re-encoded (cached in `renders/<q>/targets/<id>.mp4` with a key file). Aspect, minimum size and duration are left to lint. Lint now reports fps above the max and a long side above the max as **warnings** ("export re-encodes"), not errors.
- **`post.json`:** `publish.<target>` when present (`source: "spec"`), otherwise a draft from `socialCopyParts` with the target's own platform hashtags (`source: "generated"`); `full_text` = caption + hashtags; `ai_disclosure {requested, supported, field}`; `cover {mode, file?, timestamp_ms?}`; `limits`. `social-copy.md` is still written (transition period).
- **`qa.json`:** export re-runs `lintProject` for the render's quality and keeps findings for that target plus target-less ones.
- **Manifest:** `FinalOutput` gained optional `target` and `transcoded`; `OutputKind` gained `post`, `qa`, `spec`, `lock`.
- **Skills:** render/export/create now refine post copy by editing `publish.<target>` in the spec and re-exporting (durable), not by editing `dist/social-copy.md`.

## Step 3 items 2–4: lock, verify, test, diff (done)

- **`dist/video.lock`** (`packages/mcp/src/lock.ts`, schema `VideoLock` in `packages/schema/src/video-lock.ts`, `schemas/video-lock.schema.json`). It is deterministic (an unchanged re-export gives a byte-identical lock) and records:
  - `engine` versions and `tools`
  - the voice backend and request hash
  - `fonts` actually used: repo-relative paths for bundled fonts, `host/<basename>` for host fonts
  - each target's `contract_version`/`verified`
  - scene cache keys and clip hashes
  - `assets` (the ContentIR, provenance, brand, brief, storyboard, `assets/` minus `assets/voice/`)
  - `outputs` (the `dist/` files, excluding the lock and the manifest)

  `RenderState` gained `brand_path` and `fonts`.
- **`diffLocks` classes:**
  - creative: spec hash, voice request, scene list
  - renderer: engine, tools, fonts, scene renderer
  - spec: target contracts
  - asset: the ContentIR and assets
  - metadata: quality, project id, and output-only changes

  Changed scene clips and outputs take the class of their cause; a changed clip with no cause is reported as renderer "(non-deterministic render?)". A cache-hit re-render changes only `provenance.json` (metadata), because provenance has `rendered_at`.
- **`verify`** (`verify.ts`, skill `verify`) writes `qa/verify.{json,md}` and reports:
  - claim coverage (claim ids or evidence refs in `claim_refs`)
  - `ungrounded_scene`: an error under strict grounding, a warning under loose; cta/end_card scenes are exempt
  - `uncovered_key_claim`: a warning when a brief `key_messages` entry restates the claim
  - the semantic errors and warnings

  An uncited hook is only a warning, even under strict.
- **`test`** (`golden.ts`, skill `test`): golden frames in `<project>/golden/<quality>/NN-<label>.png` plus `golden.json`, 160 px wide, SSIM ≥ 0.97 (ffmpeg `ssim` filter, `packages/media/src/frames.ts`).
  - Frames are sampled at the first frame, each scene's midpoint and the last frame.
  - Statuses are missing, updated, pass and fail. Failing frames go to `qa/test-frames/`.
- **`diff`** (`diff.ts`, skill `diff`) compares:
  - the specs, with id-matched JSON paths
  - the locks, skipped with a reason when either is missing or the qualities differ
  - frames at matching relative times, skipped when the aspect ratios differ

  It writes b's `qa/diff.{json,md}` and `qa/diff-frames/`. Its work files go under b's `qa/`, not the OS tmp dir, because the MCP server may not inherit `TMPDIR`.
- **Example golden test:** `tests/golden-frames/examples.test.ts` renders a tiny `examples/text-to-motion-graphic` (6 × 0.5 s, 180×320, 15 fps, silent voice, ffmpeg renderer).
  - It is gated by `VS_TEST_GOLDEN=1`, and `VS_UPDATE_GOLDEN=1` records new goldens.
  - The goldens are committed in `tests/golden-frames/text-to-motion-graphic/preview/`; they were recorded in the sandbox on 2026-09-25 and checked by eye.
- **Verified through the bundle** on a 3-target project: export (writes the lock), verify, test (missing → updated → pass) and diff (identical).

## Phase 4 exit (done 2026-09-25)

- **Parts 1–2, run by the user outside the sandbox** (`~/vs-exit/readme-reel`):
  - `pnpm install`, then tests, bundle and smoke all green.
  - `/video-studio:create README.md` with 3 targets and the real `say` voice rendered preview and final.
  - Result: 3 packages plus `video.lock`, and every `qa.json` passes with 0 errors.
- **Parts 3–6, re-run by the coordinator in the sandbox** on a copy (silent voice + ffmpeg):
  - `captions.position.y = 0.9` → lint `caption_mask` error for tiktok (and instagram, youtube-shorts). The fix (remove `position`) → 0 errors in every `dist/<target>/qa.json`.
  - verify passes. test goes missing → updated → pass. diff preview vs final classifies lock changes. The example golden test passes.
- **Bugs this found and fixed:**
  - Lint during export read the caption box from the previous export's manifest, so `dist/<target>/qa.json` was stale. It now prefers `RenderState.caption_layout.box`.
  - diff could not compare preview vs final locks. Export now also writes `renders/<q>/video.lock`, and diff prefers it.
- **CI:** not wanted. The user removed the GitHub Actions workflow on 2026-09-26. The repo lives at https://github.com/harshil-1411/claude_plugin_video_studio (branch `main`). Verify locally instead: typecheck, tests, bundle, smoke, `plugin validate`, and `VS_TEST_GOLDEN=1` golden frames.

## Loop state (autonomous run; resume from here)

Approved plan: `~/.claude-msbector/plans/lets-plna-to-complete-mutable-mochi.md` (Phases 4 → 5 → 6 → local 8, no human intervention; Phase 7, Phase 9 and CI are out of scope).

- **Current:** the loop and the user checklist are **complete**. After the checklist (2026-09-26):
  - **Fixed from real runs:** caption plates without dark bars; demo capture at phone width; `footage.redact`; shorts copy only their span; true-peak headroom; strict letterbox cropping.
  - **Polish:** scene video transitions; natural voices (Premium/Enhanced picked automatically, `voice.rate_wpm`, default 160, doctor `system_voice`); the narrated hero video (`examples/readme-hero`); local `.html` ingest.
  - **New:** HyperFrames 0.8.78, and `tighten` (pauses, fillers and retakes → a new `<asset>-tight`).
  - **Hero video re-rendered (2026-09-26):** the narrated `docs/media/hero.mp4` captions "LLM" as one word; the voice spells it out through brand `language.terminology`.
  - **Student-kit ideas (2026-09-26):**
    - `scene.motion` {push_in, pull_out, punch, reveal, drift, hold} × {subtle, normal, strong} in all three renderers. The same amounts are used everywhere (`SCENE_MOTION_AMOUNT`). Versions: ffmpeg renderer 0.4.1, footage 0.2.1. Scenes without motion render byte-identically. Text boxes record the rest pose.
    - Lint timing checks from `renders/final/render-state.json`: `caption_too_brief`, `caption_sync`, `caption_gap`, `cut_off_beat` (needs `beat_sync.beat_times_ms`, recorded from now on), `onscreen_too_brief`.
    - `story_structure`: tension in the first 40% after the hook, and a payoff right before the CTA. All 18 templates were reworked to pass it at every length (a test in `plan.test.ts`).
    - `skills/plan/references/storytelling.md` covers the arc and the story move → purpose/motion/transition map. `punch`/`reveal` are entered on a `cut`, because blending transitions hide them.
    - A HyperFrames motion render is unverified in the sandbox (checklist).
  - **Next:** see "Start here" at the top.
- **Done:**
  - Step 0 (Phase 4 closed).
  - Phase 5 step 1 (`489dbbd`): schema for the new purposes and kinds, `audio.music`, `voice.mode` and `Style`.
  - Phase 5 steps 2–3 (`db94d16`):
    - 7 new kinds in both renderers
    - `music/` CC0 beds with ducking
    - `voice.mode: none`
    - background-aware black-frame QA, with `QA_VERSION`
  - Phase 5 steps 4–6 (`58b72b0`):
    - `styles/` packs and motion tokens in both renderers
    - 8 archetype templates (13 in total)
    - `variants` and `adapt` tools and skills
  - **Phase 5 exit passed (2026-09-25, sandbox, silent voice + ffmpeg, preview):**
    - The repo README was ingested, and specs were written for 3 archetypes (animated-explainer, faceless-listicle, before-after) × 2 styles (technical, energetic). That gives 6 renders; each lints 0/0 and has 3 platform packages.
    - `variants` with 3 hooks × 2 covers gave 6 variant projects, all rendered, with `experiment.json` reporting each as `rendered`. A fresh variant re-renders only its hook (5 of 6 scenes reused).
    - A `voice: none` text-over-music reel on `bundled:lofi` has only a frozen-frames warning (no silence or loudness warnings) and lints 0/0. The CC0 licence is in `video.lock`, provenance and `post.json`.
    - The exit found a bug: `fitText` hard-broke long words ("Thumbnai/l"). Now whole words must fit, and breaks inside a word only happen at the minimum size (`LAYOUT_VERSION` 5).
  - Phase 6 (`83a5219`, `7a74a80`, `cf1b51e` + close):
    - **Ingest and analysis:**
      - video/audio ingest (shots, keyframes, loudness), and a folder of clips expands to its media files
      - `transcribe` (whisper.cpp or SRT/VTT; sentence evidence refs `video:<file>#t=a-b`)
      - `analyze` (clean-room format grammar)
      - `shorts` (scored spans; `make_projects` writes `shorts/<id>/` talking-head projects)
    - **Rendering and audio:**
      - the footage renderer (fits, trim/speed/hold/loop, stills, text overlays)
      - scene audio (native/mix/music/mute, crossfades, sfx)
      - `voice.mode: native` captions from transcripts
      - beat detection and beat-synced cuts
    - **Tools and templates:**
      - `demo` capture (system Chrome through runtime puppeteer-core, inputs blurred, steps as evidence)
      - 5 footage templates (18 in total)
  - **Phase 6 exit passed (sandbox):**
    - A 60 s synthetic interview (4 shots + the JFK sample): ingest, then whisper transcribe (88 words, CPU), then `shorts` gave 3 candidates and 3 projects. `short-1` rendered with cover-cropped footage, native audio and transcript captions.
    - A folder of 6 clips (ingested as a folder) became an aesthetic-broll reel on `bundled:upbeat` with beat sync (5 cuts moved onto 120 bpm beats), −13.8 LUFS.
    - A silent-vlog reel with native ambient sound, 300 ms crossfades and a lower third over the footage: QA pass, −14.0 LUFS.
    - Demo capture against a real app: user checklist (no Chrome in the sandbox).
  - Phase 8, local subset (`58921e9`, `5eb08dd` + close):
    - **Multilingual:**
      - Noto Sans JP, Devanagari and Arabic bundled, with script detection and script-first font chains
      - CJK kinsoku breaking; Devanagari/Arabic/Hebrew drawn through libass, since this drawtext does not shape them
      - HyperFrames gets `lang`/`dir`
      - per-language system voices (ja → Kyoko; no Hindi voice → silent with a reason)
      - per-script speech and reading rates
    - **Tools:**
      - `localize` (translation sheet → `localized/<lang>/`, apply re-times and validates)
      - sound-event captions (`[music]`, sfx captions, `[ambient sound]`)
      - `export sign` for C2PA via c2patool (test certificate)
    - **Fixes, docs and media:**
      - libass captions now get a flat fonts folder; the bundled caption fonts had never loaded before (`ASSEMBLY_VERSION` 3)
      - complex-script cover headlines drawn with libass (`COVER_VERSION` 3)
      - `docs/contributing/`, a README rewrite, and `docs/media/hero.mp4` made by the plugin
  - **Phase 8 exit passed (sandbox):** the Whisper paper PDF (arXiv 2212.04356) became an English explainer grounded in 3 evidence spans, then `localize` gave hi-IN (38 s after re-timing) and ja-JP (32 s).
    - All three render and lint with 0 errors and 0 warnings for youtube-shorts, tiktok and instagram.
    - Frames and covers were checked by eye: shaped Devanagari, CJK line breaks, no tofu.
    - A signed EN export has 5 videos with valid C2PA (test certificate untrusted, as expected).
  - **Not done in Phase 8 (out of scope or needs a person):** face-collision avoidance (no vision model), the Remotion renderer (licence plus a new install), community marketplace submission, and Hebrew/Korean/Thai fonts.
- **Deferred to `docs/USER_CHECKLIST.md`** (written at the end):
  - real `say` renders
  - HyperFrames install and renders of new kinds and styles
  - demo capture against a local app
  - a real interview mp4

**Loop decisions** (defaults chosen without asking; revisit if needed):
- Phase 4 Parts 3–6 were verified in the sandbox instead of interactively.
- Music beds are synthesized in-repo (`scripts/generate-music.mjs`), CC0, 16–32 s seamless loops at about −20 LUFS. The mix is normalised to −14 LUFS.
- Ducking uses the known speech intervals (scene voice slots), not a sidechain compressor, so it is exact and deterministic.
- On-screen reading rule without narration: at most 3 words/s after a 1 s settle (a design constant in `lint.ts`).
- Strict grounding now also reads viewer-facing props text (stat values, quotes), so a numeric stat card needs a `claim_ref`.
- **Scene transitions (added 2026-09-26):** the assembly draws each scene's `transition` (crossfade, fade_black, slide, zoom, whip), or else the style pack's default, over `transition_ms`, clamped to 40% of the incoming scene. It is timeline-preserving: the incoming scene starts on its boundary while the outgoing last frame is held, so speech and captions stay in sync. Styles that blend skip the per-scene exit fade (`LAYOUT_VERSION` 7).
- A style change is classified as creative in lock diffs (`tools.style`).
- Video footage is always marked `contains_likeness` (there is no face detection).
- `crossfade_ms` crossfades scene audio; video transitions come from `transition`.
- Looped footage tails get no captions.
- ingestion now depends on `@video-studio/media` through a hand-made symlink; **`pnpm-lock.yaml` needs `pnpm install` outside the sandbox** (checklist).
- The whisper model pin is sha256 `a03779c8…d002` (`ggml-base.en.bin`, 147,964,211 bytes).
- **Unverified in the sandbox** (goes to `docs/USER_CHECKLIST.md`):
  - HyperFrames renders of the new kinds and styles; the stat count-up relies on CSS animation seeking.
  - Whether HyperFrames' own font fitting also keeps long words whole.

**Open decisions from step 3** (defaults chosen; revisit if needed):
- "Key claims" means claims restated by the brief's `key_messages`.
- A ContentIR change appears twice in a lock diff (`content_ir_sha256` and `assets.source/content-ir.json`).
- The lock's `spec_sha256` is the rendered spec, while its targets and outputs follow the spec at export time.
- `lockFonts` re-hashes host fonts on every export; cache it if it gets slow.

## Environment facts that shape everything

- **No provider keys** (ElevenLabs, Runway, HeyGen, fal). The user declined large model downloads (Kokoro, whisper models), so any download must be asked for first. The bundled fonts were part of the planned M8.
- **Low-RAM laptop.** Run at most 2 agents at once, and check `memory_pressure | tail -1` and `uptime` before spawning. Use tiny media in tests: ≤ 320 px, ≤ 3 s, 15 fps. Never run two renders at once.
- **The Claude Code Bash sandbox blocks:**
  - macOS `say` (it writes an empty file)
  - headless Chrome
  - pnpm installs of packages that contain `.gitmodules` (give the user a `!` command)
  - `pnpm install` in general, so new workspace packages get hand-made symlinks in `packages/*/node_modules/@video-studio/`; `pnpm install` recreates them
  - writes to the Claude memory dir via Bash (use Edit/Write)
  - writes to `~/.video-studio`: the dev CLI `scripts/render-project.mjs` then prints `ledger write failed … readonly database`. It is harmless and the render succeeds.
- **Rendering in the sandbox:** use `--voice silent --renderer ffmpeg`. The plugin's MCP server runs outside the sandbox for the user, so `say` and Chrome work there.
- **Chrome on macOS:** plain `chrome --headless --dump-dom` hangs for 45 s or more. The HyperFrames probe launches Chrome through the producer's `puppeteer-core` instead (about 0.6 s). The diagnostic is `node scripts/diagnose-chrome.mjs`.
- **HyperFrames:** never bundled. It is installed at `~/.video-studio/deps` (dev) or `${CLAUDE_PLUGIN_DATA}/deps` (plugin) with `PUPPETEER_SKIP_DOWNLOAD=1 npm i @hyperframes/producer@0.8.78 --prefix deps`.
- **Duplicate "engine" MCP server:** the repo root is also the plugin root. `plugin:video-studio:engine` works. The project-scope `engine` fails with CONNECTION_CLOSED and is harmless; keep it in `disabledMcpjsonServers` in `.claude/settings.local.json`.
- **pnpm:** the store is pinned in the repo (`storeDir: .pnpm-store`) so sandboxed and unsandboxed installs agree.

## Open issues

0. **From the first real `shorts` run (2026-09-26), all fixed the same day:**
   - ~~No footage redaction~~ → `footage.redact: [{x, y, w, h, from_sec?, to_sec?, mode: blur|box, label?}]`, in source-frame fractions and asset seconds, applied before the fit (heavy gblur or a solid box).
   - ~~Short projects copy the whole recording~~ → each `shorts/<id>/` gets only its span ± 1 s (re-encoded), with its own ContentIR, the transcript shifted, and footage times relative to the clip.
   - ~~True peak 0.1 dB over~~ → loudnorm now aims at −1.5 dBTP (`ASSEMBLY_VERSION` 5).
   - **Letterboxed footage** (from the b-roll run): ingest records `media.content_box` from a *strict* detector, and the footage renderer (0.2.0) crops to it before the fit. The detector requires near-black borders (luma ≤ 16), agreement across 5 samples, and symmetric bars. The run's "barred" wave clip was really a dark window frame, and a naive `cropdetect` would also have cropped a night-sky fireworks clip. Both are correctly left alone.

1. **TikTok contract not re-verified.** Re-check `platform-specs/tiktok.yaml` against developers.tiktok.com and bump `contract_version`/`verified`.
2. ~~Deprecated caption helpers~~: already removed.
3. **Brand v2 fields not used yet:** `logo_placement` and `forbidden` (no lint check yet). `motion` and `weights` are used (`packages/renderer/src/tokens.ts`).
4. **HyperFrames 404.** HyperFrames logs a non-blocking 404 for one resource, probably a favicon or font lookup. Re-check now that fonts are embedded.
5. **QA noise in silent mode.** Silent-voice renders report `silence`/`loudness` warnings in `qa/report.md`; they are labelled "expected" only in `job_status`.
6. **No render lock.** There is no cross-process lock, so two Claude sessions could render at the same time.
7. **Scenes open empty.** Scenes fade in from an empty first frame (Phase 5 motion work).
8. **Spec vs. actual timing.** The render plan lengthens scenes to fit the voiceover and records `timing_adjustments`; the spec is left unchanged by design.
9. **Lockfile:** refreshed by the user on 2026-09-25 (`0958554`); 2 harmless orphan `@secretlint/node` entries remain.
10. **Warnings.** Node prints an `ExperimentalWarning` for `node:sqlite`. It is harmless.

## How work is run

- **Coordinator + at most 2 `general-purpose` agents.** Each agent gets exact file ownership (no two edit the same file), "no `pnpm install`", targeted tests only, and a short final report. The coordinator writes and commits any shared interface (schema, types, stubs) before agents start. Agents never commit.
- **After agents finish:** `npx tsc -b`, the full `npx vitest run`, rebuild the bundle (`cd packages/mcp && ../../node_modules/.bin/tsdown`), `node scripts/smoke-mcp.mjs`, `claude plugin validate --strict .claude-plugin/plugin.json` and `claude plugin validate --strict .`, then commit.
- **Visual checks:** render a copy of a project in the scratchpad (`node scripts/render-project.mjs <dir> --voice silent --renderer ffmpeg --quality preview`), extract frames (`ffmpeg -ss T -i dist/reel.mp4 -frames:v 1 x.png`) and look at them. This is how the cover-headline overlap was found in step 2.
- **Regenerate schemas** after any zod change: `npx tsc -b && node packages/schema/dist/emit.js` (a test fails if they are stale).

## Commands the user runs outside the sandbox

```
pnpm install && git add pnpm-lock.yaml                                                                  # refresh the lockfile (issue 9)
node scripts/render-project.mjs examples/text-to-motion-graphic --voice system --renderer hyperframes   # real voice + HyperFrames
VS_TEST_SAY=1 npx vitest run packages/voice/src/system.test.ts
VS_TEST_RENDER=1 npx vitest run packages/renderer/src/hyperframes
node scripts/diagnose-chrome.mjs
claude --plugin-dir .    # then /video-studio:doctor, /video-studio:create ..., /video-studio:lint
```

## Document map

- `docs/PLAN.md`: the roadmap, including the gap analysis and M1–M9.
- `.claude/CLAUDE.md`: rules and commands for Claude sessions.
- `deep-research-report_v2.md`: v2 strategy (platform compiler, lint, grammar).
- `deep-research-report.md`: v1 strategy (provider-neutral compiler).
- `reports/Video studio implementation specs.md`: verified API and plugin facts. Where they conflict, it overrides v1.
- `platform-specs/README.md`: contract rules. `fonts/README.md`: font sources and hashes.
- `packages/renderer/README.md`: the two renderers and their gated tests.

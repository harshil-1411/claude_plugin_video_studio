# Changelog

All notable changes to video-studio. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may change behaviour).

## [0.3.0] - 2026-09-27

The directed-motion release (Phase 6.5): Claude can now write a scene as code, and the engine
holds reels to measurable pacing instead of accepting card-per-scene slideshows. Also the local
first step of Phase 7: provider-neutral shot cards compiled into prompt packs, with no keys and no
spend. Built from motion-design research (2026-09-27).

### Added
- **`motion` scenes: Claude-authored code**
  - A scene can be an HTML page Claude writes, drawn by a pure `window.seek(t)`. The engine injects
    a strict Content-Security-Policy, the brand tokens, the copy and the music's beat grid
    (`window.__vs`), and a small kit (closed-form springs, easings, seeded random numbers, beat
    helpers).
  - A static check (acorn) rejects network access, clocks, unseeded randomness, timers and CSS
    animations before anything renders; HyperFrames refuses unsafe pages, and the ffmpeg renderer
    draws a reported text stand-in.
  - A determinism check seeks the page in different orders before each render and fails pages
    whose frames depend on anything but `t`; loop scenes are checked for a clean seam.
  - `stills`: frames at chosen times, beats or downbeats, tiled into a review sheet before the full
    render.
  - `master.motion_blur`: the producer's native sub-frame blur for `motion` scenes in final renders.
  - `skills/plan/references/code-motion.md`: the contract, the kit and the craft rules.
- **Pacing you can measure**
  - QA `motion_density` (big visual changes per second) and `longest_static`; `frozen_frames` now
    fails above 15% of the runtime (or `acceptance.max_frozen_pct`).
  - `acceptance` numbers on the brief and spec (changes per second, frozen %, holds, loop); the plan
    skill turns vague asks into them, and lint reports `acceptance_unmet`.
  - `compare` against a reference video, with a metrics table and meets/misses verdicts.
  - Loop mode (`master.loop`): first/last frame SSIM and the audio seam are checked.
- **Music and beats**
  - Beat analysis v2: downbeats, bar energy, the drop and half/double-time readings; cuts can snap
    to downbeats; sound effects land on their measured peak.
  - `synth:<preset>` scores (pulse, lofi, ambient, drive): synthesized locally with ffmpeg only,
    byte-identical every run, CC0, with an exact beat grid.
- **Planning**
  - Templates can ask for inputs first (reference video, photo, real UI states, brand, track) and
    carry density targets; the create skill shows a beat-level plan at the approval gate.
  - Six templates: `ui-morph-loop`, `kinetic-type`, `ambient-loop`, `slides-narrated`,
    `topic-explainer-9`, `product-hero` (24 in total).
  - Style packs ban templated effects (`motion.avoid`); lint reports `banned_effect`.
  - `variants` can cut the same spec to several lengths (e.g. 15 s and 30 s).
  - Series bibles (`series.yaml`): recurring characters, locations, motifs and look shared by
    episodes; editing one character re-renders only the scenes that show it.
- **Prompt packs (Phase 7 step 0)**
  - `ShotCard` on generated scenes, and `provider-specs/*.yaml` for Seedance, Veo, Kling, Wan,
    Runway and Hailuo (sourced and dated, unverified until Phase 7 re-checks them; no Sora).
  - `prompt_pack` compiles each shot into every family's prompt syntax with director checks,
    offline: nothing is generated or spent.
- **Keys**: optional placeholders for the direct generator APIs and for publishing (YouTube,
  Instagram, LinkedIn, TikTok). They do nothing until their integration ships; `doctor` shows
  which are set, never their values.

### Changed
- QA no longer calls frozen frames "expected" for motion graphics.
- Style packs are version 2.
- Still captures launch Chrome exactly like the HyperFrames producer, bound every step with a
  deadline, and retry a stalled launch.

## [0.2.0] - 2026-09-26

The audit release: everything found by the forensic audit (`audit/MASTER-PLUGIN-AUDIT.md`) from P0
to P2 is fixed, plus footage features for repurposing real video.

### Added
- **Footage workflow**
  - Video URLs: YouTube, Vimeo and Loom through your `yt-dlp`, and direct media links. Downloaded
    subtitles become the transcript.
  - Multilingual transcription (`language`, auto-detection, multilingual whisper model).
  - Speaker turns (tinydiarize, English), labelled S1/S2. Captions break at speaker changes, and
    `shorts` can filter by speaker.
  - `footage_look` gives Claude a labelled shot sheet plus the transcript for a time range;
    `footage_notes` stores per-shot notes.
  - Subject-aware reframing: `footage.focus_track`, suggested by `footage_focus` using macOS Vision.
  - Footage quality checks at ingest (exposure, contrast, clipping, speech clarity), with rotation
    and HDR handling.
- **Review and checks**
  - `review` contact sheets, strips and crops, with lint-flagged scenes bordered.
  - `compare`: a before/after page.
  - An automatic review → fix → re-render loop in the render and create skills.
  - Lint rules: word-cue timing, caption readability and sync, cuts on the beat, story arc, cutaway
    rhythm, text repeating captions, logo overlap, forbidden brand treatments, subject near the
    crop edge, footage quality.
- **Craft**
  - Word cues: graphics land on spoken words.
  - Talking-head cutaways and camera moves.
  - Count-ups in both renderers.
  - Scenes no longer open on an empty frame.
  - Brand corner logo.
  - Per-scene `burn_captions`.
- **Voice**: whisper aligns system-voice word timings to the audio, so captions and cues land
  exactly.
- **Control**
  - `policy.yaml` is enforced: paid voices only when allowed, spend limits, approval thresholds.
  - Consent through Claude Code's approval dialog (MCP elicitation) for model downloads, demo
    capture and paid synthesis, recorded in `project/consent.json`.
  - `render_cancel`, and clean shutdown (renders abort and ffmpeg children are killed).
  - `source_summary` / `source_section`: read sources without loading the whole ContentIR.
- **Project**
  - `pnpm check` (every check, stops at the first failure) and a pre-push hook (`pnpm hooks`).
  - Community files: `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, GitHub templates.

### Changed
- `ingest` merges into the existing ContentIR, keeping ids and refs; `replace: true` starts over.
- `voice: auto` no longer uses a paid voice just because a key is set.
- Tool results are compact: one text block plus structured content (30–60% smaller). `job_status`
  returns deltas with `since`.
- The render pipeline is split into stage functions. Scenes render in parallel when memory allows.
  The logo costs no extra encode.
- The README Quick start is marketplace-first.

### Fixed
- Replacing a screenshot or logo image no longer reuses a stale scene clip.
- `job_status` after an engine restart no longer fails.
- A failing paid voice falls back to the system voice before silence.
- Missing, binary, image and credential files are refused instead of being ingested as text.
- Footage pointing at an audio file gets a precise error.
- Stale help text in skills; unused provider keys are marked in the plugin config.

### Security
- URL ingest refuses private, loopback and link-local addresses on every redirect and pins the
  connection.
- Paths (logo, captions file, demo script, images) are confined to the project, with symlinks
  resolved.
- Secrets in any source are redacted in the ContentIR and cache.
- Local HTML is capped at 20 MB.
- Demo `goto` steps stay on the start origin.
- Review labels don't expand `%{…}`.

## [0.1.0] - 2026-09-25

First version: ingest (text, Markdown, PDF, DOCX, PPTX, URLs, repos, video/audio) → grounded
VideoSpec → local render (FFmpeg and HyperFrames, 15 scene kinds, 4 styles, music beds, captions,
covers) → lint and QA → per-platform packages with `video.lock`; `verify`, `test`, `diff`,
`variants`, `adapt`, `localize`, `shorts`, `tighten`, `demo`, C2PA signing.

[0.2.0]: https://github.com/harshil-1411/claude_plugin_video_studio/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/harshil-1411/claude_plugin_video_studio/releases/tag/v0.1.0

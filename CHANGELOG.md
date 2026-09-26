# Changelog

All notable changes to video-studio. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may change behaviour).

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

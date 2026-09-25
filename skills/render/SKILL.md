---
name: render
description: Render a planned video-studio project (project/video-spec.json) into a finished package in dist/ - captioned 9:16/16:9 reel, clean master, SRT/VTT captions, transcript, thumbnail, social copy, render manifest and provenance - using only local tools (system TTS or silent voice, HyperFrames or ffmpeg motion graphics). Use when the user runs /video-studio:render, approves a plan, or asks to render, preview or export the video.
license: Apache-2.0
compatibility: Requires the video-studio plugin's bundled `engine` MCP server (Node.js 22.13+) and ffmpeg with libass and libx264.
allowed-tools: mcp__plugin_video-studio_engine__spec_validate mcp__plugin_video-studio_engine__render_submit mcp__plugin_video-studio_engine__job_status mcp__plugin_video-studio_engine__qa_run mcp__plugin_video-studio_engine__export mcp__plugin_video-studio_engine__doctor Read Write Edit
---

# Render a video

Rendering is local and free: no paid API is called unless an ElevenLabs key
is configured (then `voice: "auto"` uses it). Work in the project folder
that holds `project/video-spec.json`; pass absolute paths.

## 1. Check the spec

Call `spec_validate {project_dir}`. If `ok` is false, list the errors with
their fixes and stop (or fix them per the plan skill and re-validate).
`render_submit` refuses an invalid spec anyway.

## 2. Preview first

Call `render_submit {project_dir, quality: "preview"}` (voice and renderer
default to `auto`). It returns a `job_id` immediately. Only pass `voice` /
`renderer` if the user asked (`silent` for no narration, `ffmpeg` to skip
HyperFrames). `burn_in_captions: false` keeps captions only as sidecars.

## 3. Poll

Call `job_status {job_id}` every 10-20 seconds. Tell the user the stage in
one short line when it changes (voice, scene 3/6, assemble, QA, export); do
not repeat identical updates. A preview of a 30 s reel usually takes well
under a minute; a final render several minutes. Other submissions queue:
only one render runs at a time. `interrupted` means the engine restarted:
submit again (all finished work is cached).

## 4. Present the result

From `result`:

- **Files**: `dist/reel.mp4` (size, duration, resolution, preview/final),
  then one line per platform package in `dist.targets[]` (`dist/<id>/`:
  video, cover, captions, `post.json`, `qa.json` status; say when the video
  was re-encoded and why), and the other `dist/` files in one line. When the spec has a `cover`, mention
  `dist/cover.jpg` (the headline cover) and `dist/cover-square-preview.jpg`
  (how it looks cropped to a square grid tile); open both with Read to check
  the headline is legible.
- **QA**: `pass`, or each finding as `id: detail` with its fix. With the
  silent voice, `silence` and `loudness` warnings are expected; frozen
  frames are expected for static motion-graphic scenes. Report `fail`
  findings prominently.
- **Voice and renderer used, and why**: quote `voice.reason` and
  `renderer.reasons` briefly. If the voice fell back to silent, say why
  (e.g. no system TTS in this environment) and how to get narration
  (`voice: "system"` on macOS/Linux, or an ElevenLabs key via `/plugin`).
  If HyperFrames was skipped, say the ffmpeg renderer drew the scenes and
  offer the optional setup below.
- **Timing adjustments**: scenes whose narration ran long were extended in
  the render only; suggest updating `duration_sec` in the spec or trimming
  the line.
- **Placeholders**: scenes that need a video provider were drawn as titled
  cards (provider rendering arrives in a later phase).

## 5. Final render and export

Ask whether to render the final version. On approval call
`render_submit {project_dir, quality: "final"}` and poll again.

Then refine the post copy per target. Each `dist/<target>/post.json` has the
copy for that platform (`source: "generated"` is a deterministic draft) and
its `limits`. Write the refined copy into `project/video-spec.json` as
`publish.<target> {post_caption, hashtags, ai_disclosure}` (brief's tone,
the desired action, 3-6 relevant hashtags, claims only from the sources,
within `limits`), then run `export` again so every `post.json` picks it up.
Editing the spec is durable; `dist/` files are regenerated on each export.
`qa_run {project_dir}` re-checks the reel.

## Optional: HyperFrames renderer

Richer motion graphics need `@hyperframes/producer` and Google Chrome. The
engine never installs it by itself. If the user wants it, they run:

```
cd "${CLAUDE_PLUGIN_DATA}" && PUPPETEER_SKIP_DOWNLOAD=1 npm i @hyperframes/producer@0.8.75 --prefix deps
```

then `/video-studio:doctor` (check `hyperframes`) and re-render with
`renderer: "auto"` or `"hyperframes"`.

## Errors

- Tools missing: suggest `/video-studio:doctor` and `/mcp`.
- ffmpeg missing or without libass/libx264: run the doctor and follow its fix.
- A scene failed to render: show its reason; retry with `renderer: "ffmpeg"`.

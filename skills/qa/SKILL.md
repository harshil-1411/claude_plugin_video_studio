---
name: qa
description: Re-run technical QA on a rendered video-studio project - resolution, aspect, duration, codecs, black and frozen frames, silence and loudness against -14 LUFS - and explain each finding with its fix. Use when the user runs /video-studio:qa or asks whether a rendered reel is ready to post.
license: Apache-2.0
compatibility: Requires the video-studio plugin's bundled `engine` MCP server (Node.js 22.13+) and ffmpeg.
allowed-tools: mcp__plugin_video-studio_engine__qa_run mcp__plugin_video-studio_engine__review Read
---

# Check a rendered video

1. Use the project folder the user named, else the cwd (absolute path). It
   must have been rendered (`render_submit`); otherwise offer the `render` skill.
2. Call `mcp__plugin_video-studio_engine__qa_run {project_dir}` (add
   `quality: "final"` or `"preview"` to pick a render; default is the latest).
3. Report the status (`pass`, `warn`, `fail`) and each finding as
   `id: detail`, with its fix. Context:
   - `silence` / `loudness` warnings are expected when the voice was silent.
   - `frozen_frames` is expected for static motion-graphic scenes.
   - `duration`, `resolution`, `aspect`, `black_frames` or `audio_stream`
     failures mean the reel is not ready: suggest re-rendering (cached work is
     reused) and, if it persists, `/video-studio:doctor`.
4. The full report is in `qa/report.md`; `dist/render-manifest.json` now
   carries the new QA summary.

---
name: qa
description: Re-run technical QA on a rendered video-studio project - resolution, aspect, duration, codecs, black and frozen frames, motion density, the loop seam, silence and loudness against -14 LUFS - and explain each finding with its fix. Use when the user runs /video-studio:qa or asks whether a rendered reel is ready to post.
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
   - With the silent voice (or `voice.mode: none` and no music), silence and
     loudness are reported as not measured, never as warnings.
   - `frozen_frames` fails when frozen time (still for 1 s or more) exceeds
     `acceptance.max_frozen_pct` of the runtime (default 15%). It is never
     "expected": a frozen reel reads as a slideshow. Fix the listed stretches
     with motion (a `motion` scene, camera moves, staged reveals) or cut them.
   - `motion_density` (big visual changes per second, from scene-change
     detection) and `longest_static` (longest stretch with no big change)
     fail only against the spec's `acceptance.min_changes_per_sec` and
     `acceptance.max_static_sec`; otherwise they are reported for context.
     Smooth continuous motion is not a "big change"; cuts, reveals and new
     states are. `hold` checks `acceptance.hold_ms` the same way.
   - `loop_seam` (with `master.loop`): the last frame must match the first
     (SSIM ≥ 0.99) and the audio level must not jump across the seam
     (under 6 dB).
   - `duration`, `resolution`, `aspect`, `black_frames` or `audio_stream`
     failures mean the reel is not ready: suggest re-rendering (cached work is
     reused) and, if it persists, `/video-studio:doctor`.
4. The full report is in `qa/report.md`; `dist/render-manifest.json` now
   carries the new QA summary.

---
name: qa
description: Re-run technical QA on a rendered video-studio project - resolution, aspect, duration, codecs, black and frozen frames, motion density and moving share, the loop seam, flashing, audio/video sync, silence and loudness against -14 LUFS - and explain each finding with its fix. Use when the user runs /video-studio:qa or asks whether a rendered reel is ready to post.
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
   - `moving` (the share of frames where the picture moves at all, frame to
     frame) complements `motion_density`: a slow zoom, drift or crossfade
     counts as moving on every frame but is not a big change, while a hard
     cut is a big change but only one moving frame. A cut-only slideshow
     scores high changes/s and a low moving %; a slow Ken Burns the reverse.
     It fails only below `acceptance.min_moving_pct`. Fix: keep the holds
     alive (a slow camera move, easing elements, a crossfade).
     `moving` and `frozen_frames` can both be high: frozen means the whole
     frame barely changes, moving means anything changes (luma). High on
     both = only small parts move (a breathing glow, a blinking cursor)
     while the frame reads as still; give those stretches a bigger change.
   - `loop_seam` (with `master.loop`): the last frame must match the first
     (SSIM ≥ 0.99) and the audio level must not jump across the seam
     (under 6 dB).
   - `flashing`: fails above 3 flashes in any 1 s window (no acceptance
     override; flashes that fast can trigger seizures) and warns on
     single-frame luma spikes (a lone white or black frame mid-clip). It is
     measured on each frame's mean luma, an approximation of WCAG 2.3.1
     general flashes: a flash in part of the frame counts less, and red
     flashes are not measured, so say so when the reel has strobing red.
     Fix: slow the flashing to 3/s or less, lower its contrast or shrink it;
     replace or fade a lone spike frame (`qa/report.md` lists the times).
   - `av_sync`: the audio must start within one frame of the video (fail)
     and last as long as the video's frames, within one frame plus 10 ms
     (warn). Not applicable without an audio track. Renders so far measured
     a 0 ms offset; on a failure, report the measured offset, re-render and,
     if it persists, run `/video-studio:doctor` (the ffmpeg build).
   - `duration`, `resolution`, `aspect`, `black_frames` or `audio_stream`
     failures mean the reel is not ready: suggest re-rendering (cached work is
     reused) and, if it persists, `/video-studio:doctor`.
4. The full report is in `qa/report.md`; `dist/render-manifest.json` now
   carries the new QA summary.

---
name: tighten
description: Tighten talking-head footage from its transcript - shorten long pauses, cut filler words (um, uh), and drop false starts and retakes - as a new, cleaned copy of the clip. Use when the user runs /video-studio:tighten, or asks to clean up a recorded talk, demo narration or interview before making shorts or a reel.
license: Apache-2.0
compatibility: Requires the video-studio plugin's bundled `engine` MCP server (Node.js 22.13+) and ffmpeg.
allowed-tools: mcp__plugin_video-studio_engine__tighten mcp__plugin_video-studio_engine__transcribe mcp__plugin_video-studio_engine__ingest Read
---

# Tighten a recording

1. The recording must be ingested and transcribed (`ingest`, then
   `transcribe`; ask before any whisper model download). Use its asset id.
2. Dry run: `tighten {project_dir, asset}`. Show the user the summary:
   total length before → after, pauses shortened, and **every** filler and
   retake cut with its time and words.
   Also show the join check (`joins`): every `partial_word` (a cut inside
   a word) and `repeated_word` (the same word on both sides of a join) with
   its time and fix (the cut moved to the nearest word gap).
3. Let the user adjust before applying:
   - "keep the pauses" → `silences: false`, or a gentler
     `max_pause_ms: 1200`
   - "pace it like my other videos" → `pacing_from`: an `analyze` result in
     the project (`qa/analysis.json`, from a video the user edited) or the
     asset id of such a video. It sets `max_pause_ms` to their p95 pause
     (clamped to 250–1500 ms) and `keep_pause_ms` to their median pause
     (120–600 ms); explicit values win. Report the numbers (`pacing`).
   - "don't cut retakes" → `retakes: false`, if a "false start" was intentional
   - a retake detection that is wrong: turn retakes off; never hand-edit cuts
4. Apply: `tighten {project_dir, asset, …same options, apply: true}`. It
   writes a new asset `<asset>-tight` (the original is kept) with the
   transcript re-timed, so captions and `claim_refs` line up with the new cut.
   - Apply refuses while a `partial_word` remains. Usually the transcript's
     timings are off there: re-transcribe, or change the options. Pass
     `force: true` only when the user has heard the join and accepts it.
   - With whisper installed, apply re-transcribes ±2 s around every join
     (`asr_check`): report each `join_mismatch` (expected vs heard words)
     so the user can listen to it. `not_run` gives the reason (no whisper,
     no model); it is not an error.
5. Next: `shorts` or a talking-head / silent-vlog spec on `<asset>-tight`.
   Suggest watching the tightened clip once: word-timing cuts are precise to
   whisper's timestamps, and a rare cut can clip the edge of a word that the
   join check cannot see.
   For a video, the `compare` skill builds a before/after page for that:
   `a: {file: <the original's project-relative path>}` against
   `b: {file: <the path tighten returned, source/assets/<asset>-tight.mp4>}`,
   played in sync, so the user can hear each cut against the original.

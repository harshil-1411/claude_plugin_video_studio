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
3. Let the user adjust before applying:
   - "keep the pauses" → `silences: false`, or a gentler
     `max_pause_ms: 1200`
   - "don't cut retakes" → `retakes: false`, if a "false start" was intentional
   - a retake detection that is wrong: turn retakes off; never hand-edit cuts
4. Apply: `tighten {project_dir, asset, …same options, apply: true}`. It
   writes a new asset `<asset>-tight` (the original is kept) with the
   transcript re-timed, so captions and `claim_refs` line up with the new cut.
5. Next: `shorts` or a talking-head / silent-vlog spec on `<asset>-tight`.
   Suggest watching the tightened clip once: word-timing cuts are precise to
   whisper's timestamps, and a rare cut can clip the edge of a word.
   For a video, the `compare` skill builds a before/after page for that:
   `a: {file: <the original's project-relative path>}` against
   `b: {file: <the path tighten returned, source/assets/<asset>-tight.mp4>}`,
   played in sync, so the user can hear each cut against the original.

---
name: compare
description: Build a before/after page for two videos - a project's preview and final render, a render against a variant or short, or a clip against its tightened copy - with side-by-side, stacked and wipe views on one synced clock, frame stepping and per-side sound. Use when the user runs /video-studio:compare, asks to see two versions side by side, or wants to judge a change by watching it.
license: Apache-2.0
compatibility: Requires the video-studio plugin's bundled `engine` MCP server (Node.js 22.13+) and ffmpeg.
allowed-tools: mcp__plugin_video-studio_engine__compare Read
---

# Compare two videos

The `compare` tool writes `qa/compare/index.html` with both videos copied
next to it (`a.mp4`, `b.mp4`). The page is one self-contained file with no
network requests, so the folder can be zipped and sent.

## 1. Pick the two sides

Each of `a` and `b` is one of:

- `{quality: "preview" | "final"}`: this project's render;
- `{project_dir, quality?}`: another project's render, such as a variant
  or a short (absolute path);
- `{file}`: a video inside the project, relative to it, such as
  `assets/supplied/talk.mp4` against `assets/supplied/talk-tight.mp4` after
  `tighten`.

Give each side a short `label` when the defaults (quality, project name or
file name) would not tell the user which is which. `a` is the before or
reference side, and `b` the after side. With no sides given, the tool
compares this project's preview (a) with its final render (b). If a side is
missing, say which render or file is missing and offer the render skill.

## 2. Build the page

`mcp__plugin_video-studio_engine__compare {project_dir, a?, b?}`. It returns
each side's label, duration and resolution, and notes on differing
durations or aspect ratios.

## 3. Hand it over

You can't open a browser. Give the user the absolute path of `index.html`
to open (on macOS: `open "<path>"`) and tell them how to use it:

- **Views:** side by side, stacked, or wipe (drag the divider over the two
  videos laid on top of each other).
- **Playback:** one play button and scrubber drive both videos. Space
  plays and pauses, and ← and → step one frame. The shorter video holds its
  last frame.
- **Sound:** B is audible by default. Toggle each side's mute.

To say what changed rather than show it, pair this with the `diff` skill
(spec, lock and frame changes) or `review` (frames you can Read yourself).

---
name: review
description: Look at a rendered video-studio reel as images - a contact sheet of every scene's opening, middle and closing frame, a strip of every frame in a span (motion, transitions, word cues), or full-resolution crops (captions, small text, faces) - and report or fix what is wrong. Use when the user runs /video-studio:review, asks how a render looks, or before handing over a preview or final render.
license: Apache-2.0
compatibility: Requires the video-studio plugin's bundled `engine` MCP server (Node.js 22.13+) and ffmpeg.
allowed-tools: mcp__plugin_video-studio_engine__review Read
---

# Review a render

You can't watch the video, but you can look at it. The `review` tool writes
an image of labelled frames (scene id, `in`/`mid`/`out`, time) to
`qa/review/` and returns the path; Read it.

## 1. Contact sheet first

`mcp__plugin_video-studio_engine__review {project_dir}` (the latest render;
`quality` to choose). Review runs lint on the same render first: tiles of
scenes with findings get a red (error) or amber (warning) border, and the
result's `flagged` list names each scene's findings (e.g. `s03:
text_overflow (error)`). **Look at the flagged tiles first** and confirm
each finding by eye; then check every scene:

- **Text:** fits its box, readable at phone size, nothing cut off, no stray
  characters (e.g. a number glued to its unit).
- **Placement:** nothing under the captions or the platform UI.
- **Completeness:** by `mid` the scene's graphic is fully on screen; `out`
  shows the settled end state.
- **Footage:** crops keep the face or subject; redactions cover what they
  should.
- **Rhythm:** consecutive scenes look different enough (a visual change
  every 2-4 s), and the hook's first frame already says something.

## 2. Look closer where something is off

- `mode: "strip", scene: "<id>"`: every frame of that scene. Use it for
  motion (`push_in`, `punch`, `reveal`), transitions, count-ups, and word
  cues: a cued item should appear as its word is spoken. The strip labels
  the tile nearest each placed cue with `cue "<word>"` (also in the tile's
  `cues`); check the item is appearing on that tile. Unplaced cues show up
  as `cue_unmatched` flags. A long span is
  sampled evenly up to 48 frames; narrow it with `from_sec`/`to_sec` for
  every frame.
- `mode: "crop", crop: {x, y, w, h}` (fractions of the frame) with `times`:
  full-resolution detail such as the caption band (`{x: 0, y: 0.65, w: 1,
  h: 0.25}`), small labels or a face.

## 3. Report or fix

List what you found per scene, most visible first, with the fix in spec
terms (shorter `on_screen_text`, a different `motion`, `footage.focus`, a
cue on a later word). When the user asked you to fix things (or you are in
the render or create flow), edit the spec, re-render (only changed scenes
re-render) and review again. Don't claim a render looks right without
having Read the image. To let the user watch two versions (preview and
final, or before and after a fix) in sync, suggest the `compare` skill.

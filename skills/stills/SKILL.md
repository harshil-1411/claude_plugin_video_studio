---
name: stills
description: Look at chosen moments of a planned video-studio project's HyperFrames scenes (motion pages and every other motion-graphic kind) as a labelled sheet of still frames drawn straight from the composed pages in headless Chrome, before the full render - on every beat or downbeat of the music, at exact times, or in/mid/out - and fix cramped, overlapping, off-grid or unreadable moments. Use when the user runs /video-studio:stills, after writing or editing a motion page, or before a render of a spec with motion scenes.
license: Apache-2.0
compatibility: Requires the video-studio plugin's bundled `engine` MCP server (Node.js 22.13+), ffmpeg, Google Chrome and the HyperFrames producer (see doctor).
allowed-tools: mcp__plugin_video-studio_engine__stills mcp__plugin_video-studio_engine__spec_validate Read Edit
---

# Stills before the render

`stills` is not a render. It composes each HyperFrames scene exactly as the
renderer does (tokens, safe zones, word cues, the music's beat grid), opens
the page in headless Chrome, seeks it to the chosen moments and tiles the
frames into `review/stills/stills-<quality>[-<scene>].jpg` (full-size
frames in `review/stills/frames/`). Nothing in `renders/` or `dist/`
changes and no voice is synthesized, so it takes seconds, not minutes.

## Stills and determinism

1. After `spec_validate` passes and **before `render_submit`**, call
   `mcp__plugin_video-studio_engine__stills {project_dir, at: "downbeats"}`
   when the spec has a music bed (`at: "beats"` for fast cuts), else
   `{project_dir}` (in/mid/out of every scene). Limit to the scenes you
   changed with `scenes: ["s03"]`; use `times: [0.4, 1.2]` (scene-local
   seconds) for exact moments.
2. **Read every image in `images`.** Each tile is labelled
   `<scene> <moment> <time>` (`beat 3`, `bar 2`, `in`/`mid`/`out`). Check:
   - text fits, is readable at phone size and is not cramped against an edge;
   - nothing overlaps or sits under captions or the platform UI;
   - each state change lands on its beat or bar (the label says which), and
     no beat shows a frame that is half-way through nothing;
   - no empty, near-identical or cluttered frames.
3. Fix the page (`motion/*.html`) or the spec and run `stills` again on the
   changed scenes. Render only when the sheet looks right.

Stills hand each page the same data the render does. That includes the
music envelope (`vs.energy`, `vs.bass`, `vs.onset`) of `motion` pages and,
with `audio.beat_sync` on, the beat-placed reveals of text scenes. So a
still at time t matches the render's frame at t. Before the first render,
reveals sit on the bed's beats at spec durations (a note says so), and the
render can still move cuts.

**Transitions are not in stills.** Crossfades and other transitions are
drawn when the scenes are assembled, and stills draw one scene at a time.
After a render, use `review` with `transitions: true` to see each
transition at its midpoint.

Every `motion` scene is also checked automatically before it renders: the
page is seeked to the same times in a different order and the frames must
be identical, else the scene fails with `nondeterministic_scene` (a clock,
unseeded randomness, or state carried between frames: `window.seek(t)` must
rebuild the whole frame from `t`). With `props.loop`, the frame at the end
must match the first (`loop_seam` warning). The result is cached until the
page changes.

## Errors

- `RENDER_LOCKED`: a render of this project is running; wait for it
  (`job_status`), then run stills.
- Chrome or the producer missing: run `doctor`; the render can still fall
  back to ffmpeg, but stills need Chrome.
- `stills at downbeats: this project has no beat grid`: there is no music
  bed (or no clear beat); use `times` or `count`.
- A scene in `skipped` (footage, provider scenes, a motion page the lint
  refuses): fix what the reason says, or review it after the render with
  the `review` skill.

---
name: test
description: Golden-frame regression test for a rendered video-studio project - samples frames of the reel (first frame, each scene's midpoint, last frame), compares them with the golden frames stored in the project's golden/<quality>/ folder by SSIM, and records new goldens after the render has been checked by eye. Use when the user runs /video-studio:test, asks whether a re-render still looks the same, or wants to lock in a render as the reference.
license: Apache-2.0
compatibility: Requires the video-studio plugin's bundled `engine` MCP server (Node.js 22.13+) and ffmpeg.
allowed-tools: mcp__plugin_video-studio_engine__test Read
---

# Golden-frame test

Golden frames are small PNGs of a known-good render, kept in the project at
`golden/<quality>/` with `golden.json` (sample times, frame width, SSIM
threshold, reel and spec hashes). Commit them with the project.

1. Use the project folder the user named, else the cwd (absolute path). It
   needs a render (`renders/<quality>/`); if there is none, say so and offer
   the render skill.
2. Call `mcp__plugin_video-studio_engine__test {project_dir}` (add
   `quality: "preview"` or `"final"` to pick a render; the default is the
   latest).
3. Report the status:
   - `pass`: every sampled frame matches its golden (SSIM at or above the
     threshold).
   - `fail`: list each failing frame with its SSIM. Read the images it names
     under `qa/test-frames/` (`*.diff.png` shows golden | current |
     difference) and describe what changed. A size, fps or timing change
     fails before any frame is compared; say which.
   - `missing`: there are no goldens yet for this quality.

## Recording goldens (`update: true`)

Never record goldens without looking first: they become the reference every
later render is judged against.

1. Check the render by eye: Read a few frames (for example the cover or
   thumbnail in `dist/`, or the frames from a previous `qa/test-frames/`
   run) and confirm with the user that the render looks right.
2. Call `mcp__plugin_video-studio_engine__test {project_dir, update: true}`
   (same `quality` as the render being recorded).
3. Read two or three of the recorded PNGs in `golden/<quality>/` to confirm
   they show the intended frames, then tell the user to commit `golden/`.

When a failure is an intended change (new copy, new brand, a renderer
upgrade), re-record the goldens the same way; otherwise treat it as a
regression and use the diff skill against a known-good render to find the
cause.

The full report is in `qa/test.md` (machine-readable: `qa/test.json`).

---
name: diff
description: Compare two video-studio renders - two project folders, or one folder's preview and final - and explain what changed - spec changes (scenes added, removed or edited, with before and after), video.lock changes classified as creative, renderer, spec, asset or metadata, and a sampled frame diff (SSIM) with side-by-side images of frames that differ. Use when the user runs /video-studio:diff, asks what changed between two renders or versions, or a golden-frame test failed and the cause is unclear.
license: Apache-2.0
compatibility: Requires the video-studio plugin's bundled `engine` MCP server (Node.js 22.13+) and ffmpeg.
allowed-tools: mcp__plugin_video-studio_engine__diff Read
---

# Diff two renders

1. Work out the two sides from the user's request (absolute paths):
   - two folders: `project_a` is the earlier or reference render,
     `project_b` the later one;
   - one folder, preview against final: pass it as both, with
     `quality_a: "preview"` and `quality_b: "final"`.
   Both sides need a render; if one has none, say so and offer the render
   skill.
2. Call `mcp__plugin_video-studio_engine__diff {project_a, project_b}` (plus
   `quality_a` / `quality_b` when given).
3. Report, in this order:
   - **Identical** or not.
   - **Spec:** scenes added, removed and changed, then the notable field
     changes with before and after (the full list is in the report).
   - **Lock:** changes grouped by class. `creative` means the content changed;
     `renderer` means a tool, renderer, voice or font version changed (the
     likely cause when the spec did not change but frames did); `spec` means a
     platform contract changed; `asset` means a project input changed;
     `metadata` means only outputs such as post copy changed. If the lock was
     not compared (a side has no `dist/video.lock`, or it is for another
     quality), say so and suggest re-exporting that side.
   - **Frames:** how many sampled frames differ, with their SSIM. Read the
     side-by-side images it names under `qa/diff-frames/` of project b
     (A | B | difference) and describe the visible change.
4. Connect the three: for example, frames differ but only a renderer version
   changed, so the change is the renderer, not the content.

To watch the change rather than read about it, the `compare` skill builds
a before/after page of the same two renders (side by side, stacked or wipe,
played in sync) for the user to open in a browser.

The full report is in project b's `qa/diff.md` (machine-readable:
`qa/diff.json`). Diff never changes either project apart from those reports.

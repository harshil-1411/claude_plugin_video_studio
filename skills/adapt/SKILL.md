---
name: adapt
description: Adapt a planned video-studio project to another shape - aspect ratio (9:16, 1:1, 4:5, 16:9), length, platform or targets - as a new project folder, then fix the scenes that no longer fit. Use when the user runs /video-studio:adapt or asks for "a 16:9 version", "a 15-second cut", or the same video for another platform.
license: Apache-2.0
compatibility: Requires the video-studio plugin's bundled `engine` MCP server (Node.js 22.13+).
allowed-tools: mcp__plugin_video-studio_engine__adapt mcp__plugin_video-studio_engine__spec_validate mcp__plugin_video-studio_engine__storyboard_render Read Edit
---

# Adapt to another shape

1. Resolve the source project (absolute) and pick a **new** folder for the
   result, e.g. `<source>-16x9-15s` next to it. The source is never changed.
2. Call `adapt {project_dir, out_dir, aspect_ratio?, target_duration_sec?,
   platform?, targets?}`. Durations are scaled proportionally; the layouts
   re-flow for the new frame on their own.
3. Work through the result:
   - **notes** list scenes whose narration no longer fits (`trim to ≤ N
     words`). Rewrite those voiceover lines shorter in the new project's
     `project/video-spec.json` (same meaning, same claim_refs). For a much
     shorter cut, drop or merge `point`/`proof` scenes instead, keeping the
     hook and the CTA, then rebalance `duration_sec` to the target.
   - A target that does not accept the new aspect ratio: remove it from
     `targets` or pick another aspect.
   - **validation errors**: apply each fix.
4. Call `spec_validate` until it is clean, then `storyboard_render`, and
   show the storyboard. Offer the `render` skill for the new folder.

---
name: export
description: Rebuild a rendered video-studio project's dist/ folder (reel, clean master, captions, transcript, thumbnail, social copy, render manifest, provenance) from existing renders without re-rendering, and polish the social copy. Use when the user runs /video-studio:export, deleted or edited dist/, or wants the final package and posting copy.
license: Apache-2.0
compatibility: Requires the video-studio plugin's bundled `engine` MCP server (Node.js 22.13+).
allowed-tools: mcp__plugin_video-studio_engine__export Read Write
---

# Export the package

1. Resolve the project folder (absolute). It must have been rendered;
   otherwise offer the `render` skill.
2. Call `mcp__plugin_video-studio_engine__export {project_dir}` (optionally
   `quality: "final"` or `"preview"`; default is the latest render).
3. List the `dist/` files in one short block (including `cover.jpg` and
   `cover-square-preview.jpg` when the spec has a `cover`).
4. Read `dist/social-copy.md` (a deterministic draft) and the brief
   (`project/creative-brief.yaml`), then rewrite the copy for the target
   platform: a title, 2-3 description lines in the brief's tone, the desired
   action, and 3-6 relevant hashtags. Keep claims to what the sources say.
   Save it with Write. Re-running `export` regenerates the draft, so edit last.

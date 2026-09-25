---
name: export
description: Rebuild a rendered video-studio project's dist/ folder (one package per target platform with video, cover, captions, post copy and QA, plus the reel, clean master, spec, storyboard, render manifest and provenance) from existing renders without re-rendering, and polish the post copy. Use when the user runs /video-studio:export, deleted or edited dist/, or wants the final package and posting copy.
license: Apache-2.0
compatibility: Requires the video-studio plugin's bundled `engine` MCP server (Node.js 22.13+).
allowed-tools: mcp__plugin_video-studio_engine__export Read Edit
---

# Export the package

1. Resolve the project folder (absolute). It must have been rendered;
   otherwise offer the `render` skill.
2. Call `mcp__plugin_video-studio_engine__export {project_dir}` (optionally
   `quality: "final"` or `"preview"`; default is the latest render).
3. List the packages in one short block: for each `result.dist.targets[]`,
   `dist/<id>/` with its files, the video size and fps, whether it was
   re-encoded (`transcode_reasons`), and its `qa.json` status. Then the shared
   files (`reel.mp4`, `clean-master.mp4`, `video-spec.json`, `storyboard.md`,
   `render-manifest.json`, `provenance.json`; `cover.jpg` and
   `cover-square-preview.jpg` when the spec has a `cover`).
   Any target whose `qa.json` has errors: list them with their fixes and
   offer the `lint` skill's fix loop.
4. Read the brief (`project/creative-brief.yaml`), then refine the post copy per target. Each `dist/<target>/post.json` has the
   copy for that platform (`source: "generated"` is a deterministic draft) and
   its `limits`. Write the refined copy into `project/video-spec.json` as
   `publish.<target> {post_caption, hashtags, ai_disclosure}` (brief's tone,
   the desired action, 3-6 relevant hashtags, claims only from the sources,
   within `limits`), then run `export` again so every `post.json` picks it up.
   Editing the spec is durable; `dist/` files are regenerated on each export.

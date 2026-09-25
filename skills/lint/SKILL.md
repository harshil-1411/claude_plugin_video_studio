---
name: lint
description: Lint a video-studio project against its platform targets (TikTok, Instagram, YouTube Shorts, LinkedIn, Facebook Page API) - duration/fps/size envelopes, text cut off, text or captions under the app UI, contrast, caption reading speed, post caption and hashtag limits, cover, brand banned phrases - and fix what it finds by editing the spec and re-rendering. Use when the user runs /video-studio:lint, asks whether a video is ready for a platform, or after a render before publishing.
allowed-tools: mcp__plugin_video-studio_engine__lint mcp__plugin_video-studio_engine__spec_validate mcp__plugin_video-studio_engine__render_submit mcp__plugin_video-studio_engine__job_status Read Edit
---

# Lint a video for its platforms

Lint compares the project with the platform contracts in `platform-specs/`
(one per target in the spec's `targets`) and with the design rules. Platform
limits live only in those contracts: quote numbers from the findings, never
from memory.

1. Use the project folder the user named, else the cwd (absolute path). It
   needs `project/video-spec.json`; without a render only spec checks run
   (envelopes, caption placement, reading speed, post copy, cover, brand).
2. Call `mcp__plugin_video-studio_engine__lint {project_dir}` (add
   `quality: "preview"` to check a preview render; the default is `final`).
3. Report the status (`pass`, `warn`, `fail`) and each finding as
   `severity id [target] scene: message`, then its `fix`.

## Fix loop (at most 3 passes)

Run this loop when lint returns errors, or warnings the user wants cleared:

1. Apply each finding's `fix` to `project/video-spec.json` (or `brand.yaml`
   for contrast): edit only the fields the fix names, keep every other value,
   and keep claims grounded (do not add facts to shortened text).
   - `caption_mask`: prefer removing `captions.position` so captions are
     placed automatically; use the suggested `y` only if the user wants a
     manual position.
   - `text_overflow`, `reading_density`: shorten the named text or voiceover,
     or lengthen the scene; do not change the meaning.
   - `envelope_*`: adjust durations, `master` or `targets` as the fix says; ask
     the user before dropping a target.
   - `brand_banned_phrase`: rewrite the named field without the phrase.
2. Run `mcp__plugin_video-studio_engine__spec_validate {project_dir}` and fix
   any errors it reports.
3. Re-render with `mcp__plugin_video-studio_engine__render_submit` (same
   quality as before) and poll `mcp__plugin_video-studio_engine__job_status`
   until it finishes. Cached scenes are reused, so this is quick.
4. Lint again. Stop when there are no errors, after the third pass, or when a
   finding repeats unchanged after its fix: then show the remaining findings
   and ask the user how to proceed.

The full report is in `qa/lint.md` (machine-readable: `qa/lint.json`). UI
masks are approximations of each app's interface, not official safe zones, so
also look at a frame of the reel before posting.

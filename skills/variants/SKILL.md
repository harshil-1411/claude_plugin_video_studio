---
name: variants
description: Create an A/B experiment from a planned video-studio project - several hooks and covers from one spec, each rendered as its own package with an experiment manifest (hypothesis, variant ids). Use when the user runs /video-studio:variants, wants to test hooks or thumbnails, or asks for "a few versions" of the same video.
license: Apache-2.0
compatibility: Requires the video-studio plugin's bundled `engine` MCP server (Node.js 22.13+).
allowed-tools: mcp__plugin_video-studio_engine__variants mcp__plugin_video-studio_engine__job_status mcp__plugin_video-studio_engine__schema_get mcp__plugin_video-studio_engine__lint Read Write
---

# Hook and cover variants

A variant changes **only** the hook scene and the cover; every other scene is
shared with the base project, so the experiment isolates what it tests.

1. Resolve the project folder (absolute). It needs a valid
   `project/video-spec.json` (run the `validate` skill first if unsure).
   A rendered base is best: its scene clips are reused.
2. Ask what to test only if the user did not say; default to **3 hooks × 2
   covers**. Write `project/variants.json` (`schema_get experiment-plan`):
   - `id`, a one-sentence `hypothesis` ("a question hook keeps more viewers
     past 3 s than a statement hook"), and `metric` (e.g. `3s_retention`,
     `completion_rate`, `saves`).
   - `hooks[]`: `{id, label, scene}`. Each `scene` is a full hook scene
     (purpose `hook`, 1.5–4 s). Use different hook mechanisms from the brief's
     candidates (question, statistic, contrarian, promise…). Keep every claim
     grounded: reuse the base hook's `claim_refs` or cite other evidence; a
     hook with a number needs a ref. With `voice.mode: none`, voiceover stays
     "" and the words go in the props.
   - `covers[]` (optional): `{id, label, cover: {headline (≤ 6 words),
     focal_time_sec (inside the hook)}}`.
3. Call `variants {project_dir}` to prepare. Fix every variant listed as
   `failed` by editing `project/variants.json`, then call it again.
4. Call `variants {project_dir, render: true}` (add `quality: "final"` when
   the user wants final renders). Renders queue one at a time; poll
   `job_status` for each job id every 10–20 s, or
   `variants {project_dir, status_only: true}`. Calling it again is safe:
   variants already queued or running are not resubmitted, and a variant
   being rendered is left untouched (listed under `skipped`). A variant
   whose render failed or was cancelled shows `failed` with the job's error;
   `render: true` resubmits it.
5. Optionally run `lint` on one variant folder (`variants/<id>`) per hook.
6. Report: the hypothesis and metric, then one line per variant (id, hook
   label, cover headline, status, `variants/<id>/dist/`). Remind the user to
   post variants under comparable conditions (same time slot, audience) and
   to compare only the chosen metric; the plugin does not publish or fetch
   analytics.

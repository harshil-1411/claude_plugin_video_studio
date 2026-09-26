---
name: render
description: Render a planned video-studio project (project/video-spec.json) into a finished package in dist/ - captioned 9:16/16:9 reel, clean master, SRT/VTT captions, transcript, thumbnail, social copy, render manifest and provenance - using only local tools (system TTS or silent voice, HyperFrames or ffmpeg motion graphics). Use when the user runs /video-studio:render, approves a plan, or asks to render, preview or export the video.
license: Apache-2.0
compatibility: Requires the video-studio plugin's bundled `engine` MCP server (Node.js 22.13+) and ffmpeg with libass and libx264.
allowed-tools: mcp__plugin_video-studio_engine__spec_validate mcp__plugin_video-studio_engine__render_submit mcp__plugin_video-studio_engine__job_status mcp__plugin_video-studio_engine__render_cancel mcp__plugin_video-studio_engine__qa_run mcp__plugin_video-studio_engine__export mcp__plugin_video-studio_engine__doctor mcp__plugin_video-studio_engine__review mcp__plugin_video-studio_engine__footage_focus Read Write Edit
---

# Render a video

Rendering is local and free. The only paid API is ElevenLabs, and the engine
uses it only when a key is configured **and** it is allowed: `policy.yaml`
(`<project>/policy.yaml`, `project/policy.yaml`, or the user default in the
plugin data folder) lists it in `providers.allow`, the spec names it in
`voice.provider_preference`, or the user asked for `voice: "elevenlabs"`.
Otherwise `voice: "auto"` uses the system voice and `voice.reason` says why
the key was not used. Never add `providers.allow`, `provider_preference` or
`voice: "elevenlabs"` on your own; only when the user asks for ElevenLabs.
Work in the project folder that holds `project/video-spec.json`; pass
absolute paths.

## 1. Check the spec

Call `spec_validate {project_dir}`. If `ok` is false, list the errors with
their fixes and stop (or fix them per the plan skill and re-validate).
`render_submit` refuses an invalid spec anyway.

## 2. Preview first

Call `render_submit {project_dir, quality: "preview"}` (voice and renderer
default to `auto`). It returns a `job_id` immediately. Only pass `voice` /
`renderer` if the user asked (`silent` for no narration, `ffmpeg` to skip
HyperFrames). `burn_in_captions: false` keeps captions only as sidecars.

Paid voice and spend limits (`policy.yaml` `spend`): above
`project_limit_usd` / `scene_limit_usd` the engine refuses ElevenLabs; above
`approval_above_usd` it asks the user itself in an approval dialog (what,
how many characters, estimated cost) and records the answer in
`project/consent.json`. If `render_submit` returns `REFUSED` with
`consent_required: true` (the client has no approval dialog), tell the user
the characters and estimated cost from the message, ask them, and only after
a clear yes call it again with `approve_paid_voice: true`, or with
`voice: "system"` if they say no. `asked_user: true` means the user already
answered in the dialog: do not ask again or retry.

## 3. Poll

Call `job_status {job_id}` every 10-20 seconds, passing the previous
result's `cursor` as `since` so you only get what changed (the full result
arrives once when the job finishes). Tell the user the stage in
one short line when it changes (voice, scene 3/6, assemble, QA, export); do
not repeat identical updates. A preview of a 30 s reel usually takes well
under a minute; a final render several minutes. Other submissions queue:
only one render runs at a time. `interrupted` means the engine restarted:
submit again (all finished work is cached). If the user wants to stop a
render (wrong settings, taking too long), call `render_cancel {job_id}`: the
job ends as `cancelled`, the project's render lock is released and finished
scene clips stay cached for the next `render_submit`.

Errors start with a code in brackets (also `code` / `error_code` in the
structured result): `RENDER_LOCKED` (another render of this project is
running: wait and poll, or cancel it), `SPEC_INVALID` (fix the spec),
`FFMPEG_MISSING_ENCODER` / `FFMPEG_MISSING_FILTER` / `FFMPEG_NOT_INSTALLED`
(run `doctor` and relay its fix), `FFMPEG_DISK_FULL`, `FFMPEG_BAD_INPUT`
(name the file), `NOT_FOUND`, `REFUSED`, else `ERROR`.

## 4. Look at it before presenting

Call `mcp__plugin_video-studio_engine__review {project_dir}` and Read the contact sheet it returns (each
scene's opening, middle and closing frame, labelled). Check that text fits
and is readable, that nothing sits under the captions or the app UI, that
graphics are complete by the middle of their scene, and that crops keep the
subject. Look closer where needed:
- `mode: "strip"` with `scene` (every frame of it): motion, transitions,
  and word cues. A cued item should appear as its word is spoken; compare
  with `captions.json` times.
- `mode: "crop"` with `crop {x, y, w, h}` (fractions of the frame): caption
  and small-text legibility, faces.

**Review → fix → re-render loop (at most 2 passes).**
1. Collect the problems: the `flagged` scenes in the review result (lint
   findings: read `qa/lint.md` for their `fix`) plus what you saw on the
   sheet. Keep only problems you can fix in the spec without asking the
   user: text too long or overflowing, a caption or headline under the UI, a
   cue on the wrong word, a crop that loses the subject (`footage_focus` /
   `focus_track`), a scene too short for its reads, a motion or transition
   hiding a reveal.
2. Apply those fixes to `project/video-spec.json`, keeping every other
   value. Don't change the story, the facts, the voice or the look: those
   are the user's decisions (list them instead).
3. `spec_validate`, then re-render the same quality (only changed scenes
   re-render) and `review` again.
4. Stop when nothing is left to fix, when a problem comes back unchanged
   after its fix, or after the second pass. Then present, listing what you
   fixed and what you left and why.

## 5. Present the result

From `result`:

- **Files**: `dist/reel.mp4` (size, duration, resolution, preview/final),
  then one line per platform package in `dist.targets[]` (`dist/<id>/`:
  video, cover, captions, `post.json`, `qa.json` status; say when the video
  was re-encoded and why), and the other `dist/` files in one line. When the spec has a `cover`, mention
  `dist/cover.jpg` (the headline cover) and `dist/cover-square-preview.jpg`
  (how it looks cropped to a square grid tile); open both with Read to check
  the headline is legible.
- **QA**: `pass`, or each finding as `id: detail` with its fix. With the
  silent voice, silence and loudness are not measured (a preview without
  narration audio); frozen frames are expected for static motion-graphic
  scenes. Report `fail`
  findings prominently.
- **Voice and renderer used, and why**: quote `voice.reason` and
  `renderer.reasons` briefly. If the voice fell back to silent, say why
  (e.g. no system TTS in this environment) and how to get narration
  (`voice: "system"` on macOS/Linux, or ElevenLabs: a key via `/plugin`
  plus the user's permission in `policy.yaml` `providers.allow`). If a
  configured ElevenLabs key was not used, quote the policy reason.
  If HyperFrames was skipped, say the ffmpeg renderer drew the scenes and
  offer the optional setup below.
- **Timing adjustments**: scenes whose narration ran long were extended in
  the render only; suggest updating `duration_sec` in the spec or trimming
  the line.
- **Placeholders**: scenes that need a video provider were drawn as titled
  cards (provider rendering arrives in a later phase).

## 6. Final render and export

Ask whether to render the final version. On approval call
`render_submit {project_dir, quality: "final"}` and poll again.

Then refine the post copy per target. Each `dist/<target>/post.json` has the
copy for that platform (`source: "generated"` is a deterministic draft) and
its `limits`. Write the refined copy into `project/video-spec.json` as
`publish.<target> {post_caption, hashtags, ai_disclosure}` (brief's tone,
the desired action, 3-6 relevant hashtags, claims only from the sources,
within `limits`), then run `export` again so every `post.json` picks it up.
Editing the spec is durable; `dist/` files are regenerated on each export.
`qa_run {project_dir}` re-checks the reel.

## Optional: HyperFrames renderer

Richer motion graphics need `@hyperframes/producer` and Google Chrome. The
engine never installs it by itself. If the user wants it, they run:

```
cd "${CLAUDE_PLUGIN_DATA}" && PUPPETEER_SKIP_DOWNLOAD=1 npm i @hyperframes/producer@0.8.78 --prefix deps
```

then `/video-studio:doctor` (check `hyperframes`) and re-render with
`renderer: "auto"` or `"hyperframes"`.

## Errors

- Tools missing: suggest `/video-studio:doctor` and `/mcp`.
- ffmpeg missing or without libass/libx264: run the doctor and follow its fix.
- A scene failed to render: show its reason; retry with `renderer: "ffmpeg"`.

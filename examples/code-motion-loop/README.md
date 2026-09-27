# Example: code motion loop ("One shape, six states")

The Phase 6.5 reference example: a 6-second, 1:1 (1080×1080, 30 fps) seamless loop in the
`ui-morph-loop` format, drawn by a single `motion` page, which is code where every frame is a
pure function of time. Copy its structure when you write your own motion scene (see
`skills/plan/references/code-motion.md`).

One accent shape never cuts. A cursor drives it through five states and back:

| Time | Change (on the beat grid of `synth:pulse`, 120 BPM) | State |
| --- | --- | --- |
| 0–1 s | the cursor moves to the button | pill **Render** |
| 1 s (beat) | click: the pill fills the frame | full-frame accent with a progress ring |
| 2 s (bar) | ring done: the frame shrinks | card: **reel.mp4**, *Ready to post*, **Share** |
| 3 s (beat) | click Share: the card shrinks and drops | toast **Link copied** |
| 4 s (bar) | click the toast: it fills the frame | end card **video-studio** |
| 5 s (beat) | the end card shrinks | pill **Render** again, held into the loop point |

The craft rules it follows:

- Each state's resting layout is set in CSS first, and `seek(t)` tweens into it.
- Content enters about 100 ms after its container starts moving and leaves before the next
  change. It is also clipped to the shape every frame, so nothing spills mid-morph.
- Morphs use a fast-out curve (`easeOutQuint`, 380 ms), so each change reads on its beat. Clicks
  release on a critically damped spring, with no overshoot.
- One accent colour (`palette.primary`) sits on the style's background and text colours. All
  copy comes from `window.__vs.text` (`props.text`).
- Change times snap to the measured beats and downbeats (`__vs.beats`/`downbeats`) when they are
  within 120 ms of the plan.
- The label lands at about 5.5 s, followed by a ≥ 400 ms hold (about 0.5 s, plus 0.2 s after the
  loop point).
- Every moving value is its start value plus steps that sum to zero. So `seek(0)` and `seek(6)`
  draw the same frame exactly (`loop: true`).

## Files

- `input/render-button-loop.md`: the only source (the states and the score, in plain words).
- `source/`: its ContentIR and provenance, produced by the `ingest` tool.
- `project/creative-brief.yaml`: goal `explain`, template `ui-morph-loop`, three scored hooks,
  and `acceptance` (loop, 0.8 changes/s, ≤ 10% frozen, a 400 ms hold).
- `project/video-spec.json` has these settings:
  - one `motion` scene (`motion/s01.html`, `loop: true`, no effects);
  - `voice.mode: none`, captions not burned in, `style: minimal`;
  - `audio.music: synth:pulse` with `beat_sync` snapping to downbeats;
  - `master` 1080×1080 at 30 fps with `loop: true`;
  - `grounding: strict`, with every claim citing `markdown:input/render-button-loop.md#L<n>`.
- `motion/s01.html`, `s01.css`, `s01.js`: the page (markup, resting layout, `window.seek`).

Rendered media (`renders/`, `assets/`, `dist/`, `qa/`, `review/`) is not committed.

## Render it

From the repository root (with the committed `dist/mcp.mjs`, or after `pnpm bundle`):

```sh
# Anywhere (CI, sandboxes): the ffmpeg renderer draws a labelled text stand-in for the
# motion page and reports it. This checks the pipeline, not the motion, so QA fails
# motion_density, frozen_frames and loop_seam on the stand-in by design.
node scripts/render-project.mjs examples/code-motion-loop --voice silent --renderer ffmpeg

# The real thing: HyperFrames draws the page in headless Chrome (install HyperFrames first;
# /video-studio:doctor prints the command).
node scripts/render-project.mjs examples/code-motion-loop --voice silent --renderer hyperframes
node scripts/render-project.mjs examples/code-motion-loop --voice silent --renderer hyperframes --quality final
```

In Claude Code with the plugin loaded (`claude --plugin-dir .`), work through the loop from
`code-motion.md`:

1. `spec_validate {project_dir: "examples/code-motion-loop"}`: the `motion` stage lints the page
   (0 errors, 0 warnings).
2. `stills {project_dir: "examples/code-motion-loop", at: "downbeats"}` (or `at: "beats"`):
   view the sheet in `review/stills/`. Each state should be settled and readable on its beat.
3. `/video-studio:render examples/code-motion-loop`, then `qa_run`. Check `motion_density`,
   `longest_static`, `hold`, `frozen_frames` and `loop_seam` (first vs last frame SSIM ≥ 0.99).
4. `compare` with a reference video you want to match: frozen seconds, changes per second, cut
   rate and loudness, side by side.

## Tests

The page is covered by the golden-frame test, but only with HyperFrames, because the ffmpeg
stand-in would record meaningless goldens. The test renders the example at 180 px and 15 fps, at
full length. It checks that HyperFrames drew it, and that QA's first-vs-last-frame SSIM reaches
0.99 (the loop seam):

```sh
VS_TEST_RENDER=1 npx vitest run tests/golden-frames                    # check
VS_TEST_RENDER=1 VS_UPDATE_GOLDEN=1 npx vitest run tests/golden-frames # record, after looking at the frames
```

The ffmpeg-only golden run (`VS_TEST_GOLDEN=1`, part of `pnpm check`) does not include this
example.

## Re-plan

After you edit `input/render-button-loop.md`, run `ingest` again with that input and
`replace: true`. Then fix any refs that `spec_validate` reports. If the states change, also
update `props.text` (the page reads its copy from there, by index) and the `STATES` geometry
in `motion/s01.js`.

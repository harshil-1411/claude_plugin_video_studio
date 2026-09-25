# Example: text to motion graphic ("Explain vector databases in 30 seconds")

The Phase 3 exit scenario as a committed, reproducible project: a 30-second, 9:16
explainer planned from one short text source and rendered with local tools only.

- `input/vector-databases.md`: the only source (plain statements, no numbers).
- `source/`: its ContentIR and provenance, produced by the `ingest` tool.
- `project/creative-brief.yaml`: goal `explain`, template `explain`, three scored hooks.
- `project/video-spec.json`: six `motion_graphic` scenes (typography, comparison,
  diagram, diagram, comparison, cta), 30 s, `grounding: "strict"`; every scene cites
  `markdown:input/vector-databases.md#L<n>`.

Rendered media (`renders/`, `assets/voice/`, `dist/`, `qa/`) is not committed.

## Render it

From the repository root, after `pnpm bundle` (or with the committed `dist/mcp.mjs`):

```sh
# Anywhere (CI, sandboxes): silent voice, ffmpeg renderer, preview quality.
node scripts/render-project.mjs examples/text-to-motion-graphic --voice silent --renderer ffmpeg

# On macOS with narration from `say`, and HyperFrames if installed (falls back to ffmpeg otherwise).
node scripts/render-project.mjs examples/text-to-motion-graphic --voice system --quality final
```

Or in Claude Code with the plugin loaded (`claude --plugin-dir .`): `/video-studio:render
examples/text-to-motion-graphic`.

Output: `dist/reel.mp4` (captions burned in), `dist/clean-master.mp4`,
`dist/captions.srt`/`.vtt`, `dist/transcript.txt`, `dist/thumbnail.png`,
`dist/social-copy.md`, `dist/render-manifest.json`, `dist/provenance.json`, and
`qa/report.{json,md}`. A second run reuses every cached scene clip and the assembled reel.

Preview quality is 540x960 at 15 fps (24 fps when HyperFrames draws); final is 1080x1920
at 30 fps. With the silent voice, QA warns about silence and loudness by design.

## Re-plan

The spec validates against the committed ContentIR (`spec_validate` with this folder as
`project_dir`). After editing `input/vector-databases.md`, re-run `ingest` with input
`input/vector-databases.md` and fix any refs `spec_validate` reports.

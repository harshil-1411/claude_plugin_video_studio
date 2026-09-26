# Example: the README hero video

The reel in `docs/media/hero.mp4`, made by the plugin from a snapshot of the repository README
(`input/README.md`). Animated-explainer structure, `technical` style, narrated, every line citing
a README line (`grounding: strict`).

Final, narrated render (macOS `say`, HyperFrames if installed, else ffmpeg), then publish it:

```sh
node scripts/render-project.mjs examples/readme-hero --voice system --renderer auto --quality final
cp examples/readme-hero/dist/reel.mp4 docs/media/hero.mp4
cp examples/readme-hero/dist/cover.jpg docs/media/hero-cover.jpg
```

After the README changes, refresh the snapshot (`cp README.md examples/readme-hero/input/README.md`),
re-run `ingest`, and check the spec's `claim_refs` with `spec_validate`.

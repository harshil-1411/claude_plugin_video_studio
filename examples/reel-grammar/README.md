# Example: reel grammar tour

A 14 s text-over-music reel that uses every Phase 5 scene kind (kinetic_text, stat, timeline,
split_screen, quote, map, lower_third), the `energetic` style pack and the bundled `lofi` bed,
with no voiceover (`voice.mode: none`). Use it to check a renderer end to end:

```sh
node scripts/render-project.mjs examples/reel-grammar --voice silent --renderer ffmpeg
node scripts/render-project.mjs examples/reel-grammar --voice silent --renderer hyperframes
```

`grounding` is `off` because this is a format demo, not a factual video.

# Bundled music beds

Background beds for `audio.music.file: "bundled:<id>"`. They were synthesized with ffmpeg only (`aevalsrc` sine chords, a swept-sine kick and inharmonic hi-hats) by `scripts/generate-music.mjs`, so they contain no samples or third-party recordings.

**Licence: CC0-1.0** (public domain dedication). You may use, modify and redistribute them without attribution.

Each bed loops seamlessly: its length is a whole number of chord cycles (32 beats), and the engine loops it to cover the video. Loudness is normalised to about -20 LUFS integrated, 48 kHz stereo AAC 128 kbit/s.

| id | title | bpm | length | mood | sha256 |
|---|---|---|---|---|---|
| `ambient` | Ambient pad | 60 | 32 s | calm | `b184309fdd2946ccc4783692744ebabf8ff777e1fd82f7fefcf645e4f7a5424c` |
| `lofi` | Lo-fi beat | 80 | 24 s | relaxed | `7f7d6cb041f260156aef1d99bbedf5d2893dfac9c901f4bbc929b0c84190b4f7` |
| `upbeat` | Upbeat pulse | 120 | 16 s | energetic | `b6c297632d7b2952f83318cddb70ce8d45ea0977c73696eaa79dd5f6db54d1d0` |
| `minimal` | Minimal pulse | 90 | 21.333 s | focused | `c0d353c88ce803c56012ca2037acce46911096e510f7abc00a4be547d542ffa9` |

Regenerate with `node scripts/generate-music.mjs --out music` (ffmpeg 8.1.2; `-fflags +bitexact` keeps the output byte-identical on the same ffmpeg build). A different ffmpeg build may encode slightly different bytes; update the hashes here and in `catalog.json` if it does.

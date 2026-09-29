# Bundled sound effects

One-shot sounds for a scene's `sfx: [{file: "bundled:<id>", at_sec}]`. They were synthesized with ffmpeg only (`aevalsrc` sines, pitch sweeps and inharmonic sine sums for noise-like texture, then filtered) by `scripts/generate-sfx.mjs`, so they contain no samples or third-party recordings.

**Licence: CC0-1.0** (public domain dedication). You may use, modify and redistribute them without attribution. The engine carries this licence into the render manifest and provenance for every bundled sound a video uses.

Each file is 48 kHz mono 16-bit WAV (no encoder delay, so the measured peak is exact), peak-normalised to -1 dBFS, and fades to silence at its end. The engine lands each sound's **peak** (`peak_ms` into the file) on `at_sec`, so a riser swells into the moment and a hit lands on it.

The labels are measured by the generator, not written by hand (thresholds are in `catalog.json` under `labels`):

- `character`: `warm` when at least 50% of the energy is below 400 Hz, `bright` when at least 30% is above 2 kHz, else `balanced`.
- `hf_risk`: the energy share above 4 kHz (`low` < 3% ≤ `med` < 12% ≤ `high`). High-risk sounds get tiring fast when repeated.
- `default_db`: the gain used when a spec omits `volume_db`: it brings the loudest 50 ms to about -28 dBFS (roughly 10 dB under narration), 2 dB lower for `med` and 4 dB lower for `high` hf_risk.

| id | title | family | length | peak | character | hf_risk | default_db | uses |
|---|---|---|---|---|---|---|---|---|
| `whoosh-soft` | Soft whoosh | whoosh | 900 ms | 463 ms | balanced | low | -17 | transition, reveal |
| `whoosh-fast` | Fast whoosh | whoosh | 500 ms | 219 ms | balanced | low | -16 | transition |
| `swipe` | Swipe | whoosh | 400 ms | 117 ms | bright | med | -19 | transition, click |
| `riser-1s` | Riser, 1 s | riser | 1200 ms | 982 ms | balanced | low | -18 | reveal, transition |
| `riser-2s` | Riser, 2 s | riser | 2200 ms | 1971 ms | balanced | low | -18 | reveal, transition |
| `hit-soft` | Soft hit | hit | 900 ms | 9 ms | warm | low | -20 | accent, reveal, count |
| `hit-deep` | Deep hit | hit | 1800 ms | 23 ms | warm | low | -22 | accent, reveal, outro |
| `pop` | Pop | ui | 250 ms | 7 ms | balanced | low | -20 | click, reveal, count |
| `click` | Click | ui | 80 ms | 5 ms | balanced | low | -10 | click |
| `tick` | Tick | ui | 100 ms | 5 ms | bright | high | -16 | count, click |
| `key-1` | Key press 1 | type | 140 ms | 5 ms | balanced | low | -11 | type |
| `key-2` | Key press 2 | type | 140 ms | 5 ms | balanced | low | -10 | type |
| `key-3` | Key press 3 | type | 140 ms | 6 ms | balanced | low | -11 | type |
| `chime` | Chime | chime | 2000 ms | 8 ms | balanced | low | -21 | reveal, accent |
| `bell-outro` | Outro bell | chime | 2200 ms | 131 ms | balanced | low | -20 | outro |
| `blip-up` | Blip up | ui | 180 ms | 9 ms | balanced | low | -20 | reveal, click |
| `blip-down` | Blip down | ui | 180 ms | 8 ms | balanced | low | -21 | click, outro |
| `glitch` | Glitch | glitch | 450 ms | 7 ms | bright | high | -18 | transition, accent |

The sha256 of every file is in `catalog.json`. Regenerate with `node scripts/generate-sfx.mjs --out sfx` (ffmpeg 8.1.2; `-fflags +bitexact` and PCM keep the output byte-identical on the same ffmpeg build). A different ffmpeg build may produce slightly different samples; the generator rewrites the hashes and labels in `catalog.json` when it runs, so commit both together.

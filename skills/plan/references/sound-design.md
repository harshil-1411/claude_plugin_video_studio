# Sound design

Sound effects are punctuation, not decoration. Each one should mark a moment
the viewer can already see: a card landing, a cut, a number arriving, the
last frame. If nothing on screen changes, leave the moment quiet.

A scene takes up to 8 one-shots in `sfx: [{file, at_sec, volume_db?}]`.
`file` is either `bundled:<id>` (the plugin's synthesized CC0 library, table
below) or a project-relative audio file, which needs a `license`.

## Timing: the engine lands the peak

Every effect has a measured peak (`peak_ms` in `sfx/catalog.json`). The
engine starts the file early so that its **peak** falls on `at_sec`; you do
not subtract anything yourself. Think about which frame the peak belongs on:

- **Gesture sounds start with the action.** A click, key press, swipe or
  whoosh peaks almost at once (or mid-sweep for a whoosh), so put `at_sec` on
  the frame where the motion starts: the tap, the slide beginning, the cut.
- **Reveal sounds land on the payoff.** A riser swells for a second or two
  and peaks at its end; a hit or chime peaks right away. Put `at_sec` on the
  frame where the thing is fully there: the number settles, the logo locks,
  the headline finishes typing. A riser into a hit on the same `at_sec` is
  fine: the riser starts a second earlier.
- **Transitions:** put a whoosh or swipe at the cut (scene start, `at_sec`
  0-0.1) of the scene it leads into, not at the end of the scene before.
- **Typing:** one bundled key press per visible keystroke or word, rotating
  `key-1`, `key-2`, `key-3` so it does not sound like a loop. Two or three per
  second is plenty; you do not need one per letter.
- **Counts:** a `tick` or `pop` per step of a count-up reads well for 3-5
  steps; for more, mark only the last step with a `hit-soft`.

## How much: follow the tone preset

`research-specs/tones.yaml` gives each tone preset an `sfx` density. It is a
posture, not a quota:

| density | presets | what it means |
|---|---|---|
| `none` | - | no effects; the bed and the voice carry it |
| `sparse` | polished, deadpan, parody | about one accent per 5 s: the reveal and the outro |
| `moderate` | playful, cinematic, app-store | about one per scene, on its main change |
| `dense` | energetic | one per story beat, cuts included |

Check the preset you picked in the brief (`tone_preset`) and plan the effects
with the scene list, not afterwards. When in doubt, use fewer.

## Levels

- Leave `volume_db` out for bundled sounds: each has a measured `default_db`
  that puts its loudest 50 ms about 10 dB under narration (bright sounds a
  little lower). Change it only after listening.
- The music bed sits at -18 dB by default (`audio.music.volume_db`) and ducks
  under speech; tone presets suggest their own `bed_db`.
- For calm tones (polished, deadpan) set bundled effects 3-6 dB under their
  default; for energetic pieces keep the default rather than raising it.
- A project file has no default: start around -18 dB and adjust.

## What to avoid

- **Repeating bright sounds.** `tick`, `glitch` and `swipe` are measured
  `bright` or high `hf_risk`; used more than three times in one video they get
  tiring (lint `sfx_harsh_repeat`). Swap repeats for `pop` or `hit-soft`.
- **Stacking.** Two effects starting less than 250 ms apart smear into one
  noise (also `sfx_harsh_repeat`); keep one, or move the other.
- **Sounds under words.** A peak inside a spoken word masks the word (lint
  `sfx_over_voice`, after a render with voice timings). Nudge `at_sec` into
  the pause before or after the word; the picture change can stay where it is.
- **Sounds without a picture change**, and effects on every scene "for
  energy": the viewer stops hearing them after the third one.
- **Unlicensed files.** Record `license` for every project audio file (lint
  `sfx_license_missing`); bundled sounds carry CC0 automatically.

## The bundled library

Synthesized by `scripts/generate-sfx.mjs` (CC0-1.0). `character` and `hf_risk`
are measured from each file's spectrum; `peak` is where the engine aligns it.

| id | family | peak | character | hf_risk | default_db | good for |
|---|---|---|---|---|---|---|
| `bundled:whoosh-soft` | whoosh | 463 ms | balanced | low | -17 | transition, reveal |
| `bundled:whoosh-fast` | whoosh | 219 ms | balanced | low | -16 | transition |
| `bundled:swipe` | whoosh | 117 ms | bright | med | -19 | transition, click |
| `bundled:riser-1s` | riser | 982 ms | balanced | low | -18 | reveal, transition |
| `bundled:riser-2s` | riser | 1971 ms | balanced | low | -18 | reveal, transition |
| `bundled:hit-soft` | hit | 9 ms | warm | low | -20 | accent, reveal, count |
| `bundled:hit-deep` | hit | 23 ms | warm | low | -22 | accent, reveal, outro |
| `bundled:pop` | ui | 7 ms | balanced | low | -20 | click, reveal, count |
| `bundled:click` | ui | 5 ms | balanced | low | -10 | click |
| `bundled:tick` | ui | 5 ms | bright | high | -16 | count, click |
| `bundled:key-1` | type | 5 ms | balanced | low | -11 | type |
| `bundled:key-2` | type | 5 ms | balanced | low | -10 | type |
| `bundled:key-3` | type | 6 ms | balanced | low | -11 | type |
| `bundled:chime` | chime | 8 ms | balanced | low | -21 | reveal, accent |
| `bundled:bell-outro` | chime | 131 ms | balanced | low | -20 | outro |
| `bundled:blip-up` | ui | 9 ms | balanced | low | -20 | reveal, click |
| `bundled:blip-down` | ui | 8 ms | balanced | low | -21 | click, outro |
| `bundled:glitch` | glitch | 7 ms | bright | high | -18 | transition, accent |

Quick picks: a scene change → `whoosh-soft` (calm) or `whoosh-fast`
(energetic); a UI tap → `click` or `pop`; a stat landing → `hit-soft`; the big
reveal → `riser-1s` into `hit-deep`; a headline or logo lock → `chime`; the
end card → `bell-outro`; typing → `key-1`/`key-2`/`key-3` in turn; an
intentional error or hack beat → `glitch`, once.

# Visual strategy

Default to **deterministic** (`motion_graphic`): it is free, exact, on-brand
and reproducible, and it is the only safe way to show text, code and numbers.
Use generative video only where a picture adds meaning that text cannot.

## Decision table

| Scene content | `visual_strategy` | `deterministic.kind` | Typical `props` |
|---|---|---|---|
| Hook line, key phrase, single takeaway | `motion_graphic` | `typography` | `lines: [..]`, `emphasis` |
| Punchy line revealed word by word (hooks, text-over-music cards) | `motion_graphic` | `kinetic_text` | `text`, `rhythm` (`word`/`phrase`), `emphasis`; when it types out the narration with captions burned in, set the scene's `burn_captions: false` so the words aren't shown twice |
| Verbatim quote or testimonial from the source | `motion_graphic` | `quote` | `text`, `attribution`, `source` |
| One headline number | `motion_graphic` | `stat` | `value` (number or string), `unit`, `label`, `context` (baseline) |
| Code, CLI command, config, terminal output | `motion_graphic` | `code` | `language`, `code`, `highlight_lines` |
| Several numbers, trends, benchmarks | `motion_graphic` | `chart` | `type` (bar/line/pie/stat), `series`/`value`, `unit`, `label` |
| Sequence, history, steps with progress | `motion_graphic` | `timeline` | `events: [{label, text?}]` (2-6), `current` (highlighted index) |
| Architecture, pipeline, flow, relationships | `motion_graphic` | `diagram` | `nodes`, `edges` |
| A vs B as text with a verdict | `motion_graphic` | `comparison` | `left {label,text}`, `right {label,text}`, `verdict` |
| Before/after or side by side, text or images | `motion_graphic` | `split_screen` | `mode` (`side_by_side`/`before_after`), `left`/`right` `{label?, text?, asset?}` |
| Name a person, product or feature | `motion_graphic` | `lower_third` | `name`, `title`, `headline` (main text above it) |
| Places or nodes on an abstract map | `motion_graphic` | `map` | `title`, `points: [{label, x, y}]` (0-1, max 8), `route` |
| Product UI from a supplied image | `motion_graphic` | `screenshot` | `asset` (ContentIR asset id), `callouts` |
| Call to action | `motion_graphic` | `cta` | `headline`, `action`, `command`/`url` |
| Closing logo / title card | `motion_graphic` | `end_card` | `title`, `subtitle` (props may be empty) |
| Live product walkthrough the user will record | `screen_capture` | — | describe the flow in `visual_requirements.subject` |
| B-roll, atmosphere, visual metaphor, abstract concept | `generated_video` | — | capability-only `visual_requirements` |
| Presenter speaking to camera | `avatar` | — | only if the user asked and consented |
| User's own footage, photos, logo | `user_asset` | — | reference the asset id in `continuity_refs` |
| Generic real-world footage | `stock` | — | `subject`, `style` |

Rules:
- Any scene whose point is **exact text, code, a number or a UI** is
  `motion_graphic`. Generated video cannot render reliable text or numbers.
- `motion_graphic` always requires `deterministic {kind, props}` with
  non-empty `props` (except `end_card`). Props should echo the scene's
  on-screen text and cited facts, never add new ones.
- Do not use `avatar` or real people's likeness without explicit consent.
- `asset` in `screenshot`/`split_screen` must be a ContentIR asset id.
- Numbers in any props (`stat.value`, `chart.series`, `timeline` text) need
  `claim_refs` like numbers in voiceover.
- Short developer videos can be 100% deterministic; that is a good default.
  Mix in at most 1-2 generative scenes where a metaphor genuinely helps.
- With `data_policy: "local-only"` (confidential sources), avoid
  `generated_video`/`avatar`/`stock` for anything that reveals source content.

## Prompt-free requirements (`visual_requirements`)

Describe **what must be seen**, not how a model should be prompted. Never
name a provider, model, renderer or engine (the validator rejects e.g.
Runway, Kling, Veo, HeyGen, HyperFrames, Remotion).

| Field | Use | Example |
|---|---|---|
| `subject` | the concrete thing on screen | "stack of documents folding into a film strip" |
| `camera` | framing/movement in plain words | "slow push-in", "static", "none" |
| `style` | look, tied to the brand | "clean flat illustration, brand blue accents" |
| `continuity_refs` | **required** (may be `[]`) | `["s03"]`, `["a1"]` |
| `modality` | `video`, `image`, `none` | `video` |
| `realism` | `low`, `medium`, `high` | `low` for abstract |
| `character_reference` | `required`, `optional`, `none` | `none` |
| `audio_generation` | `required`, `optional`, `none` | `none` (voiceover is separate) |
| `max_cost_usd` | per-scene cap | `1.2` |
| `data_policy` | `external-ok`, `local-only` | from classification |
| `preference` | ordered subset of `continuity`, `quality`, `speed`, `cost` | `["quality","cost"]` |

For `motion_graphic` scenes, `{"continuity_refs": []}` is enough; add
`subject` only if it helps a human reading the storyboard.

## Continuity

- `continuity_refs` lists scene ids (`s03`) or ContentIR asset ids (`a1`)
  this scene must stay visually consistent with. Never the scene's own id.
- Use it when a generated subject recurs (same object/character across
  scenes), when a diagram grows across scenes, or when a screenshot is
  reused. Reference the **first** scene that establishes the look.
- Recurring generated subjects: set `character_reference: "required"` and
  `preference: ["continuity", ...]`.

## Transitions

`transition` is one of `cut`, `crossfade`, `fade_black`, `slide`, `zoom`,
`whip`. Default `cut`. Use `crossfade` into/out of generated footage,
`slide` for list steps, and at most one or two showy transitions
(`zoom`, `whip`) per short video. Respect the brand's `transition_style`.

## Motion

`motion: {pattern, intensity?}` moves the whole scene frame like a camera
(every renderer, footage included; on-screen text boxes are checked at rest).
Use `push_in` to land a key line, `punch` (a 250 ms pop) when a stat or
number lands, `reveal` (a 400 ms wipe from the left) to open a new idea,
`drift` (a slow sideways pan) for b-roll and ambient footage, `pull_out` to
show the whole after a detail, and `hold` for dense text, code or charts
that must stay still (it also stops a still image's default push-in).
`intensity` is `subtle`, `normal` (default) or `strong`; keep `strong` for
one or two moments. One pattern per scene; leave `motion` out when unsure,
and vary patterns so consecutive scenes do not repeat the same move.
`punch` and `reveal` play in the scene's first 250–400 ms, so enter those
scenes on a `cut` (or `whip`): a `crossfade` or `fade_black` into them
blends over the move and hides it.

## Cutaways (talking head, interviews, shorts)

A cutaway replaces the speaker's picture with a graphic while their voice
keeps playing: keep the scene's `footage` span (its sound and transcript
words still play and caption), add `cutaway: true` to it, and give the
scene a `deterministic` graphic, usually with `cues` on the speaker's words.

```json
{"id": "s03", "purpose": "proof", "voiceover": "", "visual_strategy": "motion_graphic",
 "footage": {"asset": "v1", "in_sec": 41.2, "out_sec": 46.0, "cutaway": true},
 "deterministic": {"kind": "stat", "props": {"value": 40, "unit": "%", "label": "faster builds"}},
 "cues": [{"word": "forty"}], "audio": {"mode": "native"}}
```

- Cut away when the line describes something to see: a number, a process,
  a comparison, a product, a chapter change. Stay on the face for
  personal, emotional or opinion lines, and for the hook's first second.
- One idea per cutaway, 3–10 s, then give the face back for at least 2 s
  (lint `cutaway_rhythm`). Two cutaway scenes in a row count as one.
- Look before you choose spans, cutaways or b-roll: `footage_look {asset,
  from_sec, to_sec}` shows a frame per shot plus the transcript of the range.
  Record each shot with `footage_notes` (`broll: true` for usable cutaway
  footage, `quality`, `on_screen_text`) and check the stored notes first
  (`footage_notes {asset}`) instead of looking again. Notes are observations,
  not evidence: never cite them as `claim_refs`.
- Landscape footage in a vertical reel: a static `focus` (a crop offset)
  loses a speaker who moves. Call `footage_focus {asset, in_sec, out_sec}`
  and paste its `focus_track` (subject centre per time, t from `in_sec`)
  into the scene's `footage` with `fit: "cover"`. Without macOS Vision,
  mark it by eye from `footage_look` frames. Check the crop with `review`
  strips; lint `subject_near_edge` flags a subject the crop can't centre.
- Native cues match the transcript's spelling: whisper writes numbers as
  it heard them ("forty" or "40"), so check the transcript first.

## Word cues

`cues: [{word, occurrence?, item?}]` lands the graphic's reveal items on
spoken words, so a number appears as it is said instead of on a timer. Each
kind reveals a fixed list of items, and cue k drives item k (or `item`):

| Kind | Items, in order |
|---|---|
| typography | each line |
| code | the block, then the highlight (with `highlight_lines`) |
| diagram · timeline · map | each node · event · point |
| chart | each series entry (or the value, for `type: stat`) |
| screenshot | each callout |
| comparison | left, right, verdict |
| split_screen | left, right |
| cta | headline, action |
| end_card | title, subtitle |
| quote | text, attribution |
| stat | the number (its count-up finishes on the word), the label |
| lower_third | the name card, the headline |
| kinetic_text | each word (or phrase with `rhythm: phrase`) |

- Cue the words that carry the item: the number for a stat, each step's
  name for a timeline, "but" or "instead" for the right side of a
  comparison. The word must be in the scene's `voiceover` (case and
  punctuation are ignored; `occurrence` picks a repeated word, a short
  phrase such as "40 percent" works too). `spec_validate` rejects others.
- Only cue what matters: 1–4 cues per scene, at least 0.4 s apart (lint
  `cue_too_close`). Uncued items keep the default stagger and never jump
  ahead of an earlier cue.
- In `voice.mode: native` the words come from the footage transcript and
  are checked at render; `voice.mode: none` has no words, so no cues.
- Timing is only as good as the word timings: exact with a transcript or a
  provider voice, close (estimated) with the system voice, and ignored in
  silent renders (lint `cue_unmatched`).

# Contributing an archetype (template)

An archetype is a story structure stored as data: `templates/<id>/template.yaml`. It is
validated by the `Template` schema (`packages/schema/src/template.ts`, JSON Schema in
`schemas/template.schema.json`). `spec_scaffold` turns it into a `VideoSpec` skeleton, and
Claude writes the words in the `plan` skill. The engine never generates text from a template.

## Fields

| Field | Meaning |
|---|---|
| `id` | Must equal the folder name. Lower case, digits and `-`. |
| `goals`, `platforms` | Which briefs it fits. The scaffold uses `platforms[0]` when the brief has no platform. |
| `default_aspect_ratio`, `default_duration_sec`, `duration_range` | The default duration must lie inside the range. The scaffold warns about a target outside the range. |
| `pacing` | `avg_shot_sec`, `max_words_per_sec` (≤ 6), and optionally the density fields `min_changes_per_sec` and `max_frozen_pct` (see "Density pacing"). |
| `caption_preset` | The default caption preset. |
| `beats[]` | At least 2. Each beat becomes one scene; see below. |
| `hook_mechanisms` | Preferred hooks, best first (`HookMechanism` in the creative brief schema). |
| `rules[]` | Story rules the plan must follow. The `plan` skill shows them to Claude. |
| `voice_mode` | `narrated` (the default), `none` (no speech; words on screen, usually over music) or `native` (the speech is in the footage; captions come from the transcripts). |
| `default_style`, `default_music` | The style pack id (`styles/<id>.yaml`) and the music bed the scaffold picks unless the user chooses others: `bundled:<id>` (a CC0 file in `music/`) or `synth:<preset>` (a score synthesized locally; see below). |
| `inputs[]` | Optional. What the `plan` skill asks the user for before planning (see "Inputs"). |

### Beats

Each beat has these fields:

- `purpose`: a `ScenePurpose`, such as `hook`, `point`, `proof`, `comparison`, `step` or `cta`.
- `share`: the fraction of the total duration. The shares of all beats must sum to 1 ± 0.01.
- `guidance`: one or two sentences on what the beat must do.
- `suggested_visual_strategy`: `motion_graphic`, `user_asset`, `screen_capture`,
  `generated_video`, and so on.
- `suggested_deterministic_kind` (optional): a `DeterministicKind` such as `typography`,
  `stat`, `split_screen` or `kinetic_text`.
- `optional` (optional): an optional beat is dropped when the target duration is below
  `default_duration_sec`, and the remaining shares are renormalized.

Footage strategies (`user_asset`, `screen_capture`) get a scene `audio.mode` from the voice
mode. They need ingested video assets.

Every template must also pass `story_structure` at every length: a tension beat (`question`,
`problem`, `contrarian_claim` or `story`) in the first 40 % after the hook, and a payoff beat
(`payoff`, `result`, `reveal` or `loop_back`) right before the closing `cta` or `end_card`. The
first beat is `hook`, and there are at least 5 beats.

### `motion` beats

`suggested_deterministic_kind: motion` makes the scaffold write a Claude-authored `seek(t)` page
for that scene (`props: {html: "motion/<scene id>.html", text: []}`). The contract, layout rules
and banned effects are in `skills/plan/references/code-motion.md`. Use `motion` when a beat needs
motion that no fixed kind draws: a shape that morphs between states, words animated by role, a
loop. Keep the fixed kinds (`stat`, `cta`, `diagram` and so on) where they are enough. Guidance
for a motion beat says what changes and when, for example "the payoff state, held for at least
400 ms". It does not say how to code it.

Templates built around one continuous shot (`ui-morph-loop`, `ambient-loop`) still list 5 or more
beats. Their rules tell the planner to merge the scenes into one motion page, or to match every
boundary frame exactly, and to keep the beats as state timings.

## Inputs

`inputs[]` lists what the plan must have before it starts. The `plan` skill asks for the
required ones first. Each input has these fields:

- `id`: unique within the template.
- `prompt`: the question, in plain words.
- `kind`:
  - `text`: a short answer;
  - `asset`: an image or clip to ingest, such as a reference video, a photo or UI screenshots;
  - `choice`: one of `options` (at least 2, and only for this kind);
  - `file`: any project file, such as a licensed track, a deck or a `brand.yaml`.
- `required`: a required input blocks planning until it is answered or defaulted.
- `default` (optional): what the plan uses when the user skips the question. The plan records it
  as an assumption.

Ask only for what the format really needs:

- the real UI states and data for a product piece;
- the exact text for kinetic type;
- a product photo for a hero shot;
- a reference video for pieces that should match someone's pace or look;
- a licensed track, or permission to synthesize one, whenever there is music.

Never ask for something the template can't use.

## Density pacing

`pacing.min_changes_per_sec` and `pacing.max_frozen_pct` are the motion density the format
needs. QA measures both on the render (`motion_density`, `frozen_frames`), and lint reports a
miss as `acceptance_unmet`. The brief's `acceptance` overrides them field by field, and
`spec_scaffold` copies the result into `spec.acceptance`. Leave them out for formats where
density doesn't matter. QA then fails frozen frames above 15 % of the runtime.

| Kind of format | `min_changes_per_sec` | `max_frozen_pct` | Examples |
|---|---|---|---|
| Social motion (loops, type, hero pieces) | 0.8-1.0 | 10-15 | `ui-morph-loop` 1.0 / 10, `kinetic-type` 1.0 / 10, `product-hero` 0.8 / 12 |
| Explainers | 0.5-0.6 | 15 | `topic-explainer-9` 0.6 / 15 |
| Calm formats | 0.1-0.2 | 30-40 | `ambient-loop` 0.1 / 30, `slides-narrated` 0.2 / 40 |

Keep `avg_shot_sec` consistent with the density. About one change per second means roughly one
state or cut every 1-1.5 s, and a slow format needs a high `max_frozen_pct`. A rule should say
where the one deliberate hold goes (at least 400 ms) when the format has one.

## Music: `bundled:` and `synth:`

- `bundled:<id>` picks a CC0 bed from `music/` (`lofi`, `ambient` and so on).
- `synth:<preset>` synthesizes an original score locally with ffmpeg: no downloads, and the
  output is always the same. It is licensed "generated (CC0)", and its beat grid is known
  exactly, so cuts and cues land on it without detection. The presets are `pulse` (120 BPM),
  `lofi` (80 BPM), `ambient` (60 BPM) and `drive` (128 BPM). A spec can tune one with
  `music.synth` (bpm, key, progression, drop bar, seed).

For a loop, the loop length must be a whole number of bars. At 4/4 a bar lasts `240 / bpm`
seconds: 2 s for `pulse`, 4 s for `ambient`. Give the user the choice in an input ("a licensed
track, or may I synthesize one?"), with the synth as the default.

## Checklist

1. Copy the closest template, for example `explain` (narrated), `text-over-music` (`none`) or
   `talking-head` (`native`).
2. Keep one idea per beat. Write guidance that says what the beat must do, not how to phrase it.
3. Add rules for grounding. Numbers need `claim_refs`, and a CTA must match `desired_action`.
   Rules are concrete and checkable ("the price is copied exactly"), not taste words.
4. Add `inputs` for what the format can't be planned without, and density `pacing` if motion
   density matters.
5. Add the id to `EXPECTED_TEMPLATES` in `packages/mcp/src/plan.test.ts` and to the list in
   `scripts/smoke-mcp.mjs`, then run `npx vitest run packages/mcp/src/plan.test.ts`. Every template must load, have shares
   that sum to 1, and scaffold to its target within ±0.5 s. The test fails with the list of
   available ids if the folder name and `id` disagree.
6. Run `pnpm schemas` only if you changed the zod schema, not for a new template.

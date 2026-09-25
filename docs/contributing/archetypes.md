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
| `pacing` | `avg_shot_sec`, `max_words_per_sec` (≤ 6). |
| `caption_preset` | The default caption preset. |
| `beats[]` | At least 2. Each beat becomes one scene; see below. |
| `hook_mechanisms` | Preferred hooks, best first (`HookMechanism` in the creative brief schema). |
| `rules[]` | Story rules the plan must follow. The `plan` skill shows them to Claude. |
| `voice_mode` | `narrated` (the default), `none` (no speech; words on screen, usually over music) or `native` (the speech is in the footage; captions come from the transcripts). |
| `default_style`, `default_music` | The style pack id (`styles/<id>.yaml`) and the music bed (`bundled:<id>`) the scaffold picks unless the user chooses others. |

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

## Checklist

1. Copy the closest template, for example `explain` (narrated), `text-over-music` (`none`) or
   `talking-head` (`native`).
2. Keep one idea per beat. Write guidance that says what the beat must do, not how to phrase it.
3. Add rules for grounding. Numbers need `claim_refs`, and a CTA must match `desired_action`.
4. Run `npx vitest run packages/mcp/src/plan.test.ts`. Every template must load, have shares
   that sum to 1, and scaffold to its target within ±0.5 s. The test fails with the list of
   available ids if the folder name and `id` disagree.
5. Run `pnpm schemas` only if you changed the zod schema, not for a new template.

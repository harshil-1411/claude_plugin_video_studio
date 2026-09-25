# Visual strategy

Default to **deterministic** (`motion_graphic`): it is free, exact, on-brand
and reproducible, and it is the only safe way to show text, code and numbers.
Use generative video only where a picture adds meaning that text cannot.

## Decision table

| Scene content | `visual_strategy` | `deterministic.kind` | Typical `props` |
|---|---|---|---|
| Hook line, key phrase, quote, single takeaway | `motion_graphic` | `typography` | `lines: [..]`, `emphasis` |
| Code, CLI command, config, terminal output | `motion_graphic` | `code` | `language`, `code`, `highlight_lines` |
| Numbers, trends, benchmarks | `motion_graphic` | `chart` | `type` (bar/line/stat), `series`/`value`, `unit`, `label` |
| Architecture, pipeline, flow, relationships | `motion_graphic` | `diagram` | `nodes`, `edges` |
| Before/after, A vs B, old vs new | `motion_graphic` | `comparison` | `left {label,text}`, `right {label,text}`, `verdict` |
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

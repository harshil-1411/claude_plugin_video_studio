# CreativeBrief and VideoSpec fields

Source of truth: `packages/schema/src/creative-brief.ts`,
`video-spec.ts`, `common.ts`. If anything here disagrees, call
`schema_get {name: "creative-brief"}` or `{name: "video-spec"}`. Both objects
are strict: unknown keys are errors.

## Shared enums

- `schema_version`: `"1.0"`
- `goal`: `explain`, `launch`, `educate`, `promote`, `announce`, `case_study`
- `platform`: `instagram_reels`, `tiktok`, `youtube_shorts`, `youtube`,
  `linkedin`, `x`, `generic`
- `aspect_ratio`: `9:16`, `16:9`, `1:1`, `4:5`
- `grounding`: `strict`, `loose`, `off`
- `targets`: platform contract ids (the files in `platform-specs/`):
  `instagram`, `tiktok`, `youtube-shorts`, `linkedin`, `facebook-page-api`.
  Omitted → the primary `platform`'s contract (`instagram_reels` →
  `instagram`, `tiktok` → `tiktok`, `youtube_shorts` → `youtube-shorts`,
  `linkedin` → `linkedin`; `youtube`, `x`, `generic` → none).
- `language`: BCP-47 tag, e.g. `en`, `en-US`
- Ids (`id`, `template`, `content_ir_id`, `brief_id`, caption `preset`):
  letters, digits, `_ - . @ :`, starting with a letter or digit.

## Inference defaults (record each one in `assumptions[]`)

| Field | Signal → value |
|---|---|
| `goal` | new tool/feature/release → `launch`; concept → `explain`; how-to/course → `educate`; offer/product page → `promote`; news/changelog → `announce`; results story → `case_study` |
| `audience` | who the source is written for (jargon, install steps → developers). Be specific: role + what they already know |
| `platform` | named by user; "reel" → `instagram_reels`; "short" → `youtube_shorts`; developer audience + vertical → `youtube_shorts`; B2B → `linkedin`; else `generic` |
| `aspect_ratio` | reels/tiktok/shorts → `9:16`; youtube → `16:9`; linkedin/x feed → `1:1` or `4:5`; unknown → `9:16` |
| `targets` | only when the user names several platforms ("for reels, tiktok and shorts" → `[instagram, tiktok, youtube-shorts]`); else omit |
| `target_duration_sec` | user value; else short-form 30-45; explainer/tutorial 45-60; youtube 60-120 |
| `tone` | from source register + brand `voice.personality`; 2-4 adjectives |
| `desired_action` | the source's own next step (install command, docs link, sign-up); else "Follow for more" is a weak last resort worth asking about |
| `language` | the source language; else `en` |

## CreativeBrief (`project/creative-brief.yaml`)

| Field | Req | Notes |
|---|---|---|
| `schema_version` | yes | `"1.0"` (quote it in YAML) |
| `id` | no | e.g. `brief-readme-launch` |
| `created_at` | no | ISO date-time with offset |
| `content_ir_id` | no | the ContentIR `id` |
| `goal` | yes | enum above |
| `audience` | yes | non-empty |
| `platform` | yes | enum |
| `aspect_ratio` | yes | enum |
| `targets` | no | contract ids; copied to the spec |
| `target_duration_sec` | yes | > 0, ≤ 600 |
| `language` | yes | BCP-47 |
| `tone` | yes | list of strings |
| `desired_action` | yes | what the viewer does after watching |
| `key_messages` | no | 2-4 grounded points |
| `hook_candidates` | yes, ≥ 1 (write ≥ 3) | `{text, mechanism, scores}` |
| `hook_candidates[].mechanism` | yes | `curiosity_gap`, `contrarian`, `contrarian_claim`, `statistic`, `question`, `pain_point`, `promise`, `story`, `demo`, `pattern_interrupt`, `before_after`, `mistake` |
| `hook_candidates[].scores` | yes | map name → 0-10; use `relevance`, `clarity`, `curiosity`, `evidence_strength`, `visual_potential` |
| `chosen_hook` | yes | exact text of one candidate |
| `template` | no | template id from `template_list`, e.g. `devtool-launch`, `text-over-music` |
| `assumptions` | yes (may be `[]`) | `{field, value, reason}`; `value` is a string |

## VideoSpec (`project/video-spec.json`)

Top level:

| Field | Req | Notes |
|---|---|---|
| `schema_version` | yes | `"1.0"` |
| `id`, `title`, `content_ir_id`, `brief_id` | no | `brief_id` = the brief's `id` |
| `goal`, `audience`, `platform`, `aspect_ratio`, `target_duration_sec`, `language` | yes | copy from the brief |
| `master` | no | `{width, height, fps}`; production canvas, ratio must equal `aspect_ratio`, even sides, fps `24`/`30`/`60`. Default 1080 px short side @ 30 (`1080×1920` for 9:16); keep what `spec_scaffold` returns |
| `targets` | no | copy from the brief or `spec_scaffold`; unknown ids are errors |
| `brand_profile` | no | e.g. `acme@3` |
| `policy_profile` | no | string |
| `grounding` | yes | `strict` by default |
| `voice` | yes | `{mode?, provider_preference?, voice_id?, style?}`; `mode`: `narrated` (default), `none` (no speech: every `voiceover` is `""`) or `native` (the speech is in the footage: every `voiceover` is `""`, captions come from the asset transcripts); leave `provider_preference` out unless the user asked; `style` in plain words ("calm, precise") |
| `style` | no | style pack id: `minimal`, `editorial`, `technical`, `energetic` (look and motion; brand colours and fonts override it). `spec_scaffold` sets the template's `default_style` |
| `audio` | no | `{music?: {file, volume_db?, duck_db?, fade_in_ms?, fade_out_ms?, loop?, start_sec?, license?}, beat_sync?: {enabled, tolerance_ms?}}`. `beat_sync` snaps cuts to beats of the bed at render time (default ±250 ms), reported as timing adjustments. `file`: `bundled:ambient` / `bundled:lofi` / `bundled:upbeat` / `bundled:minimal` (CC0, bundled) or a path relative to the project; a user file needs `license {id, source?, attribution?}` (e.g. `CC0-1.0`, `CC-BY-4.0`, `user-owned`) and only a track the user has the rights to |
| `captions` | yes | `{preset, burn_in, position?}`; preset from brand `video.caption_preset` or the template, else `minimal`; `burn_in: true` for short-form narrated videos, `false` with `voice.mode: none` (no speech to caption) |
| `cover` | no (write it) | `{headline, focal_time_sec}`: thumbnail text ≤ 6 words, different from the hook voiceover; `focal_time_sec` inside the hook scene |
| `publish` | no (write it) | map target id → `{post_caption, hashtags?, ai_disclosure?}`; one entry per target; hashtags look like `#devtools`; the post caption is not the voiceover |
| `scenes` | yes, ≥ 1 | see below |

Scene:

| Field | Req | Notes |
|---|---|---|
| `id` | yes | `s01`, `s02`, ... unique, in order |
| `duration_sec` | yes | > 0, ≤ 120; all scenes sum within ±10% of target |
| `purpose` | yes | `hook`, `problem`, `context`, `point`, `proof`, `demo`, `payoff`, `cta`, `end_card`, and the reel-grammar purposes `question`, `contrarian_claim`, `story`, `step`, `comparison`, `reveal`, `objection`, `testimonial`, `result`, `loop_back` (ending that echoes the hook for a rewatch); first scene should be `hook` |
| `voiceover` | yes | `""` for silent scenes and for every scene when `voice.mode` is `none` |
| `on_screen_text` | no | ≤ 6 words |
| `visual_strategy` | yes | `motion_graphic`, `generated_video`, `avatar`, `screen_capture`, `user_asset`, `stock` |
| `deterministic` | if `motion_graphic` | `{kind, props}`; kind: `typography`, `code`, `chart`, `diagram`, `screenshot`, `comparison`, `cta`, `end_card`, `quote`, `stat`, `timeline`, `split_screen`, `lower_third`, `kinetic_text`, `map`; props non-empty except `end_card` (shapes in `visual-strategy.md`) |
| `visual_requirements` | yes | object; `continuity_refs` required (may be `[]`); optional `subject`, `camera`, `style`, `modality` (`video`/`image`/`none`), `realism` (`low`/`medium`/`high`), `character_reference` & `audio_generation` (`required`/`optional`/`none`), `max_cost_usd` (≥ 0), `data_policy` (`external-ok`/`local-only`), `preference` (list of `continuity`/`quality`/`speed`/`cost`) |
| `claim_refs` | yes (may be `[]`) | ContentIR `evidence[].ref` or `claims[].id`, copied exactly |
| `transition` | no | `cut`, `crossfade`, `fade_black`, `slide`, `zoom`, `whip` |
| `footage` | if `user_asset` / `screen_capture` | `{asset, in_sec, out_sec?, fit?, focus?, speed?, loop?}`: `asset` is a ContentIR video (or image) asset id; `out_sec` defaults to `in_sec` + duration × speed; `fit` `cover` (default) / `contain` / `blur_pad`; `focus {x, y}` 0–1 crop centre; `speed` 0.25–4; `loop` repeats a short clip (default: hold the last frame); `redact: [{x, y, w, h, from_sec?, to_sec?, mode?: blur|box, label?}]` hides private regions (inboxes, names, dashboards, bystanders) in **source-frame** fractions and asset seconds, before the crop. A `deterministic` block of kind `lower_third`, `kinetic_text`, `typography`, `quote` or `stat` is drawn over it |
| `audio` | no (footage scenes) | `{mode, native_db?, crossfade_ms?}`; `mode`: `native` (clip sound, default for footage), `mix` (clip sound under the bed), `music` (bed only), `mute`; `native_db` −60…12; `crossfade_ms` ≤ 3000 into this scene |
| `sfx` | no | up to 8 `{file, at_sec, volume_db?, license?}`: project-relative one-shots played `at_sec` into the scene; record `license` |

## Ref formats (as the extractors write them)

`markdown:README.md#L3-L6` (a single line is `#L17`), `repo:src/a.ts#L10-L20`,
`url:https://x.dev/post#install`, `pdf:report.pdf#p3`, `pptx:deck.pptx#s4`,
`docx:<file>#<locator>`, `text:<key>#c0-120`. Markdown evidence is one span
per block (paragraph, list, code block, quote, table), so a ref covers the
whole block's line range, not a single line inside it. Always copy refs from
`source/content-ir.json`; never construct them by hand.

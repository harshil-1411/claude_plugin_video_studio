---
name: prompt-pack
description: Turn the shot cards of a video-studio project's generated_video and avatar scenes into ready-to-paste prompt packages for the video model families Seedance, Veo, Kling, Wan, Runway and Hailuo, and plan how to keep every shot consistent. Nothing is generated or spent. Use when the user runs /video-studio:prompt-pack, asks for prompts for a video model, wants to compare how a shot reads on different models, or plans AI-generated B-roll before Phase 7 generation exists.
license: Apache-2.0
compatibility: Requires the video-studio plugin's bundled `engine` MCP server (Node.js 22.13+). No network, no provider keys.
metadata:
  phase: "7 step 0"
allowed-tools: mcp__plugin_video-studio_engine__prompt_pack mcp__plugin_video-studio_engine__spec_validate Read Edit
---

# Prompt packs for generated shots

`prompt_pack` compiles a shot card into each model family's prompt syntax.
It is a prompt package: no generation, no spend and no network call.
Say that plainly to the user, and never describe a pack as a render or a
clip. Paid generation arrives in Phase 7, behind the engine's policy, spend
limit and consent gates.

## 1. Write the shot cards

Each `generated_video` or `avatar` scene gets a `shot` card in
`project/video-spec.json`. The card never names a provider or a model.
Direct it like a shot list:

- `purpose`: the shot's one job (`emotion`, `plot` or `pressure`).
- `action`: one clear action by the subject ("the engineer leans back and
  exhales"). A second action belongs in its own shot.
- `camera`: one move ("slow push in") or `locked`. "Push in and then pan"
  is two shots.
- `subjects`: stable ids bound to reference assets (`{id, role, asset}`),
  where the role says what the reference is for ("identity, wardrobe").
- `environment` (place, time, one detail), `look` (lens, light, grade) and
  `audio` (dialogue by subject id, at most 3 SFX tied to visible events,
  ambience).
- `on_screen_text` stays `post`. Logos, prices, UI and copy are composited
  in the edit, never generated, so leave them out of the action.
- `continuity`, `end_state` and `first_frame_from` (the previous scene id)
  chain one shot into the next.
- `exclusions`: what must not happen. They become a negative prompt only
  where the model accepts one. Runway gets them as positive statements.

Run `spec_validate` first.

## 2. Compile

Call `mcp__plugin_video-studio_engine__prompt_pack {project_dir}`. It
compiles for all six families by default. Narrow it with
`families: ["veo", "kling"]` or `scenes: ["s03"]`. It writes:

- `prompts/<family>/<scene>.md`: the prompt, provider-neutral parameters,
  warnings with fixes, what the compiler adjusted, and notes;
- `prompts/<family>/<scene>.json`: the same data, for a Phase 7 adapter;
- `prompts/README.md`: the index, the consistency plan, and for each family
  which credential Phase 7 would need and whether it is set. Only a yes/no
  is recorded, never the value.

## 3. Read the warnings and fix the card

Every warning has a fix. The common ones:

- `camera_compound`, `action_compound`: split the shot.
- `brand_text_in_post`: describe a clean surface and add the text in the edit.
- `duration`: the provider only takes certain lengths. The pack snaps the
  length; trim or hold in the edit, or split a long scene into chained shots.
- `aspect_ratio`: the model lacks the spec's ratio. Reframe in the edit or
  use another family.
- `cast_limit`, `cast_unbound`: too many references, or a model that cannot
  bind them. Chain from an identity keyframe instead.
- `audio_not_native`: add the sound in the edit.

Edit the card, not the generated `.md`, and run `prompt_pack` again. The
output is deterministic: the same card always gives the same text.

## 4. Consistency plan (tell the user)

1. **Identity keyframe first.** Approve one still of each recurring
   subject before any clip is made. It is the reference every shot binds to.
2. **Riskiest shot first.** Generate the hardest shot (hands, faces,
   dialogue, fast motion) and inspect it before paying for the batch.
3. **Chain the shots.** Export each approved shot's last frame to
   `prompts/frames/<scene>-last.png`. A shot with `first_frame_from`
   starts from it, and its params already point there.
4. **Logos, prices and copy in post.** Composite them in the edit over
   clean generated plates.

## 5. Be honest about the specs

Every provider spec (`provider-specs/*.yaml`) is a dated hypothesis with
`verified: false`, and every pack repeats that note. Tell the user to check
the provider's live docs before generating. To re-verify a spec, see
`docs/contributing/providers.md`. Sora is not supported: its API was shut
down on 2026-09-24.

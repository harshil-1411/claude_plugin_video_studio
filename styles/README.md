# Style packs

One file per look: `styles/<id>.yaml`, validated against `schemas/style.schema.json`
(zod source: `packages/schema/src/style.ts`). A spec selects one with `style: <id>`;
templates may set `default_style`. The file name must equal `id`.

| id | Look | Use it for |
|---|---|---|
| `minimal` | Light page, regular-weight headings a little smaller than usual, centred; calm ease-out fades (600 ms, 180 ms stagger). | Explainers and thoughtful, low-key topics. |
| `editorial` | Near-black and cream with a warm vermilion accent, Noto Sans, Title Case headings set flush left; ease-in-out reveals. | Stories, opinions, case studies, quotes. |
| `technical` | Dark editor palette, terminal-green accent, left-aligned semibold headings, JetBrains Mono for code; snap entrances (160 ms), no exit fade, hard cuts. | Developer tools, code, architecture. |
| `energetic` | Deep purple, yellow accent, extra-bold UPPER-CASE headings a size larger, centred; spring entrances with a fast 70 ms stagger. | Launches, listicles, scroll-stopping hooks. |

## Project styles

A project can keep its own packs in `<project>/styles/<id>.yaml`, validated by the same schema.

- **Lookup:** `style: <id>` resolves the project's `styles/` first, then the bundled packs here.
- **Cache:** a project pack's ref is `<id>@<version>+sha256:<file hash>`, so editing the file
  re-renders without a version bump. Bundled refs are unchanged.
- **Shadowing:** a project pack with a bundled id (`minimal`, ...) replaces it in that project.
  `analyze write_style` refuses a bundled id or an existing file unless `overwrite: true`, and
  warns when it shadows a bundled pack.
- **From a reference reel:** `analyze {path, project_dir, write_style: "<id>"}` measures the
  reference's motion timing and writes a motion-only pack: `easing` from the measured easing
  class, `enter_ms` from the median entrance, `stagger_ms` from the measured stagger,
  `personality` and `exit_ms` derived from those, and a `cut` or `crossfade` transition from
  the cut rate. It has no palette or fonts (those come from the renderer defaults and your
  brand) and an empty `avoid` list. Nothing from the reference is kept.

## Taste guard (`motion.avoid`)

Each pack bans stock effects that make motion look templated (`EffectId` in
`packages/schema/src/craft.ts`). A `motion` scene declares the effects it draws in
`props.effects`; lint reports any that its style avoids as `banned_effect` (an error), next to
anything `brand.yaml` lists under `visual.forbidden`.

| id | Avoids | Allows, and why |
|---|---|---|
| `minimal` | all nine: `shake`, `rgb_split`, `lens_flare`, `particle_burst`, `shockwave`, `neon_glow`, `grid_floor`, `flash`, `bouncy_easing` | Nothing: a calm pack moves by position, scale and opacity only. |
| `editorial` | all but `lens_flare` | A soft, warm light leak suits its photographic, printed-page look; everything louder breaks the tone. |
| `technical` | all but `rgb_split` | A one-frame channel split on a hard cut is a terminal/glitch idiom that fits precise snaps; overshoot and bounce do not. |
| `energetic` | `shake`, `rgb_split`, `lens_flare`, `particle_burst`, `neon_glow`, `grid_floor` | Its spring entrances already overshoot (`bouncy_easing`), and a `flash` or a single `shockwave` ring on a downbeat or drop suits a launch; shake, glitch and neon still read as cheap. |

Every pack bans `shake`, `neon_glow` and `grid_floor`. Lint only sees declared effects; the
`creative-director` agent also reviews the stills sheet for effects a page draws without
declaring them.

## Precedence

`renderer defaults < style < brand`. The style fills the palette, fonts, weights, text
treatment (case, heading scale, alignment) and motion. A `brand.yaml` then wins for what it
sets: palette colours, fonts, `visual.weights`, and `motion.personality` /
`motion.transition_ms`. A brand personality that differs from the style's also replaces the
style's easing and entrance timings (the table in `packages/renderer/src/tokens.ts`); the
style's scene transition kind is kept. Without a style, a brand personality alone maps to
motion through the same table. Without either, renderers use their built-in look.

## Rules

- **Legible first.** Text on background must reach WCAG 4.5:1; keep primary and secondary
  at 4.5:1 on the background too (they colour stat values, labels and CTA pills). The style
  tests check this with the lint contrast function.
- **Bump `version`** whenever a value changes: `<id>@<version>` is part of the scene cache
  key and is recorded in `video.lock` (`tools.style`).
- Weights are CSS weights; the bundled fonts ship Regular and Bold, so 600 and up draw Bold
  and lighter weights draw Regular.
- `motion.transition` is the default scene transition. The assembler still joins scenes with
  cuts, so it is recorded but not yet drawn.

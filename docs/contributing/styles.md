# Contributing a style pack

A style pack is a look stored as data: `styles/<id>.yaml`. It is validated by the `Style` schema
(`packages/schema/src/style.ts`, JSON Schema in `schemas/style.schema.json`). A spec selects a
pack with `style: <id>`, and a template can set `default_style`. `styles/README.md` lists the
packs that ship with the plugin.

## Contents

- `id`, which must equal the file name, plus `name`, `description` and an integer `version`.
- `palette` with `background`, `text`, `primary` and `secondary`, as hex colours.
- `fonts` with `heading`, `body` and `mono` font chains. Prefer the bundled fonts in `fonts/`
  (Inter, Noto Sans, JetBrains Mono), because other families depend on the host.
- `weights` with `heading` and `body` as CSS weights. The bundled fonts ship Regular and Bold,
  so 600 and above draw Bold.
- `text` with `case`, `heading_scale` and `align`.
- `motion` with `personality`, `easing`, `enter_ms`, `exit_ms`, `stagger_ms`, `transition` and
  `transition_ms`. The assembler still joins scenes with cuts, so `transition` is recorded but
  not drawn yet.
- `captions` (optional), with the same fields as the brand's `captions`: `family`, `weight`,
  `active_word`, `plate_opacity` and `max_lines`.

## Precedence

`renderer defaults < style < brand.yaml`, applied field by field (`resolveTokens` in
`packages/renderer/src/tokens.ts`):

- A brand wins for what it sets: palette colours, fonts, `visual.weights`, `motion.personality`
  and `motion.transition_ms`.
- A brand personality that differs from the style's replaces the style's easing and entrance
  timings (the personality table in `tokens.ts`). The style's scene transition kind is kept.
- Caption styling is the style's `captions`, overridden field by field by the brand's.
- Without a style, a brand personality alone maps to motion through the same table. Without a
  style or a brand, renderers use their built-in look.

## Rules

- **Legible first.** `text`, `primary` and `secondary` must each reach a WCAG contrast of 4.5:1
  on `background`. `packages/renderer/src/styles.test.ts` checks this with lint's contrast
  function.
- **Bump `version` on every change.** `<id>@<version>` is part of every scene's cache key and
  is recorded in `video.lock` (`tools.style`). Without a bump, cached clips keep the old look.
- A new pack must look clearly different from the existing ones, which the tests also check.
  Add a row to `styles/README.md`.
- Run `npx vitest run packages/renderer/src/styles.test.ts`, then render a preview of an
  example with `style: <id>` and check the frames by eye.

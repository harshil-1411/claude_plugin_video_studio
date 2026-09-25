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

# Bundled fonts

Static TTFs shipped with the plugin so renders do not depend on host fonts. Both renderers
(HyperFrames `@font-face`, FFmpeg `drawtext`) and libass caption burn-in (`fontsdir`) use
them first; `packages/renderer/src/tokens.ts` (`findFontsDir`, `resolveFontFile`,
`fontFaceCss`) finds them at `${CLAUDE_PLUGIN_ROOT}/fonts` or by walking up from the engine.

All fonts are licensed under the SIL Open Font License 1.1; each family's `OFL.txt` sits
next to its files. Files are unmodified copies taken from the official upstream release
archives below (downloaded 2026-09-25).

| Family | Version | Source archive (path inside) | License |
|---|---|---|---|
| Inter | 4.1 | https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip (`extras/ttf/`, `LICENSE.txt` → `OFL.txt`) | OFL-1.1 |
| Noto Sans | 2.015 | https://github.com/notofonts/latin-greek-cyrillic/releases/download/NotoSans-v2.015/NotoSans-v2.015.zip (`NotoSans/hinted/ttf/`, `OFL.txt`) | OFL-1.1 |
| JetBrains Mono | 2.304 | https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip (`fonts/ttf/`, `OFL.txt`) | OFL-1.1 |

## sha256

| File | sha256 |
|---|---|
| `Inter/Inter-Regular.ttf` | `40d692fce188e4471e2b3cba937be967878f631ad3ebbbdcd587687c7ebe0c82` |
| `Inter/Inter-Bold.ttf` | `288316099b1e0a47a4716d159098005eef7c0066921f34e3200393dbdb01947f` |
| `NotoSans/NotoSans-Regular.ttf` | `478c558ea716033cd60c03438f628dfa75694dcf6b5f6d505a2f05fd2b4f3823` |
| `NotoSans/NotoSans-Bold.ttf` | `1df075a380fc7cb898acf64c1f7b3b4dd780de3caa860178bf929de35817a913` |
| `JetBrainsMono/JetBrainsMono-Regular.ttf` | `a0bf60ef0f83c5ed4d7a75d45838548b1f6873372dfac88f71804491898d138f` |
| `JetBrainsMono/JetBrainsMono-Bold.ttf` | `5590990c82e097397517f275f430af4546e1c45cff408bde4255dad142479dcb` |

Release archives: `Inter-4.1.zip` `9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e`,
`NotoSans-v2.015.zip` `0c34df072a3fa7efbb7cbf34950e1f971a4447cffe365d3a359e2d4089b958f5`,
`JetBrainsMono-2.304.zip` `6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf`.

To add a family: copy static Regular/Bold files from its official release, add its `OFL.txt`,
add a row to `BUNDLED_FONTS` in `packages/renderer/src/tokens.ts` and to the tables above.

# Bundled fonts

Static TTF/OTF files shipped with the plugin so renders do not depend on host fonts. Both
renderers (HyperFrames `@font-face`, FFmpeg `drawtext`, libass for shaped scripts) and libass
caption burn-in use them first; `packages/renderer/src/tokens.ts` (`findFontsDir`,
`resolveFontFile`, `fontFaceCss`, `prepareLibassFontsDir`) finds them at
`${CLAUDE_PLUGIN_ROOT}/fonts` or by walking up from the engine. libass only reads fonts directly
inside its `fontsdir`, so callers link the files flat first (`prepareLibassFontsDir`).

All fonts are licensed under the SIL Open Font License 1.1; each family's `OFL.txt` sits
next to its files. Files are unmodified copies taken from the official upstream sources
below (downloaded 2026-09-25).

| Family | Version | Source archive (path inside) | License |
|---|---|---|---|
| Inter | 4.1 | https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip (`extras/ttf/`, `LICENSE.txt` → `OFL.txt`) | OFL-1.1 |
| Noto Sans | 2.015 | https://github.com/notofonts/latin-greek-cyrillic/releases/download/NotoSans-v2.015/NotoSans-v2.015.zip (`NotoSans/hinted/ttf/`, `OFL.txt`) | OFL-1.1 |
| JetBrains Mono | 2.304 | https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip (`fonts/ttf/`, `OFL.txt`) | OFL-1.1 |
| Noto Sans JP | 2.004 | https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/SubsetOTF/JP/NotoSansJP-{Regular,Bold}.otf (`main` branch, 2026-09-25; licence: the repo's `Sans/LICENSE` → `OFL.txt`) | OFL-1.1 |
| Noto Sans Devanagari | 2.007 | https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSansDevanagari/hinted/ttf/NotoSansDevanagari-{Regular,Bold}.ttf (`main`, 2026-09-25) | OFL-1.1 |
| Noto Sans Arabic | 2.013 | https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSansArabic/hinted/ttf/NotoSansArabic-{Regular,Bold}.ttf (`main`, 2026-09-25) | OFL-1.1 |

Versions are the fonts' own `name` table versions (no release tag pins these files). The
notofonts.github.io repository itself is Apache-2.0 (its site code); the font files are OFL-1.1
as their `name` table licence entries state, so `OFL.txt` for Devanagari and Arabic is the
standard OFL text with each project's copyright line (`Copyright 2022 The Noto Project Authors
(https://github.com/notofonts/devanagari|arabic)`, taken from the fonts).

## Scripts

The core fonts (Inter, Noto Sans, JetBrains Mono) cover Latin, Greek and Cyrillic and every
render uses them. The script fonts are only needed for text in their script:
`bundledFontsStatus(dir, { scripts })` counts them as missing only for renders with that script.

| Family | Covers | Does not cover |
|---|---|---|
| Noto Sans JP (subset OTF, 4.4–4.6 MB each) | Japanese: kana, JIS X 0208/0213 kanji (most common Chinese hanzi too), CJK and full-width punctuation, plus ASCII/Latin-1, Greek and basic Cyrillic | Hangul (Korean uses host fonts), rare Chinese-only hanzi |
| Noto Sans Devanagari | Devanagari (Hindi, Marathi, Nepali, Sanskrit) with Vedic extensions, ASCII digits and most ASCII punctuation, ₹ | Latin letters (Latin runs in a line use the Latin font) |
| Noto Sans Arabic | Arabic, Arabic Supplement and Extended-A/B, presentation forms (Arabic, Persian, Urdu), ASCII digits, `! , - . :` | Latin letters and most ASCII punctuation (drawn with the Latin font) |

Hebrew, Korean, Thai and other scripts have no bundled font; the renderers fall back to host
fonts for them (the chains name Noto Sans Hebrew/KR, Arial Hebrew, Apple SD Gothic Neo, …).
## sha256

| File | sha256 |
|---|---|
| `Inter/Inter-Regular.ttf` | `40d692fce188e4471e2b3cba937be967878f631ad3ebbbdcd587687c7ebe0c82` |
| `Inter/Inter-Bold.ttf` | `288316099b1e0a47a4716d159098005eef7c0066921f34e3200393dbdb01947f` |
| `NotoSans/NotoSans-Regular.ttf` | `478c558ea716033cd60c03438f628dfa75694dcf6b5f6d505a2f05fd2b4f3823` |
| `NotoSans/NotoSans-Bold.ttf` | `1df075a380fc7cb898acf64c1f7b3b4dd780de3caa860178bf929de35817a913` |
| `JetBrainsMono/JetBrainsMono-Regular.ttf` | `a0bf60ef0f83c5ed4d7a75d45838548b1f6873372dfac88f71804491898d138f` |
| `JetBrainsMono/JetBrainsMono-Bold.ttf` | `5590990c82e097397517f275f430af4546e1c45cff408bde4255dad142479dcb` |
| `NotoSansJP/NotoSansJP-Regular.otf` | `dff723ba59d57d136764a04b9b2d03205544f7cd785a711442d6d2d085ac5073` |
| `NotoSansJP/NotoSansJP-Bold.otf` | `1b0edfb500b73a4fa8a4fcaae1bbbd403994e08e73e3e0da37e70d3853f42c5f` |
| `NotoSansDevanagari/NotoSansDevanagari-Regular.ttf` | `4e3c66638958c3e2ab5d37f47a8deb89fffeb7be9985c665a519bbc7ba762313` |
| `NotoSansDevanagari/NotoSansDevanagari-Bold.ttf` | `6a09c8d797cfc803d32cdc731e809424d74cbaff59f503de34ade421a08e5bc2` |
| `NotoSansArabic/NotoSansArabic-Regular.ttf` | `bdff3e5659d67e67def05b33f749683b9376ae819d65d3dd62ac4640b3aaef48` |
| `NotoSansArabic/NotoSansArabic-Bold.ttf` | `4e5462d2e8be880317b9f49b5b2da109ddb6a3563d91cc604b67f3535832a555` |

Release archives: `Inter-4.1.zip` `9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e`,
`NotoSans-v2.015.zip` `0c34df072a3fa7efbb7cbf34950e1f971a4447cffe365d3a359e2d4089b958f5`,
`JetBrainsMono-2.304.zip` `6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf`.

To add a family: copy static Regular/Bold files from its official release, add its `OFL.txt`,
add a row to `BUNDLED_FONTS` in `packages/renderer/src/tokens.ts` (with `script` for a script
font, and its families in `scriptFontFamilies` in `script.ts`) and to the tables above.

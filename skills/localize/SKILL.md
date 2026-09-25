---
name: localize
description: Make a language version of a planned video-studio project (e.g. Hindi, Japanese, Arabic, German) - translate the voiceover, on-screen text, text in the motion graphics, cover headline and post copy, re-time scenes for the language, validate, then render. Use when the user runs /video-studio:localize or asks for the video "in Japanese", "a Hindi version" or several language versions.
license: Apache-2.0
compatibility: Requires the video-studio plugin's bundled `engine` MCP server (Node.js 22.13+).
allowed-tools: mcp__plugin_video-studio_engine__localize mcp__plugin_video-studio_engine__spec_validate mcp__plugin_video-studio_engine__storyboard_render Read Edit
---

# Localize a video

The source project is never changed. Each language gets its own project
folder, `<project>/localized/<language>/` by default. One language at a time;
repeat for each language the user asked for.

1. Resolve the source project folder (absolute; it needs
   `project/video-spec.json`) and the BCP-47 tag (`hi-IN`, `ja-JP`, `ar-SA`,
   `de-DE`, ...). Ask which region when the user gives only a language
   and it matters (for example `pt-BR` or `pt-PT`).
2. **Step 1:** call `localize {project_dir, language}`. It copies the project
   and writes `project/translation.json` in the new folder. Every entry has a
   `path`, a `kind` and the `source` text. Many also have a `note`.
3. **Translate:** read the sheet and fill each entry's `target`:
   - Translate the meaning, not word by word, in the register of the brief
     (`project/creative-brief.yaml`). Keep the same claims: no new facts, no
     dropped caveats. Numbers, units, product and people's names stay as
     they are unless the language has an established form. Never make up
     statistics.
   - Stay within each note's budget (words, or characters for Japanese,
     Chinese, Korean and Thai). Narration that runs over the budget makes its
     scene longer when the sheet is applied.
   - Never translate code, commands, URLs or UI labels in screenshots. The
     sheet leaves most of these out already.
   - Mark the emphasised word with `*asterisks*` when a note asks for it,
     for example `"nicht *Bedeutung*"`. The emphasis has to be a word of the
     translated line.
   - For RTL languages (Arabic, Hebrew, Persian, Urdu), write the text in
     its natural order. The renderers handle direction. Keep Latin names and
     numbers as they are.
   - For CJK, do not add spaces between words, and keep lines short.
   - Hashtags: `#` followed by letters, digits or `_`, with no spaces. Use
     the tag people search for in that language, or keep the original.
   - Leave `target` empty only for text that stays the same (names). An
     empty target keeps the source text.
   Save the sheet with Edit. Do not edit the localized
   `project/video-spec.json` by hand: step 2 rebuilds it from the source spec
   and the sheet.
4. **Step 2:** call `localize {project_dir, language, apply: true}`. Report:
   - **re-timed scenes** and any change to `target_duration_sec`. If the
     result runs over the targets' duration limits, shorten the longest
     translations in the sheet and apply again.
   - **emphasis** notes: a dropped emphasis means no word was marked.
   - **errors**: fix them in the sheet (or, for structural errors, in the
     source spec, then run step 1 again, which keeps the unchanged
     translations) and apply again.
   If the call is refused because the source spec changed, run step 1 again,
   translate the new entries, then apply.
5. Call `storyboard_render` on the localized folder and show it. Then offer
   the `render` skill for that folder. Captions, fonts and the voice follow
   `spec.language`. A `voice_id` in the source spec is removed, because it
   speaks the source language. Suggest `lint` afterwards, because reading
   speed differs by language.

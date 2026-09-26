---
name: lint
description: Lint a video-studio project against its platform targets (TikTok, Instagram, YouTube Shorts, LinkedIn, Facebook Page API) - duration/fps/size envelopes, text cut off, text or captions under the app UI, contrast, caption reading speed and timing (captions too brief or out of sync with the voice, flicker), cuts off the beat, on-screen text too brief to read, story arc, post caption and hashtag limits, cover, brand banned phrases - and fix what it finds by editing the spec and re-rendering. Use when the user runs /video-studio:lint, asks whether a video is ready for a platform, or after a render before publishing.
allowed-tools: mcp__plugin_video-studio_engine__lint mcp__plugin_video-studio_engine__spec_validate mcp__plugin_video-studio_engine__render_submit mcp__plugin_video-studio_engine__job_status Read Edit
---

# Lint a video for its platforms

Lint compares the project with the platform contracts in `platform-specs/`
(one per target in the spec's `targets`) and with the design rules. Platform
limits live only in those contracts: quote numbers from the findings, never
from memory.

1. Use the project folder the user named, else the cwd (absolute path). It
   needs `project/video-spec.json`; without a render only spec checks run
   (envelopes, caption placement, reading speed, post copy, cover, brand).
2. Call `mcp__plugin_video-studio_engine__lint {project_dir}` (add
   `quality: "preview"` to check a preview render; the default is `final`).
3. Report the status (`pass`, `warn`, `fail`) and each finding as
   `severity id [target] scene: message`, then its `fix`.

## Fix loop (at most 3 passes)

Run this loop when lint returns errors, or warnings the user wants cleared:

1. Apply each finding's `fix` to `project/video-spec.json` (or `brand.yaml`
   for contrast): edit only the fields the fix names, keep every other value,
   and keep claims grounded (do not add facts to shortened text).
   - `caption_mask`: prefer removing `captions.position` so captions are
     placed automatically; use the suggested `y` only if the user wants a
     manual position.
   - `text_overflow`, `reading_density`: shorten the named text or voiceover,
     or lengthen the scene; do not change the meaning.
   - `envelope_*`: adjust durations, `master` or `targets` as the fix says; ask
     the user before dropping a target.
   - `brand_banned_phrase`: rewrite the named field without the phrase.
   - Timing findings need a render (they read `renders/<quality>/render-state.json`,
     `captions/captions.json` and the voice tracks):
     - `caption_too_brief`: a caption is on screen for less than its
       reading time (0.25 s/word + 0.3 s, min 0.7 s; CJK 9 characters/s).
       Lower brand `captions.max_lines`, set a slower `voice.rate_wpm`, or
       shorten the scene's voiceover.
     - `caption_sync`: a caption starts over 250 ms before its first spoken
       word or stays over 400 ms after its last (beyond the 0.8 s minimum
       display), or speech runs over 1.5 s with no caption. Re-render first
       (stale captions); then split long voiceover sentences. Not checked
       when the voice has no timings (`timing_source: none`).
     - `caption_gap` (minor): captions separated by under 120 ms flicker.
       Re-render; if it stays, join the two phrases.
     - `cut_off_beat`: with `audio.beat_sync` on, a cut further than the
       tolerance (default 250 ms) from a beat, usually because moving it
       would clip speech. Set the named `duration_sec`, shorten the
       voiceover, or raise `audio.beat_sync.tolerance_ms`.
     - `onscreen_too_brief`: on-screen text (`on_screen_text` + props) the
       voiceover does not say needs more reading time than the scene has
       (3 words/s after a 1 s settle). Cut the text, say it, or lengthen
       the scene. Silent scenes already flagged by `reading_density` are
       not repeated.
     - `cue_unmatched`: a word cue could not be placed (the word is not in
       the spoken words, the render is silent so there are no timings, or
       it is spoken after the scene ends); that item kept its default
       timing. Cue a word the scene says, render with a voice, or move the
       word earlier.
     - `cue_too_close`: two cues in a scene land under 0.4 s apart. Drop
       one cue or cue a later word.
   - `text_repeats_captions`: a narrated scene's on-screen text repeats its
     voiceover word for word while burned-in captions show the same words.
     For kinetic text that types out the narration, set `burn_captions:
     false` on that scene (the .srt/.vtt keep the words). Otherwise put
     something else on screen (the number, a keyword, the payoff), or cut
     it to the 1-3 words that matter.
   - `cutaway_rhythm`: a cutaway (`footage.cutaway`) starts inside the
     hook's first second, lasts outside 3–10 s, or leaves under 2 s of the
     speaker since the previous one. Move, lengthen, split or merge it.
   - `story_structure` (3+ scenes): no tension scene (question, problem,
     contrarian_claim, story) in the first 40% after the hook, or the last
     scene before the CTA/end card is not a payoff (payoff, result, reveal,
     loop_back). Re-plan those beats with the plan skill's
     `references/storytelling.md`; ask the user before restructuring.
2. Run `mcp__plugin_video-studio_engine__spec_validate {project_dir}` and fix
   any errors it reports.
3. Re-render with `mcp__plugin_video-studio_engine__render_submit` (same
   quality as before) and poll `mcp__plugin_video-studio_engine__job_status`
   until it finishes. Cached scenes are reused, so this is quick.
4. Lint again. Stop when there are no errors, after the third pass, or when a
   finding repeats unchanged after its fix: then show the remaining findings
   and ask the user how to proceed.

The full report is in `qa/lint.md` (machine-readable: `qa/lint.json`). UI
masks are approximations of each app's interface, not official safe zones, so
also look at a frame of the reel before posting.

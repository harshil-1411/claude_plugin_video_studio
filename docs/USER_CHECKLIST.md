# User checklist: what only you can check

The autonomous loop (2026-09-25) built and tested Phases 4, 5, 6 and the local part of 8 inside Claude Code's sandbox. The sandbox blocks macOS `say`, headless Chrome and `pnpm install`, so the items below were unit-tested but not run for real.

Run them in a normal terminal, in this order, and paste back anything that fails. Each item says what "pass" looks like.

## 1. Refresh the lockfile — ✅ done 2026-09-26 (`03610f3`, all checks passed)

The `ingestion` package now depends on `media`. In the sandbox that link was made by hand.

```
cd ~/Desktop/plugin_knowledge_to_video
pnpm install
git add pnpm-lock.yaml && git commit -m "Lockfile: ingestion depends on media"
pnpm typecheck && pnpm test && pnpm bundle && pnpm smoke
```

**Pass:** the tests pass, and smoke lists 25 tools and 18 templates.

## 2. Real narration — ✅ done 2026-09-26 (`say` voice and captions verified)

```
node scripts/render-project.mjs examples/text-to-motion-graphic --voice system --renderer ffmpeg
```

**Pass:** you hear the `say` voice, and the captions follow it.

Then do the Japanese Whisper explainer. Copy it out of the scratchpad first, or re-create it with `/video-studio:create` and `/video-studio:localize`. In a Claude session, ask for a Japanese version of any project.

**Pass:**
- **Japanese:** narration uses the Kyoko voice.
- **Hindi:** there is no Hindi system voice, so it falls back to silent and says why.

## 3. HyperFrames renders — ✅ done 2026-09-26 (`examples/reel-grammar`: all 7 new kinds + energetic style match the ffmpeg render)

Install the optional renderer (it also brings puppeteer-core, which `demo` needs):

```
cd "$HOME/.video-studio" && PUPPETEER_SKIP_DOWNLOAD=1 npm i @hyperframes/producer@0.8.78 --prefix deps
```

Then, in `claude --plugin-dir ~/Desktop/plugin_knowledge_to_video`, render a project that uses the new scene kinds (stat, timeline, split_screen, quote, kinetic_text, map, lower_third) with `renderer: hyperframes`. The text-over-music or faceless-listicle templates are good for this.

**Pass:**
- the stat values count up
- kinetic text reveals word by word
- the energetic style shows UPPER CASE headings with spring motion
- a Japanese, Hindi or Arabic scene shows correct glyphs, and Arabic runs right to left

## 4. Demo capture (10 min)

Start any local web app (for example `npx serve` in a folder with an `index.html`). Then, in a Claude session:

```
/video-studio:demo record a 5-step walkthrough of http://localhost:3000
```

Approve the steps when asked.

**Pass:**
- `source/assets/demo-<id>.mp4` exists
- inputs are blurred in the recording
- a cursor is visible
- the plan's `screen_capture` scenes cite `video:demo-<id>.mp4#step-N`

## 5. A real talk or interview — ✅ done 2026-09-26 (real meeting recording → shorts → captioned 3-platform packages)

With any MP4 of someone talking (2–10 min):

```
/video-studio:shorts ~/path/to/talk.mp4
```

The skill asks before downloading the whisper model (about 148 MB); say yes.

**Pass:**
- 3 candidates with sensible hooks
- `shorts/<id>/` projects that validate
- one rendered short with captions that match the speech

## 6. A folder of your own clips — ✅ done 2026-09-26 (8 CC0/PD Wikimedia clips → beat-synced aesthetic b-roll: 9 cuts on 120 bpm beats, −13.8 LUFS, QA pass)

```
/video-studio:create ~/path/to/clips-folder as an aesthetic b-roll reel with the upbeat music, beat-synced
```

**Pass:**
- cuts land on the beat (the render reports "beat sync moved N cuts")
- the clips are cropped to 9:16
- `post.json` has a `sound` note saying trending sounds are added in the app

## 7. Optional

- **C2PA with your own certificate:** `export {sign: true}` uses c2patool's *test* certificate, which validators report as untrusted. For trusted credentials, configure c2patool with your own signing certificate and key.
- **TikTok contract:** re-check `platform-specs/tiktok.yaml` against developers.tiktok.com, which returned 503 during the build, and bump `contract_version`/`verified`.
- **CI:** removed at the user's request (2026-09-26). If it is ever wanted again, the old workflow is in git history (`.github/workflows/ci.yml`) and the plan was a GitHub Action. It renders the examples with the silent voice and ffmpeg, lints them and runs `VS_TEST_GOLDEN=1` golden frames.
- **Marketplace:** replace `<owner>/<repo>` in the README install section and submit to the community marketplace.
- **Hero video with narration:** re-render `docs/media/hero.mp4` from its project with `--voice system --quality final`. The committed one is a silent preview.
- **HyperFrames camera moves:** render a project whose scenes set `motion` (one of each: push_in, pull_out, punch, reveal, drift, hold) with `renderer: hyperframes`. It should match the ffmpeg render's moves, with no visible edges on pull_out or drift. Only the page generation and the HyperFrames linter were verified in the sandbox.
- **Word cues with a real voice:** render a narrated project with `cues` on a timeline or stat scene (`--voice system`), with both `--renderer ffmpeg` and `--renderer hyperframes`. Each item should appear as its word is spoken (roughly, since `say` timings are estimated). The sandbox renders silently, so it only tested cues against transcript timings.
- **Turn on the pre-push check (once):** `pnpm hooks`. From then on every `git push` runs `pnpm check --push` first (about 3 minutes). `git push --no-verify` skips it in an emergency.
- **Exact voice timings:** download the whisper model once, if you haven't: ask Claude to `transcribe` any video with `download_model: true` (about 148 MB), or set `VS_WHISPER_MODEL`. Then render a narrated project with `--voice system`. `render-state.json` should show `timing_source: aligned`, and the voice reason should say "aligned to the audio". Captions and word cues should land on the spoken words.
- **HyperFrames count-up and scene openings:** render a project with a stat (e.g. 12 packages) and a few scenes using `--renderer hyperframes`. Run `review` in strip mode on the stat: digits count up, the unit stays put, and frame 0 of each scene isn't blank.
- **Brand logo:** add `visual.logo` and `visual.logo_placement: {position: top_right}` to a brand.yaml and render. The logo should appear in the corner on every scene but the end card.

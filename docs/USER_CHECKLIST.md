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

## 2. Real narration (5 min)

```
node scripts/render-project.mjs examples/text-to-motion-graphic --voice system --renderer ffmpeg
```

**Pass:** you hear the `say` voice, and the captions follow it.

Then do the Japanese Whisper explainer. Copy it out of the scratchpad first, or re-create it with `/video-studio:create` and `/video-studio:localize`. In a Claude session, ask for a Japanese version of any project.

**Pass:**
- **Japanese:** narration uses the Kyoko voice.
- **Hindi:** there is no Hindi system voice, so it falls back to silent and says why.

## 3. HyperFrames renders (10 min)

Install the optional renderer (it also brings puppeteer-core, which `demo` needs):

```
cd "$HOME/.video-studio" && PUPPETEER_SKIP_DOWNLOAD=1 npm i @hyperframes/producer@0.8.75 --prefix deps
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

## 5. A real talk or interview (15 min)

With any MP4 of someone talking (2–10 min):

```
/video-studio:shorts ~/path/to/talk.mp4
```

The skill asks before downloading the whisper model (about 148 MB); say yes.

**Pass:**
- 3 candidates with sensible hooks
- `shorts/<id>/` projects that validate
- one rendered short with captions that match the speech

## 6. A folder of your own clips (10 min)

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

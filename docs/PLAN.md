> Revised 2026-09-25 after the v2 research gap analysis (`deep-research-report_v2.md`). The original 12-month plan is kept in git history; this revision reorders the roadmap local-first.

# video-studio: revised roadmap after the v2 research gap analysis

## Context

Phases 0–3 are built: ingest → ContentIR, plan → VideoSpec, and local render to `dist/reel.mp4` with the Mac `say` voice, the FFmpeg and HyperFrames renderers, captions and technical QA. 391 tests pass.

The user added `deep-research-report_v2.md` and asked three things: what gaps the two research reports have, whether any already-built code must change, and for the plan to be updated. The user decided:
1. **Local-first next.** Everything must run without API keys. Paid providers move later.
2. **Repo demo capture:** the user starts their own app and gives a URL. The plugin never runs repo code.

## Gap analysis

### v1 → v2: what v2 adds
- **Where v2 moves the centre of gravity.** v1 was "provider-neutral compiler plus routing". v2 makes these the P0 launch set:
  - a platform-aware compiler
  - versioned platform contracts
  - `video lint`/`test`
  - covers
  - brand-as-code
  - a caption engine
  - `video.lock`
  - CI visual regression
  - repo-to-demo capture
  - local-first privacy
- **Genuinely new in v2:**
  - per-platform UI exclusion masks
  - separate text fields for speech captions, burned subtitles, post caption and cover text
  - a design grid and type scale
  - accessibility lint (contrast, flashing, caption sync)
  - reel grammar layers (platform → grammar → style pack)
  - motion-personality tokens
  - variants and experiments
  - localization (RTL/CJK)
  - AI-disclosure flags and C2PA
  - clean-room reference analysis
  - long-footage-to-shorts

### Gaps and errors in the reports themselves
- **Packaging.** Both reports assume a `bin/`/`commands/` CLI. Real constraint: claude.ai/Cowork reject `bin/`, `commands/` is legacy, and secrets only reach MCP. We already chose MCP; v2's `/video:*` names become `/video-studio:*` skills.
- **Sora.** v2 still lists Sora as a provider option. It was removed 2026-09-24, as v1 noted. Keep it excluded.
- **Execution environment.** Neither report covers it:
  - Sandboxes block `say` and headless Chrome.
  - Low-RAM machines need preview modes.
  - Chrome's headless launch can hang on the macOS keychain (diagnosis in progress: `--use-mock-keychain`).
- **Repo demo safety.** v2's "launch the app" contradicts v1's "never execute repo code". Resolved: the user starts the app.
- **Missing layers:**
  - **Fonts:** determinism needs shipped OFL fonts (Inter, Noto Sans, JetBrains Mono). Today, "Inter" silently falls back to other fonts.
  - **Audio:** no licensing story for music or SFX, and no ducking. Addressed by the audio-first track in Phase 5 (music bed, `voice: none`) and Phase 6 (native sound, beat sync).
  - **Creative quality:** no evaluation method beyond technical QA.
  - **Platforms:** Windows support is not addressed.
  - **Unverified facts:** v2's platform numbers are unverified by us (Kling, HeyGen pricing). Treat them as data with a source URL and verified date, never as hard-coded prose.
- **Local TTS.** v2 assumes Kokoro/Whisper P0 downloads. The user declined large model downloads, so: macOS `say` now, espeak-ng on Linux, and any model download is opt-in only.

### Already-built code that must change
Each change is cheap now and expensive later:

| # | Change | Where |
|---|---|---|
| M1 | **Master canvas + targets.** VideoSpec gains `master {width, height, fps}` (default 1080×1920@30) and `targets[]` (platform contract ids). The existing `platform`/`aspect_ratio` stay as the primary target for back-compat. | `packages/schema/src/video-spec.ts`, `spec_scaffold`, validators, pipeline |
| M2 | **Separate text channels.** Add `cover {headline, focal_time_sec}` and `publish.<platform> {post_caption, hashtags[], ai_disclosure}`, distinct from `voiceover`/`on_screen_text`/`captions`. | video-spec.ts, plan skill + references, `social-copy.md` → per-platform `post.json` |
| M3 | **Platform contract registry.** Add `platform-specs/*.yaml` (instagram, tiktok, youtube-shorts, linkedin, facebook-page-api) with source URL, `verified` date, duration/size/fps/codec envelopes, cover specs, caption limits and UI exclusion masks (normalized rects). Safe area = design grid ∩ union of enabled targets' masks. This replaces `SAFE_MARGINS` + `captionReserveFraction`. | new `packages/platforms`; `packages/renderer/src/text-layout.ts` (`safeArea`, `LAYOUT_VERSION`→3); `packages/media/src/captions.ts` |
| M4 | **Brand v2 (back-compatible).** Add typography weights and multilingual fallback, a `captions` block (family, weight, `active_word`, `plate_opacity`, `max_lines`), a `motion` block (personality, transition_ms), logo placement and max fraction, a forbidden-treatments list, and voice `banned_phrases`. | `packages/schema/src/brand.ts`, `packages/renderer/src/tokens.ts` |
| M5 | **Caption engine defaults.** Phrase-level captions (3–7 words, max 2 lines), a semi-opaque plate for legibility, and keyword emphasis by default (karaoke only when `active_word: true`). Punctuation-aware breaks, and placement from the platform masks. | `packages/media/src/captions.ts` (`groupCaptionLines`, `toAss`), HTML caption JSON |
| M6 | **Covers.** Replace "thumbnail at hook midpoint" with a cover compiler: render `cover.headline` as a dedicated deterministic frame, export per-target covers (e.g. 9:16 JPEG ≤ 8 MB, YouTube 2160×3840), a center-square crop preview, and lint of text inside both crops. | `packages/mcp/src/pipeline.ts` (makeThumbnail call), renderer |
| M7 | **Per-platform dist.** Write `dist/<target>/{video.mp4, cover.jpg, captions.srt/vtt, post.json, qa.json}` plus top-level `video-spec.json`, `video.lock`, `provenance.json` and `storyboard.md`. Transcode or re-mux only where a contract differs. | pipeline export stage |
| M8 | **Bundled fonts.** Ship OFL fonts in `fonts/` (Inter, Noto Sans, JetBrains Mono, a few MB) and use them in both renderers and libass (`fontsdir`), so output doesn't depend on host fonts. | `tokens.ts` (`resolveFontFile`), hyperframes-compose `@font-face`, `burnCaptions` |
| M9 | **Chrome probe fix.** Add `--use-mock-keychain --password-store=basic`, pending the user's diagnostic, so HyperFrames works outside the sandbox. | `packages/renderer/src/hyperframes-renderer.ts` |

## Revised roadmap

Phases 0–3 are done. The Phase 3 exit (interactive `/video-studio:create`) is verified once M9 lands. Each phase ends demoable, keeps the ≤ 2-agent limit, and needs no API keys unless stated.

### Phase 4: Platform compiler and video engineering (local-first P0)
- Build **M1–M9** above.
- **`lint` tool and skill.** Deterministic checks from render metadata and platform contracts:
  - duration, codec, fps and size envelopes per target
  - text overflow (the `fitText` truncation flag → fail for hook and caption, warn for decorative text)
  - content or caption inside UI masks
  - WCAG contrast from tokens (4.5:1 normal, 3:1 large)
  - flashing
  - reading density (words/sec per caption line)
  - caption–audio sync
  - cover-crop safety
- **`verify` tool and skill.** A claim coverage report ("12/12 factual claims have evidence; 0 unsupported numbers"), reusing `validateVideoSpecSemantics`.
- **`video.lock`.** Records renderer, ffmpeg, voice and font versions, platform-spec verified dates, and asset hashes. It classifies changes as creative, renderer, spec, asset or metadata. Built from `render-manifest.json` and the scene sidecar cache keys.
- **`test` + visual regression.**
  - Golden frames per example (sampled frames + perceptual diff).
  - `diff` tool: spec diff + frame diff between two renders.
  - GitHub Action: render the examples with silent voice + FFmpeg, lint, and upload artifacts.
- **Exit:** `/video-studio:create README.md --targets instagram,tiktok,youtube-shorts` produces three platform packages. Lint catches a deliberately misplaced caption under a TikTok UI mask, the fix loop clears it, and the CI golden test passes.

### Phase 5: Reel grammar, archetypes and variants
- **Enum extensions:**
  - `ScenePurpose`: question, contrarian_claim, story, step, comparison, reveal, objection, testimonial, result, loop_back.
  - `DeterministicKind`: quote, stat (split out of chart), timeline, split_screen/before_after, lower_third, kinetic_text, map (basic).
  - Both renderers implement the new kinds.
- **Archetypes** (templates become grammar): carousel-story, animated-explainer, product-demo, product-UI, faceless-listicle, case-study, before-after, talking-head (needs footage; lands in Phase 6).
- **Style packs** (`styles/`): minimal, editorial, technical, energetic. Motion-personality tokens map to easing and durations in both renderers.
- **`variants` tool and skill:** N hooks × M covers from one spec, with an experiment manifest (hypothesis, variant ids). `adapt` handles target, aspect and duration changes.
- **Audio-first, no-speech reels (local):** music-only and text-over-music formats, with no voiceover.
  - **Audio bed:** a `spec.audio.music {file, volume_db, fade_in_ms, fade_out_ms, loop}` track mixed under the voice.
    - It ducks under speech (sidechain compress) and is loudness-normalised with the rest.
    - Allowed sources: a file the user supplies, or a small bundled set of CC0 / royalty-free tracks with licence and source URL recorded like `fonts/README.md`. No downloads without asking.
  - **`voice: none` mode:** scene timing comes from `duration_sec` and on-screen text reading time instead of speech.
    - Captions are off or on-screen text only.
    - QA stops reporting intended silence, lint checks on-screen text reading speed instead of words per second of speech, and the brief/plan skills write for text-over-music.
  - **Rights:** each audio file's licence is recorded in the manifest, `video.lock` and provenance. "Trending sounds" live inside each platform's app and cannot be added by the plugin; `post.json` notes that the user picks one when posting.
  - **Archetype:** `text-over-music` (kinetic text, stat and quote cards, product UI stills on a music bed), including a music-only product-demo variant.
- **Exit:**
  - One README compiles into 3 archetypes × 2 styles, and `variants --hooks 3 --covers 2` produces 6 packages.
  - The same README also compiles as a `voice: none` text-over-music reel with a bundled track. Lint and QA pass without silence warnings, and the track's licence is in the lock and provenance.

### Phase 6: Real footage and repo demo capture (local)
- **Demo capture** (the user starts the app and gives a URL):
  - A `demo` skill drives Playwright with the system Chrome (`channel: 'chrome'`, no browser download) against the URL, with explicit confirmation.
  - Scripted interactions come from a plan: click, type, scroll, zoom.
  - It records webm and applies cursor choreography.
  - Secrets are redacted with DOM masking of inputs.
  - "Actual UI only": scenes can't invent screens.
  - `screen_capture` scenes then render from the recording.
- **Footage input:**
  - Ingest video/audio files.
  - Local ASR via whisper.cpp, which is already installed. Its model download (~150 MB base.en) is **opt-in, asked first**. Fallback: user-supplied SRT.
  - Talking-head archetype.
  - Long-to-short candidate extraction.
- **Audio-first footage reels** (from the user's own clips; builds on the Phase 5 music bed and `voice: none`):
  - Keep each clip's native sound (ambient, ASMR/Foley), with per-scene `audio: native | music | mute | mix` and crossfades between clips.
  - Optional user-supplied SFX files placed on scene beats.
  - Beat sync: detect beats and onsets in the music track locally (ffmpeg audio filters, no model download) and snap cuts to them.
  - Archetypes:
    - `aesthetic-broll`: mood clips on a music bed
    - `silent-vlog`: daily-life footage with native sound and minimal text
    - `oddly-satisfying`: close-up loops, crisp native sound
    - `ambient-slice-of-life`: long takes with natural sound
  - Lint and QA: text-only captions, no speech checks, loudness targets for music-led audio.
- **Clean-room `analyze`:** reference video → format grammar (hook type, shot lengths from ffmpeg scene detection, caption density and position). Structure only; it never copies words or assets.
- **Exit:**
  - A running local app URL becomes a product-demo reel.
  - A founder-interview mp4 becomes 3 candidate shorts.
  - A folder of the user's clips plus a music file becomes a beat-synced `aesthetic-broll` reel. A second reel keeps native sound only (`silent-vlog`).

### Phase 7: Providers, policy and provenance (keys required)
- **Provider SDK:** adapter interface + capability matrix + mock conformance suite.
- **Adapters:** Runway (`@runwayml/sdk`, router `dryRun`), fal.ai (Kling/Veo/Hailuo), HeyGen v3 (consent-gated), ElevenLabs (already coded; wire it in).
- **Cost planner:** budgets and retry budget.
- **Jobs:** resume and rerender a single scene.
- **Policy and privacy:**
  - `policy.yaml` engine
  - default-deny external calls for confidential/source-code data
  - a "what leaves this machine" report
  - AI-disclosure flags per platform (TikTok `is_aigc`, Meta self-disclosure)
  - per-asset rights ledger (origin, license, consent, ai_disclosure)
- **Exit:** a mixed reel with 2 provider B-roll scenes is resumable without paying twice. A confidential source reroutes to local rendering.

### Phase 8: Localization, accessibility depth, launch → Stable
- **Localization:** translate script, re-time voice, RTL/CJK line breaking with Noto fonts, multi-language variants.
- **Accessibility:** optional face/UI collision avoidance via frame sampling (vision optional), and sound-event captions.
- **Launch:**
  - optional C2PA signing
  - Remotion opt-in renderer
  - docs, contributor guides (archetypes, styles, platform packs, providers)
  - community marketplace submission
  - README hero video made by the plugin itself
- **Exit:** whisper paper PDF → EN/HI/JA grounded explainers that pass lint.

### Phase 9: Distribution and learning (go/no-go)
- **Publishers** (dry-run first, explicit approval, capability query before posting): TikTok Direct Post, YouTube, LinkedIn, Meta.
- **Analytics:** normalized metrics that keep each platform's raw numbers; no universal virality score.
- **Experiment loop** feeding the next brief.
- **Hosted:** Docker render worker.
- SSO and collaboration stay deferred.

## Immediate next steps
Updated 2026-09-25. M9 and the Phase 3 exit are done. Phase 4 steps 1–2 are done: M1–M6, M8, platform contracts and lint. See `docs/HANDOFF.md`.
Phase 4 is done (exit passed 2026-09-25; CI deferred). Phase 5 is done (exit passed 2026-09-25 in the sandbox). The autonomous loop now runs Phase 6, then local 8. Progress is in the "Loop state" block of `docs/HANDOFF.md`.

## Verification
- **Every step:** `npx tsc -b`, full `npx vitest run`, `node scripts/smoke-mcp.mjs`, `claude plugin validate --strict .claude-plugin/plugin.json`, and a rebuilt `dist/mcp.mjs`.
- **Visual:**
  - Extract frames from each target's `video.mp4` and inspect them.
  - The lint golden test has a deliberately bad fixture that must fail and a fixed one that must pass.
- **Outside the sandbox (user-run):**
  - `node scripts/render-project.mjs examples/text-to-motion-graphic --voice system --renderer hyperframes`
  - `claude --plugin-dir .` → `/video-studio:create …`

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

Phases 0–3 are done. The Phase 3 exit (interactive `/video-studio:create`) is verified once M9 lands. Each phase ends demoable, keeps the ≤ 2-agent limit, and needs no API keys unless stated. Phase 6.5 (directed motion) comes next, before Phase 7; its waves follow the "Agent execution model" below.

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

### Phase 6.5: Directed motion and craft (local, no keys)
Why: the user rejected the 0.2.0 self-intro reel as "too simple". The reference piece had about one big visual change per second and only 0.5 s frozen; ours was 63 s long with 42.6 s frozen, because every scene had to be one of 15 fixed kinds.

Motion-design research (2026-09-27) found one pattern behind the strongest code-rendered work: Claude writes each scene as code, and every frame is a pure function of time (`seek(t)`). That single rule is what makes exact beat sync, perfect loops, motion blur and parallel rendering possible. The same research supports:
- measured beat grids;
- a still-frame review before the full render;
- a banned-effects taste list;
- seamless loops;
- a locally synthesized score;
- provider-neutral shot cards (Phase 7 step 0).

The work is split into waves for at most 2 agents; see "Agent execution model".

- **1. `motion` scene kind (Claude-authored code):**
  - **Schema** (`packages/schema/src/video-spec.ts`):
    - add `motion` to `DeterministicKind`, with props `z.strictObject({ html, text?, effects?, loop?, duration_hint? })`;
    - `html` is a project-relative file, confined with `resolveInsideProject` (`packages/core/src/project.ts`);
    - add `html` to `NON_CLAIM_KEYS`. Viewer-facing copy must also sit in `props.text[]`, so grounding, `verify`, `localize` and sound/word cues still see it.
    - Add the kind in `cues.ts`, `template.ts`, `localize.ts`, `lint.ts` and `renderer/src/footage.ts` (overlay kinds).
  - **Authoring contract:**
    - `window.readyForCapture` is a Promise that resolves after fonts and images have decoded;
    - `window.seek(t)` is synchronous and draws everything from `t` alone;
    - no CSS transitions or animations, timers, `requestAnimationFrame`, wall clock or unseeded randomness;
    - physics is closed-form, or pre-simulated and indexed by time;
    - springs are closed-form step responses, and a value whose target changes several times is the sum of one spring per change.
  - **Composer** (`hyperframes-compose.ts`): wraps the page and registers a `window.__timelines[id]` adapter whose `seek` calls `window.seek` (same shape as `timelineScript`).
  - **Runtime library** (`motion-kit.js`, bundled, MIT): `spring`, easings, a seeded `rng`, `lerp`, `stagger`, `beatAt`/`downbeatAt`.
    - The engine injects `window.__vs = { fps, duration, beats, downbeats, tokens, brand }`, so a piece uses the brand palette and fonts and the measured beat grid instead of hard-coded values.
  - **Security** (the HTML is untrusted input, and the producer launches Chrome with `--no-sandbox`):
    - **CSP:** the engine injects `default-src 'none'`, allows local scripts, styles, images and fonts only, and sets no `connect-src`.
    - **Static lint:** the page is parsed with a small MIT JS parser, e.g. acorn. It rejects:
      - network access: `fetch`, XHR, WebSocket, remote `import()`, remote `src`/`href`;
      - clocks: `Date.now`, `performance.now`;
      - unseeded `Math.random`;
      - timer- or rAF-driven state;
      - CSS `transition`/`animation`.
    - **Assets:** must sit next to the HTML, inside the project.
  - **Cache:** the HTML bytes and its local assets are hashed into `sceneCacheKey` (`packages/renderer/src/select.ts`, next to `sceneImages`).
  - **Renderers:**
    - HyperFrames only;
    - the ffmpeg renderer draws a labelled stand-in from `props.text` (revive `fallback.ts`) and reports it as a fallback, never silently.
- **2. Pre-render stills and determinism:**
  - **`packages/mcp/src/stills.ts`:** opens the composed page with the producer's own puppeteer-core (as `puppeteerLaunchProbe` does), seeks to the given times and takes screenshots.
  - **`stills` MCP tool:**
    - times can be explicit, every `beat` or every `downbeat`;
    - works for every HyperFrames kind, not just `motion`;
    - tiles the frames with `planSheets`/`tileSheet` from `review.ts`.
    - Claude views the sheet and fixes cramped, overlapping, off-grid or unreadable moments before the full render.
  - **Determinism check:**
    - seek t₁, then t₂, then t₁ again; the frame hashes must match (finding `nondeterministic_scene`);
    - runs automatically before a `motion` scene renders;
    - with `loop`, `render(0)` must equal `render(end)`.
- **3. Beat analysis v2** (`packages/media/src/beats.ts`, backward compatible):
  - **New optional `BeatAnalysis` fields:** `downbeats_ms`, `bar_energy[]`, `drop_ms`, `alternate_bpm`, `analysis_version`. Bumping `analysis_version` invalidates cached analyses.
  - **Detection:**
    - downbeats from low-band linear energy with local normalisation;
    - an octave check that reports half/double-time as `alternate_bpm`;
    - trimming grid points before the first onset and after the last (today the grid runs to the end of the file);
    - excluding a partial final bar from drop detection.
  - **`audio.beat_sync.snap`:** `beat` (default) or `downbeat`, in `beatSyncDurations` (`pipeline-media.ts`). A cut still never moves into a voiceover.
  - **SFX peak alignment:** each effect's peak offset is measured once (cached by file hash), so the peak, not the file start, lands on `at_sec`.
  - **Tests:** synthetic tracks at 75–174 BPM with offsets. Pass: tempo within 1 BPM, downbeat within 20 ms, drop within 30 ms.
- **4. Motion-density QA and reference metrics:**
  - **New `technicalQa` checks** (`packages/media/src/qa.ts`):
    - `motion_density`: big changes per second, from the ffmpeg scene-change score;
    - `longest_static`: the longest stretch with no change.
  - **`frozen_frames` becomes a fail above 15% of runtime.**
  - **Thresholds are data:**
    - new optional template `pacing.min_changes_per_sec` and `pacing.max_frozen_pct`;
    - `brief.acceptance` overrides them.
  - `QA_VERSION` goes to 4.
  - **`compare`:** gains a `reference` side (any local video file). It reports frozen seconds, changes per second, cut rate and loudness next to ours, in the HTML and in the structured output.
- **5. Taste guard and acceptance checks:**
  - **Styles:**
    - `Style.motion.avoid: EffectId[]`, from a closed enum: `shake, rgb_split, lens_flare, particle_burst, shockwave, neon_glow, grid_floor, flash, bouncy_easing`;
    - the four packs fill it in, and each pack's `version` is bumped.
  - **New lint rules** (the usual `checkX(...)` plus one line in `lintProject`):
    - `banned_effect`: a scene's declared `effects`, transition or motion pattern hits the style's avoid list or `brand.visual.forbidden`;
    - `acceptance_unmet`, fed by render state;
    - `loop_seam`.
  - **Honest limit:** lint only sees declared effects. Visual taste is also reviewed by the `creative-director` agent against the stills sheet.
- **6. Loop mode:**
  - `master.loop: boolean`.
  - **QA:**
    - first vs last frame SSIM ≥ 0.99, reusing the `golden.ts` SSIM;
    - the music bed loops at the same seam;
    - the audio level jump across the seam stays under a threshold.
  - **Planning rule:** cyclic motion periods must divide the loop length.
- **7. Original score, synthesized locally:**
  - **`packages/media/src/score.ts`** (promoted from `scripts/generate-music.mjs`):
    - `synthScore({ bpm, bars, key, progression, sections, drop_bar, seed })`;
    - deterministic, using ffmpeg `aevalsrc` only;
    - no downloads, no GPL.
  - **`MusicBed`:** `music: "synth:<preset>"` or an inline `synth` block.
  - **Output:**
    - cached by parameter hash;
    - licence "generated (CC0)" in `video.lock`, provenance and `post.json`;
    - the known grid goes straight into render state, with no detection needed.
- **8. Motion blur (spike first):**
  - **Spike:** check whether the pinned HyperFrames producer can capture subframes.
  - **If it can't:** `quality: final` plus `master.motion_blur: { subframes: 3–6 }`, captured through the `stills.ts` path. Frames are averaged at centred offsets, for `motion` scenes only.
  - **Order:** added only after a plain render passes review.
  - **Cost:** seconds × fps × subframes browser renders. If that's too slow, defer it and record why.
- **9. Planning: inputs interview, beat plan and new formats:**
  - **Templates:** `inputs[]` (`id, prompt, kind: text|asset|choice|file, required, default`) plus the `pacing` density fields; `template_get` returns them.
  - **`skills/plan`:**
    - asks for the required inputs first: reference video, photo, real UI states and data, brand tokens, a licensed track or permission to synthesize one;
    - turns vague superlatives ("go all out") into `brief.acceptance`: minimum changes per second, maximum frozen %, holds of at least 400 ms, loop, target length.
  - **`skills/create` §4:** the approval gate shows a beat-level plan (every state or cut on the measured grid) before anything is built.
  - **`skills/plan/references/code-motion.md`:**
    - the contract;
    - lay out the final state first, then tween into it;
    - content enters after its container starts moving and leaves before the next change, so text never overlaps;
    - match cuts from measured positions;
    - at least one deliberate hold;
    - one accent colour;
    - no `will-change` on camera-scaled text;
    - never set opacity on a `preserve-3d` element;
    - the banned list.
  - **`agents/creative-director.md`:** also reviews the stills sheet against `brief.acceptance`.
  - **Six new templates, each with `inputs` and `pacing`:**
    - `ui-morph-loop`: one shape, never cut; real UI states;
    - `kinetic-type`: exact words; cue sheet from phrases;
    - `ambient-loop`;
    - `slides-narrated`: slide durations from measured audio;
    - `topic-explainer-9`: 9 shots, about 45 s, one style bible;
    - `product-hero`.
  - **Hook check** (`skills/plan/references/hooks.md`): big, relatable, easy, new, safe, built from the genuine promise, never from invented data.
  - **`variants`:** `durations: [15, 30]` for paired cuts.
- **10. Series bible (optional, last):**
  - A `series.yaml` next to the projects, holding characters, style, palette, recurring assets and motifs. `spec.series` references it.
  - Changing a character re-renders only the scenes that use it, through the cache key.
- **Standards for every item:**
  - **Schemas:** zod v4 strict objects. New fields are optional or defaulted, so existing specs stay valid. Semantic checks return a `fix`. Regenerate schemas with `pnpm schemas`.
  - **Caches:** bump the matching version whenever output changes (`QA_VERSION`, renderer versions, beats `analysis_version`, style `version`).
  - **Security:** Claude-written HTML is untrusted, and CSP, the static lint and path confinement are all required.
  - **Facts are data:** platform and provider facts live in versioned YAML with a source URL and verified date.
  - **Local-first:** no paid key, model download or GPL dependency. New dependencies are MIT/Apache and recorded with their licence.
  - **Truthful reporting:**
    - fallbacks are reported;
    - `stills` and prompt packs are never reported as renders;
    - QA values are pass, warn, fail or not_run.
  - **Tests:** written first, in colocated `*.test.ts`.
  - **Packaging:** skills keep portable frontmatter; `claude plugin validate --strict` passes; the CHANGELOG follows Keep a Changelog; the release is SemVer `0.3.0`.
- **Exit:**
  - **The self-intro reel, rebuilt in a new project** (the user's reference and photo are copied in with their permission; their original folder is not touched):
    - `compare` against the reference shows ≤ 1 s frozen and ≥ 0.8 big changes per second;
    - 0 `cut_off_beat` findings, with cuts on downbeats;
    - every `motion` scene passes the determinism check;
    - the user approves it visually, which is the real bar.
  - **`examples/code-motion-loop/`:** a 6 s `ui-morph-loop` on a synth score, with seam SSIM ≥ 0.99, lint 0/0 and golden frames.
  - **Security fixture:** a `motion` page that calls `fetch`, loads a remote image and reads `Date.now` is rejected by lint and blocked by CSP at render time.
  - **Release:** `node scripts/check.mjs --push` is green, and `CHANGELOG` `0.3.0` is written.

### Phase 6.6: Craft and hygiene (local, no keys; planned 2026-09-27)
Why: a read-only review of the MIT-licensed tubeai-skills repo found eight ideas worth re-expressing in our own design. Nothing is copied: no text, no code, no Remotion, no paid service, no yt-dlp workarounds. Each idea fills a gap we confirmed in our code. The waves follow the "Agent execution model" below.

- **1. Flash and flicker QA:**
  - **Measurement:** per-frame luma (`signalstats` YAVG) in the existing single decode pass (`packages/media/src/qa.ts`).
  - **Detects:** single-frame spikes (a frame that differs from both neighbours by ≥ ~40/255, including all-white or all-black frames mid-clip) and the most flashes in any 1 s window. The window count approximates WCAG 2.3.1 general flashes; red flashes are not covered, and the docs say so.
  - **Result:** QA check and lint rule `flashing`. It fails above 3 flashes/s (no override) and warns on any spike. `QA_VERSION` goes to 5.
- **2. Insert-sync lint:**
  - `insert_early`: a data item is on screen well before the voice says its number or claim. Fix: a word cue.
  - `insert_overstays`: an insert stays more than ~2.5 s after its sentence ends while another statement is spoken.
  - `insert_crowded`: one spoken sentence triggers several data items.
  - These use voice-track word times and the quantitative-token matcher, are skipped when there is no speech timing, and are documented in `visual-strategy.md`.
- **3. Motion timing from a reference reel:**
  - **`analyze` gains `motion_timing`:** entrance durations (median and p75), an easing class (`ease_out`, `ease_in_out`, `spring`, `snap`) read from the difference-energy curve around each change, stagger and holds. It is structure only; no frames are kept.
  - **Style pack:** `write_style` turns the measurement into `<project>/styles/<id>.yaml`.
  - **Project-local styles:** styles resolve from the project before the bundled `styles/`, and the file hash is part of the cache key.
- **4. A/V sync hygiene:**
  - **Measurement:** the probe reads each stream's `start_time`, `duration` and `nb_frames`.
  - **New QA check `av_sync`:** audio starts within 1 frame of the video, and the lengths match the frame count.
  - **Fix only what the measurement shows:** handle AAC priming in the mux if needed, take lengths from frame counts, and bump `ASSEMBLY_VERSION`.
- **5. Channel glossary and measured pacing:**
  - **Glossary:** `glossary [{term, variants, case_sensitive}]` on the brand and the series bible. It corrects whisper words (timings kept), seeds the whisper `--prompt`, and applies to every caption source. The TTS `terminology` stays separate.
  - **Pacing:** `analyze` keeps the pause list and reports silence share and median/p95 pause.
  - **`tighten pacing_from`:** derives the pause limits from the user's own edits.
- **6. Verify every `tighten` join:**
  - **Always, no ASR:** detect `partial_word` (a cut inside a word) and `repeated_word` across a join.
  - **With whisper installed:** re-transcribe ±2 s around each join (a new time-range option).
  - **Apply:** `apply` refuses partial words unless forced. Without whisper, the ASR part reports `not_run`.
- **7. Phase 9 research groundwork:**
  - `research-specs/titles.yaml` holds a title-length band of 24–58 characters, labelled heuristic and unverified.
  - A `title_length` lint warning on generated and `publish` titles.
  - `outlier_multiplier` and `outlier_rate` are defined for Phase 9 below.
- **8. NLE timeline export:**
  - **`export timeline: ["fcpxml", "otio"]`:** writes `dist/timeline/` with the scene clips, the audio mix, captions, `project.fcpxml` (1.10) and `project.otio`. Offsets are frame-accurate and paths relative.
  - **Status:** marked unverified until imported into Resolve or Final Cut.
- **Waves** (at most 2 agents; the lead owns schemas):
  - **W0 (lead):** glossary, `FormatGrammar.motion_timing` + pacing, `research-specs/titles.yaml`.
  - **W1:** A = items 1 and 4 (media/QA) · B = item 2 plus the title lint.
  - **W2:** A = item 3 · B = items 5 and 6.
  - **W3:** A = item 8 · B = docs, skills, `CHANGELOG` 0.4.0.
- **Exit:**
  - **Tests and checks:** unit and fixture tests for every item, and `node scripts/check.mjs --push` green.
  - **Sandbox renders:** show `flashing` and `av_sync` passing, the insert lints on the explainer example, and `export timeline` writing both files.
  - **On the user's Mac:**
    - the loop example still passes QA;
    - `analyze` with `write_style` on the user's reference produces a style pack that moves `compare` measurably toward the reference;
    - the timeline imports into Resolve or Final Cut with clips on the right frames;
    - `tighten` on a real talking-head clip leaves no partial words.

### Phase 7: Providers, policy and provenance (keys required)
- **Step 0: shot cards and prompt packs (local, no keys; before any adapter):**
  - **`ShotCard` schema** (`packages/schema/src/shot-card.ts`), attached to `visual_strategy: generative` scenes:
    - duration and aspect ratio;
    - purpose: emotion, plot or pressure (one job per shot);
    - subject references bound to asset ids;
    - one action and one camera move (or "locked");
    - environment, look, and audio (dialogue by speaker id, at most 3 SFX, ambience, music cue);
    - `on_screen_text: post` by default: logos, prices and UI are composited, never generated;
    - continuity, end state and `first_frame_from` for chaining;
    - exclusions.
  - **Provider facts are data:** `provider-specs/<family>.yaml` for seedance, veo, kling, wan, runway and hailuo. Each records:
    - duration, aspect and resolution limits;
    - reference-binding syntax;
    - audio channels;
    - negative-prompt support;
    - source URL and verified date, with `verified: false` until re-checked at the start of this phase.
    - **Never Sora:** its API was shut down on 2026-09-24.
  - **`packages/prompts`:**
    - one pure `compile(card, spec) → { text, params, warnings }` per family;
    - a director-checks lint: one job and one camera move per shot, brand text in post, cast within the provider's reference limit, limit violations as warnings with a fix.
  - **`prompt_pack` tool and skill:**
    - writes `prompts/<provider>/<scene>.{md,json}`;
    - no network, no spend;
    - the manifest records it as a prompt package, never a render.
  - **Consistency plan:**
    - an approved identity keyframe;
    - each shot's approved last frame is the next shot's first frame;
    - the highest-risk shot is generated and inspected before the batch.
  - **Step 0 exit:** one spec compiles into packs for 3 families with 0 network calls.
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
- **Research vocabulary** (from Phase 6.6 item 7):
  - `outlier_multiplier` = a video's views ÷ the channel's median views over the same window;
  - `outlier_rate` = the share of a channel's recent videos with `outlier_multiplier` ≥ 2;
  - title patterns and length bands are dated data in `research-specs/`.
  - All of it comes from the YouTube Data/Analytics API with the user's own OAuth (the `youtube_client_*` placeholders), never a third-party service.
- **Analytics:** normalized metrics that keep each platform's raw numbers; no universal virality score.
- **Experiment loop** feeding the next brief.
- **Hosted:** Docker render worker.
- SSO and collaboration stay deferred.

## Immediate next steps
Updated 2026-09-25. M9 and the Phase 3 exit are done. Phase 4 steps 1–2 are done: M1–M6, M8, platform contracts and lint. See `docs/HANDOFF.md`.
Phase 4 is done (exit passed 2026-09-25; CI dropped by the user on 2026-09-26: checks run locally). Phases 5 and 6 are done (exits passed 2026-09-25 in the sandbox; the Phase 6 demo-capture exit needs Chrome and is on the user checklist). Phase 8 (local subset) is done; see `docs/HANDOFF.md`. What remains needs the user: `docs/USER_CHECKLIST.md`, Phase 7 (paid provider keys) and Phase 9 (distribution, go/no-go). Progress is in the "Loop state" block of `docs/HANDOFF.md`.

Updated 2026-09-27: next is **Phase 6.5** (directed motion, local, no keys), wave W0 first. Phase 7 step 0 (shot cards and prompt packs) is local too and runs in wave W4. Then Phase 7 adapters (keys) and Phase 9.

## Agent execution model
Used from Phase 6.5 on. It keeps the user's limit of **at most 2 parallel agents**, with the lead session integrating their work.

- **Lanes:**
  - A = renderer and engine: `packages/renderer`, `packages/mcp`, skills and agents;
  - B = media, QA, lint and content: `packages/media`, `lint.ts`, `compare.ts`, `templates/`, `styles/`, `music/`.
  - Each agent runs in its own git worktree and owns a disjoint set of files in each wave.
- **Contract first:**
  - The lead lands every schema change in wave W0 (zod types, `pnpm schemas`, version constants) before the agents start. Agents never edit `packages/schema` at the same time.
  - If an agent needs a contract change, it stops and reports; the lead makes the change.
- **Chrome is serialized:** only one lane per wave may start Chrome (HyperFrames renders or `stills`). The other lane uses the ffmpeg renderer, fixtures and unit tests.
- **Per agent:**
  - tests first, in colocated `*.test.ts`;
  - `node scripts/check.mjs --quick` green in its worktree;
  - never rebuild or commit `dist/mcp.mjs`;
  - never touch the user's video projects;
  - end with a report: files changed, tests added, open issues.
- **Lead, per wave:**
  - merge both lanes;
  - rebuild the bundle once;
  - run `node scripts/check.mjs --push` and wait for it to pass (never `;`-chained into a commit);
  - update `docs/HANDOFF.md`;
  - commit and push. The pre-push hook re-runs the checks.
- **Phase 6.5 and Phase 7 step 0 waves:**
  - **W0 (lead):** schema contracts for items 1, 3, 4, 5, 6, 7 and 9, plus `ShotCard`; regenerated schemas; version bumps.
  - **W1:**
    - A = item 1 (composer adapter, `motion-kit.js`, CSP, static lint, cache key);
    - B = items 3 and 7 (beats v2, SFX peak alignment, `score.ts`).
  - **W2:**
    - A = items 2 and 8 (`stills`, determinism and loop-seam checks, blur spike). **A holds Chrome.**
    - B = items 4, 5 and 6 (density QA, `compare` reference, lint rules, loop QA).
  - **W3:**
    - A = item 9 skills and docs (`plan`/`create` flow, `code-motion.md`, `creative-director`);
    - B = item 9 content (6 templates, style avoid lists, `variants` durations).
  - **W4:**
    - A = Phase 7 step 0 (`packages/prompts`, `provider-specs/`, `prompt_pack`);
    - B = item 10 (series bible).
  - **W5 (lead, with the user):** the example project and golden frames, the self-intro rebuild and `compare`, `CHANGELOG` 0.3.0.

## Verification
- **Every step:** `npx tsc -b`, full `npx vitest run`, `node scripts/smoke-mcp.mjs`, `claude plugin validate --strict .claude-plugin/plugin.json`, and a rebuilt `dist/mcp.mjs`.
- **Visual:**
  - Extract frames from each target's `video.mp4` and inspect them.
  - The lint golden test has a deliberately bad fixture that must fail and a fixed one that must pass.
- **Outside the sandbox (user-run):**
  - `node scripts/render-project.mjs examples/text-to-motion-graphic --voice system --renderer hyperframes`
  - `claude --plugin-dir .` → `/video-studio:create …`

# 14 — Edge-case analysis

For each edge case, this table gives what the code does today at `b6fd8ea` (with citations) and the gap. "Verified" means it was reproduced in 13-negative-testing. The product is a knowledge-to-video **compiler**, so an edge case matters when it breaks (a) correct and deterministic output, (b) grounded citations, or (c) platform-safe layout.

## 1. Video properties

| Edge case | Current behaviour | Gap and consequence |
|---|---|---|
| **Very short source** (< 0.5 s; 1 frame) | Ingest works. The keyframe silently fails (`ingestion/src/media.ts:139`). Footage longer than the clip holds the last frame with a warning, or loops with `loop: true` (`renderer/src/footage.ts`); QA flags `frozen_frames` (verified N6) | Claude gets no picture of the clip. It should warn "no keyframe" or grab frame 0 as a fallback. |
| **Very short output** | Scene duration 0.5–30 s is an error outside the range, and 1–15 s is a warning (`schema/src/video-spec.ts:621`+). Transitions are clamped to 40% of the incoming scene | Fine. |
| **Long source** (1–3 h podcast or webinar) | 8 GB cap (`media.ts:18`). The **whole file is copied** into `source/assets/`. Shot detection decodes the full video (60-minute timeout, `media.ts:65`). At most 24 keyframes, spread evenly (`media.ts:24`). whisper has a 60-minute timeout (`asr.ts:26`). `shorts` scores sentence spans (`shorts.ts:83`) | Disk use doubles. The ingest step can take tens of minutes with **no progress reporting**, because `ingest` is synchronous and not a job. 24 keyframes over 3 h is one per 7.5 minutes, too sparse for Claude to choose b-roll. whisper `base.en` on CPU for 3 h is near or over the timeout. |
| **Long output** | `target_duration_sec ≤ 600` (`video-spec.ts:317`), scene ≤ 120 s (schema) with an error above 30 s | Explainers longer than 10 minutes are out of scope by design. Review sheets beyond 16 scenes degrade (only 1 frame per scene, and the image is downscaled; 11-performance). |
| **Vertical 9:16 source into 9:16** | `cover` fit plus focus, safe zones from `platform-specs` (verified N12) | Fine. |
| **Square / 4:5 / 16:9 targets** | `AspectRatio` enum `9:16, 16:9, 1:1, 4:5` (`schema/src/common.ts:51`). Zones come per target | 21:9, 2:3 and 3:4 are not supported. |
| **16:9 source → 9:16** | `cover` crops the centre or `focus {x,y}`; `blur_pad`/`contain` are alternatives (`footage.ts:131-150`) | `focus` is **static per scene**, with no subject tracking and no face detection, so a speaker who walks out of the centre third is lost. Claude must choose `focus` from a single keyframe. |
| **4K / 8K sources, huge dimensions** | No resolution cap. 4000×4000 ingested and rendered (verified N7). The master accepts up to 7680 (`video-spec.ts:278`) | Decode cost and RAM are unbounded on a low-RAM laptop. Keyframes are 320 px, which is fine. |
| **Rotated phone video** | Probe ignores the display matrix (`media/src/ffmpeg.ts:318`). Renders are correct because of autorotate plus `iw/ih` math (verified N23) | Recorded width and height are swapped, which affects `content_box` crops (absolute px, `footage.ts:127`), `redact` fractions and `analyze`'s aspect. |
| **HDR (iPhone HLG / Dolby Vision, PQ)** | No tonemap and no colour metadata recorded (verified N24; grep shows 0 tonemap code). Only HyperFrames gets `hdrMode: "force-sdr"` (`hyperframes-renderer.ts:405`) | Washed-out or clipped colours in the SDR reel, with no warning. This is common for iPhone footage. |
| **VFR screen recordings** | Scene clips are re-timed with `-r <fps>`. Shot detection runs on pts | Mostly fine. Word timings from whisper are in media time, so there is no drift. |
| **Interlaced (broadcast) sources** | No deinterlace (grep: 0 `yadif`/`field_order`) | Combing in the output. Rare for this audience. |
| **Letterboxed / pillarboxed** | A strict detector (luma ≤ 16, symmetric, stable across 5 samples, `media/src/letterbox.ts`) crops before the fit | A good trade-off. Soft or grey bars are left in, deliberately. |
| **Low quality / dark / noisy** | No quality assessment beyond QA of the *output* (black and frozen frames, `media/src/qa.ts`) | Claude only finds out from keyframes and review images. There is no blur or exposure metric for choosing the best shot. |
| **Silent video** (no audio stream) | `has_audio: false`. `voice.mode: native` warns "no transcript words … captions skipped". Spec warns "video is silent" when there is no bed (verified N12) | Fine. |
| **Audio-only input** | Ingested as `audio`. Using it as footage produces a *placeholder* card and a "succeeded" render (verified N13) | The true error is hidden. Validation should reject an audio asset in `footage` up front, since the IR says `kind: audio`. |
| **Image input** (`.png/.jpg`) | No extractor, so a binary file ingested as text (verified N9). A PNG named `.mp4` is ingested as a 0 s "video" (N8) | An image extractor is needed. Screenshots are a core input for product and UI explainers. |
| **Corrupted / truncated** | Clean ffprobe error (N2–N4) | Fine. |
| **Multiple audio tracks / languages** | Always `0:a:0` (`asr.ts:44`, `analyze.ts:121`) | A second language track or a commentary track is ignored with no notice. |

## 2. Speech and language

| Edge case | Current behaviour | Gap |
|---|---|---|
| **Non-English speech in footage** | whisper is forced to `en` for the only offered model (`asr.ts:32-35`), and the `transcribe` tool has no `language` argument (`server.ts:676-681`) | **English gibberish transcripts with no warning.** Shorts, tighten, captions and grounding all build on them. High impact for the user in India (Hindi, Hinglish). |
| **Non-English narration (TTS)** | Script-aware fonts (Noto JP, Devanagari, Arabic), RTL direction, and CJK caption rows (`renderer/src/script.ts`, `captions.ts:348-383`). `localize` translates specs | Strong. Voice selection for non-English depends on installed `say` voices. Alignment via whisper `base.en` will fail to match non-English narration, so timings fall back to estimates. |
| **Code-switching** (Hinglish) | Hook scoring and filler lists are English regexes (`shorts.ts:37-38`, `tighten.ts:17`) | Mis-scored hooks, and Hindi fillers ("matlab", "haan") are not cut. |
| **Multiple speakers** (interview, podcast) | Words only, with no speaker labels (`asr.ts` parses words only) | Captions cannot attribute speakers. Shorts can start on the interviewer's question fragment. `tighten`'s retake detection can treat speaker B repeating speaker A's words as a retake and drop the sentence, because detection is based on repeated openings (`tighten.ts`). |
| **Overlapping speech / crosstalk** | Nothing special | whisper merges it; captions become garbled. Acceptable. |
| **Music under speech** | `analyze` speech share counts music as speech (verified N26). Ducking only knows speech intervals it has transcripts or TTS for | Footage with its own music is not ducked against the narration unless it is transcribed. |

## 3. Content types

| Content type | What the code does | Fit and gap |
|---|---|---|
| **Slides (PPTX/PDF)** | PPTX: slide text, notes and images through JSZip with bomb guards (`ingestion/src/pptx.ts`). PDF: text per page, at most 300 pages (`pdf.ts`). Evidence refs per slide or page | A strong fit for the compiler. Charts and diagrams embedded as images carry **no text** (no OCR), so their numbers cannot be cited under `strict` grounding. |
| **Slide *videos*** (recorded talks) | Shots are detected at slide changes (a good proxy), with at most 24 keyframes | Slide text is invisible without OCR, and 24 keyframes can miss most slides in a long talk. |
| **Screen recordings / tutorials** | `demo` records the user's local app with input masking and step evidence (`mcp/src/demo.ts`). Imported recordings go through normal footage handling, and `shorts` suggests Reading keyframes (`skills/shorts/SKILL.md:63`) | Recorded UI text is not evidence (no OCR). Masking covers inputs only (10-security S5). Scroll-heavy recordings over-trigger the 0.3 scene threshold, and shots under 0.4 s are merged. `crop` review mode helps Claude check small text. |
| **Gaming footage** | Generic footage path | High-motion, high-cut content means many shots, capped at 24 keyframes. No HUD-aware safe zones; the `cover` crop may cut the HUD or minimap. Generally out of the product's purpose. |
| **Interviews** | transcribe → tighten → shorts, with `footage.redact` for faces or names (manual), and `contains_likeness` always true (`media.ts:194`) | No diarization and no face-aware crop (a 16:9 two-shot to 9:16 cuts one person). Redaction regions are static per scene; a moving face escapes the box. |
| **Podcasts (audio-only)** | Audio ingest, transcribe, and shorts over the transcript. Visuals must come from motion-graphic scenes (audiogram-like `kinetic_text` or `quote`) | Works conceptually. No waveform or audiogram scene kind. `shorts` requires `shots` from video; for audio it relies on sentences only (snap = 0). |
| **Talking-head tutorials** | `tighten` (pauses, fillers, retakes), captions, cutaways (`footage.cutaway` with a graphic) | A good fit. English-only filler and retake heuristics. |
| **Movies / TV / copyrighted media** | The generic footage path. `analyze` is clean-room (structure only, `analyze.ts:1-5`). Music beds are CC0 with licences recorded (`music.ts`). `audio.music.license` lint | There is no rights check on user footage. A user can compile a reel from a film, and only C2PA plus the manifest record it. By design, the tool trusts the user for footage rights. |
| **Security / CCTV footage** | The generic path. Low fps and fixed camera: few shots, long holds | Shot detection finds nothing, so there is 1 keyframe. Timestamps burned into the footage are not read. Faces and licence plates need manual `redact`, with no detection. Privacy risk if published. |
| **Docs / web pages / repos** (the core use) | Markdown, HTML (defuddle, Readability), repo (priority tiers, a 400 KB budget, secret exclusion) | The core use and a strong fit. A large repo produces a 1.1 MB ContentIR (measured on this repo), which is too large for Claude to Read whole (11-performance). Secrets in non-repo docs are flagged, not removed (S3). |
| **Localized or multilingual content** | `localize` produces translation sheets, script fonts and RTL | Strong for output. The input side is weak (whisper is English-only). |

## 4. Environment edge cases

| Edge case | Behaviour | Gap |
|---|---|---|
| ffmpeg missing or without libass/libx264 | doctor FAIL with a fix; render fails with a clear reason (verified N14) | The final hint "re-run with renderer ffmpeg" is wrong when ffmpeg itself is missing. |
| HyperFrames missing | auto → ffmpeg, reported | Fine. |
| Chrome dies mid-render | Scene retried with ffmpeg (`pipeline.ts:636-644`) | Fine. The mix of renderers across scenes gives visual inconsistency, which is reported in `renderer.used`. |
| whisper or model missing | Align skipped, estimated timings, reason reported; transcribe gives an actionable error (N32) | Fine. |
| Server killed mid-render | Stale lock recovered; tmp clip, temp dir and orphaned ffmpeg leaked (N38) | Needs signal handlers. |
| Two sessions, same project | Lock refuses the second (N35) | `export`, `variants` and `localize` are not locked. |
| Paths with `~`, spaces, quotes, colons | `~` becomes a literal directory (N39). Spaces, quotes and colons in paths are handled by argv plus two-level filter escaping (`ffmpeg.ts:366-383`) | Expand or reject `~`. |
| Low disk | Media copied per project, renders cached per project, test temp leaks (859 MB) | No free-space check before a render. |

## 5. Priority gaps for the product's purpose
1. **Language:** whisper forced to English (P2). This affects the user's own market.
2. **Stale cache on asset replacement** (P1): the compiler must never ship stale pixels.
3. **Image input** and **OCR-less screen and slide content**: both limit grounding for the most common explainer sources.
4. **HDR and rotation metadata**, because iPhone footage is the most common user footage.
5. **Surfacing real reasons** instead of "succeeded" with a placeholder (N13, N20).
6. **Face-aware crop and redaction** for interviews and security footage. These are optional for a compiler, but the privacy stakes are high when publishing.

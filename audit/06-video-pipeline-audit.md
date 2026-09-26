# 06 — Video pipeline audit

This is the real pipeline as implemented at `b6fd8ea`, checked against the code and against tiny renders in `$TMPDIR/vsaudit` (320 px lavfi media, silent voice, ffmpeg renderer).

The product is a **compiler**: source material plus Claude's creative decisions go in, and a deterministic, reproducible video package comes out. Its "understanding" needs are therefore narrow. It needs enough structure to cite evidence, cut footage on sensible boundaries and place captions and graphics. It does not need to *interpret* video the way an editor-AI would. The gaps below are rated against that purpose.

## 1. Input handling

### Supported inputs (`packages/ingestion/src/detect.ts:6-31`)
| Kind | Extensions and forms | Path |
|---|---|---|
| Text / Markdown | `.txt .text .md .markdown .mdown .mkd .mdx`, or inline text | `text.ts` (20 MB cap), `markdown.ts` |
| Web | `http(s)://` URLs, local `.html/.htm` | `url.ts` (defuddle, then Readability) |
| Office / PDF | `.pdf .docx .pptx` | `pdf.ts` (50 MB, 300 pages), `docx.ts`/`pptx.ts` (100 MB, zip-bomb guards in `office-common.ts`) |
| Repo | local directory with `.git`, `package.json` or README | `repo.ts` (400 KB text budget, 64 KB per file, secretlint) |
| Video | `.mp4 .mov .webm .mkv .m4v` | `ingestion/src/media.ts` (8 GB cap, copied into `source/assets/`) |
| Audio | `.mp3 .wav .m4a .aac .flac .ogg` | same |
| Clip folders | a directory with no repo markers that holds media | `mediaFolderFiles` (`detect.ts:49`), top level only |

### Not supported
- **YouTube, Vimeo, TikTok and other hosted video URLs.** They are treated as web pages. The URL fetcher rejects non-HTML content types (`url.ts:139-143`), so a YouTube URL yields at best the page's HTML text, never the video. (In the sandbox the fetch failed on the network, 13-negative N27.) This is correct for a compiler that must not download platform content. It should be stated in the ingest skill.
- **Cloud storage** (Google Drive, Dropbox, S3). There is no integration, and a share link is fetched as an HTML page. The workable path is for the user to download the file and ingest the local copy.
- **Remote git repos.** These are explicitly refused with a clear message (`repo.ts:53`).
- **Images as input (`.png .jpg .svg`).** There is **no image extractor**. An existing file with an unknown extension falls through to `text` (`detect.ts:104`, `return byExt ?? "text"`), so `still.png` was ingested as a text source whose section text is PNG bytes (verified, 13-negative N9). Screenshots, which a compiler needs for `screenshot` scenes, can only enter through the demo recorder, keyframes or PDF/PPTX image extraction.
- **Nested clip folders.** Only the top-level files of a folder are ingested.

### Validation and metadata (ffprobe)
- `media/src/ffmpeg.ts:318` picks the first video stream that is **not** `attached_pic`, so an mp3 with cover art is correctly classified as audio (verified, N22). A file whose container claims `.mp4` but holds only audio becomes `audio` (`ingestion/src/media.ts:114-115`).
- Recorded fields: `duration_sec, width, height, fps, has_video, has_audio, shots, loudness_lufs, content_box` (`media.ts:170-180`). **Not recorded:** codec and profile (except `audio_codec` in the prose description), pixel format and bit depth, colour primaries and transfer (HDR), **rotation / display matrix**, VFR, interlacing, audio channel layout and language tags.
  - **Rotation.** A phone clip carrying `display_matrix rotation=90` was recorded as 320×180 (landscape) while it plays as 180×320 (verified, N23). Footage fitting uses `iw/ih` expressions after ffmpeg's autorotate (`renderer/src/footage.ts:131-150`), so the render was correct. `content_box` (letterbox crop, absolute pixels, `footage.ts:127`), redact fractions described as "of the SOURCE frame", and `analyze`'s reported aspect all use the unrotated dimensions. A rotated letterboxed clip would be cropped in the wrong axis. This is inferred from code and was not rendered.
  - **HDR (PQ/HLG).** There is no tonemap anywhere (grep for `tonemap|zscale|smpte2084` finds 0 hits). A 10-bit PQ clip was ingested and rendered without warning (N24). Real HDR iPhone footage will look washed out in the 8-bit SDR output. Only the HyperFrames producer is told `hdrMode: "force-sdr"` (`hyperframes-renderer.ts:405`).
- **Corrupted, empty, truncated or garbage files** fail cleanly at ffprobe with its stderr tail (verified, N2–N4). **Zero-duration streams** give "has no video or audio stream ffprobe can read" (N5).
- **A PNG named `.mp4`** is ingested as a *video* with `duration_sec: 0` and `fps: 25` (image2 demuxer). The failure appears later as a nonsensical spec error: "footage starts at 0s, after the end of asset-1 (0s) (fix: use an in_sec below 0)" (N8).
- **Odd codecs** (VP8 WebM, MPEG-4 Part 2 plus MP3 in MKV, MOV) all ingest and render (N10–N12), because anything ffmpeg decodes works. There is no allow-list and no codec warning.
- **Size and duration caps.** 8 GB per media file (`media.ts:18`) is the only cap. There are no duration or resolution caps: a 4000×4000 clip ingests and renders (N7), and a 3-hour recording would be fully decoded for shot detection (60-minute timeout, `media.ts:65`).

## 2. The understanding side

| Capability | Implementation | Assessment for a compiler |
|---|---|---|
| **Shot detection** | `select='gt(scene,0.3)',showinfo` on a 160 px downscale, shots under 0.4 s merged (`ingestion/src/media.ts:62-70`, `shotsFromCuts@44`) | Adequate for cutting on boundaries. The fixed 0.3 threshold misses soft cuts (dissolves) and over-cuts flashes and screen-recording scrolls. It decodes the whole file at full resolution before the scale. |
| **Keyframes** | One JPEG per shot at the shot's midpoint, 320 px wide, q 6, at most 24 per video, evenly spread (`media.ts:24-26,124-147`) | Scene-aware (one per shot), not fixed-interval, and no dedupe is needed because there is one per shot. Failures are **silent** (`media.ts:139`): no keyframe and no warning for a 1-frame clip or a 1-fps clip whose midpoint is past the last frame (N6, N7). With 24 frames per video, a one-hour talk with 200 shots gets 24 frames spread across it. |
| **Letterbox detection** | Strict: luma ≤ 16, agreement across 5 samples, symmetric bars (`media/src/letterbox.ts`) | Well designed (it avoids cropping night skies). The crop is applied before the fit by the footage renderer. Coordinates are unrotated (see above). |
| **Transcription** | whisper.cpp `whisper-cli -ml 1 -sow -oj`, one word per segment (`media/src/asr.ts:40-80`), or SRT/VTT import | Word timings are good enough for captions and shorts. **Language is forced to English** with the only offered model (`ggml-base.en`): `whisperLanguage` returns `"en"` for `*.en` models (`asr.ts:32-35`), and the `transcribe` tool has **no `language` parameter** (`server.ts:676-681`). A Hindi or Spanish interview is transcribed as English gibberish **with no warning**. For a user in India (per memory) this matters. |
| **Word alignment for TTS** | `mcp/src/voice-align.ts`: whisper listens to each synthesized scene, its words are matched to the known script, unmatched words are interpolated, and a track is replaced only above a match ratio | A sound approach: alignment, not transcription. It runs only when whisper and the model are present. Otherwise timings are estimated (`voice/src/estimate.ts`) and captions drift from speech. |
| **Format grammar (`analyze`)** | Shots, pacing, hook shot length, a caption band from per-row edge density of sampled frames, and speech share from voice-band (200–3500 Hz) energy above −35 dBFS (`mcp/src/analyze.ts:119-121`) | Clean-room (nothing copied). The speech share is a band-energy proxy: a **440 Hz sine tone scored "Speech: yes (100% voice-band sound)"** (verified, N26), so music-heavy references will be misread as talk. |
| **Shorts scoring** | Sentence-aligned spans of min–max seconds, snapped to cuts within 1 s, score = 0.35·hook + 0.25·density + 0.2·completeness + 0.2·dead-air + 0.05·snap (`shorts.ts:83-131`) | Transparent and deterministic. The hook heuristic is **English-only regex** (`CONJUNCTION_START`, `STRONG_WORDS`, number words, `shorts.ts:37-58`). Other languages get "plain opening" except for `?` and digits. It uses no audio energy, laughter or visual interest. Claude refines the picks afterwards, which suits a compiler. |
| **Tighten** | Transcript-driven: long pauses, a filler list (`um, uh, …`, `tighten.ts:17`), retakes (repeated openings, "let me start again") | Conservative, as designed. English fillers only. |
| **Beat detection** | Energy-envelope onsets, tempo from inter-onset intervals, phase-aligned grid (`media/src/beats.ts`) | Enough for snapping cuts to bundled beds. |

### What is absent, and whether it matters for a compiler

| Absent | Matters? | Why |
|---|---|---|
| **Vision analysis** (what is in a frame) | **Partly.** Claude fills this gap by Reading keyframes and review sheets. | The cost is tokens (§4), and nothing flags "this shot is blurry, dark or has a face at the edge" for `cover` crops. `focus {x,y}` must be chosen by Claude from an image. |
| **Face detection** | **Yes, moderately.** | `cover` crops of 16:9 interviews to 9:16 can cut heads off. Every video is marked `contains_likeness: true` (`media.ts:194`) because nothing can check. Redaction boxes are manual. |
| **OCR** | **Yes, for screen recordings and slides.** | Demo recordings and slide videos carry their content as on-screen text, which never becomes evidence, so `strict` grounding cannot cite what is on screen. The demo recorder cites *steps performed*, not text. |
| **Speaker diarization** | **Moderate** (interviews, podcasts). | Captions cannot style speakers, and shorts can start mid-answer by the other speaker. |
| **Language detection** | **Yes** (see transcription). | It is a silent quality failure. |
| **Music/speech separation** | Low to moderate. | Only affects `analyze` and dead-air scoring on music-backed talk. |
| **Emotion / sentiment** | Low. | Hook choice is Claude's creative job. It does not belong in the engine. |
| **Scene semantics / object tracking** | Low. | Out of scope for a compiler. `focus` is static per scene, so there is no subject tracking during a cut. |

## 3. Frame extraction strategy and its token cost

- **Ingest keyframes:** scene-aware, one per shot, 320 px wide JPEG (about 7 KB each), at most 24 per video. For a 320×180 frame, Claude's vision cost is about (w·h)/750 ≈ 77 tokens per image, so 24 keyframes ≈ 1.8k tokens. The shorts skill tells Claude to Read them for screen shares (`skills/shorts/SKILL.md:63`).
- **`review` sheets:** 3 frames per scene (in/mid/out; `review.ts:221-230`), 240 px tiles, 6 columns, at most 48 tiles (`review.ts:89-91`). Measured: 9 tiles → a **1468×864** JPEG (132 KB, about 1.7k tokens). A 16-scene, 60 s reel → 48 tiles of 9:16 at 240×427 in 8 rows → about **1468×3460 px**. Claude's image input is downscaled to about 1568 px on the long edge, so each tile shrinks to about 108 px wide and the 17 px labels and caption text become unreadable. The sheet should cap rows or split into pages.
- **`review` strips:** every frame of a span, 180 px tiles, 8 columns. At 15 fps preview, a 1 s scene gives 15 tiles (**1476×652**, measured). A 3 s scene at 30 fps final gives 90 tiles, clamped to 48 with a note. There is no frame dedupe in strips: static frames (most of a typography scene) are repeated tiles that cost tokens without adding information.
- **Storyboard:** text only (`storyboard.md`), with no images.
- **Tile labels:** drawtext with inline `text=` and **no `expansion=none`** (`review.ts:166-168`). A cue word containing `%` (for example "100%") makes ffmpeg log `Stray %` and **drop the yellow cue label silently** (verified, N15). A cue like `%{eif:…}` would be expression-evaluated. The actual renders are safe: they use `textfile=` with `expansion=none` (`ffmpeg-renderer.ts:1836`, `cover.ts:205`).

## 4. Audio

- **Voice synthesis** (`voice/src/synthesize.ts:52-75`): `auto` tries ElevenLabs if `ELEVENLABS_API_KEY` is set, then `say`/espeak-ng, then silent. If the chosen backend fails at synthesis, `auto` falls back to **silent** and reports it in `voice.reason` (`pipeline.ts:490-495`). A render therefore "succeeds" with no narration, and that is visible only in the job summary line.
- **Text to TTS:** voiceover text goes through a temp file (`-f textFile`, `voice/src/system.ts:229-237`), never argv, so it is injection-safe. The voice runner has **no timeout** (`voice/src/exec.ts:20`).
- **Alignment:** see §2. When whisper is missing, captions use estimated word timings.
- **Ducking:** deterministic ducking over known speech intervals (the voice slots plus native transcripts), not a sidechain compressor (`pipeline.ts:737-742`, `media/src/audio.ts`). This is exact for TTS, but it ignores speech in footage without a transcript.
- **Loudness:** two-pass `loudnorm` to −14 LUFS and −1.5 dBTP (`ASSEMBLY_VERSION 5`), skipped for silent renders. QA reports silence and loudness as "not measured" in silent mode (`QA_VERSION 3`).
- **Music:** four bundled CC0 beds (synthesized in-repo), or project-relative files confined by `resolveInsideProject` (`music.ts:84`, verified N18–N19).
- **Scene audio and sfx:** per-scene native, mix or mute modes, crossfades and sfx one-shots, all confined to the project (verified N21).

## 5. Rendering

| Stage | Implementation | Notes |
|---|---|---|
| **Renderer selection** | `renderer/src/select.ts`: `auto` = HyperFrames if its probe passes, else ffmpeg. A failed HyperFrames scene is retried with ffmpeg (`pipeline.ts:636-644`). | Fallbacks are reported in `renderer.reasons`. |
| **ffmpeg-drawtext renderer** | 2,290 lines, 15 kinds, text through `textfile=` plus `expansion=none`, libass for shaped scripts, `-threads 1`, `veryfast` crf 18 (`ultrafast` for preview) | Deterministic and dependency-light. Lower visual fidelity: for example, the "diagram: basic grid layout with orthogonal edges" warning appears on every diagram. |
| **HyperFrames renderer** | HTML/CSS/SVG composition (`hyperframes-compose.ts`), rendered by the `@hyperframes/producer` 0.8.78 Chrome pipeline, never bundled | Could not be exercised in the sandbox (Chrome is blocked). `projectImage` confinement is lexical only (`hyperframes-compose.ts:1852-1857`); see 10-security. |
| **Footage renderer** | `renderer/src/footage.ts`: in/out, speed, loop or hold, fit (`cover`, `contain`, `blur_pad`), focus, redact (blur or box) before the fit, letterbox crop | Robust across the odd inputs tested (N6–N12). A too-short clip is held with a warning, and a clip from an audio asset becomes a placeholder card (N13). |
| **Scene cache** | Sidecar per scene, `sceneCacheKey` (`select.ts:155-180`) | **Misses image bytes**, so screenshots and logos go stale (verified N16/N17). `voiceover` text is part of the scene JSON, so rewording narration re-renders the picture even when no cue moved (performance). |
| **Assembly** | `media/src/compose.ts:274-313`: concat with transitions (crossfade, fade_black, slide, zoom, whip, clamped to 40% of the incoming scene, timeline-preserving) → optional logo overlay → audio mix, loudnorm and mux → **master** → ASS burn-in → **reel** | **Generation count:** scene clip (crf 18) → concat (crf 20, `medium`) → logo overlay (crf 20, when a logo is placed) → burn-in (crf 20). The reel is therefore the 3rd or 4th lossy H.264 generation; per-target transcodes can add a 5th (`targets.ts:75`). Fine text such as captions or code at crf 20 survives, but gradients band. Drawing the logo and captions in the concat graph would save up to two generations. |
| **Captions** | `media/src/captions.ts`: phrases of 3–7 words, at most 2 rows, placed in the platform caption zone, plate, keyword emphasis, optional karaoke, CJK row handling, sound-event cues, `burn_captions: false` per scene | Strong. Captions are burned into the reel, and the clean master plus SRT/VTT are also shipped. |
| **Covers** | `mcp/src/cover.ts` (`COVER_VERSION 3`): frame at `focal_time_sec`, blurred and dimmed, headline on an opaque plate inside the hook zone across all crops | Headline text goes through `textfile` plus `expansion=none` (`cover.ts:205-206`), which is safe. |
| **Targets** | `mcp/src/targets.ts`: per-platform `dist/<target>/` packages with a transcode only when limits require it, `post.json`, `qa.json` | Transcodes are cached by input sha. |
| **QA** | `media/src/qa.ts`: black and frozen frames, silence, loudness | `frozen_frames` correctly warned on held footage (N6, N7, N13). |

## 6. Pipeline findings, ranked

| # | Severity | Finding | Evidence |
|---|---|---|---|
| P1 | High | Scene cache key omits image bytes, so stale screenshots and logos are shipped | `select.ts:155-180`; N16, N17 |
| P2 | High (for non-English users) | whisper is forced to English, with no `language` parameter and no warning | `asr.ts:32-35`, `server.ts:676-681` |
| P3 | Medium | No image ingest; a PNG becomes a binary "text" source | `detect.ts:104`; N9 |
| P4 | Medium | Rotation and HDR are not probed; no tonemap | `ffmpeg.ts:318`; N23, N24 |
| P5 | Medium | 3–5 lossy H.264 generations for the reel | `compose.ts:274-313`, `targets.ts:75` |
| P6 | Medium | Review sheets for long reels exceed vision resolution, so labels become illegible | `review.ts:89-91,221` |
| P7 | Medium | Failures surface as "succeeded" with a placeholder or silence: footage from an audio asset, a tampered asset path, synthesis failure falling back to silent | N13, N20; `pipeline.ts:490-495` |
| P8 | Low | Review tile drops cue labels containing `%` | `review.ts:166-168`; N15 |
| P9 | Low | Keyframe extraction fails silently on very short or low-fps clips | `media.ts:139`; N6, N7 |
| P10 | Low | `analyze` counts music and tones as speech | `analyze.ts:119-121`; N26 |

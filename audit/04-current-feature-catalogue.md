# 04 — Current feature catalogue

I found features by reading the code and then checked the README and skill claims against it.
Status values:
- **IMPLEMENTED**: in code, reachable from a tool.
- **PARTIAL**: works with a material gap.
- **BROKEN**: a verified defect on a reachable path.
- **EXPERIMENTAL**: in code but unwired or optional-unverified.
- **DOCUMENTED_ONLY**: claimed in docs or schema, with no code.
- **MISSING**: neither docs nor code provide it.

I did not run renders, so "IMPLEMENTED" means implemented and unit-tested in the repo, not executed by me.

## Ingestion

| Feature | Description | Implementation | Status |
|---|---|---|---|
| Input kind detection | URL, GitHub URL, repo dir, clip folder, extension map, inline text or markdown | `packages/ingestion/src/detect.ts:5-30,34,74+` | IMPLEMENTED |
| Text / Markdown | Sections and evidence refs by line range | `ingestion/src/text.ts`, `markdown.ts` | IMPLEMENTED |
| PDF | `unpdf` text; warnings `pdf_truncated`, `scanned_pdf` | `ingestion/src/pdf.ts:131,144` | PARTIAL (no OCR for scanned PDFs) |
| DOCX / PPTX | `mammoth`; `jszip` slide XML | `ingestion/src/docx.ts:119`, `pptx.ts:124,194` | IMPLEMENTED |
| Web URL | Fetch with 15 s timeout, 5 MB cap, 5 manual redirects; defuddle/Readability; `thin_content` for client-rendered pages | `ingestion/src/url.ts:12-17,109-155,287,395` | PARTIAL (no JS rendering; no private-IP/SSRF filter) |
| Saved HTML page | Same extractor, from disk | `ingestion/src/url.ts:341`; `detect.ts` `.html` → url | IMPLEMENTED |
| Local repo | repomix `searchFiles` with in-memory config; 64 KB/file, 400 KB total; secretlint recommend preset in memory; files with secrets excluded | `ingestion/src/repo.ts:19-35,103-125,182-190,347,381` | IMPLEMENTED |
| GitHub URL | Detected, but refused with "clone locally first" | `detect.ts:34`; `repo.ts:53` | IMPLEMENTED (by design, no clone) |
| Media ingest | Copy, probe, shot detection, keyframes per shot, loudness, letterbox `content_box` | `ingestion/src/media.ts:13-23,60-68,121,151-155` | IMPLEMENTED |
| Clip folder | Top-level media of a non-repo folder, sorted by name | `detect.ts` `mediaFolderFiles` | IMPLEMENTED |
| Classification | Secrets (secretlint + patterns), PII (email, phone), likeness (always set for video; images only if a caller says faces) | `ingestion/src/classify.ts:106-146`; `media.ts:199-202` | PARTIAL (likeness is a blanket flag, no face detection) |
| Ingest cache | Content-keyed extraction cache under the data dir | `ingestion/src/ingest.ts:149` | IMPLEMENTED |
| Incremental ingest | Adding a source to an existing IR | `ingest.ts:303-314` overwrites the IR | MISSING (a re-ingest drops earlier sources, transcripts and demo evidence) |

## Planning

| Feature | Description | Implementation | Status |
|---|---|---|---|
| 18 story templates | Beats, pacing, caption preset, hook mechanisms | `templates/*/template.yaml`; `mcp/src/templates.ts:34-74` | IMPLEMENTED (`.claude/CLAUDE.md` says 13: stale) |
| Brief validation | Schema, hook in candidates, template exists, platform-norm warnings | `mcp/src/plan.ts:76-135` | IMPLEMENTED |
| Spec scaffold | Scenes from template beats; word budgets; not written to disk | `mcp/src/plan.ts:192-367` | IMPLEMENTED |
| Spec validation | Schema, durations, ids, per-kind props, forbidden provider names, `claim_refs` resolution with nearest-ref fixes, strict/loose grounding | `mcp/src/spec-validate.ts:42-143`; `schema/src/video-spec.ts:505-535` | IMPLEMENTED |
| Storyboard | Markdown table + pacing flags (>3.3 w/s, <1.5 w/s over 2 s) | `mcp/src/plan.ts:348,372-479` | IMPLEMENTED |
| Research / critique agents | `source-researcher`, `creative-director` | `agents/*.md` | IMPLEMENTED (prompt only) |
| Hook scoring | 3 or more candidates scored on 5 criteria | `skills/plan/SKILL.md:101-110` | IMPLEMENTED (prompt only; no engine check beyond "3 or more / distinct mechanisms" warnings, `plan.ts:76+`) |

## Rendering

| Feature | Description | Implementation | Status |
|---|---|---|---|
| ffmpeg scene renderer | All 15 deterministic kinds with drawtext/ASS, motion, camera moves, count-up, cues | `renderer/src/ffmpeg-renderer.ts:1376,1529-1617,2168`; `count-up.ts:33-69` | IMPLEMENTED |
| HyperFrames renderer | HTML compositions rendered through `@hyperframes/producer` + Chrome; runtime-resolved; escaped HTML | `renderer/src/hyperframes-renderer.ts:312`; `hyperframes-compose.ts:117,1960-1981`; `mcp/src/hyperframes.ts:73-133` | EXPERIMENTAL (optional manual install; not verifiable in this audit) |
| Renderer selection + retry | `auto`: HyperFrames if the probe passes, else ffmpeg; failed scenes retried on ffmpeg | `renderer/src/select.ts:42-60`; `mcp/src/pipeline.ts:639-645` | IMPLEMENTED |
| Footage renderer | cover/contain/blur_pad, trim, speed, loop, focus, letterbox crop, redact regions, overlays | `renderer/src/footage.ts:101,126,151,232,278` | IMPLEMENTED |
| Cutaways | Graphic replaces the picture while the footage audio continues | `renderer/src/select.ts:184-189`; lint `mcp/src/lint.ts:1057` | IMPLEMENTED |
| Placeholder cards | Non-deterministic scenes become titled `end_card` | `renderer/src/select.ts:191-201` | IMPLEMENTED |
| Transitions | cut, crossfade, fade_black, slide, zoom, whip | `schema/src/video-spec.ts:96`; `media/src/compose.ts:65,115` | IMPLEMENTED |
| Style packs / brand tokens | 4 styles; brand colours, fonts, weights, motion, logo corner, forbidden treatments | `renderer/src/styles.ts:21-70`; `tokens.ts`; `pipeline.ts:436-448,1925+` | IMPLEMENTED |
| Script fonts / RTL / CJK | Noto JP/Devanagari/Arabic; RTL alignment; CJK wrapping | `renderer/src/text-layout.ts:46-132,329`; `media/src/captions.ts:113` | IMPLEMENTED |
| Scene cache | Sidecar cache key | `renderer/src/select.ts:155-181` | PARTIAL (key ignores screenshot/logo file contents: stale clips when a file is replaced in place) |
| Beat sync | Onset envelope → tempo → grid → snap cuts | `media/src/beats.ts:44-244`; `pipeline.ts:529-551,1343` | IMPLEMENTED |

## Voice and audio

| Feature | Description | Implementation | Status |
|---|---|---|---|
| System TTS | `say` (auto-picks Premium/Enhanced voices) / `espeak-ng` | `voice/src/system.ts:28-154` | IMPLEMENTED |
| ElevenLabs TTS | `with-timestamps`, character→word timings, pronunciation dictionaries | `voice/src/elevenlabs.ts:11,137,152-215` | IMPLEMENTED (paid; key check does not reject the literal `${user_config…}` placeholder, `elevenlabs.ts:152-155` vs `media/src/ffmpeg.ts:37-42`) |
| Silent / none / native voice | Silent backend; `voice.mode` none/native | `voice/src/silent.ts`; `pipeline.ts:470-479,564-576` | IMPLEMENTED |
| Voice fallback on failure | `auto` → silent (not system) after a synthesis error | `pipeline.ts:490-497` | PARTIAL |
| Whisper word alignment | Estimated TTS timings aligned to audio | `mcp/src/voice-align.ts:56,126,157`; `pipeline.ts:498-510` | IMPLEMENTED (needs whisper + model) |
| Pronunciation overrides | `brand.language.terminology` applied to speech text only | `voice/src/text.ts:43`; `schema/src/brand.ts:89` | IMPLEMENTED |
| Music beds + ducking | 4 bundled CC0 beds; sidechain-style duck expression; fades, loop | `mcp/src/music.ts:44-84`; `media/src/audio.ts:251-341` | IMPLEMENTED |
| Scene audio / sfx | native/mix/music/mute, crossfades, one-shots | `media/src/audio.ts:128`; `pipeline.ts:1259+` | IMPLEMENTED |
| Loudness | 2-pass loudnorm to -14 LUFS / -1.5 dBTP | `media/src/audio.ts:378-429`; `pipeline.ts:805` | IMPLEMENTED |

## Captions, QA and packaging

| Feature | Description | Implementation | Status |
|---|---|---|---|
| Caption engine | Phrases, emphasis, plates, zone placement, SRT/VTT/ASS/TXT/JSON, karaoke | `media/src/captions.ts:45-955` | IMPLEMENTED |
| Sound-event captions | `[music]`, sfx captions, ambient | `pipeline.ts:1053-1140` | IMPLEMENTED |
| Technical QA | ffprobe, blackdetect, freezedetect, silencedetect, EBU R128 | `media/src/qa.ts:107-254` | IMPLEMENTED |
| Platform lint | Envelopes, text overflow, UI masks, contrast, caption speed/sync/gap, cue checks, story arc, cutaways, brand forbidden/banned, logo overlap, text repeats captions | `mcp/src/lint.ts:194-1252` | IMPLEMENTED |
| Per-platform packages | `dist/<target>/{video.mp4, cover.jpg, captions, post.json, qa.json}`; transcode only when the contract requires it; removes packages of dropped targets | `mcp/src/targets.ts:44,176-210` | IMPLEMENTED |
| Cover compiler | Headline cover + square preview, crops per contract | `mcp/src/cover.ts:68-265` | IMPLEMENTED |
| Social copy | Deterministic draft + `publish.<target>` override | `pipeline.ts:1506-1549` | IMPLEMENTED |
| video.lock | Tools, fonts, renderers, asset hashes | `mcp/src/lock.ts:44-141`; `pipeline.ts:1853` | IMPLEMENTED |
| C2PA signing | c2patool; test-cert detection | `mcp/src/c2pa.ts:60-240` | IMPLEMENTED (optional external tool) |
| Golden-frame test | SSIM ≥ 0.97 | `mcp/src/golden.ts:20,207-270` | IMPLEMENTED |
| Diff | spec/lock/frames | `mcp/src/diff.ts:88-314` | IMPLEMENTED |
| Compare page | Self-contained sync player | `mcp/src/compare.ts:101-157` | IMPLEMENTED |
| Review sheets | sheet/strip/crop with lint borders and cue labels | `mcp/src/review.ts:105-334` | IMPLEMENTED |
| Claim verification | Coverage report | `mcp/src/verify.ts:109-326` | IMPLEMENTED |

## Derived projects and footage tools

| Feature | Description | Implementation | Status |
|---|---|---|---|
| Transcribe | whisper.cpp or SRT/VTT import; consent-gated model download, sha256-pinned | `mcp/src/transcribe.ts:20-300`; `media/src/asr.ts:40-207` | PARTIAL (default model `base.en` is English-only; other languages need `VS_WHISPER_MODEL`) |
| Tighten | Pauses, fillers, retakes; dry run, then a new asset | `mcp/src/tighten.ts:59-233` | IMPLEMENTED |
| Shorts | Candidate scoring + ready talking-head projects | `mcp/src/shorts.ts:41-352` | IMPLEMENTED (make_projects overwrites existing short specs, `shorts.ts:344-347`) |
| Analyze | Shot lengths, cuts/10 s, pacing, speech share, loudness, caption band | `mcp/src/analyze.ts:23-198` | IMPLEMENTED |
| Demo capture | Scripted Chrome walk, input blur, cursor, per-step evidence | `mcp/src/demo.ts:107-369` | IMPLEMENTED (needs the optional HyperFrames install for puppeteer-core) |
| Localize | Translation sheet → apply, re-time, script fonts | `mcp/src/localize.ts:92-601` | IMPLEMENTED (translation is done by Claude) |
| Variants | Hook × cover experiment + render queue | `mcp/src/variants.ts:52-165` | IMPLEMENTED |
| Adapt | Aspect/duration/platform/targets retarget into a new folder | `mcp/src/adapt.ts:40-135` | IMPLEMENTED (copies `project.json`, so both projects share the same `id`) |

## Infrastructure

| Feature | Description | Implementation | Status |
|---|---|---|---|
| Background render jobs | One at a time; ledger mirror | `mcp/src/render-jobs.ts:45-185` | PARTIAL (no cancel; see next row) |
| Job status after restart | Ledger fallback | `render-jobs.ts:158-171` + `server.ts:73-85` | **BROKEN** for succeeded jobs: `formatJob` reads `r.qa.findings.length`, but the ledger stores `qa` as a string (`render-jobs.ts:135`) |
| Job cancellation | Abort a running render | `render-jobs.ts:179-184` is never called; no tool | MISSING |
| Render lock | Per-project, cross-process | `mcp/src/render-lock.ts:66-91` | IMPLEMENTED (export/qa_run not covered) |
| Doctor | Node, sqlite, ffmpeg + buildconf (libass/libx264/text shaping), Chrome, HyperFrames, whisper, system voice, key presence, data dir | `mcp/src/doctor.ts:117-402` | IMPLEMENTED |
| Generic provider JobRunner | Ledger-persisted submit/poll with concurrency | `core/src/jobs.ts:107` | EXPERIMENTAL (unused outside tests) |

## Phase 7 providers and governance (checked against README and `.claude/CLAUDE.md`)

| Feature | Claim | Implementation | Status |
|---|---|---|---|
| Runway adapter (Model Router dryRun) | `.claude/CLAUDE.md` "Providers in scope"; `plugin.json:10-16` userConfig | Only env mapping `.mcp.json:7` and doctor presence `doctor.ts:60-66` | DOCUMENTED_ONLY |
| HeyGen v3 adapter | same | `.mcp.json:9`, `plugin.json:24-30` | DOCUMENTED_ONLY |
| fal.ai (Kling/Veo/Hailuo) | same | `.mcp.json:10`, `plugin.json:31-37` | DOCUMENTED_ONLY |
| Direct Kling key | `plugin.json:38-44` | `.mcp.json:11` | DOCUMENTED_ONLY |
| `VideoProviderAdapter` + mock conformance suite | `.claude/CLAUDE.md` | no such symbol in `packages/` | DOCUMENTED_ONLY |
| Capability routing / cost estimate | Pipeline "route" stage | Only local renderer selection (`select.ts:42`); `RoutingPreference` enum unused for providers (`video-spec.ts:78`) | DOCUMENTED_ONLY |
| Policy enforcement (allow/deny, residency, retention, likeness consent, spend limits) | `schema/src/policy.ts:78` says "Enforced in engine code" | `Policy` is never imported outside `schema/src` | DOCUMENTED_ONLY |
| Spend limits / approval above USD | same | none | DOCUMENTED_ONLY |
| README "every step is approved first" (demo) | `README.md:164` | Engine only checks a model-supplied `confirm: true` (`demo.ts:255`) | PARTIAL |
| README "every claim on screen cites a line in your sources" | `README.md:25` | True only under `grounding: "strict"`; `create` uses `loose` for idea-only videos (`skills/create/SKILL.md:38-45`) | PARTIAL |
| README "none of the features need a paid service" | `README.md:29` | True; ElevenLabs is optional | IMPLEMENTED |
| create skill "Talking-head videos need footage and are not available yet" | `skills/create/SKILL.md:37` | Talking head is implemented (`shorts.ts`, `templates/talking-head`) | Doc contradiction (stale) |
| Kokoro local TTS | `.claude/CLAUDE.md` (opt-in model) | none | MISSING |
| Remotion renderer (opt-in) | `.claude/CLAUDE.md` | none | MISSING |
| Posting / scheduling / analytics | README says not planned (`README.md:161`) | none | MISSING (by design) |
| CI | removed by the user | `.githooks/pre-push` only | MISSING (by design) |

## Video understanding: capabilities the plugin does not have

| Capability | Status | Nearest substitute in code |
|---|---|---|
| Object detection | MISSING | none |
| Person / face detection | MISSING | Blanket `contains_likeness: true` for every video (`ingestion/src/media.ts:199-202`); `imagesWithFaces` is only an input hint (`classify.ts:126`) |
| Emotion / sentiment on faces or voice | MISSING | `shorts.hookScore` is a text heuristic on the first sentence (`mcp/src/shorts.ts:41`) |
| OCR of on-screen text in footage | MISSING | `analyze` finds only the *band* where burned-in text sits, via row edge density (`mcp/src/analyze.ts:51,86,102`); scanned PDFs get a `scanned_pdf` warning, no OCR (`pdf.ts:144`) |
| Speaker diarization | MISSING | whisper words have no speaker labels (`media/src/asr.ts:101`) |
| Vision analysis of frames by the engine | MISSING | Shot detection via ffmpeg `scene` score (`ingestion/src/media.ts:60-68`); letterbox `cropdetect` (`media/src/letterbox.ts:27-64`); freeze/black detection in QA (`media/src/qa.ts:107`); keyframe JPEGs + `review` sheets that **Claude** looks at with Read (`mcp/src/review.ts:174`; `skills/shorts/SKILL.md:63-68`) |
| Semantic scene / topic segmentation of footage | MISSING | Transcript sentence grouping (`media/src/asr.ts:207`) + shot snapping in shorts (`shorts.ts:83`) |
| Automatic redaction of sensitive regions | MISSING | Manual `footage.redact` rectangles chosen by Claude after viewing keyframes (`renderer/src/footage.ts:101`) |
| Speech share / pacing of a reference | IMPLEMENTED | `analyze` (voice-band energy share, shot stats) `analyze.ts:120-190` |

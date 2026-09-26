# 11 — Performance audit

**Machine:** the user's low-RAM macOS laptop, load average 10–20 during measurement. All numbers come from `$TMPDIR/vsaudit` runs at `b6fd8ea` through `dist/mcp.mjs` over stdio (a custom client, `mcp.mjs`) or `scripts/render-project.mjs`. The timings are noisy because of the load, so read them as orders of magnitude.

## 1. Token efficiency (Claude context)

### 1.1 Fixed per-session cost
| Item | Size | ≈ tokens |
|---|---:|---:|
| `tools/list` (28 tools, schemas and descriptions) | **36,058 bytes** (measured) | ~9k (if the client does not defer tool schemas) |
| Longest tool descriptions | `spec_validate` ~1 KB (`server.ts:183`), `ingest` ~1 KB (`server.ts:150`), `review` ~0.9 KB (`server.ts:526`) | |

### 1.2 Skills and references (words, measured with `wc -w`)
| Skill | Lines / words |
|---|---|
| plan | 240 / **1,940** |
| lint | 91 / 857 |
| create | 111 / 859 |
| render | 111 / 820 |
| ingest | 88 / 755 |
| shorts | 87 / 698 |
| localize | 61 / 571 |
| The other 14 skills | 203–488 words each |
| **Total, 21 skills** | **about 11,200 words** |
| `plan/references/*` (5 files) | 5,807 words (visual-strategy 1,497; brief-and-spec-fields 1,354; storytelling 1,137; hooks 912; script-writing 907) |
| agents | creative-director 538, source-researcher 311 |

A full `/video-studio:create` run loads create, plan, the references it needs, render, lint and review. That is roughly **5–6k words of skill text plus up to 5.8k words of references ≈ 12–16k tokens**. Only the frontmatter descriptions are always loaded.

### 1.3 Typical MCP tool responses (measured; text content bytes)
| Tool | Bytes | Notes |
|---|---:|---|
| `ingest` (1 video) | 1,500–1,850 | summary plus pretty JSON |
| `ingest` (this repo) | 3,391 | but it writes a **1,110,688-byte `content-ir.json`** (249 sections, 717 spans, 200 claims) |
| `template_list` | 10,865 | all 18 templates, every call |
| `template_get` | 2,880 | |
| `schema_get video-spec` | 27,471 | |
| `schema_get content-ir` | 14,432 | |
| `spec_scaffold` | 7,834 | |
| `spec_validate` (valid) | 673 | invalid, missing fields: 4,439 |
| `render_submit` → final `job_status` | **3,777–4,344** | a formatted summary **plus** the full result JSON with every dist path |
| `lint` | 3,926 | summary 1,665 plus JSON 2,260 (the JSON repeats the summary) |
| `review` (strip) | 5,697 | summary 636 plus **pretty JSON 5,060 (compact: 3,363)** |
| `review` (sheet, 9 tiles) | 4,500 | |
| `qa_run` | 1,744 | |
| `doctor` | 3,927–4,422 | |
| `verify` / `export` | 1,641 / 1,654 | |
| `storyboard_render` | 1,130 | |

**Structural waste.** `jsonResult` (`server.ts:91-99`) returns (a) a human summary, (b) `JSON.stringify(data, null, 2)` of the same data, and (c) the same object again as `structuredContent`. Pretty-printing inflates the JSON by about 50% (review: 5,060 vs 3,363 bytes). Most of what the model needs is already in the summary. If a client forwards `structuredContent` as well as the text, the payload is sent twice. Dropping the pretty JSON text block, or making it compact, would cut about 40–60% of every response.

**Polling.** `render_submit` returns immediately. The skill polls `job_status`, and each running poll is small (about 200–400 bytes) but costs a round trip. The final status is about 4 KB. A 60 s final render at the measured ~1 s per output second means 10–60 polls.

### 1.4 Images Claude is asked to Read
| Image | Pixel size (measured) | ≈ vision tokens* |
|---|---|---:|
| ingest keyframe | 320 × 180 JPEG, about 7 KB | ~80 each; at most 24 per video → ~1.9k |
| `review` sheet, 3 scenes / 9 tiles | 1468 × 864 | ~1.7k |
| `review` strip, 1 s scene at 15 fps / 15 tiles | 1476 × 652 | ~1.3k |
| `review` sheet, 16 scenes / 48 tiles (computed: 6 columns × 8 rows of 240 × 427) | ~1468 × 3460, downscaled to ~665 × 1568 | ~1.4k, but tiles become ~108 px wide and labels are illegible |
| `review` crop | 540 px tiles, 2 columns | ~1–1.5k |

\*Tokens are approximated as w·h/750 after the ~1568 px long-edge downscale.

**Per-minute estimate for one create → render → review cycle of a 60 s reel (about 12–16 scenes):**
- skills and references: 12–16k
- tools/list: 9k
- ContentIR read: 1–10k for a doc, but **up to ~280k for a repo** if Read whole. The plan skill tells Claude to "Read `source/content-ir.json`" (`skills/plan/SKILL.md:47`) and delegate only for larger inputs.
- template, scaffold and schema: 5–10k
- writing the spec (output): 3–5k
- validate, lint, render and poll: 5–8k
- review sheet plus 2–4 strips: 4–7k of images plus 5–15k of JSON

That totals about **50–80k tokens per iteration, excluding the IR**. Each fix-and-re-review loop adds 10–20k. The cost scales with the number of scenes and review strips, not with minutes: the 600 s maximum spec (`video-spec.ts:317`) at 30 s per scene is about 20 or more scenes. The dominant avoidable costs are the IR Read, the pretty-JSON duplication and `schema_get video-spec` (27 KB) when the spec is already scaffolded.

## 2. Processing performance

### 2.1 Measured
| Operation | Wall time |
|---|---:|
| Server start plus `tools/list` | 0.32 s |
| `ingest` of a 2 s 320×180 mp4 (probe, shot detection, keyframe, letterbox, loudness, copy) | 1.6–2.3 s |
| `ingest` of this repo (repomix search, secretlint, 400 KB budget) | 1.1 s |
| Tiny preview render: 3 scenes, 3 s, 540×960 at 15 fps, silent voice, ffmpeg | **4.4 s** (`render-project.mjs`, includes the process spawn) |
| Same project, fully cached re-render | **2.4 s** ("3 scene(s) reused, assembly reused") |
| Final render: 3 scenes, 9 s, 1080×1920 at 30 fps | **~9.0 s** (about 1 s of wall time per output second) |
| Single footage-scene renders (2 s clips, preview) | 3.0–5.0 s |
| `review` strip / sheet | 3.2 s / 2.1 s |
| `lint` / `spec_validate` | 29 ms / 10 ms |

A fully cached re-render still costs about 2 s. The assembly is reused, but validation, voice-cache lookups, hashing every clip (`hashFile` on each segment, `pipeline.ts:751-763`), the thumbnail/QA path and export run again.

### 2.2 Caching layers and keys
| Layer | Key | Location |
|---|---|---|
| Ingest extraction | `cacheKey{kind, inputDigest (file sha / repo digest), extractorVersion, uri, project-relative path}` → CAS blob | `${CLAUDE_PLUGIN_DATA}/cache/{ingest,cas}` (`ingest.ts:148-200`) |
| Voice | text, voice, backend, rate, `VOICE_CACHE_VERSION` | `cache/voice` |
| Whisper alignment | audio sha plus `ALIGN_VERSION` | `cache/align` |
| Scene clip | `sceneCacheKey` = canonical {LAYOUT_VERSION, scene JSON, tokens, target, zones, renderer id and version, placeholder, footage {sha, duration, content_box}, cues} (`renderer/src/select.ts:155-180`) | `renders/<q>/scenes/<id>.{mp4,json}` (in the project) |
| Assembly | hash of segment shas, transitions, audio slots, captions, music and version | `render-state.json` `assembly_key` |
| Thumbnail / cover | `thumbnail_key`, `COVER_VERSION` | project |
| Target transcode | input sha, plan and preset (`targets.ts:163`) | cache |

Findings:
- **Incorrect invalidation (verified):** screenshot images and logo files are keyed by id or path, not bytes. Replacing either leaves clips `cached` and stale (13-negative N16/N17).
- **Over-invalidation:** `voiceover` is part of `scene`, so editing a word of narration re-renders that scene's picture even when no cue moved. For HyperFrames scenes (Chrome, several seconds each), a narration-only edit pass over 12 scenes costs a full visual re-render. Keying the picture on `{scene minus voiceover, cues}` would avoid that.
- `renders/<q>/scenes` lives in the project, so it is portable. `variants` seeds variant projects from the base clip cache (`variants.ts:110-115`), which is a nice touch.

### 2.3 Parallelism
- **Scenes render sequentially.** `renderScenes` defaults to `concurrency: 1` (`select.ts:324`), and `renderProjectLocked` never passes it (`pipeline.ts:621-634`).
- **Every scene encode is single-threaded** (`-threads 1` by default: `ffmpeg-renderer.ts:2065-2066`, `footage.ts:262-263`).
- **One render at a time per server** (`render-jobs.ts:40`) and one per project across processes (the lock). Queued jobs wait (verified: "queued (1 ahead)", N36).
- Assembly and final encodes use ffmpeg's default threading (the `medium` preset for the master).

On an 8-core M-series Mac the ffmpeg scene stage therefore uses about 1/8 of the CPU. That is a deliberate low-RAM choice (per the handoff), but it is **not configurable** (no env var or tool argument). A 20-scene final render spends most of its time in serial single-thread scene encodes that could run 2–4 wide.

### 2.4 Encoders and hardware
- Scenes use x264 `veryfast` crf 18 (preview `ultrafast`). The master and reel use x264 `medium` crf 20 (`compose.ts:26-29`). Target transcodes use the preset passed in.
- **No hardware acceleration.** grep for `videotoolbox|hwaccel|nvenc|qsv` finds 0 hits. On macOS, `h264_videotoolbox` for previews would cut encode time by several times, at the cost of determinism. Previews could use it and finals could stay on x264.
- **Generation losses cost time as well as quality:** clip → concat → (logo) → burn-in means 3–4 full encodes of the whole timeline for the reel (`compose.ts:274-313`). Folding the logo overlay and burn-in into the concat filtergraph would save one or two full-length encodes per render.

### 2.5 Ingest-side scaling (code-inferred; not measured on long media)
- `detectShots` decodes the **entire** video at source resolution before `scale=160` (`ingestion/src/media.ts:62-70`), with a 60-minute timeout. Letterbox takes 5 samples, and loudness decodes the full audio. A 1-hour 1080p recording means roughly one full decode pass for shots plus one for loudness. Adding `-skip_frame nokey` or hardware decoding for detection would help.
- The whole media file (up to 8 GB) is **copied** into `source/assets/` (`media.ts:77-93`). There is no hard link or reflink, so large footage doubles disk use per project, and `shorts` copies trimmed spans again.
- whisper runs one file at a time with a 60-minute timeout (`asr.ts:26`). `base.en` on CPU handles long podcasts, but a 2–3 hour file risks the timeout.

### 2.6 Temp and cleanup
- Engine temp dirs are removed in `finally` blocks. A **SIGTERM leaks** `vs-ffr-*` dirs, `.s01.<pid>.tmp.mp4`, and an orphaned ffmpeg that keeps running (verified, N38).
- The **test suite leaks** 3,879 `vs-*` dirs (859 MB) in `$TMPDIR` (see 05-code-quality CQ6), which is material on this machine.

## 3. Recommendations (highest leverage first)
1. Stop pretty-printing the JSON text block, or drop it when `structuredContent` is present. Trim the `job_status` success payload to the summary (40–60% fewer tool-result tokens).
2. Make the plan skill never Read a large `content-ir.json` whole. Add an engine-side `ir_summary` or `ir_search` tool, or have ingest return a digest of the top claims and refs.
3. Paginate review sheets at about 16 tiles, or scale tile width so the sheet stays under 1568 px tall. Dedupe identical consecutive strip frames by SSIM.
4. Add image bytes to `sceneCacheKey`, and exclude `voiceover` when no cues are present.
5. Make scene concurrency and `-threads` configurable (for example `VS_RENDER_CONCURRENCY`, defaulting to 1 on machines with 8 GB of RAM or less and 2–3 otherwise). Consider `h264_videotoolbox` for previews.
6. Fold the logo and caption burn-in into fewer encode passes.

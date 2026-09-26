# 13 — Negative testing (executed)

## Setup
All tests ran on 2026-09-26 against `b6fd8ea` and its committed bundle `dist/mcp.mjs`, inside the Claude Code sandbox, under load average 10–20.

- **Work folder:** `$TMPDIR/vsaudit` (= `/tmp/claude-504/vsaudit`), with `CLAUDE_PLUGIN_DATA=$TMPDIR/vsaudit/data`. No repo projects or examples were touched.
- **Client:** `$TMPDIR/vsaudit/mcp.mjs`, a stdio JSON-RPC client that spawns the bundle (as `scripts/smoke-mcp.mjs` does), runs a JSON list of tool calls, polls `job_status` until the job is terminal, and prints `isError`, byte size and text. Every call below is `node mcp.mjs <calls>.json`. `PATHOVERRIDE` sets the server's `PATH`.
- **Media:** generated with lavfi at 320 px or smaller and 2 s or shorter: `good.mp4` (h264+aac), `empty.mp4` (0 bytes), `truncated.mp4` (the first 3,000 bytes of good), `garbage.mp4` (20 KB of `/dev/urandom`), `zero.mp4` (`-t 0`), `one_frame.mp4`, `huge_4000.mp4` (1 frame, 4000×4000, 1 fps), `odd.webm` (VP8), `clip.mov`, `oddcodec.mkv` (MPEG-4 Part 2 + MP3), `audio_only.m4a`, `still.png`, `image_as.mp4` (a PNG renamed), `noaudio_vertical.mp4` (180×320), `rotated.mp4` (display matrix 90°), `hdr.mp4` (HEVC 10-bit, PQ/BT.2020 tags), `podcast_cover.mp3` (MP3 + attached_pic), `blob.bin` (NUL bytes), and `secret_notes.txt` (a fake AWS key, an RSA key and a phone number).
- **Renders:** `voice: silent`, `renderer: ffmpeg`, `quality: preview` (540×960 at 15 fps) unless noted.

**Verdict key:** **good error** means actionable and early. **bad error** means it fails, but the message is misleading or late. **silent wrong** means it succeeds with a wrong or degraded result. **crash** and **hang** are as named. **OK** means handled correctly.

## Results

### Input files (tool: `ingest`, one project per file)
| # | Case | Observed | Verdict |
|---|---|---|---|
| N1 | `good.mp4` | 2.3 s. Video asset plus 1 keyframe, `needs_transcript` warning, `likeness=true` | OK |
| N2 | Empty file `.mp4` | `isError`: "nothing was ingested: … ffprobe exited with code 1: moov atom not found … Invalid data found" | good error |
| N3 | Truncated mp4 | same as N2 | good error |
| N4 | Random bytes `.mp4` | same as N2 | good error |
| N5 | Zero-duration mp4 | "zero.mp4 has no video or audio stream ffprobe can read" | good error |
| N6 | 1-frame mp4 (0.067 s) | Ingested: `duration_sec 0.067`, 1 shot, **no keyframe image and no warning** (the keyframe seek at the mid-shot failed; `media.ts:139` swallows it). Rendering it as 2 s footage succeeded: "clip gives 0.067s … last frame held", QA `frozen_frames warn` | silent wrong (ingest keyframe), OK (render) |
| N7 | 4000×4000, 1 fps, 1 frame | Ingested with no size warning and **no keyframe** (same cause). Rendered to 540×960 in 4 s with a held-frame warning | silent wrong (keyframe); OK otherwise. No resolution cap exists. |
| N8 | PNG renamed `.mp4` | Ingested as **video**, `duration_sec: 0`, `fps: 25`, no warning. The footage render was refused with: "footage starts at 0s, after the end of "asset-1" (0s) (fix: use an in_sec below 0)" | bad error (the misclassification is silent; the fix text is impossible) |
| N9 | `still.png` | Ingested as a **text** source titled `"�PNG"`, whose section text is raw PNG bytes (`\u0000IHDR…`). There is no image extractor, and unknown extension or binary files fall through to `text` (`detect.ts:104`) | silent wrong |
| N10 | `odd.webm` (VP8) | Ingested; footage render OK (5 s) | OK |
| N11 | `oddcodec.mkv` (MPEG-4 + MP3) | Ingested (audio detected); footage render OK | OK |
| N12 | `clip.mov`, `noaudio_vertical.mp4` | Both ingested and rendered. The vertical clip into the 9:16 target with no audio gave "video is silent" spec warnings | OK |
| N13 | `audio_only.m4a` used as `footage.asset` | Spec validation passed. The render **"succeeded"** with `placeholders: s01` and the warning "placeholder cards … video providers … arrive in Phase 7". The true reason ("audio asset; footage needs a video or an image") appears **only** in `render-state.json` and `render-manifest.json` | bad error (reported as success, with the wrong reason shown) |
| N22 | MP3 with embedded cover art | Classified as **audio** (the `attached_pic` stream is ignored, `ffmpeg.ts:318`) | OK |
| N23 | Rotated phone clip (`rotation=90`) | Ingested as `320×180` (the unrotated coded size). The footage render displayed correctly because of autorotate plus `iw/ih` expressions, but the metadata is wrong for `content_box`, redact and `analyze` aspect | silent wrong (metadata) |
| N24 | HEVC 10-bit PQ "HDR" | Ingested and rendered with no warning and no tonemap. The visual effect could not be judged on synthetic testsrc | silent wrong (by code; visual impact not verified) |
| N28–N30 | See the argument section below | | |

### Missing tools and models
| # | Case | Observed | Verdict |
|---|---|---|---|
| N14 | `PATH=/usr/bin:/bin` (no ffmpeg): `doctor`, `ingest`, `render_submit` | doctor: `[FAIL] ffmpeg not found … fix: brew install ffmpeg` and the dependent checks skipped. ingest of a **cached** mp4 succeeded (a cache hit, so no ffprobe was needed). render: "could not render 3 scene(s): no available renderer draws "typography": ffmpeg-drawtext unavailable (ffmpeg not found on PATH); hyperframes unavailable …" followed by "**re-run with renderer "ffmpeg"**" | good error (with a misleading last hint) |
| N32 | `transcribe` with no whisper model | "no whisper model at …/models/ggml-base.en.bin … ask the user whether to download it (~148 MB) … download_model: true; or set VS_WHISPER_MODEL …; or pass captions_file" | good error |
| N33 | `VS_WHISPER_MODEL` = a non-model file | "whisper-cli failed: whisper-cli exited with code 3: … failed to initialize whisper context" | good error |
| – | whisper-cli missing | **Not tested separately**: `whisper-cli` is at `/opt/homebrew/bin` and the model check happens first. In the N14 `PATH`, doctor reported "whisper.cpp not found" with a fix | (doctor) good |

### Invalid arguments and specs
| # | Case | Observed | Verdict |
|---|---|---|---|
| N28a | `spec_validate` on truncated JSON `{ "title": ` | `INVALID … [syntax] (root): syntax error: Flow map must end with a } at line 1, column 12` (YAML parser wording for JSON) | good error |
| N28b | Spec missing most fields | 4.4 KB listing every missing or invalid field, each with a fix | good error |
| N28c | Duplicate scene ids | "duplicate scene id "s01" (first used at scenes.0) — fix: renumber …" | good error |
| N28d | `style: "../../etc/passwd"` | Render refused: "style: expected a stable identifier" (`Id` regex) | good error |
| N28e | `spec_validate` with both `project_dir` and `spec_path` | "provide exactly one of `project_dir` or `spec_path`" | good error |
| N28f | `template_get {id:"../../etc/passwd"}` | "unknown template …; available: aesthetic-broll, …" (lookup by id; no path use) | good error |
| N28g | `spec_scaffold` with the wrong argument name | MCP −32602 "expected string, received undefined at template_id" | good error |
| N28h | `job_status {job_id:"nope"}` | "unknown job nope" | good error |
| N28i | `schema_get {name:"../x"}` | MCP −32602, invalid enum, lists the valid names | good error |
| N28j | Screenshot `props.asset` as an absolute or `../` path | Refused: "expected a stable identifier" | good error |
| N29 | `ingest` of a **non-existent** `notes-typo.txt` | **Succeeded**: the literal path string was ingested as inline text ("1 sections, 1 evidence spans", `inline:inline-…`). The same with `.pdf` → "nothing was ingested" | silent wrong (`detect.ts:106` + `ingest.ts:142`) |
| N30 | `ingest blob.bin` (NUL bytes) | Ingested as text, and NUL bytes are stored in the ContentIR | silent wrong |
| N31 | `ingest` of an empty directory | "… is a directory without .git, package.json or README; it is not a recognizable repository" | good error |
| N40 | `ingest /etc/hosts` | Ingested as text (`title "##"`) | OK by design (user-scoped reads); see 10-security S8 |
| N44 | `project_init` into an existing folder that has no `project.json` | Created `project.json` (the "fails if a project already exists" rule only checks for `project.json`) | OK |
| N39 | `project_init {dir:"~/vs-tilde-test"}` | Created **`<cwd>/~/vs-tilde-test`**, a literal `~` directory | silent wrong |
| – | `analyze` on audio-only / on `/etc/hosts` | "analyze needs a video with a picture track" / an ffprobe error | good error |
| N26 | `analyze good.mp4` (a 440 Hz sine, not speech) | "Speech: yes (100% voice-band sound)" | silent wrong (documented limitation) |
| – | `tighten` / `shorts` without a transcript | "asset asset-1 has no transcript. Fix: run transcribe for asset-1 first" | good error |

### Path traversal (renders; each project under `$TMPDIR/vsaudit/pt/<case>`, and the "secret" is `$TMPDIR/vsaudit/outside/secret.png`, a red square)
| # | Case | Observed | Verdict |
|---|---|---|---|
| N25a | `brand.visual.logo` = **absolute** outside path, end card (ffmpeg renderer) | Render succeeded with **no warning**. The extracted frame shows the **red outside image on the end card** | **silent wrong: confinement bypass (10-security S4)** |
| N25b | logo `../outside/secret.png`, end card | "end_card: logo … could not be read; skipped" (rejected, but the message hides the reason) | OK, with a vague error |
| N25c | Absolute logo with `logo_placement: top_right` (overlay path) | "brand: logo "/tmp/…/secret.png" is outside the project; no logo drawn" | good error |
| N25d/e | `assets/link.png` → symlink to an outside file (end card and overlay) | end card "could not be read; skipped"; overlay "is outside the project; no logo drawn" | OK |
| N18 | `audio.music.file: "/etc/passwd"` | Job failed: "must be a file inside the project folder (… absolute paths are not allowed)" | good error |
| N19 | music `../../outside/secret.m4a`; music `bundled:../../etc/passwd` | "'..' segments are not allowed"; "is not a bundled track; use one of bundled:ambient, …" | good error |
| N21 | sfx `../outside/secret.m4a`; sfx `assets/s.m4a` → symlink outside | "'..' segments are not allowed"; "escapes project root via symlink" | good error |
| N20 | ContentIR tampered so `asset-1.path = "../outside/secret.png"`, used as footage | Render **"succeeded"** with a placeholder card and the Phase 7 message. The file was **not** read (confinement held), but the reason was not surfaced | OK for security, bad error for the user |
| N34 | `transcribe {captions_file:"../../outside/x.srt"}` (existing file) | **Imported**: "transcribed asset-1 (srt): 3 words", and the outside text "secret outside words" is in the project's ContentIR. An absolute `/etc/hosts` was refused only because of its extension | silent wrong (confinement missing; see S7) |

### Caching, rendering and review correctness
| # | Case | Observed | Verdict |
|---|---|---|---|
| N15 | Cue word `"100%"` on s02, then `review {mode:"strip", scene:"s02"}` | The tool reports `word cues: "100%" at 1.47s (tile 8)`, but the image tile at 1.47 s shows **no yellow cue label**. Reproduced directly: `tileDecor` output passed to ffmpeg logs `[Parsed_drawtext_2] Stray % near '"'` and draws only the first label; the same filter with cue "ok" draws the label | silent wrong (`review.ts:166-168`) |
| N16 | Screenshot scene; replace `source/assets/shot.png` (testsrc → solid red) and re-render | `render-state.json`: `s01: "cached"`, and the reel frame **still shows the old testsrc image** | **silent wrong: stale cache (P1)** |
| N17 | Change the absolute logo file (red → green) and re-render | `s01: "cached"`, and the end card is **still red** | silent wrong |
| – | Baseline render, then a second identical render | 4.4 s, then 2.4 s with "3 scene(s) reused, assembly reused" | OK |

### Concurrency, abort and repeat runs
| # | Case | Observed | Verdict |
|---|---|---|---|
| N35 | Two server processes render the same project about 1.2 s apart | The second job failed immediately: "another render of this project is running (pid 19750 on MSBINEM-PC001, preview quality, started …); wait for it … or if it crashed, delete …/renders/.render.lock". The first succeeded (6 s) and the lock was removed | good error |
| N36 | Two `render_submit` calls on one server for the same project | The second returned "queued (1 ahead)" | OK |
| N37 | Client closes stdin 1.5 s into a 9 s final render | The server finished the render and exited cleanly after 9.25 s. `dist/` was complete and no lock was left | OK |
| N38 | **SIGTERM** to the server 1.5 s into a final render | Exited immediately. Left behind: `renders/.render.lock` (pid 20051), `renders/final/scenes/.s01.20051.tmp.mp4` and `$TMPDIR/vs-ffr-IFHARj/{t0,t1}.txt`. **The orphaned ffmpeg kept writing**: the tmp clip grew from 48 B to 46,380 B after the server died. The next render took over the stale lock (dead pid) and succeeded, but the `.tmp.mp4` **remained** afterwards | bad (leaks plus orphaned process; recovery OK) |
| – | Same output names: re-render into an existing `dist/` | Four re-renders of `r1` overwrote `dist/` without error. Stale target dirs are removed by code (`targets.ts:179`) | OK |
| N27 | `ingest https://www.youtube.com/watch?v=…` and `http://127.0.0.1:9/admin` | Both "fetch failed" (sandbox network). **The loopback URL was attempted**, since no SSRF guard exists | inconclusive for YouTube; SSRF confirmed by code |
| – | `secret_notes.txt` (AWS key, RSA key, phone) | Ingested with `secrets=true, pii=true`, and **the key text is stored verbatim** in `content-ir.json` | silent (flagged, not redacted); see S3 |

## Could not test, and why
- **HyperFrames renders** (Chrome is blocked in the sandbox), so the HyperFrames path confinement (S6), its fonts and its HDR mode are code-reviewed only.
- **`say` / espeak** (the sandbox writes an empty file), so the voice runner's lack of a timeout (CQ4) is untested.
- **Real network egress**: the sandbox proxy refused the YouTube and loopback fetches, so SSRF redirect behaviour is from code review plus `url.test.ts`.
- **ElevenLabs** (no key) and the **whisper model download** (150 MB, consent required).
- **Demo capture** (Chrome is blocked); the masking race is inferred from `demo.ts:289-300`.
- **Very long media** (hours) and **huge declared-duration** files, which were avoided per instructions; timeouts and costs are inferred from code (`media.ts:65`, `asr.ts:26`).
- **`pkill`/`pgrep`** are blocked by the sandbox. The orphaned ffmpeg in N38 was proven by the tmp file growing after the server exited, not by the process list.
- **Hand-made multi-GB `.html`** (S9 memory exhaustion), which was not run in order to protect the machine.

## Reproduction scripts (in `$TMPDIR/vsaudit/`)
`mcp.mjs` (client), `mkfoot.mjs` (footage matrix), `mkpt.mjs` (path-traversal projects), `killtest.mjs` (SIGTERM and stdin close), and `c_*.json` (the call lists used above).

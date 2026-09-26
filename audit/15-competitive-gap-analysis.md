# 15 · Competitive gap analysis

Scope: what adjacent Claude plugins, MCP servers and AI video products do (researched 2026-09-26), compared with what video-studio does in code at `b6fd8ea`. Our claims are checked against the repository. Competitor claims come from their public pages (sources at the end) and were not verified hands-on.

## 1. The landscape: four groups

| Group | Representative projects | What they do | Relation to video-studio |
|---|---|---|---|
| **A. Perception plugins** ("let Claude watch a video") | claude-video-vision (Claude Code plugin, ~1.3k★), vidmcp (ethnn-b), mcp-video, video-watch-mcp, Video Analyzer | Extract frames (adaptive or scene-change), transcribe (Whisper / Gemini / OpenAI), hand base64 frames and a timestamped transcript to Claude. claude-video-vision: `/watch-video`, adaptive fps, max 100 frames, 512 px, YouTube via yt-dlp (prefers existing subtitles), 7-day cache. | **Different job.** video-studio *makes* videos, it doesn't answer questions about arbitrary ones. It has the parts (ffmpeg frames, scene detection in ingest, whisper, `review` sheets) but no "understand this video" tool. |
| **B. Edit-with-Claude tools** | video-use (~11.6k★, MIT), ffmpeg-mcp-server, FFmpeg Micro MCP, Video Editor MCP, "FFmpeg Toolkit" skills | Transcript-driven editing: word-level transcripts (video-use: ElevenLabs Scribe), filler/silence removal with short fades, auto colour grading presets, subtitle burn-in, speaker diarization, an approval step before destructive actions, self-evaluation and up to 3 re-renders. | **Closest overlap on footage.** We have transcript-driven `tighten` (pauses, fillers, retakes, 15 ms fades, dry run → new asset), whisper transcripts, captions, cutaways, `review`. Missing vs video-use: diarization, colour grading, an automatic self-evaluate-and-re-render loop (our render skill now reviews once, per spec). |
| **C. Programmatic creation kits** | Official Remotion skill (reported 25k installs in its first week), digitalsamba Video Toolkit (Remotion + ElevenLabs + FFmpeg + Playwright, brand profiles, 9 components, 11 transitions), Manim skills / MCP, Claude-Code-Video-Toolkit list | Claude writes React/Manim code per video, renders to MP4. Brand/theme systems, lower thirds, transitions, screen recording via Playwright. | **Same goal, different contract.** They generate code per video, while video-studio compiles a validated spec (`VideoSpec`) against a fixed renderer set (15 scene kinds, 2 renderers). That gives us determinism, lint, caching and a lock. We deliberately don't use Remotion (licence: companies of more than 3 people need a paid licence). |
| **D. Repurposing SaaS** | OpusClip, Choppity, Vizard, CapCut, Vmaker | Long video → ranked short clips ("virality score"), AI reframing with subject/face tracking, captions (OpusClip claims >97% accuracy), brand templates, 25–75+ languages, dubbing (Vmaker 35+ languages), one-click multi-platform publishing, scheduling, analytics, team workspaces, APIs. | **Our `shorts` + `adapt` + `variants` + `localize` + per-platform `dist/` cover the pipeline locally**, without accounts or upload. Missing: face-tracked reframing, learned clip ranking, dubbing voices beyond system TTS, publishing and analytics (Phase 9). |
| **E. Video intelligence APIs** | Twelve Labs (Marengo embeddings, Search/Embed API) | Multimodal embeddings of video (motion, objects, sound, on-screen text, speech), natural-language moment search. | Out of scope today. Relevant only to a "video knowledge base" direction (see §4). |

## 2. Where video-studio is ahead (verified in code)

These are rare or absent in every group above:

1. **Grounding and provenance.** Every claim cites ContentIR evidence. `spec_validate` enforces strict grounding, and `verify` reports claim coverage. No competitor checks that a video says only what its sources say.
2. **Platform compiler with lint.** `platform-specs/*.yaml` contracts plus UI-mask geometry drive the lint checks: captions under app UI, text overflow, contrast, reading density, caption timing and sync, cuts on the beat, story arc, cutaway rhythm, logo overlap, brand forbidden treatments, and text repeating captions. It emits one `dist/<target>/` package per platform with `post.json`. SaaS tools reframe, but none lint against each app's UI masks.
3. **Reproducibility.** `video.lock`, scene cache keys, `test` golden frames and a `diff` that classifies changes as creative, renderer, spec, asset or metadata. Nothing comparable exists in group A–D tools.
4. **Local-first, no LLM key.** Claude is the creative engine; rendering, voice (`say` plus whisper alignment), ASR (whisper.cpp) and music are local. Competitors in B and D usually need an ElevenLabs, OpenAI, Gemini or SaaS account.
5. **Timing craft.** Word cues land graphics on spoken words; captions get reading time; beat-synced cuts; transitions keep narration in sync. Competitors expose captions, but not cue-to-word animation from a spec.
6. **Self-review built into the flow.** `review` (sheets, strips, crops, lint-flagged borders, cue labels) and `compare` (a synced before/after page). video-use has a self-evaluate loop; perception plugins return frames but don't mark problems.

## 3. Gaps that matter for *this* product

Each is ranked by user value for a knowledge-to-video compiler. The "Evidence" column says what exists now.

| # | Gap | Who has it | Evidence in our code | Why it matters here |
|---|---|---|---|---|
| G1 | **Video URL input** (YouTube, Loom, Vimeo; existing subtitles) | claude-video-vision, mcp-video, YouTube Clipper skill | `ingest` fetches web *pages* (`packages/ingestion/src/url.ts`); no yt-dlp or video URLs (grep finds none) | `shorts`, `tighten` and cutaways all need footage. Most long-form talks live on YouTube, so the user must download them manually today. |
| G2 | **Face/subject-aware reframing** 16:9 → 9:16 | OpusClip ReframeAnything, Choppity multi-speaker tracking | Manual `footage.focus {x,y}`; ingest marks all footage `contains_likeness` because frames are never checked for faces (`packages/ingestion/src/media.ts:201`) | Talking-head shorts from landscape recordings are the #1 repurposing use. A static focus crop loses a speaker who moves. |
| G3 | **Speaker diarization** | video-use, Choppity | none (no diarization code) | Interviews and podcasts: `shorts` can't prefer one speaker, and captions can't label speakers. |
| G4 | **"Understand this video" for Claude** (frames + transcript as a query tool) | all of group A | Parts exist (`review` frames, ingest keyframes and shots, `transcribe`); no tool returns "frames at scene changes + transcript for time range X" for question answering | Planning cutaways, choosing b-roll, and writing a spec for footage all need Claude to *see* the footage cheaply. Today it reads ingest keyframes or `review` sheets, which weren't designed for this. |
| G5 | **Self-evaluate → re-render loop** | video-use (up to 3 automatic re-renders) | The render skill reviews once and fixes by hand (`skills/render/SKILL.md` step 4); lint has a 3-pass fix loop for lint findings only | Closes the gap between a render that passes lint and one that looks right. |
| G6 | **Natural multilingual voice / dubbing** | Vmaker (35+ dubbing languages), SaaS broadly | System voices per language; no Hindi voice → silent with a reason (HANDOFF, Phase 8); ElevenLabs is planned for Phase 7 | `localize` produces text and timing, but the voice is the weak link for non-English reels. |
| G7 | **Colour correction / grading of footage** | video-use presets | Only `eq` in redaction and blur-pad (`packages/renderer/src/footage.ts:116,141`) | Phone footage in reels looks flat next to crisp motion graphics. |
| G8 | **Publishing, scheduling, analytics** | OpusClip, Choppity | Phase 9, not started; `post.json` is written for manual upload | Closes the loop: hook/cover `variants` experiments need results to learn from. |
| G9 | **Learned clip ranking** | OpusClip virality score | `shorts` scores hooks and spans with heuristics (`packages/mcp/src/shorts.ts:41`) | The heuristic is transparent and local. A learned score is SaaS territory; better to let Claude rank the top N candidates with reasons. |
| G10 | **Semantic video search / knowledge base** | Twelve Labs | none | Useful only if the product moves toward "find the pricing part in 40 recordings". Not core to a compiler. |

## 4. Prompt feature ideas, judged against this codebase

| Idea (from the audit brief) | Belongs here? | Why, grounded in the current code |
|---|---|---|
| 1. Video understanding memory | **Partly.** Cache per asset, not a separate memory store | Ingest already persists per-asset facts in ContentIR (shots, keyframes, loudness, transcript refs, `content_box`). Extending *that* (scene descriptions Claude writes once, keyed by asset sha256) fits the architecture. A cross-session memory store would duplicate it. |
| 2. Scene intelligence (boundaries, descriptions, importance) | **Yes, for footage** | Boundaries exist (ingest shot detection). Descriptions and importance are Claude's job from keyframes, stored in ContentIR. Emotion scores need a vision model the plugin deliberately doesn't bundle. |
| 3. Smart highlight extraction | **Already there as `shorts`**; extend it | Candidate spans, scoring and `make_projects` exist. Add Claude re-ranking with reasons and G1 URL input. |
| 4. Content repurposing chain | **Mostly exists** | `shorts` → talking-head projects → `adapt` (aspect, length, targets) → `dist/<target>/` for instagram, youtube-shorts, linkedin, facebook-page-api and tiktok. There's no X/Twitter platform contract yet. Add one only with a verified spec (platform facts are data). |
| 5. Quality reviewer | **Largely exists** | QA (`technicalQa`: loudness, black and frozen frames), lint (about 30 rules), `review`. Missing: lighting and exposure metrics, and speech clarity (SNR) on footage. Both are cheap ffmpeg `signalstats`/`astats` checks. |
| 6. Editing agent (silence, fillers, captions, transitions, intro/outro, thumbnail) | **Exists** except intro/outro templates | `tighten`, captions, transitions, covers. Intro/outro would be an end card / hook template. |
| 7. Brand memory | **Exists as `brand.yaml`** | Colours, fonts, weights, logo placement, forbidden treatments, voice rules, terminology, CTAs. Music preference and default style could be added as fields. |
| 8. Multi-agent production pipeline | **Not as a runtime feature** | Skills (plan → create → render → review → lint → export) are the pipeline, run by one Claude session with approval gates. Splitting into agents would add cost and nondeterminism without new capability. The two existing agents (source-researcher, creative-director) are already the right granularity. |
| 9. Video knowledge base (embeddings, search) | **No** (different product) | Needs an embedding model and an index. Conflicts with the no-download, local-first defaults. |
| 10. Enterprise video intelligence | **No** (SaaS direction) | The architecture is a local compiler; enterprise needs multi-tenant storage, auth, and retention. Out of scope for a plugin. |

## 5. Positioning summary

video-studio competes on **correctness and craft** (grounded claims, platform lint, reproducibility, timing), not on breadth of AI perception. Its biggest competitive gaps are *inputs and footage handling*: video URLs (G1), subject-aware reframing (G2), diarization (G3), and a cheap "see this footage" tool (G4). Those decide whether the repurposing workflow (`shorts`, cutaways, `tighten`) is usable on real long-form content without manual prep.

## Sources

- [claude-video-vision (GitHub)](https://github.com/jordanrendric/claude-video-vision)
- [Video MCP Server by ethnn-b (Glama)](https://glama.ai/mcp/servers/ethnn-b/vidmcp)
- [mcp-video (GitHub)](https://github.com/dexi1570-sudo/mcp-video)
- [video-watch-mcp (GitHub)](https://github.com/maryfellowes/video-watch-mcp)
- [Video Analyzer (Claude Code Marketplaces)](https://claudemarketplaces.com/mcp/brightwayai/video-analyzer)
- [video-use guide (explainx.ai)](https://explainx.ai/blog/video-use-claude-code-ai-video-editor-guide-2026)
- [Claude-Code-Video-Toolkit (GitHub)](https://github.com/wilwaldon/Claude-Code-Video-Toolkit)
- [ffmpeg-mcp-server (GitHub)](https://github.com/beambuilder/ffmpeg-mcp-server)
- [FFmpeg Micro with Claude Code](https://www.ffmpeg-micro.com/with/claude-code)
- [OpusClip](https://www.opus.pro/)
- [Choppity: best AI video editors 2026](https://www.choppity.com/blog/best-ai-video-editors-content-creators/)
- [Vizard: best AI clipping tools 2026](https://vizard.ai/blog/best-ai-video-clipping-tools-2026)
- [Vmaker long-to-short](https://www.vmaker.com/tools/long-video-to-short-video-ai)
- [Twelve Labs search guide](https://docs.twelvelabs.io/docs/guides/search)

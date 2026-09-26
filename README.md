<div align="center">

<img src="docs/media/hero.svg" alt="video-studio: source documents flow through ingest, plan, render, lint and QA into TikTok, Reels and Shorts packages with captions placed clear of each app's UI" width="100%">

<p>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-4F8CFF"></a>
  <img alt="Claude Code plugin" src="https://img.shields.io/badge/Claude%20Code-plugin-22C55E">
  <img alt="MCP server" src="https://img.shields.io/badge/engine-MCP%20server-4F8CFF">
  <img alt="Node 22.13+" src="https://img.shields.io/badge/node-%E2%89%A5%2022.13-339933">
  <img alt="No API keys needed" src="https://img.shields.io/badge/API%20keys-not%20needed-22C55E">
</p>

**Turn a README, a paper, a web page or a folder of clips into a finished, captioned short video, one package per platform, without leaving Claude Code.**

[See what it makes](#see-what-it-makes) · [Quick start](#quick-start) · [How it works](#how-it-works) · [Commands](#commands) · [Limits](#what-it-does-not-do-yet)

</div>

---

## Why

Turning knowledge into short videos usually means a timeline editor, a caption tool, a thumbnail tool and a checklist for every platform's safe zones and limits. **video-studio** compiles instead:

- **Grounded:** every claim on screen cites a line in your sources. `verify` shows what is covered.
- **Platform-ready:** one `dist/<platform>/` package each for TikTok, Instagram Reels, YouTube Shorts, LinkedIn and Facebook, with the video, cover, captions, post copy and a QA report. `lint` checks captions and text against each app's UI.
- **Reproducible:** `video.lock` pins every tool, font, renderer and asset hash. Re-renders are cached scene by scene, and `diff` and `test` catch regressions.
- **Local-first:** ffmpeg, system text-to-speech and local whisper.cpp. Claude writes the plan, so the plugin needs **no LLM API key**, and none of the features below need a paid service.

## See what it makes

Everything below was made by the plugin itself: no hand editing.

**This README as a reel.** [`docs/media/hero.mp4`](docs/media/hero.mp4) is a narrated 1080×1920 final render made from this README. It uses the animated-explainer structure, the `technical` style and a macOS Premium voice, and every line cites a README line. The project that makes it is [`examples/readme-hero`](examples/readme-hero):

<p align="center"><img src="docs/media/hero-cover.jpg" width="200" alt="Cover of the hero reel: the headline 'Docs in, video out'"></p>

The strips below are frames from preview renders (built-in ffmpeg renderer) made during development.

**15 scene kinds.** The strip shows kinetic text, a stat, a timeline, before/after, a quote, a map and a lower third, from a text-over-music reel with no voiceover:

<img src="docs/media/scene-kinds.png" width="100%" alt="Seven vertical frames: kinetic text 'Docs in. Video out.', '0 keys' stat, pipeline timeline, before/after split screen, a quote, a route map and a lower-third name bar">

**4 style packs, on the same content.** From left: the default, minimal, editorial, technical and energetic:

<img src="docs/media/styles.png" width="100%" alt="The same headline and call to action rendered in five looks: default dark, minimal light, editorial title case, technical green and energetic upper case">

**Languages.** The Whisper paper (arXiv 2212.04356) as Hindi (top) and Japanese (bottom) versions made with `localize`: shaped Devanagari, Japanese line breaking and script-aware captions and covers:

<img src="docs/media/languages.png" width="100%" alt="Hindi and Japanese frames of the Whisper explainer: stats, a diagram and captions in each script">

**Your own footage.** A folder of clips cut to the beat of a bundled music bed, with text over the footage (`aesthetic-broll` and `silent-vlog`):

<img src="docs/media/footage.png" width="100%" alt="Vertical frames cropped from six clips with a kinetic text overlay and a lower third">

## Quick start

**Requirements:** Node.js 22.13+ and a system FFmpeg with libass and libx264 (`brew install ffmpeg` on macOS). Check with `/video-studio:doctor`.

```sh
git clone https://github.com/harshil-1411/claude_plugin_video_studio.git video-studio
cd video-studio && pnpm install
claude --plugin-dir .
```

Then, inside Claude Code:

```
/video-studio:create README.md as a 30-second 9:16 reel for tiktok, instagram and youtube-shorts
```

Claude reads the source, proposes a hook, a scene plan and a storyboard, and waits for your **approval**. It then renders a preview, then the final, and writes the packages:

```text
dist/
├── reel.mp4  clean-master.mp4  captions.srt  captions.vtt  cover.jpg
├── video.lock  render-manifest.json  provenance.json  video-spec.json
├── tiktok/           video.mp4  cover.jpg  captions.*  post.json  qa.json
├── instagram/        …
└── youtube-shorts/   …
```

<details>
<summary>Install from a marketplace, and optional keys</summary>

```
/plugin marketplace add harshil-1411/claude_plugin_video_studio
/plugin install video-studio@video-studio-marketplace
```

Provider keys (ElevenLabs, and later Runway, HeyGen, fal.ai) are optional. Set them in `/plugin` → video-studio → Configure. They are kept in the OS credential store and passed only to the plugin's MCP server.

</details>

## How it works

```mermaid
flowchart LR
  A["Sources<br/>md · pdf · docx · pptx · url · repo<br/>video · audio · clip folders"] --> B["ingest<br/>ContentIR + evidence refs"]
  B --> C["plan<br/>brief · grounded VideoSpec · storyboard"]
  C -->|your approval| D["render<br/>voice · scenes · captions · music"]
  D --> E["lint + QA<br/>platform contracts · WCAG · loudness"]
  E --> F["dist/&lt;platform&gt;/<br/>video · cover · captions · post · qa"]
```

- **Claude is the creative engine.** Skills guide Claude to write the brief and the scene spec.
- **The engine does the rest.** A bundled MCP server validates, renders, runs QA and packages. It is deterministic, cached and has no LLM calls.
- **Three contracts connect the stages:**
  - `ContentIR`: the sources, with provenance.
  - `VideoSpec`: a provider-neutral scene graph.
  - `RenderManifest`: exactly what happened.

  Their JSON Schemas are in [`schemas/`](schemas/).
- **Platform facts are data**, not code: [`platform-specs/*.yaml`](platform-specs/) record each app's limits and UI masks, with a source URL and the date they were verified.

## What you can make

| | |
|---|---|
| **Inputs** | Markdown, text, PDF, DOCX, PPTX, web pages, local repos, video and audio files, folders of clips |
| **Templates (18)** | explain · educational · listicle · faceless-listicle · product-launch · devtool-launch · product-demo · product-ui · case-study · before-after · carousel-story · animated-explainer · text-over-music · talking-head · aesthetic-broll · silent-vlog · oddly-satisfying · ambient-slice-of-life |
| **Scene kinds (15)** | typography · code · chart · stat · diagram · timeline · comparison · split_screen · quote · kinetic_text · lower_third · map · screenshot · cta · end_card, plus real footage with text overlays |
| **Voice** | macOS `say` (automatically picks an installed Premium/Enhanced voice) or espeak-ng, ElevenLabs (optional key), no voice (text over music), or the speech already in your footage; pace set with `voice.rate_wpm` (default 160) |
| **Audio** | 4 bundled CC0 music beds (ducked under speech), beat-synced cuts, native clip sound, crossfades, sound effects, −14 LUFS with true-peak headroom |
| **Footage** | Crop, contain or blurred-pad fits, trim and speed, text overlays, automatic removal of baked-in letterbox bars, and `redact` regions to blur inboxes, names or dashboards in screen recordings; cutaways from a talking head to a graphic while the speaker keeps talking |
| **Captions** | 3–7 word phrases on plates, placed clear of each platform's UI, with keyword emphasis and sound-event cues like `[music]` |
| **Looks** | Style packs (minimal, editorial, technical, energetic) and brand kits (colours, fonts, weights, motion, banned phrases, pronunciation overrides such as `LLM` → "L L M" that keep captions as written); scene transitions (crossfade, fade to black, slide, zoom, whip) that keep narration in sync; per-scene camera moves (push in, pull out, punch, reveal, drift, hold); word cues that land each list item, step or number on the word that says it |
| **Languages** | `localize` translation sheets; bundled Noto fonts for Japanese, Devanagari and Arabic; CJK line breaking; right-to-left text |
| **Trust** | `verify` claim coverage, `video.lock`, golden-frame `test`, `diff`, provenance, optional C2PA content credentials (`export sign`) |

## Examples

| Example | What it shows |
|---|---|
| [`examples/readme-hero`](examples/readme-hero) | The narrated hero reel above, grounded in a README snapshot |
| [`examples/text-to-motion-graphic`](examples/text-to-motion-graphic) | A 30 s explainer from Markdown notes (also the golden-frame test) |
| [`examples/reel-grammar`](examples/reel-grammar) | Every Phase 5 scene kind, the `energetic` style and a music bed, with no voiceover |
| [`examples/demo-app`](examples/demo-app) | A tiny web app to try `/video-studio:demo` screen recording on |

## Commands

| Command | What it does |
|---|---|
| `/video-studio:create` | The whole flow, from a source or an idea to packages, with an approval step |
| `/video-studio:plan` · `validate` | Brief, grounded spec and storyboard, built on a story arc (hook, open loop, escalation, payoff, CTA); explains every validation issue |
| `/video-studio:render` · `qa` · `export` | Local render (preview, then final), technical QA, per-platform packages (`sign` for C2PA) |
| `/video-studio:lint` · `verify` | Platform contract checks with a fix loop (UI zones, caption readability and sync, cuts on the beat, story arc); claim coverage against the sources |
| `/video-studio:test` · `diff` | Golden-frame regression tests; spec, lock and frame diffs between renders |
| `/video-studio:variants` · `adapt` | Hook × cover A/B sets with an experiment manifest; new aspect, length or platform |
| `/video-studio:localize` | Language versions from a translation sheet, re-timed for the language |
| `/video-studio:ingest` · `shorts` · `analyze` | Media ingest and local transcription; standalone clips from a long talk; a reference video's format |
| `/video-studio:tighten` | Cleans up talking-head footage: shortens pauses, cuts filler words and drops retakes (dry run first, new asset on apply) |
| `/video-studio:demo` | Records a scripted walk through **your** running app (inputs are blurred) |
| `/video-studio:doctor` | Checks ffmpeg, fonts, Chrome, whisper, HyperFrames and keys |

## What it does not do (yet)

- **No generative video or avatars yet.** Runway, HeyGen and fal.ai adapters are planned (Phase 7, needs keys). Until then those scenes render as titled placeholder cards. Sora is intentionally not supported.
- **No posting or analytics.** It produces packages and post copy; you upload them. Platform "trending sounds" are added in each app, and `post.json` reminds you of that.
- **HyperFrames is optional.** The built-in ffmpeg renderer covers every scene kind. The richer HyperFrames renderer needs its own install and Google Chrome.
- **The whisper model is downloaded only with your consent** (about 148 MB). You can supply SRT/VTT captions instead.
- **Demo capture never starts your app.** You start it and give the URL, and every step is approved first.

The roadmap is in [`docs/PLAN.md`](docs/PLAN.md) and the current state in [`docs/HANDOFF.md`](docs/HANDOFF.md).

<details>
<summary><b>Development</b></summary>

```sh
pnpm install
pnpm typecheck        # tsc -b
pnpm test             # vitest
pnpm schemas          # regenerate schemas/*.schema.json
pnpm bundle           # build dist/mcp.mjs (single-file ESM, committed)
pnpm smoke            # start dist/mcp.mjs over stdio and check its tools
claude plugin validate --strict .claude-plugin/plugin.json   # plugin + skills
claude plugin validate --strict .                            # marketplace
```

After changing anything under `packages/`, rerun `pnpm bundle` and commit `dist/mcp.mjs`.

| Package | Role |
|---|---|
| `packages/schema` | zod models → `schemas/*.schema.json` |
| `packages/core` | project folders, cache, SQLite ledger, jobs |
| `packages/ingestion` | extractors (documents, web, repos, media) |
| `packages/media` | ffmpeg, audio mix, captions, QA, ASR, beat detection |
| `packages/renderer` | ffmpeg, footage and HyperFrames renderers; tokens, styles, scripts |
| `packages/platforms` | platform contracts and layout zones |
| `packages/voice` | TTS backends |
| `packages/mcp` | the MCP server (`dist/mcp.mjs`) and every tool |

Data lives next to the code: `skills/`, `templates/`, `styles/`, `music/`, `fonts/` and `platform-specs/`.

</details>

## Contributing

Guides for adding [archetypes](docs/contributing/archetypes.md), [style packs](docs/contributing/styles.md), [platform packs](docs/contributing/platform-packs.md) and [providers](docs/contributing/providers.md) are in `docs/contributing/`. Ingested content is always treated as untrusted data: the plugin never executes code from sources.

## License

Apache-2.0. See [`LICENSE`](LICENSE). The bundled fonts are OFL-1.1 (see [`fonts/README.md`](fonts/README.md)), and the bundled music beds are CC0 (see [`music/README.md`](music/README.md)).

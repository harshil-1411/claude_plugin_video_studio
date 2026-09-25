# Deterministic Video Rendering and Media Tooling for a Node/TypeScript CLI (HyperFrames vs Remotion vs FFmpeg bundling)

All star counts, versions and dates below were observed on **2026-09-25** through the GitHub REST API (`api.github.com/repos/...`) and the npm registry (`registry.npmjs.org/<pkg>`), unless noted otherwise.

## HyperFrames: license, version, install, CLI, Node API, authoring model, determinism, media support, speed, OS requirements, maturity, agent skills

### Takeaway
HyperFrames (heygen-com/hyperframes) is **Apache-2.0**, currently **v0.8.74**, and very active: several releases a day, about 52.9k stars about six months after the repo was created. You write compositions as plain HTML with `data-*` timing attributes and paused, seekable animation timelines (GSAP, CSS, WAAPI, Lottie, and others). Rendering captures frames in headless Chrome one frame at a time with `HeadlessExperimental.beginFrame`, then encodes with FFmpeg. It needs Node >= 22 and FFmpeg installed separately. A one-call Node API (`createRenderJob`/`executeRenderJob` from `@hyperframes/producer`) and 21 published agent skills make it a strong fit for an agent-driven CLI. The main risk is maturity: the project is pre-1.0 and changes very quickly.

### Cited Findings
**License / version / maturity**
- License is Apache-2.0 (GitHub SPDX `Apache-2.0`). README: "Open source: Apache 2.0 license, with no per-render fees or commercial-use thresholds." — [GitHub API](https://api.github.com/repos/heygen-com/hyperframes), [README](https://github.com/heygen-com/hyperframes)
- Repo stats on 2026-09-25: 52,898 stars, 4,832 forks, 219 open issues+PRs, created 2026-03-10, last push 2026-09-25. — [GitHub API](https://api.github.com/repos/heygen-com/hyperframes)
- Release cadence: v0.8.65 through v0.8.74 were all published between 2026-09-23 15:09Z and 2026-09-24 21:23Z, which is 10 releases in about 30 hours. — [GitHub releases API](https://api.github.com/repos/heygen-com/hyperframes/releases)
- npm packages, all at 0.8.74 (published 2026-09-24): `hyperframes` (CLI, license Apache-2.0, bins `hyperframes` and `hyperframes-localize-fonts`), `@hyperframes/core` ("Types, parsers, generators, compiler, linter, runtime, and frame adapters"), `@hyperframes/engine` ("Seekable web page to video rendering engine (Puppeteer + FFmpeg)"), `@hyperframes/producer` ("HTML-to-video rendering engine using Chrome's BeginFrame API"). The scoped packages have no `license` field in their npm metadata. The repo LICENSE covers them. — [npm registry](https://registry.npmjs.org/hyperframes)
- The monorepo also contains `aws-lambda`, `gcp-cloud-run`, `player`, `studio`, `studio-server`, `shader-transitions`, `lint`, `parsers` and `sdk` packages. — [GitHub contents API](https://github.com/heygen-com/hyperframes/tree/main/packages)
- "Used in production at HeyGen", with adopters listed including tldraw and TanStack (see ADOPTERS.md). — [README](https://github.com/heygen-com/hyperframes)

**Install / CLI**
- Requirements: "Node.js 22+, FFmpeg". The producer package lists "Node.js >= 22, Chrome/Chromium (auto-downloaded), FFmpeg". — [README](https://github.com/heygen-com/hyperframes), [producer README](https://github.com/heygen-com/hyperframes/blob/main/packages/producer/README.md)
- Main CLI commands: `npx hyperframes init my-video`, `preview` (browser, live reload), `render`, `lint`, `check` ("opens the project in a browser and looks for runtime, layout, motion, media, and contrast problems"), `snapshot`, `publish`, `doctor`, `add <block>`, `catalog`, `skills update`, `keyframes`, `cloud render`, `lambda deploy / render / progress`. — [README](https://github.com/heygen-com/hyperframes), [Rendering guide](https://hyperframes.heygen.com/guides/rendering)
- Render flags: `--output`, `--format mp4|webm|mov|gif|png-sequence|hls`, `--fps`, `--quality draft|standard|high`, `--crf`, `--video-bitrate`, `--docker`, `--composition <file>`, `--gpu`, `--hdr`, `--vp9-cpu-used`, `--hls-segment-seconds`. FPS defaults to the composition's `data-fps`, otherwise 30. — [Rendering guide](https://github.com/heygen-com/hyperframes/blob/main/docs/guides/rendering.mdx)
- The README says "the CLI is non-interactive by default". — [README](https://github.com/heygen-com/hyperframes)

**Programmatic Node API**
- The `@hyperframes/producer` example:
  ```ts
  import { createRenderJob, executeRenderJob } from "@hyperframes/producer";
  const job = createRenderJob({ inputPath: "./my-composition.html", outputPath: "./output.mp4", width: 1920, height: 1080, fps: 30 });
  const result = await executeRenderJob(job, (p) => console.log(`${Math.round(p.percent*100)}%`));
  ```
  `RenderConfig` options: `inputPath`, `outputPath`, `width` (1920), `height` (1080), `fps` (24/30/60), `quality`, `format` (mp4/webm/mov/gif/png-sequence/hls), `hlsSegmentSeconds`, `videoFrameFormat` (auto/jpg/png). There is also `startServer({port})`, which exposes an HTTP `POST /render`. Distributed primitives are `planV2`, `renderChunkV2` and `assembleV2`, imported from `@hyperframes/producer/distributed`. — [producer README](https://github.com/heygen-com/hyperframes/blob/main/packages/producer/README.md)
- Lower-level `@hyperframes/engine` API: `acquireBrowser({captureMode:"beginFrame"})`, `createCaptureSession`, `initializeSession`, `captureFrame(session, i, path)`, `closeCaptureSession`. Its services include browserManager (pools `chrome-headless-shell`), streamingEncoder ("Pipe frames to FFmpeg in real time"), audioMixer, videoFrameExtractor, parallelCoordinator, and fileServer (Hono). — [engine README](https://github.com/heygen-com/hyperframes/blob/main/packages/engine/README.md)
- Producer dependencies include `puppeteer`/`puppeteer-core` ^25, `hono`, `linkedom` and several `@fontsource/*` fonts. There is **no** bundled FFmpeg npm dependency. — [producer package.json](https://github.com/heygen-com/hyperframes/blob/main/packages/producer/package.json)

**Authoring model**
- Compositions are HTML. The root has `data-composition-id`, `data-start`, `data-width`, `data-height`, and optionally `data-duration` and `data-fps`. Each visible element needs `class="clip"`, an `id`, `data-start`, `data-duration` and `data-track-index`. Animation timelines must be created `paused: true` and registered on `window.__timelines[<composition-id>]`. "Miss the last one and you get a still frame with no motion." — [HyperFrames vs Remotion guide](https://github.com/heygen-com/hyperframes/blob/main/docs/guides/hyperframes-vs-remotion.mdx), [README](https://github.com/heygen-com/hyperframes)
- Supported animation runtimes, through frame adapters: GSAP, CSS animations, Lottie, Three.js, Anime.js, WAAPI, TypeGPU, or a custom adapter. There is no build step: "an `index.html` composition plays as-is". — [README](https://github.com/heygen-com/hyperframes)
- Sub-compositions use `<template>` wrappers and render through the root. `--composition` renders another standalone file. — [Rendering guide](https://github.com/heygen-com/hyperframes/blob/main/docs/guides/rendering.mdx)

**Determinism mechanism**
- "Rendering never plays your video." Frame time is computed with integer math (`time = floor(frame) / fps`), and "real time is never consulted". The frame adapter's `seekFrame(frame)` seeks every animation, and "All GSAP timelines are paused and seeked, never played". Chrome's `HeadlessExperimental.beginFrame` "grabs the pixels in one atomic operation". Author rules: no `Date.now()`, `requestAnimationFrame` or timers; no unseeded `Math.random`; no fetching mid-render; fixed fps and size; a finite length. The `__playerReady` and `__renderReady` gates hold capture until the composition has loaded. — [Determinism docs](https://github.com/heygen-com/hyperframes/blob/main/docs/concepts/determinism.mdx)
- The time model is **seek-based**, not wall-clock virtualization. The docs describe no global patching of `Date.now`. Instead, the rules forbid wall-clock reads. — [Determinism docs](https://github.com/heygen-com/hyperframes/blob/main/docs/concepts/determinism.mdx)
- Cross-machine caveat: "Fonts and Chrome versions differ between computers, so a local render can shift by a pixel". `render --docker` "pins the Chromium version, the font set, and the FFmpeg encoder". — [Determinism docs](https://github.com/heygen-com/hyperframes/blob/main/docs/concepts/determinism.mdx)

**Audio / video elements**
- `<video class="clip" ... muted playsinline>` and `<audio data-start data-duration data-track-index data-volume>` are first-class. The pipeline "extracts `<audio>` elements and mixes them into the final video". FFmpeg "mixes in the audio from your `<audio>` and `<video>` elements". Video frames are extracted separately (videoFrameExtractor, `videoFrameFormat` jpg/png). — [README](https://github.com/heygen-com/hyperframes), [producer README](https://github.com/heygen-com/hyperframes/blob/main/packages/producer/README.md), [Determinism docs](https://github.com/heygen-com/hyperframes/blob/main/docs/concepts/determinism.mdx)
- HEVC and ProRes inputs that Chrome cannot decode get cached browser proxies for preview. "The original file stays in the project and remains the render source." — [Rendering guide](https://github.com/heygen-com/hyperframes/blob/main/docs/guides/rendering.mdx)
- Outputs: MP4 H.264 yuv420p (or H.265 + HDR10) with AAC; WebM VP9 with true alpha and Opus; MOV ProRes 4444 with alpha; PNG sequence plus an `audio.aac` sidecar; HLS. — [producer README](https://github.com/heygen-com/hyperframes/blob/main/packages/producer/README.md)
- Audio mixing extras such as a voiceover "carve", EQ, compressor, limiter and `<hf-audio-group>` submix buses are documented through the `/hyperframes-audio` skill. — [README](https://github.com/heygen-com/hyperframes)
- The catalog includes caption components such as `caption-pill-karaoke`, `caption-highlight` and `caption-kinetic-slam`. — [docs tree](https://github.com/heygen-com/hyperframes/tree/main/docs/catalog/components)

**Speed and OS**
- The only published benchmark is from the docs' own performance demo: "25.0s against 9.8s, taken as the median of three runs at 1920x1080 over 300 frames". In that demo, one CSS declaration made the difference. That works out to about 12–30 frames per second of capture on the doc author's machine. — [Performance guide](https://github.com/heygen-com/hyperframes/blob/main/docs/guides/performance.mdx)
- OS behavior: BeginFrame is "the default deterministic capture path on Linux headless-shell". "macOS and Windows already use screenshot mode by default", which is slower per frame. Rendering with alpha on Linux also falls back to `Page.captureScreenshot`. — [producer README](https://github.com/heygen-com/hyperframes/blob/main/packages/producer/README.md)
- GPU encoder detection is built in, and `--gpu` is available except for HLS. — [producer README](https://github.com/heygen-com/hyperframes/blob/main/packages/producer/README.md)

**Agent skills**
- HyperFrames ships **21 published skills**. Install with `npx skills add heygen-com/hyperframes`, or non-interactively with `npx hyperframes skills update` (core set only). The router is `/hyperframes`. Domain skills: `/hyperframes-core`, `-animation`, `-keyframes`, `-creative`, `-cli`, `-audio`, `-registry`, `/media-use`, `/figma`. Creation workflows: `/product-launch-video`, `/faceless-explainer`, `/pr-to-video`, `/embedded-captions`, `/talking-head-recut`, `/motion-graphics`, `/music-to-video`, `/slideshow`, `/general-video`, `/remotion-to-hyperframes`. The repo also has `.claude-plugin`, `.codex-plugin` and `.cursor-plugin` directories. — [README](https://github.com/heygen-com/hyperframes), [repo root](https://github.com/heygen-com/hyperframes)

### Inferences
- For a Node CLI, `@hyperframes/producer` gives a one-call HTML-to-MP4 path, including audio mixing, with no licensing friction. The CLI must still provide FFmpeg itself and must tolerate a Chrome download through Puppeteer.
- Because the project ships several releases a day and is pre-1.0, pin an exact version (for example `0.8.74`) and wrap the API behind an adapter interface.
- For bit-exact reproducibility across machines, recommend `--docker` or a pinned Chromium plus fonts. Otherwise treat determinism as "same machine, same output".
- Speed on macOS dev machines will be lower than on Linux because of screenshot-mode capture.

### Gaps
- There are no independent benchmarks comparing HyperFrames with Remotion render throughput.
- There is no explicit statement on whether `executeRenderJob` accepts runtime variables/props the way Remotion's `inputProps` does. A `variables` concept exists (docs/concepts/variables.mdx), but I did not read it.
- Windows support is mentioned (screenshot mode), but I found no official support matrix.

## Remotion: license terms, pricing, @remotion/renderer API, Lambda; checking the "more than 3 employees" claim

### Takeaway
**The claim is correct.** Under the Remotion License, the free license covers individuals, for-profit organizations with up to 3 employees, non-profits, and evaluation. Larger for-profit organizations need a Company License. The current pricing tiers are "Automators" ($0.01 per render, $100/month minimum), "Creators" ($25/month per seat), and Enterprise (from $500/month). Remotion 5.0 is planned to count contractors toward team size, but 5.0 is not released yet (npm latest is 4.0.528). The programmatic path is `bundle()` → `selectComposition()` → `renderMedia()`, and FFmpeg has been bundled since v4.0.

### Cited Findings
- Repo stats on 2026-09-25: 60,313 stars, 196 open issues, license `NOASSERTION` (custom). npm `remotion` and `@remotion/renderer` are at 4.0.528, published 2026-09-24, license "SEE LICENSE IN LICENSE.md". — [GitHub API](https://api.github.com/repos/remotion-dev/remotion), [npm](https://registry.npmjs.org/@remotion/renderer)
- Free License eligibility: "an individual; a for-profit organization with up to 3 employees; a non-profit or not-for-profit organization; evaluating whether Remotion is a good fit, and are not yet using it in a commercial way". Commercial use is allowed for eligible entities. It is not allowed to "copy or modify Remotion code for the purpose of selling, renting, licensing, relicensing, or sublicensing your own derivate of Remotion." — [Remotion LICENSE.md](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md)
- "You are required to obtain a Company License to use Remotion if you are not within the group of entities eligible for a Free License." — [Remotion LICENSE.md](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md)
- Pricing: **Remotion for Automators** costs "$0.01 per render, $100/mo minimum" and is aimed at "companies launching applications and systems; such as video editors, prompt-to-video apps". **Remotion for Creators** costs "$25/mo per seat". **Enterprise** is "Starting at $500 per month". — [remotion.pro/license](https://www.remotion.pro/license)
- The Remotion 5.0 license change (PR #3750, still open) says: "Contractors also count towards team size", and the company license will be bound to new terms and conditions. — [PR #3750](https://github.com/remotion-dev/remotion/pull/3750)
- HyperFrames' own comparison page describes Remotion as "free for individuals and companies up to three people, paid above that". — [HyperFrames vs Remotion](https://github.com/heygen-com/hyperframes/blob/main/docs/guides/hyperframes-vs-remotion.mdx)
- Renderer API: `selectComposition({serveUrl, id, inputProps})` followed by `renderMedia({composition, serveUrl, codec:'h264', outputLocation, inputProps})`. Options include `concurrency`, `onProgress`, `chromiumOptions`, `audioCodec`, `x264Preset`, `crf` and `ffmpegOverride`. It returns `{buffer, slowestFrames, contentType}`. `serveUrl` is a Webpack bundle path (from `bundle()` in `@remotion/bundler`) or a hosted URL. — [renderMedia docs](https://www.remotion.dev/docs/renderer/render-media)
- "Since Remotion v4.0, Remotion comes bundled with a lightweight version of FFmpeg." — [Remotion FFmpeg docs](https://www.remotion.dev/docs/ffmpeg)
- Authoring model: React components read `useCurrentFrame()` and use `interpolate()`, and they are registered through `<Composition>` with frames, fps and size. A bundler is required. — [HyperFrames vs Remotion](https://github.com/heygen-com/hyperframes/blob/main/docs/guides/hyperframes-vs-remotion.mdx)
- The HyperFrames maintainers themselves concede: "Remotion is older and much more established... Remotion Lambda in particular is a mature, heavily documented rendering system; ours is newer." — [HyperFrames vs Remotion](https://github.com/heygen-com/hyperframes/blob/main/docs/guides/hyperframes-vs-remotion.mdx)
- Captions: `@remotion/captions` provides `createTikTokStyleCaptions({captions, combineTokensWithinMilliseconds})`. It returns pages whose tokens carry `fromMs`/`toMs` for word-by-word highlighting, and rendering requires `white-space: pre`. — [Remotion captions docs](https://www.remotion.dev/docs/captions/create-tiktok-style-captions)

### Inferences
- A CLI distributed to users does not itself trigger Remotion licensing. However, any end user or company above 3 people (and contractors too, once 5.0 ships) would need its own Company License. That is a significant adoption barrier for a general-purpose open tool. HyperFrames avoids it.
- Remotion is the lower-risk choice for maturity and Lambda scale. HyperFrames is the lower-risk choice for licensing and for HTML-first agent authoring.

### Gaps
- I did not fetch the Remotion Lambda docs (`renderMediaOnLambda`, cost model) in this pass. Only its existence and maturity are confirmed, through the HyperFrames comparison page.
- The build configuration and license of Remotion's bundled FFmpeg (LGPL vs GPL) are not stated on the page I fetched.
- There is no release date for Remotion 5.0.

## Other candidates: Revideo, Motion Canvas, editly, FFmpeg-based templating

### Takeaway
Revideo is MIT and active (v0.11.0, July 2026), but it uses a TypeScript generator scene model rather than HTML. Motion Canvas is MIT, but its npm releases stalled in December 2024 and it is oriented toward editor-driven animation. editly is MIT and declarative, but effectively unmaintained (last npm release December 2022). None of them beats HyperFrames for an HTML/agent-first CLI. Plain FFmpeg (filtergraph or concat templating) remains the right tool for the assembly, captions and QA stages.

### Cited Findings
- **Revideo**: the repo moved to `midrender/revideo` and has 4,065 stars, 63 open issues, MIT license, last push 2026-07-15. npm `@revideo/core` and `@revideo/renderer` are at 0.11.0 (2026-07-10), MIT. Scenes are TypeScript generator functions (`makeScene2D`, `yield* waitFor()`). Headless `renderVideo()`, parallelized rendering, a React `<Player/>`, and Cloud Run deployment are supported. The README says it "borrows concepts from Remotion and Rive" and is "the engine behind Midrender". — [GitHub API](https://api.github.com/repositories/770297271), [README](https://github.com/midrender/revideo), [npm](https://registry.npmjs.org/@revideo/renderer)
- **Motion Canvas**: 19,171 stars, 174 open issues, MIT, last push 2026-07-02. npm `@motion-canvas/core` latest is 3.17.2, published 2024-12-14. — [GitHub API](https://api.github.com/repos/motion-canvas/motion-canvas), [npm](https://registry.npmjs.org/@motion-canvas/core)
- **editly**: 5,509 stars, 80 open issues, MIT, last push 2025-05-12. npm latest is 0.14.2, published 2022-12-23, and it has an `editly` bin. It describes itself as "Slick, declarative command line video editing & API". — [GitHub API](https://api.github.com/repos/mifi/editly), [npm](https://registry.npmjs.org/editly)

### Inferences
- Revideo is the only realistic MIT alternative, but compositions would be canvas and TypeScript scenes, not HTML/React. That makes existing web or React assets harder to reuse.
- editly's declarative JSON spec is a good design reference for an internal "edit decision list", but it is not a dependency to adopt.

### Gaps
- I did not assess Revideo's determinism guarantees or audio handling in depth.
- I did not evaluate FFmpeg-templating wrapper libraries such as fluent-ffmpeg. fluent-ffmpeg is widely reported as deprecated or archived, but I did not verify this in this pass.

## FFmpeg bundling from Node: licensing, system vs bundled, ffprobe, and recommended filters (libass, loudnorm, detection filters)

### Takeaway
`ffmpeg-static` ships **GPL-3.0-or-later** static binaries of FFmpeg 6.1.1, taken from johnvansickle (Linux), evermeet and osxexperts (macOS) and gyan.dev (Windows). `@ffmpeg-installer/ffmpeg` is labeled LGPL-2.1 but has not been updated since 2021. Bundling GPL binaries is acceptable for a CLI that calls FFmpeg as a separate process, as long as you comply with the binaries' license terms. Still, the cleanest approach is: **prefer the system `ffmpeg`/`ffprobe` on PATH (or a `FFMPEG_PATH` override), fall back to `ffmpeg-static`/`ffprobe-static`, and verify at startup that `--enable-libass` is present and the version is recent enough.** HyperFrames already requires system FFmpeg.

### Cited Findings
**Packages**
- `ffmpeg-static` 5.3.0 (published 2025-11-14) has license `GPL-3.0-or-later` and downloads binaries from the `b6.1.1` GitHub release, overridable with the `FFMPEG_BIN` and `FFMPEG_BINARIES_URL` env vars. Repo: 1,398 stars, 34 open issues. "The ffmpeg version currently used is `6.1.1`." "Use and distribution of the binary releases of `ffmpeg` are covered by their respective license." — [npm](https://registry.npmjs.org/ffmpeg-static), [README](https://github.com/eugeneware/ffmpeg-static)
- Binary sources for `ffmpeg-static`: Windows x64 from gyan.dev, Linux from johnvansickle.com, macOS x64 from evermeet.cx, macOS arm64 from osxexperts.net. — [README](https://github.com/eugeneware/ffmpeg-static)
- johnvansickle: "All static builds available here are licensed under the GNU General Public License version 3." The latest stable build there is 7.0.2. — [johnvansickle.com/ffmpeg](https://johnvansickle.com/ffmpeg/)
- The same monorepo publishes `ffprobe-static` 3.1.0 (npm license field "MIT", published 2022-06-17). That MIT label covers the wrapper, not the binary. — [npm](https://registry.npmjs.org/ffprobe-static)
- `@ffmpeg-installer/ffmpeg` 1.1.0 (license LGPL-2.1, last published 2021-07-15) and `@ffprobe-installer/ffprobe` 2.1.2 (LGPL-2.1, 2023-08-25) are stale. — [npm](https://registry.npmjs.org/@ffmpeg-installer/ffmpeg)
- FFmpeg's legal checklist for LGPL compliance says to compile "without '--enable-gpl' and without '--enable-nonfree'", use dynamic linking, and distribute the corresponding source. — [ffmpeg.org/legal](https://ffmpeg.org/legal.html)
- Remotion bundles its own FFmpeg (v4+). HyperFrames requires FFmpeg to be installed. — [Remotion](https://www.remotion.dev/docs/ffmpeg), [HyperFrames README](https://github.com/heygen-com/hyperframes)

**Filters (from the FFmpeg filters documentation)**
- `subtitles`: "Draw subtitles on top of input video using the libass library... you need to configure FFmpeg with --enable-libass." Options: `filename`, `original_size`, `fontsdir`, `force_style`, `charenc`, `stream_index`, `wrap_unicode` (needs libass >= 0.17.0). — [ffmpeg-filters](https://ffmpeg.org/ffmpeg-filters.html#subtitles-1)
- `ass`: "Same as the subtitles filter, except that it doesn't require libavcodec and libavformat... limited to ASS". It has a `shaping` option (`complex` "Required for correct rendering of complex scripts such as Arabic, Hebrew, Devanagari and Thai", which needs HarfBuzz). — [ffmpeg-filters](https://ffmpeg.org/ffmpeg-filters.html#ass)
- `loudnorm`: "EBU R128 loudness normalization... Support for both single pass... and double pass (files) modes." Options: `I` (range -70 to -5, default -24), `LRA` (default 7), `TP` (default -2). `measured_I/LRA/TP/thresh`, `offset` and `linear` enable the second pass. Linear mode reverts to dynamic if the conditions aren't met. In dynamic mode, audio is upsampled to 192 kHz, so set `-ar` explicitly. — [ffmpeg-filters](https://ffmpeg.org/ffmpeg-filters.html#loudnorm)
- `blackdetect`: options `d`/`black_min_duration` (default 2.0), `pic_th` (default 0.98) and `pix_th`. It logs start, end and duration, and sets `lavfi.black_start`/`lavfi.black_end` metadata. — [ffmpeg-filters](https://ffmpeg.org/ffmpeg-filters.html)
- `freezedetect`: options `n`/`noise` (default -60 dB or 0.001) and `d` (default 2 s). It sets `lavfi.freezedetect.freeze_start/duration/end`. — [ffmpeg-filters](https://ffmpeg.org/ffmpeg-filters.html#freezedetect)
- `silencedetect`: options `n` (default -60 dB), `d` (default 2 s) and `m` (per channel). It sets `lavfi.silence_start/end/duration`. Example: `silencedetect=n=-50dB:d=5`. — [ffmpeg-filters](https://ffmpeg.org/ffmpeg-filters.html#silencedetect)

### Inferences
Suggested commands. These are derived from the documented options above and have not been benchmarked.
- Two-pass loudnorm to -14 LUFS (streaming/social target):
  - Pass 1: `ffmpeg -i in.mp4 -af loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json -f null -`, then parse the JSON (`input_i`, `input_tp`, `input_lra`, `input_thresh`, `target_offset`).
  - Pass 2: `-af loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=..:measured_TP=..:measured_LRA=..:measured_thresh=..:offset=..:linear=true -ar 48000`.
- Burning in captions: `-vf "subtitles=captions.ass:fontsdir=./fonts"` or `-vf "ass=captions.ass:fontsdir=./fonts"`. Ship fonts with the project so the output doesn't depend on the host machine's fonts.
- A QA pass in one decode: `ffmpeg -i out.mp4 -vf "blackdetect=d=0.5:pix_th=0.10,freezedetect=n=-60dB:d=2" -af "silencedetect=n=-50dB:d=1.5" -f null -`. Parse stderr for `black_start`, `freeze_start` and `silence_start`. Use `ffprobe -v error -show_streams -show_format -of json` for duration, codec, fps and stream checks, plus `ebur128`/`loudnorm` measurement for loudness verification.
- Startup preflight: run `ffmpeg -hide_banner -buildconf` (or `-version`) and check for `--enable-libass` and `--enable-libx264`. Many minimal and LGPL builds lack libx264 (a GPL component) or libass.

### Gaps
- I did not verify that ffmpeg-static's b6.1.1 macOS arm64 (osxexperts) build includes libass. Checking this would require downloading and running the binary.
- There is no legal opinion here on GPL obligations when a CLI redistributes the GPL binary through npm. The general practice (exec a separate process, provide a license notice and a source link) is an inference, not a cited finding.

## Caption rendering: ASS vs SRT burn-in vs HTML-rendered captions; word-highlight (karaoke) approaches

### Takeaway
There are three workable paths:
- **ASS burned in with libass.** This gives native per-word karaoke through `\k`/`\kf` tags with centisecond timing, and it is deterministic and fast.
- **SRT burn-in.** This is simplest, but styling is limited to `force_style` and there is no per-word highlight.
- **HTML-rendered captions inside the composition** (HyperFrames caption components, or Remotion `@remotion/captions`). These give the richest "TikTok-style" animation and share the renderer's determinism, but they cost render time.

Recommended design: generate word timestamps once, emit both an ASS file (fast path or fallback) and HTML caption data (premium path), and keep a sidecar SRT/VTT for accessibility.

### Cited Findings
- ASS karaoke tags. `\k`: "Before highlight, the syllable is filled with the secondary color and alpha. When the syllable starts, the fill is instantly changed to use primary color". `\K`/`\kf`: the fill "changes from secondary to primary with a sweep from left to right". `\ko`: like `\k`, but the outline appears when the syllable starts. Durations are in centiseconds ("a duration of 100 is equivalent to 1 second"). Primary colour is `\1c`, secondary is `\2c`. — [Aegisub ASS tags](https://aegisub.org/docs/latest/ass_tags/)
- The FFmpeg `subtitles` filter converts other formats (such as SRT) to ASS and renders them with libass. `force_style` overrides style fields. `ass` reads ASS directly. — [ffmpeg-filters](https://ffmpeg.org/ffmpeg-filters.html#subtitles-1)
- HyperFrames' catalog includes HTML caption components (`caption-pill-karaoke`, `caption-highlight`, `caption-kinetic-slam`, `caption-emoji-pop` and others) and an `/embedded-captions` skill for talking-head footage. The `/media-use` skill covers "transcribe, caption". — [docs tree](https://github.com/heygen-com/hyperframes/tree/main/docs/catalog/components), [README](https://github.com/heygen-com/hyperframes)
- Remotion `@remotion/captions` `createTikTokStyleCaptions` returns pages of tokens with `fromMs`/`toMs` for word-level highlighting. — [Remotion docs](https://www.remotion.dev/docs/captions/create-tiktok-style-captions)

### Inferences
- ASS karaoke limits: it cannot do scale or pop per word natively without per-word `\t` transforms, and it needs a precise `PlayResX`/`PlayResY` matching the video (see the `original_size` caveat in the FFmpeg docs). It can do colour fill and sweep highlighting cheaply at encode time.
- HTML captions render in the same pass as the composition, so there is no second encode. When captions go on top of an already-encoded generated clip, the ASS burn-in adds one extra encode pass. Burning in during final assembly avoids re-encoding twice.
- A single canonical word-timing JSON (`{word, startMs, endMs}`) can drive all three outputs: HTML caption data, an ASS generator (`{\k<cs>}word`), and SRT/VTT sidecars.

### Gaps
- There are no measured render-time comparisons between HTML captions and libass burn-in.
- I did not research the choice of transcription or forced-alignment engine (whisper.cpp, WhisperX). That is outside this question's scope, but it is needed for word timings.

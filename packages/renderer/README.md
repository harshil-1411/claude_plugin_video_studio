# @video-studio/renderer

Renders deterministic (`motion_graphic`) scenes to silent H.264 clips, one clip per scene at the
exact scene duration. Voice, captions and assembly happen later in `@video-studio/media`.

Both renderers implement `SceneRenderer` (`src/types.ts`). `select.ts` picks one per scene:
HyperFrames first, FFmpeg as the fallback when `available()` reports `ok: false`.

## HyperFrames renderer (primary): `hyperframes-*.ts`

- Pinned to `@hyperframes/producer@0.8.75` exactly (pre-1.0; rerun the golden tests before any bump).
- `buildComposition(req)` (`hyperframes-compose.ts`) is a pure function. It returns a
  self-contained HTML document plus the asset files to copy. It covers typography, code (with a
  hand-rolled highlighter in `hyperframes-highlight.ts`), charts (stat, bar, line and pie as inline
  SVG), diagrams (layered boxes and arrows), comparison, cta, end_card and screenshot.
- Authoring contract: a root `[data-composition-id]` with `data-start`, `data-duration`,
  `data-width` and `data-height`, one `class="clip"` element with timing and track attributes, and
  a paused timeline on `window.__timelines[id]`.
- GSAP is not bundled by the producer, so motion uses CSS keyframes. The runtime's `css`
  adapter seeks these every frame. The registered timeline is a GSAP-shaped object that seeks
  the same animations. The page never reads the clock, never uses timers or randomness, and never
  touches the network.
- Scene props are escaped as HTML. Tokens become CSS variables after validation: hex colours
  only, and font names are sanitized. Fonts are `local()` only, which also stops the producer
  from fetching Google Fonts. Content stays inside the safe area; on 9:16 that means the top 10%
  and bottom 20% are kept clear.
- `createHyperframesRenderer({ chromePath?, probeTimeoutMs? })` writes the composition to a
  temp dir and calls `createRenderJob` / `executeRenderJob`. It then checks the output with
  ffprobe and removes the temp dir.
- Chrome comes from `chromePath`, then `CHROME_PATH`, then `HYPERFRAMES_BROWSER_PATH`, then the
  platform default: the macOS app bundle, or `google-chrome` / `chromium` on the Linux `PATH`.
  The producer is installed with `PUPPETEER_SKIP_DOWNLOAD=1`, so no Chromium is bundled.
- `available()` checks the producer package, Chrome and FFmpeg. It also runs a cached headless
  launch probe, so sandboxes that cannot start Chrome fall back to FFmpeg.

## FFmpeg renderer (fallback): `ffmpeg-renderer.ts`

Draws the same kinds with FFmpeg filters (`drawtext`, `drawbox`). It needs only the system
`ffmpeg`, using `tokens.ts` for fonts and `text-layout.ts` for layout estimates.

## Tests

```sh
npx vitest run packages/renderer/src/hyperframes       # unit tests (no Chrome needed)
npx vitest run packages/renderer/src/hyperframes -u    # after an intentional composition change
```

The real render test is skipped by default. Run it outside any sandbox, on a machine with Chrome
and FFmpeg installed:

```sh
VS_TEST_RENDER=1 npx vitest run packages/renderer/src/hyperframes
```

It renders a 180x320, 1 s clip and checks it with ffprobe.

Environment variables for debugging:

| Variable | Effect |
| --- | --- |
| `VS_KEEP_HYPERFRAMES_TMP=1` | Keeps the composition dir. |
| `VS_HYPERFRAMES_VERBOSE=1` | Prints producer logs to stderr. |

# Writing a `motion` page

A `motion` scene is a page you write as code: HTML, CSS and JS where every
frame is a pure function of time. It is how a scene reaches reference-grade
motion (full-frame kinetic type, one shape morphing through states, colour
flips, cuts on the bar) instead of one of the fixed kinds. Use it when the
brief's `acceptance` asks for about one big change per second, or when no
fixed kind can show the idea. Keep the fixed kinds for plain cards, code,
charts and footage overlays: they are cheaper to get right.

```json
{"id": "s01", "purpose": "hook", "duration_sec": 4, "voiceover": "",
 "visual_strategy": "motion_graphic",
 "deterministic": {"kind": "motion", "props": {
   "html": "motion/s01.html", "text": ["Docs in.", "Video out."],
   "effects": [], "loop": false}},
 "visual_requirements": {"continuity_refs": []}, "claim_refs": []}
```

- `html`: project-relative, e.g. `motion/s01.html` (`spec_scaffold` fills it).
- `text`: **every** word the viewer reads, in order. The page draws its
  copy from `window.__vs.text`, never from strings in the page, so
  grounding, `verify`, `localize` and word cues see it. Numbers in it need
  `claim_refs` like any other copy.
- `effects`: the banned-list effects the page uses (see below), honestly.
- `loop`: the scene's last frame must equal its first.

## The contract

- `window.seek(t)`: synchronous and pure. It draws the **whole** frame from
  `t` (scene-local seconds) alone, in any call order. Never keep state
  between calls ("if the line already entered...").
- `window.readyForCapture`: a Promise that resolves after fonts and images
  decode (`document.fonts.ready`, plus `img.decode()` for each image).
- Injected before your code, first thing in `<head>`:
  - `window.__vs`: `fps`, `duration`, `width`/`height` (your canvas),
    `target {width, height, aspect_ratio}`, `text[]`, `beats[]` and
    `downbeats[]` (scene-local seconds from the music bed; empty without
    one), `cues [{item, at}]` (word cues), `loop`, and `tokens`:
    `palette {background, text, primary, secondary}` (hex or null),
    `fonts {heading, body, mono}`, optional `weight_heading`,
    `weight_body`, `text_case`, `motion`, `style`, `language`.
  - `window.vs`, the motion kit (below).
  - A CSP: local scripts, styles, images, fonts and media only; no network.
- Files: put `s01.css`, `s01.js`, images and font files **in the page's
  folder** (or below it) and reference them relatively. Nothing outside it,
  nothing remote. Brand fonts in `tokens.fonts` are already loaded.
- Canvas: the page draws at the target size. If you lay it out for a fixed
  size, declare it with `<meta name="vs-canvas" content="1080x1920">`; it
  is scaled to fit, centred. Designing at 1080×1920 for 9:16 is simplest.

### The kit (`window.vs`)

| Helper | Use |
|---|---|
| `vs.spring(t, {from, to, stiffness?, damping?, mass?, delay?})` | closed-form spring released at `delay` (defaults 170 / 26 / 1) |
| `vs.springs(t, from, [{at, to}, ...], opts)` | a value whose target changes N times: the sum of N springs |
| `vs.tween(t, start, dur, from, to, ease?)`, `vs.progress(t, start, dur)` | timed moves (default ease `easeInOut`) |
| `vs.linear`, `easeIn`, `easeOut`, `easeInOut`, `easeOutQuint`, `easeInOutQuint` | easings on 0..1 (also `vs.ease.*`) |
| `vs.lerp(a, b, p)`, `vs.clamp(x, lo, hi)`, `vs.stagger(i, step, start?)` | arithmetic |
| `vs.rng(seed)` | seeded generator; the only allowed randomness |
| `vs.beatAt(t)`, `vs.downbeatAt(t)`, `vs.beatIndex(t)` | latest beat / bar start at or before `t` (null or -1 before the first) |

### What the lint rejects, and why

The page is untrusted code run in a browser without its sandbox, and the
renderer seeks frames in any order and in parallel. `spec_validate` (stage
`motion`) and the renderer refuse a page that has any of these:

- **Network**: `fetch`, XHR, WebSocket, EventSource, `sendBeacon`, dynamic
  `import()`, non-relative imports, remote `src`/`href`/`url()`/`@import`,
  `<iframe>`/`<object>`/`<embed>`/`<base>`, meta refresh, `window.open`.
- **Clocks and chance**: `Date.now`, `new Date()`, `performance.now`,
  `Math.random` (use `vs.rng(seed)`).
- **Self-running state**: `setTimeout`, `setInterval`,
  `requestAnimationFrame`, CSS `transition*`, `animation*`, `@keyframes`.
  They run on the browser clock, not on `seek(t)`, so frames differ between
  renders.
- `eval` and `new Function`; files outside the page's folder.
- No `window.seek` at all is a warning: every frame would look the same.

Before rendering, each page is also seeked out of order and the frames must
match (`nondeterministic_scene` fails the scene); with `loop`, the end must
equal the start (`loop_seam`).

## Craft rules

1. **Final state first.** Lay out the resting frame in CSS (positions,
   sizes, type), then write `seek` to tween *into* it. Text never ends up
   somewhere you did not place.
2. **Container before content.** Content enters after its container starts
   moving (~80–150 ms later) and leaves before the next change begins, so
   two lines never overlap and nothing appears on a still background.
3. **One shape, many states.** Where it fits, one shape morphs through
   states (pill → circle → frame fill) instead of cutting between cards.
   Every state change lands on a beat; big ones on a downbeat.
4. **Match cuts from measured positions.** When a scene ends on a shape
   the next scene starts from, copy its final size and position as numbers
   into the next page; don't eyeball it.
5. **Earn the change.** At least one deliberate hold (≥ 400 ms, the
   brief's `acceptance.hold_ms`) where nothing moves, usually right after
   the key line lands.
6. **About one big change per second** on social reels (a state change,
   a colour flip, a type swap, a cut): that is the reference bar, and
   `motion_density` measures it. Small drift doesn't count.
7. **One accent colour** from the brand (`palette.primary`) against
   background and text. A colour flip is a wipe or a shape growing to fill
   the frame; never fade black straight into the accent (it reads as mud
   mid-fade).
8. **One clean type family**, heavy weight, tight tracking
   (`letter-spacing: -0.02em` to `-0.04em`) for display lines, big
   (≥ 110 px at 1080 wide for full-frame words).
9. **Masked type reveals**: each line sits in an `overflow: hidden` box and
   slides up into it, rather than fading in place.
10. **Springs are closed-form.** A value that changes target several times
    is `vs.springs(t, start, [{at, to}, ...])`; never integrate frame by frame.
11. **Loops**: cyclic motion periods divide the loop length (a 6 s loop:
    periods of 1, 1.5, 2, 3 or 6 s), and the last frame equals the first.
12. **Browser traps**: no `will-change` on text the camera scales (it
    rasterises and blurs); never set `opacity` or `filter` on a
    `preserve-3d` element (it flattens the 3D): fade a wrapper instead.

## Banned effects

Styles list the effects that make motion look templated in
`motion.avoid`, from this closed set: `shake`, `rgb_split`, `lens_flare`,
`particle_burst`, `shockwave`, `neon_glow`, `grid_floor`, `flash`,
`bouncy_easing` (overshooting springs on type: damping far below
critical). Don't use them by default. Use one only when the user asked
for that look in words ("glitchy", "retro grid"): declare it in
`props.effects`, note it in `assumptions`, and pick a style that doesn't
avoid it. Lint `banned_effect` fails an effect the style avoids or that
`brand.visual.forbidden` names; the brand always wins. Lint only sees what
you declare, so the creative director also judges the stills.

## Worked example: a 4 s hook on `synth:pulse` (120 BPM)

Beats every 0.5 s, bars every 2 s. A pill springs in, line 1 reveals
inside its mask, the accent wipes up on beat 2, the pill becomes a circle
on the bar as line 1 leaves and line 2 lands, then a 500 ms hold, then the
circle fills the frame: the next scene opens on that colour (a match cut).
Five big changes in 4 s.

`motion/s01.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="vs-canvas" content="1080x1920">
<link rel="stylesheet" href="s01.css">
</head>
<body>
<div id="bg"></div><div id="flip"></div><div id="shape"></div>
<div class="mask" id="m0"><div class="line" id="l0"></div></div>
<div class="mask" id="m1"><div class="line" id="l1"></div></div>
<script src="s01.js"></script>
</body>
</html>
```

`motion/s01.css` (the resting layout; nothing animates here):

```css
#bg, #flip { position: absolute; left: 0; top: 0; width: 1080px; height: 1920px; }
#shape { position: absolute; }
.mask { position: absolute; left: 90px; right: 90px; top: 1180px; overflow: hidden; }
.line { font-size: 132px; font-weight: 800; line-height: 1.05; letter-spacing: -0.03em; }
```

`motion/s01.js`:

```js
(function () {
  var vs = window.vs, v = window.__vs, pal = v.tokens.palette;
  var $ = function (id) { return document.getElementById(id); };
  var ink = pal.background || "#0B0F19", paper = pal.text || "#F5F7FA", accent = pal.primary || "#4F8CFF";
  var copy = v.text.length ? v.text : ["", ""];
  $("bg").style.background = ink;
  $("flip").style.background = accent;
  $("shape").style.background = paper;
  ["l0", "l1"].forEach(function (id, i) {
    $(id).textContent = copy[i] || "";
    $(id).style.color = paper;
    $(id).style.fontFamily = v.tokens.fonts.heading || "sans-serif";
  });

  // Beat n of this scene: the measured grid when there is one, else 120 BPM.
  function beat(n) { return v.beats.length > n ? v.beats[n] : n * 0.5; }
  var FLIP = beat(2), BAR = beat(4), FILL = beat(6);
  var feel = { stiffness: 180, damping: 27 };   // critically damped: no bounce

  // Masked line: slides up into its box at `inAt`, out of the top at `outAt`.
  function line(t, id, inAt, outAt) {
    var y = vs.tween(t, inAt, 0.45, 110, 0, vs.easeOutQuint) + vs.tween(t, outAt, 0.3, 0, -110, vs.easeIn);
    $(id).style.transform = "translateY(" + y + "%)";
  }

  window.seek = function (t) {
    // One shape through three states: pill, circle on the bar, frame fill.
    var w = vs.springs(t, 0, [{ at: 0, to: 720 }, { at: BAR, to: 360 }, { at: FILL, to: 2400 }], feel);
    var h = vs.springs(t, 0, [{ at: 0, to: 180 }, { at: BAR, to: 360 }, { at: FILL, to: 2400 }], feel);
    var s = $("shape").style;
    s.width = w + "px"; s.height = h + "px";
    s.left = 540 - w / 2 + "px"; s.top = 820 - h / 2 + "px";
    s.borderRadius = Math.min(w, h) / 2 + "px";
    // Colour flip as a wipe, never a fade from black.
    $("flip").style.clipPath = "inset(" + vs.tween(t, FLIP, 0.35, 100, 0, vs.easeInOutQuint) + "% 0 0 0)";
    // Content after its container moves; out before the next change.
    line(t, "l0", 0.12, BAR - 0.3);
    line(t, "l1", BAR + 0.1, FILL - 0.2);   // holds from ~2.55 s to 3.0 s
  };

  window.readyForCapture = document.fonts ? document.fonts.ready : Promise.resolve();
})();
```

## The loop

1. Write the page and its files under `motion/`, and `props.text`.
2. `spec_validate {project_dir}`: fix every `motion` stage finding.
3. `stills {project_dir, at: "downbeats", scenes: ["s01"]}` (or `beats`
   for fast pieces; `times` for exact moments) and **view the sheet**:
   cramped or overlapping text, a state landing off its beat, an empty or
   half-way frame, unreadable contrast, anything on the banned list.
4. Fix the page and repeat 2–3 on the changed scenes only.
5. Render the preview; check `qa_run` (`motion_density`,
   `longest_static`, `frozen_frames`) and lint `acceptance_unmet` against
   `spec.acceptance`, and `compare` with the user's reference when there
   is one.

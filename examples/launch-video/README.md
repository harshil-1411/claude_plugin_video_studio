# Example: launch video ("Meeting notes in. Action list out.")

The worked example of `/video-studio:launch`: a 20-second, 9:16 launch reel for **Checkmint**, an
invented product (not a real brand) that turns meeting notes into an action list. The whole reel
is five `motion` pages rebuilt from the product's own site: its CSS colours, its web font and its
logo. The product's flow is the centrepiece: paste the notes, press **Tidy it**, get the list.
There is no voice. The words are the site's own UI copy, set over a synthesized score (`synth:pulse`,
120 BPM) with bundled sound effects.

| Scene | Time | Purpose | What moves (on the beat grid) | Sound |
| --- | --- | --- | --- | --- |
| s01 | 0–4 s | hook | Three scribbled note slips tumble in and jostle on beat 2. On the bar they snap into a checklist, then tick on beat 6. The headline changes from *Meeting notes in.* to *Action list out.* | `pop` 2.0, `hit-soft` 3.4 |
| s02 | 4–8 s | problem (entry) | The Checkmint card rises and the three messy notes are pasted in on beat 2, so the box takes focus. The card pushes in on the bar, and *Tidy it* arrives on beat 6. | `key-1` 1.0, `blip-up` 3.0 |
| s03 | 8–12 s | step (key action) | The cursor glides to *Tidy it* and clicks on beat 2: a ripple, and the button turns ink. A mint band reads down the notes and marks each owner (coral) and due date (underline) on beats 3–5. After a 600 ms hold, the notes slide out on beat 7. | `click` 1.0 |
| s04 | 12–16 s | result | The three actions slide in on beats 1–3, each with its owner and due day. On the bar the card pulls back and *3 actions · 3 owners* lands. The boxes tick on beats 4–6, and on beat 7 the last box grows into a full mint frame. | `pop` 2.0/2.5/3.0, `whoosh-soft` 3.8 |
| s05 | 16–20 s | cta | The shot opens on that mint frame (a match cut). The app icon springs in, then *Checkmint* rises on beat 1. *Tidy my notes* lands on the bar and *checkmint.example* on beat 5, followed by a long hold while the icon breathes with the kick. | `chime` 0.95 |

Every scene draws the same background layers: paper, two soft mint and coral blobs, and a dot
grid. They drift on the reel's clock (`T0 + t`), so the drift runs straight across the cuts. The
recurring motif is the checkbox: it appears in the hook, in the result and in the icon. The cuts
between s02, s03 and s04 are match cuts on the same card. s04 grows its last box from measured
coordinates, and s05 opens on the frame it fills.

## How it was made

The steps of `skills/launch/SKILL.md`, done by hand. Claude wrote some of the files and the
engine wrote the others:

| File | Written by |
| --- | --- |
| `input/site/` (`index.html`, `styles.css`, `fonts/`, `assets/logo-mark.png`) | Claude: the invented product site. The font is bundled Inter (OFL-1.1, `fonts/OFL.txt`), declared with `@font-face` as "Checkmint Sans". The logo is a PNG drawn with ffmpeg. |
| `project/project.json` | engine: `project_init` |
| `source/content-ir.json`, `source/provenance.json` | engine: `ingest` of `input/site/index.html` |
| `project/brand.yaml`, `fonts/CheckmintSans/`, `assets/brand/logo-mark.png` | engine: `brand_draft {source: input/site}`. The palette comes from the `--bg`/`--text`/`--primary`/`--secondary` custom properties, the font files are copied with their licence, and the logo is the image named logo. Saved as `brand.yaml` (the user's "yes") with one edit: `brand.name`, which the draft took from the folder name. |
| `project/creative-brief.yaml` | Claude, from the `product-flow.md` rubric: template `product-launch`, `goal: launch`, `tone_preset: playful`, a `product_flow` with an evidence ref for each step, and the motion quality bar in `acceptance`. Checked by `brief_validate`. |
| `project/video-spec.json` | `spec_scaffold` (template `product-launch`, 20 s, 9:16, `instagram` + `youtube-shorts`, `synth:pulse`, `voice_mode: none`), then Claude. Claude merged the template beats into hook → three flow steps → CTA, made every scene a `motion` scene, added `beat_sync` snapped to downbeats, the SFX, `cover {headline, bake_first_frame: true}` (no focal time) and `publish` copy for both targets. |
| `motion/` (`checkmint.js`, `checkmint.css`, `s01`–`s05`, `logo-mark.png`) | Claude, following `skills/plan/references/code-motion.md`. `checkmint.css` is the site's CSS rebuilt at 1080×1920. `checkmint.js` holds the shared builders (background, masked lines, card, notes, button, rows and checkbox). Each `sNN.js` defines `window.seek(t)`, and every word it draws comes from `window.__vs.text`. |

Checks, run against the committed `dist/mcp.mjs`:

- `spec_validate`: valid. The `motion` stage lints all five pages and reports 0 errors and 0 warnings.
- `lint` (spec only): 0 errors and 3 `reading_density` warnings, on s02–s04. Those scenes show
  the product's UI (notes, button and list), so their `props.text` holds more words than a 4 s
  text card should.
- Preview render in a sandbox (`--renderer ffmpeg`): the pipeline runs end to end. Frame 0 is
  the cover *Every to-do, owned*. Loudness is −13.8 LUFS, and A/V sync and flashing are fine. The
  provenance lists the synthesized bed and every bundled SFX as CC0-1.0. The motion checks fail on
  the ffmpeg text stand-in by design (see below).

Rendered media (`renders/`, `assets/voice/`, `dist/`, `qa/`, `review/`) is not committed.

## Render it

The motion pages only draw in HyperFrames (headless Chrome). Elsewhere, the ffmpeg renderer draws
a labelled text stand-in for each page and reports it. That checks the pipeline, not the motion,
so QA and lint fail `motion_density` and `frozen_frames` on the stand-in.

```sh
# Anywhere (sandboxes, no Chrome): pipeline check only.
node scripts/render-project.mjs examples/launch-video --voice silent --renderer ffmpeg --quality preview

# On a Mac with HyperFrames installed (/video-studio:doctor prints the command): the real reel.
node scripts/render-project.mjs examples/launch-video --voice silent --renderer hyperframes --quality final
```

Then, in Claude Code with the plugin loaded (`claude --plugin-dir .`):

1. `stills {project_dir: "examples/launch-video", at: "downbeats"}`: check that each state has
   settled and is readable on its bar, especially the notes box in s02–s03 and the rows in s04.
2. `/video-studio:review examples/launch-video` with `transitions: true`: check the match cuts
   s02→s03→s04 and the mint fill s04→s05, which should be seamless.
3. `qa_run` / `lint {quality: "final"}`: check against the acceptance bar (≤ 15 % frozen, ≥ 0.6 big
   changes/s, ≥ 60 % moving, a 400 ms hold).
4. `/video-studio:compare`: compare the final render against the preview, or against a launch reel
   whose pace you want to match.

## Re-plan

After editing `input/site/`, run `ingest` again with `replace: true` and `brand_draft` again, then
fix any refs that `spec_validate` reports. The pages read their copy by index from `props.text`
(each `sNN.js` lists its indices in the header comment). If the copy changes, keep the order. The
match-cut coordinates are numbers in `s03.js` (the button centre) and `s04.js` (the last box). If
`checkmint.css` moves the card, the button or the rows, update those numbers too.

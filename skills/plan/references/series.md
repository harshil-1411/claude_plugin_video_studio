# Series bible (`series.yaml`)

A series bible holds what several videos share: recurring characters,
locations and motifs, and the look. Each episode is its own project; its spec
points at the bible with `series`.

## When to create one

- Episodic content: a numbered series, a weekly explainer, a course.
- A recurring host, mascot or character that must look the same every time.
- A recurring motif (an opening sting, a toggle that flips in every episode).
- One consistent look across videos, without repeating it in every spec.

For a one-off video, skip it: use `style` and the brand instead.

## Where it lives

Next to the episode folders, so every episode can reach it:

```
my-series/
  series.yaml
  refs/host.png
  ep01-intro/project/video-spec.json    (series: ../series.yaml)
  ep02-vectors/project/video-spec.json  (series: ../series.yaml)
```

Reference files (`references`, a motif's `asset`) are relative to the series
file and must stay inside its folder: no `..`, no absolute paths, no symlinks
that point out. The engine reads the file as data only (YAML or JSON).

## Format

```yaml
schema_version: "1.0"
id: intro-series
name: Intro series
style: editorial            # style pack for episodes whose spec sets no style
palette:
  background: "#101820"
  primary: "#F26B3A"
characters:
  - id: host
    name: Ava
    description: Round glasses, teal jacket, calm and precise.
    wardrobe: Teal jacket over a white tee.
    voice_id: Samantha      # the TTS voice for her lines
    references: [refs/host.png]
locations:
  - id: lab
    description: A white lab with one tall window, morning light.
motifs:
  - id: toggle
    description: A toggle switch that flips on in every intro.
    asset: refs/toggle.svg
rules:
  - The intro always opens on the toggle motif.
```

Ids are unique across characters, locations and motifs. Get the full schema
with `schema_get name=series`.

## Episodes reference it

- The spec sets `series: ../series.yaml` (a relative path to a `.yaml`,
  `.yml` or `.json` file).
- Each scene lists the entries it shows in `series_refs`, e.g.
  `series_refs: [host, lab]`. Write each character's `description` into the
  scene's visuals so the look stays the same.
- Editing a character, location or motif (or its reference files)
  re-renders only the scenes that list it. A scene without `series_refs`
  never re-renders for bible edits.
- `spec_validate` checks the ids (and suggests the closest), that the
  reference files exist, and that the bible's style pack exists.
- `video.lock` and the provenance record the bible's hash and the hashes of
  the reference files the scenes used.

## Look precedence

Renderer defaults < series (`style`, then `palette`) < the spec's `style` <
brand. The brand is the user's identity and always wins. A spec without
`series` renders exactly as before.

## Voices

The video has one narrator voice (`voice.voice_id`). If a narrated scene
shows a character whose `voice_id` differs, validation notes it: set
`voice.voice_id` to the character's voice when that character narrates.

## Consent and rights

Character and voice consent rules still apply. A character based on a real
person, their face or their voice needs that person's consent. Never build a
character on a public figure without the rights to do so.

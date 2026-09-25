# Platform contracts

One file per publishing route: `platform-specs/<id>.yaml`, validated against
`schemas/platform-contract.schema.json` (zod source:
`packages/schema/src/platform-contract.ts`). The file name is the target id used in
`VideoSpec.targets` and `dist/<target>/`.

Rules:

- **Facts are data.** Platform limits, masks and cover specs live here, never as
  numbers in code or skill prose.
- **Every value has a source.** List first-party URLs in `sources`, set `verified`
  to the date you checked them, and bump `contract_version` on any change.
- **App vs. API.** Limits differ by route; `route` says which one the envelope
  describes. Separate routes get separate files (e.g. `facebook-page-api`).
- **UI masks** are normalized rects (0–1 from the top-left) measured on a frame of
  the mask's `aspect_ratio`. `severity: error` means captions and key text must
  not overlap it. Masks approximate the platform UI; they are not official safe
  zones.

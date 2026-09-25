# Contributing a platform pack (contract)

A platform pack is one publishing route's limits, stored as data: `platform-specs/<id>.yaml`.
It is validated by the `PlatformContract` schema (`packages/schema/src/platform-contract.ts`,
JSON Schema in `schemas/platform-contract.schema.json`). The file name is the target id used in
`VideoSpec.targets`, in `dist/<target>/` and in lint findings. `platform-specs/README.md` has
the short rules.

## Facts are data

Platform limits, safe-zone masks and cover specs live only in these files. Never write them as
numbers in code, in skills or in docs. Lint, the zone planner (`packages/platforms`), the cover
compiler and `export` all read them.

## Contents

- `id`, `name` and `contract_version`. Bump `contract_version` whenever any value changes:
  `video.lock` records it for each target.
- `verified`: the date you checked the values against the sources.
- `sources[]`: first-party URLs, each with a note on what it supports. When a value comes from
  somewhere weaker, say so in `notes`. For example, TikTok's values could not be re-verified
  when its developer site was down, and its notes say so.
- `platform`: the `VideoSpec.platform` this contract is the primary target for. `route` is
  `app_upload` or `api`. Different routes get different files, because their limits differ
  (for example `facebook-page-api`).
- `video`:
  - aspect ratios, preferred first
  - `recommended`, `min` and `max_long_side` sizes
  - `duration_sec` and `fps` ranges
  - maximum size and bitrate
  - containers, video and audio codecs
  - `export` re-encodes a target only when the render falls outside this envelope.
- `cover`: `mode` (`file`, `frame`, `file_or_frame` or `none`), formats, size and `crops`
  (other shapes the platform cuts the cover to; the headline must survive every crop).
- `captions`: post caption, hashtag and mention limits, the `sidecar_formats` the route
  accepts, and `burn_in_recommended`.
- `ai_disclosure`: whether the route has an AI-content flag, and its API field.
- `ui_masks[]`: rectangles where the app draws its UI, normalized from 0 to 1 from the top
  left of a frame with the mask's `aspect_ratio`. With `severity: error`, captions and key text
  must not overlap the mask. The layout zones shrink away from it and lint fails on it. With
  `warning`, it is only something to avoid.

## Masks

Masks approximate each app's UI, measured on screenshots. They are not official safe zones,
and every contract's `notes` must say so. Measure them on a 9:16 frame first, and add masks for
other aspect ratios only if you measured them. With an empty `ui_masks`, lint warns that the
masks are unknown.

## Checklist

1. Copy a similar contract, fill every value from a first-party source, and set `verified`.
2. Run `npx vitest run packages/platforms` and `npx vitest run packages/mcp/src/lint.test.ts`.
   The zone tests check that masks leave a usable caption region. The lint golden fixture
   (`packages/mcp/src/__fixtures__/lint/tiktok-low-captions`) must still fail for the right
   reason.
3. If the platform should be a primary target, update `PRIMARY_TARGET` in
   `packages/schema/src/common.ts` and run `pnpm schemas`.
4. Render a preview with the new target and inspect `dist/<id>/`: `video.mp4`, `post.json`
   limits and `qa.json`.

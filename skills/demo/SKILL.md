---
name: demo
description: Record a product demo of the user's own running app (a URL they started, e.g. http://localhost:3000) with a scripted browser walk - clicks, typing, scrolling, zooms - with inputs blurred, then use the recording in screen_capture scenes. Use when the user runs /video-studio:demo, or wants a product-demo or product-ui reel that shows their real app.
license: Apache-2.0
compatibility: Requires the video-studio plugin's bundled `engine` MCP server (Node.js 22.13+), Google Chrome, and the optional HyperFrames install (it provides puppeteer-core).
allowed-tools: mcp__plugin_video-studio_engine__demo mcp__plugin_video-studio_engine__schema_get mcp__plugin_video-studio_engine__doctor Read Write
---

# Record a demo of the user's app

The plugin never starts an app. The user starts it and gives you the URL.

1. Ask for the URL of the running app (and which flow to show) if the user
   did not say. Never guess a URL; never record a site the user did not name.
2. Write `project/demo.json` (`schema_get demo-script`): `id`, `url`,
   `viewport` (1080×1920 for a vertical reel: the page lays out at phone width,
   390 CSS px, and records at full resolution; 1920×1080 for a desktop layout; set
   `device_scale_factor` only to override), and
   `steps` using stable selectors (ids, `data-testid`, roles). Keep it short:
   one flow, 5–15 steps, `max_duration_sec` ≤ 60. Add `mask_selectors` for
   anything sensitive on screen (API keys, emails, account names); inputs are
   always blurred. Use dummy data for anything typed.
3. Show the user the URL, the steps and the masked selectors. Then call
   `demo {project_dir}`: when the client supports approval dialogs, the
   engine shows the user the URL and steps itself and records their answer
   in `project/consent.json` (an unchanged script is not asked again). A
   `REFUSED` result with `asked_user: true` means they declined: stop. With
   `consent_required: true` (no dialog available), ask the user to confirm in
   chat and only after a clear yes call `demo {project_dir, confirm: true}`.
   Never pass `confirm: true` without that yes, and never record a URL that
   is not the user's own running app.
4. If it fails: a missing selector → fix the step; no puppeteer-core → the
   HyperFrames install from `doctor`; no Chrome → install Google Chrome.
5. Report the recording and its step timestamps. In the plan, use
   `screen_capture` scenes with `footage: {asset: "demo-<id>", in_sec,
   out_sec}` spanning the steps they show, and cite those steps' refs
   (`video:demo-<id>.mp4#step-N`) in `claim_refs`. Scenes may only show what
   was recorded ("actual UI only"): never describe screens that are not in
   the recording.

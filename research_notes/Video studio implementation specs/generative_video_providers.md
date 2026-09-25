# Generative Video Provider APIs: Runway, Kling, Sora Status, and Others (as of 2026-09-25)

Research method note: Runway docs (docs.dev.runwayml.com) could be fetched and summarized. Kling's official docs (kling.ai/document-api/...) are rendered client-side, so fetches returned only the page shell. Kling specifics therefore come from search snippets and the Vercel AI SDK Kling provider docs; the gaps are marked. Every WebFetch result is a model summary of the page, not raw text. Check exact field names against the live API reference/OpenAPI before coding.

## Runway API: implementation spec

### Takeaway
Runway Dev is a single REST API (`https://api.dev.runwayml.com/v1`, Bearer key, `X-Runway-Version: 2024-11-06`). It now hosts many third-party video models (Veo 3.1, Seedance 2, Hailuo 3, Wan 3, Grok Imagine...) next to Runway's own gen4.5, gen4_turbo and aleph2. Credits cost $0.01 each. The "Model Router" is real and documented: config IDs, cost/latency/quality preferences, per-modality credit caps, `dryRun: true` that returns an estimated cost, and a realized cost in responses.

### Cited Findings
**Basics**
- Base URL `https://api.dev.runwayml.com/v1`. Auth header `Authorization: Bearer $RUNWAYML_API_SECRET`. Version header `X-Runway-Version: 2024-11-06`. Env var `RUNWAYML_API_SECRET`. Source: [Runway: Using the API](https://docs.dev.runwayml.com/guides/using-the-api/)
- Official Node SDK: `@runwayml/sdk` (`npm install --save @runwayml/sdk`). The pattern `await client.imageToVideo.create({...}).waitForTaskOutput()` creates a task and polls it until it finishes. Source: [Runway: Using the API](https://docs.dev.runwayml.com/guides/using-the-api/)
- Text-to-video uses `gen4.5` without `promptImage`; image-to-video uses `gen4.5` with `promptImage`. Source: [Runway: Using the API](https://docs.dev.runwayml.com/guides/using-the-api/)
- API reference sections: Start generating (Image to video, Text to video, Video to video, Text/Image to image...), Task management (Get task detail, Cancel or delete a task), Uploads, Avatars, Avatar Videos, Knowledge, Realtime Sessions, Model Router, Organization, Recipes, Voices, Workflows. Source: [Runway API reference](https://docs.dev.runwayml.com/api/)
- Endpoint paths from prior knowledge, NOT re-verified in this session: `POST /v1/image_to_video`, `POST /v1/text_to_video`, `POST /v1/video_to_video`, `GET /v1/tasks/{id}`, `DELETE /v1/tasks/{id}` (cancel/delete), `GET /v1/organization` (tier/credit balance), plus uploads. Confirm against [the API reference](https://docs.dev.runwayml.com/api/).

**gen4.5 image-to-video parameters** (third-party docs mirroring Runway, not the official page)
- Request fields: `promptImage` (HTTPS URL, data URI or `runway://` URI), `promptText`, `ratio`, `duration`. Duration is 2–10 s (default 10). Ratios: `1280:720`, `720:1280`, `1104:832`, `832:1104`, `960:960`, `1584:672`. Example: `{"model":"gen4.5","promptImage":"https://…","promptText":"A slow dolly-in shot","ratio":"1280:720","duration":5}`. Sources: [Runware Gen-4.5 docs](https://runware.ai/docs/models/runway-gen-4-5/guides/directing-motion); [rw-api-reference skill (runwayml)](https://mcpservers.org/agent-skills/runwayml/rw-api-reference)

**Current models** (official catalog). Source: [Runway: Models](https://docs.dev.runwayml.com/guides/models/)
| Model | Input |
|---|---|
| `gen4.5` | Text or image |
| `gen4_turbo` | Image only |
| `aleph2` | Video plus text/image (video-to-video) |
| `act_two` | Image or video |
| `veo3.1`, `veo3.1_fast` | Text or image |
| `seedance2_5`, `seedance2`, `seedance2_fast`, `seedance2_mini` | Text, image or video |
| `hailuo3` | Text, image or video |
| `h3_max` | Text or image |
| `wan3` | Text or image |
| `grok_imagine_1_5` | Text or image |
| `happyhorse_1_0` | Text or image |
| `gemini_omni_flash` | Text, image or video |

The catalog also lists image models (`gen4_image`, `gen4_image_turbo`, `gpt_image_2`, `gemini_image3_pro`, `seedream5_*`...), audio models (`eleven_v3`, `seed_audio`...), video upscale/frame-rate/HDR tools and `gwm1_avatars` (realtime). ProRes, PNG sequence, HDR and 10-bit output carry per-second surcharges on Gen-4.5 and Aleph 2.0. Source: [Runway: Models](https://docs.dev.runwayml.com/guides/models/)

**Pricing**
- $0.01 per credit. Source: [Runway: Pricing](https://docs.dev.runwayml.com/guides/pricing/)
- Credits per second, from the same pricing page:

| Model | Credits/s | USD/s |
|---|---|---|
| gen4.5 | 12 | $0.12 |
| gen4_turbo | 5 | $0.05 |
| veo3.1 with audio | 40 | $0.40 |
| veo3.1 without audio | 20 | $0.20 |
| veo3.1_fast with audio | 15 | $0.15 |
| veo3.1_fast without audio | 10 | $0.10 |
| aleph2 | 28 (56-credit minimum) | $0.28 |
| seedance2 480p–720p | 36 | $0.36 |
| seedance2 1080p | 40 | $0.40 |
| seedance2 4K | 150 | $1.50 |
| act_two | 5 | $0.05 |

**Task lifecycle**
- Statuses: `PENDING`, `THROTTLED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLED`. Do not expect a given task to update more often than every 5 s. Source: search snippet attributed to Runway docs/ComfyUI mirror via [search result for Runway task statuses](https://docs.comfy.org/development/comfy-router/models/runway/aleph2/code). Not confirmed on an official page this session.
- A successful task returns an `output` array of URLs, which "will expire within 24-48 hours". Download them to your own storage and "do not expose them directly in your product". Source: [Runway: API Output Formats](https://docs.dev.runwayml.com/assets/outputs/)
- Discrepancy: a "stored 14 days / expireFlag" claim came from useapi.net, an unofficial reverse-engineered API for the web app. It does not apply to the official API.

**Model Router: claim verified**
- Launched July 23, 2026, according to third-party coverage. Source: [digitalapplied.com](https://www.digitalapplied.com/blog/runway-media-router-generative-media-model-routing) (search snippet)
- A config is a named, reusable set of routing preferences with an immutable `configId` (e.g. `preview-fast`).
  - Preferences: Cost (cheapest eligible model), Latency (fastest), Quality (highest quality).
  - Per-modality credit caps (video/image/audio) act as a "hard ceiling that no model may exceed".
  - Eligibility is either an allow list (new models are never added automatically) or a deny list (new models are included automatically).
  - Configs can be managed in the portal or through the Model Router API/SDKs. Edits apply only to later requests.
  - Source: [Runway: Configuring a Model Router](https://docs.dev.runwayml.com/model-routers/configuration/)
- Generating through the router:
  - Endpoints: `POST /v1/generate/video`, `/v1/generate/image`, `/v1/generate/audio`, with body `{"configId": "...", "input": {...}}` and no model field.
  - The response carries the selected `model`, the `configId`, the optimization preference used, and the realized cost in credits. You are billed at the selected model's standard rate.
  - `"dryRun": true` tests routing without generating or spending credits and returns the same metadata plus an estimated cost.
  - If no model satisfies the config plus the request, the error names the constraints that eliminated the candidates.
  - Source: [Runway: Generating through a Model Router](https://docs.dev.runwayml.com/model-routers/generating)
  - The field spellings for estimated/realized cost (e.g. `estimatedCost` vs `estimatedCredits`) were not captured verbatim. Check the API reference.

### Inferences
- A single Runway adapter covers Runway's own models plus Veo 3.1, Seedance, Hailuo and Wan through one auth scheme and one task model. It overlaps heavily with what an aggregator adapter would give you.
- `estimate()` can be computed locally (credits/s × duration × $0.01, respecting aleph2's minimum) or taken from the router's `dryRun`.
- `download()` must run as soon as the task reaches SUCCEEDED because URLs expire in 24–48 h. Poll at ≥5 s with backoff, and treat THROTTLED as a queued, non-terminal state.
- `cancel()` maps to the Cancel/Delete task endpoint.

### Gaps
- Usage tiers, concurrency and daily limits: the [usage tiers page](https://docs.dev.runwayml.com/usage/tiers/) was not fetched.
- Exact allowed durations and ratios for gen4_turbo, veo3.1, aleph2 and the third-party models were not captured.
- Official confirmation of the status enum and exact endpoint paths is pending (they are standard in the SDK, but were not re-read here).

## runwayml/skills GitHub repo

### Takeaway
An MIT-licensed set of coding-agent skills (Claude Code, Cursor, Codex plugins) for calling the Runway API. It is useful as reference integration code, not as a runtime library.

### Cited Findings
- Structure:
  - `.claude-plugin/` and `.cursor-plugin/` (plugin configs)
  - `skills/` (skill modules)
  - `scripts/`
  - `assets/`
  - `CHANGELOG.md`, `LICENSE`, `README.md`
- License: MIT.
- Covers video generation (t2v, i2v, v2v), image generation with references, audio (TTS, SFX, voice), and integration via MCP and the Node/Python SDKs.
- Source for all of the above: [github.com/runwayml/skills](https://github.com/runwayml/skills)
- One skill is `rw-api-reference`. Source: [mcpservers.org listing](https://mcpservers.org/agent-skills/runwayml/rw-api-reference)
- The README summary did not mention the model router, cost estimation or dry-run. Source: [github.com/runwayml/skills](https://github.com/runwayml/skills)

### Inferences
- Because it is MIT-licensed, its API-reference skill content could be vendored or adapted with attribution.

### Gaps
- The individual skill files and the latest CHANGELOG entries were not enumerated.

## Kling API: implementation spec

### Takeaway
Kling's official API is at `https://api-singapore.klingai.com` for servers outside China. The older `api.klingai.com` host was moved to it. Auth is either a newer API key or the legacy AccessKey/SecretKey pair signed into an HS256 JWT (30-min expiry), sent as a Bearer token. Models range up to Kling 3.0. Billing uses prepaid resource packs, separate from web subscriptions.

### Cited Findings
**Endpoint and auth**
- "The API endpoint has been changed from https://api.klingai.com to https://api-singapore.klingai.com. This API is suitable for users whose servers are located outside of China." Source: [Kling API docs: Authentication](https://kling.ai/document-api/apiReference/commonInfo) (search snippet)
- The old `app.klingai.com/global/dev/...` doc URLs 301-redirect to `kling.ai/document-api/...`. Observed directly this session.
- Two auth schemes: an API Key (created in the console, shown once) or Access Key / Secret Key ("legacy version"). The AK/SK flow produces a JWT passed as Bearer; tokens expire after 30 min. Source: [Kling API docs: Authentication](https://kling.ai/document-api/apiReference/commonInfo) (search snippet)
- The Vercel AI SDK Kling provider uses the default base URL `https://api-singapore.klingai.com`, env vars `KLINGAI_API_KEY` (recommended) or `KLINGAI_ACCESS_KEY` + `KLINGAI_SECRET_KEY` (legacy), polls every 5000 ms by default, and times out after 600000 ms. Source: [AI SDK: Kling AI provider](https://ai-sdk.dev/providers/ai-sdk-providers/klingai)

**Models** (AI SDK IDs; these map onto Kling `model_name` values such as `kling-v2-6`, `kling-v2-master`)
- T2V: `kling-v3.0-t2v`, `kling-v2.6-t2v`, `kling-v2.5-turbo-t2v`, `kling-v2.1-master-t2v`, `kling-v2-master-t2v`, `kling-v1.6-t2v`, `kling-v1-t2v`.
- I2V: the same versions plus `kling-v2.1-i2v` and `kling-v1.5-i2v`.
- Motion control: `kling-v3.0-motion-control`, `kling-v2.6-motion-control`.
- Source: [AI SDK: Kling AI provider](https://ai-sdk.dev/providers/ai-sdk-providers/klingai)

**Parameters**
- `mode`: `std` or `pro`
- `duration`: "3–15s typical"
- `aspect_ratio`, e.g. `16:9`
- `sound`: `on`/`off`, v2.6+ with `pro` only
- `negative_prompt`: max 2500 chars
- `cfg_scale`: 0–1
- `multi_shot`: storyboard with per-shot prompts
- `callback_url`: async notification
- Source: [AI SDK: Kling AI provider](https://ai-sdk.dev/providers/ai-sdk-providers/klingai)

**Pricing**
- Billed through prepaid resource units/packages with no subscription. Web plans ($10–$180/month) include no API access, and API credits cannot be used in the web UI. Source: [Atlas Cloud: Kling API pricing](https://www.atlascloud.ai/blog/tips/kling-ai-api-pricing) (third party)
- Official pricing pages: [kling.ai/dev/pricing](https://kling.ai/dev/pricing) and [Kling docs: video pricing](https://kling.ai/document-api/pricing/base/video). Both are JS-rendered and could not be read.
- Third-party estimate of the official range: about $0.084–$0.168 per second, or $0.08–$0.42/s across std/pro/4K. Sources: [costbench](https://costbench.com/software/ai-media-apis/kling-api/); [search summary](https://renderful.ai/blog/kling-api-pricing). UNVERIFIED against the official page.

**Result retention**
- The "30 days" claim is UNVERIFIED; no official source was found. One search summary said generated video links are valid for only 24 h, but that could not be tied to an official page. Treat the retention period as unknown and download immediately.

### Inferences
- Endpoint and field details from prior knowledge, NOT re-verified this session:
  - Endpoints: `POST /v1/videos/text2video`, `POST /v1/videos/image2video`, `GET /v1/videos/{text2video|image2video}/{task_id}`.
  - Task status values: `submitted`, `processing`, `succeed`, `failed`.
  - The response wraps `{code, message, request_id, data:{task_id, task_status, task_result:{videos:[{url, duration}]}}}`.
  - JWT claims: `iss`=AccessKey, `exp`=now+1800, `nbf`=now−5, header `{alg:"HS256", typ:"JWT"}`.
  - Before implementing, verify all of this in the Kling console docs with a logged-in browser, or in the community Node wrapper [aself101/kling-api](https://github.com/aself101/kling-api).
- No cancel endpoint is known for Kling. The adapter's `cancel()` will probably be unsupported: stop polling locally and mark the job abandoned.

### Gaps
- Official Kling 3.0 duration set (5/10 vs 3–15), multi-shot schema, audio pricing, official per-unit price table, retention period, callback payload and signature, and the China base URL (`api-beijing.klingai.com`?). None could be read from the JS-rendered official docs.

## Aggregators (fal.ai, Replicate) as a single integration

### Takeaway
fal.ai exposes Kling, Veo, Hailuo, Luma and others through one queue API and one key, with per-second pricing per model. It is a practical fallback adapter. Runway's API now hosts many of the same third-party models too.

### Cited Findings
- fal `fal-ai/veo3.1/fast` costs $0.10/s without audio or $0.15/s with audio at 720p/1080p, and $0.30/$0.35 at 4K; a 5 s 1080p clip with audio is $0.75. Source: [fal.ai Veo 3.1 Fast](https://fal.ai/models/fal-ai/veo3.1/fast)
- Kling Video v3 on fal, from third-party summaries: $0.224/s audio off and $0.28/s audio on (one source), or $0.112/s off and $0.168/s on, $0.196/s with voice control (another). The two sources conflict, probably because of std vs pro tiers. Source: [ofox.ai fal alternatives](https://ofox.ai/blog/fal-ai-alternatives-video-generation-api-2026/). UNVERIFIED on fal's own page.
- fal hosts MiniMax Hailuo 02 (e.g. `fal-ai/minimax/hailuo-02/standard/image-to-video`), at about $0.49/video in one summary. Source: [fal Hailuo 02](https://fal.ai/models/fal-ai/minimax/hailuo-02/standard/image-to-video)
- Critique: fal's headline rate often buys a lower tier. Source: [ofox.ai](https://ofox.ai/blog/fal-ai-alternatives-video-generation-api-2026/) (opinion from a competitor)

### Inferences
- An adapter built on fal's queue API (submit → status → result) could cover Kling, Veo, Hailuo, Luma, Wan and Seedance with one integration. The trade-off is a price markup on some models and a lag before new features appear.

### Gaps
- Replicate pricing examples were not collected this session.

## Sora API status

### Takeaway
Confirmed from OpenAI primary sources. OpenAI announced the deprecation on March 24, 2026, and removed the Videos API and all Sora 2 models from the API on September 24, 2026, the day before this note. It named no replacement. The Sora app and web experience ended earlier, on April 26, 2026.

### Cited Findings
- "On March 24th, 2026, we notified developers using the Videos API and Sora 2 video generation model aliases and snapshots of their deprecation and removal from the API on September 24, 2026." Affected: Videos API, `sora-2`, `sora-2-pro`, `sora-2-2025-10-06`, `sora-2-2025-12-08`, `sora-2-pro-2025-10-06`. No replacement listed. Source: [OpenAI API Deprecations](https://developers.openai.com/api/docs/deprecations)
- The Sora web/app was discontinued April 26, 2026, and the API shut down September 24, 2026. Source: [OpenAI Help Center: What to know about the Sora discontinuation](https://help.openai.com/en/articles/20001152-what-to-know-about-the-sora-discontinuation) (the page returned 403 to a direct fetch; dates come from the search snippet, and they agree with the deprecations page for the API date)

### Inferences
- Do not build a Sora adapter. Any existing Sora integration is non-functional as of 2026-09-25.

### Gaps
- The article text was not read directly because of the 403.

## Other providers (brief)

### Takeaway
Google Veo 3.1 is directly available through the Gemini API and Vertex AI as long-running operations. Luma, Pika and MiniMax each have APIs, but all of them are also reachable through fal.ai, and Veo, Hailuo and others through Runway.

### Cited Findings
**Google Veo**
- Gemini API: `models/veo-3.1-generate-preview:predictLongRunning`. Produces 8 s videos at 720p/1080p/4K with native audio. Source: [Gemini API: Veo](https://ai.google.dev/gemini-api/docs/veo)
- Veo 3.1 Lite exists as a lower-cost tier. Source: [Google blog: Veo 3.1 Lite](https://blog.google/innovation-and-ai/technology/ai/veo-3-1-lite/)
- Pricing from third-party summaries: Standard about $0.40/s and Fast about $0.15/s, Lite from about $0.03/s, 4K at a premium. Source: [costgoat](https://costgoat.com/pricing/google-veo). Check the official [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing).

**Luma**
- API pricing is roughly $0.08/s for Ray-2. There is also a Luma Agents API (Ray3.2) priced per second, scaling with resolution and HDR. Sources: [apiframe Luma guide](https://apiframe.ai/guides/luma-api-guide); [eesel](https://www.eesel.ai/blog/luma-ai-pricing). Third-party figures.

**Pika**
- Runs its own API aggregator, "Pika API Club / dev.pika.art": 100+ models through one API with a membership fee (e.g. $10/month). Sources: [Pika API Club blog](https://experiment.pika.art/blog/pika-api-club); [dev.pika.art](https://dev.pika.art/)

**MiniMax Hailuo**
- Hailuo 2.3 announced; H3 released July 29, 2026 (listed on OpenRouter). Sources: [MiniMax news](https://www.minimax.io/news/minimax-hailuo-23); [OpenRouter H3](https://openrouter.ai/minimax/hailuo-3)
- Also available on fal and on Runway (`hailuo3`, `h3_max`). Source: [Runway models](https://docs.dev.runwayml.com/guides/models/)

### Inferences
- Suggested adapter priority: Runway (native, broad catalog, router with dry-run cost), then fal.ai (widest catalog: Kling, Luma, Hailuo, Veo), then direct Kling or Gemini-Veo only where native features or lower prices justify the extra integration.

### Gaps
- Official direct pricing and endpoints for Luma, Pika and MiniMax were not verified.

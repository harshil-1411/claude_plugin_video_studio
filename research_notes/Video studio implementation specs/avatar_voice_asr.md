# Avatar/Presenter Video, TTS, and Local ASR for a Node/TypeScript Video CLI

Research date: 2026-09-25. Versions below were read from the npm registry and GitHub API on that date unless noted otherwise.

## HeyGen API: current version, endpoints, consent, webhooks, idempotency, limits, pricing, and heygen-com/skills

### Takeaway
Build on **HeyGen API v3**. v1 and v2 are supported only until **October 31, 2026**, and the legacy endpoints are retired from November 1, 2026. A single endpoint, `POST /v3/videos`, takes a discriminated union (`type: avatar | image | cinematic_avatar | studio`). Its speech input is either `script` plus `voice_id`, or supplied audio (`audio_url` / `audio_asset_id`). It supports an `Idempotency-Key` header (24h replay), `callback_url` / `callback_id`, and HMAC-signed webhooks. Results come back as presigned URLs, and the docs give no expiry time for them. API billing is pay-as-you-go and separate from web plans. Treat the per-second prices as secondary-sourced until you check them against the official pricing page.

### Cited Findings
**Versioning / migration**
- v1/v2 are "Supported until October 31, 2026". v3 is recommended, and legacy endpoints retire after Nov 1, 2026. Legacy responses carry a `warning` object that names the v3 counterpart, so you can log it to build a migration inventory. — [HeyGen Endpoint Version Comparison](https://developers.heygen.com/endpoint-version-comparison.md); [Quick Start](https://developers.heygen.com/docs/quick-start)
- Mapping: `POST /v2/video/generate`→`POST /v3/videos`; `GET /v1/video_status.get`→`GET /v3/videos/{video_id}`; `GET /v2/avatars`→`GET /v3/avatars`; `GET /v2/voices`→`GET /v3/voices`; `POST /v1/audio/text_to_speech`→`POST /v3/voices/speech`; `POST /v2/template/{id}/generate`→`POST /v3/templates/{id}`; `POST /v2/video_translate`→`POST /v3/video-translations`; `POST /v1/video_agent/generate`→`POST /v3/video-agents`. — [Endpoint Version Comparison](https://developers.heygen.com/endpoint-version-comparison.md)
- v3 adds cursor pagination on every list endpoint and a single asset-input shape (`url` | `asset_id` | `base64`). Webhooks are signed and support secret rotation. When `voice_id` is omitted, the avatar's default voice is used. — [Endpoint Version Comparison](https://developers.heygen.com/endpoint-version-comparison.md)
- The old docs host `docs.heygen.com` now 301-redirects to `developers.heygen.com`. — observed via fetch of [docs.heygen.com](https://docs.heygen.com/)

**Auth / base**
- Base URL is `https://api.heygen.com`. Authenticate with the `X-Api-Key` header (OAuth `Authorization: Bearer` is also accepted). Keys are issued at app.heygen.com/developers/api. — [Quick Start](https://developers.heygen.com/docs/quick-start); [Create Video ref](https://developers.heygen.com/reference/create-video)

**Create video: `POST /v3/videos`**
- `type: "avatar"` requires `avatar_id`, which is a look ID for a video or photo avatar. The audio source must be exactly one of: `script`+`voice_id`, `audio_url`, or `audio_asset_id`. — [Create Video ref](https://developers.heygen.com/reference/create-video)
- Optional fields:
  - `title`, `folder_id`
  - `resolution`: `4k` | `1080p` | `720p`
  - `aspect_ratio`: `16:9` (default) | `9:16` | `4:5` | `5:4` | `1:1` | `auto`
  - `fit`: `contain` | `cover`
  - `background`: color hex, or image by url/asset_id
  - `remove_background`
  - `output_format`: `mp4` (default) | `webm`
  - `voice_settings`: speed 0.5–1.5, pitch −50..+50, volume 0–1, locale
  - `motion_prompt` (photo avatars only)
  - `expressiveness`: high/medium/low (photo avatars on Avatar IV)
  - `engine`: `{type: avatar_iii | avatar_iv | avatar_v}`
  - `brand_glossary_id`
  - `caption`: `{file_format: "srt"}`
  - `watermark`
  - `callback_url`, `callback_id`

  — [Create Video ref](https://developers.heygen.com/reference/create-video)
- `type: "image"` animates any still (`image` as URL, asset_id or base64) and takes the same audio sources. `type: "cinematic_avatar"` takes a prompt (1–10,000 chars), 1–3 look IDs and a duration of 4–15 s at 16:9, 9:16 or 1:1, 720p or 1080p. `type: "studio"` takes 1–50 scenes (avatar_video / image / video). — [Create Video ref](https://developers.heygen.com/reference/create-video)
- **Idempotency:** optional `Idempotency-Key` header, 1–255 chars matching `[A-Za-z0-9_:.-]`, UUID recommended. "Subsequent calls within 24 hours that share this key replay the original response." A key collision while the first request is still in progress returns 409. — [Create Video ref](https://developers.heygen.com/reference/create-video)
- Response: `{ data: { video_id, status: "waiting", output_format } }`. Errors are 400 (invalid parameters, or the avatar failed moderation), 401, 409, and 429 with a `Retry-After` header. — [Create Video ref](https://developers.heygen.com/reference/create-video)

**Status polling: `GET /v3/videos/{video_id}`**
- Statuses in the reference are `pending | processing | completed | failed`. The Quick Start instead lists "generating, completed, failed", and create returns `waiting`, so the docs disagree on status names. Your code should treat any status other than `completed` or `failed` as in progress. — [Get Video ref](https://developers.heygen.com/reference/get-video); [Quick Start](https://developers.heygen.com/docs/quick-start)
- Response fields: `video_url` ("Presigned URL"), `thumbnail_url`, `gif_url`, `captioned_video_url` (captions burned in), `subtitle_url` (SRT), `duration`, `created_at`/`completed_at` (unix), `failure_code` / `failure_message`. — [Get Video ref](https://developers.heygen.com/reference/get-video)
- **Output URL expiry is not documented** in the v3 reference or the usage-limits page. The URLs are presigned, so they will expire. — [Get Video ref](https://developers.heygen.com/reference/get-video); [Usage Limits](https://developers.heygen.com/docs/usage-limits.md)

**Webhooks**
- Register endpoints with `POST https://api.heygen.com/v3/webhooks/endpoints`. Events include `avatar_video.success`, `avatar_video.fail` and `video_agent.success`. Setting events to null subscribes to all events. — [Webhooks](https://developers.heygen.com/docs/webhooks.md)
- Payloads carry `event_type` and `event_data`. Deduplicate on `event_data.video_id` plus `event_type`. The `signature` header is an HMAC-SHA256 of the raw body using the endpoint secret, so compare it in constant time. Failed deliveries retry with exponential backoff for up to 24 h. Your endpoint must return 2xx within 10 s. — [Webhooks](https://developers.heygen.com/docs/webhooks.md)
- For one-off jobs, pass `callback_url` (plus an optional `callback_id`) on create instead of registering an endpoint. — [Webhooks](https://developers.heygen.com/docs/webhooks.md)

**Avatars, looks, voices, photo avatars**
- `GET /v3/avatars` lists avatar groups, whose fields include `consent_status`. `GET /v3/avatars/looks?avatar_type=digital_twin&ownership=private` lists private digital-twin looks, and each look's `id` is the `avatar_id` to pass. `GET /v3/avatars/looks?group_id=...` lists the looks in one group. — [Digital Twin guide](https://developers.heygen.com/generate-avatar-video); [List Avatar Groups](https://developers.heygen.com/reference/list-avatar-groups); [Photo to Avatar](https://developers.heygen.com/docs/avatar-from-photo.md)
- `GET /v3/voices` lists voices, and `POST /v3/voices/speech` is HeyGen's own TTS, whose engine is called "Starfish". — [Photo to Avatar](https://developers.heygen.com/docs/avatar-from-photo.md); [HeyGen Developers home](https://developers.heygen.com/); [Endpoint Version Comparison](https://developers.heygen.com/endpoint-version-comparison.md)
- Photo avatar creation: `POST /v3/avatars` with `type:"photo"`, `name`, `file` ({type:url}|{type:asset_id}|base64) and an optional `avatar_group_id` to add a look to an existing group. It returns `avatar_item.id`. Poll `GET /v3/avatars/looks/{look_id}` for `status` (processing/completed/failed), `preview_image_url` and `supported_api_engines`. `PATCH /v3/avatars/{group_id}` sets the group's default voice. — [Photo to Avatar](https://developers.heygen.com/docs/avatar-from-photo.md)

**Digital-twin consent**
- Consent applies only to digital twins. Photo and prompt-generated avatars have `consent_status: null`. — [Avatar Consent](https://developers.heygen.com/docs/avatar-consent.md)
- `POST /v3/avatars/{group_id}/consent` covers two levels. Level 1 is open to all customers: a webcam statement recorded on HeyGen's hosted page, with a consent URL valid for 24 h. Level 2 is Enterprise-only and uses a pre-recorded video that HeyGen reviews semantically. Check progress with `GET /v3/avatars/{group_id}` → `consent_status` (`pending` → `approved`). — [Avatar Consent](https://developers.heygen.com/docs/avatar-consent.md); [search summary of List Avatar Groups](https://developers.heygen.com/reference/list-avatar-groups)

**Limits**
- Concurrency: 10 concurrent workflows on Pay-As-You-Go. Enterprise gets 20, with burst of up to +50 per workflow type billed at 1.5×. — [Usage Limits](https://developers.heygen.com/docs/usage-limits.md)
- Content limits:
  - Avatar script: max 5,000 chars.
  - TTS: 1–5,000 chars.
  - Video Agent prompt: 1–10,000 chars.
  - Audio input for avatars: max 10 min.
  - Media: audio 50 MB (WAV/MP3), image 50 MB, video 100 MB, all under 2K resolution.
  - Asset upload: 32 MB standard; larger files use direct upload.
  - Duration: max 30 min per scene, and at most 50 scenes per video.

  — [Usage Limits](https://developers.heygen.com/docs/usage-limits.md)
- Rate limits return 429 with `Retry-After`. The docs publish no numeric request-per-minute limits. — [Usage Limits](https://developers.heygen.com/docs/usage-limits.md)
- Batch APIs accept "up to 100 requests per call, webhooks included". — [HeyGen Developers home](https://developers.heygen.com/)

**Pricing (secondary sources; the official pricing page could not be fetched)**
- Photo Avatar (Avatar IV/V): $0.05/s at 720p/1080p (≈$3/min), $0.0667/s at 4K. Digital Twin / Studio avatar: $0.0667/s at 1080p (≈$4/min), $0.0833/s at 4K. Video Agent: $0.0333/s. Cinematic Avatar: flat $7 per 4–15 s clip. Avatar creation: $1 per call. The prepaid wallet starts at $5. This comes from a third-party blog dated 2026-06-10 that does not cite HeyGen directly. — [realtimeavatar.ai](https://realtimeavatar.ai/blog/heygen-api-pricing-explained)
- "Starting February 2026, HeyGen no longer offers free API credits". API billing is separate from web-plan credits. — [search summary incl. G2 / eesel articles](https://www.g2.com/articles/heygen-api-pricing)
- The official pricing links are `developers.heygen.com/docs/pricing.md` and `.../enterprise-pricing.md`, both listed in llms.txt. Both returned 404 when fetched. — [llms.txt](https://developers.heygen.com/llms.txt)

**github.com/heygen-com/skills**
- The repo is MIT-licensed, latest release v3.2.0 (2026-05-18), last push 2026-07-14, about 450 stars. — [GitHub API / repo](https://github.com/heygen-com/skills)
- It ships three agent skills built on the "v3 Video Agent pipeline":
  - `heygen-avatar`: photo to avatar. References: avatar-creation, asset-routing, troubleshooting.
  - `heygen-video`: script/prompt to video. References: avatar-discovery, frame-check, motion-vocabulary, official-prompt-guide, prompt-craft, prompt-styles.
  - `heygen-translate`: 175+ languages.

  It also includes `.claude-plugin`, `.codex-plugin` and `.cursor-plugin` manifests plus an `.mcp.json`. — [repo README/tree](https://github.com/heygen-com/skills)
- Transport: the skills call the **HeyGen CLI**, a static binary (`curl -fsSL https://static.heygen.ai/cli/install.sh | bash`; `heygen auth status`), when `HEYGEN_API_KEY` is set. Otherwise they fall back to the remote MCP server at `https://mcp.heygen.com/mcp/v1/` (OAuth). Install options are `gh skill install heygen-com/skills heygen-video` (GitHub CLI 2.90+), ClawHub, an OpenClaw plugin, or git clone into `~/.claude/skills/heygen-skills`. — [repo README](https://raw.githubusercontent.com/heygen-com/skills/HEAD/README.md)

### Inferences
- For a TS CLI, call REST v3 directly with `fetch` rather than shelling out to the HeyGen CLI. Send `Idempotency-Key = hash(project, scene, script)` so retries don't double-bill. Use `callback_url` only if the CLI exposes a public URL, and otherwise poll with backoff while honoring `Retry-After`.
- Our pipeline is ElevenLabs TTS → HeyGen lip-sync. For that path, pass `audio_url` or `audio_asset_id` (audio ≤10 min, ≤50 MB) so the voice and our timing data stay canonical.
- Download `video_url` immediately after completion and don't store it, because presigned URLs expire.
- Build the migration against v3 only, since v2 dies on 2026-10-31, about five weeks after this research date.
- Gate digital-twin usage on `consent_status === "approved"` in the CLI.

### Gaps
- Official per-second API prices could not be verified because the HeyGen pricing pages returned 404. The figures above are third-party, dated June 2026.
- No numeric request rate limits were found, and neither was the expiry TTL of presigned `video_url`s.
- The exact full enum of `consent_status` values beyond `pending`/`approved`/`null` was not found, and neither were the webhook payload's full `event_data` fields.

## ElevenLabs: TTS with timestamps, models, formats, dictionaries, zero-retention, residency, pricing, JS SDK, Forced Alignment, Scribe

### Takeaway
`POST /v1/text-to-speech/{voice_id}/with-timestamps` returns base64 audio plus **character-level** alignment, which you group into words yourself. Use `eleven_multilingual_v2` (10k chars) or `eleven_v3` (5k chars) for quality, and `eleven_flash_v2_5` (40k chars) for half-price drafts. Zero-retention (`enable_logging=false`) and regional data-residency endpoints are **Enterprise-only**. The official SDK is `@elevenlabs/elevenlabs-js` v2.69.0 (2026-09-24). Forced Alignment (`/v1/forced-alignment`) and Scribe v2 STT both return word timestamps.

### Cited Findings
**TTS with timestamps**
- Endpoint: `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps`.
  - Query params: `enable_logging` (default true), `optimize_streaming_latency` 0–4, `output_format` (default `mp3_44100_128`; e.g. `pcm_16000`, `wav_48000`, `opus_48000_192`).
  - Body: `text` (required), `model_id` (default `eleven_multilingual_v2`), `language_code`, `voice_settings` (stability, similarity_boost, style, use_speaker_boost, speed), `pronunciation_dictionary_locators` (max 3), `seed` (0–4294967295), `previous_text`/`next_text`, `previous_request_ids`/`next_request_ids` (max 3 each), `apply_text_normalization` (auto/on/off), `apply_language_text_normalization`.

  — [ElevenLabs API ref](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)
- Response: `{ audio_base64, alignment: { characters[], character_start_times_seconds[], character_end_times_seconds[] }, normalized_alignment: { ...same } }`. — [ElevenLabs API ref](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)
- Zero retention mode (`enable_logging=false`) "may only be used by enterprise customers". MP3 192 kbps needs Creator tier or above, and PCM/WAV 44.1 kHz needs Pro or above. — [ElevenLabs API ref](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)

**Models (per docs, Sept 2026)**
- `eleven_v3`: 5,000-char limit, 70+ languages.
- `eleven_v3_conversational`: ~280 ms latency.
- `eleven_multilingual_v2`: 10,000 chars, 29 languages.
- `eleven_flash_v2_5`: 40,000 chars, ~75 ms, 32 languages.
- `eleven_flash_v2`: 30,000 chars, English only.
- `eleven_turbo_v2_5` and `eleven_turbo_v2` are **deprecated** and "functionally equivalent" to the Flash models.

  — [ElevenLabs Models](https://elevenlabs.io/docs/models)
- STT models: `scribe_v2` (batch, 90+ languages), `scribe_v2_realtime` (~150 ms), `scribe_v2_medical`. `scribe_v1` is deprecated. — [ElevenLabs Models](https://elevenlabs.io/docs/models)

**Pricing (API page)**
- Plans:

  | Plan | Price/month | Characters included |
  |------|-------------|---------------------|
  | Free | $0 | 10k |
  | Starter | $6 | 60k |
  | Creator | $22 | 220k |
  | Pro | $99 | 990k |
  | Scale | $299 | 2.99M |
  | Business | $990 | 9.9M |

  — [ElevenLabs API pricing](https://elevenlabs.io/pricing/api)
- TTS costs $0.10 per 1K chars on the standard models (v3, Multilingual v2) and $0.05 per 1K chars on Flash/Turbo and v3 Conversational. STT costs $0.22/hour for Scribe v2 (entity detection +$0.07/h, keyterms +$0.05/h) and $0.39/hour for Scribe v2 Realtime. — [ElevenLabs API pricing](https://elevenlabs.io/pricing/api)

**Data residency**
- Regional API bases: EU `https://api.eu.residency.elevenlabs.io`, India `https://api.in.residency.elevenlabs.io`, Singapore `https://api.sg.residency.elevenlabs.io`, each with a matching `wss://` host. US is the default `api.elevenlabs.io`. All are **Enterprise-only**. Dubbing is unavailable in isolated environments, model availability varies by region, and processing may occur outside the region for support and moderation. — [ElevenLabs Data residency](https://elevenlabs.io/docs/overview/administration/data-residency)
- The SDK client takes an `environment` parameter (US by default) for switching regions. Community issues report 403s when a US key is used against the EU host. — [search summary; elevenlabs-python issue #625](https://github.com/elevenlabs/elevenlabs-python/issues/625)

**JS SDK**
- `@elevenlabs/elevenlabs-js` latest is **2.69.0**, published 2026-09-24, MIT license. — [npm registry](https://registry.npmjs.org/@elevenlabs%2Felevenlabs-js)
- It requires Node 15+, reads `ELEVENLABS_API_KEY` by default, and retries twice with exponential backoff by default. The default timeout is 60 s. Usage is `new ElevenLabsClient({apiKey}).textToSpeech.convert(voiceId, {text, modelId})`, and `textToSpeech.stream()` is also available. — [elevenlabs-js GitHub](https://github.com/elevenlabs/elevenlabs-js)

**Forced Alignment**
- `POST https://api.elevenlabs.io/v1/forced-alignment` takes multipart `file` (<1 GB, any major format) and `text`. It returns `{ characters:[{text,start,end}], words:[{text,start,end,loss}], loss }` and does not support diarization. — [Forced Alignment ref](https://elevenlabs.io/docs/api-reference/forced-alignment/create)

**Speech-to-Text (Scribe)**
- `POST https://api.elevenlabs.io/v1/speech-to-text`.
  - Required: `model_id` (`scribe_v2`), plus either `file` (≤5 GB, ≥100 ms) or `source_url`. `cloud_storage_url` is deprecated.
  - Optional: `timestamps_granularity` (`word` | `character`), `diarize`, `num_speakers` (≤32), `language_code`, `tag_audio_events`, `keyterms` (up to 1000), `use_multi_channel`, `webhook`, `enable_logging=false` (zero retention).

  — [STT ref](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)
- Each word object has `{ text, start, end, type: word|spacing|audio_event, speaker_id, logprob }`. — [STT ref](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)

### Inferences
- To get word timings from `/with-timestamps`, split `alignment.characters` on whitespace and take the first char's start and last char's end. Use `alignment` (the original text) for captions that must match the script. Use `normalized_alignment` when text normalization expanded numbers or abbreviations.
- For long scripts, chunk by paragraph, pass `previous_request_ids` for prosody continuity, and offset each chunk's timestamps by the cumulative audio duration.
- If the audio is re-edited or uses another TTS, Forced Alignment with the known script is the cheapest way to get accurate word timings back from ElevenLabs.
- Store the `seed` and model ID per scene so renders can be reproduced.

### Gaps
- Forced Alignment pricing was not listed on the pricing page.
- The `eleven_v3` credit multiplier relative to characters was not separately stated beyond the $0.10/1K figure.
- It is unconfirmed whether `/with-timestamps` supports `eleven_v3` with identical alignment quality.
- It is unconfirmed whether regional endpoints are selectable via an SDK `environment` enum or require a `baseUrl` override.

## Cheaper / local TTS fallbacks (Kokoro, Piper, OpenAI TTS)

### Takeaway
**Kokoro-82M** (Apache-2.0 weights; `kokoro-js` runs in Node via ONNX/transformers.js) is the best offline fallback on license and quality. **Piper** now lives at OHF-Voice/piper1-gpl under **GPL-3.0**, and the MIT-licensed rhasspy/piper is archived. Piper is fast but sounds more robotic, and the GPL may matter for distribution. **OpenAI TTS** (`gpt-4o-mini-tts`) is a cheap cloud option but returns no timestamps, so pair it with local ASR or forced alignment. OpenAI also requires AI-voice disclosure.

### Cited Findings
- Kokoro: 82M parameters, "Apache-licensed weights". It covers American and British English, Spanish, French, Hindi, Italian, Japanese, Brazilian Portuguese and Mandarin. Install with `pip install kokoro`, which needs `espeak-ng`. Apple Silicon can use MPS via `PYTORCH_ENABLE_MPS_FALLBACK=1`. A JS port exists. — [hexgrad/kokoro](https://github.com/hexgrad/kokoro)
- `kokoro-js` latest is 1.2.1, published 2025-05-03, Apache-2.0. — [npm registry](https://registry.npmjs.org/kokoro-js)
- Piper: current repo OHF-Voice/piper1-gpl, release v1.8.0 (2026-09-04), **GPL-3.0**. Install with `pip install piper-tts`, and it uses embedded espeak-ng. Home Assistant and NVDA use it. The Open Home Foundation is seeking maintainers. — [piper1-gpl](https://github.com/OHF-Voice/piper1-gpl); [GitHub API](https://api.github.com/repos/OHF-Voice/piper1-gpl)
- rhasspy/piper (MIT) is **archived**; its last release was 2023.11.14-2. — [GitHub API](https://api.github.com/repos/rhasspy/piper)
- OpenAI TTS models are `gpt-4o-mini-tts` (newest, steerable with an `instructions` prompt), `tts-1` (low latency) and `tts-1-hd`. There are 13 voices, with `marin` and `cedar` noted as best quality. Output formats are mp3, opus, aac, flac, wav and pcm. The guide does not mention timestamps. Policy requires "a clear disclosure to end users that the TTS voice they are hearing is AI-generated". — [OpenAI TTS guide](https://developers.openai.com/api/docs/guides/text-to-speech)
- The `openai` npm package latest is 7.23.0 (2026-09-23). — [npm registry](https://registry.npmjs.org/openai)

### Inferences
- Suggested fallback chain: ElevenLabs (with timestamps) → OpenAI `gpt-4o-mini-tts` → Kokoro (fully offline). Only the ElevenLabs step yields timings natively. The other two need a pass through local whisper.cpp or ElevenLabs Forced Alignment.
- Piper's per-voice model licenses vary, and many derive from datasets with their own terms. Check each voice before bundling.

### Gaps
- Official OpenAI TTS per-minute or per-token pricing was not captured in this session.
- There are no objective quality benchmarks (MOS) comparing Kokoro, Piper and OpenAI.
- Kokoro and Piper word-timestamp output was not confirmed; no native word timings were documented.

## Local ASR with word-level timestamps from Node (faster-whisper vs whisper.cpp vs WhisperX)

### Takeaway
For a Node CLI on macOS or Linux without heavy Python, **whisper.cpp** is the most practical option: v1.9.4 (2026-09-11), MIT, Metal and Core ML on Apple Silicon. Drive it through **`@remotion/install-whisper-cpp`** (v4.0.528, 2026-09-24), which downloads and builds whisper.cpp and models and returns JSON with DTW token timestamps. **WhisperX** gives the most accurate word boundaries through wav2vec2 forced alignment, but it needs Python and PyTorch. **faster-whisper** is Python/CTranslate2 and CUDA-optimized, with no Metal support documented. If the script is known, forced alignment beats free ASR timings.

### Cited Findings
**whisper.cpp**
- Latest release v1.9.4 (2026-09-11), MIT, about 54k stars, actively pushed as of 2026-09-24. — [GitHub API](https://api.github.com/repos/ggml-org/whisper.cpp)
- Build with `cmake -B build && cmake --build build -j --config Release`. Add `-DGGML_CUDA=1` or `-DGGML_VULKAN=1` for GPU. On Apple Silicon, Metal handles GPU inference and the Core ML encoder is "more than x3 faster" than CPU. Silero-VAD is integrated. — [whisper.cpp README](https://github.com/ggml-org/whisper.cpp)
- Model sizes:

  | Model | Disk | RAM |
  |-------|------|-----|
  | tiny | 75 MiB | ~273 MB |
  | base | 142 MiB | ~388 MB |
  | small | 466 MiB | ~852 MB |
  | medium | 1.5 GiB | ~2.1 GB |
  | large-v3 | 2.9 GiB | ~3.9 GB |

  — [whisper.cpp README](https://github.com/ggml-org/whisper.cpp)
- `-ml 1` gives word-level segments, and `-owts` produces karaoke-style output. — [whisper.cpp README](https://github.com/ggml-org/whisper.cpp)

**@remotion/install-whisper-cpp**
- Latest 4.0.528 (2026-09-24). npm lists the license as "SEE LICENSE IN LICENSE.md", which is the Remotion license. The docs page summary said "MIT", so the two sources conflict; verify before commercial use. — [npm registry](https://registry.npmjs.org/@remotion%2Finstall-whisper-cpp); [Remotion docs](https://www.remotion.dev/docs/install-whisper-cpp/)
- API: `installWhisperCpp({to, version})`, `downloadWhisperModel({model, folder})`, `transcribe({...})` and `toCaptions()`.
  - `transcribe` options: `inputPath` (16-bit, 16 kHz WAV required), `model` (default `base.en`), `tokenLevelTimestamps` (turns on the DTW flag and needs whisper.cpp ≥1.5.5), `splitOnWord`, `language`, `flashAttention`, `additionalArgs`, `onProgress`, `signal`.
  - It returns `transcription[]` with `timestamps`/`offsets`/`text` and `tokens[]` with `t_dtw`. The docs recommend `t_dtw` over offsets for accuracy.

  — [Remotion transcribe()](https://www.remotion.dev/docs/install-whisper-cpp/transcribe)
- Source: macOS and Linux clone and build with `make`. Windows only supports semver releases through prebuilt zip binaries. Build logic changes for versions ≥1.7.4 (cmake-era binary paths). — [remotion source](https://github.com/remotion-dev/remotion/tree/main/packages/install-whisper-cpp)

**nodejs-whisper**
- Latest 0.3.1 (2026-08-03), MIT. It wraps whisper.cpp and needs make and g++/CMake. It auto-converts audio to 16 kHz WAV via ffmpeg. Options include `wordTimestamps`, `splitOnWord`, `outputInJson` and `modelName`, plus VAD. Outputs are txt/srt/vtt/json/wts/lrc/csv. It is "Optimized for CPU (Including Apple Silicon ARM)" with optional CUDA, and no Metal or Core ML is mentioned. — [nodejs-whisper GitHub](https://github.com/ChetanXpro/nodejs-whisper); [npm registry](https://registry.npmjs.org/nodejs-whisper)

**smart-whisper**
- Native addon binding, latest 0.8.1, published **2024-10-02**, and not updated since. Treat it as stale. — [npm registry](https://registry.npmjs.org/smart-whisper)

**faster-whisper**
- Latest release v1.2.1 (2025-10-31), MIT, last push 2025-11-19. — [GitHub API](https://api.github.com/repos/SYSTRAN/faster-whisper)
- `pip install faster-whisper` on Python ≥3.9. GPU needs CUDA 12 with cuBLAS and cuDNN 9. It uses PyAV, so no ffmpeg is needed. `word_timestamps=True`, `vad_filter=True`, a batched pipeline, and models large-v3, turbo and distil-large-v3.
  - GPU benchmark (13 min of audio, RTX 3070 Ti, large-v2): fp16 took 1m03s, and batch=8 took about 16–17 s.
  - CPU benchmark (i7-12700K, small model): int8 batch=8 took 51 s.
  - Metal and MPS are not mentioned.

  — [faster-whisper README](https://github.com/SYSTRAN/faster-whisper)

**WhisperX**
- Latest v3.8.6 (2026-05-25), BSD-2-Clause, pushed 2026-08-30. — [GitHub API](https://api.github.com/repos/m-bain/whisperX)
- It uses a faster-whisper backend plus wav2vec2 phoneme forced alignment for word timestamps, and claims "70x realtime ... large-v2" batched on GPU. It has VAD and pyannote diarization, which requires a Hugging Face token. Install with `pip install whisperx` or `uvx whisperx`, and it needs PyTorch and ffmpeg. CPU and macOS are supported, and GPU needs CUDA 12.8. Run it with `whisperx audio.wav` to get JSON output. — [WhisperX README](https://github.com/m-bain/whisperX)

### Inferences
- **Recommended:** whisper.cpp via `@remotion/install-whisper-cpp` if the Remotion license is acceptable. Otherwise shell out to a whisper.cpp binary you build yourself or install with `brew install whisper-cpp`, run with `-ojf -ml 1 -sow --dtw <model>`, and parse the JSON yourself.
- Use `large-v3-turbo` or `medium.en` for quality and `base.en` for speed. Convert input with ffmpeg to 16 kHz mono PCM WAV first.
- Whisper's native word timestamps come from cross-attention (DTW) heuristics. They are usually within about ±100–300 ms and drift around silences and punctuation. WhisperX's wav2vec2 alignment is tighter. This is general community knowledge, not measured in this session.
- For TTS-generated audio you already know the text. So prefer, in order: ElevenLabs `/with-timestamps` alignment (free with generation), then ElevenLabs Forced Alignment, then local ASR only for recorded voiceovers or other TTS.
- Offer WhisperX as an optional "precise mode" run through `uvx whisperx`, which avoids polluting the user's Python install. Keep whisper.cpp as the zero-Python default.

### Gaps
- No primary-source benchmark numbers were found for word-timestamp error (ms) comparing whisper.cpp DTW, faster-whisper and WhisperX.
- The exact current whisper.cpp flag names for DTW and the full JSON output (`--dtw`, `-ojf`) were not verified against the v1.9.4 CLI help in this session.
- The large-v3-turbo model size was not listed on the page fetched.
- The terms of the Remotion license for `@remotion/install-whisper-cpp` (e.g., whether a company license is needed) were not read directly.

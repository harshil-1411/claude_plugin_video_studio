---
name: doctor
description: Check whether this machine is ready to make videos with video-studio. Reports Node, node:sqlite, ffmpeg/ffprobe (libass, libx264), Chrome, the optional HyperFrames renderer, whisper.cpp, configured provider keys and the data directory, with a fix for each problem. Use when the user runs /video-studio:doctor, asks if their setup works, or a render fails for environment reasons.
license: Apache-2.0
compatibility: Requires the video-studio plugin's bundled `engine` MCP server (Node.js 22.13+).
allowed-tools: mcp__plugin_video-studio_engine__doctor
---

# Environment doctor

1. Call the MCP tool `mcp__plugin_video-studio_engine__doctor` with no arguments.
   If the tool is not available, tell the user the `engine` MCP server did not start:
   check that Node.js 22.13+ is on PATH, then run `/mcp` to see the server's error,
   and `/reload-plugins` after fixing it. Stop there.
2. Present the result as a short table: one row per check with its status
   (ok / warn / fail) and the detail. Keep ok rows terse.
3. Below the table, list every `fail` and then every `warn` check with its `fix`,
   written as concrete commands for the user's platform (`platform` in the result).
4. Summarize readiness in one sentence:
   - `fail` on node, sqlite, ffmpeg, ffprobe or data_dir: video-studio cannot render yet.
   - Only warnings: local rendering works, with the listed features limited.
   - All ok: ready.

Rules:
- Provider keys are reported as present/missing only. Never ask the user to paste
  a key into the chat. To add keys, point them to `/plugin` → video-studio →
  Configure, where keys are stored in the OS credential store.
- Missing provider keys are not errors; local and mock paths need no keys.
- Chrome, `hyperframes` and whisper.cpp are optional: without HyperFrames the
  ffmpeg renderer draws every motion-graphic scene. If the user wants
  HyperFrames, give them the command from the `hyperframes` fix
  (`cd "${CLAUDE_PLUGIN_DATA}" && PUPPETEER_SKIP_DOWNLOAD=1 npm i @hyperframes/producer@0.8.78 --prefix deps`)
  to run themselves, then re-run the doctor.
- Do not try to install anything yourself unless the user asks.

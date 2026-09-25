---
name: analyze
description: Analyze a reference video's format (shot lengths, cuts per 10 s, first-shot length, pacing, speech share, loudness, and where burned-in captions sit) without copying anything from it, then apply that structure to the user's own video. Use when the user runs /video-studio:analyze, shares a reel they want to imitate ("make it like this one"), or asks how fast a video cuts or where its captions are.
license: Apache-2.0
compatibility: Requires the video-studio plugin's bundled `engine` MCP server (Node.js 22.13+) and a system ffmpeg.
allowed-tools: mcp__plugin_video-studio_engine__analyze Read
---

# Analyze a reference video (clean room)

`analyze` measures only a video's structure. It keeps no words, frames or audio
from the reference, and neither do you. Never transcribe, quote, describe
shot by shot or reuse a reference video's script, music, footage or visual
identity. Use it only for pacing and layout.

1. Get the path of the video file. It must be a local file. For a link, ask
   the user to download a copy they are allowed to use.
2. Call `analyze {path, project_dir}`, where `project_dir` is the user's
   project folder (absolute path). This writes `qa/analysis.json` and
   `qa/analysis.md` there. Leave out `project_dir` for a quick look.
3. Report it in plain words:
   - duration and aspect ratio
   - shot count, average shot length, cuts per 10 s and pacing
     (fast < 2 s per shot, slow > 5 s)
   - length of the hook shot
   - speech share: voice-band sound, so music can inflate it
   - loudness in LUFS
   - caption band, as a percentage of the frame height, or "none found"
4. Turn it into guidance for the user's own video, for example:
   - Cut every ~N s to match the pacing: set scene `duration_sec` near
     `avg_shot_sec`.
   - Make the first scene about `hook_shot_sec` long.
   - Keep captions in a similar band, but let the platform lint decide the
     exact position (`/video-studio:lint`).
   - For fast pacing, use short phrases and more scenes.
5. Offer the next step: the creative brief or plan, written from the
   user's own sources.

Limits:
- Scene detection misses soft cuts (fades and dissolves) and slow motion
  graphics, so a count of 1–2 shots on an animated reel is normal.
- The caption band is the densest text-like band in the lower two-thirds of
  the frame. It can be a headline instead of captions.

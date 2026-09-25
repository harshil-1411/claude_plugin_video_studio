# Phase 4 exit run (user, outside the sandbox)

The exit criterion from `docs/PLAN.md`:

> `/video-studio:create README.md` with targets instagram, tiktok and youtube-shorts produces three platform packages. Lint catches a deliberately misplaced caption under a TikTok UI mask, the fix loop clears it, and the golden test passes.

CI (step 3 item 4) is deferred, so the golden test runs locally (step 6).

The steps run in a terminal, not in a sandboxed Claude session, because the sandbox blocks `say` and headless Chrome.

## 0. Prepare

```
cd ~/Desktop/plugin_knowledge_to_video
git status                        # clean apart from vector-dbs-explainer/
pnpm install                      # also refreshes pnpm-lock.yaml (open issue 9)
pnpm typecheck && pnpm test
pnpm bundle && pnpm smoke
```

## 1. Create with three targets

```
mkdir -p ~/vs-exit && cd ~/vs-exit
claude --plugin-dir ~/Desktop/plugin_knowledge_to_video
```

In that session:

```
/video-studio:doctor
/video-studio:create ~/Desktop/plugin_knowledge_to_video/README.md as a 9:16 reel for instagram, tiktok and youtube-shorts
```

Check that the plan's `project/video-spec.json` has `"targets": ["instagram", "tiktok", "youtube-shorts"]`; if it doesn't, ask for them before approving. Then approve the plan. Accept the preview render, then the final.

**Pass:**
- `dist/instagram/`, `dist/tiktok/` and `dist/youtube-shorts/` each hold `video.mp4`, `captions.srt`, `captions.vtt`, `post.json` and `qa.json`, plus `cover.jpg` if the spec has a `cover`.
- `dist/video.lock` exists.
- Every `dist/<target>/qa.json` has 0 errors.

## 2. Misplace a caption under TikTok's UI

Edit `project/video-spec.json` in the new project so that `captions.position` is `{ "y": 0.9 }`. That centres captions in TikTok's footer mask (y 0.80–1.00). Then, in the session:

```
/video-studio:render      (preview is enough)
/video-studio:lint
```

**Pass:** lint reports `caption_mask` as an error for `tiktok`, and `dist/tiktok/qa.json` has status `fail`.

## 3. Fix loop

Let the lint skill apply its fix (it removes `captions.position` or moves it up), re-render and lint again.

**Pass:** no `caption_mask` finding, and `dist/tiktok/qa.json` has 0 errors.

## 4. Verify and diff

```
/video-studio:verify
/video-studio:diff     (compare the preview and final renders of this project)
```

**Pass:** verify is `pass` or `warn` with reasons you accept. The diff classifies the preview→final changes. Expect renderer or metadata changes and a frame size change.

## 5. Golden test on the project

```
/video-studio:test     (first run: status missing → look at the frames, then record with update)
/video-studio:test     (second run: pass)
```

## 6. Golden test on the example (the local stand-in for the CI golden test)

```
cd ~/Desktop/plugin_knowledge_to_video
VS_TEST_GOLDEN=1 npx vitest run tests/golden-frames
```

**Pass:** all frames are above the SSIM threshold. If the goldens were recorded on another machine and your ffmpeg differs, look at `qa/test-frames/` before re-recording with `VS_UPDATE_GOLDEN=1`.

## Report back

Paste the final `/video-studio:lint` summary, the `ls -R dist` output and the result of step 6. Phase 4 is then closed in `docs/HANDOFF.md`, and CI (item 4) comes next.

import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FfmpegError, type FfmpegTools, classifyFfmpegFailure, ffmpegFeatures, outputFile, resolveFfmpeg, runFfmpeg, runProcess } from "./ffmpeg.js";

// Real stderr from ffmpeg 8.1 (and the older "<path>: <error>" form of ffmpeg ≤ 5 / ffprobe).
const STDERR = {
  encoder: `Input #0, lavfi, from 'testsrc=d=1':
[vost#0:0 @ 0x78f070000] Unknown encoder 'libx264'
[vost#0:0 @ 0x78f070000] Error selecting an encoder
Error opening output file /p/out.mp4.
Error opening output files: Encoder not found`,
  filterDrawtext: `[AVFilterGraph @ 0x98f00c400] No such filter: 'drawtext'
Error opening output file -.
Error opening output files: Filter not found`,
  filterSubtitles: `[AVFilterGraph @ 0x98f00c400] No such filter: 'subtitles'
Error initializing complex filters.
Error opening output files: Filter not found`,
  corrupt: `[in#0 @ 0xa11044000] Format mov,mp4,m4a,3gp,3g2,mj2 detected only with low score of 1, misdetection possible!
[in#0 @ 0xa11044000] moov atom not found
[in#0 @ 0xa10c48000] Error opening input: Invalid data found when processing input
Error opening input file /tmp/proj/source/assets/talk.mp4.
Error opening input files: Invalid data found when processing input`,
  corruptOld: `[mov,mp4,m4a,3gp,3g2,mj2 @ 0x7f8] moov atom not found
/Users/me/talk.mp4: Invalid data found when processing input`,
  codecParams: `[mov,mp4,m4a,3gp,3g2,mj2 @ 0x1] Could not find codec parameters for stream 0 (Video: h264, none): unspecified size
Consider increasing the value for the 'analyzeduration' (0) and 'probesize' (5000000) options`,
  missing: `[in#0 @ 0xb8cc4c000] Error opening input: No such file or directory
Error opening input file /tmp/nope.mp4.
Error opening input files: No such file or directory`,
  diskFull: `[out#0/mp4 @ 0x1] Error writing trailer: No space left on device
[aost#0:1/aac @ 0x2] Error submitting a packet to the muxer: No space left on device`,
  permission: `[out#0/mp4 @ 0xa5] Error opening output /readonly/x.mp4: Permission denied
Error opening output file /readonly/x.mp4.
Error opening output files: Permission denied`,
};

describe("classifyFfmpegFailure", () => {
  it("missing encoder names the library and the fix", () => {
    const c = classifyFfmpegFailure(STDERR.encoder);
    expect(c.kind).toBe("missing_encoder");
    expect(c.hint).toMatch(/your ffmpeg lacks libx264: install a full build, e\.g\. brew install ffmpeg/);
  });

  it("missing filters point at libfreetype / libass", () => {
    expect(classifyFfmpegFailure(STDERR.filterDrawtext)).toMatchObject({ kind: "missing_filter", hint: expect.stringMatching(/libfreetype \(drawtext\)/) });
    expect(classifyFfmpegFailure(STDERR.filterSubtitles)).toMatchObject({ kind: "missing_filter", hint: expect.stringMatching(/libass \(subtitles\)/) });
  });

  it("corrupt or unreadable input names the file", () => {
    expect(classifyFfmpegFailure(STDERR.corrupt)).toMatchObject({ kind: "bad_input", hint: expect.stringContaining("input /tmp/proj/source/assets/talk.mp4 is unreadable or corrupt") });
    expect(classifyFfmpegFailure(STDERR.corruptOld)).toMatchObject({ kind: "bad_input", hint: expect.stringContaining("input /Users/me/talk.mp4 ") });
    expect(classifyFfmpegFailure(STDERR.codecParams, { args: ["-i", "/p/clip.mov", "out.mp4"] })).toMatchObject({ kind: "bad_input", hint: expect.stringContaining("/p/clip.mov") });
  });

  it("disk full, permission denied, missing files", () => {
    expect(classifyFfmpegFailure(STDERR.diskFull)).toMatchObject({ kind: "disk_full", hint: expect.stringMatching(/disk is full/) });
    expect(classifyFfmpegFailure(STDERR.permission)).toMatchObject({ kind: "permission_denied", hint: expect.stringContaining("/readonly/x.mp4") });
    expect(classifyFfmpegFailure(STDERR.missing)).toMatchObject({ kind: "input_missing", hint: expect.stringContaining("/tmp/nope.mp4 does not exist") });
  });

  it("ffmpeg itself missing (spawn ENOENT), aborts, timeouts and unknown failures", () => {
    expect(classifyFfmpegFailure("", { bin: "/usr/local/bin/ffmpeg", spawnCode: "ENOENT" })).toMatchObject({ kind: "not_installed", hint: expect.stringMatching(/^ffmpeg is not installed or not on PATH/) });
    expect(classifyFfmpegFailure("whatever", { killedFor: "aborted" }).kind).toBe("aborted");
    expect(classifyFfmpegFailure("whatever", { killedFor: "timeout" }).kind).toBe("timeout");
    expect(classifyFfmpegFailure("Conversion failed!")).toEqual({ kind: "unknown" });
  });

  it("a missing binary becomes an FfmpegError with kind not_installed", async () => {
    const err = (await runProcess("/definitely/not/ffmpeg", ["-version"]).catch((e: unknown) => e)) as FfmpegError;
    expect(err).toBeInstanceOf(FfmpegError);
    expect(err.kind).toBe("not_installed");
    expect(err.message.split("\n")[0]).toMatch(/not installed or not on PATH/);
  });

  it("outputFile picks the last argument only when it is a plain path", () => {
    expect(outputFile(["-i", "a.mp4", "-y", "/p/out.mp4"])).toBe("/p/out.mp4");
    expect(outputFile(["-i", "a.mp4", "-f", "null", "-"])).toBeUndefined();
    expect(outputFile(["-i", "a.mp4", "/p/f_%04d.png"])).toBeUndefined();
    expect(outputFile(["-i", "a.mp4", "pipe:1"])).toBeUndefined();
    expect(outputFile(["-i", "a.mp4", "/dev/null"])).toBeUndefined();
  });
});

let tools: FfmpegTools | null = null;
let libx264 = false;
try {
  tools = await resolveFfmpeg();
  libx264 = (await ffmpegFeatures({ tools })).libx264;
} catch {
  tools = null;
}

describe.skipIf(!tools)("real ffmpeg failures", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vs-fferr-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("a missing input is classified, with the stderr tail kept after the hint", async () => {
    const missing = join(dir, "missing.mp4");
    const err = (await runFfmpeg(["-i", missing, "-f", "null", "-"], { tools: tools! }).catch((e: unknown) => e)) as FfmpegError;
    expect(err.kind).toBe("input_missing");
    const [first, ...rest] = err.message.split("\n");
    expect(first).toContain(`${missing} does not exist`);
    expect(rest.join("\n")).toMatch(/ffmpeg exited with code/);
  });

  it("an unknown encoder is classified", async () => {
    const err = (await runFfmpeg(["-f", "lavfi", "-i", "testsrc=d=0.2:s=64x64", "-c:v", "libnope", "-f", "null", "-"], { tools: tools! }).catch((e: unknown) => e)) as FfmpegError;
    expect(err.kind).toBe("missing_encoder");
    expect(err.message.split("\n")[0]).toMatch(/your ffmpeg lacks libnope/);
  });

  it.skipIf(!libx264)(
    "aborting a running encode kills ffmpeg quickly and leaves no partial output",
    async () => {
      const out = join(dir, "aborted.mp4");
      const ac = new AbortController();
      const started = Date.now();
      // 3 s of 320x240 realtime-paced input: it cannot finish before the abort.
      const run = runFfmpeg(
        ["-y", "-re", "-f", "lavfi", "-i", "testsrc=d=3:s=320x240:r=15", "-c:v", "libx264", "-preset", "ultrafast", out],
        { tools: tools!, signal: ac.signal, onProgress: () => {} },
      );
      // Wait until ffmpeg has created the output, then abort mid-encode.
      for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 300));
      ac.abort();
      const err = (await run.catch((e: unknown) => e)) as FfmpegError;
      const elapsed = Date.now() - started;
      expect(err).toBeInstanceOf(FfmpegError);
      expect(err.kind).toBe("aborted");
      expect(elapsed).toBeLessThan(2900); // stopped well before the 3 s input ended
      expect(existsSync(out)).toBe(false);
    },
    15_000,
  );

  it.skipIf(!libx264)("a failed run does not delete an output that existed before", async () => {
    const out = join(dir, "keep.mp4");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=d=0.2:s=64x64:r=5", "-c:v", "libx264", "-preset", "ultrafast", out], { tools: tools! });
    const before = (await stat(out)).size;
    await runFfmpeg(["-f", "lavfi", "-i", "testsrc=d=0.2:s=64x64", "-c:v", "libnope", out], { tools: tools! }).catch(() => {});
    expect((await stat(out)).size).toBe(before);
  });
});

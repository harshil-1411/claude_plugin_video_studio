import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { concatVideos, transitionSeconds } from "./compose.js";
import { ffprobe, runFfmpeg } from "./ffmpeg.js";

/** Average colour of the frame at `t` as [r, g, b]. */
async function colourAt(file: string, t: number): Promise<number[]> {
  const out = `${file}.${t}.rgb`;
  await runFfmpeg(["-y", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", out]);
  return [...(await readFile(out))];
}

describe("scene transitions", () => {
  let tmp: string;
  const seg = (c: string) => join(tmp, `${c}.mp4`);
  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "vs-xfade-"));
    for (const c of ["red", "lime", "blue"]) {
      await runFfmpeg(["-y", "-f", "lavfi", "-i", `color=c=${c}:s=180x320:r=15:d=2`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", seg(c)]);
    }
  });
  afterAll(() => rm(tmp, { recursive: true, force: true }));

  it("clamps the transition to 40% of the incoming slot, 1.5 s, and whole frames", () => {
    expect(transitionSeconds(400, 2000, 30)).toBeCloseTo(0.4, 5);
    expect(transitionSeconds(1200, 1000, 30)).toBeCloseTo(0.4, 5);
    expect(transitionSeconds(5000, 10_000, 30)).toBeCloseTo(1.5, 5);
    expect(transitionSeconds(50, 2000, 15)).toBe(0); // under two frames: a cut
  });

  it("keeps the timeline exact and blends at the boundary", async () => {
    const out = join(tmp, "x.mp4");
    const target = { width: 180, height: 320, fps: 15, fit: "pad" as const, padColor: "#000000" };
    const r = await concatVideos(
      [
        { path: seg("red"), duration_ms: 2000 },
        { path: seg("lime"), duration_ms: 2000, transition_in: { kind: "crossfade", ms: 600 } },
        { path: seg("blue"), duration_ms: 2000, transition_in: { kind: "cut", ms: 600 } },
      ],
      out,
      target,
      { encode: { preset: "ultrafast" } },
    );
    expect(r.frames).toBe(90);
    expect(Math.abs((await ffprobe(out)).duration_s - 6)).toBeLessThan(0.05);
    const [before, mid, after, cut] = await Promise.all([colourAt(out, 1.9), colourAt(out, 2.25), colourAt(out, 2.8), colourAt(out, 4.1)]);
    expect(before[0]).toBeGreaterThan(200); // red, until the boundary
    expect(mid[0]).toBeGreaterThan(40); // a mix of red and green…
    expect(mid[1]).toBeGreaterThan(40);
    expect(after[1]).toBeGreaterThan(200); // …then green, on time
    expect(after[0]).toBeLessThan(30);
    expect(cut[2]).toBeGreaterThan(200); // a hard cut to blue
  }, 60_000);

  it("without transitions, output is the plain concat (unchanged)", async () => {
    const a = join(tmp, "plain.mp4");
    await concatVideos([{ path: seg("red"), duration_ms: 1000 }, { path: seg("blue"), duration_ms: 1000 }], a, { width: 180, height: 320, fps: 15, fit: "pad", padColor: "#000000" }, { encode: { preset: "ultrafast" } });
    expect((await colourAt(a, 0.85))[0]).toBeGreaterThan(200); // last red frames (15 fps)
    expect((await colourAt(a, 1.05))[2]).toBeGreaterThan(200);
  }, 60_000);
});

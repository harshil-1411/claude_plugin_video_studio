import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffprobe, frameSsim, runFfmpeg } from "@video-studio/media";
import type { FootageClip, MediaInfo, MotionPattern, Scene } from "@video-studio/schema";
import { FOOTAGE_RENDERER_ID, FOOTAGE_RENDERER_VERSION, createFootageRenderer, planFootage, redactChains } from "./footage.js";
import { revealChains, sceneMotionChains, zoomPanExprs, zoomPanFilter } from "./ffmpeg-renderer.js";
import { renderScenes, sceneCacheKey } from "./select.js";
import { resolveTokens, targetForAspect } from "./tokens.js";
import type { RenderTarget } from "./types.js";

// Tiny renders only: ≤ 180x320, ≤ 1.5 s, 15 fps, x264 ultrafast.
const T = 60_000;
const target: RenderTarget = targetForAspect("9:16", { shortSide: 180, fps: 15 });
const tokens = resolveTokens();
const renderer = createFootageRenderer({ encodePreset: "ultrafast" });
let tmp: string;
let ramp: string; // 320x240, 4 s: luma rises 60 per second
let still: string;
const rampMedia: MediaInfo = { duration_sec: 4, width: 320, height: 240, fps: 15, has_video: true, has_audio: true };

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-footage-"));
  ramp = join(tmp, "ramp.mp4");
  await runFfmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=320x240:r=15:d=4,geq=lum='16+T*50':cb=128:cr=128",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:sample_rate=48000:duration=4",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    ramp,
  ]);
  still = join(tmp, "still.png");
  await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:d=1", "-frames:v", "1", still]);
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function scene(footage: FootageClip, duration_sec = 1, extra: Partial<Scene> = {}): Scene {
  return {
    id: "s01",
    duration_sec,
    purpose: "point",
    voiceover: "",
    visual_strategy: "user_asset",
    visual_requirements: { continuity_refs: [] },
    claim_refs: [],
    footage,
    ...extra,
  };
}

/** Mean luma per frame. */
async function lumas(path: string): Promise<number[]> {
  const out = join(tmp, `luma-${Math.random().toString(36).slice(2)}.txt`);
  await runFfmpeg(["-i", path, "-vf", `signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=${out}`, "-f", "null", "-"]);
  return (await readFile(out, "utf8"))
    .split("\n")
    .filter((l) => l.includes("YAVG"))
    .map((l) => Number(l.split("=")[1]));
}

async function render(name: string, sc: Scene, path = ramp, media: MediaInfo = rampMedia) {
  const out = join(tmp, `${name}.mp4`);
  const res = await renderer.render({ scene: sc, target, tokens, out_path: out, project_dir: tmp, footage: { path, sha256: "x", media } });
  return { res, out, probe: await ffprobe(out) };
}

describe("planFootage (pure)", () => {
  it("computes span, play length and fill mode", () => {
    const p = planFootage({ asset: "v", in_sec: 1, speed: 2 }, rampMedia, ramp, target, 1, "#000000");
    expect(p).toMatchObject({ kind: "video", frames: 15, span_sec: 2, play_sec: 1, fill: "exact" });
    expect(planFootage({ asset: "v", in_sec: 3, out_sec: 3.5 }, rampMedia, ramp, target, 1.5, "#000").fill).toBe("hold");
    expect(planFootage({ asset: "v", in_sec: 3, out_sec: 3.5, loop: true }, rampMedia, ramp, target, 1.5, "#000").fill).toBe("loop");
    // Clamped to the asset's end.
    expect(planFootage({ asset: "v", in_sec: 3.5 }, rampMedia, ramp, target, 1, "#000")).toMatchObject({ span_sec: 0.5, fill: "hold" });
    expect(planFootage({ asset: "v", in_sec: 0 }, { duration_sec: 0 }, still, target, 1, "#000").kind).toBe("still");
  });
});

describe("footage renderer", () => {
  it.each(["cover", "contain", "blur_pad"] as const)(
    "fit %s gives an exact-length clip at the target size, silent",
    async (fit) => {
      const { res, probe } = await render(`fit-${fit}`, scene({ asset: "v", in_sec: 0, fit }));
      expect(res.renderer).toBe(FOOTAGE_RENDERER_ID);
      expect([probe.width, probe.height]).toEqual([target.width, target.height]);
      expect(probe.has_audio).toBe(false);
      expect(res.duration_ms).toBe(1000);
      expect(Math.abs(probe.duration_s - 1)).toBeLessThan(0.08);
    },
    T,
  );

  it(
    "contain letterboxes on the background; blur_pad fills the bars with picture",
    async () => {
      // Top rows: the background colour for contain, blurred footage (brighter than black) for blur_pad.
      const top = async (fit: "contain" | "blur_pad") => {
        const out = join(tmp, `top-${fit}.png`);
        const { out: clip } = await render(`top-${fit}`, scene({ asset: "v", in_sec: 3, fit }));
        await runFfmpeg(["-y", "-i", clip, "-vf", "crop=iw:20:0:0", "-frames:v", "1", "-update", "1", out]);
        return (await lumas(out))[0]!;
      };
      const bg = resolveTokens().color_background;
      const contain = await top("contain");
      const blur = await top("blur_pad");
      expect(bg).toBeTruthy();
      expect(blur - contain).toBeGreaterThan(40);
    },
    T,
  );

  it(
    "trims in_sec and applies speed",
    async () => {
      const { out } = await render("speed", scene({ asset: "v", in_sec: 1, speed: 2, fit: "cover" }));
      const y = await lumas(out);
      expect(y.length).toBe(15);
      // Source luma = 16 + 50 t; the clip starts at t = 1 and ends near t = 1 + 2 * 14/15.
      expect(Math.abs(y[0]! - 66)).toBeLessThan(8);
      expect(Math.abs(y[14]! - (16 + 50 * (1 + (2 * 14) / 15)))).toBeLessThan(10);
    },
    T,
  );

  it(
    "holds the last frame, or loops, when the clip is shorter than the scene",
    async () => {
      const hold = await render("hold", scene({ asset: "v", in_sec: 3, out_sec: 3.5 }, 1.5));
      const loop = await render("loop", scene({ asset: "v", in_sec: 3, out_sec: 3.5, loop: true }, 1.5));
      expect(hold.res.warnings.join(" ")).toMatch(/last frame held/);
      expect(loop.res.warnings.join(" ")).toMatch(/looped/);
      const yh = await lumas(hold.out);
      const yl = await lumas(loop.out);
      expect(yh.length).toBe(23);
      expect(yl.length).toBe(23);
      // Held: the tail stays at the last source frame; looped: it drops back towards the start.
      expect(Math.abs(yh[22]! - yh[10]!)).toBeLessThan(3);
      expect(yh[22]! - yl[22]!).toBeGreaterThan(8);
      expect(Math.abs(yl[8]! - yl[1]!)).toBeLessThan(6);
    },
    T,
  );

  it(
    "draws a lower third over the footage and reports its text boxes",
    async () => {
      const sc = scene({ asset: "v", in_sec: 0 }, 1, { deterministic: { kind: "lower_third", props: { name: "Ada Lovelace", title: "Engineer" } } });
      const { res } = await render("lower-third", sc);
      expect(res.text_boxes?.map((b) => b.text)).toEqual(expect.arrayContaining(["Ada Lovelace", "Engineer"]));
      const chart = scene({ asset: "v", in_sec: 0 }, 1, { deterministic: { kind: "chart", props: {} } });
      const r2 = await render("chart-skip", chart);
      expect(r2.res.warnings.join(" ")).toMatch(/"chart" is not drawn over footage/);
      expect(r2.res.text_boxes).toBeUndefined();
    },
    T,
  );

  it(
    "turns a still into a gentle push-in",
    async () => {
      const { probe, out } = await render("still", scene({ asset: "img", in_sec: 0 }), still, { duration_sec: 0, width: 320, height: 240, has_video: true, has_audio: false });
      expect([probe.width, probe.height]).toEqual([target.width, target.height]);
      expect((await lumas(out)).length).toBe(15);
    },
    T,
  );
});

describe("redaction", () => {
  it("builds blur and box chains with time windows in play time", () => {
    const c = redactChains([{ x: 0.1, y: 0.2, w: 0.3, h: 0.4, from_sec: 12, to_sec: 14 }, { x: 0, y: 0, w: 1, h: 0.1, mode: "box" }], 10, 2, "[a]", "[b]");
    expect(c.join(";")).toContain("crop=iw*0.3:ih*0.4:iw*0.1:ih*0.2,gblur=sigma=40");
    expect(c.join(";")).toContain("enable='between(t,1,2)'"); // (12-10)/2 .. (14-10)/2
    expect(c.at(-1)).toMatch(/^\[rd0\]drawbox=x=iw\*0:y=ih\*0:w=iw\*1:h=ih\*0\.1:color=black:t=fill\[b\]$/);
    expect(redactChains([], 0, 1, "[a]", "[b]")).toEqual(["[a]null[b]"]);
  });

  it(
    "makes the region unreadable and leaves the rest of the frame alone",
    async () => {
      const detail = join(tmp, "detail.mp4");
      await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=15:d=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", detail]);
      const media: MediaInfo = { duration_sec: 2, width: 320, height: 240, fps: 15, has_video: true, has_audio: false };
      const plain = await render("detail-plain", scene({ asset: "a", in_sec: 0, fit: "contain" }), detail, media);
      const red = await render("detail-red", scene({ asset: "a", in_sec: 0, fit: "contain", redact: [{ x: 0, y: 0, w: 0.5, h: 1, label: "left half" }] }), detail, media);
      const half = async (video: string, side: "l" | "r") => {
        const out = join(tmp, `${video.split("/").pop()}-${side}.png`);
        // contain: the 320x240 source sits in the middle of the 180x320 frame (180x135).
        await runFfmpeg(["-y", "-ss", "0.5", "-i", video, "-frames:v", "1", "-vf", `crop=90:135:${side === "l" ? 0 : 90}:92`, out]);
        return out;
      };
      expect(await frameSsim(await half(plain.out, "r"), await half(red.out, "r"))).toBeGreaterThan(0.95);
      expect(await frameSsim(await half(plain.out, "l"), await half(red.out, "l"))).toBeLessThan(0.7);
    },
    60_000,
  );
});

describe("letterboxed sources", () => {
  it(
    "crops baked-in bars (media.content_box) before cover, so no black rows remain",
    async () => {
      const lb = join(tmp, "letterboxed.mp4");
      await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=white:s=320x130:r=15:d=2", "-vf", "pad=320:180:0:25:black", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", lb]);
      const media: MediaInfo = { duration_sec: 2, width: 320, height: 180, fps: 15, has_video: true, has_audio: false };
      expect(planFootage({ asset: "a", in_sec: 0 }, { ...media, content_box: { x: 0, y: 25, w: 320, h: 130 } }, lb, target, 1, "#000000").chains.join(";")).toContain("crop=320:130:0:25");
      const topRowLuma = async (video: string) => {
        const png = join(tmp, `${video.split("/").pop()}-top.png`);
        await runFfmpeg(["-y", "-ss", "0.5", "-i", video, "-frames:v", "1", "-vf", "crop=iw:4:0:0", png]);
        return (await lumas(png))[0]!;
      };
      const plain = await render("lb-plain", scene({ asset: "a", in_sec: 0, fit: "contain" }), lb, media);
      const fixed = await render("lb-fixed", scene({ asset: "a", in_sec: 0, fit: "cover" }), lb, { ...media, content_box: { x: 0, y: 25, w: 320, h: 130 } });
      expect(await topRowLuma(fixed.out)).toBeGreaterThan(200); // picture (white), not a bar
      expect(plain.probe.width).toBe(fixed.probe.width);
    },
    60_000,
  );
});

describe("renderScenes with footage", () => {
  it("cache key changes with the asset hash and the footage params", () => {
    const sc = scene({ asset: "v", in_sec: 0 });
    const k = (s: Scene, sha: string) => sceneCacheKey(s, tokens, target, renderer, false, undefined, { sha256: sha });
    expect(k(sc, "a")).not.toBe(k(sc, "b"));
    expect(k(sc, "a")).not.toBe(k(scene({ asset: "v", in_sec: 1 }), "a"));
    expect(k(sc, "a")).toBe(k(scene({ asset: "v", in_sec: 0 }), "a"));
  });

  it(
    "routes footage scenes to the footage renderer, caches them and placeholders unresolved ones",
    async () => {
      const dir = join(tmp, "rs");
      const s1 = scene({ asset: "v", in_sec: 0 });
      const s2 = { ...scene({ asset: "missing", in_sec: 0 }), id: "s02" };
      const opts = (sha: string) => ({
        project_dir: tmp,
        dir,
        renderers: [],
        tokens,
        target,
        placeholder: false,
        footageRenderer: renderer,
        footage: new Map([
          ["s01", { path: ramp, sha256: sha, media: rampMedia }],
          ["s02", { error: 'not a ContentIR asset' }],
        ]),
      });
      const a = await renderScenes({ scenes: [s1, s2] }, opts("aaa"));
      expect(a.scenes[0]).toMatchObject({ status: "rendered", renderer: FOOTAGE_RENDERER_ID });
      expect(a.scenes[1]).toMatchObject({ status: "pending", reason: expect.stringMatching(/footage asset "missing": not a ContentIR asset/) });
      const b = await renderScenes({ scenes: [s1] }, opts("aaa"));
      expect(b.scenes[0]).toMatchObject({ status: "cached", from_cache: true });
      const c = await renderScenes({ scenes: [s1] }, opts("bbb"));
      expect(c.scenes[0]!.status).toBe("rendered");
    },
    T,
  );
});

describe("scene motion on footage", () => {
  const PATTERNS: MotionPattern[] = ["push_in", "pull_out", "punch", "reveal", "drift", "hold"];
  const stillMedia: MediaInfo = { duration_sec: 0, width: 320, height: 240, has_video: true, has_audio: false };
  const gridMedia: MediaInfo = { duration_sec: 2, width: 320, height: 240, fps: 15, has_video: true, has_audio: false };
  let grid: string;
  let gridStill: string;
  const W = target.width;
  const H = target.height;

  beforeAll(async () => {
    // A static full-bleed picture (green with yellow lines): any motion changes frames, and any
    // exposed edge would show black or the background colour instead of green/yellow.
    const src = "color=c=0x00C000:s=320x240:r=15:d=2,drawgrid=w=32:h=32:t=3:c=0xFFFF00";
    grid = join(tmp, "grid.mp4");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", src, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", grid]);
    gridStill = join(tmp, "grid.png");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", src, "-frames:v", "1", gridStill]);
  });

  const rgbFrames = async (path: string): Promise<Buffer[]> => {
    const raw = join(tmp, `f-${Math.random().toString(36).slice(2)}.rgb`);
    await runFfmpeg(["-y", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", raw]);
    const buf = await readFile(raw);
    const n = W * H * 3;
    return Array.from({ length: buf.length / n }, (_, i) => buf.subarray(i * n, (i + 1) * n));
  };
  const meanDiff = (a: Buffer, b: Buffer) => {
    let d = 0;
    for (let i = 0; i < a.length; i++) d += Math.abs(a[i]! - b[i]!);
    return d / a.length;
  };
  /** Every corner pixel is picture (green or yellow), not black and not the background. */
  const cornersArePicture = (f: Buffer) =>
    [
      [0, 0],
      [W - 1, 0],
      [0, H - 1],
      [W - 1, H - 1],
    ].every(([x, y]) => {
      const i = (y! * W + x!) * 3;
      return f[i + 1]! > 120 && f[i + 2]! < 100;
    });

  it("folds the motion into the plan after the fit; without it the plan is unchanged", () => {
    expect(FOOTAGE_RENDERER_VERSION).toBe("0.3.0");
    const clip: FootageClip = { asset: "v", in_sec: 0 };
    const base = planFootage(clip, rampMedia, ramp, target, 1, "#112233");
    expect(planFootage(clip, rampMedia, ramp, target, 1, "#112233", {})).toEqual(base);
    expect(base.chains.at(-1)).toBe("[fit]format=yuv420p,trim=end_frame=15,setpts=PTS-STARTPTS[fg]");
    // hold on video: nothing to add.
    expect(planFootage(clip, rampMedia, ramp, target, 1, "#112233", { motion: { pattern: "hold" } })).toEqual(base);
    for (const pattern of ["push_in", "pull_out", "punch", "reveal", "drift"] as const) {
      const p = planFootage(clip, rampMedia, ramp, target, 1, "#112233", { motion: { pattern, intensity: "strong" }, easing: "snap" });
      const move = sceneMotionChains({ pattern, intensity: "strong" }, target, 15, "#112233", "snap", "[mv]", "[fg]");
      expect(p.chains).toEqual([...base.chains.slice(0, -1), "[fit]format=yuv420p,trim=end_frame=15,setpts=PTS-STARTPTS[mv]", ...move]);
    }
  });

  it("replaces the still's Ken Burns with the pattern; hold keeps the still still", () => {
    const clip: FootageClip = { asset: "img", in_sec: 0 };
    const kb = planFootage(clip, stillMedia, gridStill, target, 1, "#112233");
    expect(kb.chains.at(-1)).toContain("zoompan=z='1+0.08*on/14'");
    const plan = (pattern: MotionPattern) => planFootage(clip, stillMedia, gridStill, target, 1, "#112233", { motion: { pattern } });
    expect(plan("hold").chains.at(-1)).toContain(zoomPanFilter(zoomPanExprs({ pattern: "hold" }, 15, 15), target, 15));
    expect(plan("hold").chains.at(-1)).toContain("zoompan=z='1':");
    expect(plan("push_in").chains.at(-1)).toContain(zoomPanFilter(zoomPanExprs({ pattern: "push_in" }, 15, 15), target, 15));
    expect(plan("drift").chains.at(-1)).toMatch(/zoompan=z='1\.04':x='iw\/2-iw\/zoom\/2\+iw\/zoom\*0\.03\*/);
    const rv = plan("reveal").chains;
    expect(rv.at(-3)).toMatch(/zoompan=z='1':.*\[mv\]$/);
    expect(rv.slice(-2)).toEqual(revealChains(target, 1, 0.4, "#112233", undefined, "[mv]", "[fg]"));
    for (const p of PATTERNS) expect(plan(p).chains.at(-1)).not.toContain("0.08*on");
  });

  // hold first: its frames are the unmoved reference for punch's rest pose.
  let holdFrames: Buffer[] = [];
  it.each(["hold", "push_in", "pull_out", "punch", "reveal", "drift"] as const)(
    "%s on video: exact size and frames, edges never exposed, moves unless hold",
    async (pattern) => {
      const { probe, out, res } = await render(`mo-${pattern}`, scene({ asset: "v", in_sec: 0 }, 1, { motion: { pattern } }), grid, gridMedia);
      expect(res.renderer_version).toBe(FOOTAGE_RENDERER_VERSION);
      expect([probe.width, probe.height, probe.fps]).toEqual([W, H, 15]);
      const f = await rgbFrames(out);
      expect(f).toHaveLength(15);
      if (pattern === "reveal") {
        expect(cornersArePicture(f[0]!)).toBe(false); // starts on the background
        expect(f.slice(7).every(cornersArePicture)).toBe(true); // wiped in by 400 ms
        expect(meanDiff(f[0]!, f[14]!)).toBeGreaterThan(20);
        return;
      }
      expect(f.every(cornersArePicture), "an edge showed").toBe(true);
      // Thresholds sit above the x264 noise of re-encoding a static source (~0.6).
      if (pattern === "hold") {
        expect(Math.max(...f.map((x) => meanDiff(x, f[0]!)))).toBeLessThan(1);
        holdFrames = f;
      } else if (pattern === "punch") {
        expect(meanDiff(f[2]!, f[0]!)).toBeGreaterThan(2);
        expect(meanDiff(f[14]!, holdFrames[14]!)).toBeLessThan(1); // back to the untouched frame
      } else expect(meanDiff(f[14]!, f[0]!)).toBeGreaterThan(2);
    },
    T,
  );

  it.each(["hold", "push_in", "reveal"] as const)(
    "%s on a still",
    async (pattern) => {
      const { probe, out } = await render(`still-${pattern}`, scene({ asset: "img", in_sec: 0 }, 1, { motion: { pattern } }), gridStill, stillMedia);
      expect([probe.width, probe.height]).toEqual([W, H]);
      const f = await rgbFrames(out);
      expect(f).toHaveLength(15);
      if (pattern === "hold") expect(Math.max(...f.map((x) => meanDiff(x, f[0]!)))).toBeLessThan(1);
      if (pattern === "push_in") {
        expect(f.every(cornersArePicture)).toBe(true);
        expect(meanDiff(f[14]!, f[0]!)).toBeGreaterThan(2);
      }
      if (pattern === "reveal") {
        expect(cornersArePicture(f[0]!)).toBe(false);
        expect(cornersArePicture(f[14]!)).toBe(true);
      }
      if (process.env.VS_TEST_FRAMES_DIR && pattern !== "hold") {
        await runFfmpeg(["-y", "-i", out, "-vf", "select=not(mod(n\\,3)),tile=5x1", "-frames:v", "1", join(process.env.VS_TEST_FRAMES_DIR, `footage-still-${pattern}.png`)]);
      }
    },
    T,
  );
});

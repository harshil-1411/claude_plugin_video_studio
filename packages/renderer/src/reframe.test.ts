import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFfmpeg } from "@video-studio/media";
import type { FootageClip, MediaInfo, Scene } from "@video-studio/schema";
import { createFootageRenderer, planFootage } from "./footage.js";
import { REFRAME, coverCropAt, coverSize, focusAt, focusExpr, prepareFocusTrack, smoothFocus, subjectEdgeHits, toPlayPoints } from "./reframe.js";
import { resolveTokens, targetForAspect } from "./tokens.js";

describe("reframe math (pure)", () => {
  it("cover size and clamped crop offsets", () => {
    expect(coverSize(320, 180, 180, 320)).toEqual({ iw: 569, ih: 320 });
    expect(coverSize(1920, 1080, 1080, 1920)).toEqual({ iw: 3413, ih: 1920 });
    // Subject in the middle: crop centred on it.
    expect(coverCropAt({ x: 0.5, y: 0.5 }, 569, 320, 180, 320)).toEqual({ x: 194.5, y: 0 });
    // Near the edges: clamped so the crop never leaves the picture.
    expect(coverCropAt({ x: 0.02, y: 0.5 }, 569, 320, 180, 320).x).toBe(0);
    expect(coverCropAt({ x: 0.99, y: 0.5 }, 569, 320, 180, 320).x).toBe(389);
  });

  it("interpolates with smoothstep and holds outside the keyframes", () => {
    const pts = [
      { t: 1, x: 0.2, y: 0.5 },
      { t: 3, x: 0.6, y: 0.5 },
    ];
    expect(focusAt(pts, 0)).toEqual({ x: 0.2, y: 0.5 });
    expect(focusAt(pts, 2).x).toBeCloseTo(0.4);
    expect(focusAt(pts, 1.5).x).toBeCloseTo(0.2 + 0.4 * 0.15625); // smoothstep(0.25)
    expect(focusAt(pts, 9)).toEqual({ x: 0.6, y: 0.5 });
  });

  it("the ffmpeg expression matches focusAt", () => {
    const pts = [
      { t: 0, x: 0.3, y: 0.4 },
      { t: 0.5, x: 0.45, y: 0.4 },
      { t: 1.25, x: 0.7, y: 0.5 },
    ];
    const expr = focusExpr(pts, "x");
    for (const t of [0, 0.1, 0.3, 0.5, 0.8, 1.2, 1.25, 4]) {
      const js = expr.replace(/\bt\b/g, `(${t})`).replace(/if\(/g, "iff(").replace(/lt\(/g, "lt_(").replace(/gte\(/g, "gte_(");
      const val = new Function("iff", "lt_", "gte_", `return ${js};`)(
        (c: number, a: number, b: number) => (c ? a : b),
        (a: number, b: number) => (a < b ? 1 : 0),
        (a: number, b: number) => (a >= b ? 1 : 0),
      ) as number;
      expect(val).toBeCloseTo(focusAt(pts, t).x, 3);
    }
    expect(focusExpr([{ t: 0, x: 0.5, y: 0.5 }, { t: 1, x: 0.5, y: 0.5 }], "x")).toBe("0.5");
  });

  it("smoothing: dead zone swallows jitter, pan speed is capped, long tracks are downsampled", () => {
    const jitter = Array.from({ length: 10 }, (_, i) => ({ t: i * 0.5, x: 0.5 + (i % 2 ? 0.008 : -0.008), y: 0.5 }));
    const s = smoothFocus(jitter);
    expect(new Set(s.map((p) => p.x)).size).toBe(1);
    const jump = smoothFocus([
      { t: 0, x: 0.1, y: 0.5 },
      { t: 1, x: 0.9, y: 0.5 },
    ]);
    expect(jump[1]!.x - jump[0]!.x).toBeCloseTo(REFRAME.max_speed);
    const long = Array.from({ length: 200 }, (_, i) => ({ t: i * 0.25, x: 0.5 + 0.3 * Math.sin(i / 10), y: 0.5 }));
    const d = smoothFocus(long);
    expect(d.length).toBeLessThanOrEqual(REFRAME.max_keys);
    expect(d[0]!.t).toBe(0);
    expect(d.at(-1)!.t).toBe(long.at(-1)!.t);
    expect(focusExpr(d, "x").length).toBeLessThan(8000);
  });

  it("play points: speed, span and content_box", () => {
    const track = [
      { t: 0, x: 0.5, y: 0.5 },
      { t: 2, x: 0.6, y: 0.5 },
      { t: 4, x: 0.7, y: 0.5 },
      { t: 6, x: 0.8, y: 0.5 },
    ];
    const p = toPlayPoints(track, { speed: 2, spanSec: 3 });
    expect(p.map((k) => k.t)).toEqual([0, 1, 2]); // one keyframe kept past the span
    const boxed = toPlayPoints([{ t: 0, x: 0.5, y: 0.25 }], { media: { width: 400, height: 200, content_box: { x: 0, y: 25, w: 400, h: 150 } } });
    expect(boxed[0]!.y).toBeCloseTo((50 - 25) / 150);
  });

  it("edge hits: a subject at the source edge cannot be centred", () => {
    const frame = { w: 1920, h: 1080 };
    const tgt = { width: 1080, height: 1920 };
    expect(subjectEdgeHits([{ t: 0, x: 0.5, y: 0.5 }], frame, tgt)).toEqual([]);
    const hits = subjectEdgeHits([{ t: 0, x: 0.01, y: 0.5 }], frame, tgt);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ axis: "x" });
    expect(hits[0]!.pos).toBeLessThan(REFRAME.edge_margin);
  });
});

describe("focus_track render", () => {
  const target = targetForAspect("9:16", { shortSide: 180, fps: 15 });
  const W = target.width;
  const H = target.height;
  const renderer = createFootageRenderer({ encodePreset: "ultrafast" });
  const tokens = resolveTokens();
  const media: MediaInfo = { duration_sec: 2, width: 320, height: 180, fps: 15, has_video: true, has_audio: false };
  let tmp: string;
  let clip: string;
  // The box's centre moves from x = 120 to 240 px of the 320 px source over 2 s.
  const boxX = (t: number) => (120 + 60 * t) / 320;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "vs-reframe-"));
    clip = join(tmp, "box.mp4");
    await runFfmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=320x180:r=15:d=2[bg];color=c=white:s=40x40:r=15:d=2[b];[bg][b]overlay=x='100+60*t':y=70:shortest=1",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      clip,
    ]);
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const scene = (footage: FootageClip): Scene => ({
    id: "s01",
    duration_sec: 2,
    purpose: "point",
    voiceover: "",
    visual_strategy: "user_asset",
    visual_requirements: { continuity_refs: [] },
    claim_refs: [],
    footage,
  });

  /** Mean x of bright pixels per frame (null when none). */
  async function boxCentres(path: string): Promise<Array<number | null>> {
    const raw = join(tmp, `${Math.random().toString(36).slice(2)}.gray`);
    await runFfmpeg(["-y", "-i", path, "-f", "rawvideo", "-pix_fmt", "gray", raw]);
    const buf = await readFile(raw);
    const n = W * H;
    return Array.from({ length: buf.length / n }, (_, f) => {
      let sum = 0;
      let cnt = 0;
      for (let i = 0; i < n; i++) {
        if (buf[f * n + i]! > 128) {
          sum += i % W;
          cnt++;
        }
      }
      return cnt ? sum / cnt : null;
    });
  }

  it("without focus_track the cover chain is unchanged (byte-identical renders)", () => {
    const p = planFootage({ asset: "v", in_sec: 0 }, media, clip, target, 2, "#000000");
    expect(p.chains).toContain(`[src]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bicubic,crop=${W}:${H}:(iw-${W})*0.5:(ih-${H})*0.5,setsar=1[fit]`);
    expect(p.chains.join(";")).not.toContain("clip(");
    // contain ignores a track, with a warning.
    const c = planFootage({ asset: "v", in_sec: 0, fit: "contain", focus_track: [{ t: 0, x: 0.2, y: 0.5 }] }, media, clip, target, 2, "#000000");
    expect(c.chains.join(";")).toBe(planFootage({ asset: "v", in_sec: 0, fit: "contain" }, media, clip, target, 2, "#000000").chains.join(";"));
    expect(c.warnings.join(" ")).toMatch(/focus_track only steers fit cover/);
  });

  it("composes with speed, redaction, content_box and scene motion (redact → content crop → tracked fit → motion)", () => {
    const track = [
      { t: 0, x: 0.3, y: 0.5 },
      { t: 2, x: 0.7, y: 0.5 },
    ];
    const p = planFootage(
      { asset: "v", in_sec: 0, speed: 2, focus_track: track, redact: [{ x: 0, y: 0, w: 0.2, h: 0.2 }] },
      { ...media, duration_sec: 8, content_box: { x: 0, y: 10, w: 320, h: 160 } },
      clip,
      target,
      1,
      "#000000",
      { motion: { pattern: "push_in" } },
    );
    const g = p.chains.join(";");
    // Keyframe t = 2 s of source is 1 s of play at speed 2.
    expect(g).toContain("lt(t,1)");
    const order = ["gblur", "crop=320:160:0:10", "crop=180:320:'clip(", "[mv]"].map((k) => g.indexOf(k));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it(
    "keeps a moving subject near the horizontal centre of a 9:16 crop",
    async () => {
      const focus_track = [0, 0.5, 1, 1.5, 2].map((t) => ({ t, x: boxX(t), y: 0.5 }));
      const plan = planFootage({ asset: "v", in_sec: 0, focus_track }, media, clip, target, 2, "#000000");
      expect(plan.chains.join(";")).toContain(`crop=${W}:${H}:'clip(`);
      const out = join(tmp, "tracked.mp4");
      await renderer.render({ scene: scene({ asset: "v", in_sec: 0, focus_track }), target, tokens, out_path: out, project_dir: tmp, footage: { path: clip, sha256: "x", media } });
      const tracked = await boxCentres(out);
      expect(tracked).toHaveLength(30);
      for (const c of tracked) expect(Math.abs(c! - W / 2)).toBeLessThan(22);

      // The static centre crop loses it: the box drifts across (and out of) the frame.
      const staticOut = join(tmp, "static.mp4");
      await renderer.render({ scene: scene({ asset: "v", in_sec: 0 }), target, tokens, out_path: staticOut, project_dir: tmp, footage: { path: clip, sha256: "x", media } });
      const fixed = await boxCentres(staticOut);
      expect(Math.abs(fixed[0]! - W / 2)).toBeGreaterThan(50);
    },
    60_000,
  );

  it("the renderer and lint share the prepared track", () => {
    const track = [0, 1, 2].map((t) => ({ t, x: boxX(t), y: 0.5 }));
    const pts = prepareFocusTrack(track, { media });
    const { iw, ih } = coverSize(320, 180, W, H);
    for (const k of track) {
      const crop = coverCropAt(focusAt(pts, k.t), iw, ih, W, H);
      expect(Math.abs(k.x * iw - crop.x - W / 2)).toBeLessThan(15);
    }
    expect(subjectEdgeHits(track, { w: 320, h: 180 }, { width: W, height: H })).toEqual([]);
  });
});

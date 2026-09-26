import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffprobe } from "@video-studio/media";
import type { FootageClip, MediaInfo, Scene } from "@video-studio/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FOOTAGE_RENDERER_VERSION, HDR_TONEMAP_CHAIN, createFootageRenderer, planFootage } from "./footage.js";
import { resolveTokens, targetForAspect } from "./tokens.js";

// Tiny renders only: 180x320, 1 s, 15 fps, x264 ultrafast.
const T = 60_000;
const target = targetForAspect("9:16", { shortSide: 180, fps: 15 });
const tokens = resolveTokens();
const renderer = createFootageRenderer({ encodePreset: "ultrafast" });
let tmp: string;
let rotated: string; // coded 160x90 red with a blue top-left box, display matrix 90° → shown 90x160, box bottom-left
let hdr: string; // 10-bit, PQ / BT.2020 tagged

const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-footage-color-"));
  const base = join(tmp, "base.mp4");
  ff(["-f", "lavfi", "-i", "color=red:s=160x90:d=1:r=15,drawbox=x=0:y=0:w=40:h=30:color=blue:t=fill", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", base]);
  rotated = join(tmp, "rotated.mp4");
  ff(["-display_rotation", "90", "-i", base, "-c", "copy", rotated]);
  hdr = join(tmp, "hdr.mp4");
  ff([
    "-f", "lavfi", "-i", "testsrc=s=160x90:d=1:r=15",
    "-vf", "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,format=yuv420p10le",
    "-c:v", "libx264", "-preset", "ultrafast", hdr,
  ]);
}, T);
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function scene(footage: FootageClip): Scene {
  return { id: "s01", duration_sec: 1, purpose: "point", voiceover: "", visual_strategy: "user_asset", visual_requirements: { continuity_refs: [] }, claim_refs: [], footage };
}

function rgbAt(video: string, W: number, x: number, y: number): [number, number, number] {
  const buf = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", "0.3", "-i", video, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const i = (y * W + x) * 3;
  return [buf[i]!, buf[i + 1]!, buf[i + 2]!];
}

describe("rotated and HDR footage", () => {
  it("probes rotation, displayed size and HDR tags", async () => {
    const r = await ffprobe(rotated);
    expect(r).toMatchObject({ rotation: 90, width: 160, height: 90, display_width: 90, display_height: 160, hdr: false });
    const h = await ffprobe(hdr);
    expect(h).toMatchObject({ rotation: 0, color_transfer: "smpte2084", color_primaries: "bt2020", bit_depth: 10, hdr: true });
  });

  it(
    "fits the displayed (auto-rotated) picture: the box lands bottom-left",
    async () => {
      const media: MediaInfo = { duration_sec: 1, width: 90, height: 160, rotation: 90, fps: 15, has_video: true, has_audio: false };
      const out = join(tmp, "rot-cover.mp4");
      await renderer.render({ scene: scene({ asset: "v", in_sec: 0, fit: "cover" }), target, tokens, out_path: out, project_dir: tmp, footage: { path: rotated, sha256: "r", media } });
      const W = target.width;
      const H = target.height;
      const [r1, , b1] = rgbAt(out, W, 8, H - 8);
      expect(b1).toBeGreaterThan(180);
      expect(r1).toBeLessThan(80);
      for (const [x, y] of [[8, 8], [W - 8, 8], [W - 8, H - 8]] as const) {
        const [r, , b] = rgbAt(out, W, x, y);
        expect(r).toBeGreaterThan(180);
        expect(b).toBeLessThan(80);
      }
    },
    T,
  );

  it("tonemaps HDR before everything else, warns without zscale, and leaves SDR chains unchanged", () => {
    expect(FOOTAGE_RENDERER_VERSION).toBe("0.5.0");
    const clip: FootageClip = { asset: "v", in_sec: 0, redact: [{ x: 0, y: 0, w: 0.5, h: 0.5 }] };
    const sdr: MediaInfo = { duration_sec: 1, width: 160, height: 90, has_video: true, has_audio: false };
    const base = planFootage(clip, sdr, hdr, target, 1, "#000000");
    // SDR (and tags that are not HDR): byte-identical with or without zscale.
    expect(planFootage(clip, sdr, hdr, target, 1, "#000000", {}, { zscale: true })).toEqual(base);
    expect(planFootage(clip, { ...sdr, color_transfer: "bt709" }, hdr, target, 1, "#000000", {}, { zscale: false })).toEqual(base);
    const tm = planFootage(clip, { ...sdr, hdr: true, color_transfer: "smpte2084" }, hdr, target, 1, "#000000", {}, { zscale: true });
    expect(tm.chains[0]).toBe(`[0:v]${HDR_TONEMAP_CHAIN},${base.chains[0]!.slice("[0:v]".length)}`);
    expect(tm.chains.slice(1)).toEqual(base.chains.slice(1));
    expect(tm.warnings).toEqual([]);
    const fb = planFootage(clip, { ...sdr, hdr: true, color_transfer: "arib-std-b67" }, hdr, target, 1, "#000000", {}, {});
    expect(fb.chains).toEqual(base.chains);
    expect(fb.warnings.join("\n")).toMatch(/HDR \(HLG\) source rendered without tonemapping.*zscale/);
  });

  it(
    "renders a PQ clip through the tonemap (or reports the fallback)",
    async () => {
      const media: MediaInfo = { duration_sec: 1, width: 160, height: 90, fps: 15, has_video: true, has_audio: false, hdr: true, color_transfer: "smpte2084", bit_depth: 10 };
      const out = join(tmp, "hdr-cover.mp4");
      const res = await renderer.render({ scene: scene({ asset: "h", in_sec: 0, fit: "contain" }), target, tokens, out_path: out, project_dir: tmp, footage: { path: hdr, sha256: "h", media } });
      const p = await ffprobe(out);
      expect([p.width, p.height, p.pix_fmt, p.hdr]).toEqual([target.width, target.height, "yuv420p", false]);
      const hasZ = /--enable-libzimg\b/.test(execFileSync("ffmpeg", ["-hide_banner", "-buildconf"]).toString());
      if (hasZ) expect(res.warnings.filter((w) => /HDR/.test(w))).toEqual([]);
      else expect(res.warnings.join("\n")).toMatch(/without tonemapping/);
    },
    T,
  );
});

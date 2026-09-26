import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentIR } from "@video-studio/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingest } from "./ingest.js";
import { footageQualityVerdict, parseAudioWindows, parseVideoQuality } from "./media.js";

// Tiny lavfi clips only: ≤ 160 px, ≤ 2 s, x264 ultrafast.
const T = 60_000;
let dir: string;
const clips: Record<string, string> = {};

function ff(args: string[]): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}
const x264 = ["-c:v", "libx264", "-preset", "ultrafast"];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vs-media-quality-"));
  const p = (n: string) => (clips[n] = join(dir, `${n}.mp4`));
  // Normal: testsrc picture, a tone that is on 0.3 s / off 0.2 s (quiet gaps, like speech pauses).
  ff(["-f", "lavfi", "-i", "testsrc=s=160x90:d=2:r=15", "-f", "lavfi", "-i", "sine=frequency=440:duration=2,volume='if(lt(mod(t,0.5),0.3),1,0)':eval=frame", ...x264, "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", p("normal")]);
  // Dark: a dim testsrc (near black), no audio.
  ff(["-f", "lavfi", "-i", "testsrc=s=160x90:d=2:r=15,eq=brightness=-0.6", ...x264, "-pix_fmt", "yuv420p", p("dark")]);
  // Clipped: a full-scale square wave.
  ff(["-f", "lavfi", "-i", "testsrc=s=160x90:d=2:r=15", "-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t*220\\,1)\\,0.5)\\,1\\,-1)':d=2:s=48000", ...x264, "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", p("clipped")]);
  // Rotated: coded 160x90, display matrix 90° (phone footage).
  const base = join(dir, "base.mp4");
  ff(["-f", "lavfi", "-i", "testsrc=s=160x90:d=1:r=15", ...x264, "-pix_fmt", "yuv420p", base]);
  ff(["-display_rotation", "90", "-i", base, "-c", "copy", p("rotated")]);
  // HDR: 10-bit, PQ / BT.2020 tagged.
  ff(["-f", "lavfi", "-i", "testsrc=s=160x90:d=1:r=15", "-vf", "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,format=yuv420p10le", ...x264, p("hdr")]);
}, T);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function ingestOne(name: string) {
  const { ir, summary } = await ingest([clips[name]!], { projectDir: join(dir, `p-${name}`), noCache: true });
  expect(ContentIR.safeParse(ir).success).toBe(true);
  const media = ir.assets.find((a) => a.kind === "video")!.media!;
  const quality = summary.warnings.filter((w) => w.code === "footage_quality").map((w) => w.message);
  return { ir, media, quality };
}

describe("footage quality (pure)", () => {
  it("parses signalstats, named blackframe and astats windows", () => {
    const v = parseVideoQuality(
      "[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YLOW=16\n[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YAVG=40.5\n[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YHIGH=60\n" +
        "[blackframe@dark @ 0x2] frame:0 pblack:80 pts:0 t:0.000000 type:I last_keyframe:0\n[blackframe@bright @ 0x3] frame:0 pblack:2 pts:0\n",
    );
    expect(v).toEqual({ yavg: [40.5], ylow: [16], yhigh: [60], pdark: [80], pbright: [2] });
    expect(parseAudioWindows("lavfi.astats.Overall.Peak_level=-inf\nlavfi.astats.Overall.RMS_level=-inf\nlavfi.astats.Overall.RMS_level=-20.5\n")).toEqual({ rms: [Number.NEGATIVE_INFINITY, -20.5], peak: [Number.NEGATIVE_INFINITY] });
  });

  it("judges exposure, contrast, clipping and SNR", () => {
    const v = (yavg: number, lo: number, hi: number, pd: number, pb: number) => ({ yavg: [yavg], ylow: [lo], yhigh: [hi], pdark: [pd], pbright: [pb] });
    expect(footageQualityVerdict(v(120, 30, 200, 5, 5), null)).toEqual({ luma_mean: 120, contrast: 170, dark_fraction: 0.05, bright_fraction: 0.05, exposure: "ok", notes: [] });
    expect(footageQualityVerdict(v(30, 16, 60, 80, 0), null)!.exposure).toBe("dark");
    expect(footageQualityVerdict(v(225, 200, 235, 0, 70), null)!.exposure).toBe("bright");
    expect(footageQualityVerdict(v(120, 110, 130, 0, 0), null)!.notes.join()).toMatch(/low contrast/);
    // HDR: code values are not SDR luma, so no exposure verdict.
    expect(footageQualityVerdict(v(30, 16, 60, 80, 0), null, { hdr: true })!.exposure).toBeUndefined();
    const speech = { rms: [...Array(20).fill(-20), ...Array(10).fill(Number.NEGATIVE_INFINITY)], peak: Array(30).fill(-6) };
    expect(footageQualityVerdict(null, speech)).toMatchObject({ clipped_audio: false, snr_db: 100, notes: [] });
    const hum = { rms: Array(30).fill(-20), peak: Array(30).fill(-14) };
    expect(footageQualityVerdict(null, hum)!.notes.join()).toMatch(/noisy or unclear audio/);
    const clip = { rms: Array(30).fill(-3), peak: Array(30).fill(0) };
    expect(footageQualityVerdict(null, clip)).toMatchObject({ clipped_audio: true });
    expect(footageQualityVerdict(null, null)).toBeUndefined();
  });
});

describe("footage quality, rotation and HDR at ingest", () => {
  it("normal clip: quality recorded, no warnings", async () => {
    const { media, quality } = await ingestOne("normal");
    expect(media.quality).toMatchObject({ exposure: "ok", clipped_audio: false, notes: [] });
    expect(media.quality!.snr_db!).toBeGreaterThan(30);
    expect(media.rotation).toBeUndefined();
    expect(media.hdr).toBeUndefined();
    expect(quality).toEqual([]);
  }, T);

  it("dark clip: exposure dark with a suggestion", async () => {
    const { media, quality } = await ingestOne("dark");
    expect(media.quality!.exposure).toBe("dark");
    expect(quality.join("\n")).toMatch(/underexposed.*brighter span/);
  }, T);

  it("clipped audio: flagged with replace / re-record", async () => {
    const { media, quality } = await ingestOne("clipped");
    expect(media.quality!.clipped_audio).toBe(true);
    expect(quality.join("\n")).toMatch(/audio clips.*re-record/);
  }, T);

  it("rotated clip: rotation 90 and the displayed size", async () => {
    const { ir, media } = await ingestOne("rotated");
    expect(media).toMatchObject({ rotation: 90, width: 90, height: 160 });
    expect(ir.sections[0]!.text).toMatch(/90x160 at 15 fps \(rotated 90°\)/);
  }, T);

  it("10-bit PQ clip: hdr true with its colour tags", async () => {
    const { ir, media, quality } = await ingestOne("hdr");
    expect(media).toMatchObject({ hdr: true, color_transfer: "smpte2084", color_primaries: "bt2020", bit_depth: 10 });
    expect(media.quality!.exposure).toBeUndefined();
    expect(quality).toEqual([]);
    expect(ir.sections[0]!.text).toMatch(/HDR \(PQ, 10-bit/);
  }, T);
});

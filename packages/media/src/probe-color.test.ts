import { describe, expect, it } from "vitest";
import { hasZimg, normalizeRotation, parseProbeJson, pixFmtBitDepth } from "./ffmpeg.js";

const probe = (v: Record<string, unknown>) =>
  parseProbeJson(JSON.stringify({ streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, ...v }], format: { duration: "2" } }));

describe("probe rotation and colour", () => {
  it("normalises rotations to quarter turns", () => {
    expect([0, 90, -90, 180, -180, 270, 360, 89.6, Number.NaN].map(normalizeRotation)).toEqual([0, 90, 270, 180, 180, 270, 0, 90, 0]);
  });

  it("reads the display matrix (and the legacy clockwise rotate tag) and swaps the displayed size", () => {
    expect(probe({ side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] })).toMatchObject({ rotation: 270, display_width: 1080, display_height: 1920 });
    expect(probe({ side_data_list: [{ side_data_type: "Display Matrix", rotation: 180 }] })).toMatchObject({ rotation: 180, display_width: 1920, display_height: 1080 });
    expect(probe({ tags: { rotate: "90" } })).toMatchObject({ rotation: 270, display_width: 1080 });
    expect(probe({})).toMatchObject({ rotation: 0, display_width: 1920, display_height: 1080, hdr: false, color_transfer: null });
  });

  it("flags PQ and HLG as HDR, with the bit depth", () => {
    expect(probe({ pix_fmt: "yuv420p10le", color_transfer: "smpte2084", color_primaries: "bt2020" })).toMatchObject({ hdr: true, bit_depth: 10, color_primaries: "bt2020" });
    expect(probe({ pix_fmt: "yuv420p10le", color_transfer: "arib-std-b67" }).hdr).toBe(true);
    expect(probe({ pix_fmt: "yuv420p", color_transfer: "bt709" })).toMatchObject({ hdr: false, bit_depth: 8 });
    expect(probe({ color_transfer: "unknown", color_primaries: "unknown" })).toMatchObject({ color_transfer: null, color_primaries: null });
    expect([pixFmtBitDepth("p010le"), pixFmtBitDepth("yuv422p12le"), pixFmtBitDepth("gbrpf32le"), pixFmtBitDepth("nv12"), pixFmtBitDepth(null)]).toEqual([10, 12, null, 8, null]);
  });

  it("detects zscale from the build configuration", () => {
    expect(hasZimg("--enable-libx264 --enable-libzimg --enable-libass")).toBe(true);
    expect(hasZimg("--enable-libx264")).toBe(false);
  });
});

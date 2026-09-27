import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LOOP_SEAM_TOLERANCE,
  captureChromeArgs,
  compareCaptures,
  decodePng,
  determinismFindings,
  determinismPlan,
  frameAlignedTime,
  judgeLoopSeam,
  pixelDiff,
  readinessScript,
  runDeterminismCheck,
  seekScript,
  serveDirectory,
  servedFile,
  sha256,
} from "./capture.js";

/** A tiny PNG encoder for tests: 8-bit RGBA (colour 6) or RGB (colour 2), one filter type for every row. */
export function encodePng(width: number, height: number, rgba: Uint8Array, o: { rgb?: boolean; filter?: number } = {}): Buffer {
  const ch = o.rgb ? 3 : 4;
  const stride = width * ch;
  const px = new Uint8Array(height * stride);
  for (let i = 0; i < width * height; i++) for (let k = 0; k < ch; k++) px[i * ch + k] = rgba[i * 4 + k]!;
  const raw = Buffer.alloc(height * (stride + 1));
  const filter = o.filter ?? 0;
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const v = px[y * stride + x]!;
      const a = x >= ch ? px[y * stride + x - ch]! : 0;
      const up = y > 0 ? px[(y - 1) * stride + x]! : 0;
      const c = x >= ch && y > 0 ? px[(y - 1) * stride + x - ch]! : 0;
      const pred =
        filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? up : filter === 3 ? (a + up) >> 1 : (() => {
          const p = a + up - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - c);
          return pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
        })();
      raw[y * (stride + 1) + 1 + x] = (v - pred) & 0xff;
    }
  }
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    return Buffer.concat([len, Buffer.from(type, "latin1"), body, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = o.rgb ? 2 : 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** width×height RGBA with a gradient, plus `changed` pixels set to white. */
function image(width: number, height: number, changed: number[] = [], delta = 90): Uint8Array {
  const d = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    d[i * 4] = (i * 7) % 160;
    d[i * 4 + 1] = (i * 13) % 256;
    d[i * 4 + 2] = (i * 29) % 256;
    d[i * 4 + 3] = 255;
  }
  for (const i of changed) d[i * 4] = Math.min(255, d[i * 4]! + delta);
  return d;
}

describe("time planning", () => {
  it("aligns times to the frame grid inside the scene", () => {
    expect(frameAlignedTime(0.51, 30, 2)).toBe(0.5);
    expect(frameAlignedTime(-1, 30, 2)).toBe(0);
    expect(frameAlignedTime(5, 30, 2)).toBe(1.966667);
    expect(frameAlignedTime(5, 30, 2, true)).toBe(2);
    expect(frameAlignedTime(Number.NaN, 24, 1)).toBe(0);
  });

  it("seeks every time twice from different predecessors", () => {
    const p = determinismPlan(2, 30);
    expect(p.order).toEqual([0.5, 1, 1.5, 0.5, 1.5, 1]);
    const preds = new Map<number, Set<number | null>>();
    p.order.forEach((t, i) => preds.set(t, (preds.get(t) ?? new Set()).add(i ? p.order[i - 1]! : null)));
    for (const [, s] of preds) expect(s.size).toBe(2);
    expect(p.loop).toBeUndefined();
    expect(determinismPlan(2, 30, true).loop).toEqual([0, 2]);
  });

  it("still compares two times on a one-frame scene", () => {
    const p = determinismPlan(1 / 30, 30);
    expect(p.order.length).toBeGreaterThanOrEqual(4);
    expect(new Set(p.order).size).toBe(1);
    const short = determinismPlan(0.1, 30);
    expect(new Set(short.order).size).toBeGreaterThanOrEqual(2);
  });
});

describe("hash comparison", () => {
  it("reports times with more than one distinct hash", () => {
    expect(compareCaptures([{ t: 1, sha256: "a" }, { t: 2, sha256: "b" }, { t: 1, sha256: "a" }])).toEqual([]);
    expect(compareCaptures([{ t: 1, sha256: "a" }, { t: 0.5, sha256: "x" }, { t: 1, sha256: "b" }, { t: 0.5, sha256: "y" }])).toEqual([
      { t: 0.5, hashes: ["x", "y"] },
      { t: 1, hashes: ["a", "b"] },
    ]);
  });
});

describe("PNG decode and pixel diff", () => {
  it("decodes RGBA and RGB with every filter type", () => {
    const px = image(7, 5);
    for (const filter of [0, 1, 2, 3, 4]) {
      const d = decodePng(encodePng(7, 5, px, { filter }))!;
      expect([d.width, d.height]).toEqual([7, 5]);
      expect(Buffer.from(d.data).equals(Buffer.from(px))).toBe(true);
      const rgb = decodePng(encodePng(7, 5, px, { rgb: true, filter }))!;
      expect(Buffer.from(rgb.data).equals(Buffer.from(px))).toBe(true);
    }
  });

  it("returns null for data that is not a supported PNG", () => {
    expect(decodePng(Buffer.from("not a png"))).toBeNull();
  });

  it("counts pixels beyond the channel tolerance", () => {
    const a = decodePng(encodePng(10, 10, image(10, 10)))!;
    const b = decodePng(encodePng(10, 10, image(10, 10, [3, 50], 2)))!;
    expect(pixelDiff(a, b, 0)).toEqual({ differing: 2, fraction: 0.02, max: 2 });
    expect(pixelDiff(a, b, 2)).toEqual({ differing: 0, fraction: 0, max: 2 });
    expect(pixelDiff(a, decodePng(encodePng(5, 20, image(5, 20)))!)).toBeNull();
  });
});

describe("loop seam verdict", () => {
  const W = 100;
  const H = 100;
  it("passes identical frames by hash", () => {
    const png = encodePng(W, H, image(W, H));
    expect(judgeLoopSeam(png, Buffer.from(png))).toEqual({ ok: true, sha_equal: true });
  });
  it("tolerates rounding on a few edge pixels, not a moved shape", () => {
    const base = encodePng(W, H, image(W, H));
    // 1-level noise everywhere-ish is ignored by the channel tolerance.
    expect(judgeLoopSeam(base, encodePng(W, H, image(W, H, Array.from({ length: 3000 }, (_, i) => i), 1))).ok).toBe(true);
    // Up to 0.05% of pixels (5 of 10 000) may differ strongly.
    const few = Array.from({ length: Math.floor(W * H * LOOP_SEAM_TOLERANCE.fraction) }, (_, i) => i * 37);
    expect(judgeLoopSeam(base, encodePng(W, H, image(W, H, few, 80))).ok).toBe(true);
    const seam = judgeLoopSeam(base, encodePng(W, H, image(W, H, Array.from({ length: 400 }, (_, i) => i), 80)));
    expect(seam).toMatchObject({ ok: false, sha_equal: false, differing_fraction: 0.04, max_channel_diff: 80 });
  });
  it("fails when the frames cannot be compared pixel by pixel", () => {
    expect(judgeLoopSeam(Buffer.from("a"), Buffer.from("b"))).toEqual({ ok: false, sha_equal: false });
  });
});

describe("runDeterminismCheck", () => {
  const frame = (t: number, salt = "") => Buffer.from(`frame@${t}${salt}`);
  it("passes a pure seek(t)", async () => {
    const seen: number[] = [];
    const r = await runDeterminismCheck(async (t) => (seen.push(t), frame(t)), { duration: 2, fps: 30 });
    expect(r).toMatchObject({ ok: true, mismatches: [], order: [0.5, 1, 1.5, 0.5, 1.5, 1] });
    expect(seen).toEqual(r.order);
    expect(determinismFindings("s01", r)).toEqual([]);
  });

  it("fails a page that carries state between seeks", async () => {
    let calls = 0;
    const r = await runDeterminismCheck(async (t) => frame(t, t === 1 ? `#${calls++}` : ""), { duration: 2, fps: 30 });
    expect(r.ok).toBe(false);
    expect(r.mismatches.map((m) => m.t)).toEqual([1]);
    const [f] = determinismFindings("s01", r);
    expect(f).toMatchObject({ id: "nondeterministic_scene", severity: "error" });
    expect(f!.message).toMatch(/scene s01: .* at 1s \(2 different frames\)/);
    expect(f!.fix).toMatch(/clock.*random.*state carried between frames/);
  });

  it("checks the loop seam at 0 and the duration", async () => {
    const W = 20;
    const seen: number[] = [];
    const good = await runDeterminismCheck(async (t) => (seen.push(t), t === 0 || t === 2 ? encodePng(W, W, image(W, W)) : frame(t)), { duration: 2, fps: 30, loop: true });
    expect(seen.slice(-2)).toEqual([0, 2]);
    expect(good.loop_seam).toEqual({ ok: true, sha_equal: true, first_t: 0, last_t: 2 });
    const bad = await runDeterminismCheck(async (t) => (t === 2 ? encodePng(W, W, image(W, W, [1, 2, 3, 4, 5], 90)) : t === 0 ? encodePng(W, W, image(W, W)) : frame(t)), { duration: 2, fps: 30, loop: true });
    expect(bad.ok).toBe(true);
    const f = determinismFindings("s02", bad);
    expect(f).toEqual([expect.objectContaining({ id: "loop_seam", severity: "warning", message: expect.stringMatching(/1\.25% of pixels differ \(up to 90 levels\)/) })]);
  });
});

describe("capture page plumbing", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "vs-capture-"));
    await mkdir(join(root, "site", "sub"), { recursive: true });
    await writeFile(join(root, "site", "index.html"), "<p>hi</p>");
    await writeFile(join(root, "site", "sub", "a b.css"), "body{}");
    await writeFile(join(root, "secret.txt"), "no");
    await symlink(join(root, "secret.txt"), join(root, "site", "link.txt"));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it("maps request paths inside the served folder only", () => {
    const site = join(root, "site");
    expect(servedFile(site, "/")).toMatch(/site\/index\.html$/);
    expect(servedFile(site, "/sub/a%20b.css?x=1")).toMatch(/sub\/a b\.css$/);
    for (const bad of ["/../secret.txt", "/%2e%2e/secret.txt", "/sub/../../secret.txt", "/link.txt", "/missing.js", "/sub", "/%E0%A4%A"]) expect(servedFile(site, bad)).toBeNull();
  });

  it("serves files over loopback with their types and refuses the rest", async () => {
    const s = await serveDirectory(join(root, "site"));
    try {
      expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const ok = await fetch(`${s.url}/index.html`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toMatch(/text\/html/);
      expect(await ok.text()).toBe("<p>hi</p>");
      expect((await fetch(`${s.url}/sub/a%20b.css`)).headers.get("content-type")).toMatch(/text\/css/);
      expect((await fetch(`${s.url}/link.txt`)).status).toBe(404);
      expect((await fetch(`${s.url}/index.html`, { method: "POST" })).status).toBe(405);
    } finally {
      await s.close();
    }
  });

  it("builds page scripts that go through the registered timeline", () => {
    const ready = readinessScript('vs-"x', 5000);
    expect(ready).toContain('window.__timelines[id]');
    expect(ready).toContain('var id = "vs-\\"x"');
    expect(ready).toContain("__hf.buildReady[id]");
    expect(ready).toContain("document.fonts.ready");
    const seek = seekScript("vs-s01", 1.25);
    expect(seek).toContain('window.__timelines["vs-s01"]');
    expect(seek).toContain("tl.seek(1.25)");
    expect(seekScript("vs-s01", Number.NaN)).toContain("tl.seek(0)");
  });

  it("launches with the producer's pixel-relevant flags at the target size", () => {
    const args = captureChromeArgs(180, 320);
    expect(args).toEqual(expect.arrayContaining(["--use-angle=swiftshader", "--font-render-hinting=none", "--force-color-profile=srgb", "--window-size=180,320", "--hide-scrollbars"]));
    expect(args).not.toContain("--no-sandbox");
  });

  it("hashes bytes", () => {
    expect(sha256(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

// ---------------------------------------------------------------------------------------------
// Real Chrome (cannot run inside the Claude Code sandbox):
//   VS_TEST_RENDER=1 npx vitest run packages/renderer/src/capture.test.ts
// ---------------------------------------------------------------------------------------------
describe.skipIf(process.env.VS_TEST_RENDER !== "1")("real Chrome captures (VS_TEST_RENDER=1)", () => {
  const MOTION = new URL("./__fixtures__/motion/", import.meta.url);
  const TOKENS = {
    font_heading: "Helvetica, Arial, sans-serif",
    font_body: "Helvetica, Arial, sans-serif",
    font_mono: "Menlo, monospace",
    color_background: "#0B0F19",
    color_text: "#F5F7FA",
    color_primary: "#4F8CFF",
    color_secondary: "#22C55E",
  };
  const target = { width: 180, height: 320, fps: 30, aspect_ratio: "9:16" as const };

  async function composed(html: string, props: Record<string, unknown> = {}) {
    const { cp } = await import("node:fs/promises");
    const { composeScene, writeComposition, findChrome } = await import("./hyperframes-renderer.js");
    const project = await mkdtemp(join(tmpdir(), "vs-capture-real-"));
    await cp(MOTION, join(project, "motion"), { recursive: true });
    await writeFile(
      join(project, "motion", "counter.html"),
      `<!doctype html><html><body><div id="b" style="position:absolute;width:40px;height:40px;background:#fff"></div><script src="counter.js"></script></body></html>`,
    );
    // Passes the static lint but carries state between seeks: every seek moves the box further.
    await writeFile(join(project, "motion", "counter.js"), `var n = 0; window.seek = function (t) { n += 1; document.getElementById("b").style.left = (n * 7 + t * 10) + "px"; };`);
    const scene = { id: "s01", duration_sec: 2, purpose: "hook", voiceover: "", visual_strategy: "motion_graphic", deterministic: { kind: "motion", props: { html, text: ["Docs in.", "Video out."], ...props } }, visual_requirements: { continuity_refs: [] }, claim_refs: [] } as any;
    const req = { scene, target, tokens: TOKENS, out_path: join(project, "s01.mp4"), project_dir: project };
    const page = await composeScene(req);
    const dir = join(project, "comp");
    await mkdir(dir);
    await writeComposition(dir, page);
    const chrome = await findChrome(undefined, process.env);
    if (!chrome.ok) throw new Error(chrome.reason);
    return { project, dir, page, chromePath: chrome.path };
  }

  it("draws the example page at the target size and passes the determinism check", async () => {
    const { openCaptureSession } = await import("./capture.js");
    const c = await composed("motion/morph.html");
    const session = await openCaptureSession({ chromePath: c.chromePath, width: 180, height: 320 });
    try {
      const pc = await session.open(c.dir, c.page.composition_id, 180, 320);
      const png = await pc.capture(0.5);
      const img = decodePng(png)!;
      expect([img.width, img.height]).toEqual([180, 320]);
      const r = await runDeterminismCheck((t) => pc.capture(t), { duration: 2, fps: 30 });
      expect(r.mismatches).toEqual([]);
      expect(pc.errors).toEqual([]);
      // Different times draw different frames (the page really moves).
      expect(sha256(await pc.capture(0.1))).not.toBe(sha256(await pc.capture(1.5)));
    } finally {
      await session.close();
      await rm(c.project, { recursive: true, force: true });
    }
  }, 120_000);

  it("catches a page that carries state between seeks", async () => {
    const { openCaptureSession } = await import("./capture.js");
    const c = await composed("motion/counter.html");
    const session = await openCaptureSession({ chromePath: c.chromePath, width: 180, height: 320 });
    try {
      const pc = await session.open(c.dir, c.page.composition_id, 180, 320);
      const r = await runDeterminismCheck((t) => pc.capture(t), { duration: 2, fps: 30 });
      expect(r.ok).toBe(false);
      expect(determinismFindings("s01", r)[0]!.id).toBe("nondeterministic_scene");
    } finally {
      await session.close();
      await rm(c.project, { recursive: true, force: true });
    }
  }, 120_000);
});

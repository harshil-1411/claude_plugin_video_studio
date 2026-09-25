import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunOptions, escapeFilterOption, escapeFiltergraph, ffprobe, runFfmpeg, secs } from "@video-studio/media";
import { type LayoutZones, type PxRect, intersect } from "@video-studio/platforms";
import { COMPLEX_SCRIPTS, type FontResolver, type VisualTokens, createFontResolver, dominantScript, ffColor, fitText, prepareLibassFontsDir, scriptFontFamilies } from "@video-studio/renderer";
import type { AspectRatio, PlatformContract, TextBox } from "@video-studio/schema";

/**
 * Cover compiler (PLAN M6). The cover is a dedicated deterministic frame: the clean master's
 * frame at `cover.focal_time_sec` with `cover.headline` drawn by FFmpeg drawtext on a plate,
 * fitted (`fitText`) into the hook zone where it overlaps every crop the targets cut the cover
 * to (plus the centre square preview). Outputs, at the master's size:
 *   - `thumbnail.png`: the composed cover as PNG (the `thumbnail` output kept for back-compat),
 *   - `cover.jpg`: JPEG under the targets' cover size limit (from the contracts),
 *   - `cover-square-preview.jpg`: the centre-square crop (profile grids).
 * The headline's box is returned for lint. Platform limits come from the contracts only.
 */

export const COVER_VERSION = 2;

export interface CoverCropRect extends PxRect {
  id: string;
  aspect_ratio: AspectRatio;
  anchor: "center" | "top" | "bottom";
  /** Contract ids that use this crop (`preview` for the built-in centre square). */
  targets: string[];
}

export interface CoverOptions extends Pick<RunOptions, "signal" | "tools"> {
  /** Clean master video (no burned captions). */
  master: string;
  /** Output directory for thumbnail.png, cover.jpg and cover-square-preview.jpg. */
  outDir: string;
  /** Frame time in ms (clamped into the video). */
  atMs: number;
  headline: string;
  zones: LayoutZones;
  tokens: VisualTokens;
  contracts?: readonly PlatformContract[];
  /** Resolves a font chain + weight to a file (default: bundled fonts, then host fonts). */
  fontResolver?: FontResolver;
  env?: NodeJS.ProcessEnv;
}

export interface CoverResult {
  thumbnail: string;
  cover: string;
  square_preview: string;
  width: number;
  height: number;
  at_ms: number;
  bytes: number;
  /** JPEG quality scale used (-q:v, 2 = best). */
  jpeg_q: number;
  /** Limit from the contracts, if any. */
  max_bytes?: number;
  /** The headline plate (text inside it), for lint. Absent when the headline could not be drawn. */
  headline_box?: TextBox;
  /** Region the headline was fitted into. */
  region: PxRect;
  crops: CoverCropRect[];
  warnings: string[];
}

/** The largest `aspect` rect inside a W×H frame, anchored centre/top/bottom. */
export function cropRect(width: number, height: number, aspect: AspectRatio, anchor: "center" | "top" | "bottom" = "center"): PxRect {
  const [aw, ah] = aspect.split(":").map(Number) as [number, number];
  let w = width;
  let h = Math.round((width * ah) / aw);
  if (h > height) {
    h = height;
    w = Math.round((height * aw) / ah);
  }
  const x = Math.round((width - w) / 2);
  const y = anchor === "top" ? 0 : anchor === "bottom" ? height - h : Math.round((height - h) / 2);
  return { x, y, w, h };
}

/** Crops the headline must survive: every target's cover crops plus the centre-square preview. */
export function coverCrops(width: number, height: number, contracts: readonly PlatformContract[] = []): CoverCropRect[] {
  const out: CoverCropRect[] = [{ id: "square-preview", aspect_ratio: "1:1", anchor: "center", targets: ["preview"], ...cropRect(width, height, "1:1", "center") }];
  for (const c of contracts) {
    for (const crop of c.cover.crops ?? []) {
      const same = out.find((o) => o.aspect_ratio === crop.aspect_ratio && o.anchor === crop.anchor);
      if (same) same.targets.push(c.id);
      else out.push({ id: crop.id, aspect_ratio: crop.aspect_ratio, anchor: crop.anchor, targets: [c.id], ...cropRect(width, height, crop.aspect_ratio, crop.anchor) });
    }
  }
  return out;
}

/** Smallest cover file limit among targets that take an uploaded cover (bytes), if any. */
export function coverMaxBytes(contracts: readonly PlatformContract[] = []): number | undefined {
  const mbs = contracts.filter((c) => c.cover.mode === "file" || c.cover.mode === "file_or_frame").map((c) => c.cover.max_size_mb).filter((m): m is number => m !== undefined);
  return mbs.length ? Math.floor(Math.min(...mbs) * 1024 * 1024) : undefined;
}

/**
 * Where the headline goes: the hook zone intersected with every crop. When that leaves less than
 * `minHeight` (a top hook zone vs a centre square), the content zone ∩ crops is used from its
 * top, as tall as the hook zone (at least `minHeight`).
 */
export function headlineRegion(zones: LayoutZones, crops: readonly PxRect[], minHeight: number): PxRect {
  const within = (r: PxRect | null) => crops.reduce<PxRect | null>((acc, c) => (acc ? intersect(acc, c) : null), r);
  const hook = within(zones.hook);
  if (hook && hook.h >= minHeight) return hook;
  const content = within(zones.content);
  if (content) return { ...content, h: Math.min(content.h, Math.max(zones.hook.h, minHeight)) };
  return hook ?? zones.hook;
}

/** `name=k=v:...` with both escaping levels applied per value. */
function f(name: string, opts: Record<string, string | number | undefined>): string {
  const parts = Object.entries(opts)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${escapeFiltergraph(escapeFilterOption(String(v)))}`);
  return `${name}=${parts.join(":")}`;
}

const BITEXACT = ["-fflags", "+bitexact", "-flags:v", "+bitexact", "-map_metadata", "-1"];

/** Compose and write the cover files. */
export async function renderCover(o: CoverOptions): Promise<CoverResult> {
  const warnings: string[] = [];
  const run = { ...(o.signal ? { signal: o.signal } : {}), ...(o.tools ? { tools: o.tools } : {}) };
  const probe = await ffprobe(o.master, run);
  if (!probe.width || !probe.height) throw new Error(`cover: ${o.master} has no video stream`);
  const W = probe.width;
  const H = probe.height;
  const maxMs = Math.max(0, Math.floor(probe.duration_s * 1000) - 100);
  const at = Math.min(Math.max(0, Math.round(o.atMs)), maxMs);
  const crops = coverCrops(W, H, o.contracts);
  const short = Math.min(W, H);
  // Type scale from the v2 design defaults (hook 84–108 px at 1080): relative to the short side.
  const maxSize = Math.max(10, Math.round(short * 0.096));
  const minSize = Math.max(8, Math.round(short * 0.044));
  const padX = Math.round(short * 0.03);
  const padY = Math.round(short * 0.022);
  // The hook zone must hold two lines at the largest size, else the headline moves to the top of content ∩ crops.
  const region = headlineRegion(o.zones, crops, Math.round(maxSize * 2 * 1.12 + 2 * padY));
  const fit = fitText(o.headline.trim(), { w: Math.max(1, region.w - 2 * padX), h: Math.max(1, region.h - 2 * padY) }, { maxSize, minSize, maxLines: 3, lineHeight: 1.12 });
  if (fit.truncated) warnings.push(`cover: headline "${o.headline}" does not fit at ${minSize}px; truncated (shorten cover.headline)`);

  await mkdir(o.outDir, { recursive: true });
  const thumbnail = join(o.outDir, "thumbnail.png");
  const cover = join(o.outDir, "cover.jpg");
  const square = join(o.outDir, "cover-square-preview.jpg");
  const tmp = await mkdtemp(join(tmpdir(), "vs-cover-"));
  let headline_box: TextBox | undefined;
  try {
    const filters: string[] = [];
    let font: string | null = null;
    try {
      font = await (o.fontResolver ?? createFontResolver(o.env ?? process.env))(o.tokens.font_heading, 700);
    } catch (e) {
      warnings.push(`cover: no font for "${o.tokens.font_heading}" (${e instanceof Error ? e.message : String(e)}); cover has no headline`);
    }
    if (font && fit.lines.length) {
      const cx = Math.round(region.x + region.w / 2);
      const blockW = Math.min(region.w, Math.ceil(fit.width + 2 * padX));
      const blockH = Math.min(region.h, Math.ceil(fit.height + 2 * padY));
      const bx = Math.round(cx - blockW / 2);
      const by = Math.round(region.y + (region.h - blockH) / 2);
      // Blur and dim the frame so its own text reads as texture, not a competing headline,
      // then an opaque plate behind the headline itself.
      filters.push(`gblur=sigma=${Math.max(2, Math.round(Math.min(W, H) * 0.025))}`);
      filters.push(f("drawbox", { x: 0, y: 0, w: W, h: H, color: ffColor(o.tokens.color_background, 0.7), t: "fill" }));
      filters.push(f("drawbox", { x: bx, y: by, w: blockW, h: blockH, color: ffColor(o.tokens.color_background, 1), t: "fill" }));
      const top = by + (blockH - fit.height) / 2;
      const script = dominantScript(o.headline);
      if (COMPLEX_SCRIPTS.has(script) && script !== "other") {
        // drawtext cannot shape Devanagari or join/reorder Arabic: draw the headline with libass.
        const fontsDir = await prepareLibassFontsDir(join(tmp, "fonts"));
        const family = scriptFontFamilies(script)[0] ?? "Noto Sans";
        const bgr = (hex: string) => `&H00${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();
        const ass = [
          "[Script Info]",
          "ScriptType: v4.00+",
          `PlayResX: ${W}`,
          `PlayResY: ${H}`,
          "WrapStyle: 2",
          "",
          "[V4+ Styles]",
          "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
          `Style: H,${family},${fit.fontSize},${bgr(o.tokens.color_text)},${bgr(o.tokens.color_text)},&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,8,0,0,0,1`,
          "",
          "[Events]",
          "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
          `Dialogue: 0,0:00:00.00,0:00:10.00,H,,0,0,0,,{\\an8\\pos(${cx},${Math.round(top)})}${fit.lines.join("\\N")}`,
          "",
        ].join("\n");
        const assFile = join(tmp, "headline.ass");
        await writeFile(assFile, ass, "utf8");
        filters.push(`ass=filename=${escapeFiltergraph(escapeFilterOption(assFile))}:fontsdir=${escapeFiltergraph(escapeFilterOption(fontsDir))}`);
      }
      for (const [i, line] of (COMPLEX_SCRIPTS.has(script) && script !== "other" ? [] : fit.lines).entries()) {
        const file = join(tmp, `l${i}.txt`);
        await writeFile(file, line, "utf8");
        filters.push(
          f("drawtext", {
            fontfile: font,
            textfile: file,
            expansion: "none",
            fontsize: fit.fontSize,
            fontcolor: ffColor(o.tokens.color_text),
            x: `${cx}-text_w/2`,
            y: Math.round(top + i * fit.lineAdvance),
            y_align: "font",
          }),
        );
      }
      headline_box = {
        role: "headline",
        text: o.headline.trim(),
        rect: { x: bx, y: by, w: blockW, h: blockH },
        font_px: fit.fontSize,
        truncated: fit.truncated,
        color: o.tokens.color_text,
        background: o.tokens.color_background,
      };
    }
    filters.push("format=rgb24");
    await runFfmpeg(["-y", "-ss", secs(at), "-i", o.master, "-frames:v", "1", "-vf", filters.join(","), ...BITEXACT, "-update", "1", "-c:v", "png", thumbnail], run);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  // JPEG under the contracts' limit: step the quality scale down until it fits.
  const max_bytes = coverMaxBytes(o.contracts);
  let q = 2;
  let bytes = 0;
  for (;;) {
    await runFfmpeg(["-y", "-i", thumbnail, "-frames:v", "1", "-vf", "format=yuvj420p", ...BITEXACT, "-update", "1", "-c:v", "mjpeg", "-q:v", String(q), cover], run);
    bytes = (await stat(cover)).size;
    if (max_bytes === undefined || bytes <= max_bytes) break;
    if (q >= 31) {
      warnings.push(`cover: cover.jpg is ${bytes} bytes, over the targets' ${max_bytes}-byte limit even at the lowest quality`);
      break;
    }
    q = Math.min(31, q + 3);
  }
  const sq = crops[0]!;
  await runFfmpeg(
    ["-y", "-i", thumbnail, "-frames:v", "1", "-vf", `crop=${sq.w}:${sq.h}:${sq.x}:${sq.y},format=yuvj420p`, ...BITEXACT, "-update", "1", "-c:v", "mjpeg", "-q:v", "2", square],
    run,
  );
  return {
    thumbnail,
    cover,
    square_preview: square,
    width: W,
    height: H,
    at_ms: at,
    bytes,
    jpeg_q: q,
    ...(max_bytes !== undefined ? { max_bytes } : {}),
    ...(headline_box ? { headline_box } : {}),
    region,
    crops,
    warnings,
  };
}

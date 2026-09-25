import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type LoudnessStats, parseEbur128Summary } from "./audio.js";
import { type ProbeResult, type RunOptions, ffprobe, runFfmpeg } from "./ffmpeg.js";

export type QaCheckStatus = "ok" | "warn" | "fail";

export interface QaCheck {
  id: string;
  status: QaCheckStatus;
  detail: string;
  fix?: string;
}

export interface TimeRange {
  start_s: number;
  end_s: number;
  duration_s: number;
}

export interface QaExpectations {
  width: number;
  height: number;
  duration_s: number;
  /** Default 0.5 s. */
  tolerance_s?: number;
  /** Default -14 LUFS. */
  loudness_target?: number;
  /** Default 1.5 LU. */
  loudness_tolerance?: number;
  /** Default true. */
  require_audio?: boolean;
  /** The video is silent on purpose (no narration and no music): silence and loudness pass. */
  intended_silence?: boolean;
  /**
   * Scene background colour (#RRGGBB). Dark themes sit near black, so sparse scenes would read as
   * "black" at blackdetect's default threshold; the threshold is set just below this colour.
   */
  background?: string;
}

/** Default blackdetect pixel threshold (fraction of the luma range). */
export const BLACK_PIX_TH = 0.1;

/** Normalised limited-range luma (0–1) of a #RRGGBB colour, BT.709. */
export function lumaOf(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * blackdetect pix_th for a background: half its luma (so the background itself is not "black"),
 * capped at the default. `nearBlack` means the background is too dark to tell a sparse scene from
 * a blank one, so black intervals can only be a warning.
 */
export function blackThreshold(background?: string): { pix_th: number; nearBlack: boolean } {
  const l = background ? lumaOf(background) : null;
  if (l === null) return { pix_th: BLACK_PIX_TH, nearBlack: false };
  const pix_th = Math.min(BLACK_PIX_TH, Math.round((l / 2) * 1000) / 1000);
  return { pix_th: Math.max(0.005, pix_th), nearBlack: l < 0.02 };
}

export interface QaMetrics extends LoudnessStats {
  probe: ProbeResult;
  black: TimeRange[];
  freeze: TimeRange[];
  silence: TimeRange[];
}

export interface QaReport {
  status: QaCheckStatus;
  video: string;
  checks: QaCheck[];
  metrics: QaMetrics;
}

/** A single black interval at least this long fails QA (a scene that failed to render). */
export const BLACK_FAIL_S = 2;

const r3 = (n: number) => Math.round(n * 1000) / 1000;

function ranges(stderr: string, startRe: RegExp, endRe: RegExp, totalS: number): TimeRange[] {
  const events: { t: number; kind: "s" | "e"; at: number }[] = [];
  for (const m of stderr.matchAll(startRe)) events.push({ t: Number(m[1]), kind: "s", at: m.index });
  for (const m of stderr.matchAll(endRe)) events.push({ t: Number(m[1]), kind: "e", at: m.index });
  events.sort((a, b) => a.at - b.at);
  const out: TimeRange[] = [];
  let open: number | null = null;
  for (const e of events) {
    if (e.kind === "s") open = e.t;
    else if (open !== null) {
      out.push({ start_s: r3(open), end_s: r3(e.t), duration_s: r3(e.t - open) });
      open = null;
    }
  }
  // Detectors report an interval that runs to EOF only as a start.
  if (open !== null && totalS > open) out.push({ start_s: r3(open), end_s: r3(totalS), duration_s: r3(totalS - open) });
  return out;
}

/** Parse blackdetect / freezedetect / silencedetect / ebur128 output from one decode pass. */
export function parseDetections(stderr: string, totalS: number): Pick<QaMetrics, "black" | "freeze" | "silence"> & LoudnessStats {
  const black: TimeRange[] = [];
  for (const m of stderr.matchAll(/black_start:\s*(-?[\d.]+)\s+black_end:\s*(-?[\d.]+)\s+black_duration:\s*(-?[\d.]+)/g)) {
    black.push({ start_s: r3(Number(m[1])), end_s: r3(Number(m[2])), duration_s: r3(Number(m[3])) });
  }
  // blackdetect only logs an interval once it ends; one that reaches EOF is flushed at uninit in recent builds.
  return {
    black,
    freeze: ranges(stderr, /freeze_start:\s*(-?[\d.]+)/g, /freeze_end:\s*(-?[\d.]+)/g, totalS),
    silence: ranges(stderr, /silence_start:\s*(-?[\d.]+)/g, /silence_end:\s*(-?[\d.]+)/g, totalS),
    ...parseEbur128Summary(stderr),
  };
}

const fmtRanges = (rs: TimeRange[]) => rs.map((r) => `${r.start_s.toFixed(2)}–${r.end_s.toFixed(2)}s`).join(", ");

/**
 * Technical QA in one ffprobe plus one decode pass (blackdetect, freezedetect, silencedetect,
 * ebur128). Freeze and silence are warnings: static motion-graphic scenes legitimately freeze.
 */
export async function technicalQa(videoPath: string, expect: QaExpectations, opts: RunOptions = {}): Promise<QaReport> {
  const tol = expect.tolerance_s ?? 0.5;
  const target = expect.loudness_target ?? -14;
  const ltol = expect.loudness_tolerance ?? 1.5;
  const requireAudio = expect.require_audio ?? true;
  const probe = await ffprobe(videoPath, opts);
  const checks: QaCheck[] = [];

  if (!probe.has_video) {
    checks.push({ id: "video_stream", status: "fail", detail: "no video stream", fix: "Re-run the render; the output has no video." });
  } else {
    const sizeOk = probe.width === expect.width && probe.height === expect.height;
    checks.push({
      id: "resolution",
      status: sizeOk ? "ok" : "fail",
      detail: `${probe.width}x${probe.height} (expected ${expect.width}x${expect.height})`,
      ...(sizeOk ? {} : { fix: "Re-assemble with the target width/height (concatVideos normalises every segment)." }),
    });
    const ar = probe.width! / probe.height!;
    const want = expect.width / expect.height;
    const arOk = Math.abs(ar - want) / want < 0.01;
    checks.push({ id: "aspect", status: arOk ? "ok" : "fail", detail: `aspect ${ar.toFixed(4)} (expected ${want.toFixed(4)})`, ...(arOk ? {} : { fix: "Scale and pad/crop to the target aspect ratio." }) });
    const h264 = probe.video_codec === "h264";
    checks.push({ id: "video_codec", status: h264 ? "ok" : "warn", detail: `${probe.video_codec} ${probe.pix_fmt ?? ""}`.trim(), ...(h264 ? {} : { fix: "Encode with libx264 (encodeFinal) for platform compatibility." }) });
    if (probe.pix_fmt && probe.pix_fmt !== "yuv420p") {
      checks.push({ id: "pix_fmt", status: "warn", detail: `${probe.pix_fmt}; most platforms expect yuv420p`, fix: "Add `format=yuv420p` / `-pix_fmt yuv420p`." });
    }
  }
  const dd = Math.abs(probe.duration_s - expect.duration_s);
  checks.push({
    id: "duration",
    status: dd <= tol ? "ok" : "fail",
    detail: `${probe.duration_s.toFixed(3)}s (expected ${expect.duration_s.toFixed(3)}s ± ${tol}s)`,
    ...(dd <= tol ? {} : { fix: "Check scene durations and the voice track length; the concat enforces exact slots." }),
  });
  if (!probe.has_audio) {
    checks.push({
      id: "audio_stream",
      status: requireAudio ? "fail" : "ok",
      detail: "no audio stream",
      ...(requireAudio ? { fix: "Mux the voice track (muxAudio), or a silent track for a silent video." } : {}),
    });
  } else {
    const aacOk = probe.audio_codec === "aac" && probe.sample_rate === 48_000;
    checks.push({
      id: "audio_stream",
      status: aacOk ? "ok" : "warn",
      detail: `${probe.audio_codec} ${probe.sample_rate} Hz, ${probe.channels} ch`,
      ...(aacOk ? {} : { fix: "Encode audio as AAC 48 kHz." }),
    });
  }

  // One decode pass for every detector.
  const args = ["-i", videoPath];
  const black = blackThreshold(expect.background);
  if (probe.has_video) args.push("-map", "0:v:0", "-vf", `blackdetect=d=0.5:pix_th=${black.pix_th},freezedetect=n=-60dB:d=1.0`);
  if (probe.has_audio) args.push("-map", "0:a:0", "-af", "silencedetect=n=-50dB:d=1.0,ebur128=peak=true:framelog=quiet");
  args.push("-f", "null", "-");
  const { stderr } = await runFfmpeg(args, { ...opts, keepStderr: true });
  const det = parseDetections(stderr, probe.duration_s);

  if (probe.has_video) {
    const longest = Math.max(0, ...det.black.map((b) => b.duration_s));
    checks.push(
      det.black.length === 0
        ? { id: "black_frames", status: "ok", detail: "no black intervals ≥ 0.5s" }
        : {
            id: "black_frames",
            status: longest >= BLACK_FAIL_S && !black.nearBlack ? "fail" : "warn",
            detail: `black at ${fmtRanges(det.black)}${black.nearBlack ? " (the background is near black, so sparse scenes can read as black)" : ""}`,
            fix: "Check the scene(s) at those times rendered correctly; re-render them if blank.",
          },
    );
    checks.push(
      det.freeze.length === 0
        ? { id: "frozen_frames", status: "ok", detail: "no frozen intervals ≥ 1s" }
        : {
            id: "frozen_frames",
            status: "warn",
            detail: `frozen at ${fmtRanges(det.freeze)} (expected for static motion-graphic scenes)`,
            fix: "If those scenes should move, check their animation timelines or generated clips.",
          },
    );
  }
  if (probe.has_audio && expect.intended_silence) {
    checks.push({ id: "silence", status: "ok", detail: "silent on purpose (no narration, no music)" });
    checks.push({ id: "loudness", status: "ok", detail: "not measured: silent on purpose" });
  } else if (probe.has_audio) {
    checks.push(
      det.silence.length === 0
        ? { id: "silence", status: "ok", detail: "no silence ≥ 1s below -50 dB" }
        : { id: "silence", status: "warn", detail: `silent at ${fmtRanges(det.silence)}`, fix: "Check the voice track covers those scenes, or accept intentional pauses." },
    );
    const I = det.integrated_lufs;
    if (I === null) {
      checks.push({ id: "loudness", status: "warn", detail: "integrated loudness not measurable (silent audio?)" });
    } else {
      const off = Math.abs(I - target);
      checks.push({
        id: "loudness",
        status: off <= ltol ? "ok" : "warn",
        detail: `${I.toFixed(1)} LUFS (target ${target} ± ${ltol})`,
        ...(off <= ltol ? {} : { fix: "Run two-pass loudnorm (loudnorm2pass) on the voice track before muxing." }),
      });
    }
    if (det.true_peak_dbtp !== null && det.true_peak_dbtp > -1) {
      checks.push({ id: "true_peak", status: "warn", detail: `true peak ${det.true_peak_dbtp.toFixed(1)} dBTP > -1 dBTP`, fix: "Normalise with TP=-1 (loudnorm2pass)." });
    }
  }

  const status: QaCheckStatus = checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "warn") ? "warn" : "ok";
  return {
    status,
    video: videoPath,
    checks,
    metrics: {
      probe,
      black: det.black,
      freeze: det.freeze,
      silence: det.silence,
      integrated_lufs: det.integrated_lufs,
      lra: det.lra,
      true_peak_dbtp: det.true_peak_dbtp,
    },
  };
}

export function formatQaMarkdown(r: QaReport): string {
  const icon: Record<QaCheckStatus, string> = { ok: "ok", warn: "WARN", fail: "FAIL" };
  const p = r.metrics.probe;
  const lines = [
    `# Technical QA: ${r.status.toUpperCase()}`,
    "",
    `Video: \`${r.video}\``,
    "",
    "| Check | Status | Detail | Fix |",
    "| --- | --- | --- | --- |",
    ...r.checks.map((c) => `| ${c.id} | ${icon[c.status]} | ${c.detail.replace(/\|/g, "\\|")} | ${(c.status !== "ok" && c.fix ? c.fix : "").replace(/\|/g, "\\|")} |`),
    "",
    "## Metrics",
    "",
    `- Size: ${p.width}x${p.height} @ ${p.fps ?? "?"} fps, ${p.duration_s.toFixed(3)} s, ${p.video_codec ?? "no video"} / ${p.audio_codec ?? "no audio"}`,
    `- Loudness: ${r.metrics.integrated_lufs ?? "n/a"} LUFS integrated, LRA ${r.metrics.lra ?? "n/a"} LU, true peak ${r.metrics.true_peak_dbtp ?? "n/a"} dBTP`,
    `- Black: ${r.metrics.black.length ? fmtRanges(r.metrics.black) : "none"}`,
    `- Frozen: ${r.metrics.freeze.length ? fmtRanges(r.metrics.freeze) : "none"}`,
    `- Silence: ${r.metrics.silence.length ? fmtRanges(r.metrics.silence) : "none"}`,
    "",
  ];
  return lines.join("\n");
}

/** Write `<dir>/qa/report.json` and `<dir>/qa/report.md`. */
export async function writeQaReport(dir: string, report: QaReport): Promise<{ json: string; md: string }> {
  const qaDir = join(dir, "qa");
  await mkdir(qaDir, { recursive: true });
  const json = join(qaDir, "report.json");
  const md = join(qaDir, "report.md");
  await writeFile(json, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(md, formatQaMarkdown(report));
  return { json, md };
}

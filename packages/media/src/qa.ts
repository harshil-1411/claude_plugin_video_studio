import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LoudnessStats, parseEbur128Summary } from "./audio.js";
import { type ProbeResult, type RunOptions, ffprobe, runFfmpeg } from "./ffmpeg.js";
import { frameSsim } from "./frames.js";

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
  /** Why it is silent, shown in those checks (default: "silent on purpose (no narration, no music)"). */
  silence_reason?: string;
  /**
   * Scene background colour (#RRGGBB). Dark themes sit near black, so sparse scenes would read as
   * "black" at blackdetect's default threshold; the threshold is set just below this colour.
   */
  background?: string;
  /** Measurable acceptance numbers (spec.acceptance); without them density and static stretch are only reported. */
  acceptance?: QaAcceptance;
  /** The video must loop seamlessly (spec master.loop): adds the `loop_seam` check. */
  loop?: boolean;
}

/** The acceptance numbers technical QA checks (schema `Acceptance`). */
export interface QaAcceptance {
  min_changes_per_sec?: number;
  max_frozen_pct?: number;
  max_static_sec?: number;
  hold_ms?: number;
}

/**
 * Scene-change score (ffmpeg `scdet`, 0–100) at or above which a frame counts as a big visual
 * change. scdet scores min(frame difference, jump in frame difference), so continuous motion
 * (a pan, a sliding element) scores near 0 and only sudden changes count. Measured on synthetic
 * 160x288 clips: a full-contrast element covering 10% of the frame appearing scores ~7.5, 25%
 * scores ~19, a hard cut between flat colours 15–85, while continuous motion stays below 1.6
 * (encoder noise included). 5 counts anything from about 6% of the frame at full contrast.
 */
export const BIG_CHANGE_SCORE = 5;
/**
 * Scene-change score at or above which a change counts as a cut (whole-picture change). A hard
 * cut between flat colours of different luma scored 15.6 at the lowest; an element covering a
 * quarter of the frame scores about the same, so the cut rate is an estimate, not an edit list.
 */
export const CUT_SCORE = 15;
/** Changes closer than this merge into one (a flash or a multi-frame dissolve is one change). */
export const CHANGE_MERGE_S = 0.1;
/** Frozen share of the runtime (percent) above which `frozen_frames` fails, unless acceptance sets another. */
export const DEFAULT_MAX_FROZEN_PCT = 15;
/** A loop's last frame must match its first at least this well (SSIM, the golden-frame metric). */
export const LOOP_SSIM_MIN = 0.99;
/**
 * Largest RMS level jump (dB) across a loop seam, last 50 ms vs first 50 ms. 6 dB is a doubling of
 * amplitude, an audible bump; a bed that loops on its own phrase stays within a few dB.
 */
export const LOOP_AUDIO_JUMP_DB = 6;
/** Window each side of the loop seam for the audio level (ms). */
export const LOOP_AUDIO_WINDOW_MS = 50;
/** Floor for RMS levels (dB), so two silent ends compare as equal. */
const SILENCE_DB = -90;

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

/** A big visual change: its time and scdet score. */
export interface SceneChange {
  t: number;
  score: number;
}

/** Motion density of a video, from one decode pass (scdet + freezedetect). */
export interface MotionStats {
  /** Big visual changes (scdet score ≥ BIG_CHANGE_SCORE). */
  changes: number;
  changes_per_sec: number;
  /** Changes that score like a cut (≥ CUT_SCORE). */
  cuts: number;
  cuts_per_sec: number;
  /** Times of the big changes (s, first 500). */
  change_times_s: number[];
  /** Longest stretch with no big change, the start and end of the video included. */
  longest_static_s: number;
  longest_static_at?: { start_s: number; end_s: number };
  /** Frozen time (freezedetect intervals ≥ 1 s) and its share of the runtime. */
  frozen_s: number;
  frozen_pct: number;
}

/** First vs last frame and the audio level either side of a loop's seam. */
export interface LoopSeam {
  ssim: number | null;
  /** |RMS(last 50 ms) − RMS(first 50 ms)| in dB; null without audio. */
  audio_jump_db: number | null;
}

export interface QaMetrics extends LoudnessStats {
  probe: ProbeResult;
  black: TimeRange[];
  freeze: TimeRange[];
  silence: TimeRange[];
  /** Motion density (videos with a video stream). */
  motion?: MotionStats;
  /** Loop seam measurement (when the video must loop). */
  loop_seam?: LoopSeam;
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

/** Big changes from `scdet` log lines (score ≥ BIG_CHANGE_SCORE), merged within CHANGE_MERGE_S. */
export function parseSceneChanges(stderr: string, minScore = BIG_CHANGE_SCORE): SceneChange[] {
  const out: SceneChange[] = [];
  for (const m of stderr.matchAll(/lavfi\.scd\.score:\s*([\d.]+),\s*lavfi\.scd\.time:\s*(-?[\d.]+)/g)) {
    const score = Number(m[1]);
    const t = r3(Number(m[2]));
    if (!Number.isFinite(score) || !Number.isFinite(t) || score < minScore) continue;
    const prev = out[out.length - 1];
    if (prev && t - prev.t < CHANGE_MERGE_S) {
      prev.score = Math.max(prev.score, score);
      continue;
    }
    out.push({ t, score });
  }
  return out;
}

/** Changes/s, cuts/s, the longest stretch without a change and the frozen share of `durationS`. */
export function motionStats(changes: readonly SceneChange[], durationS: number, freeze: readonly TimeRange[]): MotionStats {
  const d = durationS > 0 ? durationS : 0;
  const per = (n: number) => (d > 0 ? r3(n / d) : 0);
  const cuts = changes.filter((c) => c.score >= CUT_SCORE).length;
  const edges = [0, ...changes.map((c) => c.t).filter((t) => t > 0 && t < d), d];
  let longest = 0;
  let at: { start_s: number; end_s: number } | undefined;
  for (let i = 1; i < edges.length; i++) {
    const gap = edges[i]! - edges[i - 1]!;
    if (gap > longest) {
      longest = gap;
      at = { start_s: r3(edges[i - 1]!), end_s: r3(edges[i]!) };
    }
  }
  const frozen = freeze.reduce((n, f) => n + f.duration_s, 0);
  return {
    changes: changes.length,
    changes_per_sec: per(changes.length),
    cuts,
    cuts_per_sec: per(cuts),
    change_times_s: changes.slice(0, 500).map((c) => c.t),
    longest_static_s: r3(longest),
    ...(at ? { longest_static_at: at } : {}),
    frozen_s: r3(frozen),
    frozen_pct: d > 0 ? Math.round((frozen / d) * 1000) / 10 : 0,
  };
}

/** RMS level (dB full scale) of mono PCM, floored at -90 dB. */
export function rmsDb(pcm: Float32Array): number {
  if (!pcm.length) return SILENCE_DB;
  let e = 0;
  for (const v of pcm) e += v * v;
  const rms = Math.sqrt(e / pcm.length);
  return rms > 0 ? Math.max(SILENCE_DB, Math.round(20 * Math.log10(rms) * 100) / 100) : SILENCE_DB;
}

/** Everything one decode pass measures, plus the probe (technical QA and `compare`). */
export interface VideoAnalysis extends LoudnessStats {
  probe: ProbeResult;
  black: TimeRange[];
  freeze: TimeRange[];
  silence: TimeRange[];
  motion: MotionStats;
  /** blackdetect threshold used for `background`. */
  black_threshold: { pix_th: number; nearBlack: boolean };
}

/**
 * One ffprobe plus one decode pass: blackdetect, freezedetect and scdet on the video, silencedetect
 * and ebur128 on the audio. Shared by technical QA and `compare` (a reference video).
 */
export async function analyzeVideo(videoPath: string, o: { background?: string; probe?: ProbeResult } = {}, opts: RunOptions = {}): Promise<VideoAnalysis> {
  const probe = o.probe ?? (await ffprobe(videoPath, opts));
  const args = ["-i", videoPath];
  const black = blackThreshold(o.background);
  if (probe.has_video) args.push("-map", "0:v:0", "-vf", `blackdetect=d=0.5:pix_th=${black.pix_th},freezedetect=n=-60dB:d=1.0,scdet=t=${BIG_CHANGE_SCORE}`);
  if (probe.has_audio) args.push("-map", "0:a:0", "-af", "silencedetect=n=-50dB:d=1.0,ebur128=peak=true:framelog=quiet");
  args.push("-f", "null", "-");
  const { stderr } = await runFfmpeg(args, { ...opts, keepStderr: true });
  const det = parseDetections(stderr, probe.duration_s);
  const motion = motionStats(probe.has_video ? parseSceneChanges(stderr) : [], probe.duration_s, det.freeze);
  return { probe, ...det, motion, black_threshold: black };
}

/**
 * Measure a loop's seam: SSIM of the first vs the last frame (160 px wide, as golden frames) and
 * the RMS level jump between the last and first {@link LOOP_AUDIO_WINDOW_MS} of audio.
 */
export async function measureLoopSeam(videoPath: string, probe: ProbeResult, opts: RunOptions = {}): Promise<LoopSeam> {
  const work = await mkdtemp(join(tmpdir(), "vs-loop-seam-"));
  const run = (args: string[]) => runFfmpeg(["-y", ...args], { ...(opts.tools ? { tools: opts.tools } : {}), ...(opts.signal ? { signal: opts.signal } : {}), timeoutMs: 120_000 });
  try {
    let ssim: number | null = null;
    if (probe.has_video) {
      const first = join(work, "first.png");
      const last = join(work, "last.png");
      const png = ["-vf", "scale=160:-2:flags=bicubic", "-pix_fmt", "rgb24", "-c:v", "png"];
      await run(["-i", videoPath, "-map", "0:v:0", "-frames:v", "1", ...png, first]);
      // Decode the last second and keep overwriting one image: it ends as the final frame.
      await run(["-sseof", "-1", "-i", videoPath, "-map", "0:v:0", ...png, "-update", "1", "-f", "image2", last]);
      const ok = async (f: string) => ((await stat(f).catch(() => undefined))?.size ?? 0) > 0;
      if ((await ok(first)) && (await ok(last))) ssim = Math.round((await frameSsim(first, last, opts)) * 10000) / 10000;
    }
    let jump: number | null = null;
    if (probe.has_audio) {
      const w = (LOOP_AUDIO_WINDOW_MS / 1000).toFixed(3);
      const pcm = ["-map", "0:a:0", "-ac", "1", "-ar", "16000", "-f", "f32le", "-c:a", "pcm_f32le"];
      const head = join(work, "head.f32");
      const tail = join(work, "tail.f32");
      await run(["-i", videoPath, "-t", w, ...pcm, head]);
      await run(["-sseof", `-${w}`, "-i", videoPath, ...pcm, tail]);
      const level = async (f: string) => {
        const buf = await readFile(f);
        return rmsDb(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)));
      };
      jump = Math.round(Math.abs((await level(tail)) - (await level(head))) * 100) / 100;
    }
    return { ssim, audio_jump_db: jump };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const fmtRanges = (rs: TimeRange[]) => rs.map((r) => `${r.start_s.toFixed(2)}–${r.end_s.toFixed(2)}s`).join(", ");

/**
 * Technical QA in one ffprobe plus one decode pass (blackdetect, freezedetect, scdet,
 * silencedetect, ebur128), plus the loop seam when asked. Frozen time fails above its limit;
 * motion density and the longest static stretch fail only against acceptance numbers.
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
  const det = await analyzeVideo(videoPath, { probe, ...(expect.background ? { background: expect.background } : {}) }, opts);
  const black = det.black_threshold;
  const acc = expect.acceptance ?? {};
  let loopSeam: LoopSeam | undefined;

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
    checks.push(...motionChecks(det.motion, det.freeze, acc));
    if (expect.loop) {
      loopSeam = await measureLoopSeam(videoPath, probe, opts);
      checks.push(loopSeamCheck(loopSeam));
    }
  }
  if (probe.has_audio && expect.intended_silence) {
    const why = expect.silence_reason ?? "silent on purpose (no narration, no music)";
    checks.push({ id: "silence", status: "ok", detail: why });
    checks.push({ id: "loudness", status: "ok", detail: `not measured: ${why}` });
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
      ...(probe.has_video ? { motion: det.motion } : {}),
      ...(loopSeam ? { loop_seam: loopSeam } : {}),
    },
  };
}

const fmtS = (n: number) => `${Math.round(n * 100) / 100}s`;

/**
 * frozen_frames, motion_density, longest_static and (with acceptance.hold_ms) hold. Frozen time
 * fails above the limit (default {@link DEFAULT_MAX_FROZEN_PCT}%): a frozen reel reads as a
 * slideshow, whatever made it. Density and static stretch fail only against acceptance numbers.
 */
export function motionChecks(m: MotionStats, freeze: readonly TimeRange[], acc: QaAcceptance): QaCheck[] {
  const out: QaCheck[] = [];
  const maxFrozen = acc.max_frozen_pct ?? DEFAULT_MAX_FROZEN_PCT;
  if (!freeze.length) out.push({ id: "frozen_frames", status: "ok", detail: `no frozen intervals ≥ 1s (limit ${maxFrozen}% of the runtime)` });
  else {
    const over = m.frozen_pct > maxFrozen;
    out.push({
      id: "frozen_frames",
      status: over ? "fail" : "ok",
      detail: `${fmtS(m.frozen_s)} frozen, ${m.frozen_pct}% of the runtime (limit ${maxFrozen}%): ${fmtRanges([...freeze])}`,
      ...(over ? { fix: "Give those stretches motion (a `motion` scene, a camera move, staged reveals or a count-up), or shorten them; a frozen reel reads as a slideshow." } : {}),
    });
  }
  const perSec = `${m.changes_per_sec} big changes/s (${m.changes} in total, ${m.cuts} cuts)`;
  if (acc.min_changes_per_sec === undefined) out.push({ id: "motion_density", status: "ok", detail: `${perSec}; no acceptance minimum set` });
  else {
    const ok = m.changes_per_sec >= acc.min_changes_per_sec;
    out.push({
      id: "motion_density",
      status: ok ? "ok" : "fail",
      detail: `${perSec}; minimum ${acc.min_changes_per_sec}/s`,
      ...(ok ? {} : { fix: "Add visual beats: stage each scene as several states (reveals, match cuts, camera moves) or split long scenes." }),
    });
  }
  const where = m.longest_static_at ? ` (${m.longest_static_at.start_s.toFixed(2)}–${m.longest_static_at.end_s.toFixed(2)}s)` : "";
  if (acc.max_static_sec === undefined) out.push({ id: "longest_static", status: "ok", detail: `longest stretch without a big change ${fmtS(m.longest_static_s)}${where}; no acceptance maximum set` });
  else {
    const ok = m.longest_static_s <= acc.max_static_sec;
    out.push({
      id: "longest_static",
      status: ok ? "ok" : "fail",
      detail: `longest stretch without a big change ${fmtS(m.longest_static_s)}${where}; maximum ${acc.max_static_sec}s`,
      ...(ok ? {} : { fix: "Add a change inside that stretch (a new state, a cut or a reveal), or shorten the scene there." }),
    });
  }
  if (acc.hold_ms !== undefined) {
    const ok = m.longest_static_s * 1000 >= acc.hold_ms;
    out.push({
      id: "hold",
      status: ok ? "ok" : "fail",
      detail: `longest hold ${Math.round(m.longest_static_s * 1000)} ms; at least one of ${acc.hold_ms} ms wanted`,
      ...(ok ? {} : { fix: "Hold one key moment still (no big change) so the motion around it feels earned." }),
    });
  }
  return out;
}

/** loop_seam: first vs last frame SSIM ≥ LOOP_SSIM_MIN and the audio level jump < LOOP_AUDIO_JUMP_DB. */
export function loopSeamCheck(seam: LoopSeam): QaCheck {
  const frameOk = seam.ssim !== null && seam.ssim >= LOOP_SSIM_MIN;
  const audioOk = seam.audio_jump_db === null || seam.audio_jump_db < LOOP_AUDIO_JUMP_DB;
  const detail = [
    `first vs last frame SSIM ${seam.ssim ?? "not measured"} (minimum ${LOOP_SSIM_MIN})`,
    seam.audio_jump_db === null ? "no audio" : `audio level jump ${seam.audio_jump_db} dB across the seam (maximum ${LOOP_AUDIO_JUMP_DB} dB)`,
  ].join("; ");
  const fixes = [
    ...(frameOk ? [] : ["make the last frame return to the first (cyclic motion periods must divide the loop length)"]),
    ...(audioOk ? [] : ["end the music and sound where they started (loop the bed on a bar, no fade-in or fade-out at the seam)"]),
  ];
  return { id: "loop_seam", status: frameOk && audioOk ? "ok" : "fail", detail, ...(fixes.length ? { fix: `${fixes.join("; ")}.` } : {}) };
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
    ...(r.metrics.motion
      ? [
          `- Motion: ${r.metrics.motion.changes} big changes (${r.metrics.motion.changes_per_sec}/s), ${r.metrics.motion.cuts} cuts (${r.metrics.motion.cuts_per_sec}/s), longest static ${r.metrics.motion.longest_static_s}s, frozen ${r.metrics.motion.frozen_pct}%`,
        ]
      : []),
    ...(r.metrics.loop_seam ? [`- Loop seam: SSIM ${r.metrics.loop_seam.ssim ?? "n/a"}, audio jump ${r.metrics.loop_seam.audio_jump_db ?? "n/a"} dB`] : []),
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

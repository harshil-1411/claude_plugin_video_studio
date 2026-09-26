import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, rm } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";

/**
 * FFmpeg process layer. Policy (see reports/Video studio implementation specs.md):
 * use the system `ffmpeg`/`ffprobe` (or `FFMPEG_PATH`/`FFPROBE_PATH`), never a bundled
 * GPL binary by default. Every invocation is an argv array handed to `spawn` without a
 * shell; filtergraphs are assembled from arrays and escaped with the helpers below.
 */

export type Env = Record<string, string | undefined>;
export type FfToolName = "ffmpeg" | "ffprobe";

/** What locating a binary touches; injectable for tests (the doctor passes its own deps). */
export interface ToolLocatorDeps {
  env: Env;
  platform: NodeJS.Platform;
  /** True if `path` exists and is executable. */
  isExecutable: (path: string) => Promise<boolean>;
}

export async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function defaultLocatorDeps(env: Env = process.env): ToolLocatorDeps {
  return { env, platform: process.platform, isExecutable: isExecutableFile };
}

/** A value substituted from an unset `${user_config.X}` may arrive empty or as the literal placeholder. */
export function hasEnvValue(v: string | undefined): v is string {
  if (!v) return false;
  const t = v.trim();
  return t.length > 0 && !/^\$\{[^}]*\}$/.test(t);
}

/** Look `name` up on PATH. */
export async function which(name: string, deps: ToolLocatorDeps): Promise<string | null> {
  const pathVar = deps.env.PATH ?? deps.env.Path ?? "";
  const sep = deps.platform === "win32" ? ";" : delimiter;
  const exts = deps.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (await deps.isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export const FF_ENV_VAR: Record<FfToolName, "FFMPEG_PATH" | "FFPROBE_PATH"> = {
  ffmpeg: "FFMPEG_PATH",
  ffprobe: "FFPROBE_PATH",
};

export type LocateResult =
  | { ok: true; path: string; source: "FFMPEG_PATH" | "FFPROBE_PATH" | "PATH" }
  | { ok: false; reason: "bad_override"; envVar: string; override: string }
  | { ok: false; reason: "not_found"; envVar: string };

/** Find ffmpeg/ffprobe: the env override first (it must be executable), then PATH. Never ffmpeg-static. */
export async function locateFfTool(tool: FfToolName, deps: ToolLocatorDeps): Promise<LocateResult> {
  const envVar = FF_ENV_VAR[tool];
  const override = deps.env[envVar];
  if (hasEnvValue(override)) {
    return (await deps.isExecutable(override))
      ? { ok: true, path: override, source: envVar }
      : { ok: false, reason: "bad_override", envVar, override };
  }
  const path = await which(tool, deps);
  return path ? { ok: true, path, source: "PATH" } : { ok: false, reason: "not_found", envVar };
}

export interface FfmpegTools {
  ffmpeg: string;
  ffprobe: string;
}

export class MediaToolError extends Error {
  constructor(
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = "MediaToolError";
  }
}

/**
 * Resolve both binaries (FFMPEG_PATH/FFPROBE_PATH, then PATH). Throws `MediaToolError`
 * with a fix when either is missing. Does not run them; `doctor` does the deeper checks.
 */
export async function resolveFfmpeg(env: Env = process.env, deps?: Partial<ToolLocatorDeps>): Promise<FfmpegTools> {
  const d: ToolLocatorDeps = { ...defaultLocatorDeps(env), ...deps, env };
  const out: Partial<FfmpegTools> = {};
  for (const tool of ["ffmpeg", "ffprobe"] as const) {
    const r = await locateFfTool(tool, d);
    if (!r.ok) {
      throw r.reason === "bad_override"
        ? new MediaToolError(`${r.envVar} is set to ${r.override}, which is not an executable file`, `Point ${r.envVar} at a working ${tool} binary or unset it.`)
        : new MediaToolError(`${tool} not found on PATH`, `Install FFmpeg (macOS: \`brew install ffmpeg\`; Debian/Ubuntu: \`sudo apt install ffmpeg\`) or set ${r.envVar}.`);
    }
    out[tool] = r.path;
  }
  return out as FfmpegTools;
}

let defaultTools: { key: string; tools: Promise<FfmpegTools> } | undefined;

/** Tools from `opts.tools`, else resolved once from process.env (re-resolved if the relevant env changes). */
export function getTools(tools?: FfmpegTools): Promise<FfmpegTools> {
  if (tools) return Promise.resolve(tools);
  const e = process.env;
  const key = `${e.FFMPEG_PATH ?? ""}\0${e.FFPROBE_PATH ?? ""}\0${e.PATH ?? ""}`;
  if (!defaultTools || defaultTools.key !== key) {
    const p = resolveFfmpeg(e);
    p.catch(() => {
      if (defaultTools?.tools === p) defaultTools = undefined;
    });
    defaultTools = { key, tools: p };
  }
  return defaultTools.tools;
}

// ---------------------------------------------------------------------------------- running

export interface FfmpegProgress {
  /** Output time reached, in ms. */
  out_time_ms: number;
  frame?: number;
  fps?: number;
  speed?: string;
  done: boolean;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Kill ffmpeg after this long. Default 30 minutes. */
  timeoutMs?: number;
  /** Adds `-progress pipe:1` and reports parsed progress blocks. */
  onProgress?: (p: FfmpegProgress) => void;
  tools?: FfmpegTools;
  /** Keep the whole stderr (capped at 64 MB) instead of just the tail; needed for detection filters. */
  keepStderr?: boolean;
  cwd?: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Why an ffmpeg/ffprobe run failed, classified from its stderr (see {@link classifyFfmpegFailure}). */
export type FfmpegErrorKind =
  | "not_installed"
  | "missing_encoder"
  | "missing_filter"
  | "input_missing"
  | "bad_input"
  | "disk_full"
  | "permission_denied"
  | "aborted"
  | "timeout"
  | "unknown";

export class FfmpegError extends Error {
  /** Classified cause; the message's first line says what to do about it. */
  readonly kind: FfmpegErrorKind;
  constructor(
    message: string,
    readonly bin: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderrTail: string,
    kind?: FfmpegErrorKind,
  ) {
    super(message);
    this.name = "FfmpegError";
    this.kind = kind ?? "unknown";
  }
}

export interface FfmpegFailure {
  kind: FfmpegErrorKind;
  /** One actionable line, or undefined when the cause is not recognised. */
  hint?: string;
}

/**
 * The file an ffmpeg error names: `Error opening input file <path>.` (ffmpeg 6+), else a
 * `<path>: <error>` line (older builds), else the first `-i` argument (inputs only).
 */
function namedFile(stderr: string, error: RegExp, args: readonly string[], inputsOnly: boolean): string | undefined {
  const opening = new RegExp(`^Error opening ${inputsOnly ? "input" : "(?:input|output)"} file (.+?)\\.?$`, "m").exec(stderr);
  if (opening) return opening[1];
  for (const line of stderr.split("\n")) {
    const m = /^(?:\[[^\]]*\]\s*)?(.+?):\s*(.*)$/.exec(line);
    if (m && !/^Error /.test(m[1]!) && error.test(m[2]!)) return m[1];
  }
  if (!inputsOnly) return undefined;
  const i = args.indexOf("-i");
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * Classify a failed ffmpeg/ffprobe run into a short actionable line. `spawnCode` is the spawn
 * error's errno code (ENOENT: the binary is missing); `killedFor` is set when we killed it.
 */
export function classifyFfmpegFailure(
  stderr: string,
  ctx: { bin?: string; args?: readonly string[]; spawnCode?: string; killedFor?: "aborted" | "timeout" } = {},
): FfmpegFailure {
  const bin = (ctx.bin ?? "ffmpeg").split(/[\\/]/).pop() ?? "ffmpeg";
  const args = ctx.args ?? [];
  if (ctx.killedFor === "aborted") return { kind: "aborted", hint: `${bin} was stopped because the job was cancelled or the engine is shutting down` };
  if (ctx.killedFor === "timeout") return { kind: "timeout", hint: `${bin} took too long and was killed; try preview quality or a shorter input` };
  if (ctx.spawnCode === "ENOENT") {
    return { kind: "not_installed", hint: `${bin} is not installed or not on PATH: install FFmpeg (macOS: brew install ffmpeg; Debian/Ubuntu: sudo apt install ffmpeg) or set FFMPEG_PATH/FFPROBE_PATH` };
  }
  if (ctx.spawnCode === "EACCES") return { kind: "permission_denied", hint: `${bin} is not executable (permission denied): fix its permissions or point FFMPEG_PATH/FFPROBE_PATH at a working binary` };
  const enc = /Unknown encoder '([^']+)'|Encoder '?([\w-]+)'? not found|Requested encoder '([^']+)'/i.exec(stderr);
  if (enc || /Encoder \(codec [^)]*\) not found/i.test(stderr)) {
    const name = enc ? (enc[1] ?? enc[2] ?? enc[3]) : undefined;
    const lib = name ?? "the requested encoder";
    return { kind: "missing_encoder", hint: `your ffmpeg lacks ${lib}: install a full build, e.g. brew install ffmpeg (Debian/Ubuntu: sudo apt install ffmpeg), then check it with the doctor tool` };
  }
  const filt = /No such filter: '([^']+)'|Filter not found|Unknown filter '([^']+)'/i.exec(stderr);
  if (filt) {
    const name = filt[1] ?? filt[2];
    const lib = name === "drawtext" ? "libfreetype (drawtext)" : name === "subtitles" || name === "ass" ? `libass (${name})` : name ? `the ${name} filter` : "a required filter";
    return { kind: "missing_filter", hint: `your ffmpeg lacks ${lib}: install a full build with libfreetype and libass (e.g. brew install ffmpeg) and check it with the doctor tool` };
  }
  if (/No space left on device/i.test(stderr)) return { kind: "disk_full", hint: "the disk is full (No space left on device): free some space, then retry (cached work is reused)" };
  if (/moov atom not found|Invalid data found when processing input|Could not find codec parameters/i.test(stderr)) {
    const file = namedFile(stderr, /Invalid data found when processing input|moov atom not found|could not find codec parameters/i, args, true);
    return { kind: "bad_input", hint: `${file ? `input ${file}` : "an input file"} is unreadable or corrupt (incomplete download or unsupported format): re-export or re-download it` };
  }
  if (/No such file or directory/i.test(stderr)) {
    const file = namedFile(stderr, /No such file or directory/i, args, false);
    return { kind: "input_missing", hint: `${file ? `${file} does not exist` : "a file ffmpeg needs does not exist"}: check the path` };
  }
  if (/Permission denied/i.test(stderr)) {
    const file = namedFile(stderr, /Permission denied/i, args, false);
    return { kind: "permission_denied", hint: `permission denied${file ? ` on ${file}` : ""}: check the file and folder permissions` };
  }
  return { kind: "unknown" };
}

const TAIL_BYTES = 16 * 1024;
const MAX_KEEP = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT = 30 * 60 * 1000;
const KILL_GRACE_MS = 2000;

/** Spawn a binary with an argv array (never a shell) and collect output. */
export function runProcess(bin: string, args: readonly string[], opts: RunOptions & { captureStdout?: boolean; onStdoutLine?: (l: string) => void } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new FfmpegError(`${bin.split(/[\\/]/).pop()} aborted before start`, bin, args, null, "", "aborted"));
      return;
    }
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, cwd: opts.cwd });
    let stderr = "";
    let stdout = "";
    let lineBuf = "";
    let killedFor: "aborted" | "timeout" | null = null;
    const keep = opts.keepStderr ? MAX_KEEP : TAIL_BYTES * 4;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > keep) stderr = stderr.slice(stderr.length - (opts.keepStderr ? MAX_KEEP : TAIL_BYTES));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (opts.captureStdout) stdout += chunk;
      if (opts.onStdoutLine) {
        lineBuf += chunk;
        let i: number;
        while ((i = lineBuf.indexOf("\n")) >= 0) {
          opts.onStdoutLine(lineBuf.slice(0, i).trim());
          lineBuf = lineBuf.slice(i + 1);
        }
      }
    });

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    // SIGTERM first (ffmpeg stops cleanly), then SIGKILL if it is still alive after the grace period.
    const kill = (why: "aborted" | "timeout") => {
      if (killedFor) return;
      killedFor = why;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => kill("timeout"), timeoutMs);
    timer.unref();
    const onAbort = () => kill("aborted");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const done = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (err) => {
      done();
      const c = classifyFfmpegFailure("", { bin, args, spawnCode: (err as NodeJS.ErrnoException).code });
      reject(new FfmpegError(`${c.hint ? `${c.hint}\n` : ""}could not start ${bin}: ${err.message}`, bin, args, null, "", c.kind));
    });
    child.on("close", (code) => {
      done();
      if (code === 0 && !killedFor) {
        resolve({ stdout, stderr });
        return;
      }
      const tail = stderr.slice(-TAIL_BYTES).trim();
      const lastLines = tail.split("\n").slice(-6).join("\n");
      const why = killedFor === "aborted" ? "aborted" : killedFor === "timeout" ? `timed out after ${timeoutMs} ms` : `exited with code ${code}`;
      const c = classifyFfmpegFailure(tail, { bin, args, ...(killedFor ? { killedFor } : {}) });
      const detail = `${bin.split(/[\\/]/).pop()} ${why}${lastLines ? `:\n${lastLines}` : ""}`;
      reject(new FfmpegError(c.hint ? `${c.hint}\n${detail}` : detail, bin, args, code, tail, c.kind));
    });
  });
}

/** Run ffmpeg with `args` (no shell). Always adds `-hide_banner -nostdin -nostats`. */
export async function runFfmpeg(args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  const out = outputFile(args, opts.cwd);
  // A file ffmpeg creates and then fails (or is aborted) on is partial: never leave it at its final path.
  const existed = out ? existsSync(out) : true;
  try {
    return await runFfmpegRaw(args, opts);
  } catch (err) {
    if (out && !existed) await rm(out, { force: true }).catch(() => {});
    throw err;
  }
}

/** ffmpeg's output file (its last argument) when it is a plain file path, not a pipe, device or pattern. */
export function outputFile(args: readonly string[], cwd?: string): string | undefined {
  const last = args[args.length - 1];
  if (!last || args.length < 2 || last.startsWith("-") || last.includes("%") || /^[a-z][a-z0-9+.-]*:/i.test(last) || last.startsWith("/dev/")) return undefined;
  // The last argument must not be an option's value (e.g. `-f null` has no output path).
  const prev = args[args.length - 2]!;
  if (prev === "-i" || prev === "-f") return undefined;
  return resolve(cwd ?? ".", last);
}

async function runFfmpegRaw(args: readonly string[], opts: RunOptions): Promise<RunResult> {
  const { ffmpeg } = await getTools(opts.tools);
  const pre = ["-hide_banner", "-nostdin", "-nostats"];
  if (!opts.onProgress) return runProcess(ffmpeg, [...pre, ...args], opts);
  const onProgress = opts.onProgress;
  let block: Record<string, string> = {};
  return runProcess(ffmpeg, [...pre, "-progress", "pipe:1", ...args], {
    ...opts,
    onStdoutLine: (line) => {
      const eq = line.indexOf("=");
      if (eq <= 0) return;
      const k = line.slice(0, eq);
      const v = line.slice(eq + 1);
      block[k] = v;
      if (k === "progress") {
        onProgress(parseProgressBlock(block));
        block = {};
      }
    },
  });
}

/** Parse one `-progress` key=value block. (`out_time_ms` is in microseconds despite its name.) */
export function parseProgressBlock(b: Record<string, string>): FfmpegProgress {
  const us = Number(b.out_time_us ?? b.out_time_ms);
  const p: FfmpegProgress = { out_time_ms: Number.isFinite(us) ? Math.max(0, Math.round(us / 1000)) : 0, done: b.progress === "end" };
  if (b.frame !== undefined && Number.isFinite(Number(b.frame))) p.frame = Number(b.frame);
  if (b.fps !== undefined && Number.isFinite(Number(b.fps))) p.fps = Number(b.fps);
  if (b.speed) p.speed = b.speed.trim();
  return p;
}

// ---------------------------------------------------------------------------------- probing

export interface ProbeResult {
  duration_s: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  sample_rate: number | null;
  channels: number | null;
  has_audio: boolean;
  has_video: boolean;
  pix_fmt: string | null;
  format_name: string | null;
}

interface RawStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  pix_fmt?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
}

function parseRate(r: string | undefined): number | null {
  if (!r) return null;
  const [n, d] = r.split("/").map(Number);
  if (!n || !Number.isFinite(n)) return null;
  const v = d ? n / d : n;
  return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) / 1000 : null;
}

export function parseProbeJson(json: string): ProbeResult {
  const data = JSON.parse(json) as { streams?: RawStream[]; format?: { duration?: string; format_name?: string } };
  const streams = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === "audio");
  const dur = Number(data.format?.duration ?? v?.duration ?? a?.duration ?? 0);
  return {
    duration_s: Number.isFinite(dur) ? dur : 0,
    width: v?.width ?? null,
    height: v?.height ?? null,
    fps: v ? (parseRate(v.avg_frame_rate) ?? parseRate(v.r_frame_rate)) : null,
    video_codec: v?.codec_name ?? null,
    audio_codec: a?.codec_name ?? null,
    sample_rate: a?.sample_rate ? Number(a.sample_rate) : null,
    channels: a?.channels ?? null,
    has_audio: Boolean(a),
    has_video: Boolean(v),
    pix_fmt: v?.pix_fmt ?? null,
    format_name: data.format?.format_name ?? null,
  };
}

/** ffprobe a media file. */
export async function ffprobe(path: string, opts: Pick<RunOptions, "signal" | "tools" | "timeoutMs"> = {}): Promise<ProbeResult> {
  const { ffprobe: bin } = await getTools(opts.tools);
  const { stdout } = await runProcess(bin, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", "--", path], {
    ...opts,
    timeoutMs: opts.timeoutMs ?? 60_000,
    captureStdout: true,
  });
  return parseProbeJson(stdout);
}

/** `ffmpeg -buildconf` feature flags. */
export function parseBuildconf(text: string): { libass: boolean; libx264: boolean } {
  return { libass: /--enable-libass\b/.test(text), libx264: /--enable-libx264\b/.test(text) };
}

export async function ffmpegFeatures(opts: Pick<RunOptions, "tools"> = {}): Promise<{ libass: boolean; libx264: boolean; version: string }> {
  const { ffmpeg } = await getTools(opts.tools);
  const [conf, ver] = await Promise.all([
    runProcess(ffmpeg, ["-hide_banner", "-buildconf"], { timeoutMs: 10_000, captureStdout: true }),
    runProcess(ffmpeg, ["-hide_banner", "-version"], { timeoutMs: 10_000, captureStdout: true }),
  ]);
  const first = ver.stdout.split("\n")[0] ?? "";
  return { ...parseBuildconf(`${conf.stdout}\n${conf.stderr}`), version: /version\s+(\S+)/.exec(first)?.[1] ?? "unknown" };
}

// ---------------------------------------------------------------------------------- filtergraph escaping

/** First level: a value inside `key=value:key=value` filter options (escapes `\ ' :`). */
export function escapeFilterOption(value: string): string {
  return value.replace(/[\\':]/g, (m) => `\\${m}`);
}

/** Second level: a filter description inside a filtergraph (escapes `\ ' [ ] , ;`). */
export function escapeFiltergraph(value: string): string {
  return value.replace(/[\\'[\],;]/g, (m) => `\\${m}`);
}

/**
 * Escape a file path for a filter option such as `subtitles=filename=<here>` when the
 * filter is passed via `-vf`/`-filter_complex` as one argv element (no shell). Both escaping
 * levels apply. On Windows, backslash separators become forward slashes first.
 */
export function escapeFilterPath(path: string, platform: NodeJS.Platform = process.platform): string {
  const p = platform === "win32" ? path.replace(/\\/g, "/") : path;
  return escapeFiltergraph(escapeFilterOption(p));
}

/** `name=k=v:k=v` with values escaped at the option level (the result still needs graph-level escaping if values contain `,;[]`). */
export function filter(name: string, options?: Record<string, string | number | undefined>): string {
  if (!options) return name;
  const parts = Object.entries(options)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${escapeFilterOption(String(v))}`);
  return parts.length ? `${name}=${parts.join(":")}` : name;
}

/** Join filter chains (each an array of filters, optionally with pads) into a `-filter_complex` string. */
export function filterGraph(chains: readonly (readonly string[])[]): string {
  return chains.map((c) => c.join(",")).join(";");
}

/** Seconds with millisecond precision, for ffmpeg time options. */
export function secs(ms: number): string {
  return (Math.round(ms) / 1000).toFixed(3);
}

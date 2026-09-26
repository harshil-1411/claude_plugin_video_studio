import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ensureDir, hashFile, sha256Hex } from "@video-studio/core";
import { hasEnvValue, isExecutableFile, which } from "@video-studio/media";
import type { MediaInfo, Source } from "@video-studio/schema";
import { MEDIA_URL_EXTENSIONS, videoPlatform } from "./detect.js";
import { extractMediaFile } from "./media.js";
import { BlockedAddressError, type LookupFn, checkUrlHost, defaultLookup } from "./net-guard.js";
import { type FetchImpl, UrlFetchError, guardedGet, parseHttpUrl } from "./url.js";
import type { ExtractInput, ExtractedSource, Extractor } from "./types.js";

/**
 * Video URLs → a downloaded media file ingested exactly like a local one ({@link extractMediaFile}).
 *
 * - **Direct media URLs** (`https://…/talk.mp4`, or any URL that serves `video/*`/`audio/*`) are
 *   streamed by the engine through the SSRF guard ({@link guardedGet}: every redirect hop checked,
 *   connections DNS-pinned), capped at {@link VIDEO_URL_MAX_BYTES}.
 * - **Platform URLs** (YouTube, Vimeo, Loom) are downloaded by the USER's `yt-dlp` (env
 *   `YT_DLP_PATH`, else `yt-dlp` on PATH), which is never bundled or installed by the plugin. It
 *   runs with an argv array (no shell), a filtered environment (no API keys), inside a temp folder
 *   of the project, with {@link YT_DLP_SAFETY_ARGS}, a capped format, `--max-filesize`, a timeout
 *   and abort support. Existing subtitles (manual preferred over automatic) are downloaded as .vtt
 *   next to the asset and recorded on `media.subtitles`, so `transcribe captions_file` can import
 *   them without whisper.
 *
 * SSRF residual risk (yt-dlp): the URL's host must resolve to public addresses before yt-dlp
 * runs, but yt-dlp does its own DNS and follows the platform's redirects and CDN URLs, which the
 * engine cannot pin; a hostile DNS answer between the check and yt-dlp's connect (rebinding) is
 * not prevented. Only YouTube/Vimeo/Loom URLs reach yt-dlp, and its generic extractor is disabled
 * (`--use-extractors default,-generic`), so it never follows an arbitrary page's embeds.
 */

type Env = Record<string, string | undefined>;

/** Largest media file a video URL may download (both paths). Local files are not affected. */
export const VIDEO_URL_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** yt-dlp format: best video up to 1080p + best audio, or the best single file up to 1080p. */
export const YT_DLP_FORMAT = "bv*[height<=1080]+ba/b[height<=1080]";
export const YT_DLP_PATH_ENV = "YT_DLP_PATH";
export const YT_DLP_METADATA_TIMEOUT_MS = 3 * 60_000;
export const VIDEO_URL_DOWNLOAD_TIMEOUT_MS = 60 * 60_000;
/** Subtitle files larger than this are skipped (transcribe refuses them too). */
export const SUBTITLE_MAX_BYTES = 20 * 1024 * 1024;
export const VIDEO_URL_EXTRACTOR_VERSION = "video-url-1";

export const YT_DLP_MISSING_MESSAGE =
  "yt-dlp is not installed: brew install yt-dlp (or pipx install yt-dlp), then ingest again; or download the video yourself and ingest the file";

/**
 * Flags on every yt-dlp run. `--ignore-config`: no system/user config files (they could add
 * `--exec`, cookies or output paths). No cookies, no browser cookies, no batch file, no `--exec`
 * hooks, no playlists (a `watch?v=…&list=…` URL is that one video), no generic extractor.
 * netrc is off by default and cannot be switched on without a config file.
 */
export const YT_DLP_SAFETY_ARGS: readonly string[] = [
  "--ignore-config",
  "--no-playlist",
  "--restrict-filenames",
  "--no-exec",
  "--no-cookies",
  "--no-cookies-from-browser",
  "--no-batch-file",
  "--use-extractors",
  "default,-generic",
  "--no-mtime",
  "--no-progress",
  "--newline",
  "--socket-timeout",
  "30",
  "--retries",
  "3",
];

/** Environment variables passed to yt-dlp; everything else (API keys, PYTHONPATH…) is dropped. */
const YT_DLP_ENV_ALLOW = [
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "USERPROFILE",
  "APPDATA", "LOCALAPPDATA", "XDG_CACHE_HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy",
  "https_proxy", "no_proxy", "all_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
];

export class YtDlpMissingError extends Error {
  constructor(message: string = YT_DLP_MISSING_MESSAGE) {
    super(message);
    this.name = "YtDlpMissingError";
  }
}

/** yt-dlp's executable: `YT_DLP_PATH` (must be executable), else `yt-dlp` on PATH; throws {@link YtDlpMissingError}. */
export async function resolveYtDlp(env: Env = process.env, isExecutable: (p: string) => Promise<boolean> = isExecutableFile): Promise<string> {
  const override = env[YT_DLP_PATH_ENV];
  if (hasEnvValue(override)) {
    if (await isExecutable(override)) return override;
    throw new YtDlpMissingError(`${YT_DLP_PATH_ENV} points at ${override}, which is not an executable file. ${YT_DLP_MISSING_MESSAGE}`);
  }
  const found = await which("yt-dlp", { env, platform: process.platform, isExecutable });
  if (!found) throw new YtDlpMissingError();
  return found;
}

/** `--sub-langs`: the requested language (and its variants), English variants, never live chat. */
export function subLangs(lang = "en"): string {
  const l = lang.trim().toLowerCase().replace(/[^a-z0-9-]/g, "") || "en";
  return [...new Set([`${l}.*`, "en.*"])].concat("-live_chat").join(",");
}

function subtitleArgs(lang: string): string[] {
  return ["--write-subs", "--write-auto-subs", "--sub-langs", subLangs(lang), "--sub-format", "vtt"];
}

/** argv of the metadata run (`-J`: prints one JSON object, downloads nothing). */
export function ytDlpMetadataArgs(url: string, lang = "en"): string[] {
  return [...YT_DLP_SAFETY_ARGS, "-J", "-f", YT_DLP_FORMAT, ...subtitleArgs(lang), "--", url];
}

/** argv of the download run; it runs with cwd = a temp folder inside the project. */
export function ytDlpDownloadArgs(url: string, opts: { lang?: string; maxBytes?: number } = {}): string[] {
  return [
    ...YT_DLP_SAFETY_ARGS,
    "-f",
    YT_DLP_FORMAT,
    "--merge-output-format",
    "mp4",
    "--max-filesize",
    String(opts.maxBytes ?? VIDEO_URL_MAX_BYTES),
    ...subtitleArgs(opts.lang ?? "en"),
    "-o",
    "media.%(ext)s",
    "--",
    url,
  ];
}

export interface RunYtDlpOptions {
  env?: Env;
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Largest stdout kept (the -J JSON); more fails the run. */
  maxStdout?: number;
}

/** Run yt-dlp with an argv array (never a shell) and a filtered environment. */
export function runYtDlp(bin: string, args: readonly string[], opts: RunYtDlpOptions): Promise<{ stdout: string; stderr: string }> {
  const src = opts.env ?? process.env;
  const env: Record<string, string> = { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
  for (const k of YT_DLP_ENV_ALLOW) if (src[k] !== undefined) env[k] = src[k]!;
  const maxStdout = opts.maxStdout ?? 64 * 1024 * 1024;
  return new Promise((resolvePromise, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error("yt-dlp aborted before start"));
      return;
    }
    const child = spawn(bin, args, { cwd: opts.cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let failure: string | undefined;
    const kill = (why: string) => {
      if (failure) return;
      failure = why;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2000).unref();
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
      if (stdout.length > maxStdout) kill(`printed more than ${maxStdout} bytes`);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      stderr = (stderr + c).slice(-16_384);
    });
    const timer = setTimeout(() => kill(`timed out after ${Math.round(opts.timeoutMs / 1000)} s`), opts.timeoutMs);
    timer.unref();
    const onAbort = () => kill("aborted");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (err) => {
      done();
      reject(new Error(`could not start yt-dlp (${bin}): ${err.message}`));
    });
    child.on("close", (code) => {
      done();
      if (code === 0 && !failure) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const tail = stderr.trim().split("\n").slice(-6).join("\n");
      reject(new Error(`yt-dlp ${failure ?? `exited with code ${code}`}${tail ? `:\n${tail}` : ""}`));
    });
  });
}

/** The fields of yt-dlp's `-J` JSON this module reads (all untrusted). */
export interface YtDlpInfo {
  _type?: string;
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  webpage_url?: string;
  license?: string;
  extractor_key?: string;
  is_live?: boolean;
  live_status?: string;
  filesize?: number;
  filesize_approx?: number;
  requested_formats?: Array<{ filesize?: number; filesize_approx?: number }>;
  requested_subtitles?: Record<string, { ext?: string }> | null;
  subtitles?: Record<string, unknown> | null;
  automatic_captions?: Record<string, unknown> | null;
  _version?: { version?: string };
}

/** A short, single-line string from untrusted metadata (control characters dropped). */
function clean(v: unknown, max = 300): string | undefined {
  if (typeof v !== "string") return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters on purpose
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return s ? (s.length > max ? `${s.slice(0, max - 1)}…` : s) : undefined;
}

/** Estimated download size from the metadata (sum of the selected formats), or undefined. */
export function estimatedBytes(info: YtDlpInfo): number | undefined {
  const size = (f: { filesize?: number; filesize_approx?: number }) => (typeof f.filesize === "number" ? f.filesize : typeof f.filesize_approx === "number" ? f.filesize_approx : undefined);
  if (Array.isArray(info.requested_formats) && info.requested_formats.length) {
    const sizes = info.requested_formats.map(size);
    return sizes.every((s) => s !== undefined) ? sizes.reduce((a, b) => a! + b!, 0) : undefined;
  }
  return size(info);
}

const size = (n: number) => (n >= 1024 * 1024 ? `${Math.round(n / 1024 / 1024)} MB` : `${n} bytes`);

function tooLarge(what: string, bytes: number | undefined, max: number): UrlFetchError {
  return new UrlFetchError(
    "too_large",
    `${what} is ${bytes !== undefined ? `about ${size(bytes)}` : "larger than the limit"}; video URLs are limited to ${size(max)}. Download a shorter or lower-resolution copy yourself and ingest the file`,
  );
}

export interface SubtitleFile {
  /** Absolute path while staged. */
  file: string;
  lang: string;
  kind: "manual" | "auto";
}

/** Order subtitles best first: manual before auto, then the requested language, `-orig`, variants. */
export function rankSubtitles<T extends { lang: string; kind: "manual" | "auto" }>(subs: readonly T[], lang = "en"): T[] {
  const l = lang.toLowerCase();
  const score = (s: T) => {
    const x = s.lang.toLowerCase();
    const langScore = x === l ? 0 : x === `${l}-orig` ? 1 : x.startsWith(`${l}-`) ? 2 : x === "en" ? 3 : x.startsWith("en") ? 4 : 5;
    return (s.kind === "manual" ? 0 : 10) + langScore;
  };
  return [...subs].sort((a, b) => score(a) - score(b) || a.lang.localeCompare(b.lang));
}

const MEDIA_OUT = /^media\.(mp4|mkv|webm|mov|m4v|m4a|mp3|ogg|opus|wav|flac|aac)$/i;
const SUB_OUT = /^media\.([A-Za-z0-9_-]{1,40})\.vtt$/;

/** The merged media file and the subtitle files yt-dlp left in `dir`. */
async function collectDownload(dir: string, info: YtDlpInfo): Promise<{ media?: string; subs: SubtitleFile[] }> {
  const names = await readdir(dir);
  const media = names.find((n) => MEDIA_OUT.test(n));
  const manual = new Set(Object.keys(info.subtitles ?? {}));
  const subs: SubtitleFile[] = [];
  for (const n of names) {
    const m = SUB_OUT.exec(n);
    if (!m) continue;
    const file = join(dir, n);
    const st = await stat(file);
    if (!st.isFile() || st.size === 0 || st.size > SUBTITLE_MAX_BYTES) continue;
    subs.push({ file, lang: m[1]!, kind: manual.has(m[1]!) ? "manual" : "auto" });
  }
  return { ...(media ? { media: join(dir, media) } : {}), subs };
}

/** Content types a direct media download accepts (HLS/m3u playlists are not files: refused). */
const DIRECT_TYPES = /^(?:video\/|audio\/)|^(?:application\/(?:octet-stream|mp4|ogg|x-matroska)|binary\/octet-stream)$/;
const isDirectType = (t: string) => DIRECT_TYPES.test(t) && !/mpegurl/.test(t);
const TYPE_EXT: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "video/x-m4v": ".m4v",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/aac": ".aac",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/flac": ".flac",
  "audio/ogg": ".ogg",
  "application/mp4": ".mp4",
  "application/ogg": ".ogg",
};

export interface DirectDownload {
  path: string;
  finalUrl: string;
  bytes: number;
  sha256: string;
  contentType?: string;
}

export interface DirectDownloadOptions {
  fetch?: FetchImpl;
  lookup?: LookupFn;
  allowPrivateAddresses?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Stream a direct media URL into `dir` through the SSRF guard (every hop checked, DNS-pinned),
 * refusing non-media content types and anything over `maxBytes` (declared or streamed).
 */
export async function downloadDirectMedia(url: string, dir: string, opts: DirectDownloadOptions = {}): Promise<DirectDownload> {
  const maxBytes = opts.maxBytes ?? VIDEO_URL_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? VIDEO_URL_DOWNLOAD_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  try {
    const { response: res, finalUrl } = await guardedGet(url, {
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.lookup ? { lookup: opts.lookup } : {}),
      ...(opts.allowPrivateAddresses ? { allowPrivateAddresses: true } : {}),
      signal,
      accept: "video/*,audio/*;q=0.9,application/octet-stream;q=0.5,*/*;q=0.1",
    });
    const mediaType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (mediaType && !isDirectType(mediaType)) {
      await res.body?.cancel().catch(() => {});
      throw new UrlFetchError("unsupported_content_type", `${finalUrl} returned ${mediaType}, not a video or audio file`, mediaType);
    }
    const declared = Number(res.headers.get("content-length"));
    if (res.headers.has("content-length") && Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw tooLarge(finalUrl, declared, maxBytes);
    }
    const pathExt = extname(safeDecode(new URL(finalUrl).pathname)).toLowerCase();
    const ext = MEDIA_URL_EXTENSIONS.has(pathExt) ? pathExt : (TYPE_EXT[mediaType] ?? ".bin");
    const out = join(dir, `download${ext}`);
    const hash = createHash("sha256");
    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          cb(tooLarge(finalUrl, undefined, maxBytes));
          return;
        }
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    if (!res.body) throw new UrlFetchError("network_error", `${finalUrl} returned no body`);
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>), counter, createWriteStream(out), { signal });
    if (bytes === 0) throw new UrlFetchError("network_error", `${finalUrl} returned an empty body`);
    return { path: out, finalUrl, bytes, sha256: hash.digest("hex"), ...(mediaType ? { contentType: mediaType } : {}) };
  } catch (err) {
    if (err instanceof UrlFetchError) throw err;
    if (timeout.aborted) throw new UrlFetchError("timeout", `timed out after ${Math.round(timeoutMs / 1000)} s downloading ${url}`);
    if (opts.signal?.aborted) throw new Error(`download of ${url} was cancelled`);
    throw new UrlFetchError("network_error", `download failed for ${url}: ${(err as Error).message}`);
  }
}

function safeDecode(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

export interface VideoUrlOptions {
  /** Environment: `YT_DLP_PATH`, PATH, proxies (default process.env). */
  env?: Env;
  lookup?: LookupFn;
  /** From the USER's `VS_ALLOW_PRIVATE_URLS=1` only. */
  allowPrivateAddresses?: boolean;
  /** Transport for direct downloads (tests). */
  fetch?: FetchImpl;
  maxBytes?: number;
  /** Preferred subtitle language (default en; English is always requested too). */
  subtitleLanguage?: string;
  timeoutMs?: number;
}

/** The URL without its fragment, used as the ref location (`video:https://…#t=12.0`). */
function refLocation(url: string): string {
  const i = url.indexOf("#");
  return i >= 0 ? url.slice(0, i) : url;
}

function titleFromUrl(url: string): string {
  const u = new URL(url);
  const last = safeDecode(u.pathname.split("/").filter(Boolean).pop() ?? "");
  const stem = last.replace(/\.[^.]+$/, "");
  return clean(stem, 120) ?? u.hostname;
}

/** Stage folder inside the project (never the system temp: the file is renamed into assets). */
async function stageDir(projectDir: string): Promise<string> {
  const base = join(resolve(projectDir), "source", ".downloads");
  await ensureDir(base);
  return mkdtemp(join(base, "dl-"));
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await rmdir(join(dir, "..")).catch(() => {}); // `.downloads` when empty
}

const NO_TRANSCRIPT = "No transcript yet: run transcribe to add what is said as evidence.";

/** Record where the media came from, subtitles, and the rights note on an extracted media part. */
async function finishPart(
  part: ExtractedSource,
  projectDir: string,
  remote: NonNullable<Source["remote"]>,
  subs: readonly SubtitleFile[],
  lang: string,
): Promise<ExtractedSource> {
  const root = resolve(projectDir);
  const main = part.assets.find((a) => (a.kind === "video" || a.kind === "audio") && a.media);
  const files: Array<{ path: string; sha256: string }> = [];
  const recorded: NonNullable<MediaInfo["subtitles"]> = [];
  if (main) {
    for (const s of rankSubtitles(subs, lang)) {
      const safeLang = s.lang.replace(/[^A-Za-z0-9_-]/g, "_");
      const abs = join(root, "source", "assets", `${main.sha256}.${safeLang}.vtt`);
      const rel = relative(root, abs);
      if (rel.startsWith("..") || isAbsolute(rel)) continue;
      await rename(s.file, abs);
      const p = rel.split(sep).join("/");
      files.push({ path: p, sha256: await hashFile(abs) });
      recorded.push({ path: p, lang: s.lang, kind: s.kind });
    }
    if (recorded.length) main.media = { ...main.media!, subtitles: recorded };
  }
  const best = recorded[0];
  const subNote = best
    ? `Subtitles downloaded (${best.kind}, ${best.lang}): ${best.path}. Import them with transcribe captions_file instead of running whisper.`
    : undefined;
  if (subNote) {
    part.sections = part.sections.map((s) => ({ ...s, text: s.text.replace(NO_TRANSCRIPT, subNote) }));
    part.warnings = part.warnings.map((w) =>
      w.code === "needs_transcript" ? { ...w, message: `${remote.url} has no transcript yet; ${best!.kind} subtitles are in ${best!.path}: run transcribe with captions_file ${best!.path}` } : w,
    );
  }
  const host = (() => {
    try {
      return new URL(remote.webpage_url ?? remote.url).hostname;
    } catch {
      return "the web";
    }
  })();
  const hints = part.classificationHints ?? {};
  part.classificationHints = {
    ...hints,
    notes: [
      ...(hints.notes ?? []),
      `rights: downloaded from ${host}${remote.license ? ` (license: ${remote.license})` : " (no license reported)"}; use only videos you have the right to use`,
    ],
  };
  part.source = { ...part.source, remote };
  if (files.length) part.files = files;
  return part;
}

/** Video URL extractor (kind `video_url`); see the module comment. */
export function createVideoUrlExtractor(options: VideoUrlOptions = {}): Extractor {
  const maxBytes = options.maxBytes ?? VIDEO_URL_MAX_BYTES;
  const lang = options.subtitleLanguage ?? "en";
  return {
    version: VIDEO_URL_EXTRACTOR_VERSION,
    kinds: ["video_url"],
    // Keyed on the URL (downloading to hash would defeat the cache): a re-ingest of the same URL
    // reuses the earlier download. Ingest with the extraction cache off to fetch it again.
    async inputDigest(input: ExtractInput): Promise<string> {
      return sha256Hex(JSON.stringify({ kind: "video_url", url: input.uri.trim(), lang, maxBytes, format: YT_DLP_FORMAT }));
    },
    async extract(input: ExtractInput): Promise<ExtractedSource> {
      const url = input.uri.trim();
      const parsed = parseHttpUrl(url);
      if (!input.projectDir) throw new Error("video URLs need a project folder to download into");
      const platform = videoPlatform(url);
      const env = options.env ?? process.env;
      if (!platform) {
        // A direct media file (by extension, or a URL whose content-type said video/audio).
        const dir = await stageDir(input.projectDir);
        try {
          const dl = await downloadDirectMedia(url, dir, {
            ...(options.fetch ? { fetch: options.fetch } : {}),
            ...(options.lookup ? { lookup: options.lookup } : {}),
            ...(options.allowPrivateAddresses ? { allowPrivateAddresses: true } : {}),
            maxBytes,
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          });
          const part = await extractMediaFile(dl.path, {
            projectDir: input.projectDir,
            uri: url,
            title: titleFromUrl(dl.finalUrl),
            refPath: refLocation(url),
            move: true,
            ...(input.signal ? { signal: input.signal } : {}),
          });
          return await finishPart(
            part,
            input.projectDir,
            { url, via: "direct", ...(dl.finalUrl !== url ? { final_url: dl.finalUrl } : {}), bytes: dl.bytes, ...(dl.contentType ? { content_type: dl.contentType } : {}) },
            [],
            lang,
          );
        } finally {
          await cleanup(dir);
        }
      }

      if (platform === "youtube" && parsed.pathname === "/playlist") {
        throw new Error(`${url} is a playlist; ingest the videos one URL at a time`);
      }
      // SSRF: the host must be public before yt-dlp (which resolves it again itself) is started.
      try {
        await checkUrlHost(parsed, { lookup: options.lookup ?? defaultLookup, allowPrivate: options.allowPrivateAddresses === true });
      } catch (err) {
        if (err instanceof BlockedAddressError) throw new UrlFetchError("blocked_address", err.message);
        throw new UrlFetchError("network_error", `could not resolve ${parsed.hostname}: ${(err as Error).message}`);
      }
      const bin = await resolveYtDlp(env);
      const dir = await stageDir(input.projectDir);
      try {
        const meta = await runYtDlp(bin, ytDlpMetadataArgs(url, lang), {
          env,
          cwd: dir,
          timeoutMs: YT_DLP_METADATA_TIMEOUT_MS,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        let info: YtDlpInfo;
        try {
          info = JSON.parse(meta.stdout.trim().split("\n").pop() ?? "") as YtDlpInfo;
        } catch {
          throw new Error(`yt-dlp printed no readable metadata for ${url}`);
        }
        if (!info || typeof info !== "object") throw new Error(`yt-dlp printed no readable metadata for ${url}`);
        if (info._type === "playlist") throw new Error(`${url} is a playlist; ingest the videos one URL at a time`);
        if (info.is_live === true || info.live_status === "is_live" || info.live_status === "is_upcoming") {
          throw new Error(`${url} is a live or upcoming stream; ingest it after it has ended`);
        }
        const est = estimatedBytes(info);
        if (est !== undefined && est > maxBytes) throw tooLarge(clean(info.title) ?? url, est, maxBytes);

        const run = await runYtDlp(bin, ytDlpDownloadArgs(url, { lang, maxBytes }), {
          env,
          cwd: dir,
          timeoutMs: options.timeoutMs ?? VIDEO_URL_DOWNLOAD_TIMEOUT_MS,
          ...(input.signal ? { signal: input.signal } : {}),
        }).catch((err: Error) => {
          if (/max-filesize/i.test(err.message)) throw tooLarge(clean(info.title) ?? url, est, maxBytes);
          throw err;
        });
        const got = await collectDownload(dir, info);
        if (!got.media) {
          // yt-dlp skips a file over --max-filesize and still exits 0.
          if (/max-filesize/i.test(`${run.stdout}\n${run.stderr}`)) throw tooLarge(clean(info.title) ?? url, est, maxBytes);
          throw new Error(`yt-dlp finished but produced no media file for ${url}`);
        }
        const size = (await stat(got.media)).size;
        if (size > maxBytes) throw tooLarge(clean(info.title) ?? url, size, maxBytes);

        const title = clean(info.title) ?? titleFromUrl(url);
        const part = await extractMediaFile(got.media, {
          projectDir: input.projectDir,
          uri: url,
          title,
          refPath: refLocation(url),
          move: true,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        const remote: NonNullable<Source["remote"]> = { url, via: "yt-dlp", bytes: size };
        const put = <K extends keyof typeof remote>(k: K, v: (typeof remote)[K] | undefined) => {
          if (v !== undefined) remote[k] = v;
        };
        put("webpage_url", clean(info.webpage_url, 2000));
        put("extractor", clean(info.extractor_key, 60));
        put("video_id", clean(info.id, 120));
        put("uploader", clean(info.uploader ?? info.channel, 200));
        put("duration_sec", typeof info.duration === "number" && info.duration >= 0 ? info.duration : undefined);
        put("license", clean(info.license, 200));
        put("downloader_version", clean(info._version?.version, 40));
        return await finishPart(part, input.projectDir, remote, got.subs, lang);
      } finally {
        await cleanup(dir);
      }
    },
  };
}

/** Default video URL extractor (process.env, DNS). */
export const videoUrlExtractor: Extractor = createVideoUrlExtractor();

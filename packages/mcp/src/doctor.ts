import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveDataDir } from "@video-studio/core";
import { hasEnvValue as hasValue, locateFfTool, parseBuildconf, which } from "@video-studio/media";
import { checkHyperframes } from "./hyperframes.js";

// ffmpeg/ffprobe location and buildconf parsing live in @video-studio/media (shared with the render path).
export { parseBuildconf, which };

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  id: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  overall: CheckStatus;
  platform: string;
  checks: Check[];
  /** Provider credential presence only. Values are never included. */
  provider_keys: Record<string, boolean>;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

type Env = Record<string, string | undefined>;

/** Everything the doctor touches, injectable for tests. */
export interface DoctorDeps {
  env: Env;
  platform: NodeJS.Platform;
  nodeVersion: string;
  home: string;
  /** Run a binary. Resolves `null` when it cannot be spawned (e.g. ENOENT). */
  exec: (file: string, args: string[]) => Promise<ExecResult | null>;
  /** True if `path` exists and is executable. */
  isExecutable: (path: string) => Promise<boolean>;
  /** Try to load node:sqlite. Returns null on success or an error message. */
  loadSqlite: () => Promise<string | null>;
  /** Create `dir` if needed and verify it is writable. Returns null on success or an error message. */
  probeWritable: (dir: string) => Promise<string | null>;
  /** HyperFrames renderer check (producer installed + headless Chrome launch probe). Omitted = skipped. */
  hyperframes?: () => Promise<Check>;
}

export const MIN_NODE = [22, 13] as const;

export const PROVIDER_KEYS = [
  "RUNWAYML_API_SECRET",
  "ELEVENLABS_API_KEY",
  "HEYGEN_API_KEY",
  "FAL_KEY",
  "KLINGAI_API_KEY",
] as const;

export function defaultDoctorDeps(): DoctorDeps {
  return {
    env: process.env,
    platform: process.platform,
    nodeVersion: process.versions.node,
    home: homedir(),
    exec: (file, args) =>
      new Promise((resolve) => {
        execFile(file, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
          if (err && typeof (err as NodeJS.ErrnoException).code === "string") {
            // Spawn failure (ENOENT, EACCES, ...): not runnable.
            resolve(null);
            return;
          }
          const code = err ? ((err as { code?: number | null }).code ?? 1) : 0;
          resolve({ code: typeof code === "number" ? code : 1, stdout: String(stdout), stderr: String(stderr) });
        });
      }),
    isExecutable: async (path) => {
      try {
        await access(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    loadSqlite: async () => {
      try {
        const mod = (await import("node:sqlite")) as { DatabaseSync?: unknown };
        return typeof mod.DatabaseSync === "function" ? null : "node:sqlite has no DatabaseSync export";
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    probeWritable: async (dir) => {
      try {
        await mkdir(dir, { recursive: true });
        const probe = join(dir, `.doctor-probe-${process.pid}-${Date.now()}`);
        await writeFile(probe, "ok");
        await rm(probe, { force: true });
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    hyperframes: () => checkHyperframes(process.env),
  };
}

export function checkNode(version: string): Check {
  const [maj = 0, min = 0] = version.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10));
  const ok = maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]);
  return ok
    ? { id: "node", status: "ok", detail: `Node v${version.replace(/^v/, "")}` }
    : {
        id: "node",
        status: "fail",
        detail: `Node v${version.replace(/^v/, "")} is older than the required v${MIN_NODE.join(".")}`,
        fix: "Install Node.js 22.13 or newer (LTS 24.x recommended), e.g. via nvm, fnm or https://nodejs.org.",
      };
}

export async function checkSqlite(deps: DoctorDeps): Promise<Check> {
  const err = await deps.loadSqlite();
  return err === null
    ? { id: "sqlite", status: "ok", detail: "node:sqlite is available" }
    : {
        id: "sqlite",
        status: "fail",
        detail: `node:sqlite unavailable: ${err}`,
        fix: "Use Node.js 22.13 or newer, where node:sqlite is available without flags.",
      };
}

const FFMPEG_FIX: Record<"ffmpeg" | "ffprobe", string> = {
  ffmpeg:
    "Install FFmpeg with libass and libx264 (macOS: `brew install ffmpeg`; Debian/Ubuntu: `sudo apt install ffmpeg`), or set FFMPEG_PATH to an ffmpeg binary.",
  ffprobe:
    "Install FFmpeg, which includes ffprobe (macOS: `brew install ffmpeg`; Debian/Ubuntu: `sudo apt install ffmpeg`), or set FFPROBE_PATH.",
};

/** Resolve ffmpeg/ffprobe: env override first, then PATH. Never ffmpeg-static. */
export async function resolveFfTool(
  tool: "ffmpeg" | "ffprobe",
  deps: DoctorDeps,
): Promise<{ path: string | null; check: Check }> {
  const loc = await locateFfTool(tool, deps);
  if (!loc.ok && loc.reason === "bad_override") {
    return {
      path: null,
      check: {
        id: tool,
        status: "fail",
        detail: `${loc.envVar} is set to ${loc.override}, which is not an executable file`,
        fix: `Point ${loc.envVar} at a working ${tool} binary, or unset it to use ${tool} from PATH.`,
      },
    };
  }
  if (!loc.ok) {
    return { path: null, check: { id: tool, status: "fail", detail: `${tool} not found on PATH`, fix: FFMPEG_FIX[tool] } };
  }
  const { path, source } = loc;
  const res = await deps.exec(path, ["-hide_banner", "-version"]);
  if (!res || res.code !== 0) {
    return {
      path: null,
      check: { id: tool, status: "fail", detail: `${path} (from ${source}) failed to run`, fix: FFMPEG_FIX[tool] },
    };
  }
  const first = (res.stdout || res.stderr).split("\n")[0]?.trim() ?? "";
  const ver = /version\s+(\S+)/.exec(first)?.[1] ?? "unknown version";
  return { path, check: { id: tool, status: "ok", detail: `${path} (${ver}, from ${source})` } };
}

export async function checkBuildconf(ffmpegPath: string | null, deps: DoctorDeps): Promise<Check[]> {
  if (!ffmpegPath) {
    const skipped = "skipped: ffmpeg not available";
    return [
      { id: "ffmpeg_libass", status: "warn", detail: skipped },
      { id: "ffmpeg_libx264", status: "warn", detail: skipped },
    ];
  }
  const res = await deps.exec(ffmpegPath, ["-hide_banner", "-buildconf"]);
  if (!res || res.code !== 0) {
    const detail = "could not read `ffmpeg -buildconf`";
    return [
      { id: "ffmpeg_libass", status: "warn", detail },
      { id: "ffmpeg_libx264", status: "warn", detail },
    ];
  }
  const flags = parseBuildconf(`${res.stdout}\n${res.stderr}`);
  return [
    flags.libass
      ? { id: "ffmpeg_libass", status: "ok", detail: "ffmpeg built with --enable-libass (burned-in captions)" }
      : {
          id: "ffmpeg_libass",
          status: "warn",
          detail: "ffmpeg was built without --enable-libass; burned-in ASS captions will not work",
          fix: "Install an FFmpeg build with libass (Homebrew's `ffmpeg` formula includes it), or set FFMPEG_PATH to one.",
        },
    flags.libx264
      ? { id: "ffmpeg_libx264", status: "ok", detail: "ffmpeg built with --enable-libx264 (H.264 output)" }
      : {
          id: "ffmpeg_libx264",
          status: "warn",
          detail: "ffmpeg was built without --enable-libx264; H.264 MP4 encoding will be unavailable",
          fix: "Install an FFmpeg build with libx264 (Homebrew's `ffmpeg` formula includes it), or set FFMPEG_PATH to one.",
        },
  ];
}

export function chromeCandidates(platform: NodeJS.Platform, home: string): string[] {
  if (platform === "darwin") {
    const apps = [
      "Google Chrome.app/Contents/MacOS/Google Chrome",
      "Chromium.app/Contents/MacOS/Chromium",
      "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    ];
    return apps.flatMap((a) => [join("/Applications", a), join(home, "Applications", a)]);
  }
  if (platform === "win32") return [];
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/opt/google/chrome/chrome",
  ];
}

export async function checkChrome(deps: DoctorDeps): Promise<Check> {
  for (const envVar of ["CHROME_PATH", "PUPPETEER_EXECUTABLE_PATH"]) {
    const v = deps.env[envVar];
    if (hasValue(v) && (await deps.isExecutable(v!))) {
      return { id: "chrome", status: "ok", detail: `${v} (from ${envVar})` };
    }
  }
  for (const c of chromeCandidates(deps.platform, deps.home)) {
    if (await deps.isExecutable(c)) return { id: "chrome", status: "ok", detail: c };
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const p = await which(name, deps);
    if (p) return { id: "chrome", status: "ok", detail: p };
  }
  return {
    id: "chrome",
    status: "warn",
    detail: "Chrome/Chromium not found (needed for the HyperFrames renderer; the ffmpeg renderer works without it)",
    fix: "Install Google Chrome or Chromium, or set CHROME_PATH to its executable.",
  };
}

export async function checkWhisper(deps: DoctorDeps): Promise<Check> {
  const override = deps.env.WHISPER_CPP_PATH;
  if (hasValue(override) && (await deps.isExecutable(override!))) {
    return { id: "whisper_cpp", status: "ok", detail: `${override} (from WHISPER_CPP_PATH)` };
  }
  for (const name of ["whisper-cli", "whisper-cpp", "main"]) {
    const p = await which(name, deps);
    if (p) {
      const note = name === "main" ? " (generic name `main`; confirm it is whisper.cpp)" : "";
      return { id: "whisper_cpp", status: "ok", detail: `${p}${note}` };
    }
  }
  return {
    id: "whisper_cpp",
    status: "warn",
    detail: "whisper.cpp not found (optional: local transcription of recorded voiceovers)",
    fix: "Install whisper.cpp (macOS: `brew install whisper-cpp`) or set WHISPER_CPP_PATH.",
  };
}

export function checkProviderKeys(env: Env): { check: Check; keys: Record<string, boolean> } {
  const keys = Object.fromEntries(PROVIDER_KEYS.map((k) => [k, hasValue(env[k])])) as Record<string, boolean>;
  const present = PROVIDER_KEYS.filter((k) => keys[k]);
  const missing = PROVIDER_KEYS.filter((k) => !keys[k]);
  const detail =
    `present: ${present.length ? present.join(", ") : "none"}; missing: ${missing.length ? missing.join(", ") : "none"}` +
    " (optional; local/mock paths need no keys)";
  const check: Check = { id: "provider_keys", status: "ok", detail };
  if (missing.length) {
    check.fix = "Set keys via `/plugin` → video-studio → Configure (stored in the OS keychain), or export the env vars for the dev CLI.";
  }
  return { check, keys };
}

export async function checkDataDir(deps: DoctorDeps): Promise<Check> {
  let root: string;
  try {
    root = resolveDataDir(deps.env, deps.home).root;
  } catch (err) {
    return {
      id: "data_dir",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      fix: "Set CLAUDE_PLUGIN_DATA or VIDEO_STUDIO_DATA to a writable directory outside the plugin root.",
    };
  }
  const source = hasValue(deps.env.CLAUDE_PLUGIN_DATA)
    ? "CLAUDE_PLUGIN_DATA"
    : hasValue(deps.env.VIDEO_STUDIO_DATA)
      ? "VIDEO_STUDIO_DATA"
      : "default";
  const err = await deps.probeWritable(root);
  return err === null
    ? { id: "data_dir", status: "ok", detail: `${root} (from ${source}, writable)` }
    : {
        id: "data_dir",
        status: "fail",
        detail: `${root} (from ${source}) is not writable: ${err}`,
        fix: "Fix permissions on that directory, or set VIDEO_STUDIO_DATA to a writable location.",
      };
}

export async function runDoctor(deps: DoctorDeps = defaultDoctorDeps()): Promise<DoctorReport> {
  const checks: Check[] = [checkNode(deps.nodeVersion), await checkSqlite(deps)];
  const ffmpeg = await resolveFfTool("ffmpeg", deps);
  const ffprobe = await resolveFfTool("ffprobe", deps);
  checks.push(ffmpeg.check, ffprobe.check, ...(await checkBuildconf(ffmpeg.path, deps)));
  checks.push(await checkChrome(deps));
  if (deps.hyperframes) checks.push(await deps.hyperframes());
  checks.push(await checkWhisper(deps));
  const keys = checkProviderKeys(deps.env);
  checks.push(keys.check, await checkDataDir(deps));
  const overall: CheckStatus = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : "ok";
  return { ok: overall !== "fail", overall, platform: deps.platform, checks, provider_keys: keys.keys };
}

const ICON: Record<CheckStatus, string> = { ok: "[ok]  ", warn: "[warn]", fail: "[FAIL]" };

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [`video-studio doctor: ${report.overall.toUpperCase()} (${report.platform})`, ""];
  for (const c of report.checks) {
    lines.push(`${ICON[c.status]} ${c.id}: ${c.detail}`);
    if (c.fix && c.status !== "ok") lines.push(`       fix: ${c.fix}`);
  }
  return lines.join("\n");
}

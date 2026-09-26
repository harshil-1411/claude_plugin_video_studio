import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { Env } from "./types.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  signal?: AbortSignal;
  env?: Env;
  /** Kill the process after this long (SIGTERM, then SIGKILL). Default {@link DEFAULT_COMMAND_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Default per-call timeout for external commands (say, espeak-ng, ffmpeg helpers): 5 minutes. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
/** Grace period between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 2000;

/** Runs a command (no shell). Injected everywhere so tests never depend on real binaries. */
export type CommandRunner = (cmd: string, args: string[], opts?: RunOptions) => Promise<CommandResult>;

function abortError(cmd: string, signal: AbortSignal): Error {
  const reason = signal.reason instanceof Error ? `: ${signal.reason.message}` : "";
  const e = new Error(`${cmd} aborted${reason}`);
  e.name = "AbortError";
  return e;
}

/**
 * Spawn `cmd` with an argv array. Aborting `signal` or exceeding `timeoutMs` sends SIGTERM, then
 * SIGKILL after a short grace period, and rejects (AbortError / timeout error) once the child is gone.
 */
export const defaultRunner: CommandRunner = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const signal = opts.signal;
    if (signal?.aborted) {
      reject(abortError(cmd, signal));
      return;
    }
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env ? ({ ...process.env, ...opts.env } as NodeJS.ProcessEnv) : process.env,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let killedFor: "aborted" | "timeout" | null = null;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
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
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => {
      done();
      reject(e);
    });
    child.on("close", (code) => {
      done();
      if (killedFor === "aborted") return reject(abortError(cmd, signal!));
      if (killedFor === "timeout") return reject(new Error(`${cmd} timed out after ${timeoutMs} ms and was killed`));
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Find an executable on PATH. */
export function which(name: string, env: Env = process.env): string | undefined {
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const p = join(dir, name);
    if (isExecutable(p)) return p;
  }
  return undefined;
}

/**
 * Resolve ffmpeg/ffprobe: FFMPEG_PATH / FFPROBE_PATH first, then PATH.
 * TODO: swap for @video-studio/media's resolver once it lands.
 */
export function resolveFfTool(name: "ffmpeg" | "ffprobe", env: Env = process.env): string | undefined {
  const override = env[name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"];
  if (override && override.trim()) return isExecutable(override) ? override : undefined;
  return which(name, env);
}

/** Resolves a tool name to a path (injectable for tests). */
export type ToolResolver = (name: string, env: Env) => string | undefined;

export const defaultResolver: ToolResolver = (name, env) => {
  if (name === "ffmpeg" || name === "ffprobe") return resolveFfTool(name, env);
  const found = which(name, env);
  if (found) return found;
  if (name === "say" && isExecutable("/usr/bin/say")) return "/usr/bin/say";
  return undefined;
};

export async function runChecked(
  runner: CommandRunner,
  cmd: string,
  args: string[],
  what: string,
  opts?: RunOptions,
): Promise<CommandResult> {
  const res = await runner(cmd, args, opts);
  if (res.code !== 0) {
    const tail = res.stderr.trim().split("\n").slice(-3).join(" | ");
    throw new Error(`${what} failed (exit ${res.code})${tail ? `: ${tail}` : ""}`);
  }
  return res;
}

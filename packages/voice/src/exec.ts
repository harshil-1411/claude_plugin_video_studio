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
}

/** Runs a command (no shell). Injected everywhere so tests never depend on real binaries. */
export type CommandRunner = (cmd: string, args: string[], opts?: RunOptions) => Promise<CommandResult>;

export const defaultRunner: CommandRunner = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      signal: opts.signal,
      env: opts.env ? ({ ...process.env, ...opts.env } as NodeJS.ProcessEnv) : process.env,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }),
    );
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

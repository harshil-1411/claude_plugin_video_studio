import { describe, expect, it } from "vitest";
import { DEFAULT_COMMAND_TIMEOUT_MS, defaultRunner } from "./exec.js";

describe("defaultRunner", () => {
  it("runs a command and collects its output", async () => {
    const r = await defaultRunner("/bin/sh", ["-c", "echo hi; echo err 1>&2; exit 3"]);
    expect(r).toEqual({ code: 3, stdout: "hi\n", stderr: "err\n" });
  });

  it("kills a command that exceeds its timeout", async () => {
    const started = Date.now();
    await expect(defaultRunner("sleep", ["10"], { timeoutMs: 200 })).rejects.toThrow(/sleep timed out after 200 ms/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const started = Date.now();
    await expect(defaultRunner("/bin/sh", ["-c", "trap '' TERM; exec sleep 10"], { timeoutMs: 100 })).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10_000);

  it("stops on abort with an AbortError", async () => {
    const ac = new AbortController();
    const run = defaultRunner("sleep", ["10"], { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    const err = (await run.catch((e: unknown) => e)) as Error;
    expect(err.name).toBe("AbortError");
    await expect(defaultRunner("sleep", ["1"], { signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("defaults to a generous timeout", () => {
    expect(DEFAULT_COMMAND_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });
});

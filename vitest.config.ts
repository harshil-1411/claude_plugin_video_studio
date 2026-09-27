import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "tests/**/*.test.ts"],
    // One temp root per run, removed at the end (tests mkdtemp freely without leaking).
    globalSetup: ["tests/setup/tmp-root.ts"],
    // Keep resource use low on small machines.
    pool: "forks",
    maxWorkers: 2,
    // Many tests run real ffmpeg on tiny clips; under a full two-worker run the slowest pass 5 s,
    // so the default timeout flaked. Tests that need longer still set their own.
    testTimeout: 20_000,
  },
});

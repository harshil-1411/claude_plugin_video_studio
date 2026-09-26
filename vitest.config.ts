import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "tests/**/*.test.ts"],
    // One temp root per run, removed at the end (tests mkdtemp freely without leaking).
    globalSetup: ["tests/setup/tmp-root.ts"],
    // Keep resource use low on small machines.
    pool: "forks",
    maxWorkers: 2,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "tests/**/*.test.ts"],
    // Keep resource use low on small machines.
    pool: "forks",
    maxWorkers: 2,
  },
});

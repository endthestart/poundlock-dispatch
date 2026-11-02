import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve("src/shared"),
      "@core": resolve("src/core"),
      "@runtime": resolve("src/runtime"),
      "@tui": resolve("src/tui"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/support/setup-git-env.ts", "tests/support/no-drive-flush.ts"],
    // The engine tests spawn dozens of git processes each: the slowest takes about 6 s alone at
    // load 18, and the full suite beside other builds pushed them past 20 s (30 Oct).
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

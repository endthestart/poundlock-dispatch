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
    setupFiles: ["tests/support/setup-git-env.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});

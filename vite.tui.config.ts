import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * The terminal client is a plain Node program, not an Electron target, so it
 * is built here rather than by electron-vite. Dependencies stay external: this
 * bundles Dispatch's own source so the `@core`/`@shared`/`@runtime` aliases
 * resolve at runtime, and nothing more.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve("src/shared"),
      "@core": resolve("src/core"),
      "@runtime": resolve("src/runtime"),
      "@tui": resolve("src/tui"),
    },
  },
  build: {
    target: "node22",
    outDir: "out/tui",
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    lib: { entry: resolve("src/tui/index.ts"), formats: ["es"], fileName: () => "index.js" },
    rollupOptions: {
      external: (id) =>
        !id.startsWith(".") &&
        !id.startsWith("/") &&
        !id.startsWith("@core") &&
        !id.startsWith("@shared") &&
        !id.startsWith("@runtime") &&
        !id.startsWith("@tui"),
      output: { banner: "#!/usr/bin/env node" },
    },
  },
});

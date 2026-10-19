import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
        "@core": resolve("src/core"),
        "@runtime": resolve("src/runtime"),
      },
    },
  },
  preload: {
    plugins: [
      externalizeDepsPlugin(),
      {
        name: "dispatch-preload-cjs",
        enforce: "post",
        config(config) {
          config.build = config.build ?? {};
          const entry = resolve("src/preload/index.ts");
          const fallbackLib =
            typeof config.build.lib === "object" && config.build.lib ? config.build.lib : {};
          config.build.lib = { ...fallbackLib, formats: ["cjs"], entry };
          const output = config.build.rollupOptions?.output;
          if (output && !Array.isArray(output)) {
            output.format = "cjs";
            output.entryFileNames = "index.cjs";
            output.inlineDynamicImports = true;
          }
        },
      },
    ],
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "index.cjs",
          inlineDynamicImports: true,
        },
      },
    },
  },
  renderer: {
    base: "./",
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
        "@renderer": resolve("src/renderer"),
      },
    },
    plugins: [
      react(),
      {
        name: "dispatch-file-protocol",
        transformIndexHtml(html) {
          return html.replaceAll(" crossorigin", "");
        },
      },
    ],
  },
});

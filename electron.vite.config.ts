import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

// electron-vite 5 externalizes dependencies by default (build.externalizeDeps),
// so native addons added in Plan 3 are never bundled.
export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: { index: resolve(__dirname, "src/main/index.ts") } },
    },
  },
  preload: {
    build: {
      rollupOptions: { input: { publisher: resolve(__dirname, "src/preload/publisher.ts") } },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: {
      rollupOptions: {
        input: { publisher: resolve(__dirname, "src/renderer/publisher/index.html") },
      },
    },
  },
});

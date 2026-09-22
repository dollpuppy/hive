import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(__dirname, "src/viewer"),
  base: "/viewer/",
  build: {
    outDir: resolve(__dirname, "out/viewer"),
    emptyOutDir: true,
    target: "chrome120",
  },
});

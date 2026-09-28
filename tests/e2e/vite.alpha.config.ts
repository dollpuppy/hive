import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(__dirname, "alpha"),
  base: "/alpha/",
  logLevel: "warn",
  build: { outDir: resolve(__dirname, ".alpha-dist"), emptyOutDir: true, target: "chrome120" },
});

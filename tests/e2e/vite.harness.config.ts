import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(__dirname, "harness"),
  base: "/harness/",
  logLevel: "warn",
  build: { outDir: resolve(__dirname, ".harness-dist"), emptyOutDir: true, target: "chrome120" },
});

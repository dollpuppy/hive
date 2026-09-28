import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(__dirname, "../../src/renderer/dashboard"),
  base: "/dash/",
  logLevel: "warn",
  build: { outDir: resolve(__dirname, ".dashboard-dist"), emptyOutDir: true, target: "chrome120" },
});

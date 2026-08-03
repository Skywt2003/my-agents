import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const sourceRoot = resolve("src");

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@": sourceRoot } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@": sourceRoot } },
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: { "@": sourceRoot } },
  },
});

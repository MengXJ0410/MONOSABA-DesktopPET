import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
        // 用 Pixi 自带的单文件 ESM，避免 Vite 对 Pixi 内部模块分块时产生循环依赖
        // （曾导致 `Bounds is not a constructor`）。
        "pixi.js": resolve("node_modules/pixi.js/dist/pixi.mjs"),
      },
    },
    plugins: [react()],
  },
});

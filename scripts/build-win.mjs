import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// 默认人物决定 exe 图标：希罗黑红，艾玛白粉。
const isEma = process.env.VITE_DEFAULT_CHARACTER === "ema";
const icon = isEma ? "build/icon-ema.ico" : "build/icon.ico";
const iconPath = resolve(icon);

if (!existsSync(iconPath)) {
  console.error(`[build:win] 找不到图标文件：${iconPath}`);
  process.exit(1);
}

const cli = resolve("node_modules", "electron-builder", "cli.js");
const result = spawnSync(
  process.execPath,
  [cli, "--win", "portable", `--config.win.icon=${icon}`],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);

import { app } from "electron";
import { execFile } from "node:child_process";
import { readFileSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 显示器的物理分辨率。
 *
 * Electron 的 `display.size` 是 DIP 且被取整过（1707 × 1.5 = 2560.5 → 2561），
 * 面板上要显示 2560×1600 / 2560×1440 这种和 Windows 设置一致的数值，
 * 所以用一次 PowerShell（DPI aware）读 Screen.AllScreens 的物理像素。
 * 排序规则与 capture.ts 一致：按 Bounds.X、Bounds.Y。
 */
export type PhysicalScreen = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const SCRIPT = `Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System.Runtime.InteropServices;
public class MonosabaPhysicalDpi {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
}
"@
[MonosabaPhysicalDpi]::SetProcessDPIAware() | Out-Null
[System.Windows.Forms.Screen]::AllScreens | Sort-Object { $_.Bounds.X }, { $_.Bounds.Y } | ForEach-Object { "$($_.Bounds.X)|$($_.Bounds.Y)|$($_.Bounds.Width)|$($_.Bounds.Height)" }
`;

let cache: PhysicalScreen[] = loadCache();
let refreshing: Promise<boolean> | null = null;
let scriptReady: Promise<string> | null = null;

function cachePath(): string {
  return join(app.getPath("userData"), "display-metrics.json");
}

function parseScreens(text: string): PhysicalScreen[] {
  const screens: PhysicalScreen[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split("|");
    if (parts.length !== 4) continue;
    const values = parts.map((part) => Number(part));
    if (!values.every((value) => Number.isFinite(value))) continue;
    const [x, y, width, height] = values;
    if (width <= 0 || height <= 0) continue;
    screens.push({ x, y, width, height });
  }
  return screens;
}

function loadCache(): PhysicalScreen[] {
  try {
    const data = JSON.parse(readFileSync(cachePath(), "utf8"));
    if (!Array.isArray(data)) return [];
    return data.filter(
      (item): item is PhysicalScreen =>
        item &&
        typeof item === "object" &&
        Number.isFinite(item.x) &&
        Number.isFinite(item.y) &&
        Number.isFinite(item.width) &&
        Number.isFinite(item.height) &&
        item.width > 0 &&
        item.height > 0,
    );
  } catch {
    return [];
  }
}

async function writeCache(screens: PhysicalScreen[]): Promise<void> {
  try {
    await fs.writeFile(cachePath(), JSON.stringify(screens), "utf8");
  } catch {
    // 缓存写不进去只影响下次启动的初始显示，不影响本次。
  }
}

async function ensureScript(): Promise<string> {
  if (!scriptReady) {
    scriptReady = (async () => {
      const path = join(app.getPath("temp"), "monosaba-display-metrics.ps1");
      try {
        const existing = await fs.readFile(path, "utf8");
        if (existing === SCRIPT) return path;
      } catch {
        // 文件不存在时直接写。
      }
      await fs.writeFile(path, SCRIPT, "utf8");
      return path;
    })().catch((error) => {
      scriptReady = null;
      throw error;
    });
  }
  return scriptReady;
}

/** 最近一次读到的物理屏幕列表；还没读到时为空数组，调用方退回 DIP 估算。 */
export function physicalScreens(): PhysicalScreen[] {
  return cache;
}

/**
 * 重新读取物理分辨率。返回列表是否发生变化，调用方据此通知渲染层刷新。
 * 失败时保留旧值，不抛错。
 */
export function refreshPhysicalScreens(): Promise<boolean> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const scriptPath = await ensureScript();
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
        ],
        { encoding: "utf8", timeout: 6_000, windowsHide: true },
      );
      const screens = parseScreens(stdout);
      if (screens.length === 0) return false;
      const changed = JSON.stringify(screens) !== JSON.stringify(cache);
      cache = screens;
      if (changed) void writeCache(screens);
      return changed;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

import { app } from "electron";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 读取前台窗口，找到它覆盖最多的显示器，并按「X/Y 排序后的下标」输出。
 * 排序与 capture.ts 的 Screen.AllScreens / Electron display 顺序一致。
 * 只有窗口覆盖该屏 ≥90% 时才算全屏，避免普通窗口把光标所在屏抢走。
 */
const ACTIVE_WINDOW_SCRIPT = `Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MonosabaForeground {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
public class MonosabaDpi {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[MonosabaDpi]::SetProcessDPIAware() | Out-Null

$handle = [MonosabaForeground]::GetForegroundWindow()
if ($handle -eq [IntPtr]::Zero) { exit 2 }
$rect = New-Object MonosabaForeground+RECT
if (-not [MonosabaForeground]::GetWindowRect($handle, [ref]$rect)) { exit 2 }

$screens = [System.Windows.Forms.Screen]::AllScreens | Sort-Object { $_.Bounds.X }, { $_.Bounds.Y }
$best = -1
$bestArea = 0
for ($i = 0; $i -lt $screens.Count; $i++) {
    $b = $screens[$i].Bounds
    $left = [Math]::Max($b.X, $rect.Left)
    $top = [Math]::Max($b.Y, $rect.Top)
    $right = [Math]::Min($b.Right, $rect.Right)
    $bottom = [Math]::Min($b.Bottom, $rect.Bottom)
    $width = $right - $left
    $height = $bottom - $top
    if ($width -le 0 -or $height -le 0) { continue }
    $area = $width * $height
    if ($area -gt $bestArea) {
        $bestArea = $area
        $best = $i
    }
}

if ($best -lt 0) { exit 3 }
$screen = $screens[$best].Bounds
$full = ($bestArea -ge 0.9 * $screen.Width * $screen.Height)
"$best|$([int]$full)"
`;

let scriptReady: Promise<string> | null = null;

async function ensureScript(): Promise<string> {
  if (!scriptReady) {
    scriptReady = (async () => {
      const path = join(app.getPath("temp"), "monosaba-active-window.ps1");
      try {
        const existing = await fs.readFile(path, "utf8");
        if (existing === ACTIVE_WINDOW_SCRIPT) return path;
      } catch {
        // 文件不存在时直接写。
      }
      await fs.writeFile(path, ACTIVE_WINDOW_SCRIPT, "utf8");
      return path;
    })().catch((error) => {
      scriptReady = null;
      throw error;
    });
  }
  return scriptReady;
}

/**
 * 前台窗口若是全屏，返回它所在显示器在下标排序里的位置；否则返回 null。
 * 失败时静默返回 null，调用方继续按鼠标位置选屏。
 */
export async function getActiveFullscreenDisplayIndex(): Promise<number | null> {
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
      {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      },
    );
    const match = stdout.trim().match(/(\d+)\|([01])/);
    if (!match) return null;
    return match[2] === "1" ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

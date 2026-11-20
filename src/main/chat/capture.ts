import { app, desktopCapturer, screen, type Display } from "electron";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CapturedScreen = {
  /** 不带 data: 前缀的 JPEG base64，直接交给桥接插件。 */
  base64: string;
  /** 给聊天框缩略图用的完整 data URL。 */
  dataUrl: string;
  width: number;
  height: number;
};

/** AstrBot 的 image_compress_options.max_size 是 1280，这里截 1280 正好。 */
const MAX_WIDTH = 1280;
const JPEG_QUALITY = 85;

/** AI 指针：只用来判断“屏幕变了什么”，768 / 70 已足够看清窗口和页面结构。 */
export const POINTER_MAX_WIDTH = 768;
export const POINTER_JPEG_QUALITY = 70;
/** AI 观察不能像点评那样等 20 秒；超时就跳过这一轮。 */
export const POINTER_CAPTURE_TIMEOUT_MS = 8_000;

export type CaptureOptions = {
  /** 长边上限；0 表示不缩放。 */
  maxWidth?: number;
  /** JPEG 质量 1~100。 */
  quality?: number;
  /** PowerShell 兜底的最长执行时间。 */
  timeoutMs?: number;
};

/**
 * Electron 的 desktopCapturer 在这台机器上只枚举得到副屏（WGC 对主屏返回
 * “Source is not capturable”）。主屏用 PowerShell + GDI 的 CopyFromScreen
 * 兜底；Screen.AllScreens 按 X/Y 排序后与 Electron 的显示器顺序一致。
 */
const CAPTURE_SCRIPT = `param([int]$Index = 0, [int]$MaxWidth = 0, [int]$Quality = 85)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System.Runtime.InteropServices;
public class MonosabaDpi {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
}
"@
[MonosabaDpi]::SetProcessDPIAware() | Out-Null
$screens = [System.Windows.Forms.Screen]::AllScreens | Sort-Object { $_.Bounds.X }, { $_.Bounds.Y }
if ($Index -lt 0 -or $Index -ge $screens.Count) { exit 3 }
$r = $screens[$Index].Bounds
$full = New-Object System.Drawing.Bitmap($r.Width, $r.Height)
$g0 = [System.Drawing.Graphics]::FromImage($full)
$g0.CopyFromScreen($r.X, $r.Y, 0, 0, $full.Size)
$g0.Dispose()
$w = $r.Width
$h = $r.Height
if ($MaxWidth -gt 0 -and $w -gt $MaxWidth) {
    $scale = $MaxWidth / $w
    $w = [int][Math]::Max(1, [Math]::Round($r.Width * $scale))
    $h = [int][Math]::Max(1, [Math]::Round($r.Height * $scale))
}
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($full, 0, 0, $w, $h)
$g.Dispose()
$full.Dispose()
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$params = New-Object System.Drawing.Imaging.EncoderParameters(1)
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, $Quality)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, $codec, $params)
[Convert]::ToBase64String($ms.ToArray())
$bmp.Dispose()
$ms.Dispose()
`;

let scriptReady: Promise<string> | null = null;
/** 记录每块屏幕实际能用的截图方式，避免每次都先等 desktopCapturer 超时。 */
const methodCache = new Map<string, "capturer" | "powershell">();
/** desktopCapturer 在部分屏幕 / 全屏游戏下会卡住，最多等这么久就切 PowerShell。 */
const CAPTURER_TIMEOUT_MS = 2500;

/** 给可能卡住的异步调用加一个上限；超时返回 null，调用方继续走兜底。 */
async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toSourceId(displayId: string | number | null | undefined): string {
  return displayId === null || displayId === undefined ? "" : String(displayId);
}

/** 与 captureDisplay 的 PowerShell 下标共用同一套显示器排序。 */
export function sortedDisplays(): Display[] {
  return [...screen.getAllDisplays()].sort(
    (a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y || a.id - b.id,
  );
}

async function ensureScript(): Promise<string> {
  if (!scriptReady) {
    scriptReady = (async () => {
      const path = join(app.getPath("temp"), "monosaba-screen-capture.ps1");
      try {
        const existing = await fs.readFile(path, "utf8");
        if (existing === CAPTURE_SCRIPT) return path;
      } catch {
        // 文件不存在时直接写。
      }
      await fs.writeFile(path, CAPTURE_SCRIPT, "utf8");
      return path;
    })().catch((error) => {
      scriptReady = null;
      throw error;
    });
  }
  return scriptReady;
}

async function captureWithDesktopCapturer(
  target: Display,
  maxWidth: number,
  quality: number,
): Promise<CapturedScreen | null> {
  const physicalWidth = Math.max(
    1,
    Math.round(target.size.width * target.scaleFactor),
  );
  const physicalHeight = Math.max(
    1,
    Math.round(target.size.height * target.scaleFactor),
  );
  const limit = maxWidth > 0 ? maxWidth : physicalWidth;
  const scale = Math.min(1, limit / physicalWidth);
  const width = Math.max(1, Math.round(physicalWidth * scale));
  const height = Math.max(1, Math.round(physicalHeight * scale));

  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width, height },
    fetchWindowIcons: false,
  });
  const wanted = toSourceId(target.id);
  // 不能回退到 sources[0]：那会把别的屏幕当成目标屏。
  const source = sources.find((item) => item.display_id === wanted);
  if (!source) return null;

  const image = source.thumbnail;
  if (image.isEmpty()) return null;
  const jpeg = image.toJPEG(quality);
  if (!jpeg || jpeg.length === 0) return null;

  const size = image.getSize();
  const base64 = jpeg.toString("base64");
  return {
    base64,
    dataUrl: `data:image/jpeg;base64,${base64}`,
    width: size.width,
    height: size.height,
  };
}

async function captureWithPowerShell(
  index: number,
  maxWidth: number,
  quality: number,
  timeoutMs: number,
): Promise<CapturedScreen | null> {
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
      "-Index",
      String(index),
      "-MaxWidth",
      String(Math.max(0, Math.round(maxWidth))),
      "-Quality",
      String(Math.max(1, Math.min(100, Math.round(quality)))),
    ],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  );

  const base64 = stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
  if (!base64) return null;
  return {
    base64,
    dataUrl: `data:image/jpeg;base64,${base64}`,
    width: 0,
    height: 0,
  };
}

/**
 * 截取指定显示器；截图会包含桌宠和聊天框（按当前产品设定）。
 * 先试 Electron desktopCapturer，目标屏没有 source 时用 PowerShell 兜底。
 * 每块屏幕记住能用的方式：主屏 desktopCapturer 不可用时，下次直接走 PowerShell，
 * 不会再白等一次超时（否则一次点评可能多花十几秒）。
 */
export async function captureDisplay(
  displayId?: string,
  options: CaptureOptions = {},
): Promise<CapturedScreen | null> {
  const maxWidth = options.maxWidth ?? MAX_WIDTH;
  const quality = options.quality ?? JPEG_QUALITY;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const displays = sortedDisplays();
  const target =
    displays.find((display) => toSourceId(display.id) === displayId) ??
    screen.getPrimaryDisplay();
  const index = displays.findIndex((display) => display.id === target.id);
  const key = toSourceId(target.id);
  const preferred = methodCache.get(key);

  const viaPowerShell = async (): Promise<CapturedScreen | null> => {
    try {
      const shot = await captureWithPowerShell(index >= 0 ? index : 0, maxWidth, quality, timeoutMs);
      if (shot) methodCache.set(key, "powershell");
      return shot;
    } catch (error) {
      console.warn("[chat] PowerShell screen capture failed", error);
      return null;
    }
  };

  if (preferred === "powershell") {
    const shot = await viaPowerShell();
    if (shot) return shot;
  }

  try {
    const direct = await withTimeout(
      captureWithDesktopCapturer(target, maxWidth, quality),
      CAPTURER_TIMEOUT_MS,
    );
    if (direct) {
      methodCache.set(key, "capturer");
      return direct;
    }
  } catch (error) {
    console.warn("[chat] desktopCapturer failed", error);
  }

  return viaPowerShell();
}

/** AI 指针专用：更小的长边和更低的质量，单轮控制在几十 KB。 */
export async function captureDisplayForPointer(
  displayId?: string,
): Promise<CapturedScreen | null> {
  return captureDisplay(displayId, {
    maxWidth: POINTER_MAX_WIDTH,
    quality: POINTER_JPEG_QUALITY,
    timeoutMs: POINTER_CAPTURE_TIMEOUT_MS,
  });
}

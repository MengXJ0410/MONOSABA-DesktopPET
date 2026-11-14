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

/**
 * Electron 的 desktopCapturer 在这台机器上只枚举得到副屏（WGC 对主屏返回
 * “Source is not capturable”）。主屏用 PowerShell + GDI 的 CopyFromScreen
 * 兜底；Screen.AllScreens 按 X/Y 排序后与 Electron 的显示器顺序一致。
 */
const CAPTURE_SCRIPT = `param([int]$Index = 0)
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
$bmp = New-Object System.Drawing.Bitmap($r.Width, $r.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.X, $r.Y, 0, 0, $bmp.Size)
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$params = New-Object System.Drawing.Imaging.EncoderParameters(1)
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, ${JPEG_QUALITY})
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, $codec, $params)
[Convert]::ToBase64String($ms.ToArray())
$g.Dispose()
$bmp.Dispose()
$ms.Dispose()
`;

let scriptReady: Promise<string> | null = null;

function toSourceId(displayId: string | number | null | undefined): string {
  return displayId === null || displayId === undefined ? "" : String(displayId);
}

function sortedDisplays(): Display[] {
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
): Promise<CapturedScreen | null> {
  const physicalWidth = Math.max(
    1,
    Math.round(target.size.width * target.scaleFactor),
  );
  const physicalHeight = Math.max(
    1,
    Math.round(target.size.height * target.scaleFactor),
  );
  const scale = Math.min(1, MAX_WIDTH / physicalWidth);
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
  const jpeg = image.toJPEG(JPEG_QUALITY);
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
    ],
    {
      encoding: "utf8",
      timeout: 20_000,
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
 */
export async function captureDisplay(
  displayId?: string,
): Promise<CapturedScreen | null> {
  const displays = sortedDisplays();
  const target =
    displays.find((display) => toSourceId(display.id) === displayId) ??
    screen.getPrimaryDisplay();
  const index = displays.findIndex((display) => display.id === target.id);

  try {
    const direct = await captureWithDesktopCapturer(target);
    if (direct) return direct;
  } catch (error) {
    console.warn("[chat] desktopCapturer failed", error);
  }

  try {
    return await captureWithPowerShell(index >= 0 ? index : 0);
  } catch (error) {
    console.warn("[chat] PowerShell screen capture failed", error);
    return null;
  }
}

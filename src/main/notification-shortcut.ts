import { app } from "electron";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Windows 的 toast 点击是按 AppUserModelID 找开始菜单快捷方式再启动目标程序。
 * 便携版每次解压到新的临时目录，旧的快捷方式会指向已删除的 exe；
 * 如果开发时还留下同名 AUMID 的 Electron 快捷方式，点击通知就会打开原生 Electron。
 * 所以启动时把快捷方式修到真正的启动器，并清掉指向 electron.exe 的同类快捷方式。
 */

const AUMID = "com.mengxj.monosaba.desktop-pet";
const SHORTCUT_NAME = "MONOSABA DesktopPET.lnk";

/** 纯 ASCII，避免 PowerShell 5 按 GBK 读取 UTF-8 注释导致解析错位。 */
const SCRIPT = String.raw`param(
  [Parameter(Mandatory = $true)][string]$ShortcutPath,
  [Parameter(Mandatory = $true)][string]$Target,
  [string]$Arguments = "",
  [string]$WorkDir = "",
  [string]$Icon = "",
  [Parameter(Mandatory = $true)][string]$Aumid
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct PROPERTYKEY {
    public Guid fmtid;
    public uint pid;
}

[StructLayout(LayoutKind.Explicit, Size = 24)]
public struct PROPVARIANT {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(2)] public ushort r1;
    [FieldOffset(4)] public ushort r2;
    [FieldOffset(6)] public ushort r3;
    [FieldOffset(8)] public IntPtr pointerValue;
}

[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore {
    [PreserveSig] int GetCount(out uint cProps);
    [PreserveSig] int GetAt(uint iProp, out PROPERTYKEY pkey);
    [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
    [PreserveSig] int Commit();
}

public static class ShortcutAumid {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHGetPropertyStoreFromParsingName(
        string pszPath, IntPtr pbc, uint flags, ref Guid riid, out IPropertyStore ppv);

    public static void Set(string path, string value) {
        Guid iid = typeof(IPropertyStore).GUID;
        IPropertyStore store;
        SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, 2, ref iid, out store);
        PROPERTYKEY key;
        key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
        key.pid = 5;
        PROPVARIANT pv = new PROPVARIANT();
        pv.vt = 31;
        pv.pointerValue = Marshal.StringToCoTaskMemUni(value);
        store.SetValue(ref key, ref pv);
        store.Commit();
        Marshal.FreeCoTaskMem(pv.pointerValue);
    }
}
"@

$folderPath = Split-Path -Parent $ShortcutPath
if (-not (Test-Path $folderPath)) {
    New-Item -ItemType Directory -Path $folderPath -Force | Out-Null
}

$shellApp = New-Object -ComObject Shell.Application
$folder = $shellApp.Namespace($folderPath)
$wsh = New-Object -ComObject WScript.Shell
$changed = $false

# Remove dev leftovers that share our AUMID but launch electron.exe.
foreach ($file in Get-ChildItem $folderPath -Filter *.lnk -ErrorAction SilentlyContinue) {
    if ($file.FullName -ieq $ShortcutPath) { continue }
    $item = $folder.ParseName($file.Name)
    if ($null -eq $item) { continue }
    $id = ""
    try { $id = [string]$item.ExtendedProperty("System.AppUserModel.ID") } catch { }
    if ($id -ne $Aumid) { continue }
    $targetPath = ""
    try { $targetPath = $wsh.CreateShortcut($file.FullName).TargetPath } catch { }
    if ($targetPath -match '(?i)\\electron\.exe$') {
        Remove-Item $file.FullName -Force -ErrorAction SilentlyContinue
        Write-Output ("removed|" + $file.Name)
        $changed = $true
    }
}

$needsWrite = $true
if (Test-Path $ShortcutPath) {
    try {
        $current = $wsh.CreateShortcut($ShortcutPath)
        $currentItem = $folder.ParseName((Split-Path $ShortcutPath -Leaf))
        $currentId = ""
        if ($null -ne $currentItem) {
            $currentId = [string]$currentItem.ExtendedProperty("System.AppUserModel.ID")
        }
        if (($current.TargetPath -ieq $Target) -and
            ($current.Arguments -eq $Arguments) -and
            ($currentId -eq $Aumid)) {
            $needsWrite = $false
        }
    } catch {
        $needsWrite = $true
    }
}

if ($needsWrite) {
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        try {
            $shortcut = $wsh.CreateShortcut($ShortcutPath)
            $shortcut.TargetPath = $Target
            $shortcut.Arguments = $Arguments
            $shortcut.WorkingDirectory = $WorkDir
            if ($Icon) { $shortcut.IconLocation = $Icon }
            $shortcut.Description = "MONOSABA DesktopPET"
            $shortcut.Save()
            [ShortcutAumid]::Set($ShortcutPath, $Aumid)
            $changed = $true
            break
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }
}

if ($changed) { Write-Output "updated" } else { Write-Output "ok" }
`;

type Launcher = { target: string; args: string; workDir: string };

/**
 * 真正的启动入口。
 * 便携版优先用“当前正在运行的解压后 exe”：通知点击时 Windows 只需要再起一个
 * 同样的小实例（约 1 秒）转发回主实例；如果指向 100MB 的外层便携 exe，
 * 每次点击都要重新解压，实测要 20 秒以上。
 * 安装版用当前 exe；开发模式用 Electron 可执行文件重新打开当前项目。
 */
function resolveLauncher(): Launcher | null {
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    if (!existsSync(process.execPath)) return null;
    return {
      target: process.execPath,
      args: "",
      workDir: dirname(process.execPath),
    };
  }
  if (app.isPackaged) {
    if (!existsSync(process.execPath)) return null;
    return {
      target: process.execPath,
      args: "",
      workDir: dirname(process.execPath),
    };
  }
  const appPath = app.getAppPath();
  return { target: process.execPath, args: `"${appPath}"`, workDir: appPath };
}

export async function ensureNotificationShortcut(): Promise<void> {
  if (process.platform !== "win32") return;
  const launcher = resolveLauncher();
  if (!launcher) return;
  await runShortcutScript(launcher, true);
}

/**
 * 退出时把快捷方式指回外层便携 exe：进程结束后解压目录会失效，
 * 至少让开始菜单里的入口还能重新启动应用。
 */
export function restoreNotificationShortcut(): void {
  if (process.platform !== "win32") return;
  const outer = process.env.PORTABLE_EXECUTABLE_FILE;
  if (!outer || !existsSync(outer)) return;
  const launcher: Launcher = { target: outer, args: "", workDir: dirname(outer) };
  void runShortcutScript(launcher, false);
}

async function runShortcutScript(
  launcher: Launcher,
  wait: boolean,
): Promise<void> {
  try {
    const scriptPath = join(app.getPath("temp"), "monosaba-notify-shortcut.ps1");
    await writeFile(scriptPath, SCRIPT, "utf8");
    const folder = join(
      app.getPath("appData"),
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
    );
    const shortcutPath = join(folder, SHORTCUT_NAME);
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-ShortcutPath",
      shortcutPath,
      "-Target",
      launcher.target,
      "-Arguments",
      launcher.args,
      "-WorkDir",
      launcher.workDir,
      "-Icon",
      `${launcher.target},0`,
      "-Aumid",
      AUMID,
    ];
    if (!wait) {
      // 退出阶段不阻塞：让 PowerShell 独立跑完。
      const child = spawn("powershell.exe", args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      return;
    }
    await new Promise<void>((resolve) => {
      execFile(
        "powershell.exe",
        args,
        { encoding: "utf8", timeout: 20_000, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            console.warn("[notify] 修复通知快捷方式失败", error.message, stderr);
            resolve();
            return;
          }
          const result = String(stdout).trim();
          if (result.includes("updated") || result.includes("removed")) {
            console.info("[notify] 通知快捷方式已修复 ->", launcher.target, result);
          }
          resolve();
        },
      );
    });
  } catch {
    // 修复失败不影响应用启动；通知点击会退化成打开桌宠窗口。
  }
}

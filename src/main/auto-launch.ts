import { app } from "electron";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readConfig, updateAutoLaunch } from "./config";

type LaunchTarget = { path: string; args: string[] };

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const APP_RUN_NAME = "com.mengxj.monosaba.desktop-pet";

/**
 * 便携版每次运行都会解压到临时目录，进程自身的 execPath 会失效；
 * electron-builder 会给出原始 exe 路径，开机自启要登记这个路径。
 */
function resolveLaunchTarget(): LaunchTarget {
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portableExe && existsSync(portableExe)) {
    return { path: portableExe, args: [] };
  }
  if (app.isPackaged) {
    return { path: process.execPath, args: [] };
  }
  // 开发模式：开机时用 Electron 可执行文件重新打开当前项目。
  return { path: process.execPath, args: [app.getAppPath()] };
}

function readRunEntries(): { name: string; command: string }[] {
  if (process.platform !== "win32") return [];
  const reg = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\reg.exe`;
  try {
    const output = execFileSync(reg, ["query", RUN_KEY], {
      encoding: "utf8",
      windowsHide: true,
    });
    const entries: { name: string; command: string }[] = [];
    for (const line of output.split(/\r?\n/)) {
      const match = /^\s{2,}(.+?)\s{4,}REG_(?:EXPAND_)?SZ\s{4,}(.+)$/.exec(line);
      if (!match) continue;
      entries.push({ name: match[1].trim(), command: match[2].trim() });
    }
    return entries;
  } catch {
    return [];
  }
}

/** 旧版本登记过自启（路径可能已经因为换版本失效）。 */
function hasExistingRunEntry(): boolean {
  return readRunEntries().some(
    (entry) =>
      entry.name.toLowerCase() === APP_RUN_NAME ||
      /monosaba/i.test(entry.name) ||
      /MONOSABA-DesktopPET/i.test(entry.command),
  );
}

export function getAutoLaunchEnabled(): boolean {
  try {
    const target = resolveLaunchTarget();
    return app.getLoginItemSettings({ path: target.path, args: target.args }).openAtLogin;
  } catch (error) {
    console.warn("[auto-launch] read failed", error);
    return false;
  }
}

/**
 * 启动时调用：沿用用户上次的选择，并把自启路径修到当前 exe。
 * 便携版的 exe 名带版本号，升级后旧登记会指向已删除的文件。
 */
export async function ensureAutoLaunch(): Promise<void> {
  if (!app.isPackaged || process.platform !== "win32") return;
  try {
    const config = await readConfig();
    let intent = config.autoLaunch;
    if (!intent && hasExistingRunEntry()) {
      // 升级前开过自启：登记还在，但路径是旧版本，迁移成“开启”意图。
      intent = true;
      await updateAutoLaunch(true);
    }
    if (!intent) return;

    const target = resolveLaunchTarget();
    const settings = app.getLoginItemSettings({
      path: target.path,
      args: target.args,
    });
    if (!settings.openAtLogin) {
      app.setLoginItemSettings({
        openAtLogin: true,
        path: target.path,
        args: target.args,
      });
      console.info("[auto-launch] 已把自启路径修到", target.path);
    }
  } catch (error) {
    console.warn("[auto-launch] ensure failed", error);
  }
}

export async function setAutoLaunchEnabled(enabled: boolean): Promise<boolean> {
  try {
    const target = resolveLaunchTarget();
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: target.path,
      args: target.args,
    });
  } catch (error) {
    console.warn("[auto-launch] write failed", error);
  }
  try {
    await updateAutoLaunch(enabled);
  } catch (error) {
    console.warn("[auto-launch] persist failed", error);
  }
  return getAutoLaunchEnabled();
}

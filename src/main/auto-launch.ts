import { app } from "electron";
import { existsSync } from "node:fs";

type LaunchTarget = { path: string; args: string[] };

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

export function getAutoLaunchEnabled(): boolean {
  try {
    const target = resolveLaunchTarget();
    return app.getLoginItemSettings({ path: target.path, args: target.args }).openAtLogin;
  } catch (error) {
    console.warn("[auto-launch] read failed", error);
    return false;
  }
}

export function setAutoLaunchEnabled(enabled: boolean): boolean {
  const target = resolveLaunchTarget();
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: target.path,
    args: target.args,
  });
  return getAutoLaunchEnabled();
}

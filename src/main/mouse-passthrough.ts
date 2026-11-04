import { BrowserWindow, ipcMain } from "electron";

/**
 * 鼠标穿透由渲染进程决定：它用 clientX/clientY 判断是否落在人物、齿轮或
 * 设置面板上，再通过 IPC 告诉主进程。这样不受 Windows 缩放/多屏坐标换算影响。
 */
export function startMousePassthrough(win: BrowserWindow): () => void {
  let ignoring = true;
  let stopped = false;

  const setIgnore = (next: boolean) => {
    if (stopped || win.isDestroyed()) return;
    if (ignoring === next) return;
    ignoring = next;
    win.setIgnoreMouseEvents(next, next ? { forward: true } : undefined);
  };

  const onSetIgnore = (_event: Electron.IpcMainEvent, value: unknown) => {
    setIgnore(value !== false);
  };

  ipcMain.on("pet:set-ignore", onSetIgnore);
  setIgnore(true);

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    ipcMain.removeListener("pet:set-ignore", onSetIgnore);
  };

  win.on("closed", cleanup);
  return cleanup;
}

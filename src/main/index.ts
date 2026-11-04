import { app, BrowserWindow, ipcMain, Menu, screen, shell } from "electron";
import { join } from "node:path";
import { registerAppProtocol, registerAppScheme } from "./app-protocol";
import { getAutoLaunchEnabled, setAutoLaunchEnabled } from "./auto-launch";
import { ensureConfig } from "./config";
import { listDisplays, selectDisplay, syncWindowToDisplay } from "./display";
import { loadDiary, diaryAvailability } from "./diary/ssh";
import { initDiaryWindow } from "./diary-window";
import { startMousePassthrough } from "./mouse-passthrough";
import { createTray } from "./tray";
import { createMainWindow, getMainWindow } from "./window";

registerAppScheme();

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.setAppUserModelId("com.mengxj.monosaba.desktop-pet");

process.on("uncaughtException", (error) => {
  console.error("[main] uncaught exception", error);
});
process.on("unhandledRejection", (error) => {
  console.error("[main] unhandled rejection", error);
});

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    getMainWindow()?.showInactive();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    await ensureConfig();
    registerAppProtocol();
    initDiaryWindow();

    ipcMain.handle("diary:load", async (_event, book: unknown) => {
      try {
        const data = await loadDiary(typeof book === "string" ? book : null);
        return { ok: true, data };
      } catch (error) {
        const message = error instanceof Error ? error.message : "日记本打不开。";
        console.warn("[diary] load failed", message);
        return { ok: false, error: message };
      }
    });

    ipcMain.handle("diary:availability", async () => {
      try {
        return await diaryAvailability();
      } catch {
        return false;
      }
    });

    ipcMain.handle("app:get-auto-launch", () => getAutoLaunchEnabled());
    ipcMain.handle("app:set-auto-launch", (_event, enabled: unknown) => {
      try {
        return setAutoLaunchEnabled(Boolean(enabled));
      } catch (error) {
        console.warn("[auto-launch] write failed", error);
        return getAutoLaunchEnabled();
      }
    });

    ipcMain.on("app:quit", () => app.quit());
    ipcMain.on("app:open-config", () => {
      void ensureConfig().then(async (path) => {
        const error = await shell.openPath(path);
        if (error) shell.showItemInFolder(path);
      });
    });
    ipcMain.on("pet:focus", (event) => {
      BrowserWindow.fromWebContents(event.sender)?.focus();
    });

    ipcMain.handle("pet:list-displays", () => listDisplays());
    ipcMain.handle("pet:set-display", (_event, displayId: unknown) => {
      if (typeof displayId !== "string" || !displayId) return null;
      return selectDisplay(displayId);
    });

    const win = createMainWindow(join(__dirname, "../preload/index.js"));
    startMousePassthrough(win);
    createTray();

    // 拔掉 / 接入屏幕、分辨率或缩放变化时，把窗口重新贴回所在屏并通知渲染层刷新按钮。
    const handleDisplayChange = () => {
      const info = syncWindowToDisplay();
      const current = getMainWindow();
      if (info && current && !current.isDestroyed()) {
        current.webContents.send("pet:display-changed", info);
      }
    };
    screen.on("display-added", handleDisplayChange);
    screen.on("display-removed", handleDisplayChange);
    screen.on("display-metrics-changed", handleDisplayChange);
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("activate", () => {
    if (getMainWindow()) {
      getMainWindow()?.showInactive();
      return;
    }
    const win = createMainWindow(join(__dirname, "../preload/index.js"));
    startMousePassthrough(win);
  });
}
import { app, BrowserWindow, ipcMain, Menu, screen, shell } from "electron";
import { join } from "node:path";
import { registerAppProtocol, registerAppScheme } from "./app-protocol";
import { getAutoLaunchEnabled, setAutoLaunchEnabled } from "./auto-launch";
import { ensureConfig } from "./config";
import { listDisplays, selectDisplay, setForceTop, syncWindowToDisplay, disposeForceTop } from "./display";
import {
  loadDiary,
  diaryAvailability,
  loadMemory,
  updateMemory,
  deleteMemory,
} from "./diary/ssh";
import type { MemoryDeleteInput, MemoryUpdateInput } from "../shared/types";
import { initChatWindow } from "./chat-window";
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
    initChatWindow();

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

    ipcMain.handle("diary:load-memory", async () => {
      try {
        const data = await loadMemory();
        return { ok: true, data };
      } catch (error) {
        const message = error instanceof Error ? error.message : "记忆暂时打不开。";
        console.warn("[memory] load failed", message);
        return { ok: false, error: message };
      }
    });

    ipcMain.handle("diary:update-memory", async (_event, input: unknown) => {
      try {
        return await updateMemory(input as MemoryUpdateInput);
      } catch (error) {
        const message = error instanceof Error ? error.message : "写入失败。";
        console.warn("[memory] update failed", message);
        return { ok: false, error: message };
      }
    });

    ipcMain.handle("diary:delete-memory", async (_event, input: unknown) => {
      try {
        return await deleteMemory(input as MemoryDeleteInput);
      } catch (error) {
        const message = error instanceof Error ? error.message : "删除失败。";
        console.warn("[memory] delete failed", message);
        return { ok: false, error: message };
      }
    });

    // 日记窗口切换日记/记忆时的马赛克过渡：截取卡片当前画面，交给渲染层做像素溶解。
    ipcMain.handle("diary:capture", async (event, rect: unknown) => {
      const area = rect as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
      const x = Math.round(Number(area?.x));
      const y = Math.round(Number(area?.y));
      const width = Math.round(Number(area?.width));
      const height = Math.round(Number(area?.height));
      if (
        ![x, y, width, height].every(Number.isFinite) ||
        width <= 0 ||
        height <= 0 ||
        width > 4000 ||
        height > 4000
      ) {
        return { ok: false as const };
      }
      try {
        const image = await event.sender.capturePage({ x, y, width, height });
        if (image.isEmpty()) return { ok: false as const };
        return { ok: true as const, dataUrl: image.toDataURL() };
      } catch (error) {
        console.warn("[diary] capture failed", error);
        return { ok: false as const };
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
    ipcMain.handle("pet:set-force-top", (_event, enabled: unknown) => setForceTop(Boolean(enabled)));

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

  app.on("before-quit", disposeForceTop);

  app.on("activate", () => {
    if (getMainWindow()) {
      getMainWindow()?.showInactive();
      return;
    }
    const win = createMainWindow(join(__dirname, "../preload/index.js"));
    startMousePassthrough(win);
  });
}
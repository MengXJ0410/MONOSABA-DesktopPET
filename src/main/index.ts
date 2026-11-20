import { app, BrowserWindow, ipcMain, Menu, screen, shell } from "electron";
import { join } from "node:path";
import { registerAppProtocol, registerAppScheme } from "./app-protocol";
import { getAutoLaunchEnabled, ensureAutoLaunch, setAutoLaunchEnabled } from "./auto-launch";
import { ensureConfig, readConfig, updateBubble, updateCommentary } from "./config";
import {
  getCommentaryDiagnostics,
  noteCommentarySchedule,
  resetCommentaryWatch,
  runCommentary,
} from "./commentary";
import type {
  BubbleSettings,
  CommentarySettings,
  MemoryDeleteInput,
  MemoryUpdateInput,
  MessageFont,
} from "../shared/types";
import { listDisplays, selectDisplay, setForceTop, syncWindowToDisplay, disposeForceTop } from "./display";
import {
  loadDiary,
  diaryAvailability,
  loadMemory,
  updateMemory,
  deleteMemory,
} from "./diary/ssh";
import { chatService } from "./chat/service";
import { initChatWindow, openChatWindow } from "./chat-window";
import { initDiaryWindow } from "./diary-window";
import { logStartup } from "./logs";
import { refreshPhysicalScreens } from "./display-metrics";
import { disposePointerWindows, hidePointerWindows, initPointerWindows } from "./pointer-window";
import { setActivityDisplayId } from "./screen-target";
import {
  disposePointerAi,
  getPointerAiState,
  observePointerNow,
  setPointerAiEnabled,
  updatePointerAiSettings,
} from "./pointer-ai";
import { ensureNotificationShortcut, restoreNotificationShortcut } from "./notification-shortcut";
import { startMousePassthrough } from "./mouse-passthrough";
import { createTray } from "./tray";
import { createMainWindow, getMainWindow } from "./window";

registerAppScheme();

function broadcastToAll(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      // 窗口正在销毁时忽略。
    }
  }
}

/** Explorer 还没准备好时创建托盘会失败，隔一会儿重试，别让用户没有托盘图标。 */
function createTrayWithRetry(attempt = 0): void {
  try {
    createTray();
  } catch (error) {
    logStartup(`托盘创建失败 attempt=${attempt} ${String(error)}`);
    if (attempt < 2) {
      setTimeout(() => createTrayWithRetry(attempt + 1), 1500);
    }
  }
}

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
  app.on("second-instance", (_event, argv) => {
    // 点通知时 Windows 会按 AUMID 启动快捷方式，第二个实例在这里被转发回来：
    // 直接把聊天窗口调出来，用户才觉得“点通知跳到了聊天”。
    // 开机自启拉起的第二实例只露桌宠，不弹聊天窗口。
    const autoStart = argv.includes("--autostart");
    logStartup(`second-instance autoStart=${autoStart} argv=${argv.join(" ")}`);
    getMainWindow()?.showInactive();
    if (!autoStart) openChatWindow(null);
  });

  // 退出后临时解压目录会失效：把开始菜单入口指回外层便携 exe。
  app.on("before-quit", () => {
    restoreNotificationShortcut();
  });

  app.whenReady().then(async () => {
    logStartup(
      `app ready version=${app.getVersion()} packaged=${app.isPackaged} argv=${process.argv.join(" ")}`,
    );
    Menu.setApplicationMenu(null);
    await ensureConfig();
    registerAppProtocol();
    initDiaryWindow();
    initChatWindow();
    void ensureNotificationShortcut();
    void chatService.start().catch((error) => {
      console.error("[chat] service start failed", error);
    });

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
    ipcMain.handle("app:set-auto-launch", async (_event, enabled: unknown) => {
      try {
        return await setAutoLaunchEnabled(Boolean(enabled));
      } catch (error) {
        console.warn("[auto-launch] write failed", error);
        return getAutoLaunchEnabled();
      }
    });

    ipcMain.handle("commentary:get", async () => (await readConfig()).commentary);
    ipcMain.handle("commentary:set", async (_event, patch: unknown) => {
      const record =
        patch && typeof patch === "object"
          ? (patch as Record<string, unknown>)
          : {};
      const next: Partial<CommentarySettings> = {};
      if (typeof record.enabled === "boolean") next.enabled = record.enabled;
      if (
        typeof record.minSeconds === "number" &&
        Number.isFinite(record.minSeconds)
      ) {
        next.minSeconds = record.minSeconds;
      }
      if (
        typeof record.maxSeconds === "number" &&
        Number.isFinite(record.maxSeconds)
      ) {
        next.maxSeconds = record.maxSeconds;
      }
      const settings = await updateCommentary(next);
      resetCommentaryWatch();
      broadcastToAll("pet:commentary", settings);
      return settings;
    });
    ipcMain.handle("pet:run-commentary", async (_event, character: unknown) =>
      runCommentary(typeof character === "string" ? character : undefined),
    );

    ipcMain.handle("commentary:diagnostics", () => getCommentaryDiagnostics());
    ipcMain.handle("commentary:note-schedule", (_event, at: unknown) => {
      noteCommentarySchedule(typeof at === "number" ? at : 0);
    });

    // 希罗指针：渲染层负责持久化开关与间隔，主进程只管当前会话的运行状态。
    ipcMain.handle("pointer:ai:configure", (_event, patch: unknown) => {
      const record =
        patch && typeof patch === "object"
          ? (patch as Record<string, unknown>)
          : {};
      if (typeof record.enabled === "boolean") {
        setPointerAiEnabled(record.enabled);
        if (!record.enabled) hidePointerWindows();
      }
      // 随机点评和希罗指针共用的活动屏幕；选屏本身由主进程统一解析。
      if (typeof record.activityDisplayId === "string") {
        setActivityDisplayId(record.activityDisplayId);
      }
      // 指针可用（希罗 + 开关打开）时，桌面消息才会带上「你能操控指针」的提示。
      if (typeof record.capable === "boolean") {
        chatService.setPointerCapable(record.capable);
      }
      if (
        typeof record.intervalSec === "number" ||
        typeof record.dailyLimit === "number"
      ) {
        return updatePointerAiSettings({
          intervalSec:
            typeof record.intervalSec === "number" ? record.intervalSec : undefined,
          dailyLimit:
            typeof record.dailyLimit === "number" ? record.dailyLimit : undefined,
        });
      }
      return getPointerAiState();
    });
    ipcMain.handle("pointer:ai:get", () => getPointerAiState());
    ipcMain.handle("pointer:ai:observe", () => observePointerNow());

    ipcMain.handle("bubble:get", async () => (await readConfig()).bubble);
    ipcMain.handle("bubble:set", async (_event, patch: unknown) => {
      const record =
        patch && typeof patch === "object"
          ? (patch as Record<string, unknown>)
          : {};
      const { font, ...rest } = record;
      const next = await updateBubble({
        ...(rest as Partial<Omit<BubbleSettings, "font">>),
        font:
          font && typeof font === "object"
            ? (font as Partial<MessageFont>)
            : undefined,
      });
      broadcastToAll("pet:bubble", next);
      return next;
    });
    ipcMain.on("bubble:preview", (_event, payload: unknown) => {
      const record =
        payload && typeof payload === "object"
          ? (payload as Record<string, unknown>)
          : {};
      const text = typeof record.text === "string" ? record.text.slice(0, 200) : "";
      if (!text) return;
      const ttl =
        typeof record.ttlMs === "number" && Number.isFinite(record.ttlMs)
          ? Math.max(400, Math.min(5000, Math.round(record.ttlMs)))
          : 1500;
      // 只影响桌宠气泡的临时预览，不写聊天记录、不触发通知。
      broadcastToAll("pet:bubble-preview", { text, ttlMs: ttl });
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
    createTrayWithRetry();
    initPointerWindows();
    // 桌宠窗口关闭时先拆掉指针浮层，否则 window-all-closed 会被浮层托住。
    win.on("closed", () => disposePointerWindows());

    // 物理分辨率要跑一次 PowerShell；放在窗口之后后台读，读到变化再通知面板刷新。
    const syncPhysicalDisplays = async () => {
      if (await refreshPhysicalScreens()) {
        broadcastToAll("pet:displays-updated", {});
      }
    };
    void syncPhysicalDisplays();

    // 自启维护要跑一次 PowerShell（约 1.5 秒），放在窗口之后后台执行，
    // 不要挡住启动：0.3.7 就是因为登录后迟迟看不到桌宠才被当成「没自启」。
    void ensureAutoLaunch().catch((error) => {
      logStartup(`ensureAutoLaunch failed ${String(error)}`);
    });

    // 拔掉 / 接入屏幕、分辨率或缩放变化时，把窗口重新贴回所在屏并通知渲染层刷新按钮。
    const handleDisplayChange = () => {
      const info = syncWindowToDisplay();
      const current = getMainWindow();
      if (info && current && !current.isDestroyed()) {
        current.webContents.send("pet:display-changed", info);
      }
      void syncPhysicalDisplays();
    };
    screen.on("display-added", handleDisplayChange);
    screen.on("display-removed", handleDisplayChange);
    screen.on("display-metrics-changed", handleDisplayChange);
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", () => {
    disposePointerWindows();
    disposePointerAi();
    disposeForceTop();
    void chatService.stop();
  });

  app.on("activate", () => {
    if (getMainWindow()) {
      getMainWindow()?.showInactive();
      return;
    }
    const win = createMainWindow(join(__dirname, "../preload/index.js"));
    startMousePassthrough(win);
    initPointerWindows();
    win.on("closed", () => disposePointerWindows());
  });
}
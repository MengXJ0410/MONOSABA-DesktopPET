import { BrowserWindow, ipcMain, screen } from "electron";
import { join } from "node:path";
import type {
  ChatHistoryResult,
  ChatResult,
  ChatSendResult,
  ChatStatus,
} from "../shared/types";
import { appEntryUrl } from "./app-protocol";
import {
  loadHistory,
  pollMessages,
  resetChatHostCache,
  sendMessage,
} from "./chat/client";
import { captureDisplay, type CapturedScreen } from "./chat/capture";
import { readConfig } from "./config";

const WINDOW_PADDING = 8;
const CARD_WIDTH = 420;
const CARD_HEIGHT = 600;
const WINDOW_WIDTH = CARD_WIDTH + WINDOW_PADDING * 2;
const WINDOW_HEIGHT = CARD_HEIGHT + WINDOW_PADDING * 2;

let chatWindow: BrowserWindow | null = null;
let initialized = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollCursor = 0;
let pollInFlight = false;
let lastStatus: ChatStatus | null = null;

function loadChatPage(win: BrowserWindow): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  const url = devUrl
    ? `${devUrl}?view=chat`
    : `${appEntryUrl()}?view=chat`;
  void win.loadURL(url);
}

function placeWindow(
  win: BrowserWindow,
  anchor: { x: number; y: number } | null,
): void {
  if (!anchor) {
    win.center();
    return;
  }

  const display = screen.getDisplayNearestPoint({
    x: Math.round(anchor.x),
    y: Math.round(anchor.y),
  });
  const area = display.workArea;

  let x = Math.round(anchor.x - WINDOW_WIDTH - 24);
  if (x < area.x + 8) x = Math.round(anchor.x + 24);
  if (x + WINDOW_WIDTH > area.x + area.width - 8) {
    x = area.x + area.width - WINDOW_WIDTH - 8;
  }

  let y = Math.round(anchor.y - WINDOW_HEIGHT + 96);
  y = Math.max(area.y + 8, Math.min(area.y + area.height - WINDOW_HEIGHT - 8, y));

  win.setBounds({ x, y, width: WINDOW_WIDTH, height: WINDOW_HEIGHT });
}

function emitStatus(win: BrowserWindow, status: ChatStatus): void {
  if (win.isDestroyed()) return;
  if (
    lastStatus &&
    lastStatus.state === status.state &&
    lastStatus.detail === status.detail
  ) {
    return;
  }
  lastStatus = status;
  win.webContents.send("chat:status", status);
}

function statusFromResult(
  result: Extract<ChatResult<unknown>, { ok: false }>,
): ChatStatus {
  if (result.kind === "auth") {
    return { state: "auth", detail: result.error };
  }
  if (result.kind === "server" && result.error.includes("未安装")) {
    return { state: "bridge-missing", detail: result.error };
  }
  if (result.kind === "server") {
    return { state: "offline", detail: result.error };
  }
  return { state: "offline", detail: result.error };
}

function onlineStatus(qqConnected: boolean): ChatStatus {
  return qqConnected ? { state: "online" } : { state: "qq-offline" };
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  pollInFlight = false;
  lastStatus = null;
}

function startPolling(win: BrowserWindow, pollMs: number): void {
  if (pollTimer) clearInterval(pollTimer);
  lastStatus = null;

  const tick = async () => {
    if (pollInFlight || win.isDestroyed()) return;
    pollInFlight = true;
    try {
      const result = await pollMessages(pollCursor);
      if (win.isDestroyed()) return;
      if (!result.ok) {
        emitStatus(win, statusFromResult(result));
        return;
      }
      const data = result.data;
      pollCursor = Math.max(pollCursor, data.cursor);
      if (data.messages.length > 0) {
        win.webContents.send("chat:messages", data.messages);
      }
      emitStatus(win, onlineStatus(data.qqConnected));
    } finally {
      pollInFlight = false;
    }
  };

  pollTimer = setInterval(() => {
    void tick();
  }, pollMs);
}

function createChatWindow(anchor: { x: number; y: number } | null): BrowserWindow {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.show();
    chatWindow.focus();
    return chatWindow;
  }

  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: "希罗",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  chatWindow = win;
  pollCursor = 0;
  lastStatus = null;
  win.setMenu(null);
  win.setAlwaysOnTop(true);
  placeWindow(win, anchor);

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = process.env.ELECTRON_RENDERER_URL
      ? url.startsWith(process.env.ELECTRON_RENDERER_URL)
      : url.startsWith("app://bundle/");
    if (!allowed) event.preventDefault();
  });

  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });

  win.on("closed", () => {
    if (chatWindow === win) chatWindow = null;
    stopPolling();
  });

  loadChatPage(win);
  return win;
}

function isChatSender(sender: Electron.WebContents): boolean {
  return Boolean(chatWindow && !chatWindow.isDestroyed() && sender === chatWindow.webContents);
}

async function handleHistory(): Promise<ChatHistoryResult> {
  const result = await loadHistory(40);
  if (!chatWindow || chatWindow.isDestroyed()) return result;

  if (!result.ok) {
    stopPolling();
    emitStatus(chatWindow, statusFromResult(result));
    return result;
  }

  pollCursor = Math.max(0, result.data.cursor);
  emitStatus(chatWindow, onlineStatus(result.data.qqConnected));
  const config = await readConfig();
  startPolling(chatWindow, config.chat.pollMs);
  return result;
}

export function initChatWindow(): void {
  if (initialized) return;
  initialized = true;

  ipcMain.on("chat:open", (event, anchor: unknown) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    const bounds = sender?.getBounds();
    let point: { x: number; y: number } | null = null;
    if (
      bounds &&
      anchor &&
      typeof anchor === "object" &&
      typeof (anchor as { x?: unknown }).x === "number" &&
      typeof (anchor as { y?: unknown }).y === "number"
    ) {
      point = {
        x: bounds.x + (anchor as { x: number }).x,
        y: bounds.y + (anchor as { y: number }).y,
      };
    }
    resetChatHostCache();
    createChatWindow(point);
  });

  ipcMain.on("chat:close", (event) => {
    if (isChatSender(event.sender)) {
      chatWindow?.close();
    }
  });

  ipcMain.handle("chat:history", async (event) => {
    if (!isChatSender(event.sender)) {
      return {
        ok: false as const,
        kind: "unknown" as const,
        error: "聊天窗口未打开",
      };
    }
    return handleHistory();
  });

  ipcMain.handle("chat:send", async (event, payload: unknown): Promise<ChatSendResult> => {
    if (!isChatSender(event.sender)) {
      return {
        ok: false,
        kind: "unknown",
        error: "聊天窗口未打开",
      };
    }

    const record =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : {};
    const value = typeof record.text === "string" ? record.text.trim() : "";
    if (!value) {
      return { ok: false, kind: "unknown", error: "消息不能为空。" };
    }
    if (value.startsWith("/")) {
      return { ok: false, kind: "unknown", error: "桌面聊天暂不支持指令。" };
    }

    const capture = record.captureScreen === true;
    const displayId =
      typeof record.displayId === "string" ? record.displayId : undefined;
    let screen: CapturedScreen | null = null;
    if (capture) {
      try {
        screen = await captureDisplay(displayId);
      } catch (error) {
        console.warn("[chat] screen capture failed", error);
        screen = null;
      }
    }

    const result = await sendMessage(value, screen?.base64);
    if (!result.ok) return result;

    return {
      ok: true,
      data: {
        message: result.data.message,
        screenImage: screen?.dataUrl ?? null,
        captureFailed: capture && screen === null,
      },
    };
  });
}

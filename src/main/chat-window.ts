import { app, BrowserWindow, dialog, ipcMain, screen, shell } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ChatAvatarHistoryItem,
  ChatBackgroundPatch,
  ChatBackgroundUploadResult,
  ChatDiagnostics,
  ChatFontScale,
  ChatInitialResult,
  ChatLineHeight,
  ChatMediaKind,
  ChatMediaResult,
  ChatMessage,
  ChatProfileData,
  ChatResizeDirection,
  ChatSendResult,
  ChatStorageResult,
  ChatTheme,
  ChatUiMode,
  ChatUiState,
  Rect,
} from "../shared/types";
import { appEntryUrl } from "./app-protocol";
import { readConfig } from "./config";
import {
  chatService,
  type ChatService,
} from "./chat/service";

const WINDOW_PADDING = 8;
const COMPACT_CARD_WIDTH = 420;
const COMPACT_CARD_HEIGHT = 600;
const FULL_CARD_WIDTH = 1040;
const FULL_CARD_HEIGHT = 700;
const FULL_MIN_WIDTH = 880;
const FULL_MIN_HEIGHT = 560;

let chatWindow: BrowserWindow | null = null;
let chatWindowMode: ChatUiMode = "compact";
let initialized = false;
let boundsTimer: ReturnType<typeof setTimeout> | null = null;
let quitting = false;

type ResizeSession = {
  windowId: number;
  direction: ChatResizeDirection;
  startPoint: { x: number; y: number };
  startBounds: Rect;
};

/**
 * 窗口图标。打包后 `build/` 不在 app.asar 里，必须从 extraResources 读，
 * 否则路径无效，Windows 会退回默认图标。
 *
 * Windows 任务栏默认按 AppUserModelID 合并按钮，只设 BrowserWindow.icon
 * 通常只在标题栏 / Alt+Tab 生效；优先用 ICO，并在创建后单独设置 AUMID。
 */
function chatWindowIcon(): string {
  const dir = app.isPackaged
    ? process.resourcesPath
    : join(app.getAppPath(), "build");
  const ico = join(dir, "icon-chat.ico");
  if (existsSync(ico)) return ico;
  return join(dir, "icon-chat.png");
}

function relaunchCommand(): string {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portable && existsSync(portable)) return portable;
  return process.execPath;
}

let resizeSession: ResizeSession | null = null;
let resizeTimer: ReturnType<typeof setInterval> | null = null;

const RESIZE_DIRECTIONS = new Set<ChatResizeDirection>([
  "n",
  "s",
  "e",
  "w",
  "ne",
  "nw",
  "se",
  "sw",
]);

function isResizeDirection(value: unknown): value is ChatResizeDirection {
  return typeof value === "string" && RESIZE_DIRECTIONS.has(value as ChatResizeDirection);
}

function resizeBounds(
  start: Rect,
  direction: ChatResizeDirection,
  dx: number,
  dy: number,
): Rect {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;

  if (direction.includes("e")) right = start.x + start.width + dx;
  if (direction.includes("s")) bottom = start.y + start.height + dy;
  if (direction.includes("w")) left = start.x + dx;
  if (direction.includes("n")) top = start.y + dy;

  if (right - left < FULL_MIN_WIDTH) {
    if (direction.includes("w")) left = right - FULL_MIN_WIDTH;
    else right = left + FULL_MIN_WIDTH;
  }
  if (bottom - top < FULL_MIN_HEIGHT) {
    if (direction.includes("n")) top = bottom - FULL_MIN_HEIGHT;
    else bottom = top + FULL_MIN_HEIGHT;
  }

  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
  };
}

function service(): ChatService {
  return chatService;
}

function applyResizeFrame(): void {
  if (!resizeSession) return;
  if (
    !chatWindow ||
    chatWindow.isDestroyed() ||
    chatWindow.id !== resizeSession.windowId
  ) {
    stopResize();
    return;
  }

  const point = screen.getCursorScreenPoint();
  const next = resizeBounds(
    resizeSession.startBounds,
    resizeSession.direction,
    point.x - resizeSession.startPoint.x,
    point.y - resizeSession.startPoint.y,
  );
  const current = chatWindow.getBounds();
  if (
    current.x !== next.x ||
    current.y !== next.y ||
    current.width !== next.width ||
    current.height !== next.height
  ) {
    chatWindow.setBounds(next);
  }
}

function stopResize(): void {
  if (resizeTimer) {
    clearInterval(resizeTimer);
    resizeTimer = null;
  }
  const hadSession = resizeSession !== null;
  resizeSession = null;
  if (hadSession) persistBoundsSoon();
}

function loadChatPage(win: BrowserWindow): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  const url = devUrl
    ? `${devUrl}?view=chat`
    : `${appEntryUrl()}?view=chat`;
  void win.loadURL(url);
}

function windowSizeForMode(mode: ChatUiMode): { width: number; height: number } {
  if (mode === "full") {
    return { width: FULL_CARD_WIDTH, height: FULL_CARD_HEIGHT };
  }
  return {
    width: COMPACT_CARD_WIDTH + WINDOW_PADDING * 2,
    height: COMPACT_CARD_HEIGHT + WINDOW_PADDING * 2,
  };
}

function cardBoundsFromWindow(mode: ChatUiMode, bounds: Rect): Rect {
  const padding = mode === "compact" ? WINDOW_PADDING : 0;
  return {
    x: bounds.x + padding,
    y: bounds.y + padding,
    width: Math.max(100, bounds.width - padding * 2),
    height: Math.max(100, bounds.height - padding * 2),
  };
}

function windowBoundsFromCard(mode: ChatUiMode, card: Rect): Rect {
  const padding = mode === "compact" ? WINDOW_PADDING : 0;
  return {
    x: card.x - padding,
    y: card.y - padding,
    width: card.width + padding * 2,
    height: card.height + padding * 2,
  };
}

function clampToArea(bounds: Rect, area: Rect): Rect {
  const width = Math.min(Math.max(bounds.width, 300), area.width - 16);
  const height = Math.min(Math.max(bounds.height, 240), area.height - 16);
  const x = Math.min(
    Math.max(bounds.x, area.x + 8),
    area.x + area.width - width - 8,
  );
  const y = Math.min(
    Math.max(bounds.y, area.y + 8),
    area.y + area.height - height - 8,
  );
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function targetBounds(
  mode: ChatUiMode,
  anchor: { x: number; y: number } | null,
): Rect {
  const ui = service().getUiConfig();
  const size = windowSizeForMode(mode);
  const saved = mode === "full" ? ui.fullBounds : ui.compactBounds;

  if (saved) {
    const display = screen.getDisplayNearestPoint({ x: saved.x, y: saved.y });
    const card: Rect =
      mode === "full"
        ? {
            x: saved.x,
            y: saved.y,
            width: Math.max(FULL_MIN_WIDTH, saved.width),
            height: Math.max(FULL_MIN_HEIGHT, saved.height),
          }
        : {
            x: saved.x,
            y: saved.y,
            width: COMPACT_CARD_WIDTH,
            height: COMPACT_CARD_HEIGHT,
          };
    return clampToArea(windowBoundsFromCard(mode, card), display.workArea);
  }

  if (mode === "compact" && anchor) {
    const display = screen.getDisplayNearestPoint({
      x: Math.round(anchor.x),
      y: Math.round(anchor.y),
    });
    const area = display.workArea;
    let x = Math.round(anchor.x - size.width - 24);
    if (x < area.x + 8) x = Math.round(anchor.x + 24);
    if (x + size.width > area.x + area.width - 8) {
      x = area.x + area.width - size.width - 8;
    }
    let y = Math.round(anchor.y - size.height + 96);
    y = Math.max(area.y + 8, Math.min(area.y + area.height - size.height - 8, y));
    return { x, y, width: size.width, height: size.height };
  }

  const display = screen.getDisplayNearestPoint(
    anchor ?? screen.getCursorScreenPoint(),
  );
  const area = display.workArea;
  return clampToArea(
    {
      x: area.x + (area.width - size.width) / 2,
      y: area.y + (area.height - size.height) / 2,
      width: size.width,
      height: size.height,
    },
    area,
  );
}

function persistBoundsSoon(): void {
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    boundsTimer = null;
    if (!chatWindow || chatWindow.isDestroyed()) return;
    const card = cardBoundsFromWindow(chatWindowMode, chatWindow.getBounds());
    void service().updateBounds(chatWindowMode, card);
  }, 450);
}

function saveWindowBounds(win: BrowserWindow, mode: ChatUiMode): void {
  if (win.isDestroyed()) return;
  const card = cardBoundsFromWindow(mode, win.getBounds());
  void service().updateBounds(mode, card);
}

function notifyWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const active = win.isVisible() && win.isFocused();
  service().setWindowActive(active);
}

function createChatWindow(mode: ChatUiMode, bounds: Rect): BrowserWindow {
  const full = mode === "full";
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: true,
    roundedCorners: !full,
    thickFrame: !full,
    resizable: false,
    minimizable: full,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: !full,
    alwaysOnTop: !full || service().getUiState().pinned,
    title: "希罗",
    icon: chatWindowIcon(),
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
  chatWindowMode = mode;
  const icon = chatWindowIcon();
  try {
    win.setIcon(icon);
    if (process.platform === "win32") {
      // 单独的任务栏身份，避免被合并进进程默认图标（Windows 11 默认合并按钮）。
      win.setAppDetails({
        appId: "com.mengxj.monosaba.chat",
        appIconPath: icon,
        appIconIndex: 0,
        relaunchCommand: relaunchCommand(),
        relaunchDisplayName: "希罗",
      });
    }
  } catch (error) {
    console.warn("[chat] set taskbar icon failed", error);
  }
  if (resizeTimer) {
    clearInterval(resizeTimer);
    resizeTimer = null;
  }
  resizeSession = null;
  win.setMenu(null);
  win.setMinimumSize(
    full ? FULL_MIN_WIDTH : windowSizeForMode("compact").width,
    full ? FULL_MIN_HEIGHT : windowSizeForMode("compact").height,
  );
  win.setVisibleOnAllWorkspaces(false);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = process.env.ELECTRON_RENDERER_URL
      ? url.startsWith(process.env.ELECTRON_RENDERER_URL)
      : url.startsWith("app://bundle/");
    if (!allowed) event.preventDefault();
  });

  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    win.show();
    // Electron 45 在 Windows 上只有 screen-saver 层级能真正置顶。
    win.setAlwaysOnTop(!full || service().getUiState().pinned, "screen-saver");
    win.focus();
    notifyWindowState(win);
  });

  win.on("move", persistBoundsSoon);
  win.on("resize", persistBoundsSoon);
  win.on("focus", () => service().setWindowActive(true));
  win.on("blur", () => service().setWindowActive(false));
  win.on("show", () => notifyWindowState(win));
  win.on("hide", () => service().setWindowActive(false));

  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    hideChatWindow();
  });

  win.on("closed", () => {
    if (chatWindow === win) chatWindow = null;
    stopResize();
    service().setWindowActive(false);
  });

  loadChatPage(win);
  return win;
}

function showChatWindow(anchor: { x: number; y: number } | null): BrowserWindow {
  if (chatWindow && !chatWindow.isDestroyed()) {
    if (chatWindow.isMinimized()) chatWindow.restore();
    chatWindow.show();
    chatWindow.focus();
    notifyWindowState(chatWindow);
    return chatWindow;
  }

  const mode = service().getUiState().mode;
  const bounds = targetBounds(mode, anchor);
  return createChatWindow(mode, bounds);
}

function rebuildChatWindow(previous: ChatUiMode, next: ChatUiMode): void {
  const old = chatWindow;
  if (!old || old.isDestroyed()) {
    showChatWindow(null);
    return;
  }

  stopResize();
  const oldCard = cardBoundsFromWindow(previous, old.getBounds());
  void service().updateBounds(previous, oldCard);

  const display = screen.getDisplayNearestPoint({
    x: oldCard.x + oldCard.width - 1,
    y: oldCard.y,
  });
  const saved = next === "full" ? service().getUiConfig().fullBounds : null;
  const size =
    next === "full" && saved
      ? {
          width: Math.max(FULL_MIN_WIDTH, saved.width),
          height: Math.max(FULL_MIN_HEIGHT, saved.height),
        }
      : windowSizeForMode(next);

  // 右上角锚定：新窗口的右边贴着旧窗口的右边，再限制在屏幕内。
  const bounds = clampToArea(
    {
      x: oldCard.x + oldCard.width - size.width,
      y: oldCard.y,
      width: size.width,
      height: size.height,
    },
    display.workArea,
  );

  if (boundsTimer) {
    clearTimeout(boundsTimer);
    boundsTimer = null;
  }
  chatWindow = null;
  old.destroy();
  createChatWindow(next, bounds);
}

export function hideChatWindow(): void {
  stopResize();
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.hide();
  }
  service().setWindowActive(false);
}

export function openChatWindow(anchor: { x: number; y: number } | null = null): void {
  showChatWindow(anchor);
}

export function toggleChatWindow(): void {
  if (chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible()) {
    hideChatWindow();
  } else {
    showChatWindow(null);
  }
}

export function getChatWindow(): BrowserWindow | null {
  return chatWindow;
}

export function isChatWindowVisible(): boolean {
  return Boolean(chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible());
}

function isChatSender(sender: Electron.WebContents): boolean {
  return Boolean(
    chatWindow && !chatWindow.isDestroyed() && sender === chatWindow.webContents,
  );
}

export function initChatWindow(): void {
  if (initialized) return;
  initialized = true;

  service().setOpenChatListener(() => showChatWindow(null));

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
    showChatWindow(point);
  });

  ipcMain.on("chat:close", (event) => {
    if (isChatSender(event.sender)) hideChatWindow();
  });

  ipcMain.on("chat:minimize", (event) => {
    if (isChatSender(event.sender)) chatWindow?.minimize();
  });

  ipcMain.on("chat:resize-start", (event, direction: unknown) => {
    if (!isChatSender(event.sender) || chatWindowMode !== "full") return;
    if (!isResizeDirection(direction) || !chatWindow || chatWindow.isDestroyed()) return;
    if (resizeTimer) {
      clearInterval(resizeTimer);
      resizeTimer = null;
    }
    resizeSession = {
      windowId: chatWindow.id,
      direction,
      startPoint: screen.getCursorScreenPoint(),
      startBounds: chatWindow.getBounds(),
    };
    // 透明窗口里光标移出窗口后渲染层收不到 mousemove，改由主进程采样光标。
    resizeTimer = setInterval(applyResizeFrame, 16);
  });

  ipcMain.on("chat:resize-move", (event) => {
    if (!isChatSender(event.sender)) return;
    applyResizeFrame();
  });

  ipcMain.on("chat:resize-end", (event) => {
    if (!isChatSender(event.sender)) return;
    stopResize();
  });

  ipcMain.handle("chat:initial", (event): ChatInitialResult => {
    if (!isChatSender(event.sender)) {
      return { ok: false, kind: "unknown", error: "聊天窗口未打开" };
    }
    return { ok: true, data: service().getInitial() };
  });

  ipcMain.handle("chat:load-more", (event, beforeId: unknown, limit: unknown) => {
    if (!isChatSender(event.sender)) return [] as ChatMessage[];
    const id = typeof beforeId === "number" && Number.isFinite(beforeId) ? beforeId : 0;
    const size = typeof limit === "number" && Number.isFinite(limit) ? limit : 200;
    return service().loadMore(id, size);
  });

  ipcMain.handle("chat:send", async (event, payload: unknown): Promise<ChatSendResult> => {
    if (!isChatSender(event.sender)) {
      return { ok: false, kind: "unknown", error: "聊天窗口未打开" };
    }
    const record =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : {};
    const value = typeof record.text === "string" ? record.text.trim() : "";
    if (!value) {
      return { ok: false, kind: "unknown", error: "消息不能为空。" };
    }
    const capture = record.captureScreen === true;
    const displayId =
      typeof record.displayId === "string" ? record.displayId : undefined;
    return service().send(value, { captureScreen: capture, displayId });
  });

  ipcMain.handle("chat:media", async (event, media: unknown, kind: unknown) => {
    if (!isChatSender(event.sender)) {
      return { ok: false, error: "聊天窗口未打开" } satisfies ChatMediaResult;
    }
    if (typeof media !== "string" || !media) {
      return { ok: false, error: "图片 id 不正确。" } satisfies ChatMediaResult;
    }
    const normalizedKind: ChatMediaKind = kind === "original" ? "original" : "thumb";
    return service().getMedia(media, normalizedKind);
  });

  ipcMain.handle("chat:commands", async (event, force: unknown) => {
    if (!isChatSender(event.sender)) return null;
    return service().getCommands(force === true);
  });

  ipcMain.handle("chat:status-data", async (event, force: unknown) => {
    if (!isChatSender(event.sender)) return null;
    return service().getMoodStatus(force === true);
  });

  ipcMain.handle("chat:set-mode", async (event, mode: unknown) => {
    if (!isChatSender(event.sender)) return null;
    const next: ChatUiMode = mode === "full" ? "full" : "compact";
    const previous = service().getUiState().mode;
    if (next === previous) return service().getUiState();
    const state = await service().setMode(next);
    // 先让 IPC 回复走完，再重建窗口，避免渲染进程收到切换失败。
    setTimeout(() => rebuildChatWindow(previous, next), 60);
    return state;
  });

  ipcMain.handle("chat:set-pinned", async (event, pinned: unknown) => {
    if (!isChatSender(event.sender)) return null;
    const state = await service().setPinned(pinned === true);
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.setAlwaysOnTop(
        state.mode === "compact" || state.pinned,
        "screen-saver",
      );
    }
    return state;
  });

  ipcMain.handle("chat:set-notifications", async (event, enabled: unknown) => {
    if (!isChatSender(event.sender)) return null;
    return service().setNotifications(enabled === true);
  });

  ipcMain.handle("chat:mark-read", (event) => {
    if (!isChatSender(event.sender)) return;
    service().markRead();
  });

  ipcMain.handle("chat:retry", async (event) => {
    if (!isChatSender(event.sender)) return null;
    await service().bootstrap();
    return service().getInitial();
  });

  ipcMain.handle("chat:open-settings", (event) => {
    if (!isChatSender(event.sender)) return;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win === chatWindow || win.isDestroyed()) continue;
      win.webContents.send("pet:open-settings");
      win.showInactive();
    }
  });

  ipcMain.handle("chat:ui-state", (event) => {
    if (!isChatSender(event.sender)) return null;
    return service().getUiState();
  });

  ipcMain.handle("chat:hide", (event) => {
    if (!isChatSender(event.sender)) return;
    hideChatWindow();
  });

  ipcMain.handle("chat:state", (event) => {
    if (!isChatSender(event.sender)) return null;
    return {
      ui: service().getUiState(),
      status: service().getInitial().status,
    };
  });

  ipcMain.handle("chat:profile", (event): ChatProfileData | null => {
    if (!isChatSender(event.sender)) return null;
    return service().getProfile();
  });

  ipcMain.handle("chat:profile-name", async (event, role: unknown, name: unknown) => {
    if (!isChatSender(event.sender)) return null;
    if (role !== "hiro" && role !== "me") return null;
    try {
      return await service().setProfileName(role, typeof name === "string" ? name : "");
    } catch (error) {
      return { error: error instanceof Error ? error.message : "改名失败。" };
    }
  });

  ipcMain.handle("chat:profile-avatar", async (event, role: unknown, dataUrl: unknown) => {
    if (!isChatSender(event.sender)) return null;
    if (role !== "hiro" && role !== "me") return null;
    try {
      return await service().saveProfileAvatar(
        role,
        typeof dataUrl === "string" ? dataUrl : "",
      );
    } catch (error) {
      return { error: error instanceof Error ? error.message : "保存头像失败。" };
    }
  });

  ipcMain.handle("chat:profile-avatar-select", async (event, role: unknown, id: unknown) => {
    if (!isChatSender(event.sender)) return null;
    if (role !== "hiro" && role !== "me") return null;
    try {
      return await service().selectProfileAvatar(
        role,
        typeof id === "string" && id ? id : null,
      );
    } catch (error) {
      return { error: error instanceof Error ? error.message : "切换头像失败。" };
    }
  });

  ipcMain.handle("chat:profile-avatar-reset", async (event, role: unknown) => {
    if (!isChatSender(event.sender)) return null;
    if (role !== "hiro" && role !== "me") return null;
    try {
      return await service().resetProfileAvatar(role);
    } catch (error) {
      return { error: error instanceof Error ? error.message : "恢复默认头像失败。" };
    }
  });

  ipcMain.handle("chat:profile-history", async (event, role: unknown) => {
    if (!isChatSender(event.sender)) return [] as ChatAvatarHistoryItem[];
    if (role !== "hiro" && role !== "me") return [] as ChatAvatarHistoryItem[];
    return service().getProfileHistory(role);
  });

  ipcMain.handle("chat:set-theme", async (event, theme: unknown) => {
    if (!isChatSender(event.sender) || !theme || typeof theme !== "object") return null;
    const record = theme as Record<string, unknown>;
    const mode = record.mode === "day" ? "day" : "night";
    const accent = typeof record.accent === "string" ? record.accent : "#c8102e";
    const presetId =
      typeof record.presetId === "string" && record.presetId ? record.presetId : null;
    return service().setTheme({ mode, accent, presetId });
  });

  ipcMain.handle("chat:set-font-scale", async (event, value: unknown) => {
    if (!isChatSender(event.sender)) return null;
    const scale: ChatFontScale =
      value === "sm" || value === "lg" ? value : "md";
    return service().setFontScale(scale);
  });

  ipcMain.handle("chat:set-line-height", async (event, value: unknown) => {
    if (!isChatSender(event.sender)) return null;
    const height: ChatLineHeight =
      value === "compact" || value === "loose" ? value : "normal";
    return service().setLineHeight(height);
  });

  ipcMain.handle("chat:set-background", async (event, patch: unknown) => {
    if (!isChatSender(event.sender)) return null;
    const record =
      patch && typeof patch === "object"
        ? (patch as Record<string, unknown>)
        : {};
    const next: ChatBackgroundPatch = {};
    if (record.chatOpacity === null) next.chatOpacity = null;
    else if (typeof record.chatOpacity === "number" && Number.isFinite(record.chatOpacity)) {
      next.chatOpacity = Math.max(0, Math.min(100, Math.round(record.chatOpacity)));
    }
    if (typeof record.panelOpacity === "number" && Number.isFinite(record.panelOpacity)) {
      next.panelOpacity = Math.max(0, Math.min(100, Math.round(record.panelOpacity)));
    }
    if (typeof record.extend === "boolean") next.extend = record.extend;
    return service().setBackground(next);
  });

  ipcMain.handle("chat:background-get", async (event) => {
    if (!isChatSender(event.sender)) return null;
    return service().getInitial().backgroundImage;
  });

  ipcMain.handle(
    "chat:background-upload",
    async (event, dataUrl: unknown): Promise<ChatBackgroundUploadResult> => {
      if (!isChatSender(event.sender)) {
        return { ok: false, error: "聊天窗口未打开" };
      }
      if (typeof dataUrl !== "string" || !dataUrl) {
        return { ok: false, error: "背景图数据不正确。" };
      }
      try {
        const saved = await service().saveBackground(dataUrl);
        return { ok: true, dataUrl: saved };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "保存背景图失败。",
        };
      }
    },
  );

  ipcMain.handle("chat:background-reset", async (event) => {
    if (!isChatSender(event.sender)) return false;
    await service().clearBackground();
    return true;
  });

  ipcMain.handle(
    "chat:preset-save",
    async (event, name: unknown, theme: unknown): Promise<ChatUiState | { error: string }> => {
      if (!isChatSender(event.sender)) return { error: "聊天窗口未打开" };
      if (!theme || typeof theme !== "object") return { error: "主题数据不正确。" };
      const record = theme as Record<string, unknown>;
      try {
        return await service().saveThemePreset(
          typeof name === "string" ? name : "",
          {
            mode: record.mode === "day" ? "day" : "night",
            accent: typeof record.accent === "string" ? record.accent : "#c8102e",
            presetId: null,
          } satisfies ChatTheme,
        );
      } catch (error) {
        return { error: error instanceof Error ? error.message : "保存预设失败。" };
      }
    },
  );

  ipcMain.handle("chat:preset-delete", async (event, id: unknown) => {
    if (!isChatSender(event.sender)) return null;
    if (typeof id !== "string" || !id) return null;
    try {
      return await service().deleteThemePreset(id);
    } catch (error) {
      return { error: error instanceof Error ? error.message : "删除预设失败。" };
    }
  });

  ipcMain.handle("chat:storage-info", async (event) => {
    if (!isChatSender(event.sender)) return null;
    return service().getStorageInfo();
  });

  ipcMain.handle("chat:storage-choose", async (event): Promise<ChatStorageResult | null> => {
    if (!isChatSender(event.sender)) return null;
    const options: Electron.OpenDialogOptions = {
      title: "选择聊天记录的存放目录",
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "用这个目录",
    };
    const result =
      chatWindow && !chatWindow.isDestroyed()
        ? await dialog.showOpenDialog(chatWindow, options)
        : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, error: "" };
    }
    return service().chooseStorageDir(result.filePaths[0]);
  });

  ipcMain.handle("chat:storage-default", async (event) => {
    if (!isChatSender(event.sender)) return null;
    return service().useDefaultStorageDir();
  });

  ipcMain.handle("chat:storage-clear", async (event) => {
    if (!isChatSender(event.sender)) return null;
    return service().clearCache();
  });

  ipcMain.handle("chat:open-folder", async (event, kind: unknown) => {
    if (!isChatSender(event.sender)) return;
    if (kind === "config") {
      await shell.openPath(app.getPath("userData"));
      return;
    }
    const info = await service().getStorageInfo();
    await shell.openPath(kind === "profile" ? info.profileDir : info.dir);
  });

  ipcMain.handle("chat:diagnostics", async (event): Promise<ChatDiagnostics | null> => {
    if (!isChatSender(event.sender)) return null;
    const config = await readConfig();
    const initial = service().getInitial();
    return {
      appVersion: app.getVersion(),
      electron: process.versions.electron ?? "",
      chrome: process.versions.chrome ?? "",
      platform: `${process.platform} ${process.arch}`,
      status: initial.status,
      epoch: initial.epoch,
      cursor: initial.cursor,
      hosts: config.chat.hosts,
      port: config.chat.port,
    };
  });
}

app.on("before-quit", () => {
  quitting = true;
  if (resizeTimer) {
    clearInterval(resizeTimer);
    resizeTimer = null;
  }
  resizeSession = null;
  if (boundsTimer) {
    clearTimeout(boundsTimer);
    boundsTimer = null;
  }
  if (chatWindow && !chatWindow.isDestroyed()) {
    saveWindowBounds(chatWindow, chatWindowMode);
  }
});

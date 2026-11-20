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
  ChatTypewriterSettings,
  MessageFont,
  ChatProfileData,
  ChatQuote,
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
import { resetCommentaryWatch } from "./commentary";
import {
  exportChatSettings,
  importChatSettings,
} from "./chat/settings-io";
import {
  chatService,
  type ChatService,
} from "./chat/service";
import {
  COMPACT_CARD_HEIGHT,
  COMPACT_CARD_WIDTH,
  FULL_CARD_HEIGHT,
  FULL_CARD_WIDTH,
  FULL_MIN_HEIGHT,
  FULL_MIN_WIDTH,
  WINDOW_PADDING,
} from "./chat/layout";
import { isPointerWindow } from "./pointer-window";
import { logChatWindow } from "./logs";

function broadcastToWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      // 窗口正在销毁时忽略。
    }
  }
}

let chatWindow: BrowserWindow | null = null;
let chatWindowMode: ChatUiMode = "compact";
/** 正在后台加载、还没换上台的新窗口；它们也要能收到 chat:* IPC。 */
const pendingChatWindows = new Set<BrowserWindow>();
let creating: Promise<BrowserWindow | null> | null = null;
/** 完整版 / 小窗切换互斥，避免连点同时建两个窗口。 */
let switching = false;
let initialized = false;
let boundsTimer: ReturnType<typeof setTimeout> | null = null;
let quitting = false;

function isLiveWindow(win: BrowserWindow | null): win is BrowserWindow {
  return Boolean(win && !win.isDestroyed());
}

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
  const current = chatWindow.getContentBounds();
  if (
    current.x !== next.x ||
    current.y !== next.y ||
    current.width !== next.width ||
    current.height !== next.height
  ) {
    chatWindow.setContentBounds(next);
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

/** 窗口内容区尺寸：小窗是卡片 + 四周透明留白，完整版就是卡片本身。 */
function contentSizeForMode(mode: ChatUiMode): { width: number; height: number } {
  if (mode === "full") {
    return { width: FULL_CARD_WIDTH, height: FULL_CARD_HEIGHT };
  }
  return {
    width: COMPACT_CARD_WIDTH + WINDOW_PADDING * 2,
    height: COMPACT_CARD_HEIGHT + WINDOW_PADDING * 2,
  };
}

/** 配置里存的是用户看到的卡片位置；窗口内容区比卡片多一圈透明留白。 */
function cardBoundsFromContent(mode: ChatUiMode, bounds: Rect): Rect {
  const padding = mode === "compact" ? WINDOW_PADDING : 0;
  return {
    x: bounds.x + padding,
    y: bounds.y + padding,
    width: Math.max(100, bounds.width - padding * 2),
    height: Math.max(100, bounds.height - padding * 2),
  };
}

function contentBoundsFromCard(mode: ChatUiMode, card: Rect): Rect {
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
  const size = contentSizeForMode(mode);
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
    return contentBoundsFromCard(mode, clampToArea(card, display.workArea));
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

/**
 * 取可以写回配置的卡片尺寸。
 * 窗口最小化 / 正在切换时 `getContentBounds()` 会返回 0×0 或屏幕外的占位值，
 * 直接存进去会把用户的位置和大小抹掉（配置归一化会判成无效 → null）。
 */
function saveableCardBounds(win: BrowserWindow, mode: ChatUiMode): Rect | null {
  if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return null;
  const content = win.getContentBounds();
  if (content.width < 200 || content.height < 200) return null;
  const card = cardBoundsFromContent(mode, content);
  const minWidth = mode === "full" ? FULL_MIN_WIDTH : COMPACT_CARD_WIDTH;
  const minHeight = mode === "full" ? FULL_MIN_HEIGHT : COMPACT_CARD_HEIGHT;
  if (card.width < minWidth - 1 || card.height < minHeight - 1) return null;
  return card;
}

function persistBoundsSoon(): void {
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    boundsTimer = null;
    if (!isLiveWindow(chatWindow)) return;
    const card = saveableCardBounds(chatWindow, chatWindowMode);
    if (!card) return;
    void service().updateBounds(chatWindowMode, card);
  }, 450);
}

function saveWindowBounds(win: BrowserWindow, mode: ChatUiMode): void {
  const card = saveableCardBounds(win, mode);
  if (!card) return;
  void service().updateBounds(mode, card);
}

function notifyWindowState(win: BrowserWindow): void {
  if (!isLiveWindow(win) || win !== chatWindow) return;
  const active = win.isVisible() && win.isFocused();
  service().setWindowActive(active);
}

/** 页面真正画出聊天卡片的判定：DOM 里有聊天 section，且正文不是空的。 */
const HEALTH_SCRIPT = `(() => {
  const section =
    document.querySelector('section[aria-label="与希罗的聊天"]') ||
    document.querySelector("section[data-layout]");
  if (!section) return false;
  const text = ((document.body && document.body.innerText) || "").trim();
  return text.length > 0;
})()`;

function buildChatWindow(mode: ChatUiMode, bounds: Rect): BrowserWindow {
  const full = mode === "full";
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    // 宽度 / 高度按内容区解释，保存和恢复都用 getContentBounds，避免边框来回累积。
    useContentSize: true,
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
  win.setMenu(null);
  win.setMinimumSize(
    full ? FULL_MIN_WIDTH : contentSizeForMode("compact").width,
    full ? FULL_MIN_HEIGHT : contentSizeForMode("compact").height,
  );
  win.setVisibleOnAllWorkspaces(false);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = process.env.ELECTRON_RENDERER_URL
      ? url.startsWith(process.env.ELECTRON_RENDERER_URL)
      : url.startsWith("app://bundle/");
    if (!allowed) event.preventDefault();
  });

  // Windows 下 useContentSize 偶尔会有 1px 偏差，创建后再按内容区校正一次。
  try {
    win.setContentBounds(bounds);
  } catch {
    // 窗口还没 ready 时个别平台会抛错，忽略即可。
  }

  win.on("move", persistBoundsSoon);
  win.on("resize", persistBoundsSoon);
  win.on("focus", () => {
    if (win === chatWindow) service().setWindowActive(true);
  });
  win.on("blur", () => {
    if (win === chatWindow) service().setWindowActive(false);
  });
  win.on("show", () => notifyWindowState(win));
  win.on("hide", () => {
    if (win === chatWindow) service().setWindowActive(false);
  });

  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (win === chatWindow) hideChatWindow();
  });

  win.on("closed", () => {
    pendingChatWindows.delete(win);
    if (chatWindow === win) {
      chatWindow = null;
      stopResize();
      service().setWindowActive(false);
    }
  });

  return win;
}

/**
 * 等页面真正加载完成并画出内容。
 * ready-to-show 只代表窗口“可以显示”，不代表 loadURL 成功；0.3.7 的全透明故障
 * 就是 ready-to-show 已触发、页面还是空白时把窗口 show 了出来。
 */
function waitForChatReady(win: BrowserWindow, timeoutMs = 10_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (pollTimer) clearInterval(pollTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      pollTimer = null;
      deadlineTimer = null;
      win.webContents.off("did-fail-load", onFail);
      win.webContents.off("render-process-gone", onGone);
    };
    const finish = (ok: boolean, reason?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!ok && reason) logChatWindow(reason);
      resolve(ok);
    };
    const onFail = (
      _event: Electron.Event,
      code: number,
      description: string,
      _url: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame) return;
      finish(false, `did-fail-load ${code} ${description}`);
    };
    const onGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
      finish(false, `render-process-gone ${details.reason}`);
    };

    const probe = async () => {
      if (settled || win.isDestroyed()) return;
      let url = "";
      try {
        url = win.webContents.getURL();
      } catch {
        return;
      }
      // 刚建出来的 about:blank 也会触发加载事件，等到真正的聊天页再检查。
      if (!url.includes("view=chat")) return;
      let ok = false;
      try {
        ok = (await win.webContents.executeJavaScript(HEALTH_SCRIPT, true)) === true;
      } catch {
        ok = false;
      }
      if (!ok || settled || win.isDestroyed()) return;
      // 再等两帧，避免 React 刚提交、样式还没生效就切上台。
      await new Promise((next) => setTimeout(next, 120));
      if (settled || win.isDestroyed()) return;
      let again = false;
      try {
        again = (await win.webContents.executeJavaScript(HEALTH_SCRIPT, true)) === true;
      } catch {
        again = false;
      }
      if (again) finish(true);
    };

    win.webContents.on("did-fail-load", onFail);
    win.webContents.on("render-process-gone", onGone);
    pollTimer = setInterval(() => {
      void probe();
    }, 250);
    deadlineTimer = setTimeout(() => finish(false, "聊天页面 10 秒内没有准备好"), timeoutMs);
    void probe();
  });
}

/** 建一个隐藏窗口并等它真正画出聊天内容；失败时自己清理，不留幽灵窗口。 */
async function createPreparedWindow(
  mode: ChatUiMode,
  bounds: Rect,
): Promise<BrowserWindow | null> {
  const win = buildChatWindow(mode, bounds);
  pendingChatWindows.add(win);
  const ready = waitForChatReady(win);
  loadChatPage(win);
  const ok = await ready;
  if (quitting || !ok || win.isDestroyed()) {
    pendingChatWindows.delete(win);
    if (!win.isDestroyed()) win.destroy();
    return null;
  }
  return win;
}

function revealChatWindow(win: BrowserWindow): void {
  if (!isLiveWindow(win)) return;
  win.show();
  // Electron 45 在 Windows 上只有 screen-saver 层级能真正置顶。
  win.setAlwaysOnTop(chatWindowMode === "compact" || service().getUiState().pinned, "screen-saver");
  win.focus();
  notifyWindowState(win);
}

/** 首次创建：失败等 2 秒重试一次，避免一次渲染进程分配失败就永远打不开。 */
function ensureChatWindow(
  anchor: { x: number; y: number } | null,
): Promise<BrowserWindow | null> {
  if (isLiveWindow(chatWindow)) return Promise.resolve(chatWindow);
  if (creating) return creating;

  const mode = service().getUiState().mode;
  creating = (async () => {
    const bounds = targetBounds(mode, anchor);
    let win = await createPreparedWindow(mode, bounds);
    if (!win && !quitting) {
      logChatWindow(`首次创建失败，2 秒后重试 mode=${mode}`);
      await new Promise((next) => setTimeout(next, 2000));
      win = await createPreparedWindow(mode, bounds);
    }
    if (!win) {
      logChatWindow(`聊天窗口创建失败 mode=${mode}`);
      return null;
    }
    if (isLiveWindow(chatWindow) && chatWindow !== win) {
      // 另一条路径已经创建好了窗口，丢掉这个重复的。
      pendingChatWindows.delete(win);
      if (!win.isDestroyed()) win.destroy();
      return chatWindow;
    }
    pendingChatWindows.delete(win);
    chatWindow = win;
    chatWindowMode = mode;
    revealChatWindow(win);
    logChatWindow(`聊天窗口已创建 mode=${mode} bounds=${JSON.stringify(bounds)}`);
    return win;
  })().finally(() => {
    creating = null;
  });
  return creating;
}

function showChatWindow(anchor: { x: number; y: number } | null): void {
  if (isLiveWindow(chatWindow)) {
    if (chatWindow.isMinimized()) chatWindow.restore();
    chatWindow.show();
    chatWindow.focus();
    notifyWindowState(chatWindow);
    return;
  }
  void ensureChatWindow(anchor);
}

/**
 * 双缓冲切换：先把新窗口藏在后台加载好，确认 DOM 健康后再 show 新窗口、销毁旧窗口。
 * 直接 destroy 旧窗口再同一拍创建新窗口，会让新窗口的导航 / 渲染进程分配失败，
 * 留下一个永远空白的全透明窗口。
 */
async function swapChatWindow(next: ChatUiMode): Promise<boolean> {
  const old = chatWindow;
  if (!isLiveWindow(old)) return false;
  const previous = chatWindowMode;
  if (next === previous) return true;

  stopResize();
  if (boundsTimer) {
    clearTimeout(boundsTimer);
    boundsTimer = null;
  }

  const oldCard = cardBoundsFromContent(previous, old.getContentBounds());
  logChatWindow(
    `切换开始 ${previous} -> ${next} oldContent=${JSON.stringify(old.getContentBounds())} oldCard=${JSON.stringify(oldCard)}`,
  );
  void service().updateBounds(previous, oldCard);

  const display = screen.getDisplayNearestPoint({
    x: oldCard.x + oldCard.width - 1,
    y: oldCard.y,
  });
  const saved = next === "full" ? service().getUiConfig().fullBounds : null;
  const cardSize =
    next === "full"
      ? {
          width: Math.max(FULL_MIN_WIDTH, saved?.width ?? FULL_CARD_WIDTH),
          height: Math.max(FULL_MIN_HEIGHT, saved?.height ?? FULL_CARD_HEIGHT),
        }
      : { width: COMPACT_CARD_WIDTH, height: COMPACT_CARD_HEIGHT };

  // 右上角锚定：新卡片的右边贴着旧卡片的右边，再限制在屏幕内。
  // 必须用卡片坐标而不是窗口坐标，否则小窗那圈 8px 透明留白会让位置每轮漂移。
  const nextCard = clampToArea(
    {
      x: oldCard.x + oldCard.width - cardSize.width,
      y: oldCard.y,
      width: cardSize.width,
      height: cardSize.height,
    },
    display.workArea,
  );
  const bounds = contentBoundsFromCard(next, nextCard);

  const win = await createPreparedWindow(next, bounds);
  if (!win) {
    logChatWindow(`切换 ${previous} -> ${next} 失败，保留旧窗口`);
    return false;
  }

  chatWindow = win;
  chatWindowMode = next;
  pendingChatWindows.delete(win);
  if (isLiveWindow(old)) old.destroy();
  revealChatWindow(win);
  logChatWindow(`切换 ${previous} -> ${next} 完成 bounds=${JSON.stringify(bounds)}`);
  return true;
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
  if (isLiveWindow(chatWindow) && chatWindow.isVisible()) {
    hideChatWindow();
  } else {
    showChatWindow(null);
  }
}

export function getChatWindow(): BrowserWindow | null {
  return chatWindow;
}

export function isChatWindowVisible(): boolean {
  return Boolean(isLiveWindow(chatWindow) && chatWindow.isVisible());
}

/** 正在加载的新窗口也要能取初始数据，否则切过去会显示成空页面。 */
function isChatSender(sender: Electron.WebContents): boolean {
  if (isLiveWindow(chatWindow) && sender === chatWindow.webContents) return true;
  for (const win of pendingChatWindows) {
    if (!win.isDestroyed() && sender === win.webContents) return true;
  }
  return false;
}

/** 关闭 / 缩放这类动作只认已经上台的窗口，避免 pending 窗口误操作旧窗口。 */
function isCurrentChatSender(sender: Electron.WebContents): boolean {
  return Boolean(isLiveWindow(chatWindow) && sender === chatWindow.webContents);
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
    if (isCurrentChatSender(event.sender)) hideChatWindow();
  });

  ipcMain.on("chat:minimize", (event) => {
    if (isCurrentChatSender(event.sender) && isLiveWindow(chatWindow)) {
      chatWindow.minimize();
    }
  });

  ipcMain.on("chat:resize-start", (event, direction: unknown) => {
    if (!isCurrentChatSender(event.sender) || chatWindowMode !== "full") return;
    if (!isResizeDirection(direction) || !isLiveWindow(chatWindow)) return;
    if (resizeTimer) {
      clearInterval(resizeTimer);
      resizeTimer = null;
    }
    resizeSession = {
      windowId: chatWindow.id,
      direction,
      startPoint: screen.getCursorScreenPoint(),
      startBounds: chatWindow.getContentBounds(),
    };
    // 透明窗口里光标移出窗口后渲染层收不到 mousemove，改由主进程采样光标。
    resizeTimer = setInterval(applyResizeFrame, 16);
  });

  ipcMain.on("chat:resize-move", (event) => {
    if (!isCurrentChatSender(event.sender)) return;
    applyResizeFrame();
  });

  ipcMain.on("chat:resize-end", (event) => {
    if (!isCurrentChatSender(event.sender)) return;
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
    const clientId =
      typeof record.clientId === "string" ? record.clientId.trim() : undefined;
    const quote =
      record.quote && typeof record.quote === "object"
        ? (record.quote as ChatQuote)
        : undefined;
    return service().send(value, {
      captureScreen: capture,
      displayId,
      clientId,
      quote,
    });
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

  ipcMain.handle("chat:retract", async (event, clientId: unknown) => {
    if (!isChatSender(event.sender)) {
      return { ok: false, kind: "unknown", error: "聊天窗口未打开" };
    }
    const turn = typeof clientId === "string" ? clientId.trim() : "";
    if (!turn) {
      return { ok: false, kind: "unknown", error: "回合 id 不正确。" };
    }
    return service().retract(turn);
  });

  ipcMain.handle("chat:set-mode", (event, mode: unknown) => {
    if (!isCurrentChatSender(event.sender)) return null;
    const next: ChatUiMode = mode === "full" ? "full" : "compact";
    const previous = service().getUiState().mode;
    // 立即返回，窗口切换在后台完成；旧窗口在新窗口准备好之前一直保持原样。
    if (next === previous || switching) return null;

    switching = true;
    void (async () => {
      try {
        // 先静默写入新模式，让新窗口加载时就能拿到正确布局；旧窗口不广播、不预切。
        await service().setMode(next, { broadcast: false });
        const ok = await swapChatWindow(next);
        if (ok) {
          service().broadcastUiState();
        } else {
          await service().setMode(previous, { broadcast: false });
          service().broadcastUiState();
        }
      } catch (error) {
        logChatWindow(`set-mode 失败 ${String(error)}`);
        try {
          await service().setMode(previous, { broadcast: false });
        } catch {
          // 回滚失败时至少把旧窗口的状态广播出去。
        }
        service().broadcastUiState();
      } finally {
        switching = false;
      }
    })();
    return null;
  });

  ipcMain.handle("chat:set-pinned", async (event, pinned: unknown) => {
    if (!isChatSender(event.sender)) return null;
    const state = await service().setPinned(pinned === true);
    if (isLiveWindow(chatWindow)) {
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

  // 打字时告诉主进程：随机点评先让路；停手 2 分钟后自动恢复。
  ipcMain.handle("chat:activity", (event) => {
    if (!isChatSender(event.sender)) return;
    service().noteChatActivity();
  });

  ipcMain.handle("chat:retry", async (event) => {
    if (!isChatSender(event.sender)) return null;
    await service().bootstrap();
    return service().getInitial();
  });

  ipcMain.handle("chat:open-settings", (event) => {
    if (!isCurrentChatSender(event.sender)) return;
    for (const win of BrowserWindow.getAllWindows()) {
      if (
        win === chatWindow ||
        pendingChatWindows.has(win) ||
        isPointerWindow(win) ||
        win.isDestroyed()
      ) {
        continue;
      }
      win.webContents.send("pet:open-settings");
      win.showInactive();
    }
  });

  ipcMain.handle("chat:ui-state", (event) => {
    if (!isChatSender(event.sender)) return null;
    return service().getUiState();
  });

  ipcMain.handle("chat:hide", (event) => {
    if (!isCurrentChatSender(event.sender)) return;
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

  ipcMain.handle("chat:set-message-font", async (event, patch: unknown) => {
    if (!isChatSender(event.sender) || !patch || typeof patch !== "object") {
      return null;
    }
    const record = patch as Record<string, unknown>;
    const next: Partial<MessageFont> = {};
    if (typeof record.bold === "boolean") next.bold = record.bold;
    if (typeof record.color === "string") next.color = record.color;
    if (typeof record.stroke === "boolean") next.stroke = record.stroke;
    if (typeof record.strokeWidth === "number" && Number.isFinite(record.strokeWidth)) {
      next.strokeWidth = record.strokeWidth;
    }
    if (typeof record.strokeColor === "string") next.strokeColor = record.strokeColor;
    if (typeof record.shadow === "boolean") next.shadow = record.shadow;
    if (typeof record.shadowBlur === "number" && Number.isFinite(record.shadowBlur)) {
      next.shadowBlur = record.shadowBlur;
    }
    if (typeof record.shadowColor === "string") next.shadowColor = record.shadowColor;
    return service().setMessageFont(next);
  });

  ipcMain.handle("chat:set-typewriter", async (event, patch: unknown) => {
    if (!isChatSender(event.sender) || !patch || typeof patch !== "object") {
      return null;
    }
    const record = patch as Record<string, unknown>;
    const next: Partial<ChatTypewriterSettings> = {};
    if (typeof record.enabled === "boolean") next.enabled = record.enabled;
    if (
      typeof record.charsPerSecond === "number" &&
      Number.isFinite(record.charsPerSecond)
    ) {
      next.charsPerSecond = record.charsPerSecond;
    }
    return service().setTypewriter(next);
  });

  ipcMain.handle("chat:font-preset-save", async (event, name: unknown) => {
    if (!isChatSender(event.sender) || typeof name !== "string") return null;
    try {
      return await service().saveFontPreset(name);
    } catch (error) {
      return { error: error instanceof Error ? error.message : "保存字体预设失败。" };
    }
  });

  ipcMain.handle("chat:font-preset-delete", async (event, id: unknown) => {
    if (!isChatSender(event.sender) || typeof id !== "string") return null;
    try {
      return await service().deleteFontPreset(id);
    } catch (error) {
      return { error: error instanceof Error ? error.message : "删除字体预设失败。" };
    }
  });

  ipcMain.handle("chat:font-preset-apply", async (event, id: unknown) => {
    if (!isChatSender(event.sender) || typeof id !== "string") return null;
    try {
      const result = await service().applyFontPreset(id);
      return result.state;
    } catch (error) {
      return { error: error instanceof Error ? error.message : "应用字体预设失败。" };
    }
  });

  ipcMain.handle("chat:settings-export", async (event) => {
    if (!isChatSender(event.sender)) return null;
    return exportChatSettings(BrowserWindow.fromWebContents(event.sender));
  });

  ipcMain.handle("chat:settings-import", async (event) => {
    if (!isChatSender(event.sender)) return null;
    const result = await importChatSettings(
      BrowserWindow.fromWebContents(event.sender),
    );
    if (result.ok) {
      await service().reloadUi();
      resetCommentaryWatch();
      const config = await readConfig();
      broadcastToWindows("pet:bubble", config.bubble);
      broadcastToWindows("pet:commentary", config.commentary);
    }
    return result;
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

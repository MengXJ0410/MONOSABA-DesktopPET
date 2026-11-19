import { BrowserWindow, ipcMain, screen } from "electron";
import { join } from "node:path";
import type { PointerPosition, PointerUpdate } from "../shared/types";
import { appEntryUrl } from "./app-protocol";
import { logStartup } from "./logs";
import { getMainWindow } from "./window";

/**
 * 第二指针（希罗指针）的桌面浮层。
 *
 * Windows 同一时刻只有一个系统光标，所以第二个指针由程序自己画：
 * 每块显示器一个全屏透明、置顶、鼠标穿透的窗口，里面只渲染光标帧。
 * 位置由桌宠渲染层按虚拟桌面 DIP 坐标推过来，这里负责按显示器路由。
 */

type Overlay = {
  win: BrowserWindow;
  displayId: number;
};

const overlays = new Map<number, Overlay>();
let activeDisplayId: number | null = null;
let initialized = false;

function createOverlay(display: Electron.Display): BrowserWindow {
  const owner = getMainWindow();
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    title: "希罗指针",
    // 桌宠窗口开着「强制顶层」时会每 0.9 秒 moveTop 一次；浮层作为它的
    // owned window 才能稳定压在人物上面，否则指针走到人物身上会被挡住。
    ...(owner && !owner.isDestroyed() ? { parent: owner } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.setMenu(null);
  win.setSkipTaskbar(true);
  win.setIgnoreMouseEvents(true);
  // 和聊天窗口一样用 screen-saver 层级，才能真正盖在普通窗口和任务栏之上。
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(false);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = process.env.ELECTRON_RENDERER_URL
      ? url.startsWith(process.env.ELECTRON_RENDERER_URL)
      : url.startsWith("app://bundle/");
    if (!allowed) event.preventDefault();
  });
  win.on("closed", () => {
    const entry = overlays.get(display.id);
    if (entry?.win === win) overlays.delete(display.id);
  });

  overlays.set(display.id, { win, displayId: display.id });
  const url = process.env.ELECTRON_RENDERER_URL
    ? `${process.env.ELECTRON_RENDERER_URL}?view=pointer`
    : `${appEntryUrl()}?view=pointer`;
  void win.loadURL(url);
  win.once("ready-to-show", () => keepOwnerOnTop());
  win.webContents.once("did-finish-load", () => {
    keepOwnerOnTop();
    // 页面首次合成时 Windows 可能再动一次 Z 序，延迟补一次。
    setTimeout(keepOwnerOnTop, 200);
  });
  keepOwnerOnTop();
  logStartup(
    `指针浮层已创建 display=${display.id} bounds=${JSON.stringify(display.bounds)}`,
  );
  return win;
}

function ensureOverlay(display: Electron.Display): BrowserWindow {
  const existing = overlays.get(display.id);
  if (existing && !existing.win.isDestroyed()) return existing.win;
  return createOverlay(display);
}

/**
 * owned 的指针浮层出现时，Windows 会把桌宠主窗口踢出置顶层
 * （实测：浮层创建前 topmost=true，浮层出现后立刻变 false）。
 * 这里把主人的置顶补回来；forceTop 的 0.9 秒循环也会兜底。
 */
function keepOwnerOnTop(): void {
  const owner = getMainWindow();
  if (!owner || owner.isDestroyed()) return;
  owner.setAlwaysOnTop(true, "screen-saver");
  owner.moveTop();
}

function displayForPoint(x: number, y: number): Electron.Display {
  const displays = screen.getAllDisplays();
  const exact = displays.find(
    (display) =>
      x >= display.bounds.x &&
      x < display.bounds.x + display.bounds.width &&
      y >= display.bounds.y &&
      y < display.bounds.y + display.bounds.height,
  );
  if (exact) return exact;
  return screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
}

function routePointer(position: PointerPosition): void {
  const display = displayForPoint(position.x, position.y);
  const { bounds } = display;
  const x =
    Math.min(Math.max(position.x, bounds.x), bounds.x + bounds.width - 1) - bounds.x;
  const y =
    Math.min(Math.max(position.y, bounds.y), bounds.y + bounds.height - 1) - bounds.y;
  const size = Math.min(Math.max(position.size || 32, 8), 512);

  const win = ensureOverlay(display);
  if (activeDisplayId !== display.id) {
    if (!win.isDestroyed() && !win.isVisible()) win.showInactive();
    for (const overlay of overlays.values()) {
      if (overlay.displayId === display.id) continue;
      if (!overlay.win.isDestroyed() && overlay.win.isVisible()) overlay.win.hide();
    }
    activeDisplayId = display.id;
    keepOwnerOnTop();
  }

  const update: PointerUpdate = { x, y, size, visible: true };
  if (!win.isDestroyed()) win.webContents.send("pointer:update", update);
}

function onPointerPosition(event: Electron.IpcMainEvent, payload: unknown): void {
  // 只接受桌宠主窗口上报；聊天 / 指针 / 日记窗口都不能驱动第二指针。
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (!sender || sender !== getMainWindow()) return;
  if (!payload || typeof payload !== "object") return;
  const { x, y, size } = payload as { x?: unknown; y?: unknown; size?: unknown };
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    return;
  }
  routePointer({
    x,
    y,
    size: typeof size === "number" && Number.isFinite(size) ? size : 32,
  });
}

function destroyOverlays(): void {
  for (const overlay of [...overlays.values()]) {
    if (!overlay.win.isDestroyed()) overlay.win.destroy();
  }
  overlays.clear();
  activeDisplayId = null;
}

function handleDisplayChange(): void {
  // 显示器增删 / 缩放变化后旧的 bounds 和 DPI 都可能失效，直接重建。
  destroyOverlays();
}

export function initPointerWindows(): void {
  if (initialized) return;
  initialized = true;
  ipcMain.on("pointer:position", onPointerPosition);
  screen.on("display-added", handleDisplayChange);
  screen.on("display-removed", handleDisplayChange);
  screen.on("display-metrics-changed", handleDisplayChange);
}

export function disposePointerWindows(): void {
  if (!initialized) return;
  initialized = false;
  ipcMain.removeListener("pointer:position", onPointerPosition);
  screen.removeListener("display-added", handleDisplayChange);
  screen.removeListener("display-removed", handleDisplayChange);
  screen.removeListener("display-metrics-changed", handleDisplayChange);
  destroyOverlays();
}

/** 聊天设置「打开控制面板」广播时要跳过指针浮层。 */
export function isPointerWindow(win: BrowserWindow | null): boolean {
  if (!win) return false;
  for (const overlay of overlays.values()) {
    if (overlay.win === win) return true;
  }
  return false;
}

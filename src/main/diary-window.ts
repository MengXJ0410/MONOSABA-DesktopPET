import { BrowserWindow, ipcMain, screen } from "electron";
import { join } from "node:path";
import { appEntryUrl } from "./app-protocol";

const WINDOW_PADDING = 16;

let diaryWindow: BrowserWindow | null = null;
let initialized = false;

function loadDiaryPage(win: BrowserWindow): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  const url = devUrl
    ? `${devUrl}?view=diary`
    : `${appEntryUrl()}?view=diary`;
  void win.loadURL(url);
}

function resizeDiaryWindow(size: { width?: unknown; height?: unknown }): void {
  if (!diaryWindow || diaryWindow.isDestroyed()) return;
  const cardWidth =
    typeof size.width === "number" && Number.isFinite(size.width)
      ? size.width
      : 760;
  const cardHeight =
    typeof size.height === "number" && Number.isFinite(size.height)
      ? size.height
      : 340;

  const width = Math.round(Math.max(360, Math.min(920, cardWidth + WINDOW_PADDING * 2)));
  const height = Math.round(Math.max(120, Math.min(920, cardHeight + WINDOW_PADDING * 2)));

  const bounds = diaryWindow.getBounds();
  if (bounds.width === width && bounds.height === height) return;

  const display = screen.getDisplayMatching(bounds);
  const area = display.workArea;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;

  const x = Math.round(
    Math.max(area.x, Math.min(area.x + area.width - width, centerX - width / 2)),
  );
  const y = Math.round(
    Math.max(area.y, Math.min(area.y + area.height - height, centerY - height / 2)),
  );

  diaryWindow.setBounds({ x, y, width, height });
}

export function createDiaryWindow(): BrowserWindow {
  if (diaryWindow && !diaryWindow.isDestroyed()) {
    diaryWindow.show();
    diaryWindow.focus();
    return diaryWindow;
  }

  const win = new BrowserWindow({
    width: 760 + WINDOW_PADDING * 2,
    height: 340 + WINDOW_PADDING * 2,
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
    title: "希罗的日记",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  diaryWindow = win;
  win.setMenu(null);
  win.setAlwaysOnTop(true);
  win.center();

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
    if (diaryWindow === win) diaryWindow = null;
  });

  loadDiaryPage(win);
  return win;
}

export function initDiaryWindow(): void {
  if (initialized) return;
  initialized = true;

  ipcMain.on("diary:open", () => {
    createDiaryWindow();
  });

  ipcMain.on("diary:close", (event) => {
    if (diaryWindow && !diaryWindow.isDestroyed() && event.sender === diaryWindow.webContents) {
      diaryWindow.close();
    }
  });

  ipcMain.on("diary:resize", (event, size: unknown) => {
    if (!diaryWindow || diaryWindow.isDestroyed() || event.sender !== diaryWindow.webContents) {
      return;
    }
    if (!size || typeof size !== "object") return;
    resizeDiaryWindow(size as { width?: unknown; height?: unknown });
  });
}

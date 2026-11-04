import { BrowserWindow, screen } from "electron";
import { appEntryUrl } from "./app-protocol";

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function createMainWindow(preloadPath: string): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;

  const win = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
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
    alwaysOnTop: true,
    // 全屏置顶窗口一旦被点击激活，下层播放器（如 B 站客户端）会进入
    // 非前台/失焦状态并暂停视频渲染，表现为“点一下桌宠视频就黑屏”。
    // focusable: false 会加上 WS_EX_NOACTIVATE，窗口仍然收得到鼠标事件，
    // 但点击/拖拽不会再抢走前台焦点。
    focusable: false,
    title: "MONOSABA DesktopPET",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  mainWindow = win;

  win.setMenu(null);
  win.setSkipTaskbar(true);
  win.setAlwaysOnTop(true);
  win.setFocusable(false);
  win.setIgnoreMouseEvents(true, { forward: true });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = process.env.ELECTRON_RENDERER_URL
      ? url.startsWith(process.env.ELECTRON_RENDERER_URL)
      : url.startsWith("app://bundle/");
    if (!allowed) event.preventDefault();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    win.webContents.on("console-message", (_event, level, message) => {
      console.log(`[renderer:${level}] ${message}`);
    });
  }
  win.webContents.on("did-fail-load", (_event, code, description) => {
    console.error(`[main] renderer failed to load: ${code} ${description}`);
  });
  win.webContents.on("did-finish-load", () => {
    console.log("[main] renderer loaded");
  });

  win.once("ready-to-show", () => {
    win.showInactive();
  });

  win.on("closed", () => {
    mainWindow = null;
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadURL(appEntryUrl());
  }

  return win;
}

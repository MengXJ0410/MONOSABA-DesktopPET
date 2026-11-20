import { app, Menu, nativeImage, screen, shell, Tray } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BUILD_DEFAULT_CHARACTER } from "./build-info";
import { chatService } from "./chat/service";
import { ensureConfig } from "./config";
import {
  isChatWindowVisible,
  openChatWindow,
  toggleChatWindow,
} from "./chat-window";
import { isForceTop, listDisplays, selectDisplay } from "./display";
import { getMainWindow } from "./window";

let tray: Tray | null = null;
let unread = 0;
let normalImage: Electron.NativeImage | null = null;
let unreadImage: Electron.NativeImage | null = null;

function iconName(unreadState: boolean): string {
  if (BUILD_DEFAULT_CHARACTER === "ema") return "icon-ema.png";
  return unreadState ? "icon-unread.png" : "icon.png";
}

function resolveIconPath(name: string): string {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, name), join(process.resourcesPath, "icon.png")]
    : [join(app.getAppPath(), "build", name), join(app.getAppPath(), "build", "icon.png")];
  return candidates.find((path) => existsSync(path)) ?? "";
}

function loadImages(): void {
  if (!normalImage) {
    const path = resolveIconPath(iconName(false));
    normalImage = path ? nativeImage.createFromPath(path) : nativeImage.createEmpty();
  }
  if (!unreadImage) {
    const path = resolveIconPath(iconName(true));
    unreadImage = path ? nativeImage.createFromPath(path) : normalImage;
  }
}

function updateTrayVisual(): void {
  if (!tray) return;
  loadImages();
  tray.setImage(unread > 0 && unreadImage ? unreadImage : normalImage ?? nativeImage.createEmpty());
  tray.setToolTip(unread > 0 ? `希罗 · ${unread} 条未读` : "MONOSABA DesktopPET");
}

export function setTrayUnread(count: number): void {
  unread = Math.max(0, Math.round(count));
  updateTrayVisual();
  if (tray) rebuildMenu();
}

function rebuildMenu(): void {
  if (!tray) return;
  const win = getMainWindow();
  const displays = listDisplays();
  const screenItems =
    displays.length > 1
      ? [
          {
            label: "显示屏幕",
            submenu: displays.map((display) => ({
              label: `${display.label}${display.primary ? "（主屏）" : ""} · ${display.pixelWidth}×${display.pixelHeight}`,
              type: "radio" as const,
              checked: display.current,
              click: () => {
                selectDisplay(display.id);
                rebuildMenu();
              },
            })),
          },
          { type: "separator" as const },
        ]
      : [];

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: isChatWindowVisible() ? "收起聊天" : "打开聊天",
        click: () => toggleChatWindow(),
      },
      { type: "separator" },
      {
        label: "重新载入",
        click: () => getMainWindow()?.webContents.reload(),
      },
      {
        label: "始终置顶",
        type: "checkbox",
        checked: win?.isAlwaysOnTop() ?? true,
        // 强制顶层自己会维持置顶，避免两处开关互相打架。
        enabled: !isForceTop(),
        click: (item) => {
          if (isForceTop()) return;
          getMainWindow()?.setAlwaysOnTop(item.checked);
        },
      },
      ...screenItems,
      {
        label: "打开配置文件",
        click: () => {
          void ensureConfig().then(async (path) => {
            const error = await shell.openPath(path);
            if (error) shell.showItemInFolder(path);
          });
        },
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => app.quit(),
      },
    ]),
  );
}

export function createTray(): Tray {
  if (tray) return tray;

  loadImages();
  tray = new Tray(unread > 0 && unreadImage ? unreadImage : normalImage ?? nativeImage.createEmpty());
  tray.setToolTip("MONOSABA DesktopPET");
  rebuildMenu();

  chatService.setUnreadListener((next) => setTrayUnread(next));

  tray.on("double-click", () => {
    if (BUILD_DEFAULT_CHARACTER === "ema") {
      getMainWindow()?.showInactive();
      return;
    }
    openChatWindow(null);
  });
  tray.on("right-click", rebuildMenu);

  // 屏幕热插拔后重建菜单，避免「显示屏幕」里还是旧列表。
  screen.on("display-added", rebuildMenu);
  screen.on("display-removed", rebuildMenu);
  screen.on("display-metrics-changed", rebuildMenu);

  app.on("before-quit", () => {
    screen.removeListener("display-added", rebuildMenu);
    screen.removeListener("display-removed", rebuildMenu);
    screen.removeListener("display-metrics-changed", rebuildMenu);
    tray?.destroy();
    tray = null;
  });

  return tray;
}

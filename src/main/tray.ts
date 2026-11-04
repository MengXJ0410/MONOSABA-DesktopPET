import { app, Menu, nativeImage, screen, shell, Tray } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BUILD_DEFAULT_CHARACTER } from "./build-info";
import { ensureConfig } from "./config";
import { listDisplays, selectDisplay } from "./display";
import { getMainWindow } from "./window";

let tray: Tray | null = null;

function resolveIconPath(): string {
  const iconName = BUILD_DEFAULT_CHARACTER === "ema" ? "icon-ema.png" : "icon.png";
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, iconName)]
    : [join(app.getAppPath(), "build", iconName)];
  return candidates.find((path) => existsSync(path)) ?? "";
}

export function createTray(): Tray {
  if (tray) return tray;

  const iconPath = resolveIconPath();
  const image = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip("MONOSABA DesktopPET");

  const rebuild = () => {
    if (!tray) return;
    const win = getMainWindow();
    const displays = listDisplays();
    const screenItems =
      displays.length > 1
        ? [
            {
              label: "显示屏幕",
              submenu: displays.map((display) => ({
                label: display.primary ? `${display.label}（主屏）` : display.label,
                type: "radio" as const,
                checked: display.current,
                click: () => {
                  selectDisplay(display.id);
                  rebuild();
                },
              })),
            },
            { type: "separator" as const },
          ]
        : [];

    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: "重新载入",
          click: () => getMainWindow()?.webContents.reload(),
        },
        {
          label: "始终置顶",
          type: "checkbox",
          checked: win?.isAlwaysOnTop() ?? true,
          click: (item) => getMainWindow()?.setAlwaysOnTop(item.checked),
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
  };

  rebuild();
  tray.on("double-click", () => getMainWindow()?.showInactive());
  tray.on("right-click", rebuild);

  // 屏幕热插拔后重建菜单，避免「显示屏幕」里还是旧列表。
  screen.on("display-added", rebuild);
  screen.on("display-removed", rebuild);
  screen.on("display-metrics-changed", rebuild);

  app.on("before-quit", () => {
    screen.removeListener("display-added", rebuild);
    screen.removeListener("display-removed", rebuild);
    screen.removeListener("display-metrics-changed", rebuild);
    tray?.destroy();
    tray = null;
  });

  return tray;
}

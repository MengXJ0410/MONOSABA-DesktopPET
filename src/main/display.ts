import { screen } from "electron";
import type { DisplayInfo } from "../shared/types";
import { getMainWindow } from "./window";

/**
 * 桌宠窗口铺满一块屏幕的工作区。默认只在主屏，可在设置面板 / 托盘里切换。
 * 窗口坐标用 DIP，和渲染层的 CSS 像素一致，跨不同缩放的屏幕也不用换算。
 */

function currentDisplayId(): string | null {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return null;
  return String(screen.getDisplayMatching(win.getBounds()).id);
}

export function listDisplays(): DisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id;
  const activeId = currentDisplayId();
  // 按坐标排序，保证拔插屏幕后「屏幕 N」的编号尽量稳定。
  const displays = [...screen.getAllDisplays()].sort(
    (a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y || a.id - b.id,
  );

  return displays.map((display, index) => ({
    id: String(display.id),
    index: index + 1,
    label: `屏幕 ${index + 1}`,
    width: Math.round(display.workArea.width),
    height: Math.round(display.workArea.height),
    scaleFactor: display.scaleFactor,
    primary: display.id === primaryId,
    current: String(display.id) === activeId,
  }));
}

function boundsOf(displayId: string) {
  return screen.getAllDisplays().find((display) => String(display.id) === displayId)?.workArea ?? null;
}

/** 把窗口整块搬到目标屏幕的工作区；找不到这块屏就返回 null。 */
export function moveToDisplay(displayId: string): DisplayInfo | null {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return null;
  const area = boundsOf(displayId);
  if (!area) return null;

  win.setBounds({ x: area.x, y: area.y, width: area.width, height: area.height });
  win.setAlwaysOnTop(true);
  return listDisplays().find((display) => display.id === displayId) ?? null;
}

/** 屏幕事件后把窗口重新贴回所在屏的工作区（拔掉屏幕时 getDisplayMatching 会回落到主屏）。 */
export function syncWindowToDisplay(): DisplayInfo | null {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return null;

  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  const bounds = win.getBounds();
  if (
    bounds.x !== area.x ||
    bounds.y !== area.y ||
    bounds.width !== area.width ||
    bounds.height !== area.height
  ) {
    win.setBounds({ x: area.x, y: area.y, width: area.width, height: area.height });
    win.setAlwaysOnTop(true);
  }
  const activeId = currentDisplayId();
  return listDisplays().find((display) => display.id === activeId) ?? null;
}

/** 切换屏幕并通知渲染层同步（渲染层据此更新按钮高亮和 localStorage）。 */
export function selectDisplay(displayId: string): DisplayInfo | null {
  const info = moveToDisplay(displayId);
  if (!info) return null;
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send("pet:display-changed", info);
  }
  return info;
}

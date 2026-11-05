import { screen, type Display } from "electron";
import type { DisplayInfo } from "../shared/types";
import { getMainWindow } from "./window";

/**
 * 桌宠窗口铺满一块屏幕。默认只占工作区，可在设置面板 / 托盘里切换。
 * 开启「强制顶层」后改为铺满整块屏幕（含任务栏），并定期把自己提到
 * 置顶窗口的最前面，避免被任务栏、开始菜单顶下去。
 * 窗口坐标用 DIP，和渲染层的 CSS 像素一致，跨不同缩放的屏幕也不用换算。
 */

let forceTop = false;
let topmostTimer: NodeJS.Timeout | null = null;

/** 任务栏也是置顶窗口，隔一小段时间重新提一次，保证盖在它上面。 */
const TOPMOST_INTERVAL_MS = 900;

export function isForceTop(): boolean {
  return forceTop;
}

function areaOf(display: Display) {
  return forceTop ? display.bounds : display.workArea;
}

function applyBounds(display: Display) {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  const area = areaOf(display);
  win.setBounds({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
  });
}

function currentDisplayId(): string | null {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return null;
  return String(screen.getDisplayMatching(win.getBounds()).id);
}

function stopTopmostLoop() {
  if (topmostTimer) {
    clearInterval(topmostTimer);
    topmostTimer = null;
  }
}

function startTopmostLoop() {
  stopTopmostLoop();
  topmostTimer = setInterval(() => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      stopTopmostLoop();
      return;
    }
    // moveTop 只调整 Z 序、不抢前台焦点，正好配合 focusable: false。
    win.moveTop();
  }, TOPMOST_INTERVAL_MS);
}

/** 退出前清理定时器，避免持有已销毁的窗口。 */
export function disposeForceTop() {
  stopTopmostLoop();
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
    // 和窗口实际覆盖范围一致：强制顶层时是整块屏幕，否则是工作区。
    width: Math.round(areaOf(display).width),
    height: Math.round(areaOf(display).height),
    scaleFactor: display.scaleFactor,
    primary: display.id === primaryId,
    current: String(display.id) === activeId,
  }));
}

function findDisplay(displayId: string) {
  return screen.getAllDisplays().find((display) => String(display.id) === displayId) ?? null;
}

/** 把窗口整块搬到目标屏幕；找不到这块屏就返回 null。 */
export function moveToDisplay(displayId: string): DisplayInfo | null {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return null;
  const display = findDisplay(displayId);
  if (!display) return null;

  applyBounds(display);
  win.setAlwaysOnTop(true, "screen-saver");
  if (forceTop) win.moveTop();
  return listDisplays().find((info) => info.id === displayId) ?? null;
}

/** 屏幕事件后把窗口重新贴回所在屏（拔掉屏幕时 getDisplayMatching 会回落到主屏）。 */
export function syncWindowToDisplay(): DisplayInfo | null {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return null;

  const display = screen.getDisplayMatching(win.getBounds());
  const area = areaOf(display);
  const bounds = win.getBounds();
  if (
    bounds.x !== area.x ||
    bounds.y !== area.y ||
    bounds.width !== area.width ||
    bounds.height !== area.height
  ) {
    applyBounds(display);
    win.setAlwaysOnTop(true, "screen-saver");
    if (forceTop) win.moveTop();
  }
  const activeId = currentDisplayId();
  return listDisplays().find((info) => info.id === activeId) ?? null;
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

/**
 * 强制顶层：窗口铺满整块屏幕（含任务栏），并定期把自己提到置顶层队首。
 * 关闭时恢复原来的工作区大小和用户之前的置顶开关。
 */
export function setForceTop(enabled: boolean): boolean {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return forceTop;
  if (enabled === forceTop) return forceTop;

  if (enabled) {
    forceTop = true;
    // 先改尺寸再声明置顶：Windows 上 setBounds 会把窗口挪出置顶层，
    // 顺序反了会出现「关了强制顶层就掉到所有窗口后面」。
    applyBounds(screen.getDisplayMatching(win.getBounds()));
    win.setAlwaysOnTop(true, "screen-saver");
    win.moveTop();
    startTopmostLoop();
  } else {
    stopTopmostLoop();
    forceTop = false;
    applyBounds(screen.getDisplayMatching(win.getBounds()));
    // 恢复到应用默认的普通置顶；「始终置顶」托盘开关仍可单独关闭。
    win.setAlwaysOnTop(true, "screen-saver");
    win.moveTop();
  }

  return forceTop;
}

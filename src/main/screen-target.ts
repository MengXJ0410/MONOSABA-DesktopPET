import { screen, type Display } from "electron";
import { getActiveFullscreenDisplayIndex } from "./active-window";
import { sortedDisplays } from "./chat/capture";

/**
 * 随机点评和希罗指针共用的「读屏目标屏幕」。
 *
 * 默认 `auto`：沿用活跃屏幕规则——前台全屏 / 最大化窗口所在屏优先，
 * 否则鼠标所在屏。用户在面板里选定某块屏幕后，两边都只读那块屏，
 * 也省掉每轮启动 PowerShell 检测前台窗口的开销。
 */
let activityDisplayId = "auto";

export function setActivityDisplayId(value: unknown): void {
  if (typeof value !== "string") return;
  const next = value.trim();
  activityDisplayId = next && next !== "auto" ? next : "auto";
}

/** 当前选定的活动屏幕 id；`auto` 表示跟随活跃屏幕。 */
export function getActivityDisplayId(): string {
  return activityDisplayId;
}

export async function resolveObservationDisplay(): Promise<Display> {
  const displays = sortedDisplays();

  if (activityDisplayId !== "auto") {
    const target = displays.find(
      (display) => String(display.id) === activityDisplayId,
    );
    if (target) return target;
    // 选中的屏幕被拔掉了：回退到自动，避免一直读错屏。
    activityDisplayId = "auto";
  }

  const activeIndex = await getActiveFullscreenDisplayIndex();
  if (activeIndex !== null && displays[activeIndex]) {
    return displays[activeIndex];
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

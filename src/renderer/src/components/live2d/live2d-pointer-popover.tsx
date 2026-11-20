"use client";

import type { CSSProperties, RefObject } from "react";
import type { PointerAiState } from "../../../../shared/types";
import {
  LIVE2D_POINTER_AI_INTERVAL_MAX,
  LIVE2D_POINTER_AI_INTERVAL_MIN,
  LIVE2D_POINTER_AI_INTERVAL_STEP,
  LIVE2D_POINTER_SIZE_MAX,
  LIVE2D_POINTER_SIZE_MIN,
  LIVE2D_POINTER_SIZE_STEP,
} from "@/content/live2d";
import { Live2DHoverPopover } from "./live2d-hover-popover";

type Live2DPointerPopoverProps = {
  /** 「希罗指针」按钮的位置，小窗以它为垂直中心。 */
  anchor: DOMRect;
  /** 设置面板的位置，小窗优先贴在面板外侧。 */
  panel: DOMRect;
  /** 相对 Windows 默认光标（32 DIP）的倍数。 */
  size: number;
  /** 闲时是否让指针自己游走。 */
  idleMove: boolean;
  /** 希罗指针总开关。 */
  enabled: boolean;
  /** AI 观察间隔（秒）。 */
  intervalSec: number;
  /** AI 观察运行状态。 */
  aiState: PointerAiState | null;
  /** 「立即观察一次」正在进行。 */
  observing: boolean;
  popoverRef?: RefObject<HTMLDivElement | null>;
  onChange: (size: number) => void;
  onToggleIdleMove: () => void;
  onToggleEnabled: () => void;
  onIntervalChange: (seconds: number) => void;
  onObserveNow: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onPointerDown: () => void;
  onPointerUp: () => void;
};

const SKIP_LABELS: Record<string, string> = {
  unchanged: "画面没变",
  sleeping: "希罗睡着了",
  budget: "今日调用已用完",
  capture: "截图失败",
  offline: "连不上 AstrBot",
  "no-action": "她觉得不用动",
  error: "这一轮出错",
  disabled: "已关闭",
};

function progressOf(value: number, min: number, max: number) {
  const span = Math.max(1, max - min);
  return ((value - min) / span) * 100;
}

function timeOf(at: number): string {
  if (!at) return "";
  try {
    return new Date(at).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

function describeStatus(enabled: boolean, state: PointerAiState | null): string {
  if (!enabled) return "指针已关闭：不读屏、不调用模型。";
  if (!state) return "正在读取主进程状态…";
  const calls = `今日 ${state.todayCalls}/${state.dailyLimit} 次`;
  if (!state.running) return `观察尚未启动（人物未加载或模型未就绪）· ${calls}`;
  if (!state.lastObserveAt) return `等待第一次观察 · ${calls}`;
  const at = timeOf(state.lastObserveAt);
  if (state.lastAction && !state.lastSkip) {
    return `上次移动 ${at} · ${calls}`;
  }
  const why = state.lastSkip ? SKIP_LABELS[state.lastSkip] ?? state.lastSkip : "";
  return `上次观察 ${at}${why ? ` · ${why}` : ""} · ${calls}`;
}

/** 希罗指针的大小 / 闲时游走 / AI 观察间隔设置小窗。 */
export function Live2DPointerPopover({
  anchor,
  panel,
  size,
  idleMove,
  enabled,
  intervalSec,
  aiState,
  observing,
  popoverRef,
  onChange,
  onToggleIdleMove,
  onToggleEnabled,
  onIntervalChange,
  onObserveNow,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
  onPointerUp,
}: Live2DPointerPopoverProps) {
  return (
    <Live2DHoverPopover
      anchor={anchor}
      panel={panel}
      label="希罗指针设置"
      popoverRef={popoverRef}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <div className="appearance-rotate-heading">
        <span>希罗指针</span>
        <span className="appearance-rotate-current">
          {enabled ? `每 ${intervalSec} 秒看一眼` : "已关闭"}
        </span>
      </div>
      <button
        type="button"
        className={`appearance-popover-switch${enabled ? " is-on" : ""}`}
        aria-pressed={enabled}
        title={
          enabled
            ? "希罗指针已开启：她会定期看一眼屏幕，自己决定把指针移到哪；点击关闭"
            : "希罗指针已关闭：点击开启"
        }
        onClick={onToggleEnabled}
      >
        希罗指针
      </button>
      <button
        type="button"
        className={`appearance-popover-switch${idleMove ? " is-on" : ""}`}
        aria-pressed={idleMove}
        disabled={!enabled}
        title={
          idleMove
            ? "闲时指针自己随机游走，视线跟着它；点击关闭"
            : "指针停在原地，只等 AI 操控；人物闲时仍会自己看来看去"
        }
        onClick={onToggleIdleMove}
      >
        闲时随机移动
      </button>
      <label className="appearance-range appearance-rotate-row">
        <span className="appearance-rotate-label">大小</span>
        <input
          type="range"
          min={LIVE2D_POINTER_SIZE_MIN}
          max={LIVE2D_POINTER_SIZE_MAX}
          step={LIVE2D_POINTER_SIZE_STEP}
          value={size}
          aria-label={`希罗指针大小，当前 ${size.toFixed(1)} 倍`}
          style={
            {
              "--range-progress": `${progressOf(
                size,
                LIVE2D_POINTER_SIZE_MIN,
                LIVE2D_POINTER_SIZE_MAX,
              )}%`,
            } as CSSProperties
          }
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <span className="appearance-rotate-value">×{size.toFixed(1)}</span>
      </label>
      <label className="appearance-range appearance-rotate-row">
        <span className="appearance-rotate-label">观察</span>
        <input
          type="range"
          min={LIVE2D_POINTER_AI_INTERVAL_MIN}
          max={LIVE2D_POINTER_AI_INTERVAL_MAX}
          step={LIVE2D_POINTER_AI_INTERVAL_STEP}
          value={intervalSec}
          disabled={!enabled}
          aria-label={`AI 观察间隔，当前 ${intervalSec} 秒`}
          style={
            {
              "--range-progress": `${progressOf(
                intervalSec,
                LIVE2D_POINTER_AI_INTERVAL_MIN,
                LIVE2D_POINTER_AI_INTERVAL_MAX,
              )}%`,
            } as CSSProperties
          }
          onChange={(event) => onIntervalChange(Number(event.target.value))}
        />
        <span className="appearance-rotate-value">{intervalSec}s</span>
      </label>
      <p className="appearance-rotate-hint" role="status">
        {describeStatus(enabled, aiState)}
      </p>
      <button
        type="button"
        className="appearance-popover-switch"
        disabled={!enabled || observing}
        onClick={onObserveNow}
      >
        {observing ? "正在看一眼…" : "立即观察一次"}
      </button>
      <p className="appearance-rotate-hint">
        {idleMove
          ? "相对 Windows 默认光标；人物视线跟随指针。"
          : "指针停在原地；AI 动作期间视线仍会跟过去。"}
      </p>
    </Live2DHoverPopover>
  );
}

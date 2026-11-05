"use client";

import type { CSSProperties, RefObject } from "react";
import {
  LIVE2D_ROTATE_MAX_SECONDS,
  LIVE2D_ROTATE_MIN_SECONDS,
  LIVE2D_ROTATE_STEP_SECONDS,
} from "@/content/live2d";
import { Live2DHoverPopover } from "./live2d-hover-popover";

type Live2DRotatePopoverProps = {
  /** 「自动轮换」按钮的位置，小窗以它为垂直中心。 */
  anchor: DOMRect;
  /** 设置面板的位置，小窗优先贴在面板外侧。 */
  panel: DOMRect;
  minSeconds: number;
  maxSeconds: number;
  popoverRef?: RefObject<HTMLDivElement | null>;
  onChange: (minSeconds: number, maxSeconds: number) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onPointerDown: () => void;
  onPointerUp: () => void;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function progressOf(seconds: number) {
  const span = LIVE2D_ROTATE_MAX_SECONDS - LIVE2D_ROTATE_MIN_SECONDS;
  return ((seconds - LIVE2D_ROTATE_MIN_SECONDS) / span) * 100;
}

/** 自动轮换的周期设置小窗。 */
export function Live2DRotatePopover({
  anchor,
  panel,
  minSeconds,
  maxSeconds,
  popoverRef,
  onChange,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
  onPointerUp,
}: Live2DRotatePopoverProps) {
  const changeMin = (value: number) => {
    const next = clamp(value, LIVE2D_ROTATE_MIN_SECONDS, maxSeconds);
    onChange(next, maxSeconds);
  };

  const changeMax = (value: number) => {
    const next = clamp(value, minSeconds, LIVE2D_ROTATE_MAX_SECONDS);
    onChange(minSeconds, next);
  };

  return (
    <Live2DHoverPopover
      anchor={anchor}
      panel={panel}
      label="自动轮换周期"
      popoverRef={popoverRef}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <div className="appearance-rotate-heading">
        <span>轮换周期</span>
        <span className="appearance-rotate-current">
          {minSeconds}–{maxSeconds} 秒
        </span>
      </div>
      <label className="appearance-range appearance-rotate-row">
        <span className="appearance-rotate-label">最短</span>
        <input
          type="range"
          min={LIVE2D_ROTATE_MIN_SECONDS}
          max={LIVE2D_ROTATE_MAX_SECONDS}
          step={LIVE2D_ROTATE_STEP_SECONDS}
          value={minSeconds}
          aria-label={`最短轮换间隔，当前 ${minSeconds} 秒`}
          style={{ "--range-progress": `${progressOf(minSeconds)}%` } as CSSProperties}
          onChange={(event) => changeMin(Number(event.target.value))}
        />
        <span className="appearance-rotate-value">{minSeconds}s</span>
      </label>
      <label className="appearance-range appearance-rotate-row">
        <span className="appearance-rotate-label">最长</span>
        <input
          type="range"
          min={LIVE2D_ROTATE_MIN_SECONDS}
          max={LIVE2D_ROTATE_MAX_SECONDS}
          step={LIVE2D_ROTATE_STEP_SECONDS}
          value={maxSeconds}
          aria-label={`最长轮换间隔，当前 ${maxSeconds} 秒`}
          style={{ "--range-progress": `${progressOf(maxSeconds)}%` } as CSSProperties}
          onChange={(event) => changeMax(Number(event.target.value))}
        />
        <span className="appearance-rotate-value">{maxSeconds}s</span>
      </label>
      <p className="appearance-rotate-hint">每次轮换后重新随机，建议 ≥ 15 秒</p>
      {/*
        预留：将来加入第三个人物时，在这里渲染「参与轮换」的多选。
        参与名单已随设置持久化在 characters 字段里。
      */}
    </Live2DHoverPopover>
  );
}

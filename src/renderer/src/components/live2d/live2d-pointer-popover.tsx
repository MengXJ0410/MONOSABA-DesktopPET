"use client";

import type { CSSProperties, RefObject } from "react";
import {
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
  popoverRef?: RefObject<HTMLDivElement | null>;
  onChange: (size: number) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onPointerDown: () => void;
  onPointerUp: () => void;
};

function progressOf(size: number) {
  const span = LIVE2D_POINTER_SIZE_MAX - LIVE2D_POINTER_SIZE_MIN;
  return ((size - LIVE2D_POINTER_SIZE_MIN) / span) * 100;
}

/** 希罗指针的大小设置小窗。 */
export function Live2DPointerPopover({
  anchor,
  panel,
  size,
  popoverRef,
  onChange,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
  onPointerUp,
}: Live2DPointerPopoverProps) {
  return (
    <Live2DHoverPopover
      anchor={anchor}
      panel={panel}
      label="希罗指针大小"
      popoverRef={popoverRef}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <div className="appearance-rotate-heading">
        <span>指针大小</span>
        <span className="appearance-rotate-current">×{size.toFixed(1)}</span>
      </div>
      <label className="appearance-range appearance-rotate-row">
        <span className="appearance-rotate-label">大小</span>
        <input
          type="range"
          min={LIVE2D_POINTER_SIZE_MIN}
          max={LIVE2D_POINTER_SIZE_MAX}
          step={LIVE2D_POINTER_SIZE_STEP}
          value={size}
          aria-label={`希罗指针大小，当前 ${size.toFixed(1)} 倍`}
          style={{ "--range-progress": `${progressOf(size)}%` } as CSSProperties}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <span className="appearance-rotate-value">×{size.toFixed(1)}</span>
      </label>
      <p className="appearance-rotate-hint">
        相对 Windows 默认光标；拖动即时生效，设置会记住。
      </p>
    </Live2DHoverPopover>
  );
}

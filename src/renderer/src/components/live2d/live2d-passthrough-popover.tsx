"use client";

import type { CSSProperties, RefObject } from "react";
import { Live2DHoverPopover } from "./live2d-hover-popover";

type Live2DPassthroughPopoverProps = {
  /** 「鼠标穿透」按钮的位置，小窗以它为垂直中心。 */
  anchor: DOMRect;
  /** 设置面板的位置，小窗优先贴在面板外侧。 */
  panel: DOMRect;
  hoverFade: boolean;
  hoverOpacity: number;
  baseOpacity: number;
  popoverRef?: RefObject<HTMLDivElement | null>;
  onToggleHoverFade: () => void;
  onOpacityChange: (hoverOpacity: number, baseOpacity: number) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onPointerDown: () => void;
  onPointerUp: () => void;
};

/** 鼠标穿透的透明度设置小窗。 */
export function Live2DPassthroughPopover({
  anchor,
  panel,
  hoverFade,
  hoverOpacity,
  baseOpacity,
  popoverRef,
  onToggleHoverFade,
  onOpacityChange,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
  onPointerUp,
}: Live2DPassthroughPopoverProps) {
  return (
    <Live2DHoverPopover
      anchor={anchor}
      panel={panel}
      label="鼠标穿透的不透明度"
      popoverRef={popoverRef}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <div className="appearance-rotate-heading">
        <span>人物不透明度</span>
        <span className="appearance-rotate-current">
          {hoverFade ? `悬停 ${hoverOpacity}%` : "悬停不变淡"}
        </span>
      </div>
      <button
        type="button"
        className={`appearance-popover-switch${hoverFade ? " is-on" : ""}`}
        aria-pressed={hoverFade}
        title={
          hoverFade
            ? "鼠标穿透开启时，悬停人物会变淡，点击关闭"
            : "鼠标穿透开启时，悬停人物会变淡，点击开启"
        }
        onClick={onToggleHoverFade}
      >
        悬停时变淡
      </button>
      <label className="appearance-range appearance-rotate-row">
        <span className="appearance-rotate-label">悬停</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={hoverOpacity}
          aria-label={`悬停不透明度，当前 ${hoverOpacity}%`}
          style={{ "--range-progress": `${hoverOpacity}%` } as CSSProperties}
          onChange={(event) => onOpacityChange(Number(event.target.value), baseOpacity)}
        />
        <span className="appearance-rotate-value">{hoverOpacity}%</span>
      </label>
      <label className="appearance-range appearance-rotate-row">
        <span className="appearance-rotate-label">常态</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={baseOpacity}
          aria-label={`常态不透明度，当前 ${baseOpacity}%`}
          style={{ "--range-progress": `${baseOpacity}%` } as CSSProperties}
          onChange={(event) => onOpacityChange(hoverOpacity, Number(event.target.value))}
        />
        <span className="appearance-rotate-value">{baseOpacity}%</span>
      </label>
      <p className="appearance-rotate-hint">
        常态随时生效；悬停变淡只在鼠标穿透开启时生效
      </p>
    </Live2DHoverPopover>
  );
}

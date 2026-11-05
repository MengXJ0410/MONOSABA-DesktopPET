"use client";

import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

type Live2DHoverPopoverProps = {
  /** 触发按钮的位置，小窗以它为垂直中心。 */
  anchor: DOMRect;
  /** 设置面板的位置，小窗优先贴在面板外侧。 */
  panel: DOMRect;
  label: string;
  popoverRef?: RefObject<HTMLDivElement | null>;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onPointerDown: () => void;
  onPointerUp: () => void;
  children: ReactNode;
};

const POPOVER_WIDTH = 236;
const POPOVER_GAP = 10;
const VIEWPORT_EDGE = 12;
/** 首帧还没量出高度时的占位值，只影响初次定位，量完会纠正。 */
const ESTIMATED_HEIGHT = 160;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

/**
 * 设置面板的悬停小窗外壳。挂在 document.body 上，因为面板自带
 * backdrop-filter + overflow，任何留在面板里的浮层都会被裁掉。
 * 定位优先贴面板左侧，放不下翻到右侧，再整体夹进视口。
 */
export function Live2DHoverPopover({
  anchor,
  panel,
  label,
  popoverRef,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
  onPointerUp,
  children,
}: Live2DHoverPopoverProps) {
  const localRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    const measured = localRef.current?.offsetHeight ?? 0;
    if (measured > 0) setHeight(measured);
  }, []);

  const viewportWidth = typeof window === "undefined" ? 0 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 0 : window.innerHeight;

  let left = panel.left - POPOVER_WIDTH - POPOVER_GAP;
  if (left < VIEWPORT_EDGE) left = panel.right + POPOVER_GAP;
  left = clamp(left, VIEWPORT_EDGE, viewportWidth - POPOVER_WIDTH - VIEWPORT_EDGE);

  const measuredHeight = height || ESTIMATED_HEIGHT;
  const top = clamp(
    anchor.top + anchor.height / 2 - measuredHeight / 2,
    VIEWPORT_EDGE,
    Math.max(VIEWPORT_EDGE, viewportHeight - measuredHeight - VIEWPORT_EDGE),
  );

  const style: CSSProperties = {
    left,
    top,
    width: POPOVER_WIDTH,
    visibility: height ? "visible" : "hidden",
  };

  const setRef = (node: HTMLDivElement | null) => {
    localRef.current = node;
    if (popoverRef) popoverRef.current = node;
  };

  return createPortal(
    <div
      ref={setRef}
      className="appearance-hover-popover"
      style={style}
      role="group"
      aria-label={label}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {children}
    </div>,
    document.body,
  );
}

"use client";

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { DisplayInfo } from "../../../../shared/types";
import {
  LIVE2D_SIZE_MAX,
  LIVE2D_SIZE_MIN,
  type Live2DCharacterId,
} from "@/content/live2d";
import { Live2DRotatePopover } from "./live2d-rotate-popover";
import { Live2DPassthroughPopover } from "./live2d-passthrough-popover";

type PopoverKind = "rotate" | "passthrough";

type Live2DSettingsPanelProps = {
  visible: boolean;
  passthrough: boolean;
  autoLaunch: boolean;
  autoLaunchPending: boolean;
  rotateEnabled: boolean;
  rotateMinSeconds: number;
  rotateMaxSeconds: number;
  opacityHoverFade: boolean;
  opacityHover: number;
  opacityBase: number;
  forceTop: boolean;
  scale: number;
  character: Live2DCharacterId;
  characterName: string;
  nextCharacterName: string;
  /** 可切换的屏幕；只有一块屏时面板不显示这一栏。 */
  displays: DisplayInfo[];
  currentDisplayId: string | null;
  panelRef?: RefObject<HTMLDivElement | null>;
  /** 悬停小窗的 DOM 引用（同一时间只有一个），用于鼠标穿透命中判定。 */
  popoverRef?: RefObject<HTMLDivElement | null>;
  onSwitchCharacter: () => void;
  onSelectDisplay: (displayId: string) => void;
  onToggleRotate: () => void;
  onRotateRangeChange: (minSeconds: number, maxSeconds: number) => void;
  onToggleOpacityHoverFade: () => void;
  onOpacityChange: (hoverOpacity: number, baseOpacity: number) => void;
  onToggleForceTop: () => void;
  /** 管理员 + 希罗时才显示「查看日记」。 */
  canViewDiary: boolean;
  onOpenDiary: () => void;
  onClose: () => void;
  onToggleVisible: () => void;
  onTogglePassthrough: () => void;
  onToggleAutoLaunch: () => void;
  onScaleChange: (value: number) => void;
  onScaleStart?: () => void;
  onScaleCommit?: () => void;
};

/** 悬停按钮后，给鼠标从按钮挪到小窗留一点时间。 */
const POPOVER_CLOSE_MS = 160;

export function Live2DSettingsPanel({
  visible,
  passthrough,
  autoLaunch,
  autoLaunchPending,
  rotateEnabled,
  rotateMinSeconds,
  rotateMaxSeconds,
  opacityHoverFade,
  opacityHover,
  opacityBase,
  forceTop,
  scale,
  character,
  characterName,
  nextCharacterName,
  displays,
  currentDisplayId,
  panelRef,
  popoverRef,
  onSwitchCharacter,
  onSelectDisplay,
  onToggleRotate,
  onRotateRangeChange,
  onToggleOpacityHoverFade,
  onOpacityChange,
  onToggleForceTop,
  canViewDiary,
  onOpenDiary,
  onClose,
  onToggleVisible,
  onTogglePassthrough,
  onToggleAutoLaunch,
  onScaleChange,
  onScaleStart,
  onScaleCommit,
}: Live2DSettingsPanelProps) {
  const progress =
    ((scale - LIVE2D_SIZE_MIN) / (LIVE2D_SIZE_MAX - LIVE2D_SIZE_MIN)) * 100;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const rotateButtonRef = useRef<HTMLButtonElement | null>(null);
  const passthroughButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  // 鼠标在小窗里（或正在拖滑杆）时不能收，否则点到滑杆的瞬间就把面板关了。
  const popoverHoverRef = useRef(false);
  const popoverDraggingRef = useRef(false);
  const [activePopover, setActivePopover] = useState<{
    kind: PopoverKind;
    anchor: DOMRect;
    panel: DOMRect;
  } | null>(null);

  const clearCloseTimer = () => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const openPopover = (kind: PopoverKind) => {
    clearCloseTimer();
    const button =
      kind === "rotate" ? rotateButtonRef.current : passthroughButtonRef.current;
    const root = rootRef.current;
    if (!button || !root) return;
    setActivePopover({
      kind,
      anchor: button.getBoundingClientRect(),
      panel: root.getBoundingClientRect(),
    });
  };

  const scheduleClosePopover = () => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      if (popoverHoverRef.current || popoverDraggingRef.current) return;
      setActivePopover(null);
    }, POPOVER_CLOSE_MS);
  };

  const handlePopoverPointerEnter = () => {
    popoverHoverRef.current = true;
    clearCloseTimer();
  };

  const handlePopoverPointerLeave = () => {
    popoverHoverRef.current = false;
    scheduleClosePopover();
  };

  const handlePopoverPointerDown = () => {
    popoverDraggingRef.current = true;
    clearCloseTimer();
    const end = () => {
      popoverDraggingRef.current = false;
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const handlePopoverPointerUp = () => {
    popoverDraggingRef.current = false;
  };

  useEffect(() => clearCloseTimer, []);

  const setRootRef = (node: HTMLDivElement | null) => {
    rootRef.current = node;
    if (panelRef) panelRef.current = node;
  };

  return (
    <div
      ref={setRootRef}
      className="appearance-panel live2d-settings-panel"
      role="dialog"
      aria-label={characterName}
    >
      <div className="appearance-panel-heading">
        <button
          type="button"
          className="appearance-panel-character"
          data-character={character}
          title={`想见${nextCharacterName}`}
          aria-label={`切换到${nextCharacterName}`}
          onClick={onSwitchCharacter}
        >
          {characterName}
        </button>
        <div className="appearance-panel-actions">
          {canViewDiary && character === "hiro" ? (
            <button
              type="button"
              className="appearance-panel-diary"
              aria-label="偷看希罗的日记"
              onClick={onOpenDiary}
            >
              偷看日记
            </button>
          ) : null}
          <button type="button" aria-label={`关闭${characterName}`} onClick={onClose}>
            ×
          </button>
        </div>
      </div>
      <div className="appearance-toggles" role="group" aria-label="人物设置">
        <button
          type="button"
          className={`appearance-choice appearance-system${visible ? " is-on" : ""}`}
          aria-pressed={visible}
          aria-label={`显示或隐藏人物，当前${visible ? "显示中" : "已隐藏"}`}
          title={visible ? "当前显示中，点击隐藏" : "当前已隐藏，点击显示"}
          onClick={onToggleVisible}
        >
          {visible ? "隐藏人物" : "显示人物"}
        </button>
        <button
          ref={passthroughButtonRef}
          type="button"
          className={`appearance-choice appearance-system${passthrough ? " is-on" : ""}`}
          aria-pressed={passthrough}
          aria-label={`鼠标穿透，当前${passthrough ? "已开启" : "已关闭"}，悬停可设置不透明度`}
          title={
            passthrough
              ? "鼠标穿透已开启，悬停设置不透明度，点击关闭"
              : "鼠标穿透已关闭，悬停设置不透明度，点击开启"
          }
          onClick={onTogglePassthrough}
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") openPopover("passthrough");
          }}
          onPointerLeave={() => scheduleClosePopover()}
          onFocus={() => openPopover("passthrough")}
        >
          鼠标穿透
        </button>
        <button
          type="button"
          className={`appearance-choice appearance-system${autoLaunch ? " is-on" : ""}`}
          aria-pressed={autoLaunch}
          aria-label={`开机自启，当前${autoLaunch ? "已开启" : "已关闭"}`}
          title={autoLaunch ? "开机自启已开启，点击关闭" : "开机自启已关闭，点击开启"}
          disabled={autoLaunchPending}
          onClick={onToggleAutoLaunch}
        >
          开机自启
        </button>
        <button
          ref={rotateButtonRef}
          type="button"
          className={`appearance-choice appearance-system${rotateEnabled ? " is-on" : ""}`}
          aria-pressed={rotateEnabled}
          aria-label={`自动轮换，当前${rotateEnabled ? "已开启" : "已关闭"}，悬停可设置周期`}
          title={
            rotateEnabled
              ? "自动轮换已开启，悬停设置周期，点击关闭"
              : "自动轮换已关闭，悬停设置周期，点击开启"
          }
          onClick={onToggleRotate}
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") openPopover("rotate");
          }}
          onPointerLeave={() => scheduleClosePopover()}
          onFocus={() => openPopover("rotate")}
        >
          自动轮换
        </button>
        <button
          type="button"
          className={`appearance-choice appearance-system appearance-wide${forceTop ? " is-on" : ""}`}
          aria-pressed={forceTop}
          aria-label={`强制顶层，当前${forceTop ? "已开启" : "已关闭"}`}
          title={
            forceTop
              ? "强制顶层已开启：覆盖任务栏，始终显示在最上层，点击关闭"
              : "强制顶层已关闭：只覆盖工作区，开启后人物可以盖住任务栏"
          }
          onClick={onToggleForceTop}
        >
          强制顶层
        </button>
      </div>
      {displays.length > 1 ? (
        <div className="appearance-screens">
          <span className="appearance-label">显示屏幕</span>
          <div className="appearance-screen-list" role="group" aria-label="显示屏幕">
            {displays.map((display) => {
              const active = display.id === currentDisplayId;
              return (
                <button
                  key={display.id}
                  type="button"
                  className={`appearance-choice appearance-screen appearance-system${active ? " is-on" : ""}`}
                  aria-pressed={active}
                  title={`${display.label}${display.primary ? "（主屏）" : ""} · ${display.width}×${display.height}`}
                  onClick={() => onSelectDisplay(display.id)}
                >
                  {display.label}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      <label className="appearance-range">
        <span>人物大小</span>
        <input
          type="range"
          min={LIVE2D_SIZE_MIN}
          max={LIVE2D_SIZE_MAX}
          step={1}
          value={scale}
          style={{ "--range-progress": `${progress}%` } as CSSProperties}
          onChange={(event) => onScaleChange(Number(event.target.value))}
          onPointerDown={onScaleStart}
          onPointerUp={onScaleCommit}
          onPointerCancel={onScaleCommit}
          onKeyUp={onScaleCommit}
          onBlur={onScaleCommit}
        />
      </label>
      <span className="appearance-label" style={{ justifySelf: "end" }}>
        {scale}%
      </span>
      {activePopover?.kind === "rotate" ? (
        <Live2DRotatePopover
          anchor={activePopover.anchor}
          panel={activePopover.panel}
          minSeconds={rotateMinSeconds}
          maxSeconds={rotateMaxSeconds}
          popoverRef={popoverRef}
          onChange={onRotateRangeChange}
          onPointerEnter={handlePopoverPointerEnter}
          onPointerLeave={handlePopoverPointerLeave}
          onPointerDown={handlePopoverPointerDown}
          onPointerUp={handlePopoverPointerUp}
        />
      ) : null}
      {activePopover?.kind === "passthrough" ? (
        <Live2DPassthroughPopover
          anchor={activePopover.anchor}
          panel={activePopover.panel}
          hoverFade={opacityHoverFade}
          hoverOpacity={opacityHover}
          baseOpacity={opacityBase}
          popoverRef={popoverRef}
          onToggleHoverFade={onToggleOpacityHoverFade}
          onOpacityChange={onOpacityChange}
          onPointerEnter={handlePopoverPointerEnter}
          onPointerLeave={handlePopoverPointerLeave}
          onPointerDown={handlePopoverPointerDown}
          onPointerUp={handlePopoverPointerUp}
        />
      ) : null}
    </div>
  );
}

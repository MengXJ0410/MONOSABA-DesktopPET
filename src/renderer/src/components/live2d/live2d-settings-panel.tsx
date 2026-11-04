"use client";

import type { CSSProperties, RefObject } from "react";
import type { DisplayInfo } from "../../../../shared/types";
import {
  LIVE2D_SIZE_MAX,
  LIVE2D_SIZE_MIN,
  type Live2DCharacterId,
} from "@/content/live2d";

type Live2DSettingsPanelProps = {
  visible: boolean;
  passthrough: boolean;
  autoLaunch: boolean;
  autoLaunchPending: boolean;
  scale: number;
  character: Live2DCharacterId;
  characterName: string;
  nextCharacterName: string;
  /** 可切换的屏幕；只有一块屏时面板不显示这一栏。 */
  displays: DisplayInfo[];
  currentDisplayId: string | null;
  panelRef?: RefObject<HTMLDivElement | null>;
  onSwitchCharacter: () => void;
  onSelectDisplay: (displayId: string) => void;
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

export function Live2DSettingsPanel({
  visible,
  passthrough,
  autoLaunch,
  autoLaunchPending,
  scale,
  character,
  characterName,
  nextCharacterName,
  displays,
  currentDisplayId,
  panelRef,
  onSwitchCharacter,
  onSelectDisplay,
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

  return (
    <div
      ref={panelRef}
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
      <button
        type="button"
        className={`appearance-choice appearance-system${visible ? " is-on" : ""}`}
        aria-pressed={visible}
        onClick={onToggleVisible}
      >
        {visible ? "隐藏人物" : "显示人物"}
      </button>
      <button
        type="button"
        className={`appearance-choice appearance-system${passthrough ? " is-on" : ""}`}
        aria-pressed={passthrough}
        onClick={onTogglePassthrough}
      >
        {passthrough ? "关闭鼠标穿透" : "开启鼠标穿透"}
      </button>
      <button
        type="button"
        className={`appearance-choice appearance-system${autoLaunch ? " is-on" : ""}`}
        aria-pressed={autoLaunch}
        disabled={autoLaunchPending}
        onClick={onToggleAutoLaunch}
      >
        {autoLaunch ? "关闭开机自启" : "开机自启"}
      </button>
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
    </div>
  );
}

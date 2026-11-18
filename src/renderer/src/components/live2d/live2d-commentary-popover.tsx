"use client";

import { useEffect, useState, type CSSProperties, type RefObject } from "react";
import {
  LIVE2D_COMMENTARY_MAX_SECONDS,
  LIVE2D_COMMENTARY_MIN_SECONDS,
  LIVE2D_COMMENTARY_SLIDER_MAX,
  LIVE2D_COMMENTARY_STEP_SECONDS,
} from "@/content/live2d";
import { Live2DHoverPopover } from "./live2d-hover-popover";

type Live2DCommentaryPopoverProps = {
  anchor: DOMRect;
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

function sliderMax(value: number) {
  return Math.max(LIVE2D_COMMENTARY_SLIDER_MAX, value);
}

function progressOf(seconds: number) {
  const max = sliderMax(seconds);
  const span = max - LIVE2D_COMMENTARY_MIN_SECONDS;
  return ((seconds - LIVE2D_COMMENTARY_MIN_SECONDS) / span) * 100;
}

/** 随机点评的间隔设置小窗。 */
export function Live2DCommentaryPopover({
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
}: Live2DCommentaryPopoverProps) {
  const [minDraft, setMinDraft] = useState(String(minSeconds));
  const [maxDraft, setMaxDraft] = useState(String(maxSeconds));

  useEffect(() => setMinDraft(String(minSeconds)), [minSeconds]);
  useEffect(() => setMaxDraft(String(maxSeconds)), [maxSeconds]);

  const commitMin = (raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      setMinDraft(String(minSeconds));
      return;
    }
    const next = clamp(
      Math.round(parsed),
      LIVE2D_COMMENTARY_MIN_SECONDS,
      LIVE2D_COMMENTARY_MAX_SECONDS,
    );
    const value = Math.min(next, maxSeconds);
    setMinDraft(String(value));
    onChange(value, maxSeconds);
  };

  const commitMax = (raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      setMaxDraft(String(maxSeconds));
      return;
    }
    const next = clamp(
      Math.round(parsed),
      minSeconds,
      LIVE2D_COMMENTARY_MAX_SECONDS,
    );
    setMaxDraft(String(next));
    onChange(minSeconds, next);
  };

  return (
    <Live2DHoverPopover
      anchor={anchor}
      panel={panel}
      label="随机点评间隔"
      popoverRef={popoverRef}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <div className="appearance-rotate-heading">
        <span>点评间隔</span>
        <span className="appearance-rotate-current">
          {minSeconds}–{maxSeconds} 秒
        </span>
      </div>
      <label className="appearance-range appearance-rotate-row">
        <span className="appearance-rotate-label">最短</span>
        <input
          type="range"
          min={LIVE2D_COMMENTARY_MIN_SECONDS}
          max={sliderMax(minSeconds)}
          step={LIVE2D_COMMENTARY_STEP_SECONDS}
          value={minSeconds}
          aria-label={`最短点评间隔，当前 ${minSeconds} 秒`}
          style={{ "--range-progress": `${progressOf(minSeconds)}%` } as CSSProperties}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(next, Math.max(next, maxSeconds));
          }}
        />
        <input
          className="appearance-commentary-input"
          type="number"
          min={LIVE2D_COMMENTARY_MIN_SECONDS}
          step={LIVE2D_COMMENTARY_STEP_SECONDS}
          value={minDraft}
          aria-label="最短点评间隔（秒）"
          onChange={(event) => setMinDraft(event.target.value)}
          onBlur={() => commitMin(minDraft)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            commitMin(minDraft);
            event.currentTarget.blur();
          }}
        />
        <span className="appearance-rotate-value">s</span>
      </label>
      <label className="appearance-range appearance-rotate-row">
        <span className="appearance-rotate-label">最长</span>
        <input
          type="range"
          min={LIVE2D_COMMENTARY_MIN_SECONDS}
          max={sliderMax(maxSeconds)}
          step={LIVE2D_COMMENTARY_STEP_SECONDS}
          value={maxSeconds}
          aria-label={`最长点评间隔，当前 ${maxSeconds} 秒`}
          style={{ "--range-progress": `${progressOf(maxSeconds)}%` } as CSSProperties}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(minSeconds, Math.max(minSeconds, next));
          }}
        />
        <input
          className="appearance-commentary-input"
          type="number"
          min={LIVE2D_COMMENTARY_MIN_SECONDS}
          step={LIVE2D_COMMENTARY_STEP_SECONDS}
          value={maxDraft}
          aria-label="最长点评间隔（秒）"
          onChange={(event) => setMaxDraft(event.target.value)}
          onBlur={() => commitMax(maxDraft)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            commitMax(maxDraft);
            event.currentTarget.blur();
          }}
        />
        <span className="appearance-rotate-value">s</span>
      </label>
      <p className="appearance-rotate-hint">
        开启后停用待机闲谈；滑块到 600 秒，数值框可填任意 ≥30 秒的值。
      </p>
      <p className="appearance-rotate-hint">
        字号、字体和气泡样式请在聊天设置 → 桌宠气泡里调整。
      </p>
    </Live2DHoverPopover>
  );
}

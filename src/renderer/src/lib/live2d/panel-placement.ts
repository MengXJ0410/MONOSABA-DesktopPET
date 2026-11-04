/**
 * 面板避让：像磁铁同性相斥一样，把面板推到不压住人物的位置，
 * 同时被视口边界挤住；实在放不下（窗口太小）就允许重叠。
 */
export type PanelRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type BoxRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type PlacementBounds = {
  minLeft: number;
  minTop: number;
  maxLeft: number;
  maxTop: number;
};

export function repelPanel(
  panel: PanelRect,
  character: BoxRect | null,
  bounds: PlacementBounds,
): { left: number; top: number } {
  const clamp = (value: number, minimum: number, maximum: number) =>
    Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
  let left = clamp(panel.left, bounds.minLeft, bounds.maxLeft);
  let top = clamp(panel.top, bounds.minTop, bounds.maxTop);
  if (!character) return { left, top };

  const overlaps =
    left < character.right &&
    left + panel.width > character.left &&
    top < character.bottom &&
    top + panel.height > character.top;
  if (!overlaps) return { left, top };

  const candidates = [
    { left: character.left - panel.width, top },
    { left: character.right, top },
    { left, top: character.top - panel.height },
    { left, top: character.bottom },
  ]
    .filter(
      (candidate) =>
        candidate.left >= bounds.minLeft &&
        candidate.left <= bounds.maxLeft &&
        candidate.top >= bounds.minTop &&
        candidate.top <= bounds.maxTop,
    )
    .sort(
      (a, b) =>
        Math.abs(a.left - left) +
        Math.abs(a.top - top) -
        (Math.abs(b.left - left) + Math.abs(b.top - top)),
    );

  if (candidates.length === 0) return { left, top };
  left = clamp(candidates[0].left, bounds.minLeft, bounds.maxLeft);
  top = clamp(candidates[0].top, bounds.minTop, bounds.maxTop);
  return { left, top };
}

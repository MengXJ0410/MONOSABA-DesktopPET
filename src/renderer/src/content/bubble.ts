import type {
  BubblePosition,
  BubbleSettings,
  MessageFont,
} from "../../../shared/types";

/** 桌宠气泡和聊天消息统一使用黑体栈。 */
export const MESSAGE_FONT_STACK =
  '"Microsoft YaHei UI", "Microsoft YaHei", SimHei, "Heiti SC", sans-serif';

export const DEFAULT_MESSAGE_FONT: MessageFont = {
  bold: false,
  color: "",
  stroke: false,
  strokeWidth: 1,
  strokeColor: "#000000",
  shadow: false,
  shadowBlur: 4,
  shadowColor: "#000000",
};

export const DEFAULT_BUBBLE_FONT: MessageFont = {
  ...DEFAULT_MESSAGE_FONT,
  shadow: true,
  shadowBlur: 6,
};

export const DEFAULT_BUBBLE: BubbleSettings = {
  fontSize: 13,
  opacity: 84,
  position: "top",
  maxWidth: 260,
  plainText: false,
  autoHideSeconds: 0,
  rounds: 3,
  font: DEFAULT_BUBBLE_FONT,
};

export const BUBBLE_FONT_MIN = 12;
export const BUBBLE_FONT_MAX = 24;
export const BUBBLE_OPACITY_MIN = 20;
export const BUBBLE_WIDTH_MIN = 180;
export const BUBBLE_WIDTH_MAX = 420;
export const BUBBLE_ROUNDS_MIN = 1;
export const BUBBLE_ROUNDS_MAX = 5;
export const BUBBLE_AUTOHIDE_MAX = 300;

export const TYPEWRITER_MIN_CPS = 5;
export const TYPEWRITER_MAX_CPS = 60;

export const BUBBLE_POSITION_LABEL: Record<BubblePosition, string> = {
  top: "正上方",
  left: "左侧",
  right: "右侧",
};

/** 把一段消息字体配置转成内联 CSS 变量。 */
export function messageFontVars(
  font: MessageFont,
  prefix: string,
): Record<string, string> {
  const vars: Record<string, string> = {
    [`--${prefix}-weight`]: font.bold ? "700" : "400",
  };
  // 只有真正开了才写变量，关掉后自动回落到组件原本的配色。
  if (font.color) vars[`--${prefix}-color`] = font.color;
  if (font.stroke && font.strokeWidth > 0) {
    vars[`--${prefix}-stroke`] = `${font.strokeWidth}px ${font.strokeColor}`;
  }
  if (font.shadow) {
    vars[`--${prefix}-shadow`] =
      `0 2px ${Math.max(0, Math.round(font.shadowBlur))}px ${font.shadowColor}`;
  }
  return vars;
}

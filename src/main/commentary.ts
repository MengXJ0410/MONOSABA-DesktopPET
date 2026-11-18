import { screen } from "electron";
import type { CommentaryRunResult } from "../shared/types";
import { getActiveFullscreenDisplayIndex } from "./active-window";
import { captureDisplay, sortedDisplays } from "./chat/capture";
import { chatService } from "./chat/service";
import { normalizeCommentary } from "./commentary-text";

const PROMPT =
  "（你随手瞥了一眼我现在的屏幕）用 10~100 字、1~3 段，随口点评一下你看到的内容。不要提问，不要解释你在做什么，也不要提“截图”两个字。";

/** 前台全屏窗口优先，其次鼠标所在屏幕。 */
export async function runCommentary(character?: string): Promise<CommentaryRunResult> {
  if (chatService.isWindowActive()) {
    // 聊天窗口聚焦时暂停，避免和正在进行的对话叠在一起。
    return { ok: false, skipped: true };
  }

  const activeIndex = await getActiveFullscreenDisplayIndex();
  const displays = sortedDisplays();
  const display =
    activeIndex !== null && displays[activeIndex]
      ? displays[activeIndex]
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const shot = await captureDisplay(String(display.id));
  if (!shot) return { ok: false, error: "屏幕截图失败。" };

  const reply = await chatService.sendCommentary(PROMPT, shot, character);
  if (!reply) return { ok: false, error: "没有收到点评。" };

  const text = normalizeCommentary(reply);
  if (!text) return { ok: false, error: "点评内容为空。" };
  return { ok: true, text };
}

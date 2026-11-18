import { BrowserWindow, nativeImage, screen } from "electron";
import type { CommentaryRunResult } from "../shared/types";
import { getActiveFullscreenDisplayIndex } from "./active-window";
import { captureDisplay, sortedDisplays } from "./chat/capture";
import { chatService } from "./chat/service";
import { isCommentarySameReply } from "./commentary-marker";
import { normalizeCommentary } from "./commentary-text";

const PROMPT =
  "（你随手瞥了一眼我现在的屏幕）先判断这一屏和你上一轮点评时相比有没有实质变化：如果只是人物待机动画、动态壁纸这类细微变化，或者基本就是同一屏，请只回复 [[SAME]]，不要写点评。否则用 10~100 字、1~3 段，随口点评一下你看到的内容；不要提问，不要解释你在做什么，也不要提“截图”两个字。";

/** 连续 3 轮回复“没变”后暂停；和“超过三轮”对应。 */
const SAME_REPLY_LIMIT = 3;
/** 恢复判定：缩略图指纹变化超过约 20% 才算画面真的变了，忽略待机动画 / 动态壁纸。 */
const RESUME_FINGERPRINT_DISTANCE = 120;
/** 恢复判定：鼠标移动超过 24px 视为用户回来了。 */
const RESUME_POINTER_PX = 24;
const PAUSE_TIP =
  "屏幕一直没变，我先不点评了。等你回来或者画面有变化，我再继续。";

let sameRounds = 0;
let paused = false;
let pauseFingerprint: string | null = null;
let pauseCursor: { x: number; y: number } | null = null;

/** 重新开启点评、修改间隔或导入设置时，清掉暂停判断，重新观察。 */
export function resetCommentaryWatch(): void {
  sameRounds = 0;
  paused = false;
  pauseFingerprint = null;
  pauseCursor = null;
}

/** 32×18 灰度缩略图指纹：只用于判断“画面是否发生了大的变化”。 */
function screenFingerprint(dataUrl: string): string | null {
  try {
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) return null;
    const size = image.getSize();
    if (size.width <= 0 || size.height <= 0) return null;
    // 去掉底部约 8% 的任务栏（时钟每分钟变化会干扰比较）。
    const cropHeight = Math.max(
      1,
      Math.round(size.height - Math.min(72, size.height * 0.08)),
    );
    const cropped = image.crop({
      x: 0,
      y: 0,
      width: size.width,
      height: cropHeight,
    });
    const small = cropped.resize({ width: 32, height: 18, quality: "good" });
    const bitmap = small.toBitmap();
    const gray: number[] = [];
    for (let i = 0; i + 3 < bitmap.length; i += 4) {
      // BGRA
      gray.push(bitmap[i] * 0.114 + bitmap[i + 1] * 0.587 + bitmap[i + 2] * 0.299);
    }
    if (gray.length === 0) return null;
    const average = gray.reduce((sum, value) => sum + value, 0) / gray.length;
    return gray.map((value) => (value >= average ? "1" : "0")).join("");
  } catch {
    return null;
  }
}

function fingerprintDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) distance += 1;
  }
  return distance;
}

function pointerDistance(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function notifyPaused(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send("pet:commentary-paused", PAUSE_TIP);
    } catch {
      // 窗口正在销毁时忽略。
    }
  }
}

/**
 * 前台全屏窗口优先，其次鼠标所在屏幕。
 * 由模型判断画面有没有实质变化；连续 3 轮 [[SAME]] 后暂停，
 * 画面大幅变化或鼠标移动后自动恢复。
 */
export async function runCommentary(character?: string): Promise<CommentaryRunResult> {
  if (chatService.isWindowActive()) {
    // 聊天窗口聚焦时暂停，避免和正在进行的对话叠在一起。
    return { ok: false, skipped: true, reason: "busy" };
  }

  // 睡着时不截图、不调用模型；只回 zzZ。
  if (await chatService.isSleeping()) {
    return { ok: false, skipped: true, reason: "sleeping", reply: "zzZ" };
  }

  const activeIndex = await getActiveFullscreenDisplayIndex();
  const displays = sortedDisplays();
  const display =
    activeIndex !== null && displays[activeIndex]
      ? displays[activeIndex]
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const shot = await captureDisplay(String(display.id));
  if (!shot) return { ok: false, error: "屏幕截图失败。" };

  const fingerprint = screenFingerprint(shot.dataUrl);
  const cursor = screen.getCursorScreenPoint();

  if (paused) {
    const moved =
      pauseCursor !== null &&
      pointerDistance(cursor, pauseCursor) > RESUME_POINTER_PX;
    const changed =
      fingerprint !== null &&
      pauseFingerprint !== null &&
      fingerprintDistance(fingerprint, pauseFingerprint) >
        RESUME_FINGERPRINT_DISTANCE;
    if (!moved && !changed) {
      return { ok: false, skipped: true, reason: "stalled" };
    }
    // 用户回来了，或者画面发生了明显变化：重新开始点评。
    paused = false;
    sameRounds = 0;
    pauseFingerprint = null;
    pauseCursor = null;
    console.info("[commentary] 画面或鼠标有变化，恢复点评");
  }

  const reply = await chatService.sendCommentary(PROMPT, shot, character);
  if (reply.sleeping) {
    return { ok: false, skipped: true, reason: "sleeping", reply: "zzZ" };
  }
  if (!reply.text) return { ok: false, error: "没有收到点评。" };

  if (isCommentarySameReply(reply.text)) {
    sameRounds += 1;
    if (sameRounds >= SAME_REPLY_LIMIT) {
      paused = true;
      pauseFingerprint = fingerprint;
      pauseCursor = cursor;
      notifyPaused();
      console.info("[commentary] 连续 3 轮画面没变化，暂停点评");
      return {
        ok: false,
        skipped: true,
        reason: "stalled",
        paused: true,
      };
    }
    return { ok: false, skipped: true, reason: "same" };
  }

  sameRounds = 0;
  const text = normalizeCommentary(reply.text);
  if (!text) return { ok: false, error: "点评内容为空。" };
  return { ok: true, text };
}

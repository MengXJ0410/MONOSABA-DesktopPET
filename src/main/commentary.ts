import { app, BrowserWindow, screen } from "electron";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  CommentaryAttempt,
  CommentaryDiagnostics,
  CommentaryRunResult,
} from "../shared/types";
import { getActiveFullscreenDisplayIndex } from "./active-window";
import { captureDisplay, sortedDisplays } from "./chat/capture";
import { chatService } from "./chat/service";
import { isCommentarySameReply } from "./commentary-marker";
import { normalizeCommentary } from "./commentary-text";
import { fingerprintDistance, screenFingerprint } from "./screen-fingerprint";

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
/** 截图偶发失败时重试一次，避免一整轮点评白白错过。 */
const CAPTURE_RETRY_DELAY_MS = 700;

let sameRounds = 0;
let paused = false;
let pauseFingerprint: string | null = null;
let pauseCursor: { x: number; y: number } | null = null;

let nextRunAt = 0;
let attempts = 0;
let lastAt = 0;
let lastOk = false;
let lastReason: string | undefined;
let lastDetail: string | undefined;
let lastDurationMs = 0;
let lastText: string | undefined;
/** 最近一轮截图耗时，用来确认截屏没有拖慢点评。 */
let lastCaptureMs = 0;
const history: CommentaryAttempt[] = [];

/** 重新开启点评、修改间隔或导入设置时，清掉暂停判断，重新观察。 */
export function resetCommentaryWatch(): void {
  sameRounds = 0;
  paused = false;
  pauseFingerprint = null;
  pauseCursor = null;
}

/** 渲染层排下一轮定时器时同步过来，设置面板据此显示“下次点评”。 */
export function noteCommentarySchedule(at: number): void {
  nextRunAt = Number.isFinite(at) && at > 0 ? at : 0;
}

export function getCommentaryDiagnostics(): CommentaryDiagnostics {
  const conversation = chatService.getConversationState();
  return {
    attempts,
    lastAt,
    lastOk,
    lastReason,
    lastDetail,
    lastDurationMs,
    lastText,
    sameRounds,
    paused,
    nextAt: nextRunAt,
    lastCaptureMs,
    chatWindowActive: conversation.windowActive,
    chatLastActivityAt: conversation.lastActivityAt,
    history: [...history],
  };
}

/** 记录到 userData/logs/commentary.log，超过 512KB 时轮换一次。 */
async function appendLog(line: string): Promise<void> {
  try {
    const dir = join(app.getPath("userData"), "logs");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "commentary.log");
    try {
      const info = await stat(file);
      if (info.size > 512 * 1024) {
        await rename(file, join(dir, "commentary.1.log"));
      }
    } catch {
      // 文件还不存在。
    }
    await appendFile(file, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    // 日志失败不影响点评。
  }
}

function record(result: CommentaryRunResult, startedAt: number, detail?: string): CommentaryRunResult {
  const durationMs = Date.now() - startedAt;
  const reason = result.ok ? undefined : result.reason ?? "error";
  const isJump = !result.ok && result.skipped === true;
  attempts += 1;
  lastAt = Date.now();
  lastOk = result.ok;
  lastReason = reason;
  lastDetail = detail ?? (result.ok ? undefined : result.error);
  lastDurationMs = durationMs;
  if (result.ok) lastText = result.text.slice(0, 60);
  const attempt: CommentaryAttempt = {
    at: lastAt,
    ok: result.ok,
    reason,
    durationMs,
    detail: lastDetail,
  };
  history.unshift(attempt);
  if (history.length > 8) history.length = 8;
  const summary = result.ok
    ? `ok ${durationMs}ms capture=${lastCaptureMs}ms "${result.text.slice(0, 40)}"`
    : `${isJump ? "skip" : "fail"} ${reason ?? "error"} ${durationMs}ms capture=${lastCaptureMs}ms ${
        lastDetail ?? ""
      }`;
  void appendLog(summary);
  return result;
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 前台全屏窗口优先，其次鼠标所在屏幕。
 * 由模型判断画面有没有实质变化；连续 3 轮 [[SAME]] 后暂停，
 * 画面大幅变化或鼠标移动后自动恢复。
 */
export async function runCommentary(character?: string): Promise<CommentaryRunResult> {
  const startedAt = Date.now();
  lastCaptureMs = 0;
  try {
    return await runCommentaryOnce(character, startedAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return record({ ok: false, error: `点评失败：${message}` }, startedAt, message);
  }
}

async function runCommentaryOnce(
  character: string | undefined,
  startedAt: number,
): Promise<CommentaryRunResult> {
  if (chatService.isConversationBusy()) {
    // 用户正在聊天窗口里输入或刚发过消息时暂停，避免和进行中的对话叠在一起。
    return record({ ok: false, skipped: true, reason: "busy" }, startedAt, "聊天窗口使用中");
  }

  // 睡着时不截图、不调用模型；只回 zzZ。
  if (await chatService.isSleeping()) {
    return record(
      { ok: false, skipped: true, reason: "sleeping", reply: "zzZ" },
      startedAt,
    );
  }

  const activeIndex = await getActiveFullscreenDisplayIndex();
  const displays = sortedDisplays();
  const display =
    activeIndex !== null && displays[activeIndex]
      ? displays[activeIndex]
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

  const captureStarted = Date.now();
  let shot = await captureDisplay(String(display.id));
  if (!shot) {
    // 偶发失败（例如全屏游戏切换瞬间）重试一次，别直接浪费一整轮。
    await sleep(CAPTURE_RETRY_DELAY_MS);
    shot = await captureDisplay(String(display.id));
  }
  lastCaptureMs = Date.now() - captureStarted;
  if (!shot) {
    return record(
      { ok: false, error: "屏幕截图失败。" },
      startedAt,
      `截图失败 display=${display.id}`,
    );
  }

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
      return record({ ok: false, skipped: true, reason: "stalled" }, startedAt);
    }
    // 用户回来了，或者画面发生了明显变化：重新开始点评。
    paused = false;
    sameRounds = 0;
    pauseFingerprint = null;
    pauseCursor = null;
    console.info("[commentary] 画面或鼠标有变化，恢复点评");
    void appendLog("resume: 画面或鼠标有变化");
  }

  const reply = await chatService.sendCommentary(PROMPT, shot, character);
  if (reply.sleeping) {
    return record(
      { ok: false, skipped: true, reason: "sleeping", reply: "zzZ" },
      startedAt,
    );
  }
  if (!reply.text) {
    return record(
      { ok: false, error: "没有收到点评。" },
      startedAt,
      "请求已发出但没有等到回复",
    );
  }

  if (isCommentarySameReply(reply.text)) {
    sameRounds += 1;
    if (sameRounds >= SAME_REPLY_LIMIT) {
      paused = true;
      pauseFingerprint = fingerprint;
      pauseCursor = cursor;
      notifyPaused();
      console.info("[commentary] 连续 3 轮画面没变化，暂停点评");
      void appendLog("pause: 连续 3 轮画面没变化");
      return record(
        {
          ok: false,
          skipped: true,
          reason: "stalled",
          paused: true,
        },
        startedAt,
      );
    }
    return record({ ok: false, skipped: true, reason: "same" }, startedAt);
  }

  sameRounds = 0;
  const text = normalizeCommentary(reply.text);
  if (!text) {
    return record({ ok: false, error: "点评内容为空。" }, startedAt, "点评内容为空");
  }
  return record({ ok: true, text }, startedAt);
}

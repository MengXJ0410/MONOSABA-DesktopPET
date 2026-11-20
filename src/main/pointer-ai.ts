import { app, BrowserWindow } from "electron";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  PointerAiAction,
  PointerAiSettings,
  PointerAiSkipReason,
  PointerAiState,
} from "../shared/types";
import { captureDisplayForPointer } from "./chat/capture";
import { requestPointer } from "./chat/client";
import { chatService } from "./chat/service";
import { resolveObservationDisplay } from "./screen-target";
import { fingerprintDistance, screenFingerprint } from "./screen-fingerprint";
import { getMainWindow } from "./window";

/**
 * AI 指针：本地看、模型想、渲染层动。
 *
 * 每 N 秒截一张压缩小图，只在画面指纹明显变化时才调用模型；
 * 空闲时 0 token。模型返回的坐标是相对截图的比例，这里换算成
 * 虚拟桌面 DIP 坐标后交给桌宠渲染层缓动。
 */

export const POINTER_AI_INTERVAL_MIN = 1;
export const POINTER_AI_INTERVAL_MAX = 30;
export const POINTER_AI_INTERVAL_DEFAULT = 10;
export const POINTER_AI_DAILY_LIMIT = 500;
/** 32×18 = 576 位；不同位超过约 8% 才算画面真的变了。 */
const CHANGE_THRESHOLD = 48;

let settings: PointerAiSettings = {
  intervalSec: POINTER_AI_INTERVAL_DEFAULT,
  dailyLimit: POINTER_AI_DAILY_LIMIT,
};
let enabled = false;
let timer: ReturnType<typeof setTimeout> | null = null;
/** 每次启停自增；在途请求回来时用它判断结果是否已经过期。 */
let generation = 0;
/** 同一时刻只允许一轮观察（定时器 / 立即观察 / 聊天触发共用）。 */
let observing = false;
/** 聊天刚发过消息时暂存的原话；下一轮观察带上它。 */
let chatHint: string | null = null;
let chatHintTimer: ReturnType<typeof setTimeout> | null = null;
let chatHintRetries = 0;

let lastFingerprint: string | null = null;
let lastDisplayId: string | null = null;
let lastObserveAt = 0;
let lastModelAt = 0;
let lastAction: PointerAiAction | null = null;
let lastSkip: PointerAiSkipReason | undefined;
let lastSkipDetail: string | undefined;
let lastCaptureBytes = 0;
let lastCaptureMs = 0;
let lastDurationMs = 0;

let dayKey = "";
let todayCalls = 0;
let actionSeq = 0;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function localDayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

function rolloverDay(): void {
  const key = localDayKey();
  if (key === dayKey) return;
  dayKey = key;
  todayCalls = 0;
}

export function getPointerAiState(): PointerAiState {
  rolloverDay();
  return {
    running: enabled && timer !== null,
    intervalSec: settings.intervalSec,
    dailyLimit: settings.dailyLimit,
    todayCalls,
    lastObserveAt,
    lastModelAt,
    lastAction,
    lastSkip,
    lastSkipDetail,
    lastCaptureBytes,
    lastCaptureMs,
    lastDurationMs,
  };
}

function broadcast(): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send("pointer:ai:state", getPointerAiState());
  } catch {
    // 窗口正在销毁时忽略。
  }
}

function sendControl(control: {
  x: number;
  y: number;
  durationMs: number;
  holdMs: number;
  seq: number;
}): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send("pointer:control", { mode: "external", ...control });
  } catch {
    // 窗口正在销毁时忽略。
  }
}

/** 记录到 userData/logs/pointer-ai.log，超过 512KB 时轮换一次。 */
async function appendLog(line: string): Promise<void> {
  try {
    const dir = join(app.getPath("userData"), "logs");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "pointer-ai.log");
    try {
      const info = await stat(file);
      if (info.size > 512 * 1024) {
        await rename(file, join(dir, "pointer-ai.1.log"));
      }
    } catch {
      // 文件还不存在。
    }
    await appendFile(file, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    // 日志失败不影响观察。
  }
}

function markSkip(
  reason: PointerAiSkipReason,
  startedAt: number,
  detail?: string,
): void {
  lastSkip = reason;
  lastSkipDetail = detail;
  lastDurationMs = Date.now() - startedAt;
  broadcast();
  void appendLog(
    `skip ${reason} ${lastDurationMs}ms capture=${lastCaptureMs}ms ${detail ?? ""}`,
  );
}

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function schedule(delayMs?: number): void {
  clearTimer();
  if (!enabled) return;
  const delay =
    delayMs ?? Math.max(POINTER_AI_INTERVAL_MIN, settings.intervalSec) * 1000;
  timer = setTimeout(() => {
    timer = null;
    void tick();
  }, delay);
}

async function tick(): Promise<void> {
  const gen = generation;
  if (observing) return;
  observing = true;
  try {
    await observe(gen, false);
  } catch (error) {
    markSkip("error", Date.now(), error instanceof Error ? error.message : String(error));
  } finally {
    observing = false;
  }
  if (gen !== generation || !enabled) return;
  // 上一轮分析结束后再等 N 秒，模型慢的时候不会堆叠请求。
  schedule();
}

/**
 * 她刚在桌面聊天里说了一句话：稍等一下就让指针看她一眼。
 *
 * 这样「把指针移到右下角」不会拖到下一个 10 秒周期才执行；
 * hint 直接带给模型，也不用等 AstrBot 会话历史落盘。
 */
export function noteChatMessage(text: string): void {
  const value = text.trim();
  if (!enabled || !value) return;
  if (value.startsWith("/")) return;
  chatHint = value.slice(0, 500);
  chatHintRetries = 0;
  scheduleChatObserve(1200);
}

function scheduleChatObserve(delayMs: number): void {
  if (chatHintTimer !== null) clearTimeout(chatHintTimer);
  const gen = generation;
  chatHintTimer = setTimeout(() => {
    chatHintTimer = null;
    if (gen !== generation || !enabled || !chatHint) return;
    void runChatObserve(gen);
  }, delayMs);
}

async function runChatObserve(gen: number): Promise<void> {
  if (observing) {
    // 正在跑定时观察：等它结束再说，最多重试 6 次。
    chatHintRetries += 1;
    if (chatHintRetries <= 6 && gen === generation && enabled) {
      scheduleChatObserve(1500);
    } else {
      chatHint = null;
    }
    return;
  }
  const hint = chatHint ?? undefined;
  observing = true;
  try {
    await observe(gen, true, hint);
    chatHint = null;
  } catch (error) {
    markSkip("error", Date.now(), error instanceof Error ? error.message : String(error));
  } finally {
    observing = false;
  }
}

/**
 * 跑一轮观察。
 * @param force 忽略指纹变化判定（「立即观察一次」/ 聊天刚发过消息时用）。
 * @param hint 用户刚在桌面聊天里说的话，直接塞给模型，不用等会话历史落盘。
 */
async function observe(gen: number, force: boolean, hint?: string): Promise<void> {
  const startedAt = Date.now();
  lastCaptureMs = 0;
  lastCaptureBytes = 0;
  if (!enabled || gen !== generation) return;

  // 睡着时不截图、不调用模型。
  if (await chatService.isSleeping()) {
    markSkip("sleeping", startedAt);
    return;
  }

  const display = await resolveObservationDisplay();
  const displayId = String(display.id);

  const captureStarted = Date.now();
  const shot = await captureDisplayForPointer(displayId);
  lastCaptureMs = Date.now() - captureStarted;
  if (gen !== generation || !enabled) return;
  if (!shot) {
    markSkip("capture", startedAt, `截图失败 display=${displayId}`);
    return;
  }
  lastCaptureBytes = Math.round(shot.base64.length * 0.75);

  const fingerprint = screenFingerprint(shot.dataUrl);
  if (!fingerprint) {
    markSkip("capture", startedAt, "指纹生成失败");
    return;
  }

  const distance =
    lastFingerprint === null ? Number.MAX_SAFE_INTEGER : fingerprintDistance(fingerprint, lastFingerprint);
  const changed =
    force ||
    lastFingerprint === null ||
    lastDisplayId !== displayId ||
    distance > CHANGE_THRESHOLD;

  lastFingerprint = fingerprint;
  lastDisplayId = displayId;
  lastObserveAt = Date.now();

  if (!changed) {
    markSkip("unchanged", startedAt, `distance=${distance}`);
    return;
  }

  rolloverDay();
  if (todayCalls >= settings.dailyLimit) {
    markSkip("budget", startedAt, `${todayCalls}/${settings.dailyLimit}`);
    return;
  }

  todayCalls += 1;
  lastModelAt = Date.now();
  const result = await requestPointer(
    shot.base64,
    {
      width: display.bounds.width,
      height: display.bounds.height,
    },
    force ? hint : undefined,
  );
  if (gen !== generation || !enabled) return;

  if (!result.ok) {
    markSkip(
      result.kind === "offline" ? "offline" : "error",
      startedAt,
      result.error,
    );
    return;
  }

  const raw = result.data?.action ?? null;
  if (!raw) {
    markSkip("no-action", startedAt, `distance=${distance}`);
    return;
  }

  const nx = clamp(Number(raw.nx), 0, 1);
  const ny = clamp(Number(raw.ny), 0, 1);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
    markSkip("error", startedAt, "模型返回的坐标无效");
    return;
  }

  const durationMs = clamp(
    Math.round(Number(raw.durationMs) || 900),
    120,
    6000,
  );
  const holdMs = clamp(Math.round(Number(raw.holdMs) || 1200), 0, 8000);
  const action: PointerAiAction = {
    kind: "move",
    nx,
    ny,
    durationMs,
    holdMs,
    reason: typeof raw.reason === "string" ? raw.reason.slice(0, 120) : undefined,
  };
  const saySource =
    typeof raw.say === "string" ? raw.say : result.data?.say;
  const say =
    typeof saySource === "string" ? saySource.trim().slice(0, 60) : "";

  actionSeq += 1;
  lastAction = action;
  lastSkip = undefined;
  lastSkipDetail = undefined;
  lastDurationMs = Date.now() - startedAt;
  broadcast();
  sendControl({
    x: display.bounds.x + nx * Math.max(0, display.bounds.width - 1),
    y: display.bounds.y + ny * Math.max(0, display.bounds.height - 1),
    durationMs,
    holdMs,
    seq: actionSeq,
  });
  void appendLog(
    `move ${lastDurationMs}ms capture=${lastCaptureMs}ms ${lastCaptureBytes}B ` +
      `display=${displayId} nx=${nx.toFixed(3)} ny=${ny.toFixed(3)} ` +
      `duration=${durationMs} hold=${holdMs} say="${say}" "${action.reason ?? ""}"`,
  );
}

/** 希罗指针开关。关闭后立刻停表、隐藏浮层；开启后从头观察。 */
export function setPointerAiEnabled(next: boolean): PointerAiState {
  if (enabled === next) return getPointerAiState();
  enabled = next;
  generation += 1;
  if (enabled) {
    // 重新开启时不拿旧画面做对比，第一轮一定调模型。
    lastFingerprint = null;
    lastDisplayId = null;
    schedule();
  } else {
    clearTimer();
    clearChatHint();
  }
  broadcast();
  return getPointerAiState();
}

/** 面板滑杆 / 日上限变化。间隔变化时按新间隔重新排期。 */
export function updatePointerAiSettings(patch: {
  intervalSec?: number;
  dailyLimit?: number;
}): PointerAiState {
  let changed = false;
  if (typeof patch.intervalSec === "number" && Number.isFinite(patch.intervalSec)) {
    const next = Math.round(
      clamp(patch.intervalSec, POINTER_AI_INTERVAL_MIN, POINTER_AI_INTERVAL_MAX),
    );
    if (next !== settings.intervalSec) {
      settings = { ...settings, intervalSec: next };
      changed = true;
    }
  }
  if (typeof patch.dailyLimit === "number" && Number.isFinite(patch.dailyLimit)) {
    const next = Math.max(1, Math.round(patch.dailyLimit));
    if (next !== settings.dailyLimit) {
      settings = { ...settings, dailyLimit: next };
      changed = true;
    }
  }
  if (changed) {
    if (enabled) schedule();
    broadcast();
  }
  return getPointerAiState();
}

/** 「立即观察一次」：忽略指纹判定，但仍受开关、睡眠和日上限约束。 */
export async function observePointerNow(): Promise<PointerAiState> {
  if (!enabled || observing) return getPointerAiState();
  const gen = generation;
  observing = true;
  try {
    await observe(gen, true);
  } catch (error) {
    markSkip("error", Date.now(), error instanceof Error ? error.message : String(error));
  } finally {
    observing = false;
  }
  return getPointerAiState();
}

/** 退出时清理定时器，避免进程退出后还有悬挂的截图任务。 */
export function disposePointerAi(): void {
  enabled = false;
  generation += 1;
  clearTimer();
  clearChatHint();
}

function clearChatHint(): void {
  if (chatHintTimer !== null) {
    clearTimeout(chatHintTimer);
    chatHintTimer = null;
  }
  chatHint = null;
  chatHintRetries = 0;
}

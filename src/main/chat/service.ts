import { app, BrowserWindow, Notification } from "electron";
import { existsSync, promises as fs, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ChatAppearance,
  ChatBackground,
  ChatBackgroundConfig,
  ChatBackgroundPatch,
  ChatCommand,
  ChatCommandsData,
  ChatFontScale,
  ChatInitialData,
  ChatLineHeight,
  ChatMessage,
  ChatPollData,
  ChatProfileData,
  ChatQuote,
  ChatRetractResult,
  ChatSendData,
  ChatSkillsData,
  ChatStatus,
  ChatStatusData,
  ChatStorageInfo,
  ChatStorageResult,
  ChatTheme,
  ChatThemePreset,
  ChatTypewriterSettings,
  ChatUiConfig,
  ChatUiMode,
  ChatUiState,
  BubbleSettings,
  FontPreset,
  MessageFont,
} from "../../shared/types";
import { readConfig, updateBubble, updateChatUi } from "../config";
import { isCommentarySameReply } from "../commentary-marker";
import { normalizeCommentary } from "../commentary-text";
import { profileStore } from "../profile";
import { backgroundStore } from "./background";
import { captureDisplay } from "./capture";
import {
  bootstrapChat,
  loadChatStatus,
  loadCommands,
  loadSkills,
  pollMessages,
  retractMessage,
  sendMessage,
} from "./client";
import { MediaCache } from "./media";
import { ChatStore, normalizeMessage } from "./store";
import type { CapturedScreen } from "./capture";

const CACHE_MAX_BYTES = 500 * 1024 * 1024;
const STATUS_CACHE_MS = 3000;
const COMMANDS_CACHE_MS = 10 * 60_000;
const SKILLS_CACHE_MS = 15_000;
const NOTIFY_DEBOUNCE_MS = 2200;
/** 聊天窗口聚焦后，多久没有输入就允许点评恢复。 */
const CONVERSATION_BUSY_MS = 120_000;

const DEFAULT_THEME: ChatTheme = { mode: "night", accent: "#c8102e", presetId: "hiro" };
const DEFAULT_THEME_PRESETS: ChatThemePreset[] = [
  { id: "hiro", name: "希罗", mode: "night", accent: "#c8102e", builtin: true },
];
const DEFAULT_APPEARANCE: ChatAppearance = {
  theme: DEFAULT_THEME,
  themePresets: DEFAULT_THEME_PRESETS,
  fontScale: "md",
  lineHeight: "normal",
  messageFont: {
    bold: false,
    color: "",
    stroke: false,
    strokeWidth: 1,
    strokeColor: "#000000",
    shadow: false,
    shadowBlur: 4,
    shadowColor: "#000000",
  },
  typewriter: { enabled: true, charsPerSecond: 25 },
  fontPresets: [],
};
const DEFAULT_BACKGROUND: ChatBackground = {
  chatOpacity: null,
  panelOpacity: 92,
  extend: false,
};
const DEFAULT_PROFILE: ChatProfileData = {
  hiro: { role: "hiro", name: "希罗", avatar: null },
  me: { role: "me", name: "我", avatar: null },
};

const FALLBACK_COMMANDS: ChatCommand[] = [
  {
    name: "/心情",
    aliases: [],
    description: "查看希罗现在的心情（管理员）",
    permission: "admin",
    plugin: "内置",
    dangerous: false,
    subcommands: [],
  },
  {
    name: "/好感",
    aliases: [],
    description: "查看好感度（管理员）",
    permission: "admin",
    plugin: "内置",
    dangerous: false,
    subcommands: [],
  },
  {
    name: "/记忆 状态",
    aliases: [],
    description: "查看记忆插件状态（管理员）",
    permission: "admin",
    plugin: "内置",
    dangerous: false,
    subcommands: [],
  },
  {
    name: "/记忆 检索",
    aliases: [],
    description: "检索长期记忆（管理员）",
    permission: "admin",
    plugin: "内置",
    dangerous: false,
    subcommands: [],
  },
  {
    name: "/help",
    aliases: [],
    description: "查看 AstrBot 指令帮助",
    permission: "everyone",
    plugin: "内置",
    dangerous: false,
    subcommands: [],
  },
  {
    name: "/stats",
    aliases: [],
    description: "查看当前会话的 token 统计",
    permission: "everyone",
    plugin: "内置",
    dangerous: false,
    subcommands: [],
  },
  {
    name: "/reset",
    aliases: [],
    description: "清空当前会话上下文",
    permission: "admin",
    plugin: "内置",
    dangerous: true,
    subcommands: [],
  },
  {
    name: "/new",
    aliases: [],
    description: "创建一个新会话",
    permission: "admin",
    plugin: "内置",
    dangerous: true,
    subcommands: [],
  },
  {
    name: "/provider",
    aliases: [],
    description: "查看或切换 LLM Provider",
    permission: "admin",
    plugin: "内置",
    dangerous: true,
    subcommands: [],
  },
  {
    name: "/persona",
    aliases: [],
    description: "查看或切换人格",
    permission: "admin",
    plugin: "内置",
    dangerous: true,
    subcommands: [],
  },
];

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      // 窗口正在销毁时忽略。
    }
  }
}

function statusFromError(kind: string, error: string): ChatStatus {
  if (kind === "auth") return { state: "auth", detail: error };
  if (kind === "server" && error.includes("未安装")) {
    return { state: "bridge-missing", detail: error };
  }
  return { state: "offline", detail: error };
}

function onlineStatus(qqConnected: boolean): ChatStatus {
  return qqConnected ? { state: "online" } : { state: "qq-offline" };
}

function notificationIcon(): string {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, "icon.png")]
    : [join(app.getAppPath(), "build", "icon.png")];
  return candidates.find((path) => existsSync(path)) ?? "";
}

function compactText(messages: ChatMessage[], limit = 180): string {
  const text = messages
    .map((message) => {
      if (message.text.trim()) return message.text.trim();
      if (message.attachments?.length) return "[图片]";
      if (message.image) return "[图片]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

function pickAppearance(ui: ChatUiConfig): ChatAppearance {
  return {
    theme: ui.theme,
    themePresets: ui.themePresets,
    fontScale: ui.fontScale,
    lineHeight: ui.lineHeight,
    messageFont: ui.messageFont,
    typewriter: ui.typewriter,
    fontPresets: ui.fontPresets,
  };
}

function toBackground(config: ChatBackgroundConfig): ChatBackground {
  return {
    chatOpacity: config.chatOpacity,
    panelOpacity: config.panelOpacity,
    extend: config.extend,
  };
}

async function fileSize(path: string): Promise<number> {
  try {
    const stat = await fs.stat(path);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

async function dirSize(path: string): Promise<number> {
  let total = 0;
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await dirSize(child);
    else total += await fileSize(child);
  }
  return total;
}

async function copyFileIfExists(from: string, to: string): Promise<void> {
  try {
    await fs.copyFile(from, to);
  } catch {
    // 源文件不存在时跳过。
  }
}

async function copyDir(from: string, to: string): Promise<void> {
  try {
    await fs.cp(from, to, { recursive: true });
  } catch {
    // 缩略图目录不存在时跳过。
  }
}

export class ChatService {
  private store: ChatStore | null = null;
  private media: MediaCache | null = null;
  private ui: ChatUiState = {
    mode: "compact",
    pinned: false,
    unread: 0,
    notifications: true,
    ...DEFAULT_APPEARANCE,
    background: DEFAULT_BACKGROUND,
  };
  private profile: ChatProfileData = DEFAULT_PROFILE;
  private backgroundImage: string | null = null;
  private uiConfig: ChatUiConfig | null = null;
  private status: ChatStatus = { state: "offline", detail: "正在连接……" };
  private commands: ChatCommandsData = {
    commands: FALLBACK_COMMANDS,
    source: "fallback",
    generatedAt: 0,
  };
  private commandsFetchedAt = 0;
  private skillsCache: ChatSkillsData | null = null;
  private skillsFetchedAt = 0;
  private moodCache: ChatStatusData | null = null;
  private moodFetchedAt = 0;
  private windowActive = false;
  /** 最近一次用户在聊天窗口里活动（聚焦、输入、发送）的时间。 */
  private lastChatActivityAt = 0;
  /** 最近一次发送消息的时间。 */
  private lastChatSendAt = 0;
  /** 希罗指针是否可用：可用时桌面消息会带上「你能操控第二指针」的提示。 */
  private pointerCapable = false;
  private bootstrapped = false;
  private bootstrapInFlight = false;
  private pollInFlight = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private bootstrapRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingNotify: ChatMessage[] = [];
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private unreadListener: ((unread: number) => void) | null = null;
  private openChatListener: (() => void) | null = null;
  private replyListeners = new Set<(message: ChatMessage) => void>();
  /** 点评轮次的自增序号，保证每轮气泡能按 roundId 归并。 */
  private commentaryRoundSeq = 0;
  /** 屏幕点评的回复：照常进聊天，但不加未读、不弹通知。 */
  private silentReplyIds = new Set<number>();
  private started = false;
  private lastCursor = 0;
  private lastEpoch = "";
  private lastQqConnected = false;
  /** 桥接插件在 /bootstrap 里声明的能力；旧桥接没有 retract 时桌面隐藏撤回。 */
  private bridgeCapabilities = new Set<string>();

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const config = await readConfig();
    this.uiConfig = config.chat.ui;
    this.ui = {
      mode: config.chat.ui.mode,
      pinned: config.chat.ui.fullPinned,
      unread: 0,
      notifications: config.chat.ui.notifications,
      ...pickAppearance(config.chat.ui),
      background: toBackground(config.chat.ui.background),
    };

    this.store = new ChatStore(config.chat.ui.cacheDir ?? undefined);
    await this.store.load(
      config.chat.ui.cacheLimit,
      Math.min(config.chat.ui.cacheMaxMb * 1024 * 1024, CACHE_MAX_BYTES),
    );
    this.media = new MediaCache(this.store.thumbsDir);
    this.lastCursor = this.store.getCursor();
    this.lastEpoch = this.store.getEpoch();

    try {
      this.profile = await profileStore.getData();
    } catch (error) {
      console.warn("[chat] load profile failed", error);
    }
    try {
      this.backgroundImage = await backgroundStore.load();
    } catch (error) {
      console.warn("[chat] load background failed", error);
    }

    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, config.chat.pollMs);

    await this.bootstrap();
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.bootstrapRetryTimer) {
      clearTimeout(this.bootstrapRetryTimer);
      this.bootstrapRetryTimer = null;
    }
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    await this.store?.flush();
  }

  setUnreadListener(listener: (unread: number) => void): void {
    this.unreadListener = listener;
    listener(this.ui.unread);
  }

  setOpenChatListener(listener: () => void): void {
    this.openChatListener = listener;
  }

  getUiState(): ChatUiState {
    return { ...this.ui };
  }

  async bootstrap(): Promise<void> {
    if (this.bootstrapInFlight) return;
    this.bootstrapInFlight = true;
    try {
      const result = await bootstrapChat();
      if (!result.ok) {
        this.setStatus(statusFromError(result.kind, result.error));
        this.scheduleBootstrapRetry();
        return;
      }
      const data = result.data;
      const history = Array.isArray(data.history)
        ? data.history
            .map((item) => normalizeMessage({ ...item, id: 0, ts: 0 }))
            .filter((item): item is ChatMessage => item !== null)
        : [];
      const log = Array.isArray(data.messages)
        ? data.messages
            .map((item) => normalizeMessage(item))
            .filter((item): item is ChatMessage => item !== null)
        : [];
      await this.store?.applyBootstrap(
        history,
        log,
        data.cursor ?? 0,
        data.epoch ?? "",
      );
      this.lastCursor = data.cursor ?? 0;
      this.lastEpoch = data.epoch ?? "";
      this.lastQqConnected = data.qqConnected === true;
      if (Array.isArray(data.capabilities)) {
        this.bridgeCapabilities = new Set(
          data.capabilities.filter((item): item is string => typeof item === "string"),
        );
      }
      this.bootstrapped = true;
      this.setStatus(onlineStatus(this.lastQqConnected));
      this.invalidateMood();
      broadcast("chat:reset", this.getInitial());
      if (this.commandsFetchedAt === 0) {
        void this.loadCommands(false);
      }
    } finally {
      this.bootstrapInFlight = false;
    }
  }

  private scheduleBootstrapRetry(): void {
    if (this.bootstrapRetryTimer) return;
    this.bootstrapRetryTimer = setTimeout(() => {
      this.bootstrapRetryTimer = null;
      void this.bootstrap();
    }, 10_000);
  }

  private async pollOnce(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      let guard = 0;
      while (guard < 10) {
        guard += 1;
        const result = await pollMessages(this.lastCursor, 200);
        if (!result.ok) {
          this.setStatus(statusFromError(result.kind, result.error));
          return;
        }
        if (this.consumePoll(result.data)) return;
        if (!result.data.hasMore) break;
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  /** 返回 true 表示桥接日志已重置，本轮需要重新 bootstrap。 */
  private consumePoll(data: ChatPollData): boolean {
    const epoch = typeof data.epoch === "string" ? data.epoch : "";
    if (epoch && this.lastEpoch && epoch !== this.lastEpoch) {
      // 桥接插件重启后日志可能被重置，旧 cursor 不再有效。
      this.lastEpoch = epoch;
      this.lastCursor = 0;
      void this.store?.setCursor(0, epoch);
      void this.bootstrap();
      return true;
    }

    const messages = Array.isArray(data.messages) ? data.messages : [];
    const normalized = messages
      .map((item) => normalizeMessage(item))
      .filter((item): item is ChatMessage => item !== null);

    // 点评的隐藏 [[SAME]] 标记也要通知等待器，但不进入聊天 / 缓存。
    for (const message of normalized) {
      if (message.role !== "assistant") continue;
      for (const listener of this.replyListeners) {
        try {
          listener(message);
        } catch (error) {
          console.warn("[chat] reply listener failed", error);
        }
      }
    }
    const displayable = normalized.filter(
      (message) =>
        !(message.role === "assistant" && isCommentarySameReply(message.text)),
    );

    const hadNew = displayable.length > 0;
    this.lastCursor = Math.max(this.lastCursor, data.cursor ?? 0);
    if (epoch) this.lastEpoch = epoch;
    this.lastQqConnected = data.qqConnected === true;
    this.setStatus(onlineStatus(this.lastQqConnected));

    if (!hadNew) {
      void this.store?.setCursor(this.lastCursor, this.lastEpoch);
      return false;
    }

    void this.store
      ?.append(displayable)
      .then((added) => {
        if (added.length === 0) return;
        this.invalidateMood();
        broadcast("chat:messages", added);
        this.handleUnread(added);
      })
      .catch((error) => console.warn("[chat] append failed", error));

    void this.store?.setCursor(this.lastCursor, this.lastEpoch);
    return false;
  }

  private handleUnread(messages: ChatMessage[]): void {
    const silent = new Set<number>();
    for (const message of messages) {
      if (this.silentReplyIds.delete(message.id)) silent.add(message.id);
    }
    if (!this.bootstrapped) return;
    const replies = messages.filter(
      (message) =>
        message.role === "assistant" &&
        message.pointer !== true &&
        !silent.has(message.id),
    );
    if (replies.length === 0) return;
    if (this.windowActive) {
      this.markRead();
      return;
    }
    this.setUnread(this.ui.unread + replies.length);
    this.queueNotification(replies);
  }

  private queueNotification(messages: ChatMessage[]): void {
    if (!this.ui.notifications) return;
    this.pendingNotify.push(...messages);
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      const pending = this.pendingNotify;
      this.pendingNotify = [];
      if (pending.length === 0 || this.windowActive || this.ui.unread === 0) return;
      if (!Notification.isSupported()) return;
      const body = compactText(pending);
      if (!body) return;
      const notification = new Notification({
        title: "希罗",
        body,
        icon: notificationIcon() || undefined,
        silent: false,
      });
      notification.on("click", () => {
        this.markRead();
        this.openChatListener?.();
      });
      notification.show();
    }, NOTIFY_DEBOUNCE_MS);
  }

  private setUnread(value: number): void {
    const next = Math.max(0, Math.round(value));
    if (next === this.ui.unread) return;
    this.ui = { ...this.ui, unread: next };
    this.unreadListener?.(next);
    broadcast("chat:ui-state", this.getUiState());
  }

  markRead(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    this.pendingNotify = [];
    this.setUnread(0);
  }

  setWindowActive(active: boolean): void {
    this.windowActive = active;
    if (active) {
      this.lastChatActivityAt = Date.now();
      this.markRead();
    }
  }

  /** 聊天窗口里打字、点按钮时调用：点评会避开这段正在对话的时间。 */
  noteChatActivity(): void {
    this.lastChatActivityAt = Date.now();
  }

  /**
   * 随机点评是否该让路。
   * 不再只看“窗口有没有聚焦”——窗口长期开着但没人理时，点评照常进行；
   * 只有聚焦状态下 2 分钟内还有输入 / 发送才跳过。
   */
  isConversationBusy(): boolean {
    if (!this.windowActive) return false;
    const last = Math.max(this.lastChatActivityAt, this.lastChatSendAt);
    return Date.now() - last < CONVERSATION_BUSY_MS;
  }

  /** 供“随机点评”状态显示：窗口是否在用、最近活动时间。 */
  getConversationState(): { windowActive: boolean; lastActivityAt: number } {
    return {
      windowActive: this.windowActive,
      lastActivityAt: Math.max(this.lastChatActivityAt, this.lastChatSendAt),
    };
  }

  private setStatus(status: ChatStatus): void {
    if (
      this.status.state === status.state &&
      this.status.detail === status.detail
    ) {
      return;
    }
    this.status = status;
    broadcast("chat:status", status);
  }

  getInitial(): ChatInitialData {
    return {
      messages: this.store?.getRecent(200) ?? [],
      total: this.store?.total() ?? 0,
      cursor: this.lastCursor,
      qqConnected: this.lastQqConnected,
      status: this.status,
      ui: this.getUiState(),
      commands: this.commands,
      epoch: this.lastEpoch,
      profile: this.profile,
      backgroundImage: this.backgroundImage,
      capabilities: [...this.bridgeCapabilities],
    };
  }

  loadMore(beforeId: number, limit = 200): ChatMessage[] {
    return this.store?.getBefore(beforeId, Math.max(1, Math.min(400, limit))) ?? [];
  }

  async send(
    text: string,
    options: {
      captureScreen?: boolean;
      displayId?: string;
      clientId?: string;
      quote?: ChatQuote | null;
    } = {},
  ): Promise<
    | { ok: true; data: ChatSendData }
    | { ok: false; error: string; kind: "offline" | "auth" | "server" | "unknown" }
  > {
    const value = text.trim();
    if (!value) return { ok: false, kind: "unknown", error: "消息不能为空。" };
    this.lastChatSendAt = Date.now();
    this.lastChatActivityAt = this.lastChatSendAt;

    let screen: CapturedScreen | null = null;
    if (options.captureScreen) {
      try {
        screen = await captureDisplay(options.displayId);
      } catch (error) {
        console.warn("[chat] screen capture failed", error);
      }
    }

    const result = await sendMessage(value, screen?.base64, false, {
      clientId: options.clientId,
      quote: options.quote ?? null,
      pointerEnabled: this.pointerCapable,
    });
    if (!result.ok) {
      this.setStatus(statusFromError(result.kind, result.error));
      return result;
    }

    if (result.data.retracted) {
      // 发送途中已经被撤回：桥接没有写入，也不会注入回合。
      this.setStatus(onlineStatus(this.lastQqConnected));
      return {
        ok: true,
        data: {
          message: null,
          screenImage: screen?.dataUrl ?? null,
          captureFailed: options.captureScreen === true && screen === null,
          retracted: true,
        },
      };
    }

    const message = normalizeMessage(result.data.message);
    if (message) {
      const added = (await this.store?.append([message])) ?? [];
      if (added.length > 0) {
        broadcast("chat:messages", added);
      }
    }
    this.setStatus(onlineStatus(this.lastQqConnected));
    return {
      ok: true,
      data: {
        message: message ?? result.data.message,
        screenImage: screen?.dataUrl ?? null,
        captureFailed: options.captureScreen === true && screen === null,
      },
    };
  }

  /** 撤回一轮桌面消息：桥接中止生成并清理日志 / 会话历史，本地同步删缓存。 */
  async retract(clientId: string): Promise<ChatRetractResult> {
    const result = await retractMessage(clientId);
    if (!result.ok) return result;
    const localRemoved = (await this.store?.removeTurn(clientId)) ?? [];
    const removed = Array.from(
      new Set([...(result.data.removed ?? []), ...localRemoved]),
    );
    broadcast("chat:retract", { turn: clientId, removed });
    return { ok: true, data: { ...result.data, removed } };
  }

  isWindowActive(): boolean {
    return this.windowActive;
  }

  /** 屏幕点评：注入一条带截图的加粗回合，等待希罗的回复文本。 */
  async sendCommentary(
    text: string,
    shot: CapturedScreen,
    character?: string,
  ): Promise<{ text: string | null; sleeping?: boolean }> {
    const roundId = `r${Date.now().toString(36)}-${++this.commentaryRoundSeq}`;
    const waiter = this.waitForAssistantReply(180_000, 8_000, character, roundId);
    const result = await sendMessage(text, shot.base64, true);
    if (!result.ok) {
      waiter.cancel();
      return { text: null };
    }
    if (result.data.sleeping) {
      waiter.cancel();
      return { text: null, sleeping: true };
    }
    return { text: await waiter.promise };
  }

  private waitForAssistantReply(
    timeoutMs: number,
    quietMs: number,
    character?: string,
    roundId = "",
  ): { promise: Promise<string | null>; cancel: () => void } {
    let settled = false;
    const parts: string[] = [];
    let segmentIndex = 0;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let overallTimer: ReturnType<typeof setTimeout> | null = null;
    let resolvePromise: (value: string | null) => void = () => {};

    let listener: (message: ChatMessage) => void = () => {};
    const cleanup = () => {
      this.replyListeners.delete(listener);
      if (quietTimer) clearTimeout(quietTimer);
      if (overallTimer) clearTimeout(overallTimer);
      quietTimer = null;
      overallTimer = null;
    };
    const emit = (text: string, seq: number, final: boolean) => {
      // 气泡只认这条事件：每段到达就上屏，和聊天窗口同一时刻出现；
      // final 只表示这一轮收齐，不再决定何时显示。
      broadcast("chat:commentary", { text, character, roundId, seq, final });
    };
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      emit("", segmentIndex, true);
      resolvePromise(value);
    };

    listener = (message: ChatMessage) => {
      if (message.role !== "assistant") return;
      // QQ 的回复可能同时到达，不能混进屏幕点评。
      if (message.origin && message.origin !== "desktop") return;
      const value = message.text.trim();
      if (!value) return;
      // 心情插件的主动报告不算点评回复。
      if (value.startsWith("【希罗现在的心情")) return;
      if (!isCommentarySameReply(message.text)) {
        this.silentReplyIds.add(message.id);
        parts.push(message.text);
        const segment = normalizeCommentary(message.text);
        if (segment) emit(segment, segmentIndex++, false);
      } else {
        // 隐藏标记只用于判断画面没变，不生成气泡。
        parts.push(message.text);
      }
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(parts.join("").trim() || null), quietMs);
    };
    this.replyListeners.add(listener);
    overallTimer = setTimeout(() => finish(null), timeoutMs);

    const promise = new Promise<string | null>((resolve) => {
      resolvePromise = resolve;
    });
    return { promise, cancel: () => finish(null) };
  }

  async getCommands(force = false): Promise<ChatCommandsData> {
    const fresh = Date.now() - this.commandsFetchedAt < COMMANDS_CACHE_MS;
    if (!force && fresh) return this.commands;
    return this.loadCommands(force);
  }

  private async loadCommands(force: boolean): Promise<ChatCommandsData> {
    if (!force && Date.now() - this.commandsFetchedAt < COMMANDS_CACHE_MS) {
      return this.commands;
    }
    const result = await loadCommands();
    if (result.ok && Array.isArray(result.data.commands)) {
      this.commands = result.data;
      this.commandsFetchedAt = Date.now();
      broadcast("chat:commands", this.commands);
    } else if (this.commands.generatedAt === 0) {
      this.commands = {
        commands: FALLBACK_COMMANDS,
        source: "fallback",
        generatedAt: Date.now(),
      };
    }
    return this.commands;
  }

  async getSkills(force = false): Promise<ChatSkillsData | null> {
    const fresh = Date.now() - this.skillsFetchedAt < SKILLS_CACHE_MS;
    if (!force && fresh && this.skillsCache) return this.skillsCache;
    const result = await loadSkills();
    this.skillsFetchedAt = Date.now();
    if (!result.ok) {
      // 失败时保留上一次内容，面板会显示错误 / 继续展示旧数据。
      return this.skillsCache;
    }
    this.skillsCache = result.data;
    return this.skillsCache;
  }

  async getMoodStatus(force = false): Promise<ChatStatusData> {
    const fresh = Date.now() - this.moodFetchedAt < STATUS_CACHE_MS;
    if (!force && fresh && this.moodCache) return this.moodCache;
    const result = await loadChatStatus();
    this.moodFetchedAt = Date.now();
    if (!result.ok) {
      this.moodCache = {
        available: false,
        error: result.error,
      };
      return this.moodCache;
    }
    this.moodCache = result.data;
    return this.moodCache;
  }

  /** 主私聊是否在睡眠；读不到时 fail-open（返回 false）。 */
  async isSleeping(): Promise<boolean> {
    const status = await this.getMoodStatus(false);
    return status.sleeping === true;
  }

  /** 希罗指针是否可用；由桌宠渲染层同步过来，只影响发送时注入的能力提示。 */
  setPointerCapable(enabled: boolean): void {
    this.pointerCapable = enabled;
  }

  private invalidateMood(): void {
    this.moodCache = null;
    this.moodFetchedAt = 0;
  }

  async getMedia(
    media: string,
    kind: "thumb" | "original",
  ): Promise<
    | { ok: true; dataUrl: string; mime: string }
    | { ok: false; error: string }
  > {
    if (!this.media) return { ok: false, error: "聊天缓存还没准备好。" };
    return this.media.get(media, kind);
  }

  async setMode(
    mode: ChatUiMode,
    options: { broadcast?: boolean } = {},
  ): Promise<ChatUiState> {
    const next = await updateChatUi({ mode });
    this.uiConfig = next;
    this.ui = { ...this.ui, mode: next.mode };
    if (options.broadcast !== false) this.broadcastUiState();
    return this.getUiState();
  }

  /** 窗口切换成功后再广播，旧窗口不会提前收到新布局。 */
  broadcastUiState(): void {
    broadcast("chat:ui-state", this.getUiState());
  }

  async setPinned(pinned: boolean): Promise<ChatUiState> {
    const next = await updateChatUi({ fullPinned: pinned });
    this.uiConfig = next;
    this.ui = { ...this.ui, pinned: next.fullPinned };
    broadcast("chat:ui-state", this.getUiState());
    return this.getUiState();
  }

  async setNotifications(enabled: boolean): Promise<ChatUiState> {
    const next = await updateChatUi({ notifications: enabled });
    this.uiConfig = next;
    this.ui = { ...this.ui, notifications: next.notifications };
    broadcast("chat:ui-state", this.getUiState());
    return this.getUiState();
  }

  getUiConfig(): ChatUiConfig {
    return this.uiConfig ?? {
      mode: "compact",
      compactBounds: null,
      fullBounds: null,
      fullPinned: false,
      notifications: true,
      cacheLimit: 20_000,
      cacheMaxMb: 500,
      cacheDir: ChatStore.defaultDir(),
      ...DEFAULT_APPEARANCE,
      background: { ...DEFAULT_BACKGROUND, image: null },
    };
  }

  async setTheme(theme: ChatTheme): Promise<ChatUiState> {
    const next = await updateChatUi({ theme });
    this.uiConfig = next;
    this.ui = { ...this.ui, theme: next.theme };
    broadcast("chat:ui-state", this.getUiState());
    return this.getUiState();
  }

  async setFontScale(fontScale: ChatFontScale): Promise<ChatUiState> {
    const next = await updateChatUi({ fontScale });
    this.uiConfig = next;
    this.ui = { ...this.ui, fontScale: next.fontScale };
    broadcast("chat:ui-state", this.getUiState());
    return this.getUiState();
  }

  async setLineHeight(lineHeight: ChatLineHeight): Promise<ChatUiState> {
    const next = await updateChatUi({ lineHeight });
    this.uiConfig = next;
    this.ui = { ...this.ui, lineHeight: next.lineHeight };
    broadcast("chat:ui-state", this.getUiState());
    return this.getUiState();
  }

  async setMessageFont(patch: Partial<MessageFont>): Promise<ChatUiState> {
    const current = this.getUiConfig();
    const messageFont = { ...current.messageFont, ...patch };
    const next = await updateChatUi({ messageFont });
    this.uiConfig = next;
    this.ui = { ...this.ui, messageFont: next.messageFont };
    broadcast("chat:ui-state", this.getUiState());
    return this.getUiState();
  }

  async setTypewriter(
    patch: Partial<ChatTypewriterSettings>,
  ): Promise<ChatUiState> {
    const current = this.getUiConfig();
    const typewriter = { ...current.typewriter, ...patch };
    const next = await updateChatUi({ typewriter });
    this.uiConfig = next;
    this.ui = { ...this.ui, typewriter: next.typewriter };
    broadcast("chat:ui-state", this.getUiState());
    return this.getUiState();
  }

  /** 导入设置或批量改动后，从 config.json 重新读一遍 UI 并广播。 */
  async reloadUi(): Promise<ChatUiState> {
    const config = await readConfig();
    this.uiConfig = config.chat.ui;
    this.ui = {
      mode: config.chat.ui.mode,
      pinned: config.chat.ui.fullPinned,
      unread: this.ui.unread,
      notifications: config.chat.ui.notifications,
      ...pickAppearance(config.chat.ui),
      background: toBackground(config.chat.ui.background),
    };
    broadcast("chat:ui-state", this.getUiState());
    return this.getUiState();
  }

  async saveFontPreset(name: string): Promise<ChatUiState> {
    const label = name.trim().slice(0, 12);
    if (!label) throw new Error("预设名称不能为空。");
    const current = this.getUiConfig();
    if (current.fontPresets.length >= 10) {
      throw new Error("字体预设最多 10 个，先删掉一个吧。");
    }
    const bubble = (await readConfig()).bubble;
    const preset: FontPreset = {
      id: `f-${Date.now().toString(36)}`,
      name: label,
      messageFont: { ...current.messageFont },
      bubble: {
        fontSize: bubble.fontSize,
        opacity: bubble.opacity,
        position: bubble.position,
        maxWidth: bubble.maxWidth,
        plainText: bubble.plainText,
        indent: bubble.indent,
        font: { ...bubble.font },
      },
    };
    const next = await updateChatUi({
      fontPresets: [...current.fontPresets, preset],
    });
    this.uiConfig = next;
    this.ui = { ...this.ui, fontPresets: next.fontPresets };
    broadcast("chat:ui-state", this.getUiState());
    return this.getUiState();
  }

  async deleteFontPreset(id: string): Promise<ChatUiState> {
    const current = this.getUiConfig();
    if (!current.fontPresets.some((preset) => preset.id === id)) {
      throw new Error("这个字体预设已经不在了。");
    }
    const next = await updateChatUi({
      fontPresets: current.fontPresets.filter((preset) => preset.id !== id),
    });
    this.uiConfig = next;
    this.ui = { ...this.ui, fontPresets: next.fontPresets };
    broadcast("chat:ui-state", this.getUiState());
    return this.getUiState();
  }

  async applyFontPreset(
    id: string,
  ): Promise<{ state: ChatUiState; bubble: BubbleSettings }> {
    const current = this.getUiConfig();
    const preset = current.fontPresets.find((item) => item.id === id);
    if (!preset) throw new Error("这个字体预设已经不在了。");
    const next = await updateChatUi({ messageFont: preset.messageFont });
    const bubble = await updateBubble(preset.bubble);
    this.uiConfig = next;
    this.ui = { ...this.ui, messageFont: next.messageFont };
    broadcast("chat:ui-state", this.getUiState());
    broadcast("pet:bubble", bubble);
    return { state: this.getUiState(), bubble };
  }

  async setBackground(patch: ChatBackgroundPatch): Promise<ChatUiState> {
    const current = this.getUiConfig();
    const next = await updateChatUi({
      background: { ...current.background, ...patch },
    });
    this.uiConfig = next;
    this.ui = { ...this.ui, background: toBackground(next.background) };
    broadcast("chat:ui-state", this.getUiState());
    return this.getUiState();
  }

  async saveBackground(dataUrl: string): Promise<string> {
    const saved = await backgroundStore.save(dataUrl);
    const current = this.getUiConfig();
    const next = await updateChatUi({
      background: { ...current.background, image: saved.image },
    });
    this.uiConfig = next;
    this.backgroundImage = saved.dataUrl;
    return saved.dataUrl;
  }

  async clearBackground(): Promise<void> {
    await backgroundStore.clear();
    const current = this.getUiConfig();
    const next = await updateChatUi({
      background: { ...current.background, image: null },
    });
    this.uiConfig = next;
    this.backgroundImage = null;
  }

  async saveThemePreset(name: string, theme: ChatTheme): Promise<ChatUiState> {
    const label = name.trim().slice(0, 12);
    if (!label) throw new Error("预设名称不能为空。");
    const current = this.getUiConfig();
    const presets = current.themePresets.filter((item) => !item.builtin);
    if (presets.length >= 11) throw new Error("自定义预设最多 11 个，先删掉一个吧。");
    const id = `p-${Date.now().toString(36)}`;
    const preset: ChatThemePreset = {
      id,
      name: label,
      mode: theme.mode,
      accent: theme.accent,
    };
    const builtin = current.themePresets.filter((item) => item.builtin);
    const next = await updateChatUi({
      themePresets: [...builtin, preset, ...presets],
      theme: { ...theme, presetId: id },
    });
    this.uiConfig = next;
    this.ui = {
      ...this.ui,
      themePresets: next.themePresets,
      theme: next.theme,
    };
    broadcast("chat:ui-state", this.getUiState());
    return this.getUiState();
  }

  async deleteThemePreset(id: string): Promise<ChatUiState> {
    const current = this.getUiConfig();
    const preset = current.themePresets.find((item) => item.id === id);
    if (!preset) throw new Error("这个预设已经不在了。");
    if (preset.builtin) throw new Error("内置预设不能删除。");
    const theme =
      current.theme.presetId === id
        ? { ...current.theme, presetId: null }
        : current.theme;
    const next = await updateChatUi({
      themePresets: current.themePresets.filter((item) => item.id !== id),
      theme,
    });
    this.uiConfig = next;
    this.ui = {
      ...this.ui,
      themePresets: next.themePresets,
      theme: next.theme,
    };
    broadcast("chat:ui-state", this.getUiState());
    return this.getUiState();
  }

  getProfile(): ChatProfileData {
    return this.profile;
  }

  private async applyProfile(
    action: () => Promise<ChatProfileData>,
  ): Promise<ChatProfileData> {
    this.profile = await action();
    return this.profile;
  }

  async setProfileName(
    role: "hiro" | "me",
    name: string,
  ): Promise<ChatProfileData> {
    return this.applyProfile(() => profileStore.setName(role, name));
  }

  async saveProfileAvatar(
    role: "hiro" | "me",
    dataUrl: string,
  ): Promise<ChatProfileData> {
    return this.applyProfile(() => profileStore.saveAvatar(role, dataUrl));
  }

  async selectProfileAvatar(
    role: "hiro" | "me",
    id: string | null,
  ): Promise<ChatProfileData> {
    return this.applyProfile(() => profileStore.selectAvatar(role, id));
  }

  async resetProfileAvatar(role: "hiro" | "me"): Promise<ChatProfileData> {
    return this.applyProfile(() => profileStore.resetAvatar(role));
  }

  async getProfileHistory(role: "hiro" | "me") {
    return profileStore.history(role);
  }

  async getStorageInfo(): Promise<ChatStorageInfo> {
    const dir = this.store?.dir ?? ChatStore.defaultDir();
    const messages = await fileSize(join(dir, "messages.jsonl"));
    const meta = await fileSize(join(dir, "meta.json"));
    const thumbs = await dirSize(join(dir, "thumbs"));
    const avatars = await dirSize(profileStore.dir);
    return {
      dir,
      defaultDir: ChatStore.defaultDir(),
      custom: Boolean(this.uiConfig?.cacheDir),
      total: this.store?.total() ?? 0,
      bytes: messages + meta + thumbs + avatars,
      files: { messages, meta, thumbs, avatars },
      profileDir: profileStore.dir,
    };
  }

  private async switchStore(dir: string): Promise<void> {
    const limits = this.getUiConfig();
    await this.store?.flush();
    const store = new ChatStore(dir);
    await store.load(
      limits.cacheLimit,
      Math.min(limits.cacheMaxMb * 1024 * 1024, CACHE_MAX_BYTES),
    );
    this.store = store;
    this.media = new MediaCache(store.thumbsDir);
    this.lastCursor = store.getCursor();
    this.lastEpoch = store.getEpoch();
    this.bootstrapped = false;
    broadcast("chat:reset", this.getInitial());
    void this.bootstrap();
  }

  async chooseStorageDir(target: string): Promise<ChatStorageResult> {
    const raw = target.trim();
    if (!raw) return { ok: false, error: "路径不能为空。" };
    const dir = resolve(raw);
    const current = this.store?.dir ?? "";
    if (current && resolve(current) === dir) {
      return { ok: false, error: "已经在使用这个目录了。" };
    }
    try {
      await fs.mkdir(dir, { recursive: true });
      const probe = join(dir, ".monosaba-write-test");
      await fs.writeFile(probe, "ok", "utf8");
      await fs.rm(probe, { force: true });
    } catch {
      return { ok: false, error: "这个目录写不进去，换一个试试。" };
    }
    if (existsSync(join(dir, "messages.jsonl"))) {
      return {
        ok: false,
        error: "目标目录里已经有聊天记录，请换一个空目录。",
      };
    }
    try {
      if (current) {
        await copyFileIfExists(join(current, "messages.jsonl"), join(dir, "messages.jsonl"));
        await copyFileIfExists(join(current, "meta.json"), join(dir, "meta.json"));
        await copyDir(join(current, "thumbs"), join(dir, "thumbs"));
      }
      const next = await updateChatUi({ cacheDir: dir });
      this.uiConfig = next;
      await this.switchStore(dir);
      return { ok: true, info: await this.getStorageInfo() };
    } catch (error) {
      console.warn("[chat] switch storage failed", error);
      return { ok: false, error: "搬迁失败，原目录没有改动。" };
    }
  }

  async useDefaultStorageDir(): Promise<ChatStorageResult> {
    if (!this.uiConfig?.cacheDir) {
      return { ok: false, error: "现在用的就是默认目录。" };
    }
    try {
      const next = await updateChatUi({ cacheDir: null });
      this.uiConfig = next;
      await this.switchStore(ChatStore.defaultDir());
      return { ok: true, info: await this.getStorageInfo() };
    } catch (error) {
      console.warn("[chat] reset storage failed", error);
      return { ok: false, error: "切回默认目录失败。" };
    }
  }

  async clearCache(): Promise<ChatStorageResult> {
    try {
      await this.store?.clear();
      broadcast("chat:reset", this.getInitial());
      return { ok: true, info: await this.getStorageInfo() };
    } catch (error) {
      console.warn("[chat] clear cache failed", error);
      return { ok: false, error: "清空缓存失败。" };
    }
  }

  async updateBounds(mode: ChatUiMode, bounds: { x: number; y: number; width: number; height: number }): Promise<void> {
    const next = await updateChatUi(
      mode === "compact"
        ? { compactBounds: bounds }
        : { fullBounds: bounds },
    );
    this.uiConfig = next;
  }

  getMediaRoot(): string {
    return this.store?.thumbsDir ?? "";
  }
}

export const chatService = new ChatService();

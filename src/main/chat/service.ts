import { app, BrowserWindow, Notification } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ChatCommand,
  ChatCommandsData,
  ChatInitialData,
  ChatMessage,
  ChatPollData,
  ChatSendData,
  ChatStatus,
  ChatStatusData,
  ChatUiConfig,
  ChatUiMode,
  ChatUiState,
} from "../../shared/types";
import { readConfig, updateChatUi } from "../config";
import { captureDisplay } from "./capture";
import {
  bootstrapChat,
  loadChatStatus,
  loadCommands,
  pollMessages,
  sendMessage,
} from "./client";
import { MediaCache } from "./media";
import { ChatStore, normalizeMessage } from "./store";
import type { CapturedScreen } from "./capture";

const CACHE_MAX_BYTES = 500 * 1024 * 1024;
const STATUS_CACHE_MS = 3000;
const COMMANDS_CACHE_MS = 10 * 60_000;
const NOTIFY_DEBOUNCE_MS = 2200;

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

export class ChatService {
  private store: ChatStore | null = null;
  private media: MediaCache | null = null;
  private ui: ChatUiState = {
    mode: "compact",
    pinned: false,
    unread: 0,
    notifications: true,
  };
  private uiConfig: ChatUiConfig | null = null;
  private status: ChatStatus = { state: "offline", detail: "正在连接……" };
  private commands: ChatCommandsData = {
    commands: FALLBACK_COMMANDS,
    source: "fallback",
    generatedAt: 0,
  };
  private commandsFetchedAt = 0;
  private moodCache: ChatStatusData | null = null;
  private moodFetchedAt = 0;
  private windowActive = false;
  private bootstrapped = false;
  private bootstrapInFlight = false;
  private pollInFlight = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private bootstrapRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingNotify: ChatMessage[] = [];
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private unreadListener: ((unread: number) => void) | null = null;
  private openChatListener: (() => void) | null = null;
  private started = false;
  private lastCursor = 0;
  private lastEpoch = "";
  private lastQqConnected = false;

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
    };

    this.store = new ChatStore();
    await this.store.load(
      config.chat.ui.cacheLimit,
      Math.min(config.chat.ui.cacheMaxMb * 1024 * 1024, CACHE_MAX_BYTES),
    );
    this.media = new MediaCache(this.store.thumbsDir);
    this.lastCursor = this.store.getCursor();
    this.lastEpoch = this.store.getEpoch();

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
    const hadNew = normalized.length > 0;
    this.lastCursor = Math.max(this.lastCursor, data.cursor ?? 0);
    if (epoch) this.lastEpoch = epoch;
    this.lastQqConnected = data.qqConnected === true;
    this.setStatus(onlineStatus(this.lastQqConnected));

    if (!hadNew) {
      void this.store?.setCursor(this.lastCursor, this.lastEpoch);
      return false;
    }

    void this.store
      ?.append(normalized)
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
    if (!this.bootstrapped) return;
    const replies = messages.filter(
      (message) => message.role === "assistant",
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
    if (active) this.markRead();
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
    };
  }

  loadMore(beforeId: number, limit = 200): ChatMessage[] {
    return this.store?.getBefore(beforeId, Math.max(1, Math.min(400, limit))) ?? [];
  }

  async send(
    text: string,
    options: { captureScreen?: boolean; displayId?: string } = {},
  ): Promise<
    | { ok: true; data: ChatSendData }
    | { ok: false; error: string; kind: "offline" | "auth" | "server" | "unknown" }
  > {
    const value = text.trim();
    if (!value) return { ok: false, kind: "unknown", error: "消息不能为空。" };

    let screen: CapturedScreen | null = null;
    if (options.captureScreen) {
      try {
        screen = await captureDisplay(options.displayId);
      } catch (error) {
        console.warn("[chat] screen capture failed", error);
      }
    }

    const result = await sendMessage(value, screen?.base64);
    if (!result.ok) {
      this.setStatus(statusFromError(result.kind, result.error));
      return result;
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

  async setMode(mode: ChatUiMode): Promise<ChatUiState> {
    const next = await updateChatUi({ mode });
    this.uiConfig = next;
    this.ui = { ...this.ui, mode: next.mode };
    broadcast("chat:ui-state", this.getUiState());
    return this.getUiState();
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
    };
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

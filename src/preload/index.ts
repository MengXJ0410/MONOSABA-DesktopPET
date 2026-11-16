import { contextBridge, ipcRenderer } from "electron";
import type {
  ChatCommandsData,
  ChatInitialData,
  ChatInitialResult,
  ChatMediaKind,
  ChatMediaResult,
  ChatMessage,
  ChatResizeDirection,
  ChatSendOptions,
  ChatSendResult,
  ChatStatus,
  ChatStatusData,
  ChatUiMode,
  ChatUiState,
  DiaryPayload,
  DisplayInfo,
  MemoryDeleteInput,
  MemoryPayload,
  MemoryUpdateInput,
  MemoryWriteResult,
} from "../shared/types";

export type DiaryResult =
  | { ok: true; data: DiaryPayload }
  | { ok: false; error: string };

export type MemoryResult =
  | { ok: true; data: MemoryPayload }
  | { ok: false; error: string };

const api = {
  setIgnore(ignore: boolean) {
    ipcRenderer.send("pet:set-ignore", ignore);
  },
  focus(): void {
    ipcRenderer.send("pet:focus");
  },
  openDiary(): void {
    ipcRenderer.send("diary:open");
  },
  closeDiary(): void {
    ipcRenderer.send("diary:close");
  },
  resizeDiary(size: { width: number; height: number }): void {
    ipcRenderer.send("diary:resize", size);
  },
  loadDiary(book?: string | null): Promise<DiaryResult> {
    return ipcRenderer.invoke("diary:load", book ?? null) as Promise<DiaryResult>;
  },
  diaryAvailability(): Promise<boolean> {
    return ipcRenderer.invoke("diary:availability") as Promise<boolean>;
  },
  loadMemory(): Promise<MemoryResult> {
    return ipcRenderer.invoke("diary:load-memory") as Promise<MemoryResult>;
  },
  updateMemory(input: MemoryUpdateInput): Promise<MemoryWriteResult> {
    return ipcRenderer.invoke("diary:update-memory", input) as Promise<MemoryWriteResult>;
  },
  deleteMemory(input: MemoryDeleteInput): Promise<MemoryWriteResult> {
    return ipcRenderer.invoke("diary:delete-memory", input) as Promise<MemoryWriteResult>;
  },
  openChat(anchor?: { x: number; y: number }): void {
    ipcRenderer.send("chat:open", anchor);
  },
  closeChat(): void {
    ipcRenderer.send("chat:close");
  },
  chatInitial(): Promise<ChatInitialResult> {
    return ipcRenderer.invoke("chat:initial") as Promise<ChatInitialResult>;
  },
  chatLoadMore(beforeId: number, limit = 200): Promise<ChatMessage[]> {
    return ipcRenderer.invoke("chat:load-more", beforeId, limit) as Promise<ChatMessage[]>;
  },
  chatSend(text: string, options?: ChatSendOptions): Promise<ChatSendResult> {
    return ipcRenderer.invoke("chat:send", { text, ...options }) as Promise<ChatSendResult>;
  },
  chatMedia(media: string, kind: ChatMediaKind): Promise<ChatMediaResult> {
    return ipcRenderer.invoke("chat:media", media, kind) as Promise<ChatMediaResult>;
  },
  chatCommands(force = false): Promise<ChatCommandsData | null> {
    return ipcRenderer.invoke("chat:commands", force) as Promise<ChatCommandsData | null>;
  },
  chatStatusData(force = false): Promise<ChatStatusData | null> {
    return ipcRenderer.invoke("chat:status-data", force) as Promise<ChatStatusData | null>;
  },
  chatSetMode(mode: ChatUiMode): Promise<ChatUiState | null> {
    return ipcRenderer.invoke("chat:set-mode", mode) as Promise<ChatUiState | null>;
  },
  chatSetPinned(pinned: boolean): Promise<ChatUiState | null> {
    return ipcRenderer.invoke("chat:set-pinned", pinned) as Promise<ChatUiState | null>;
  },
  chatSetNotifications(enabled: boolean): Promise<ChatUiState | null> {
    return ipcRenderer.invoke("chat:set-notifications", enabled) as Promise<ChatUiState | null>;
  },
  chatMarkRead(): void {
    void ipcRenderer.invoke("chat:mark-read");
  },
  chatRetry(): Promise<ChatInitialResult | null> {
    return ipcRenderer.invoke("chat:retry") as Promise<ChatInitialResult | null>;
  },
  chatOpenSettings(): void {
    void ipcRenderer.invoke("chat:open-settings");
  },
  chatMinimize(): void {
    ipcRenderer.send("chat:minimize");
  },
  chatResizeStart(direction: ChatResizeDirection): void {
    ipcRenderer.send("chat:resize-start", direction);
  },
  chatResizeMove(): void {
    ipcRenderer.send("chat:resize-move");
  },
  chatResizeEnd(): void {
    ipcRenderer.send("chat:resize-end");
  },
  onChatMessages(handler: (messages: ChatMessage[]) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, messages: ChatMessage[]) => {
      handler(messages);
    };
    ipcRenderer.on("chat:messages", listener);
    return () => {
      ipcRenderer.removeListener("chat:messages", listener);
    };
  },
  onChatReset(handler: (data: ChatInitialData) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, data: ChatInitialData) => {
      handler(data);
    };
    ipcRenderer.on("chat:reset", listener);
    return () => {
      ipcRenderer.removeListener("chat:reset", listener);
    };
  },
  onChatStatus(handler: (status: ChatStatus) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, status: ChatStatus) => {
      handler(status);
    };
    ipcRenderer.on("chat:status", listener);
    return () => {
      ipcRenderer.removeListener("chat:status", listener);
    };
  },
  onChatCommands(handler: (data: ChatCommandsData) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, data: ChatCommandsData) => {
      handler(data);
    };
    ipcRenderer.on("chat:commands", listener);
    return () => {
      ipcRenderer.removeListener("chat:commands", listener);
    };
  },
  onChatUiState(handler: (state: ChatUiState) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, state: ChatUiState) => {
      handler(state);
    };
    ipcRenderer.on("chat:ui-state", listener);
    return () => {
      ipcRenderer.removeListener("chat:ui-state", listener);
    };
  },
  onOpenSettings(handler: () => void): () => void {
    const listener = () => handler();
    ipcRenderer.on("pet:open-settings", listener);
    return () => {
      ipcRenderer.removeListener("pet:open-settings", listener);
    };
  },
  captureDiaryCard(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<{ ok: boolean; dataUrl?: string }> {
    return ipcRenderer.invoke("diary:capture", rect) as Promise<{
      ok: boolean;
      dataUrl?: string;
    }>;
  },
  getAutoLaunch(): Promise<boolean> {
    return ipcRenderer.invoke("app:get-auto-launch") as Promise<boolean>;
  },
  setAutoLaunch(enabled: boolean): Promise<boolean> {
    return ipcRenderer.invoke("app:set-auto-launch", enabled) as Promise<boolean>;
  },
  listDisplays(): Promise<DisplayInfo[]> {
    return ipcRenderer.invoke("pet:list-displays") as Promise<DisplayInfo[]>;
  },
  setDisplay(displayId: string): Promise<DisplayInfo | null> {
    return ipcRenderer.invoke("pet:set-display", displayId) as Promise<DisplayInfo | null>;
  },
  setForceTop(enabled: boolean): Promise<boolean> {
    return ipcRenderer.invoke("pet:set-force-top", enabled) as Promise<boolean>;
  },
  onDisplayChanged(handler: (info: DisplayInfo) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, info: DisplayInfo) => handler(info);
    ipcRenderer.on("pet:display-changed", listener);
    return () => {
      ipcRenderer.removeListener("pet:display-changed", listener);
    };
  },
  openConfig(): void {
    ipcRenderer.send("app:open-config");
  },
  quit(): void {
    ipcRenderer.send("app:quit");
  },
};

contextBridge.exposeInMainWorld("petApi", api);

export type PetApi = typeof api;

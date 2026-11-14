import { contextBridge, ipcRenderer } from "electron";
import type {
  ChatHistoryResult,
  ChatMessage,
  ChatSendOptions,
  ChatSendResult,
  ChatStatus,
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
  chatHistory(): Promise<ChatHistoryResult> {
    return ipcRenderer.invoke("chat:history") as Promise<ChatHistoryResult>;
  },
  chatSend(text: string, options?: ChatSendOptions): Promise<ChatSendResult> {
    return ipcRenderer.invoke("chat:send", { text, ...options }) as Promise<ChatSendResult>;
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
  onChatStatus(handler: (status: ChatStatus) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, status: ChatStatus) => {
      handler(status);
    };
    ipcRenderer.on("chat:status", listener);
    return () => {
      ipcRenderer.removeListener("chat:status", listener);
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

import { contextBridge, ipcRenderer } from "electron";
import type {
  BubblePreviewEvent,
  BubbleSettings,
  ChatAvatarHistoryItem,
  ChatBackgroundPatch,
  ChatBackgroundUploadResult,
  ChatCommandsData,
  ChatDiagnostics,
  ChatFontScale,
  ChatInitialData,
  ChatInitialResult,
  ChatLineHeight,
  ChatMediaKind,
  ChatMediaResult,
  ChatMessage,
  ChatProfileData,
  ChatProfileRole,
  ChatResizeDirection,
  ChatSendOptions,
  ChatSendResult,
  ChatSettingsExportResult,
  ChatSettingsImportResult,
  ChatStatus,
  ChatStatusData,
  ChatStorageInfo,
  ChatStorageResult,
  ChatTheme,
  ChatUiMode,
  ChatUiState,
  ChatTypewriterSettings,
  CommentaryRunResult,
  CommentaryReplyEvent,
  CommentarySettings,
  CommentaryDiagnostics,
  DiaryPayload,
  DisplayInfo,
  MemoryDeleteInput,
  MemoryPayload,
  MemoryUpdateInput,
  MemoryWriteResult,
  MessageFont,
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
  chatProfile(): Promise<ChatProfileData | null> {
    return ipcRenderer.invoke("chat:profile") as Promise<ChatProfileData | null>;
  },
  chatProfileName(
    role: ChatProfileRole,
    name: string,
  ): Promise<ChatProfileData | { error: string } | null> {
    return ipcRenderer.invoke("chat:profile-name", role, name) as Promise<
      ChatProfileData | { error: string } | null
    >;
  },
  chatProfileAvatar(
    role: ChatProfileRole,
    dataUrl: string,
  ): Promise<ChatProfileData | { error: string } | null> {
    return ipcRenderer.invoke("chat:profile-avatar", role, dataUrl) as Promise<
      ChatProfileData | { error: string } | null
    >;
  },
  chatProfileAvatarSelect(
    role: ChatProfileRole,
    id: string | null,
  ): Promise<ChatProfileData | { error: string } | null> {
    return ipcRenderer.invoke("chat:profile-avatar-select", role, id) as Promise<
      ChatProfileData | { error: string } | null
    >;
  },
  chatProfileAvatarReset(
    role: ChatProfileRole,
  ): Promise<ChatProfileData | { error: string } | null> {
    return ipcRenderer.invoke("chat:profile-avatar-reset", role) as Promise<
      ChatProfileData | { error: string } | null
    >;
  },
  chatProfileHistory(role: ChatProfileRole): Promise<ChatAvatarHistoryItem[]> {
    return ipcRenderer.invoke("chat:profile-history", role) as Promise<
      ChatAvatarHistoryItem[]
    >;
  },
  chatSetTheme(theme: ChatTheme): Promise<ChatUiState | null> {
    return ipcRenderer.invoke("chat:set-theme", theme) as Promise<ChatUiState | null>;
  },
  chatSetFontScale(scale: ChatFontScale): Promise<ChatUiState | null> {
    return ipcRenderer.invoke("chat:set-font-scale", scale) as Promise<ChatUiState | null>;
  },
  chatSetLineHeight(height: ChatLineHeight): Promise<ChatUiState | null> {
    return ipcRenderer.invoke("chat:set-line-height", height) as Promise<ChatUiState | null>;
  },
  chatSetMessageFont(patch: Partial<MessageFont>): Promise<ChatUiState | null> {
    return ipcRenderer.invoke("chat:set-message-font", patch) as Promise<ChatUiState | null>;
  },
  chatSetTypewriter(
    patch: Partial<ChatTypewriterSettings>,
  ): Promise<ChatUiState | null> {
    return ipcRenderer.invoke("chat:set-typewriter", patch) as Promise<ChatUiState | null>;
  },
  chatFontPresetSave(
    name: string,
  ): Promise<ChatUiState | { error: string } | null> {
    return ipcRenderer.invoke("chat:font-preset-save", name) as Promise<
      ChatUiState | { error: string } | null
    >;
  },
  chatFontPresetDelete(
    id: string,
  ): Promise<ChatUiState | { error: string } | null> {
    return ipcRenderer.invoke("chat:font-preset-delete", id) as Promise<
      ChatUiState | { error: string } | null
    >;
  },
  chatFontPresetApply(
    id: string,
  ): Promise<ChatUiState | { error: string } | null> {
    return ipcRenderer.invoke("chat:font-preset-apply", id) as Promise<
      ChatUiState | { error: string } | null
    >;
  },
  chatSettingsExport(): Promise<ChatSettingsExportResult | null> {
    return ipcRenderer.invoke("chat:settings-export") as Promise<ChatSettingsExportResult | null>;
  },
  chatSettingsImport(): Promise<ChatSettingsImportResult | null> {
    return ipcRenderer.invoke("chat:settings-import") as Promise<ChatSettingsImportResult | null>;
  },
  chatSetBackground(patch: ChatBackgroundPatch): Promise<ChatUiState | null> {
    return ipcRenderer.invoke("chat:set-background", patch) as Promise<ChatUiState | null>;
  },
  chatBackgroundGet(): Promise<string | null> {
    return ipcRenderer.invoke("chat:background-get") as Promise<string | null>;
  },
  chatBackgroundUpload(dataUrl: string): Promise<ChatBackgroundUploadResult> {
    return ipcRenderer.invoke("chat:background-upload", dataUrl) as Promise<ChatBackgroundUploadResult>;
  },
  chatBackgroundReset(): Promise<boolean> {
    return ipcRenderer.invoke("chat:background-reset") as Promise<boolean>;
  },
  chatSavePreset(
    name: string,
    theme: ChatTheme,
  ): Promise<ChatUiState | { error: string } | null> {
    return ipcRenderer.invoke("chat:preset-save", name, theme) as Promise<
      ChatUiState | { error: string } | null
    >;
  },
  chatDeletePreset(id: string): Promise<ChatUiState | { error: string } | null> {
    return ipcRenderer.invoke("chat:preset-delete", id) as Promise<
      ChatUiState | { error: string } | null
    >;
  },
  chatStorageInfo(): Promise<ChatStorageInfo | null> {
    return ipcRenderer.invoke("chat:storage-info") as Promise<ChatStorageInfo | null>;
  },
  chatStorageChoose(): Promise<ChatStorageResult | null> {
    return ipcRenderer.invoke("chat:storage-choose") as Promise<ChatStorageResult | null>;
  },
  chatStorageDefault(): Promise<ChatStorageResult | null> {
    return ipcRenderer.invoke("chat:storage-default") as Promise<ChatStorageResult | null>;
  },
  chatStorageClear(): Promise<ChatStorageResult | null> {
    return ipcRenderer.invoke("chat:storage-clear") as Promise<ChatStorageResult | null>;
  },
  chatOpenFolder(kind: "cache" | "config" | "profile"): void {
    void ipcRenderer.invoke("chat:open-folder", kind);
  },
  chatDiagnostics(): Promise<ChatDiagnostics | null> {
    return ipcRenderer.invoke("chat:diagnostics") as Promise<ChatDiagnostics | null>;
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
  getCommentary(): Promise<CommentarySettings> {
    return ipcRenderer.invoke("commentary:get") as Promise<CommentarySettings>;
  },
  setCommentary(patch: Partial<CommentarySettings>): Promise<CommentarySettings> {
    return ipcRenderer.invoke("commentary:set", patch) as Promise<CommentarySettings>;
  },
  getCommentaryDiagnostics(): Promise<CommentaryDiagnostics> {
    return ipcRenderer.invoke("commentary:diagnostics") as Promise<CommentaryDiagnostics>;
  },
  noteCommentarySchedule(at: number): void {
    void ipcRenderer.invoke("commentary:note-schedule", at);
  },
  onCommentary(handler: (settings: CommentarySettings) => void): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      settings: CommentarySettings,
    ) => handler(settings);
    ipcRenderer.on("pet:commentary", listener);
    return () => {
      ipcRenderer.removeListener("pet:commentary", listener);
    };
  },
  onCommentaryPaused(handler: (text: string) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, text: unknown) => {
      handler(typeof text === "string" ? text : "");
    };
    ipcRenderer.on("pet:commentary-paused", listener);
    return () => {
      ipcRenderer.removeListener("pet:commentary-paused", listener);
    };
  },
  runCommentary(character?: string): Promise<CommentaryRunResult> {
    return ipcRenderer.invoke("pet:run-commentary", character) as Promise<CommentaryRunResult>;
  },
  noteChatActivity(): void {
    void ipcRenderer.invoke("chat:activity");
  },
  onCommentaryReply(handler: (event: CommentaryReplyEvent) => void): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: CommentaryReplyEvent,
    ) => handler(payload);
    ipcRenderer.on("chat:commentary", listener);
    return () => {
      ipcRenderer.removeListener("chat:commentary", listener);
    };
  },
  getBubble(): Promise<BubbleSettings> {
    return ipcRenderer.invoke("bubble:get") as Promise<BubbleSettings>;
  },
  setBubble(
    patch: Partial<Omit<BubbleSettings, "font">> & { font?: Partial<MessageFont> },
  ): Promise<BubbleSettings> {
    return ipcRenderer.invoke("bubble:set", patch) as Promise<BubbleSettings>;
  },
  onBubble(handler: (settings: BubbleSettings) => void): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      settings: BubbleSettings,
    ) => handler(settings);
    ipcRenderer.on("pet:bubble", listener);
    return () => {
      ipcRenderer.removeListener("pet:bubble", listener);
    };
  },
  previewBubble(text: string, ttlMs = 1500): void {
    ipcRenderer.send("bubble:preview", { text, ttlMs });
  },
  onBubblePreview(handler: (event: BubblePreviewEvent) => void): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: BubblePreviewEvent,
    ) => handler(payload);
    ipcRenderer.on("pet:bubble-preview", listener);
    return () => {
      ipcRenderer.removeListener("pet:bubble-preview", listener);
    };
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

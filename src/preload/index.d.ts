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
  ChatRetractResult,
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
  PointerControl,
  PointerPosition,
  PointerUpdate,
} from "../shared/types";

export type DiaryResult =
  | { ok: true; data: DiaryPayload }
  | { ok: false; error: string };

export type MemoryResult =
  | { ok: true; data: MemoryPayload }
  | { ok: false; error: string };

export type PetApi = {
  setIgnore(ignore: boolean): void;
  focus(): void;
  openDiary(): void;
  closeDiary(): void;
  resizeDiary(size: { width: number; height: number }): void;
  loadDiary(book?: string | null): Promise<DiaryResult>;
  diaryAvailability(): Promise<boolean>;
  loadMemory(): Promise<MemoryResult>;
  updateMemory(input: MemoryUpdateInput): Promise<MemoryWriteResult>;
  deleteMemory(input: MemoryDeleteInput): Promise<MemoryWriteResult>;
  openChat(anchor?: { x: number; y: number }): void;
  closeChat(): void;
  chatInitial(): Promise<ChatInitialResult>;
  chatLoadMore(beforeId: number, limit?: number): Promise<ChatMessage[]>;
  chatSend(text: string, options?: ChatSendOptions): Promise<ChatSendResult>;
  chatMedia(media: string, kind: ChatMediaKind): Promise<ChatMediaResult>;
  chatRetract(clientId: string): Promise<ChatRetractResult>;
  chatCommands(force?: boolean): Promise<ChatCommandsData | null>;
  chatStatusData(force?: boolean): Promise<ChatStatusData | null>;
  chatSetMode(mode: ChatUiMode): Promise<ChatUiState | null>;
  chatSetPinned(pinned: boolean): Promise<ChatUiState | null>;
  chatSetNotifications(enabled: boolean): Promise<ChatUiState | null>;
  chatMarkRead(): void;
  chatProfile(): Promise<ChatProfileData | null>;
  chatProfileName(
    role: ChatProfileRole,
    name: string,
  ): Promise<ChatProfileData | { error: string } | null>;
  chatProfileAvatar(
    role: ChatProfileRole,
    dataUrl: string,
  ): Promise<ChatProfileData | { error: string } | null>;
  chatProfileAvatarSelect(
    role: ChatProfileRole,
    id: string | null,
  ): Promise<ChatProfileData | { error: string } | null>;
  chatProfileAvatarReset(
    role: ChatProfileRole,
  ): Promise<ChatProfileData | { error: string } | null>;
  chatProfileHistory(role: ChatProfileRole): Promise<ChatAvatarHistoryItem[]>;
  chatSetTheme(theme: ChatTheme): Promise<ChatUiState | null>;
  chatSetFontScale(scale: ChatFontScale): Promise<ChatUiState | null>;
  chatSetLineHeight(height: ChatLineHeight): Promise<ChatUiState | null>;
  chatSetMessageFont(patch: Partial<MessageFont>): Promise<ChatUiState | null>;
  chatSetTypewriter(
    patch: Partial<ChatTypewriterSettings>,
  ): Promise<ChatUiState | null>;
  chatFontPresetSave(
    name: string,
  ): Promise<ChatUiState | { error: string } | null>;
  chatFontPresetDelete(
    id: string,
  ): Promise<ChatUiState | { error: string } | null>;
  chatFontPresetApply(
    id: string,
  ): Promise<ChatUiState | { error: string } | null>;
  chatSettingsExport(): Promise<ChatSettingsExportResult | null>;
  chatSettingsImport(): Promise<ChatSettingsImportResult | null>;
  chatSetBackground(patch: ChatBackgroundPatch): Promise<ChatUiState | null>;
  chatBackgroundGet(): Promise<string | null>;
  chatBackgroundUpload(dataUrl: string): Promise<ChatBackgroundUploadResult>;
  chatBackgroundReset(): Promise<boolean>;
  chatSavePreset(
    name: string,
    theme: ChatTheme,
  ): Promise<ChatUiState | { error: string } | null>;
  chatDeletePreset(id: string): Promise<ChatUiState | { error: string } | null>;
  chatStorageInfo(): Promise<ChatStorageInfo | null>;
  chatStorageChoose(): Promise<ChatStorageResult | null>;
  chatStorageDefault(): Promise<ChatStorageResult | null>;
  chatStorageClear(): Promise<ChatStorageResult | null>;
  chatOpenFolder(kind: "cache" | "config" | "profile"): void;
  chatDiagnostics(): Promise<ChatDiagnostics | null>;
  chatRetry(): Promise<ChatInitialResult | null>;
  chatOpenSettings(): void;
  chatMinimize(): void;
  chatResizeStart(direction: ChatResizeDirection): void;
  chatResizeMove(): void;
  chatResizeEnd(): void;
  onChatMessages(handler: (messages: ChatMessage[]) => void): () => void;
  onChatReset(handler: (data: ChatInitialData) => void): () => void;
  onChatStatus(handler: (status: ChatStatus) => void): () => void;
  onChatCommands(handler: (data: ChatCommandsData) => void): () => void;
  onChatUiState(handler: (state: ChatUiState) => void): () => void;
  onChatRetract(
    handler: (payload: { turn: string; removed: number[] }) => void,
  ): () => void;
  onOpenSettings(handler: () => void): () => void;
  pointerReport(position: PointerPosition): void;
  onPointerUpdate(handler: (update: PointerUpdate) => void): () => void;
  onPointerControl(handler: (control: PointerControl) => void): () => void;
  captureDiaryCard(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<{ ok: boolean; dataUrl?: string }>;
  getAutoLaunch(): Promise<boolean>;
  setAutoLaunch(enabled: boolean): Promise<boolean>;
  getCommentary(): Promise<CommentarySettings>;
  setCommentary(patch: Partial<CommentarySettings>): Promise<CommentarySettings>;
  getCommentaryDiagnostics(): Promise<CommentaryDiagnostics>;
  noteCommentarySchedule(at: number): void;
  onCommentary(handler: (settings: CommentarySettings) => void): () => void;
  onCommentaryPaused(handler: (text: string) => void): () => void;
  runCommentary(character?: string): Promise<CommentaryRunResult>;
  noteChatActivity(): void;
  onCommentaryReply(handler: (event: CommentaryReplyEvent) => void): () => void;
  getBubble(): Promise<BubbleSettings>;
  setBubble(
    patch: Partial<Omit<BubbleSettings, "font">> & { font?: Partial<MessageFont> },
  ): Promise<BubbleSettings>;
  onBubble(handler: (settings: BubbleSettings) => void): () => void;
  previewBubble(text: string, ttlMs?: number): void;
  onBubblePreview(handler: (event: BubblePreviewEvent) => void): () => void;
  listDisplays(): Promise<DisplayInfo[]>;
  setDisplay(displayId: string): Promise<DisplayInfo | null>;
  setForceTop(enabled: boolean): Promise<boolean>;
  onDisplayChanged(handler: (info: DisplayInfo) => void): () => void;
  openConfig(): void;
  quit(): void;
};

declare global {
  interface Window {
    petApi: PetApi;
  }
}

export {};

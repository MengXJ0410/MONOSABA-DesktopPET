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
  chatCommands(force?: boolean): Promise<ChatCommandsData | null>;
  chatStatusData(force?: boolean): Promise<ChatStatusData | null>;
  chatSetMode(mode: ChatUiMode): Promise<ChatUiState | null>;
  chatSetPinned(pinned: boolean): Promise<ChatUiState | null>;
  chatSetNotifications(enabled: boolean): Promise<ChatUiState | null>;
  chatMarkRead(): void;
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
  onOpenSettings(handler: () => void): () => void;
  captureDiaryCard(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<{ ok: boolean; dataUrl?: string }>;
  getAutoLaunch(): Promise<boolean>;
  setAutoLaunch(enabled: boolean): Promise<boolean>;
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

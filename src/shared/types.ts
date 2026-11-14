export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** 一块屏幕的展示信息，用于设置面板 / 托盘的「显示屏幕」切换。 */
export type DisplayInfo = {
  /** Electron display id，字符串化后便于跨 IPC 传递。 */
  id: string;
  /** 从 1 开始的稳定序号，对应按钮上的「屏幕 N」。 */
  index: number;
  /** 按钮文案，例如「屏幕 1」。 */
  label: string;
  /** 工作区宽高（DIP），不含任务栏。 */
  width: number;
  height: number;
  scaleFactor: number;
  /** 是否为系统主屏。 */
  primary: boolean;
  /** 桌宠窗口当前是否在这块屏上。 */
  current: boolean;
};

export type DiaryBook = {
  name: string;
  size: number;
  mtime: number;
};

export type DiaryPayload = DiaryBook & {
  books: DiaryBook[];
  book: string | null;
  content: string;
  truncated: boolean;
};

export type DiaryConfig = {
  hosts: string[];
  port: number;
  username: string;
  privateKeyPath: string;
  remoteDir: string;
  /** 服务器上的记忆 JSONL 目录（读取用）。 */
  memoryDir: string;
  /** 记忆 JSONL 在 AstrBot 容器里的目录（写入用）。 */
  memoryDirInContainer: string;
  /** AstrBot 容器名，写入时走 docker exec。 */
  containerName: string;
};

/** 一条长久记忆，对应 AstrBot 插件 memory/YYYY-MM-DD.jsonl 的一行。 */
export type MemoryEntry = {
  date: string;
  /** 事实 / 事件 / 偏好 / 情绪 / 约定 / 关系 / 画像 / 日记 */
  kind: string;
  /** 1–5，数值越大越重要。 */
  imp: number;
  text: string;
  /** diary 或 qq... 等来源域。 */
  scope: string;
  /** JSONL 文件名，例如 2026-10-26.jsonl。 */
  file: string;
  /** 文件里的物理行号，1 开始。 */
  line: number;
};

export type MemoryUpdateInput = {
  file: string;
  line: number;
  text: string;
  original: string;
};

export type MemoryDeleteInput = {
  file: string;
  line: number;
  original: string;
};

export type MemoryWriteResult =
  | { ok: true }
  | { ok: false; error: string };

export type MemoryPayload = {
  entries: MemoryEntry[];
  /** 有记忆的天数。 */
  days: number;
  count: number;
};

/** 桌面聊天框连接 AstrBot 桥接插件的配置。 */
export type ChatConfig = {
  /** 依次尝试的服务器地址，复用日记的 EasyTier / 局域网地址。 */
  hosts: string[];
  /** AstrBot dashboard 端口。 */
  port: number;
  /** plugin scope 的 API Key；为空时聊天框提示未配置。 */
  apiKey: string;
  timeoutMs: number;
  /** 聊天窗口打开期间的增量拉取间隔。 */
  pollMs: number;
};

export type ChatRole = "user" | "assistant";

/** 一条聊天消息；从 AstrBot 会话回填的历史 id/ts 为 0。 */
export type ChatMessage = {
  id: number;
  ts: number;
  role: ChatRole;
  origin?: "qq" | "desktop" | null;
  text: string;
  /** 图片消息的 data URL；桌面截图和会话回填的图片会带。 */
  image?: string | null;
};

export type ChatConnectionState =
  | "online"
  | "qq-offline"
  | "offline"
  | "auth"
  | "bridge-missing";

export type ChatStatus = {
  state: ChatConnectionState;
  detail?: string;
};

export type ChatErrorKind = "offline" | "auth" | "server" | "unknown";

export type ChatResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; kind: ChatErrorKind };

export type ChatHistoryData = {
  messages: ChatMessage[];
  cursor: number;
  qqConnected: boolean;
};

export type ChatSendData = {
  message: ChatMessage;
  /** 本条消息附带的屏幕截图 data URL；没有截图时为 null。 */
  screenImage?: string | null;
  /** 请求了截图但截取失败。 */
  captureFailed?: boolean;
};

/** 发送消息时的截图选项。 */
export type ChatSendOptions = {
  captureScreen?: boolean;
  displayId?: string;
};

export type ChatPollData = {
  messages: ChatMessage[];
  cursor: number;
  qqConnected: boolean;
};

export type ChatHistoryResult = ChatResult<ChatHistoryData>;
export type ChatSendResult = ChatResult<ChatSendData>;

export type PetConfig = {
  diary: DiaryConfig;
  chat: ChatConfig;
};

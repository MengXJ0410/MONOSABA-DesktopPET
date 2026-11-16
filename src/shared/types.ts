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

export type ChatUiMode = "compact" | "full";

/** 完整版窗口的自定义缩放方向（透明窗口无法使用系统边框缩放）。 */
export type ChatResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** 聊天窗口的位置与尺寸（不含卡片外的 8px 透明留白）。 */
export type ChatBounds = Rect;

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
  /** 完整版 / 小窗偏好、窗口尺寸与通知设置。 */
  ui: ChatUiConfig;
};

export type ChatThemeMode = "night" | "day";

export type ChatFontScale = "sm" | "md" | "lg";

export type ChatLineHeight = "compact" | "normal" | "loose";

export type ChatTheme = {
  mode: ChatThemeMode;
  /** 主题色，`#rrggbb`。 */
  accent: string;
  /** 当前套用的预设 id；手动调整后为 null。 */
  presetId: string | null;
};

export type ChatThemePreset = {
  id: string;
  name: string;
  mode: ChatThemeMode;
  accent: string;
  /** 内置预设（希罗）不允许删除。 */
  builtin?: boolean;
};

/** 聊天窗口的外观设置，配置与运行态共用。 */
export type ChatAppearance = {
  theme: ChatTheme;
  themePresets: ChatThemePreset[];
  fontScale: ChatFontScale;
  lineHeight: ChatLineHeight;
};

export type ChatUiConfig = ChatAppearance & {
  /** 上次使用的界面模式。 */
  mode: ChatUiMode;
  /** 小窗卡片位置与尺寸（窗口 bounds 去掉 8px 留白）。 */
  compactBounds: ChatBounds | null;
  /** 完整版卡片位置与尺寸。 */
  fullBounds: ChatBounds | null;
  /** 完整版图钉：窗口是否始终置顶。 */
  fullPinned: boolean;
  /** 窗口隐藏时是否弹 Windows 通知。 */
  notifications: boolean;
  /** 本地缓存最多保留多少条消息。 */
  cacheLimit: number;
  /** 本地缓存 / 缩略图最多占用多少 MB。 */
  cacheMaxMb: number;
  /** 自定义聊天记录目录；null 表示使用 userData/chat-cache。 */
  cacheDir: string | null;
};

export type ChatProfileRole = "hiro" | "me";

export type ChatProfileEntry = {
  role: ChatProfileRole;
  name: string;
  /** 自定义头像 data URL；null 表示内置默认头像。 */
  avatar: string | null;
};

export type ChatProfileData = {
  hiro: ChatProfileEntry;
  me: ChatProfileEntry;
};

export type ChatAvatarHistoryItem = {
  id: string;
  src: string;
  createdAt: number;
};

export type ChatStorageInfo = {
  dir: string;
  defaultDir: string;
  custom: boolean;
  /** 本地缓存的聊天条数。 */
  total: number;
  /** 消息 / 缩略图 / 头像合计占用字节。 */
  bytes: number;
  files: {
    messages: number;
    meta: number;
    thumbs: number;
    avatars: number;
  };
  profileDir: string;
};

export type ChatStorageResult =
  | { ok: true; info: ChatStorageInfo }
  | { ok: false; error: string };

/** 设置面板「关于」里显示的排障信息。 */
export type ChatDiagnostics = {
  appVersion: string;
  electron: string;
  chrome: string;
  platform: string;
  status: ChatStatus;
  epoch: string;
  cursor: number;
  hosts: string[];
  port: number;
};

export type ChatRole = "user" | "assistant";

/** 桥接插件保存的图片附件；缩略图 / 原图通过 /media 按需读取。 */
export type ChatAttachment = {
  type: "image";
  /** 桥接插件 media 目录里的文件名，例如 3f2a...c1.webp。 */
  media: string;
  mime: string;
  width?: number;
  height?: number;
  animated?: boolean;
  bytes?: number;
};

/** 一条聊天消息；从 AstrBot 会话回填的历史 id/ts 可能为 0。 */
export type ChatMessage = {
  id: number;
  ts: number;
  role: ChatRole;
  origin?: "qq" | "desktop" | null;
  text: string;
  /** 旧接口内联的图片 data URL；新消息改用 attachments。 */
  image?: string | null;
  /** 图片 / 表情包附件。 */
  attachments?: ChatAttachment[];
  /** 本次运行中实时收到的消息；渲染层据此保留 GIF 动画。 */
  live?: boolean;
  /** 仅渲染层使用：还没被桥接确认的乐观消息。 */
  pending?: boolean;
  /** 历史回填没有原始时间，ts 是按顺序推算的近似值。 */
  approximate?: boolean;
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
  hasMore?: boolean;
  qqConnected: boolean;
  epoch?: string;
};

export type ChatHistoryResult = ChatResult<ChatHistoryData>;
export type ChatSendResult = ChatResult<ChatSendData>;

export type ChatBootstrapData = {
  /** 桥接插件发送日志（包含 QQ 与桌面的实际收发）。 */
  messages: ChatMessage[];
  /** AstrBot 当前会话历史，用于补齐插件安装前的对话。 */
  history: ChatMessage[];
  cursor: number;
  epoch: string;
  qqConnected: boolean;
  version?: string;
  capabilities?: string[];
  logLimit?: number;
};

export type ChatBootstrapResult = ChatResult<ChatBootstrapData>;

export type ChatMoodEmotion = {
  name: string;
  /** 0–1，已按半衰期衰减。 */
  intensity: number;
  reason: string;
  ts: number;
};

export type ChatAffection = {
  value: number;
  cap: number;
  stage: string;
  partner: boolean;
  gainToday: number;
  lossToday: number;
  gainCapToday: number;
  breakupPending: boolean;
  coldWar: boolean;
  coldWarSince: number;
  coldWarReason: string;
};

export type ChatRecentExchange = {
  user: string;
  assistant: string;
  ts: number;
};

export type ChatStatusData = {
  available: boolean;
  error?: string;
  umo?: string;
  updatedAt?: number;
  thoughtAt?: number;
  lastThought?: string;
  affection?: ChatAffection | null;
  emotions?: ChatMoodEmotion[];
  recent?: ChatRecentExchange[];
  coldWar?: boolean;
};

export type ChatCommand = {
  name: string;
  aliases: string[];
  description: string;
  permission: string;
  plugin: string;
  dangerous: boolean;
  subcommands: ChatCommand[];
};

export type ChatCommandsData = {
  commands: ChatCommand[];
  source: "astrbot" | "fallback";
  generatedAt: number;
};

export type ChatMediaKind = "thumb" | "original";

export type ChatMediaData = {
  media: string;
  mime: string;
  width: number;
  height: number;
  animated: boolean;
  bytes: number;
  base64: string;
};

export type ChatMediaResult =
  | { ok: true; dataUrl: string; mime: string }
  | { ok: false; error: string };

export type ChatUiState = ChatAppearance & {
  mode: ChatUiMode;
  pinned: boolean;
  unread: number;
  notifications: boolean;
};

export type ChatInitialData = {
  messages: ChatMessage[];
  total: number;
  cursor: number;
  qqConnected: boolean;
  status: ChatStatus;
  ui: ChatUiState;
  commands: ChatCommandsData;
  epoch: string;
  profile: ChatProfileData;
};

export type ChatInitialResult = ChatResult<ChatInitialData>;

export type PetConfig = {
  diary: DiaryConfig;
  chat: ChatConfig;
};

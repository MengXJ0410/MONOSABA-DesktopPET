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

/** 消息文字样式。聊天消息和桌宠气泡各存一份，互不影响。 */
export type MessageFont = {
  bold: boolean;
  /** `#rrggbb`；空字符串表示跟随原有配色。 */
  color: string;
  stroke: boolean;
  /** 描边宽度（px），0–4。 */
  strokeWidth: number;
  strokeColor: string;
  shadow: boolean;
  /** 阴影模糊半径（px），0–16。 */
  shadowBlur: number;
  shadowColor: string;
};

/** 聊天消息逐字输出。 */
export type ChatTypewriterSettings = {
  enabled: boolean;
  /** 每秒显示多少个字，5–60。 */
  charsPerSecond: number;
};

/** 字体预设里保存的气泡外观（不含自动隐藏 / 保留轮数等行为）。 */
export type FontPresetBubble = {
  fontSize: number;
  opacity: number;
  position: BubblePosition;
  maxWidth: number;
  plainText: boolean;
  indent: boolean;
  font: MessageFont;
};

/** 一套字体预设：聊天字体 + 气泡字体与外观，最多 10 个。 */
export type FontPreset = {
  id: string;
  name: string;
  messageFont: MessageFont;
  bubble: FontPresetBubble;
};

/** 聊天窗口的外观设置，配置与运行态共用。 */
export type ChatAppearance = {
  theme: ChatTheme;
  themePresets: ChatThemePreset[];
  fontScale: ChatFontScale;
  lineHeight: ChatLineHeight;
  messageFont: MessageFont;
  typewriter: ChatTypewriterSettings;
  fontPresets: FontPreset[];
};

export type BubblePosition = "top" | "left" | "right" | "auto";

/** 桌宠气泡的外观设置；桌宠和聊天设置共用同一份。 */
export type BubbleSettings = {
  /** 字号（px），8–64。 */
  fontSize: number;
  /** 背景不透明度（%），20–100；纯文字模式下不生效。 */
  opacity: number;
  position: BubblePosition;
  /** 气泡最大宽度（px），180–420。 */
  maxWidth: number;
  /** 无气泡纯文字：去掉底色和边框。 */
  plainText: boolean;
  /** 每段首行缩进 2 字符。 */
  indent: boolean;
  /** 最后一段到达后自动隐藏（秒），0 = 不自动隐藏。 */
  autoHideSeconds: number;
  /** 点评气泡保留多少轮，1–5。 */
  rounds: number;
  font: MessageFont;
};

export type ChatBackground = {
  /** 聊天区不透明度 0–100；null = 按模式默认（完整版 60 / 小窗 85）。 */
  chatOpacity: number | null;
  /** 面板（标题栏 / 左栏 / 右侧面板 / 输入区 / 状态栏）不透明度 0–100。 */
  panelOpacity: number;
  /** 自定义背景是否铺满整张卡片。 */
  extend: boolean;
};

export type ChatBackgroundConfig = ChatBackground & {
  /** 背景图文件名（userData/background/ 下）；null 表示没有自定义背景。 */
  image: string | null;
};

export type ChatBackgroundPatch = Partial<ChatBackground>;

export type ChatBackgroundUploadResult =
  | { ok: true; dataUrl: string }
  | { ok: false; error: string };

export type ChatUiConfig = ChatAppearance & {
  /** 背景透明度与自定义背景图。 */
  background: ChatBackgroundConfig;
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

/** 引用快照：只保存展示需要的字段，原消息删了也不影响。 */
export type ChatQuote = {
  /** 被引用消息的本地 id，仅用于跳回原消息，不参与服务端逻辑。 */
  id?: number;
  role: ChatRole;
  text: string;
  ts?: number;
};

/** 一条聊天消息；从 AstrBot 会话回填的历史 id/ts 可能为 0。 */
export type ChatMessage = {
  id: number;
  ts: number;
  role: ChatRole;
  origin?: "qq" | "desktop" | null;
  text: string;
  /** 桌面对话回合 id；撤回时按它精确删掉这一轮。 */
  turn?: string;
  /** 引用回复的快照。 */
  quote?: ChatQuote | null;
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
  /** 桥接确认写入的 user 消息；被预撤回时为 null。 */
  message: ChatMessage | null;
  /** 本条消息附带的屏幕截图 data URL；没有截图时为 null。 */
  screenImage?: string | null;
  /** 请求了截图但截取失败。 */
  captureFailed?: boolean;
  /** 点评目标正在睡眠，桥接没有注入回合。 */
  sleeping?: boolean;
  /** 睡眠时的固定回复。 */
  reply?: string;
  /** 发送途中已经被撤回，桥接没有注入回合。 */
  retracted?: boolean;
};

/** 发送消息时的截图 / 引用选项。 */
export type ChatSendOptions = {
  captureScreen?: boolean;
  displayId?: string;
  /** 本轮 id；撤回时用它定位。 */
  clientId?: string;
  quote?: ChatQuote | null;
};

export type ChatRetractData = {
  /** 被撤回的回合 id。 */
  turn: string;
  /** 桥接侧删掉的消息 id。 */
  removed: number[];
  /** 桥接不支持撤回时为 false。 */
  supported?: boolean;
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
export type ChatRetractResult = ChatResult<ChatRetractData>;

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
  /** 主私聊是否正在睡眠；桌宠点评会据此直接回 zzZ。 */
  sleeping?: boolean;
  /** awake / delaying / sleeping / woken / nightmare。 */
  sleepStatus?: string;
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

/** 导出到本地 JSON 的聊天个性化设置（不含 API Key / 服务器 / 缓存路径）。 */
export type ChatSettingsExport = {
  format: "monosaba-chat-settings";
  version: 1;
  exportedAt: string;
  appVersion: string;
  appearance: {
    theme: ChatTheme;
    themePresets: ChatThemePreset[];
    messageFont: MessageFont;
    typewriter: ChatTypewriterSettings;
  };
  background: ChatBackground;
  bubble: BubbleSettings;
  commentary: {
    minSeconds: number;
    maxSeconds: number;
  };
  fontPresets: FontPreset[];
};

export type ChatSettingsExportResult =
  | { ok: true; path: string }
  | { ok: false; error: string; canceled?: boolean };

export type ChatSettingsImportResult =
  | { ok: true; applied: string[] }
  | { ok: false; error: string; canceled?: boolean };

export type ChatUiState = ChatAppearance & {
  mode: ChatUiMode;
  pinned: boolean;
  unread: number;
  notifications: boolean;
  background: ChatBackground;
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
  /** 自定义背景图 data URL；没有时是 null。 */
  backgroundImage: string | null;
  /** 桥接插件声明的能力（retract / quote / commentary ...）。 */
  capabilities?: string[];
};

export type ChatInitialResult = ChatResult<ChatInitialData>;

export type PetConfig = {
  diary: DiaryConfig;
  chat: ChatConfig;
  /** 用户是否开启过开机自启；升级换代后用它把自启路径修到当前 exe。 */
  autoLaunch: boolean;
  /** 随机屏幕点评。 */
  commentary: CommentarySettings;
  /** 桌宠气泡外观（位置、字号、字体、透明度）。 */
  bubble: BubbleSettings;
  /** 已经执行过的一次性配置迁移。 */
  migrations: string[];
};

export type CommentarySettings = {
  enabled: boolean;
  /** 最短间隔（秒），最小 30。 */
  minSeconds: number;
  /** 最长间隔（秒），不设实际上限（受系统定时器限制）。 */
  maxSeconds: number;
};

export type CommentaryRunResult =
  | {
      ok: true;
      text: string;
      /** 这一轮之后进入了暂停（连续 3 轮点评内容接近）。 */
      paused?: boolean;
    }
  | {
      ok: false;
      skipped?: boolean;
      error?: string;
      /**
       * stalled = 已经暂停，画面还没变化；same = 这一轮画面没变但还没到暂停阈值；
       * sleeping = 睡着，只回 zzZ；busy = 聊天窗口正在使用；capture = 屏幕截图失败；
       * no-reply = 请求已发出但没等到回复；error = 其它异常。
       */
      reason?: "stalled" | "busy" | "same" | "sleeping" | "capture" | "no-reply" | "error";
      /** 这一次是否刚好进入暂停（用于只提示一次）。 */
      paused?: boolean;
      /** 睡眠时的固定回复（zzZ）。 */
      reply?: string;
    };

/**
 * 主进程收到一段点评回复就广播一次，气泡与聊天窗口同步出现；
 * `final` 只表示这一轮已经收齐，渲染层不用等它才能上屏。
 */
export type CommentaryReplyEvent = {
  text: string;
  character?: string;
  roundId: string;
  /** 本轮第几段，从 0 开始。 */
  seq: number;
  final: boolean;
};

/** 聊天设置里调整气泡时，让桌宠立刻显示一句预览。 */
export type BubblePreviewEvent = {
  text: string;
  /** 毫秒；到点自动收起预览。 */
  ttlMs: number;
};

/** 一次随机点评尝试的结果，用于设置面板显示“为什么没点评”。 */
export type CommentaryAttempt = {
  at: number;
  ok: boolean;
  /** 与 CommentaryRunResult.reason 对应；成功时为空。 */
  reason?: string;
  durationMs: number;
  /** 简短说明，例如截图失败、请求超时。 */
  detail?: string;
};

/**
 * 随机点评的运行状态。设置面板打开「随机点评」时读取，
 * 用来显示下次时间、上次结果和跳过原因，避免“开了但一直没触发”无从排查。
 */
export type CommentaryDiagnostics = {
  /** 本次启动累计尝试次数。 */
  attempts: number;
  /** 最近一次尝试时间；0 表示启动后还没试过。 */
  lastAt: number;
  lastOk: boolean;
  lastReason?: string;
  lastDetail?: string;
  lastDurationMs: number;
  /** 最近一段成功的点评开头，用来确认内容真的上屏了。 */
  lastText?: string;
  /** 最近一轮截图耗时（毫秒）。 */
  lastCaptureMs: number;
  /** 聊天窗口当前是否聚焦在用（点评会因此让路）。 */
  chatWindowActive: boolean;
  /** 聊天窗口最近一次活动时间戳（聚焦、输入、发送）。 */
  chatLastActivityAt: number;
  sameRounds: number;
  paused: boolean;
  /** 渲染层排定的下一轮时间戳；0 表示当前没有排期。 */
  nextAt: number;
  /** 最近 8 次尝试，新的在前。 */
  history: CommentaryAttempt[];
};

/** 第二指针（希罗指针）。坐标统一用虚拟桌面的 DIP，size 是光标的 CSS 像素高度基准。 */
export type PointerPosition = {
  x: number;
  y: number;
  size: number;
};

/** 主进程发给指针浮层的坐标，相对该显示器左上角。 */
export type PointerUpdate = {
  x: number;
  y: number;
  size: number;
  visible: boolean;
};

/** 主进程发给桌宠渲染层的指针状态；本版只使用 wander。 */
export type PointerControl = {
  mode: "wander" | "external";
  x?: number;
  y?: number;
};

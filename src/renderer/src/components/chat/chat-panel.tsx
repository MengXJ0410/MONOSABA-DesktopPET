import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type {
  ChatAttachment,
  ChatBackgroundPatch,
  ChatCommand,
  ChatCommandsData,
  ChatDiagnostics,
  ChatFontScale,
  ChatInitialData,
  ChatLineHeight,
  ChatMessage,
  ChatMoodEmotion,
  ChatProfileData,
  ChatProfileEntry,
  ChatProfileRole,
  ChatResizeDirection,
  ChatRole,
  ChatStatus,
  ChatStatusData,
  ChatStorageInfo,
  ChatTheme,
  ChatThemePreset,
  ChatUiMode,
  ChatUiState,
  DisplayInfo,
} from "../../../../shared/types";
import { HIRO_AVATAR, ME_DEFAULT_AVATAR } from "../../content/avatars";
import styles from "./chat-panel.module.css";

const REPLY_TIMEOUT_MS = 90_000;
const MAX_INPUT_HEIGHT = 140;
const COMPACT_MESSAGE_LIMIT = 40;
const GROUP_WINDOW_MS = 3 * 60_000;
const PAGE_SIZE = 200;
const STATUS_DEBOUNCE_MS = 650;
const PANEL_STORAGE_KEY = "chat.full.panel";
const MODE_STORAGE_KEY = "chat.ui.mode";

const DEFAULT_PROFILE: ChatProfileData = {
  hiro: { role: "hiro", name: "希罗", avatar: null },
  me: { role: "me", name: "我", avatar: null },
};

const ACCENT_SWATCHES: { name: string; color: string }[] = [
  { name: "希罗红", color: "#c8102e" },
  { name: "绯樱", color: "#e0556d" },
  { name: "樱花粉", color: "#ff8fb3" },
  { name: "暖橙", color: "#d9713c" },
  { name: "琥珀", color: "#c9a227" },
  { name: "青松", color: "#39a07a" },
  { name: "海蓝", color: "#3f7fd9" },
  { name: "紫罗兰", color: "#8b6ce0" },
  { name: "石墨", color: "#7a7f8c" },
];

const FONT_SCALE_LABEL: Record<ChatFontScale, string> = {
  sm: "小",
  md: "中",
  lg: "大",
};

const LINE_HEIGHT_LABEL: Record<ChatLineHeight, string> = {
  compact: "紧凑",
  normal: "标准",
  loose: "宽松",
};

const AVATAR_SIZE = 272;
const AVATAR_OUTPUT = 256;

function avatarOf(entry: ChatProfileEntry): string {
  return entry.avatar ?? (entry.role === "hiro" ? HIRO_AVATAR : ME_DEFAULT_AVATAR);
}

function profileRoleName(role: ChatProfileRole): string {
  return role === "hiro" ? "希罗" : "我";
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("load failed"));
    image.src = src;
  });
}

const RESIZE_DIRECTIONS: ChatResizeDirection[] = [
  "n",
  "s",
  "e",
  "w",
  "ne",
  "nw",
  "se",
  "sw",
];

const STATUS_TEXT: Record<ChatStatus["state"], string> = {
  online: "已连接",
  "qq-offline": "QQ 未连接",
  offline: "无法连接",
  auth: "密钥无效",
  "bridge-missing": "桥接插件未安装",
};

const EMOTION_ORDER = [
  "开心",
  "害羞",
  "生气",
  "委屈",
  "担心",
  "失落",
  "累",
  "吃醋",
];

const EMOTION_META: Record<string, { color: string }> = {
  开心: { color: "#f2c14e" },
  害羞: { color: "#ff8fb3" },
  生气: { color: "#ff5a5a" },
  委屈: { color: "#b59cff" },
  担心: { color: "#6fb3ff" },
  失落: { color: "#8b9bb0" },
  累: { color: "#b8a88f" },
  吃醋: { color: "#8fd14f" },
};

// 和桥接插件保持一致的判定，发送前再兜一层确认。
const DANGEROUS_ROOTS = new Set([
  "reset",
  "new",
  "del",
  "delete",
  "clear",
  "清除",
  "清空",
  "重置",
  "provider",
  "model",
  "persona",
  "plugin",
  "op",
  "dashboard_update",
  "ni",
  "ni重置",
  "删图",
  "存tag",
  "应用tag",
  "删除tag",
  "搜图",
  "自动搜图立即执行",
  "心情表情刷新",
]);

const DANGEROUS_SUBCOMMANDS: Record<string, Set<string>> = {
  心情: new Set(["重置", "冷战", "解除冷战", "结束冷战", "uncold", "reset", "clear"]),
  好感: new Set(["设置", "set"]),
  记忆: new Set([
    "刷新",
    "flush",
    "删除",
    "delete",
    "回填",
    "backfill",
    "重建",
    "rebuild",
    "画像",
    "profile",
  ]),
};

const DANGEROUS_KEYWORDS = [
  "重置",
  "清空",
  "清除",
  "删除",
  "删图",
  "重建",
  "回填",
  "冷战",
  "设置好感",
  "生图",
  "画图",
  "搜图",
  "ni重置",
];

type TimelineItem =
  | { kind: "date"; key: string; label: string }
  | {
      kind: "group";
      key: string;
      role: ChatRole;
      messages: ChatMessage[];
      ts: number;
    };

type ViewerState = {
  src: string | null;
  loading: boolean;
  error: string | null;
  animated: boolean;
};

function statusFromError(kind: string, error: string): ChatStatus {
  if (kind === "auth") return { state: "auth", detail: error };
  if (kind === "server" && error.includes("未安装")) {
    return { state: "bridge-missing", detail: error };
  }
  return { state: "offline", detail: error };
}

function normalizeCommand(text: string): string {
  return text.trim().replace(/\s+/g, " ").replace(/^\//, "").toLowerCase();
}

function isDangerousCommand(text: string): boolean {
  const body = normalizeCommand(text);
  if (!body) return false;
  const [root, sub = ""] = body.split(" ");
  if (DANGEROUS_ROOTS.has(root)) return true;
  const subs = DANGEROUS_SUBCOMMANDS[root];
  if (sub && subs?.has(sub)) return true;
  return DANGEROUS_KEYWORDS.some((word) => body.includes(word.toLowerCase()));
}

function dayStart(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dateLabel(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "未知时间";
  const date = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diff = Math.round((today - day) / 86_400_000);
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function timeLabel(ts: number, approximate = false): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const date = new Date(ts);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${approximate ? "约 " : ""}${hh}:${mm}`;
}

function dateTimeLabel(ts?: number): string {
  if (!ts || !Number.isFinite(ts) || ts <= 0) return "—";
  const date = new Date(ts);
  return `${date.getMonth() + 1}/${date.getDate()} ${timeLabel(ts)}`;
}

function buildTimeline(messages: ChatMessage[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let currentDay: number | null = null;
  let group: Extract<TimelineItem, { kind: "group" }> | null = null;
  for (const message of messages) {
    const day = message.ts > 0 ? dayStart(message.ts) : -1;
    if (day !== currentDay) {
      items.push({
        kind: "date",
        key: `d-${day}-${items.length}`,
        label: dateLabel(message.ts),
      });
      currentDay = day;
      group = null;
    }
    const last = group?.messages[group.messages.length - 1];
    if (
      group &&
      last &&
      group.role === message.role &&
      message.ts >= last.ts &&
      message.ts - last.ts <= GROUP_WINDOW_MS
    ) {
      group.messages.push(message);
      continue;
    }
    group = {
      kind: "group",
      key: `g-${message.id}-${items.length}`,
      role: message.role,
      messages: [message],
      ts: message.ts,
    };
    items.push(group);
  }
  return items;
}

function normalizeChatCommand(input: ChatCommand): ChatCommand {
  const command = input as Partial<ChatCommand> & {
    aliases?: unknown;
    subcommands?: unknown;
  };
  return {
    ...input,
    name: typeof command.name === "string" ? command.name : "",
    aliases: Array.isArray(command.aliases)
      ? command.aliases.filter((alias): alias is string => typeof alias === "string")
      : [],
    description: typeof command.description === "string" ? command.description : "",
    permission: typeof command.permission === "string" ? command.permission : "",
    plugin: typeof command.plugin === "string" ? command.plugin : "",
    dangerous: command.dangerous === true,
    subcommands: Array.isArray(command.subcommands)
      ? command.subcommands.map((sub) => normalizeChatCommand(sub as ChatCommand))
      : [],
  };
}

function flattenCommands(data: ChatCommandsData | null): ChatCommand[] {
  const result: ChatCommand[] = [];
  const seen = new Set<string>();
  const add = (input: ChatCommand) => {
    const command = normalizeChatCommand(input);
    if (!command.name || seen.has(command.name)) return;
    seen.add(command.name);
    result.push(command);
    for (const sub of command.subcommands) add(sub);
  };
  for (const command of data?.commands ?? []) add(command);
  return result.sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

function filterCommands(list: ChatCommand[], draft: string): ChatCommand[] {
  const raw = draft.trimStart();
  if (!raw.startsWith("/") || raw.includes("\n")) return [];
  const query = raw.toLowerCase();
  return list
    .filter((command) => {
      if (command.name.toLowerCase().startsWith(query)) return true;
      const aliases = Array.isArray(command.aliases) ? command.aliases : [];
      return aliases.some(
        (alias) =>
          typeof alias === "string" && alias.toLowerCase().startsWith(query),
      );
    })
    .slice(0, 20);
}

function isStickerMessage(message: ChatMessage): boolean {
  if (message.role !== "assistant") return false;
  if ((message.attachments?.length ?? 0) === 0) return false;
  const text = message.text.trim();
  return !text || /^\[(图片|表情|表情包)\]$/.test(text);
}

function mergeUnique(base: ChatMessage[], extra: ChatMessage[]): ChatMessage[] {
  const ids = new Set(base.filter((message) => message.id !== 0).map((message) => message.id));
  const result = [...base];
  for (const message of extra) {
    if (message.id !== 0 && ids.has(message.id)) continue;
    if (message.id !== 0) ids.add(message.id);
    result.push(message);
  }
  return result;
}

function Icon({
  children,
  size = 16,
  viewBox = "0 0 24 24",
}: {
  children: ReactNode;
  size?: number;
  viewBox?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const icons = {
  close: (
    <Icon>
      <path d="M6 6l12 12M18 6L6 18" />
    </Icon>
  ),
  minimize: (
    <Icon>
      <path d="M5 12h14" />
    </Icon>
  ),
  pin: (
    <Icon>
      <path d="M9 4h6l-1 6 4 4H6l4-4-1-6z" />
      <path d="M12 14v6" />
    </Icon>
  ),
  heart: (
    <Icon>
      <path d="M12 20s-7-4.35-7-9.5A3.9 3.9 0 0 1 12 7a3.9 3.9 0 0 1 7 3.5C19 15.65 12 20 12 20z" />
    </Icon>
  ),
  expand: (
    <Icon>
      <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
    </Icon>
  ),
  collapse: (
    <Icon>
      <path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5" />
    </Icon>
  ),
  chat: (
    <Icon>
      <path d="M4 5h16v10H9l-5 4V5z" />
    </Icon>
  ),
  gear: (
    <Icon>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.27.63.88 1.04 1.55 1.06H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" />
    </Icon>
  ),
  refresh: (
    <Icon>
      <path d="M20 11a8 8 0 1 0-2.34 5.66" />
      <path d="M20 4v7h-7" />
    </Icon>
  ),
  edit: (
    <Icon>
      <path d="M4 20h4l10-10-4-4L4 16v4z" />
      <path d="M13.5 6.5l4 4" />
    </Icon>
  ),
  image: (
    <Icon>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M4 18l5-5 3 3 3-3 5 5" />
    </Icon>
  ),
  sun: (
    <Icon>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
    </Icon>
  ),
  moon: (
    <Icon>
      <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />
    </Icon>
  ),
  trash: (
    <Icon>
      <path d="M4 7h16" />
      <path d="M9 7V5h6v2" />
      <path d="M6 7l1 13h10l1-13" />
    </Icon>
  ),
  folder: (
    <Icon>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </Icon>
  ),
  down: (
    <Icon>
      <path d="M12 5v14M5 12l7 7 7-7" />
    </Icon>
  ),
};

function IconButton({
  label,
  onClick,
  children,
  active = false,
  danger = false,
  className = "",
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
  danger?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`${styles.iconButton}${active ? ` ${styles.iconActive}` : ""}${
        danger ? ` ${styles.iconDanger}` : ""
      }${className ? ` ${className}` : ""}`}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active || undefined}
      data-tip={label}
    >
      {children}
    </button>
  );
}

function AttachmentImage({
  attachment,
  live,
  sticker,
  onOpen,
}: {
  attachment: ChatAttachment;
  live: boolean;
  sticker: boolean;
  onOpen: (attachment: ChatAttachment, live: boolean) => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    const kind = live && attachment.animated ? "original" : "thumb";
    void window.petApi
      .chatMedia(attachment.media, kind)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setSrc(result.dataUrl);
        else setFailed(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.media, attachment.animated, live]);

  return (
    <button
      type="button"
      className={sticker ? styles.stickerButton : styles.inlineImageButton}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(attachment, live);
      }}
      aria-label="查看原图"
      title="点击查看原图"
    >
      {src ? (
        <img
          className={sticker ? styles.stickerImage : styles.inlineImage}
          src={src}
          alt="图片"
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : (
        <span
          className={sticker ? styles.stickerPlaceholder : styles.imagePlaceholder}
        >
          {failed ? "图片加载失败" : "加载中…"}
        </span>
      )}
    </button>
  );
}

function MessageContent({
  message,
  full,
  onOpen,
  onOpenDirect,
}: {
  message: ChatMessage;
  full: boolean;
  onOpen: (attachment: ChatAttachment, live: boolean) => void;
  onOpenDirect: (url: string) => void;
}) {
  const attachments = message.attachments ?? [];
  const assistant = message.role === "assistant";
  const sticker = isStickerMessage(message);
  const text = sticker ? "" : message.text;
  const directImage = attachments.length === 0 ? message.image : null;

  if (sticker) {
    return (
      <div className={styles.stickerWrap}>
        {attachments.map((attachment, index) => (
          <AttachmentImage
            key={`${attachment.media}-${index}`}
            attachment={attachment}
            live={message.live === true}
            sticker
            onOpen={onOpen}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={`${styles.bubble} ${
        assistant ? styles.bubbleAssistant : styles.bubbleUser
      } ${full ? styles.bubbleFull : styles.bubbleCompact}${
        message.pending ? ` ${styles.bubblePending}` : ""
      }`}
    >
      {text ? <span className={styles.bubbleText}>{text}</span> : null}
      {directImage ? (
        <button
          type="button"
          className={styles.inlineImageButton}
          onClick={(event) => {
            event.stopPropagation();
            onOpenDirect(directImage);
          }}
          aria-label="查看图片"
          title="点击查看图片"
        >
          <img
            className={styles.inlineImage}
            src={directImage}
            alt="屏幕截图"
            draggable={false}
          />
        </button>
      ) : null}
      {attachments.length > 0 ? (
        <div className={styles.imageStack}>
          {attachments.map((attachment, index) => (
            <AttachmentImage
              key={`${attachment.media}-${index}`}
              attachment={attachment}
              live={message.live === true}
              sticker={false}
              onOpen={onOpen}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MessageGroup({
  group,
  full,
  profile,
  onOpen,
  onOpenDirect,
}: {
  group: Extract<TimelineItem, { kind: "group" }>;
  full: boolean;
  profile: ChatProfileData;
  onOpen: (attachment: ChatAttachment, live: boolean) => void;
  onOpenDirect: (url: string) => void;
}) {
  const assistant = group.role === "assistant";
  const entry = assistant ? profile.hiro : profile.me;
  return (
    <div
      className={`${styles.group} ${
        assistant ? styles.groupAssistant : styles.groupUser
      } ${full ? styles.groupFull : styles.groupCompact}`}
    >
      {full ? (
        <img
          className={styles.avatar}
          src={avatarOf(entry)}
          alt={entry.name}
          draggable={false}
        />
      ) : null}
      <div className={styles.groupBody}>
        {full ? (
          <div className={styles.groupMeta}>
            <span className={styles.groupName}>{entry.name}</span>
            <time className={styles.groupTime}>
              {timeLabel(group.ts, group.messages[0]?.approximate)}
            </time>
          </div>
        ) : null}
        {group.messages.map((message, index) => (
          <div
            className={`${styles.messageRow} ${
              assistant ? styles.messageRowAssistant : styles.messageRowUser
            }`}
            key={`${message.id}-${index}`}
          >
            <MessageContent
              message={message}
              full={full}
              onOpen={onOpen}
              onOpenDirect={onOpenDirect}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusPanel({
  data,
  loading,
  notifications,
  onToggleNotifications,
  onRefresh,
  onClose,
  onOpenSettings,
}: {
  data: ChatStatusData | null;
  loading: boolean;
  notifications: boolean;
  onToggleNotifications: (enabled: boolean) => void;
  onRefresh: () => void;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const emotions = useMemo(() => {
    const map = new Map<string, ChatMoodEmotion>();
    for (const emotion of data?.emotions ?? []) map.set(emotion.name, emotion);
    return EMOTION_ORDER.map((name) => ({
      name,
      detail: map.get(name),
      meta: EMOTION_META[name] ?? { color: "#c8102e" },
    }));
  }, [data]);

  const affection = data?.affection ?? null;
  const affectionPercent =
    affection && affection.cap > 0
      ? Math.max(0, Math.min(100, (affection.value / affection.cap) * 100))
      : 0;

  return (
    <aside className={styles.panel} aria-label="希罗的状态">
      <header className={styles.panelHead}>
        <div>
          <h2>状态</h2>
          <span className={styles.panelUpdated}>
            {data?.updatedAt ? `更新于 ${dateTimeLabel(data.updatedAt)}` : ""}
          </span>
        </div>
        <div className={styles.panelActions}>
          <button
            type="button"
            className={`${styles.panelIcon}${loading ? ` ${styles.spinning}` : ""}`}
            onClick={onRefresh}
            aria-label="刷新状态"
            title="刷新状态"
          >
            {icons.refresh}
          </button>
          <button
            type="button"
            className={styles.panelIcon}
            onClick={onClose}
            aria-label="收起状态面板"
            title="收起状态面板"
          >
            {icons.close}
          </button>
        </div>
      </header>

      <div className={styles.panelScroll}>
        {!data ? (
          <div className={styles.panelEmpty}>
            {loading ? "正在读取希罗的状态……" : "还没有状态数据。"}
          </div>
        ) : !data.available ? (
          <div className={styles.panelEmpty}>
            {data.error || "心情数据暂时读不到。"}
          </div>
        ) : (
          <>
            <section className={styles.panelSection}>
              <h3>好感</h3>
              {affection ? (
                <>
                  <div className={styles.affectionTop}>
                    <strong>{affection.value}</strong>
                    <span className={styles.affectionCap}>/ {affection.cap}</span>
                    <span className={styles.stageChip}>{affection.stage}</span>
                  </div>
                  <div className={styles.affectionTrack} aria-hidden="true">
                    <span style={{ width: `${affectionPercent}%` }} />
                  </div>
                  <div className={styles.affectionMeta}>
                    <span className={styles.gain}>今日 +{affection.gainToday}</span>
                    <span className={styles.loss}>-{affection.lossToday}</span>
                    <span>上限 {affection.gainCapToday}</span>
                  </div>
                  <div className={styles.chips}>
                    {affection.partner ? (
                      <span className={`${styles.chip} ${styles.chipPartner}`}>伴侣</span>
                    ) : null}
                    {affection.coldWar ? (
                      <span className={`${styles.chip} ${styles.chipCold}`}>冷战中</span>
                    ) : null}
                    {affection.breakupPending ? (
                      <span className={`${styles.chip} ${styles.chipWarn}`}>分手待确认</span>
                    ) : null}
                  </div>
                  {affection.coldWar ? (
                    <p className={styles.reason}>
                      {affection.coldWarReason
                        ? `冷战原因：${affection.coldWarReason}`
                        : "正在冷战，先别急着哄。"}
                      {affection.coldWarSince
                        ? ` · ${dateTimeLabel(affection.coldWarSince)} 开始`
                        : ""}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className={styles.muted}>还没有建立好感度。</p>
              )}
            </section>

            <section className={styles.panelSection}>
              <h3>心情</h3>
              <div className={styles.emotions}>
                {emotions.map(({ name, detail, meta }) => {
                  const value = Math.max(0, Math.min(1, detail?.intensity ?? 0));
                  return (
                    <div
                      className={styles.emotion}
                      key={name}
                      title={detail?.reason || undefined}
                    >
                      <div className={styles.emotionHead}>
                        <span>{name}</span>
                        <span>{Math.round(value * 100)}%</span>
                      </div>
                      <div className={styles.emotionTrack}>
                        <span
                          style={{
                            width: `${value * 100}%`,
                            background: meta.color,
                          }}
                        />
                      </div>
                      {detail?.reason && value > 0.02 ? (
                        <p className={styles.emotionReason}>{detail.reason}</p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>

            <section className={styles.panelSection}>
              <h3>心里话</h3>
              {data.lastThought ? (
                <blockquote className={styles.thought}>
                  “{data.lastThought}”
                  {data.thoughtAt ? (
                    <span>{dateTimeLabel(data.thoughtAt)}</span>
                  ) : null}
                </blockquote>
              ) : (
                <p className={styles.muted}>还没有心里话。</p>
              )}
            </section>

            <section className={styles.panelSection}>
              <h3>最近对话</h3>
              {data.recent && data.recent.length > 0 ? (
                <div className={styles.recentList}>
                  {[...data.recent].reverse().map((row, index) => (
                    <div className={styles.recentRow} key={`${row.ts}-${index}`}>
                      <time>{dateTimeLabel(row.ts)}</time>
                      {row.user ? (
                        <p>
                          <span className={styles.recentUser}>他</span>
                          {row.user}
                        </p>
                      ) : null}
                      {row.assistant ? (
                        <p>
                          <span className={styles.recentHiro}>希罗</span>
                          {row.assistant}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <p className={styles.muted}>还没有对话摘要。</p>
              )}
            </section>
          </>
        )}
      </div>

      <footer className={styles.panelFoot}>
        <label className={styles.notifyRow}>
          <span>桌面通知</span>
          <button
            type="button"
            role="switch"
            aria-checked={notifications}
            className={`${styles.smallSwitch}${notifications ? ` ${styles.smallSwitchOn}` : ""}`}
            onClick={() => onToggleNotifications(!notifications)}
          >
            <span className={styles.switchTrack} aria-hidden="true">
              <span className={styles.switchThumb} />
            </span>
          </button>
        </label>
        <button type="button" className={styles.panelSettings} onClick={onOpenSettings}>
          {icons.gear}
          打开控制面板
        </button>
      </footer>
    </aside>
  );
}

function ProfileMenu({
  role,
  entry,
  x,
  y,
  onClose,
  onEditAvatar,
  onEditName,
  onResetAvatar,
  onResetName,
}: {
  role: ChatProfileRole;
  entry: ChatProfileEntry;
  x: number;
  y: number;
  onClose: () => void;
  onEditAvatar: () => void;
  onEditName: () => void;
  onResetAvatar: () => void;
  onResetName: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const left = Math.max(8, Math.min(x, window.innerWidth - 208));
  const top = Math.max(8, Math.min(y, window.innerHeight - 200));
  const defaultName = role === "hiro" ? "希罗" : "我";

  return (
    <div
      className={styles.profileMenu}
      style={{ left, top }}
      role="menu"
      aria-label={`${profileRoleName(role)}的资料`}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className={styles.profileMenuHead}>
        <img className={styles.profileMenuAvatar} src={avatarOf(entry)} alt="" draggable={false} />
        <div>
          <strong>{entry.name}</strong>
          <span>{role === "hiro" ? "角色资料" : "本机资料"}</span>
        </div>
      </div>
      <button type="button" role="menuitem" onClick={onEditAvatar}>
        {icons.image}
        修改头像
      </button>
      <button type="button" role="menuitem" onClick={onEditName}>
        {icons.edit}
        修改名称
      </button>
      {entry.avatar ? (
        <button type="button" role="menuitem" onClick={onResetAvatar}>
          {icons.refresh}
          恢复默认头像
        </button>
      ) : null}
      {entry.name !== defaultName ? (
        <button type="button" role="menuitem" onClick={onResetName}>
          {icons.refresh}
          恢复默认名称
        </button>
      ) : null}
    </div>
  );
}

function NameEditor({
  role,
  entry,
  onClose,
  onSaved,
  onError,
}: {
  role: ChatProfileRole;
  entry: ChatProfileEntry;
  onClose: () => void;
  onSaved: (data: ChatProfileData) => void;
  onError: (message: string) => void;
}) {
  const [value, setValue] = useState(entry.name);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    const name = value.trim();
    if (!name || busy) return;
    if (name === entry.name) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      const result = await window.petApi.chatProfileName(role, name);
      if (!result) {
        onError("改名失败，请稍后再试。");
        return;
      }
      if ("error" in result) {
        onError(result.error);
        return;
      }
      onSaved(result);
      onClose();
    } catch {
      onError("改名失败，请稍后再试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.modalBackdrop} onMouseDown={onClose}>
      <div
        className={`${styles.modal} ${styles.editorModal}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-name-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="chat-name-title">修改名称</h2>
        <p className={styles.editorHint}>
          输入要新名称，例如“艾玛的专属小笨狗”
        </p>
        <input
          ref={inputRef}
          className={styles.textInput}
          value={value}
          maxLength={16}
          placeholder="输入新的名称"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className={styles.editorMeta}>
          <span>{[...value.trim()].length} / 16</span>
          <span>只影响本机显示</span>
        </div>
        <div className={styles.modalActions}>
          <button type="button" className={styles.modalCancel} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className={styles.modalConfirm}
            onClick={() => void submit()}
            disabled={!value.trim() || busy}
          >
            {busy ? "保存中" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AvatarEditor({
  role,
  entry,
  onClose,
  onSaved,
  onError,
}: {
  role: ChatProfileRole;
  entry: ChatProfileEntry;
  onClose: () => void;
  onSaved: (data: ChatProfileData) => void;
  onError: (message: string) => void;
}) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [history, setHistory] = useState<
    { id: string; src: string; createdAt: number }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [empty, setEmpty] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const baseScale = image
    ? Math.max(AVATAR_SIZE / image.width, AVATAR_SIZE / image.height)
    : 1;
  const scale = baseScale * zoom;
  const maxX = image ? Math.max(0, (image.width * scale - AVATAR_SIZE) / 2) : 0;
  const maxY = image ? Math.max(0, (image.height * scale - AVATAR_SIZE) / 2) : 0;

  useEffect(() => {
    void window.petApi
      .chatProfileHistory(role)
      .then((rows) => setHistory(rows))
      .catch(() => undefined);
  }, [role]);

  const loadSource = useCallback((src: string) => {
    const img = new Image();
    img.onload = () => {
      setImage(img);
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      setEmpty(false);
    };
    img.onerror = () => setEmpty(true);
    img.src = src;
  }, []);

  useEffect(() => {
    loadSource(avatarOf(entry));
  }, [entry, loadSource]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const width = image.width * scale;
    const height = image.height * scale;
    ctx.clearRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
    ctx.save();
    ctx.beginPath();
    ctx.arc(AVATAR_SIZE / 2, AVATAR_SIZE / 2, AVATAR_SIZE / 2 - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(
      image,
      AVATAR_SIZE / 2 + offset.x - width / 2,
      AVATAR_SIZE / 2 + offset.y - height / 2,
      width,
      height,
    );
    ctx.restore();
  }, [image, scale, offset.x, offset.y]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom((prev) => Math.min(4, Math.max(1, prev - event.deltaY * 0.0012)));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  const clampOffset = (x: number, y: number, nextMaxX = maxX, nextMaxY = maxY) => ({
    x: Math.max(-nextMaxX, Math.min(nextMaxX, x)),
    y: Math.max(-nextMaxY, Math.min(nextMaxY, y)),
  });

  // 缩放变化后把偏移收回到合法范围，避免露出裁剪框外的空白。
  useEffect(() => {
    setOffset((prev) => {
      const next = clampOffset(prev.x, prev.y);
      return next.x === prev.x && next.y === prev.y ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxX, maxY]);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      ox: offset.x,
      oy: offset.y,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setOffset(
      clampOffset(
        drag.ox + event.clientX - drag.x,
        drag.oy + event.clientY - drag.y,
      ),
    );
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // 指针已经释放时忽略。
      }
    }
    dragRef.current = null;
  };

  const readFile = (file: File | undefined) => {
    if (!file) return;
    if (!/^image\//i.test(file.type)) {
      onError("只能选图片文件。");
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      onError("图片太大了，换一张 12MB 以内的吧。");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") loadSource(reader.result);
    };
    reader.onerror = () => onError("读取图片失败。");
    reader.readAsDataURL(file);
  };

  const save = async () => {
    if (!image || busy) return;
    const output = document.createElement("canvas");
    output.width = AVATAR_OUTPUT;
    output.height = AVATAR_OUTPUT;
    const ctx = output.getContext("2d");
    if (!ctx) {
      onError("浏览器不支持裁剪。");
      return;
    }
    const ratio = AVATAR_OUTPUT / AVATAR_SIZE;
    const width = image.width * scale * ratio;
    const height = image.height * scale * ratio;
    ctx.save();
    ctx.beginPath();
    ctx.arc(AVATAR_OUTPUT / 2, AVATAR_OUTPUT / 2, AVATAR_OUTPUT / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(
      image,
      (AVATAR_SIZE / 2 + offset.x) * ratio - width / 2,
      (AVATAR_SIZE / 2 + offset.y) * ratio - height / 2,
      width,
      height,
    );
    ctx.restore();
    setBusy(true);
    try {
      const result = await window.petApi.chatProfileAvatar(
        role,
        output.toDataURL("image/png"),
      );
      if (!result) {
        onError("保存头像失败。");
        return;
      }
      if ("error" in result) {
        onError(result.error);
        return;
      }
      onSaved(result);
      onClose();
    } catch {
      onError("保存头像失败。");
    } finally {
      setBusy(false);
    }
  };

  const useHistory = async (id: string) => {
    try {
      const result = await window.petApi.chatProfileAvatarSelect(role, id);
      if (!result || "error" in result) {
        onError(result && "error" in result ? result.error : "切换头像失败。");
        return;
      }
      onSaved(result);
      onClose();
    } catch {
      onError("切换头像失败。");
    }
  };

  const resetAvatar = async () => {
    try {
      const result = await window.petApi.chatProfileAvatarReset(role);
      if (!result || "error" in result) {
        onError(result && "error" in result ? result.error : "恢复默认头像失败。");
        return;
      }
      onSaved(result);
      onClose();
    } catch {
      onError("恢复默认头像失败。");
    }
  };

  return (
    <div className={styles.modalBackdrop} onMouseDown={onClose}>
      <div
        className={`${styles.modal} ${styles.avatarModal}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-avatar-title"
        onMouseDown={(event) => event.stopPropagation()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          readFile(event.dataTransfer.files?.[0]);
        }}
      >
        <h2 id="chat-avatar-title">修改{profileRoleName(role)}的头像</h2>
        <div className={styles.avatarEditorBody}>
          <div className={styles.avatarCrop}>
            <canvas
              ref={canvasRef}
              width={AVATAR_SIZE}
              height={AVATAR_SIZE}
              className={styles.avatarCanvas}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onDoubleClick={() => {
                setZoom(1);
                setOffset({ x: 0, y: 0 });
              }}
              aria-label="裁剪区域：拖动平移，滚轮缩放"
            />
            {empty || !image ? (
              <span className={styles.avatarEmpty}>拖动图片到这里，或点“选择图片”</span>
            ) : null}
          </div>
          <div className={styles.avatarSide}>
            <div className={styles.avatarActions}>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={() => fileRef.current?.click()}
              >
                {icons.image}
                选择图片
              </button>
              <button type="button" className={styles.ghostBtn} onClick={() => void resetAvatar()}>
                恢复默认
              </button>
            </div>
            <p className={styles.avatarHint}>
              拖动平移，滚轮缩放，双击复位。保存后会裁成 256×256 的圆图。
            </p>
            <div className={styles.historyHead}>
              <span>历史头像</span>
              <span>{history.length} 张</span>
            </div>
            {history.length > 0 ? (
              <div className={styles.historyGrid}>
                {history.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={styles.historyItem}
                    onClick={() => void useHistory(item.id)}
                    title={new Date(item.createdAt).toLocaleString("zh-CN")}
                  >
                    <img src={item.src} alt="" draggable={false} />
                  </button>
                ))}
              </div>
            ) : (
              <p className={styles.historyEmpty}>还没有历史头像。</p>
            )}
          </div>
        </div>
        <div className={styles.modalActions}>
          <button type="button" className={styles.modalCancel} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className={styles.modalConfirm}
            onClick={() => void save()}
            disabled={!image || busy}
          >
            {busy ? "保存中" : "保存"}
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className={styles.hiddenInput}
          onChange={(event) => {
            readFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

function SettingsPanel({
  ui,
  storage,
  diagnostics,
  autoLaunch,
  backgroundImage,
  onClose,
  onTheme,
  onFontScale,
  onLineHeight,
  onBackground,
  onUploadBackground,
  onClearBackground,
  onSavePreset,
  onDeletePreset,
  onToggleNotifications,
  onTogglePinned,
  onToggleAutoLaunch,
  onChooseStorage,
  onDefaultStorage,
  onOpenFolder,
  onClearStorage,
  onOpenControlPanel,
  onToast,
}: {
  ui: ChatUiState;
  storage: ChatStorageInfo | null;
  diagnostics: ChatDiagnostics | null;
  autoLaunch: boolean;
  backgroundImage: string | null;
  onClose: () => void;
  onTheme: (theme: ChatTheme) => void;
  onFontScale: (scale: ChatFontScale) => void;
  onLineHeight: (height: ChatLineHeight) => void;
  onBackground: (patch: ChatBackgroundPatch) => void;
  onUploadBackground: (file: File) => void;
  onClearBackground: () => void;
  onSavePreset: (name: string) => Promise<boolean>;
  onDeletePreset: (id: string) => void;
  onToggleNotifications: (enabled: boolean) => void;
  onTogglePinned: (pinned: boolean) => void;
  onToggleAutoLaunch: (enabled: boolean) => void;
  onChooseStorage: () => void;
  onDefaultStorage: () => void;
  onOpenFolder: (kind: "cache" | "config" | "profile") => void;
  onClearStorage: () => void;
  onOpenControlPanel: () => void;
  onToast: (message: string) => void;
}) {
  const [presetName, setPresetName] = useState("");
  const [savingPreset, setSavingPreset] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const backgroundFileRef = useRef<HTMLInputElement | null>(null);

  const theme = ui.theme;
  const chatOpacity = ui.background.chatOpacity ?? 60;
  const apply = (patch: Partial<ChatTheme>) => {
    onTheme({ ...theme, ...patch, presetId: patch.presetId ?? null });
  };

  const savePreset = async () => {
    const name = presetName.trim();
    if (!name || savingPreset) return;
    setSavingPreset(true);
    try {
      const ok = await onSavePreset(name);
      if (ok) setPresetName("");
    } finally {
      setSavingPreset(false);
    }
  };

  const copyDiagnostics = async () => {
    if (!diagnostics) return;
    const text = [
      `桌面版本：${diagnostics.appVersion}`,
      `Electron ${diagnostics.electron} / Chromium ${diagnostics.chrome}`,
      `平台：${diagnostics.platform}`,
      `桥接状态：${STATUS_TEXT[diagnostics.status.state]}${diagnostics.status.detail ? `（${diagnostics.status.detail}）` : ""}`,
      `服务器：${diagnostics.hosts.join(" / ")}:${diagnostics.port}`,
      `epoch：${diagnostics.epoch || "—"}`,
      `cursor：${diagnostics.cursor}`,
      `存储：${storage?.dir ?? "—"}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      onToast("诊断信息已复制");
    } catch {
      onToast("复制失败，可以手动截图");
    }
  };

  return (
    <aside className={styles.panel} aria-label="聊天设置">
      <header className={styles.panelHead}>
        <div>
          <h2>设置</h2>
          <span className={styles.panelUpdated}>外观、通知与本地数据</span>
        </div>
        <div className={styles.panelActions}>
          <button
            type="button"
            className={styles.panelIcon}
            onClick={onClose}
            aria-label="收起设置面板"
            title="收起设置面板"
          >
            {icons.close}
          </button>
        </div>
      </header>

      <div className={styles.panelScroll}>
        <section className={styles.panelSection}>
          <h3>外观</h3>
          <div className={styles.settingsRow}>
            <span className={styles.settingsLabel}>明暗</span>
            <div className={styles.segmented}>
              <button
                type="button"
                data-active={theme.mode === "day" || undefined}
                onClick={() => apply({ mode: "day" })}
              >
                {icons.sun}
                日间
              </button>
              <button
                type="button"
                data-active={theme.mode === "night" || undefined}
                onClick={() => apply({ mode: "night" })}
              >
                {icons.moon}
                夜间
              </button>
            </div>
          </div>
          <div className={styles.settingsRow}>
            <span className={styles.settingsLabel}>主题色</span>
            <span className={styles.accentValue}>{theme.accent}</span>
          </div>
          <div className={styles.swatchRow}>
            {ACCENT_SWATCHES.map((swatch) => (
              <button
                key={swatch.color}
                type="button"
                className={styles.swatch}
                style={{ background: swatch.color }}
                data-active={
                  swatch.color.toLowerCase() === theme.accent.toLowerCase() || undefined
                }
                title={swatch.name}
                aria-label={swatch.name}
                onClick={() => apply({ accent: swatch.color })}
              />
            ))}
            <label className={styles.swatchCustom} title="自定义颜色">
              <input
                type="color"
                value={theme.accent}
                onChange={(event) => apply({ accent: event.target.value })}
                aria-label="自定义主题色"
              />
              <span>+</span>
            </label>
          </div>

          <div className={styles.presetHead}>
            <span>色彩预设</span>
            <span>日/夜 + 主题色</span>
          </div>
          <div className={styles.presetList}>
            {ui.themePresets.map((preset) => {
              const active = theme.presetId === preset.id;
              return (
                <div
                  key={preset.id}
                  className={`${styles.presetItem}${active ? ` ${styles.presetItemActive}` : ""}`}
                >
                  <button
                    type="button"
                    className={styles.presetApply}
                    onClick={() =>
                      onTheme({
                        mode: preset.mode,
                        accent: preset.accent,
                        presetId: preset.id,
                      })
                    }
                  >
                    <span
                      className={styles.presetDot}
                      style={{ background: preset.accent }}
                      aria-hidden="true"
                    />
                    <span className={styles.presetName}>{preset.name}</span>
                    <span className={styles.presetMeta}>
                      {preset.mode === "day" ? "日间" : "夜间"}
                    </span>
                  </button>
                  {preset.builtin ? (
                    <span className={styles.presetLock}>内置</span>
                  ) : (
                    <button
                      type="button"
                      className={styles.presetDelete}
                      onClick={() => onDeletePreset(preset.id)}
                      aria-label={`删除预设 ${preset.name}`}
                      title="删除预设"
                    >
                      {icons.trash}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <div className={styles.presetSave}>
            <input
              value={presetName}
              maxLength={12}
              placeholder="预设名称，例如 夜樱"
              onChange={(event) => setPresetName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void savePreset();
                }
              }}
            />
            <button
              type="button"
              onClick={() => void savePreset()}
              disabled={!presetName.trim() || savingPreset}
            >
              {savingPreset ? "保存中" : "存为预设"}
            </button>
          </div>
        </section>

        <section className={styles.panelSection}>
          <h3>背景</h3>
          <div className={styles.sliderRow}>
            <span className={styles.settingsLabel}>聊天背景不透明度</span>
            <span className={styles.sliderValue}>{chatOpacity}%</span>
          </div>
          <input
            type="range"
            className={styles.range}
            min={0}
            max={100}
            step={1}
            value={chatOpacity}
            onChange={(event) =>
              onBackground({ chatOpacity: Number(event.target.value) })
            }
            aria-label="聊天背景不透明度"
          />
          <div className={styles.sliderRow}>
            <span className={styles.settingsLabel}>面板背景不透明度</span>
            <span className={styles.sliderValue}>{ui.background.panelOpacity}%</span>
          </div>
          <input
            type="range"
            className={styles.range}
            min={0}
            max={100}
            step={1}
            value={ui.background.panelOpacity}
            onChange={(event) =>
              onBackground({ panelOpacity: Number(event.target.value) })
            }
            aria-label="面板背景不透明度"
          />

          <div className={styles.bgHead}>
            <span>自定义背景</span>
            <span>{backgroundImage ? "已设置" : "未设置"}</span>
          </div>
          <div className={styles.panelBtnRow}>
            <button
              type="button"
              onClick={() => backgroundFileRef.current?.click()}
            >
              {icons.image}
              {backgroundImage ? "更换图片" : "选择图片"}
            </button>
            {backgroundImage ? (
              <button type="button" onClick={onClearBackground}>
                清除背景
              </button>
            ) : null}
          </div>
          {backgroundImage ? (
            <img
              className={styles.bgPreview}
              src={backgroundImage}
              alt="自定义背景预览"
              draggable={false}
            />
          ) : (
            <p className={styles.historyEmpty}>
              选一张图作为聊天区背景；不透明度越低，图片越明显。
            </p>
          )}
          <label className={styles.notifyRow}>
            <span>拓展到全部</span>
            <button
              type="button"
              role="switch"
              aria-checked={ui.background.extend}
              disabled={!backgroundImage}
              className={`${styles.smallSwitch}${ui.background.extend ? ` ${styles.smallSwitchOn}` : ""}`}
              onClick={() => onBackground({ extend: !ui.background.extend })}
            >
              <span className={styles.switchTrack} aria-hidden="true">
                <span className={styles.switchThumb} />
              </span>
            </button>
          </label>
          <p className={styles.storageHint}>
            关闭时只铺聊天区；打开后铺满标题栏、左栏、右侧面板和输入区，主题暗层仍按两个滑块叠加。
          </p>
          <input
            ref={backgroundFileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className={styles.hiddenInput}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onUploadBackground(file);
              event.target.value = "";
            }}
          />
        </section>

        <section className={styles.panelSection}>
          <h3>消息</h3>
          <div className={styles.settingsRow}>
            <span className={styles.settingsLabel}>字号</span>
            <div className={styles.segmented}>
              {(["sm", "md", "lg"] as ChatFontScale[]).map((scale) => (
                <button
                  key={scale}
                  type="button"
                  data-active={ui.fontScale === scale || undefined}
                  onClick={() => onFontScale(scale)}
                >
                  {FONT_SCALE_LABEL[scale]}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.settingsRow}>
            <span className={styles.settingsLabel}>行距</span>
            <div className={styles.segmented}>
              {(["compact", "normal", "loose"] as ChatLineHeight[]).map((height) => (
                <button
                  key={height}
                  type="button"
                  data-active={ui.lineHeight === height || undefined}
                  onClick={() => onLineHeight(height)}
                >
                  {LINE_HEIGHT_LABEL[height]}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.panelSection}>
          <h3>通知与窗口</h3>
          {[
            {
              label: "桌面通知",
              value: ui.notifications,
              action: onToggleNotifications,
            },
            { label: "完整版置顶", value: ui.pinned, action: onTogglePinned },
            { label: "开机自启", value: autoLaunch, action: onToggleAutoLaunch },
          ].map((row) => (
            <label className={styles.notifyRow} key={row.label}>
              <span>{row.label}</span>
              <button
                type="button"
                role="switch"
                aria-checked={row.value}
                className={`${styles.smallSwitch}${row.value ? ` ${styles.smallSwitchOn}` : ""}`}
                onClick={() => row.action(!row.value)}
              >
                <span className={styles.switchTrack} aria-hidden="true">
                  <span className={styles.switchThumb} />
                </span>
              </button>
            </label>
          ))}
        </section>

        <section className={styles.panelSection}>
          <h3>数据与存储</h3>
          {storage ? (
            <>
              <p className={styles.storagePath} title={storage.dir}>
                {storage.dir}
              </p>
              <div className={styles.storageStats}>
                <span>{storage.total} 条消息</span>
                <span>{formatBytes(storage.bytes)}</span>
                <span>{storage.custom ? "自定义目录" : "默认目录"}</span>
              </div>
              <p className={styles.storageDetail}>
                消息 {formatBytes(storage.files.messages)} · 缩略图{" "}
                {formatBytes(storage.files.thumbs)} · 头像{" "}
                {formatBytes(storage.files.avatars)}
              </p>
            </>
          ) : (
            <p className={styles.muted}>正在读取存储信息……</p>
          )}
          <div className={styles.panelBtnRow}>
            <button type="button" onClick={onChooseStorage}>
              {icons.folder}
              更改路径…
            </button>
            <button
              type="button"
              onClick={onDefaultStorage}
              disabled={!storage?.custom}
            >
              恢复默认
            </button>
          </div>
          <div className={styles.panelBtnRow}>
            <button type="button" onClick={() => onOpenFolder("cache")}>
              打开缓存目录
            </button>
            <button type="button" onClick={() => onOpenFolder("profile")}>
              打开头像目录
            </button>
          </div>
          <div className={styles.panelBtnRow}>
            <button type="button" onClick={() => onOpenFolder("config")}>
              打开配置目录
            </button>
            {confirmClear ? (
              <button
                type="button"
                className={styles.dangerBtn}
                onClick={() => {
                  setConfirmClear(false);
                  onClearStorage();
                }}
              >
                确认清空
              </button>
            ) : (
              <button
                type="button"
                className={styles.dangerBtn}
                onClick={() => setConfirmClear(true)}
              >
                清空本地缓存
              </button>
            )}
          </div>
          <p className={styles.storageHint}>
            迁移会先复制到新目录再切换，旧目录保留为备份；头像和设置始终留在配置目录。
          </p>
        </section>

        <section className={styles.panelSection}>
          <h3>关于</h3>
          <dl className={styles.aboutList}>
            <div>
              <dt>桌面版本</dt>
              <dd>v{diagnostics?.appVersion ?? "—"}</dd>
            </div>
            <div>
              <dt>运行环境</dt>
              <dd>
                Electron {diagnostics?.electron ?? "—"} · Chromium{" "}
                {diagnostics?.chrome ?? "—"}
              </dd>
            </div>
            <div>
              <dt>桥接</dt>
              <dd>
                {diagnostics ? STATUS_TEXT[diagnostics.status.state] : "—"}
                {diagnostics?.epoch ? ` · ${diagnostics.epoch.slice(0, 8)}` : ""}
              </dd>
            </div>
            <div>
              <dt>服务器</dt>
              <dd>
                {diagnostics ? `${diagnostics.hosts.join(" / ")}:${diagnostics.port}` : "—"}
              </dd>
            </div>
          </dl>
          <div className={styles.panelBtnRow}>
            <button type="button" onClick={onOpenControlPanel}>
              {icons.gear}
              桌宠控制面板
            </button>
            <button type="button" onClick={() => void copyDiagnostics()}>
              复制诊断
            </button>
          </div>
        </section>
      </div>
    </aside>
  );
}

export function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<ChatStatus>({
    state: "offline",
    detail: "正在连接……",
  });
  const [ui, setUi] = useState<ChatUiState>(() => ({
    mode:
      window.localStorage.getItem(MODE_STORAGE_KEY) === "full"
        ? "full"
        : "compact",
    pinned: false,
    unread: 0,
    notifications: true,
    theme: { mode: "night", accent: "#c8102e", presetId: "hiro" },
    themePresets: [
      { id: "hiro", name: "希罗", mode: "night", accent: "#c8102e", builtin: true },
    ],
    fontScale: "md",
    lineHeight: "normal",
    background: { chatOpacity: null, panelOpacity: 92, extend: false },
  }));
  const [profile, setProfile] = useState<ChatProfileData>(DEFAULT_PROFILE);
  const [backgroundImage, setBackgroundImage] = useState<string | null>(null);
  const [selectedPerson, setSelectedPerson] = useState<ChatProfileRole>("hiro");
  const [profileMenu, setProfileMenu] = useState<{
    role: ChatProfileRole;
    x: number;
    y: number;
  } | null>(null);
  const [editor, setEditor] = useState<{
    kind: "avatar" | "name";
    role: ChatProfileRole;
  } | null>(null);
  const [panelMode, setPanelMode] = useState<"status" | "settings">("status");
  const [storage, setStorage] = useState<ChatStorageInfo | null>(null);
  const [diagnostics, setDiagnostics] = useState<ChatDiagnostics | null>(null);
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [commands, setCommands] = useState<ChatCommandsData | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [captureEnabled, setCaptureEnabled] = useState(false);
  const [displayId, setDisplayId] = useState("");
  const [panelOpen, setPanelOpen] = useState(
    () => window.localStorage.getItem(PANEL_STORAGE_KEY) !== "0",
  );
  const [statusData, setStatusData] = useState<ChatStatusData | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [confirmState, setConfirmState] = useState<{ text: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [noMore, setNoMore] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const [stick, setStick] = useState(true);

  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const initializedRef = useRef(false);
  const pendingRef = useRef<ChatMessage[]>([]);
  const knownIdsRef = useRef<Set<number>>(new Set());
  const loadedCountRef = useRef(0);
  const nearBottomRef = useRef(true);
  const prependRef = useRef<{ height: number; top: number } | null>(null);
  const awaitingRef = useRef(false);
  const sendingRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);
  const statusTimerRef = useRef<number | null>(null);
  const themeTimerRef = useRef<number | null>(null);
  const themePendingRef = useRef<ChatTheme | null>(null);
  const backgroundTimerRef = useRef<number | null>(null);
  const backgroundPendingRef = useRef<ChatBackgroundPatch | null>(null);
  /** 已上屏但还没被桥接确认的消息，等真实消息回来时按文本对账。 */
  const optimisticRef = useRef<{ id: number; text: string }[]>([]);
  const viewerTokenRef = useRef(0);
  const uiRef = useRef(ui);
  const panelOpenRef = useRef(panelOpen);
  const panelModeRef = useRef(panelMode);
  const commandOpenRef = useRef(commandOpen);
  const viewerRef = useRef(viewer);
  const confirmRef = useRef(confirmState);
  const stickRef = useRef(stick);
  const editorRef = useRef(editor);
  const profileMenuRef = useRef(profileMenu);

  uiRef.current = ui;
  panelOpenRef.current = panelOpen;
  panelModeRef.current = panelMode;
  commandOpenRef.current = commandOpen;
  viewerRef.current = viewer;
  confirmRef.current = confirmState;
  stickRef.current = stick;
  editorRef.current = editor;
  profileMenuRef.current = profileMenu;
  loadedCountRef.current = messages.length;

  const full = ui.mode === "full";
  const blocking =
    status.state === "offline" ||
    status.state === "auth" ||
    status.state === "bridge-missing";
  const canSend = !loading && !blocking && !sending;
  const statusText = STATUS_TEXT[status.state];
  const dotClass =
    status.state === "online"
      ? styles.dotOnline
      : status.state === "qq-offline"
        ? styles.dotWarn
        : styles.dotOffline;
  const banner = blocking
    ? status.detail || statusText
    : status.state === "qq-offline"
      ? "QQ 未连接，手机消息暂时同步不过来；桌面聊天仍可用。"
      : null;

  const visibleMessages = useMemo(
    () =>
      full ? messages : messages.slice(-COMPACT_MESSAGE_LIMIT),
    [full, messages],
  );
  const timeline = useMemo(() => buildTimeline(visibleMessages), [visibleMessages]);
  const allCommands = useMemo(() => flattenCommands(commands), [commands]);
  const commandMatches = useMemo(
    () => filterCommands(allCommands, draft),
    [allCommands, draft],
  );
  const selectedCommand =
    commandMatches.length > 0
      ? commandMatches[Math.min(commandIndex, commandMatches.length - 1)]
      : null;
  const hasMore = full && !noMore && messages.length < total;

  const applyUiState = useCallback((state: ChatUiState) => {
    setUi(() => {
      let next = state;
      // 取色器 / 背景滑块还在合并写盘时，别被其它 ui-state 广播拉回旧值。
      const pendingTheme = themePendingRef.current;
      if (pendingTheme && themeTimerRef.current) {
        next = { ...next, theme: pendingTheme };
      }
      const pendingBackground = backgroundPendingRef.current;
      if (pendingBackground) {
        next = {
          ...next,
          background: { ...next.background, ...pendingBackground },
        };
      }
      return next;
    });
    window.localStorage.setItem(MODE_STORAGE_KEY, state.mode);
  }, []);

  const refreshStatus = useCallback(async (force = false) => {
    setStatusLoading(true);
    try {
      const next = await window.petApi.chatStatusData(force);
      if (next) setStatusData(next);
    } catch {
      // 状态面板失败不影响聊天本身。
    } finally {
      setStatusLoading(false);
    }
  }, []);

  const scheduleStatusRefresh = useCallback(() => {
    if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current);
    statusTimerRef.current = window.setTimeout(() => {
      statusTimerRef.current = null;
      if (uiRef.current.mode === "full" && panelOpenRef.current) {
        void refreshStatus(false);
      }
    }, STATUS_DEBOUNCE_MS);
  }, [refreshStatus]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, 2600);
  }, []);

  const applyInitial = useCallback(
    (data: ChatInitialData) => {
      const merged = mergeUnique(data.messages ?? [], pendingRef.current);
      pendingRef.current = [];
      initializedRef.current = true;
      knownIdsRef.current = new Set(
        merged.filter((message) => message.id !== 0).map((message) => message.id),
      );
      loadedCountRef.current = merged.length;
      setMessages(merged);
      setTotal(Math.max(data.total ?? merged.length, merged.length));
      setStatus(data.status);
      applyUiState(data.ui);
      if (data.profile) setProfile(data.profile);
      setBackgroundImage(data.backgroundImage ?? null);
      if (data.commands?.commands?.length) setCommands(data.commands);
      setLoading(false);
      setNoMore(merged.length >= Math.max(data.total ?? merged.length, merged.length));
      nearBottomRef.current = true;
      setStick(true);
      scheduleStatusRefresh();
    },
    [applyUiState, scheduleStatusRefresh],
  );

  const appendMessages = useCallback(
    (incoming: ChatMessage[]) => {
      if (!Array.isArray(incoming) || incoming.length === 0) return;
      if (!initializedRef.current) {
        pendingRef.current.push(...incoming);
        return;
      }
      const fresh = incoming.filter(
        (message) => message.id === 0 || !knownIdsRef.current.has(message.id),
      );
      if (fresh.length === 0) return;

      // 轮询可能比 /send 响应先拿到同一条用户消息：按文本认领乐观消息，
      // 用真实消息替换它，避免出现两个一样的气泡。
      const settledPending = new Set<number>();
      for (const message of fresh) {
        if (message.role !== "user") continue;
        const text = message.text.trim();
        const pending = optimisticRef.current.find((item) => item.text === text);
        if (!pending) continue;
        settledPending.add(pending.id);
        optimisticRef.current = optimisticRef.current.filter(
          (item) => item.id !== pending.id,
        );
      }

      for (const message of fresh) {
        if (message.id !== 0) knownIdsRef.current.add(message.id);
      }
      setMessages((prev) => [
        ...prev.filter((message) => !settledPending.has(message.id)),
        ...fresh.map((message) => ({ ...message, live: true })),
      ]);
      setTotal((prev) =>
        Math.max(0, prev + fresh.length - settledPending.size),
      );
      if (fresh.some((message) => message.role === "assistant")) {
        if (awaitingRef.current) {
          awaitingRef.current = false;
          setWaiting(false);
          setTimedOut(false);
        }
        if (document.hasFocus()) window.petApi.chatMarkRead();
      }
      scheduleStatusRefresh();
    },
    [scheduleStatusRefresh],
  );

  const closeViewer = useCallback(() => {
    viewerTokenRef.current += 1;
    setViewer(null);
  }, []);

  const openAttachment = useCallback(
    (attachment: ChatAttachment, live: boolean) => {
      const token = ++viewerTokenRef.current;
      setViewer({ src: null, loading: true, error: null, animated: false });
      void window.petApi
        .chatMedia(attachment.media, "original")
        .then((result) => {
          if (viewerTokenRef.current !== token) return;
          if (result.ok) {
            setViewer({
              src: result.dataUrl,
              loading: false,
              error: null,
              animated: live && attachment.animated === true,
            });
          } else {
            setViewer({
              src: null,
              loading: false,
              error: result.error || "原图读取失败。",
              animated: false,
            });
          }
        })
        .catch(() => {
          if (viewerTokenRef.current !== token) return;
          setViewer({
            src: null,
            loading: false,
            error: "原图读取失败。",
            animated: false,
          });
        });
    },
    [],
  );

  const openDirect = useCallback((url: string) => {
    viewerTokenRef.current += 1;
    setViewer({ src: url, loading: false, error: null, animated: false });
  }, []);

  const retryConnection = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.petApi.chatRetry();
      if (!result) return;
      if (result.ok) applyInitial(result.data);
      else setStatus(statusFromError(result.kind, result.error));
    } finally {
      setLoading(false);
    }
  }, [applyInitial]);

  const loadOlder = useCallback(async () => {
    if (!full || loadingMoreRef.current || !hasMore) return;
    const first = messages[0];
    if (!first) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const list = listRef.current;
    const height = list?.scrollHeight ?? 0;
    const top = list?.scrollTop ?? 0;
    try {
      const older = await window.petApi.chatLoadMore(first.id, PAGE_SIZE);
      if (older.length === 0) {
        setNoMore(true);
        return;
      }
      const fresh = older.filter(
        (message) => message.id === 0 || !knownIdsRef.current.has(message.id),
      );
      if (fresh.length === 0) {
        setNoMore(true);
        return;
      }
      for (const message of fresh) {
        if (message.id !== 0) knownIdsRef.current.add(message.id);
      }
      prependRef.current = { height, top };
      nearBottomRef.current = false;
      setStick(false);
      setMessages((prev) => [...fresh, ...prev]);
      setTotal((prev) => Math.max(prev, messages.length + fresh.length));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [full, hasMore, messages]);

  const sendText = useCallback(
    async (text: string) => {
      const value = text.trim();
      if (!value || sendingRef.current) return;
      sendingRef.current = true;
      setSending(true);
      setSendError(null);
      setConfirmState(null);
      // 回复可能比 /send 响应先到，先挂上等待标记；界面提示等确认后再切。
      awaitingRef.current = true;
      setWaiting(false);
      setTimedOut(false);

      // 立即清空输入框并上屏，别让消息滞留在输入框里。
      setDraft((prev) => (prev.trim() === value ? "" : prev));
      const tempId = -Date.now();
      optimisticRef.current.push({ id: tempId, text: value });
      setMessages((prev) => [
        ...prev,
        {
          id: tempId,
          ts: Date.now(),
          role: "user",
          origin: "desktop",
          text: value,
          image: null,
          attachments: [],
          live: true,
          pending: true,
        },
      ]);
      setTotal((prev) => prev + 1);
      nearBottomRef.current = true;
      setStick(true);

      const settle = (message: ChatMessage | null, image?: string | null) => {
        const wasPending = optimisticRef.current.some((item) => item.id === tempId);
        optimisticRef.current = optimisticRef.current.filter(
          (item) => item.id !== tempId,
        );
        if (!message) {
          setMessages((prev) => prev.filter((item) => item.id !== tempId));
          if (wasPending) setTotal((prev) => Math.max(0, prev - 1));
          return;
        }
        const exists = message.id !== 0 && knownIdsRef.current.has(message.id);
        if (message.id !== 0) knownIdsRef.current.add(message.id);
        setMessages((prev) => {
          const without = prev.filter((item) => item.id !== tempId);
          if (exists) {
            if (!image) return without;
            return without.map((item) =>
              item.id === message.id && !item.image ? { ...item, image } : item,
            );
          }
          return [
            ...without,
            { ...message, image: image ?? message.image ?? null, live: true },
          ];
        });
        setTotal((prev) =>
          Math.max(0, prev + (exists && wasPending ? -1 : 0)),
        );
      };

      try {
        const result = await window.petApi.chatSend(value, {
          captureScreen: captureEnabled,
          displayId: displayId || undefined,
        });
        if (!result.ok) {
          awaitingRef.current = false;
          settle(null);
          // 用户没在发送期间输入新内容时，把原文放回输入框。
          setDraft((prev) => (prev.trim() ? prev : value));
          setSendError(result.error);
          if (result.kind === "auth" || result.kind === "offline") {
            setStatus(statusFromError(result.kind, result.error));
          }
          return;
        }
        settle(result.data.message ?? null, result.data.screenImage ?? null);
        if (awaitingRef.current) setWaiting(true);
        if (result.data.captureFailed) {
          setSendError("截图失败，已只发送文字。");
        }
        if (/^\/(心情|好感)(\s|$)/.test(value)) {
          window.setTimeout(() => {
            void refreshStatus(true);
          }, 1500);
        }
      } catch {
        awaitingRef.current = false;
        settle(null);
        setDraft((prev) => (prev.trim() ? prev : value));
        setSendError("发送失败，请稍后重试。");
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [captureEnabled, displayId, refreshStatus],
  );

  const submit = useCallback(() => {
    if (!canSend) return;
    const text = draft.trim();
    if (!text) return;
    if (isDangerousCommand(text)) {
      setCommandOpen(false);
      setConfirmState({ text });
      return;
    }
    void sendText(text);
  }, [canSend, draft, sendText]);

  const selectCommand = useCallback((command: ChatCommand) => {
    setDraft(`${command.name} `);
    setCommandOpen(false);
    setCommandIndex(0);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const togglePanel = useCallback(() => {
    if (uiRef.current.mode !== "full") {
      showToast("查看请切换完整版UI");
      return;
    }
    if (panelOpenRef.current && panelModeRef.current === "settings") {
      setPanelMode("status");
      return;
    }
    setPanelMode("status");
    setPanelOpen((prev) => {
      const next = !prev;
      window.localStorage.setItem(PANEL_STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  }, [showToast]);

  const switchMode = useCallback(
    async (mode: ChatUiMode) => {
      if (mode === uiRef.current.mode) return;
      setCommandOpen(false);
      closeViewer();
      setConfirmState(null);
      try {
        const state = await window.petApi.chatSetMode(mode);
        if (state) applyUiState(state);
      } catch {
        showToast("切换界面失败。");
      }
    },
    [applyUiState, closeViewer, showToast],
  );

  const togglePin = useCallback(async () => {
    try {
      const state = await window.petApi.chatSetPinned(!uiRef.current.pinned);
      if (state) applyUiState(state);
    } catch {
      showToast("切换置顶失败。");
    }
  }, [applyUiState, showToast]);

  const toggleNotifications = useCallback(
    async (enabled: boolean) => {
      try {
        const state = await window.petApi.chatSetNotifications(enabled);
        if (state) applyUiState(state);
      } catch {
        showToast("切换通知失败。");
      }
    },
    [applyUiState, showToast],
  );

  const openControlPanel = useCallback(() => {
    window.petApi.chatOpenSettings();
  }, []);

  const openSettings = useCallback(() => {
    if (uiRef.current.mode !== "full") {
      showToast("查看请切换完整版UI");
      return;
    }
    setPanelMode("settings");
    setPanelOpen(true);
    window.localStorage.setItem(PANEL_STORAGE_KEY, "1");
  }, [showToast]);

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    window.localStorage.setItem(PANEL_STORAGE_KEY, "0");
  }, []);

  const applyProfileResult = useCallback(
    (result: ChatProfileData | { error: string } | null) => {
      if (!result) {
        showToast("操作失败了，请稍后再试。");
        return;
      }
      if ("error" in result) {
        showToast(result.error);
        return;
      }
      setProfile(result);
    },
    [showToast],
  );

  const openProfileMenu = useCallback(
    (role: ChatProfileRole, event: { clientX: number; clientY: number }) => {
      setProfileMenu({ role, x: event.clientX, y: event.clientY });
    },
    [],
  );

  const setTheme = useCallback(
    (theme: ChatTheme) => {
      // 取色器拖动时会连发很多次，先即时反馈，再合并写盘。
      setUi((prev) => ({ ...prev, theme }));
      themePendingRef.current = theme;
      if (themeTimerRef.current) return;
      themeTimerRef.current = window.setTimeout(() => {
        themeTimerRef.current = null;
        const next = themePendingRef.current;
        themePendingRef.current = null;
        if (!next) return;
        void window.petApi
          .chatSetTheme(next)
          .then((state) => {
            if (state) applyUiState(state);
          })
          .catch(() => showToast("切换主题失败。"));
      }, 180);
    },
    [applyUiState, showToast],
  );

  const setFontScale = useCallback(
    async (scale: ChatFontScale) => {
      try {
        const state = await window.petApi.chatSetFontScale(scale);
        if (state) applyUiState(state);
      } catch {
        showToast("调整字号失败。");
      }
    },
    [applyUiState, showToast],
  );

  const setLineHeight = useCallback(
    async (height: ChatLineHeight) => {
      try {
        const state = await window.petApi.chatSetLineHeight(height);
        if (state) applyUiState(state);
      } catch {
        showToast("调整行距失败。");
      }
    },
    [applyUiState, showToast],
  );

  const setBackgroundAppearance = useCallback(
    (patch: ChatBackgroundPatch) => {
      // 滑块拖动会连发很多次：先即时生效，再合并写盘。
      setUi((prev) => ({
        ...prev,
        background: { ...prev.background, ...patch },
      }));
      backgroundPendingRef.current = {
        ...(backgroundPendingRef.current ?? {}),
        ...patch,
      };
      if (backgroundTimerRef.current) return;
      backgroundTimerRef.current = window.setTimeout(() => {
        backgroundTimerRef.current = null;
        const pending = backgroundPendingRef.current;
        backgroundPendingRef.current = null;
        if (!pending) return;
        void window.petApi
          .chatSetBackground(pending)
          .then((state) => {
            if (state) applyUiState(state);
          })
          .catch(() => showToast("调整背景失败。"));
      }, 180);
    },
    [applyUiState, showToast],
  );

  const uploadBackground = useCallback(
    async (file: File) => {
      if (!/^image\//i.test(file.type)) {
        showToast("只能选图片文件。");
        return;
      }
      if (file.size > 20 * 1024 * 1024) {
        showToast("图片太大了，换一张 20MB 以内的吧。");
        return;
      }
      try {
        const raw = await readFileAsDataUrl(file);
        const image = await loadImage(raw);
        const maxSide = 1920;
        const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas unavailable");
        ctx.drawImage(image, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/webp", 0.9);
        const result = await window.petApi.chatBackgroundUpload(dataUrl);
        if (!result) return;
        if (!result.ok) {
          showToast(result.error);
          return;
        }
        setBackgroundImage(result.dataUrl);
        showToast("背景已更新");
      } catch {
        showToast("处理背景图失败，请换一张试试。");
      }
    },
    [showToast],
  );

  const clearBackground = useCallback(async () => {
    try {
      const ok = await window.petApi.chatBackgroundReset();
      if (!ok) {
        showToast("清除背景失败。");
        return;
      }
      setBackgroundImage(null);
      showToast("已清除自定义背景");
    } catch {
      showToast("清除背景失败。");
    }
  }, [showToast]);

  const savePreset = useCallback(
    async (name: string): Promise<boolean> => {
      try {
        const result = await window.petApi.chatSavePreset(name, uiRef.current.theme);
        if (!result) return false;
        if ("error" in result) {
          showToast(result.error);
          return false;
        }
        applyUiState(result);
        showToast("预设已保存");
        return true;
      } catch {
        showToast("保存预设失败。");
        return false;
      }
    },
    [applyUiState, showToast],
  );

  const deletePreset = useCallback(
    async (id: string) => {
      try {
        const result = await window.petApi.chatDeletePreset(id);
        if (!result) return;
        if ("error" in result) {
          showToast(result.error);
          return;
        }
        applyUiState(result);
      } catch {
        showToast("删除预设失败。");
      }
    },
    [applyUiState, showToast],
  );

  const toggleAutoLaunch = useCallback(
    async (enabled: boolean) => {
      try {
        const value = await window.petApi.setAutoLaunch(enabled);
        setAutoLaunch(value);
        showToast(value ? "已开启开机自启" : "已关闭开机自启");
      } catch {
        showToast("设置开机自启失败。");
      }
    },
    [showToast],
  );

  const refreshStorage = useCallback(async () => {
    try {
      const [info, diag] = await Promise.all([
        window.petApi.chatStorageInfo(),
        window.petApi.chatDiagnostics(),
      ]);
      setStorage(info);
      if (diag) setDiagnostics(diag);
    } catch {
      // 设置面板读取失败时保留上一次数据。
    }
  }, []);

  const chooseStorage = useCallback(async () => {
    try {
      const result = await window.petApi.chatStorageChoose();
      if (!result) return;
      if (!result.ok) {
        if (result.error) showToast(result.error);
        return;
      }
      setStorage(result.info);
      showToast("已切换到新目录，正在重新载入…");
    } catch {
      showToast("更改存储路径失败。");
    }
  }, [showToast]);

  const defaultStorage = useCallback(async () => {
    try {
      const result = await window.petApi.chatStorageDefault();
      if (!result) return;
      if (!result.ok) {
        if (result.error) showToast(result.error);
        return;
      }
      setStorage(result.info);
      showToast("已切回默认目录");
    } catch {
      showToast("切换默认目录失败。");
    }
  }, [showToast]);

  const clearStorage = useCallback(async () => {
    try {
      const result = await window.petApi.chatStorageClear();
      if (!result) return;
      if (!result.ok) {
        showToast(result.error);
        return;
      }
      setStorage(result.info);
      setMessages([]);
      setTotal(0);
      setNoMore(true);
      showToast("本地聊天缓存已清空");
    } catch {
      showToast("清空缓存失败。");
    }
  }, [showToast]);

  const submitConfirmed = useCallback(() => {
    if (!confirmState) return;
    const text = confirmState.text;
    setConfirmState(null);
    void sendText(text);
  }, [confirmState, sendText]);

  const onComposerKeyDown = (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (event.nativeEvent.isComposing) return;
    if (commandOpen && commandMatches.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCommandIndex((index) => (index + 1) % commandMatches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setCommandIndex(
          (index) => (index - 1 + commandMatches.length) % commandMatches.length,
        );
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        if (selectedCommand) selectCommand(selectedCommand);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setCommandOpen(false);
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    submit();
  };

  const onListScroll = () => {
    const list = listRef.current;
    if (!list) return;
    const near =
      list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    nearBottomRef.current = near;
    setStick((prev) => (prev === near ? prev : near));
    if (full && list.scrollTop < 120 && hasMore && !loadingMoreRef.current) {
      void loadOlder();
    }
  };

  const jumpToLatest = () => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    nearBottomRef.current = true;
    setStick(true);
  };

  const toggleCapture = () => {
    setCaptureEnabled((prev) => {
      const next = !prev;
      window.localStorage.setItem("chat.capture.enabled", next ? "1" : "0");
      return next;
    });
  };

  const changeCaptureDisplay = (value: string) => {
    setDisplayId(value);
    window.localStorage.setItem("chat.capture.displayId", value);
  };

  useEffect(() => {
    document.documentElement.dataset.petCharacter = "hiro";
    return () => {
      delete document.documentElement.dataset.petCharacter;
    };
  }, []);

  useEffect(() => {
    setCaptureEnabled(window.localStorage.getItem("chat.capture.enabled") === "1");
    let cancelled = false;
    void window.petApi
      .listDisplays()
      .then((list) => {
        if (cancelled) return;
        setDisplays(list);
        const saved = window.localStorage.getItem("chat.capture.displayId") ?? "";
        const savedExists = list.some((item) => item.id === saved);
        const fallback =
          list.find((item) => item.current) ??
          list.find((item) => item.primary) ??
          list[0];
        setDisplayId(savedExists ? saved : (fallback?.id ?? ""));
      })
      .catch(() => {
        // 拿不到屏幕列表时仍然可以在主屏截图。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const offMessages = window.petApi.onChatMessages(appendMessages);
    const offReset = window.petApi.onChatReset(applyInitial);
    const offStatus = window.petApi.onChatStatus((next) => setStatus(next));
    const offCommands = window.petApi.onChatCommands((next) => setCommands(next));
    const offUi = window.petApi.onChatUiState(applyUiState);
    return () => {
      offMessages();
      offReset();
      offStatus();
      offCommands();
      offUi();
    };
  }, [appendMessages, applyInitial, applyUiState]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await window.petApi.chatInitial();
        if (cancelled) return;
        if (result.ok) {
          applyInitial(result.data);
        } else {
          setStatus(statusFromError(result.kind, result.error));
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setStatus({ state: "offline", detail: "无法连接" });
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyInitial]);

  useEffect(() => {
    void window.petApi.chatCommands(false);
  }, []);

  useEffect(() => {
    void window.petApi
      .getAutoLaunch()
      .then((enabled) => setAutoLaunch(enabled))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!full || !panelOpen || panelMode !== "settings") return;
    void refreshStorage();
  }, [full, panelOpen, panelMode, refreshStorage]);

  useEffect(() => {
    if (!full || !panelOpen) return;
    void refreshStatus(false);
  }, [full, panelOpen, refreshStatus]);

  useEffect(() => {
    window.petApi.chatMarkRead();
    const markRead = () => window.petApi.chatMarkRead();
    window.addEventListener("focus", markRead);
    return () => window.removeEventListener("focus", markRead);
  }, []);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "0px";
    input.style.height = `${Math.min(MAX_INPUT_HEIGHT, input.scrollHeight)}px`;
  }, [draft]);

  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => {
      if (!awaitingRef.current) return;
      awaitingRef.current = false;
      setWaiting(false);
      setTimedOut(true);
    }, REPLY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [waiting]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const prepend = prependRef.current;
    if (prepend) {
      prependRef.current = null;
      list.scrollTop = list.scrollHeight - prepend.height + prepend.top;
      return;
    }
    if (nearBottomRef.current) list.scrollTop = list.scrollHeight;
  }, [visibleMessages, full, panelOpen]);

  // 图片解码完成后高度会变高；如果此时仍贴着底部，就再钉一次，
  // 避免开机载入历史时停在半截图片上。
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onLoad = () => {
      if (!nearBottomRef.current) return;
      list.scrollTop = list.scrollHeight;
      setStick(true);
    };
    list.addEventListener("load", onLoad, true);
    return () => list.removeEventListener("load", onLoad, true);
  }, []);

  useEffect(() => {
    const shouldOpen =
      commandMatches.length > 0 &&
      draft.trimStart().startsWith("/") &&
      !draft.includes("\n");
    setCommandOpen(shouldOpen);
    setCommandIndex((index) =>
      Math.min(index, Math.max(0, commandMatches.length - 1)),
    );
  }, [commandMatches, draft]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (editorRef.current) {
        event.preventDefault();
        setEditor(null);
        return;
      }
      if (profileMenuRef.current) {
        event.preventDefault();
        setProfileMenu(null);
        return;
      }
      if (viewerRef.current) {
        event.preventDefault();
        closeViewer();
        return;
      }
      if (confirmRef.current) {
        event.preventDefault();
        setConfirmState(null);
        return;
      }
      if (commandOpenRef.current) {
        event.preventDefault();
        setCommandOpen(false);
        return;
      }
      window.petApi.closeChat();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeViewer]);

  useEffect(() => {
    if (!confirmState) return;
    confirmButtonRef.current?.focus();
  }, [confirmState]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current);
      if (themeTimerRef.current) window.clearTimeout(themeTimerRef.current);
      if (backgroundTimerRef.current) window.clearTimeout(backgroundTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const input = inputRef.current;
    if (!input || loading || blocking) return;
    input.focus();
  }, [blocking, loading]);

  useEffect(() => {
    const endResize = () => window.petApi.chatResizeEnd();
    window.addEventListener("pointerup", endResize);
    window.addEventListener("pointercancel", endResize);
    window.addEventListener("blur", endResize);
    return () => {
      window.removeEventListener("pointerup", endResize);
      window.removeEventListener("pointercancel", endResize);
      window.removeEventListener("blur", endResize);
    };
  }, []);

  const chatBackgroundOpacity = ui.background.chatOpacity ?? (full ? 60 : 85);
  const backgroundUrl = backgroundImage ? `url("${backgroundImage}")` : "none";
  const showCardBackground =
    Boolean(backgroundImage) && (!full || ui.background.extend);
  const showChatBackground =
    Boolean(backgroundImage) && full && !ui.background.extend;
  const shellVariables = {
    "--accent": ui.theme.accent,
    "--chat-bg-alpha": `${chatBackgroundOpacity}%`,
    "--panel-bg-alpha": `${ui.background.panelOpacity}%`,
    "--card-bg-image": showCardBackground ? backgroundUrl : "none",
    "--chat-bg-image": showChatBackground ? backgroundUrl : "none",
  } as CSSProperties;

  return (
    <div
      className={`${styles.shell} ${full ? styles.shellFull : ""}`}
      data-mode={ui.theme.mode}
      data-font={ui.fontScale}
      data-leading={ui.lineHeight}
      style={shellVariables}
    >
      {full ? (
        <div className={styles.resizeLayer}>
          {RESIZE_DIRECTIONS.map((direction) => (
            <span
              key={direction}
              className={`${styles.resizeHandle} ${styles[`resize_${direction}`]}`}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                window.petApi.chatResizeStart(direction);
              }}
              onPointerMove={() => window.petApi.chatResizeMove()}
              onPointerUp={() => window.petApi.chatResizeEnd()}
              onPointerCancel={() => window.petApi.chatResizeEnd()}
            />
          ))}
        </div>
      ) : null}
      <section
        className={`${styles.card} ${full ? styles.cardFull : styles.cardCompact}`}
        aria-label="与希罗的聊天"
      >
        <header
          className={`${styles.header} ${full ? styles.headerFull : styles.headerCompact}`}
        >
          {full ? (
            <>
              <div className={styles.headInfo}>
                <span className={styles.title}>{profile.hiro.name}</span>
                <span
                  className={`${styles.dot} ${dotClass}`}
                  role="status"
                  aria-label={statusText}
                  title={statusText}
                />
                <span className={styles.statusLabel}>{statusText}</span>
                {ui.unread > 0 ? (
                  <span className={styles.headerUnread}>
                    {ui.unread > 99 ? "99+" : ui.unread}
                  </span>
                ) : null}
              </div>
              <div className={styles.windowActions}>
                <IconButton
                  label="心情与好感"
                  onClick={togglePanel}
                  active={panelOpen}
                >
                  {icons.heart}
                </IconButton>
                <IconButton
                  label={ui.pinned ? "取消置顶" : "窗口置顶"}
                  onClick={() => void togglePin()}
                  active={ui.pinned}
                >
                  {icons.pin}
                </IconButton>
                <IconButton
                  label="最小化"
                  onClick={() => window.petApi.chatMinimize()}
                >
                  {icons.minimize}
                </IconButton>
                <IconButton
                  label="切换小型UI"
                  onClick={() => void switchMode("compact")}
                >
                  {icons.collapse}
                </IconButton>
                <IconButton
                  label="关闭聊天"
                  onClick={() => window.petApi.closeChat()}
                  danger
                >
                  {icons.close}
                </IconButton>
              </div>
            </>
          ) : (
            <>
              <img
                className={styles.miniAvatar}
                src={avatarOf(profile.hiro)}
                alt={profile.hiro.name}
                draggable={false}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openProfileMenu("hiro", event);
                }}
              />
              <span className={styles.title}>{profile.hiro.name}</span>
              <span
                className={`${styles.dot} ${dotClass}`}
                role="status"
                aria-label={statusText}
                title={statusText}
              />
              <span className={styles.compactStatus}>{statusText}</span>
              <div className={styles.windowActions}>
                <IconButton label="查看心情与好感" onClick={togglePanel}>
                  {icons.heart}
                </IconButton>
                <IconButton
                  label="切换完整版UI"
                  onClick={() => void switchMode("full")}
                >
                  {icons.expand}
                </IconButton>
                <IconButton
                  label="关闭聊天"
                  onClick={() => window.petApi.closeChat()}
                  danger
                >
                  {icons.close}
                </IconButton>
              </div>
            </>
          )}
        </header>

        <div className={`${styles.body} ${full ? styles.bodyFull : styles.bodyCompact}`}>
          {full ? (
            <aside className={styles.rail} aria-label="聊天导航">
              <div className={styles.railPeople}>
                <button
                  type="button"
                  className={`${styles.railPerson}${selectedPerson === "hiro" ? ` ${styles.railPersonActive}` : ""}`}
                  onClick={() => {
                    setSelectedPerson("hiro");
                    inputRef.current?.focus();
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setSelectedPerson("hiro");
                    openProfileMenu("hiro", event);
                  }}
                  title={`${profile.hiro.name}（右键修改资料）`}
                >
                  <img
                    className={styles.railAvatar}
                    src={avatarOf(profile.hiro)}
                    alt={profile.hiro.name}
                    draggable={false}
                  />
                  <span className={styles.railName}>{profile.hiro.name}</span>
                  <span className={`${styles.railDot} ${dotClass}`} />
                </button>
                <button
                  type="button"
                  className={`${styles.railPerson}${selectedPerson === "me" ? ` ${styles.railPersonActive}` : ""}`}
                  onClick={() => setSelectedPerson("me")}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setSelectedPerson("me");
                    openProfileMenu("me", event);
                  }}
                  title={`${profile.me.name}（右键修改资料）`}
                >
                  <img
                    className={styles.railAvatar}
                    src={avatarOf(profile.me)}
                    alt={profile.me.name}
                    draggable={false}
                  />
                  <span className={styles.railName}>{profile.me.name}</span>
                </button>
              </div>
              <nav className={styles.railNav}>
                <button
                  type="button"
                  className={`${styles.railButton} ${styles.railActive}`}
                  onClick={() => inputRef.current?.focus()}
                  aria-current="page"
                >
                  {icons.chat}
                  <span>聊天</span>
                </button>
                <button
                  type="button"
                  className={`${styles.railButton}${panelOpen && panelMode === "status" ? ` ${styles.railActive}` : ""}`}
                  onClick={togglePanel}
                  aria-pressed={panelOpen && panelMode === "status"}
                >
                  {icons.heart}
                  <span>心情</span>
                </button>
              </nav>
              <div className={styles.railFoot}>
                <button
                  type="button"
                  className={`${styles.railButton}${panelOpen && panelMode === "settings" ? ` ${styles.railActive}` : ""}`}
                  onClick={openSettings}
                  aria-pressed={panelOpen && panelMode === "settings"}
                >
                  {icons.gear}
                  <span>设置</span>
                </button>
              </div>
            </aside>
          ) : null}

          <div className={styles.chat}>
            <div className={`${styles.toolbar} ${full ? styles.toolbarFull : ""}`}>
              <button
                type="button"
                role="switch"
                aria-checked={captureEnabled}
                className={`${styles.captureToggle}${captureEnabled ? ` ${styles.captureOn}` : ""}`}
                onClick={toggleCapture}
              >
                <span className={styles.switchTrack} aria-hidden="true">
                  <span className={styles.switchThumb} />
                </span>
                <span>获取屏幕</span>
              </button>
              {captureEnabled && displays.length > 1 ? (
                <select
                  className={styles.displaySelect}
                  value={displayId}
                  onChange={(event) => changeCaptureDisplay(event.target.value)}
                  aria-label="截图屏幕"
                >
                  {displays.map((display) => (
                    <option key={display.id} value={display.id}>
                      {display.label}
                      {display.primary ? "（主屏）" : ""}
                    </option>
                  ))}
                </select>
              ) : null}
              <span className={styles.toolbarSpacer} />
              <span className={styles.toolbarMeta}>
                {full
                  ? `显示 ${visibleMessages.length} / 共 ${Math.max(total, messages.length)}`
                  : `${visibleMessages.length} 条`}
              </span>
            </div>

            {banner ? (
              <div
                className={`${styles.banner}${blocking ? "" : ` ${styles.bannerWarn}`}`}
                role={blocking ? "alert" : "status"}
              >
                <span>{banner}</span>
                {blocking ? (
                  <button
                    type="button"
                    className={styles.retry}
                    onClick={() => void retryConnection()}
                  >
                    重试
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className={styles.messagesWrap}>
              <div
                ref={listRef}
                className={`${styles.list} ${full ? styles.listFull : styles.listCompact}`}
                onScroll={onListScroll}
                role="log"
                aria-live="polite"
                aria-label="聊天记录"
              >
                {loading ? <div className={styles.placeholder}>连接中……</div> : null}
                {!loading && !blocking && visibleMessages.length === 0 ? (
                  <div className={styles.placeholder}>还没有对话。说点什么吧。</div>
                ) : null}
                {full && !loading && visibleMessages.length > 0 ? (
                  loadingMore ? (
                    <div className={styles.loadMoreMuted}>正在载入更早的消息……</div>
                  ) : hasMore ? (
                    <button
                      type="button"
                      className={styles.loadMoreButton}
                      onClick={() => void loadOlder()}
                    >
                      载入更早的消息
                    </button>
                  ) : (
                    <div className={styles.loadMoreMuted}>已经是最早的消息了</div>
                  )
                ) : null}
                {timeline.map((item) =>
                  item.kind === "date" ? (
                    <div className={styles.dateLine} key={item.key}>
                      <span>{item.label}</span>
                    </div>
                  ) : (
                    <MessageGroup
                      key={item.key}
                      group={item}
                      full={full}
                      profile={profile}
                      onOpen={openAttachment}
                      onOpenDirect={openDirect}
                    />
                  ),
                )}
                {sending ? (
                  <div className={styles.sendingHint} aria-live="polite">
                    消息正在发送…
                  </div>
                ) : waiting ? (
                  <div className={styles.typing} aria-live="polite">
                    <span className={styles.typingDots} aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                    希罗正在回复中…
                  </div>
                ) : timedOut ? (
                  <div className={styles.typingMuted}>希罗没有回应。</div>
                ) : null}
              </div>
              {!stick && visibleMessages.length > 0 ? (
                <button
                  type="button"
                  className={styles.jumpButton}
                  onClick={jumpToLatest}
                  aria-label="回到最新消息"
                  title="回到最新消息"
                >
                  {icons.down}
                </button>
              ) : null}
            </div>

            {sendError ? (
              <div className={styles.sendError} role="alert">
                {sendError}
              </div>
            ) : null}

            <div className={styles.composerZone}>
              {commandOpen && commandMatches.length > 0 ? (
                <div className={styles.commands} role="listbox" aria-label="指令补全">
                  <div className={styles.commandsHead}>
                    <span>指令</span>
                    <span>↑↓ 选择 · Tab 补全 · Enter 发送</span>
                  </div>
                  <div className={styles.commandsList}>
                    {commandMatches.map((command, index) => {
                      const active =
                        index ===
                        Math.min(commandIndex, commandMatches.length - 1);
                      return (
                        <button
                          key={command.name}
                          type="button"
                          role="option"
                          aria-selected={active}
                          className={`${styles.commandItem}${active ? ` ${styles.commandItemActive}` : ""}`}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => selectCommand(command)}
                        >
                          <span className={styles.commandName}>{command.name}</span>
                          {command.dangerous || isDangerousCommand(command.name) ? (
                            <span className={styles.commandDanger}>危险</span>
                          ) : null}
                          <span className={styles.commandDesc}>
                            {command.description || command.plugin}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <div className={styles.composer}>
                <textarea
                  ref={inputRef}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={onComposerKeyDown}
                  placeholder="和希罗说点什么……输入 / 查看指令"
                  aria-label="消息"
                  rows={1}
                  maxLength={2000}
                  disabled={blocking || loading}
                />
                <button
                  type="button"
                  className={styles.send}
                  onClick={submit}
                  disabled={!canSend || !draft.trim()}
                >
                  {sending ? "发送中" : "发送"}
                </button>
              </div>
            </div>
          </div>

          {full && panelOpen ? (
            panelMode === "settings" ? (
              <SettingsPanel
                ui={ui}
                storage={storage}
                diagnostics={diagnostics}
                autoLaunch={autoLaunch}
                backgroundImage={backgroundImage}
                onClose={closePanel}
                onTheme={(theme) => void setTheme(theme)}
                onFontScale={(scale) => void setFontScale(scale)}
                onLineHeight={(height) => void setLineHeight(height)}
                onBackground={setBackgroundAppearance}
                onUploadBackground={(file) => void uploadBackground(file)}
                onClearBackground={() => void clearBackground()}
                onSavePreset={savePreset}
                onDeletePreset={(id) => void deletePreset(id)}
                onToggleNotifications={(enabled) => void toggleNotifications(enabled)}
                onTogglePinned={(pinned) => {
                  if (pinned !== uiRef.current.pinned) void togglePin();
                }}
                onToggleAutoLaunch={(enabled) => void toggleAutoLaunch(enabled)}
                onChooseStorage={() => void chooseStorage()}
                onDefaultStorage={() => void defaultStorage()}
                onOpenFolder={(kind) => window.petApi.chatOpenFolder(kind)}
                onClearStorage={() => void clearStorage()}
                onOpenControlPanel={openControlPanel}
                onToast={showToast}
              />
            ) : (
              <StatusPanel
                data={statusData}
                loading={statusLoading}
                notifications={ui.notifications}
                onToggleNotifications={(enabled) => void toggleNotifications(enabled)}
                onRefresh={() => void refreshStatus(true)}
                onClose={closePanel}
                onOpenSettings={openControlPanel}
              />
            )
          ) : null}
        </div>

        {full ? (
          <footer className={styles.statusBar}>
            <span className={styles.footerStatus}>
              <span className={`${styles.dot} ${dotClass}`} aria-hidden="true" />
              {statusText}
            </span>
            <span className={styles.footerCount}>
              {messages.length > 0 ? `已载入 ${messages.length} 条` : "暂无消息"}
              {total > messages.length ? ` · 共 ${total} 条` : ""}
            </span>
            <span className={ui.unread > 0 ? styles.footerUnread : styles.footerRead}>
              {ui.unread > 0 ? `${ui.unread} 条未读` : "全部已读"}
            </span>
          </footer>
        ) : null}
      </section>

      {toast ? (
        <div className={styles.toast} role="status">
          {toast}
        </div>
      ) : null}

      {viewer ? (
        <div
          className={styles.viewerBackdrop}
          onClick={closeViewer}
          role="dialog"
          aria-modal="true"
          aria-label="查看原图"
        >
          <button
            type="button"
            className={styles.viewerClose}
            onClick={closeViewer}
            aria-label="关闭原图"
            title="关闭原图"
          >
            {icons.close}
          </button>
          {viewer.loading ? (
            <div className={styles.viewerLoading}>正在读取原图……</div>
          ) : viewer.error ? (
            <div className={styles.viewerError}>{viewer.error}</div>
          ) : viewer.src ? (
            <img
              className={styles.viewerImage}
              src={viewer.src}
              alt="原图"
              draggable={false}
              onClick={(event) => event.stopPropagation()}
            />
          ) : null}
          <p className={styles.viewerHint}>点击空白处或按 Esc 关闭</p>
        </div>
      ) : null}

      {confirmState ? (
        <div
          className={styles.modalBackdrop}
          onMouseDown={() => setConfirmState(null)}
        >
          <div
            className={styles.modal}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="chat-confirm-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="chat-confirm-title">确认发送指令？</h2>
            <p>这条指令可能清空会话、修改记忆或改变希罗的状态，发送后无法撤销。</p>
            <code className={styles.confirmCommand}>{confirmState.text}</code>
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.modalCancel}
                onClick={() => setConfirmState(null)}
              >
                取消
              </button>
              <button
                ref={confirmButtonRef}
                type="button"
                className={styles.modalConfirm}
                onClick={submitConfirmed}
              >
                确认发送
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {profileMenu ? (
        <ProfileMenu
          role={profileMenu.role}
          entry={profileMenu.role === "hiro" ? profile.hiro : profile.me}
          x={profileMenu.x}
          y={profileMenu.y}
          onClose={() => setProfileMenu(null)}
          onEditAvatar={() => {
            setEditor({ kind: "avatar", role: profileMenu.role });
            setProfileMenu(null);
          }}
          onEditName={() => {
            setEditor({ kind: "name", role: profileMenu.role });
            setProfileMenu(null);
          }}
          onResetAvatar={() => {
            const role = profileMenu.role;
            setProfileMenu(null);
            void window.petApi
              .chatProfileAvatarReset(role)
              .then(applyProfileResult)
              .catch(() => showToast("恢复默认头像失败。"));
          }}
          onResetName={() => {
            const role = profileMenu.role;
            setProfileMenu(null);
            void window.petApi
              .chatProfileName(role, role === "hiro" ? "希罗" : "我")
              .then(applyProfileResult)
              .catch(() => showToast("恢复默认名称失败。"));
          }}
        />
      ) : null}

      {editor?.kind === "name" ? (
        <NameEditor
          role={editor.role}
          entry={editor.role === "hiro" ? profile.hiro : profile.me}
          onClose={() => setEditor(null)}
          onSaved={(data) => setProfile(data)}
          onError={showToast}
        />
      ) : null}

      {editor?.kind === "avatar" ? (
        <AvatarEditor
          role={editor.role}
          entry={editor.role === "hiro" ? profile.hiro : profile.me}
          onClose={() => setEditor(null)}
          onSaved={(data) => setProfile(data)}
          onError={showToast}
        />
      ) : null}
    </div>
  );
}


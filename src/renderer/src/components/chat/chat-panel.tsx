import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type {
  ChatAttachment,
  ChatCommand,
  ChatCommandsData,
  ChatInitialData,
  ChatMessage,
  ChatMoodEmotion,
  ChatResizeDirection,
  ChatRole,
  ChatStatus,
  ChatStatusData,
  ChatUiMode,
  ChatUiState,
  DisplayInfo,
} from "../../../../shared/types";
import { HIRO_AVATAR } from "../../content/avatars";
import styles from "./chat-panel.module.css";

const REPLY_TIMEOUT_MS = 90_000;
const MAX_INPUT_HEIGHT = 140;
const COMPACT_MESSAGE_LIMIT = 40;
const GROUP_WINDOW_MS = 3 * 60_000;
const PAGE_SIZE = 200;
const STATUS_DEBOUNCE_MS = 650;
const PANEL_STORAGE_KEY = "chat.full.panel";
const MODE_STORAGE_KEY = "chat.ui.mode";

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

function flattenCommands(data: ChatCommandsData | null): ChatCommand[] {
  const result: ChatCommand[] = [];
  const seen = new Set<string>();
  const add = (command: ChatCommand) => {
    if (!command.name || seen.has(command.name)) return;
    seen.add(command.name);
    result.push(command);
  };
  for (const command of data?.commands ?? []) {
    add(command);
    for (const sub of command.subcommands ?? []) add(sub);
  }
  return result.sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

function filterCommands(list: ChatCommand[], draft: string): ChatCommand[] {
  const raw = draft.trimStart();
  if (!raw.startsWith("/") || raw.includes("\n")) return [];
  const query = raw.toLowerCase();
  return list
    .filter((command) => {
      if (command.name.toLowerCase().startsWith(query)) return true;
      return command.aliases.some((alias) =>
        alias.toLowerCase().startsWith(query),
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
      } ${full ? styles.bubbleFull : styles.bubbleCompact}`}
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
  onOpen,
  onOpenDirect,
}: {
  group: Extract<TimelineItem, { kind: "group" }>;
  full: boolean;
  onOpen: (attachment: ChatAttachment, live: boolean) => void;
  onOpenDirect: (url: string) => void;
}) {
  const assistant = group.role === "assistant";
  return (
    <div
      className={`${styles.group} ${
        assistant ? styles.groupAssistant : styles.groupUser
      } ${full ? styles.groupFull : styles.groupCompact}`}
    >
      {full ? (
        assistant ? (
          <img className={styles.avatar} src={HIRO_AVATAR} alt="希罗" draggable={false} />
        ) : (
          <span className={`${styles.avatar} ${styles.userAvatar}`} aria-hidden="true">
            他
          </span>
        )
      ) : null}
      <div className={styles.groupBody}>
        {full ? (
          <div className={styles.groupMeta}>
            <span className={styles.groupName}>{assistant ? "希罗" : "他"}</span>
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
  }));
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
  const viewerTokenRef = useRef(0);
  const uiRef = useRef(ui);
  const panelOpenRef = useRef(panelOpen);
  const commandOpenRef = useRef(commandOpen);
  const viewerRef = useRef(viewer);
  const confirmRef = useRef(confirmState);
  const stickRef = useRef(stick);

  uiRef.current = ui;
  panelOpenRef.current = panelOpen;
  commandOpenRef.current = commandOpen;
  viewerRef.current = viewer;
  confirmRef.current = confirmState;
  stickRef.current = stick;
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
    setUi(state);
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
      for (const message of fresh) {
        if (message.id !== 0) knownIdsRef.current.add(message.id);
      }
      setMessages((prev) => [...prev, ...fresh.map((message) => ({ ...message, live: true }))]);
      setTotal((prev) => prev + fresh.length);
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

  const upsertMessage = useCallback(
    (message: ChatMessage, image?: string | null) => {
      const exists =
        message.id !== 0 && knownIdsRef.current.has(message.id);
      if (!exists && message.id !== 0) knownIdsRef.current.add(message.id);
      setMessages((prev) => {
        const index = prev.findIndex(
          (item) => message.id !== 0 && item.id === message.id,
        );
        if (index >= 0) {
          if (!image || prev[index].image) return prev;
          const next = [...prev];
          next[index] = { ...prev[index], image };
          return next;
        }
        if (exists) return prev;
        return [
          ...prev,
          { ...message, image: image ?? message.image ?? null, live: true },
        ];
      });
      if (!exists) setTotal((prev) => prev + 1);
    },
    [],
  );

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
      awaitingRef.current = true;
      setWaiting(true);
      setTimedOut(false);
      try {
        const result = await window.petApi.chatSend(value, {
          captureScreen: captureEnabled,
          displayId: displayId || undefined,
        });
        if (!result.ok) {
          awaitingRef.current = false;
          setWaiting(false);
          setSendError(result.error);
          if (result.kind === "auth" || result.kind === "offline") {
            setStatus(statusFromError(result.kind, result.error));
          }
          return;
        }
        setDraft((prev) => (prev.trim() === value ? "" : prev));
        if (result.data.message) {
          upsertMessage(result.data.message, result.data.screenImage ?? null);
        }
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
        setWaiting(false);
        setSendError("发送失败，请稍后重试。");
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [captureEnabled, displayId, refreshStatus, upsertMessage],
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

  const openSettings = useCallback(() => {
    window.petApi.chatOpenSettings();
  }, []);

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

  return (
    <div className={`${styles.shell} ${full ? styles.shellFull : ""}`}>
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
                <span className={styles.title}>希罗</span>
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
                src={HIRO_AVATAR}
                alt=""
                draggable={false}
              />
              <span className={styles.title}>希罗</span>
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
              <div className={styles.railTop}>
                <img
                  className={styles.railAvatar}
                  src={HIRO_AVATAR}
                  alt="希罗"
                  draggable={false}
                />
                <span className={styles.railName}>希罗</span>
                <span className={`${styles.railDot} ${dotClass}`} />
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
                  className={`${styles.railButton}${panelOpen ? ` ${styles.railActive}` : ""}`}
                  onClick={togglePanel}
                  aria-pressed={panelOpen}
                >
                  {icons.heart}
                  <span>心情</span>
                </button>
              </nav>
              <div className={styles.railFoot}>
                <button type="button" className={styles.railButton} onClick={openSettings}>
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
                      onOpen={openAttachment}
                      onOpenDirect={openDirect}
                    />
                  ),
                )}
                {waiting ? (
                  <div className={styles.typing} aria-live="polite">
                    <span className={styles.typingDots} aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                    希罗正在输入…
                  </div>
                ) : null}
                {timedOut ? <div className={styles.typingMuted}>希罗没有回应。</div> : null}
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
            <StatusPanel
              data={statusData}
              loading={statusLoading}
              notifications={ui.notifications}
              onToggleNotifications={(enabled) => void toggleNotifications(enabled)}
              onRefresh={() => void refreshStatus(true)}
              onClose={togglePanel}
              onOpenSettings={openSettings}
            />
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
    </div>
  );
}


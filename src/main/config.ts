import { app } from "electron";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  BubblePosition,
  BubbleSettings,
  ChatBackgroundConfig,
  ChatBounds,
  ChatFontScale,
  ChatLineHeight,
  ChatTheme,
  ChatThemeMode,
  ChatThemePreset,
  ChatTypewriterSettings,
  ChatUiConfig,
  CommentarySettings,
  FontPreset,
  MessageFont,
  PetConfig,
} from "../shared/types";

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const COMMENTARY_MIN_SECONDS = 30;
/** setTimeout 的上限约 24.8 天，超过这个值没有实际意义。 */
const COMMENTARY_MAX_SECONDS = 2_147_483;

/** 两套字体配置共用同一套默认值；气泡默认带一点阴影保证浅色桌面可读。 */
const DEFAULT_MESSAGE_FONT: MessageFont = {
  bold: false,
  color: "",
  stroke: false,
  strokeWidth: 1,
  strokeColor: "#000000",
  shadow: false,
  shadowBlur: 4,
  shadowColor: "#000000",
};

const DEFAULT_BUBBLE_FONT: MessageFont = {
  ...DEFAULT_MESSAGE_FONT,
  shadow: true,
  shadowBlur: 6,
};

const DEFAULT_TYPEWRITER: ChatTypewriterSettings = {
  enabled: true,
  charsPerSecond: 25,
};

const DEFAULT_BUBBLE: BubbleSettings = {
  fontSize: 20,
  opacity: 84,
  position: "top",
  maxWidth: 260,
  plainText: false,
  indent: true,
  autoHideSeconds: 0,
  rounds: 3,
  font: DEFAULT_BUBBLE_FONT,
};
/** 旧默认字号 13 只迁移一次；之后手动改回 13 不再覆盖。 */
const BUBBLE_FONT_MIGRATION = "bubble-fontsize-20";

const DEFAULT_THEME: ChatTheme = {
  mode: "night",
  accent: "#c8102e",
  presetId: "hiro",
};

const DEFAULT_THEME_PRESETS: ChatThemePreset[] = [
  { id: "hiro", name: "希罗", mode: "night", accent: "#c8102e", builtin: true },
];

const DEFAULT_CHAT_UI: ChatUiConfig = {
  mode: "compact",
  compactBounds: null,
  fullBounds: null,
  fullPinned: false,
  notifications: true,
  cacheLimit: 20_000,
  cacheMaxMb: 500,
  cacheDir: null,
  theme: DEFAULT_THEME,
  themePresets: DEFAULT_THEME_PRESETS,
  fontScale: "md",
  lineHeight: "normal",
  messageFont: DEFAULT_MESSAGE_FONT,
  typewriter: DEFAULT_TYPEWRITER,
  fontPresets: [],
  background: {
    chatOpacity: null,
    panelOpacity: 92,
    extend: false,
    image: null,
  },
};

const DEFAULT_CONFIG: PetConfig = {
  autoLaunch: false,
  commentary: {
    enabled: false,
    minSeconds: 30,
    maxSeconds: 300,
  },
  bubble: DEFAULT_BUBBLE,
  migrations: [],
  diary: {
    hosts: ["10.144.144.1", "192.168.124.47", "192.168.124.48"],
    port: 22,
    username: "mxjserver",
    privateKeyPath: join(homedir(), ".ssh", "jxmfun_server"),
    remoteDir:
      "/home/mxjserver/astrbot/data/workspaces/Hiro_FriendMessage_1955272576/diary",
    memoryDir:
      "/home/mxjserver/astrbot/data/plugin_data/astrbot_plugin_hiro_memory/memory",
    memoryDirInContainer:
      "/AstrBot/data/plugin_data/astrbot_plugin_hiro_memory/memory",
    containerName: "astrbot",
  },
  chat: {
    hosts: ["10.144.144.1", "192.168.124.47", "192.168.124.48"],
    port: 6185,
    apiKey: "",
    timeoutMs: 15_000,
    pollMs: 700,
    ui: DEFAULT_CHAT_UI,
  },
};

export function configPath(): string {
  return join(app.getPath("userData"), "config.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeBounds(value: unknown): ChatBounds | null {
  if (!isRecord(value)) return null;
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  const width = finiteNumber(value.width);
  const height = finiteNumber(value.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (width < 320 || height < 240 || width > 6000 || height > 4000) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function normalizeThemeMode(value: unknown): ChatThemeMode {
  return value === "day" ? "day" : "night";
}

function normalizeAccent(value: unknown, fallback = DEFAULT_THEME.accent): string {
  return typeof value === "string" && HEX_COLOR.test(value.trim())
    ? value.trim().toLowerCase()
    : fallback;
}

function normalizeTheme(input: unknown): ChatTheme {
  const theme = isRecord(input) ? input : {};
  return {
    mode: normalizeThemeMode(theme.mode),
    accent: normalizeAccent(theme.accent),
    presetId:
      typeof theme.presetId === "string" && theme.presetId.trim()
        ? theme.presetId.trim()
        : null,
  };
}

function normalizePresets(input: unknown): ChatThemePreset[] {
  const list = Array.isArray(input) ? input : [];
  const presets: ChatThemePreset[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!id || !name || seen.has(id)) continue;
    if (presets.length >= 12) break;
    seen.add(id);
    presets.push({
      id,
      name: name.slice(0, 12),
      mode: normalizeThemeMode(item.mode),
      accent: normalizeAccent(item.accent),
      builtin: item.builtin === true,
    });
  }
  const builtin = DEFAULT_THEME_PRESETS[0];
  if (!presets.some((preset) => preset.id === builtin.id)) {
    presets.unshift({ ...builtin });
  }
  const builtinIndex = presets.findIndex((preset) => preset.id === builtin.id);
  if (builtinIndex > 0) {
    const [item] = presets.splice(builtinIndex, 1);
    presets.unshift({ ...item, builtin: true });
  } else {
    presets[0] = { ...presets[0], builtin: true };
  }
  return presets;
}

function normalizeFontScale(value: unknown): ChatFontScale {
  return value === "sm" || value === "lg" ? value : "md";
}

function normalizeLineHeight(value: unknown): ChatLineHeight {
  return value === "compact" || value === "loose" ? value : "normal";
}

function normalizeOpacity(value: unknown, fallback: number): number {
  const parsed = finiteNumber(value);
  if (parsed === null) return fallback;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function normalizeColor(value: unknown, fallback: string, allowAuto = false): string {
  if (allowAuto && value === "") return "";
  return typeof value === "string" && HEX_COLOR.test(value.trim())
    ? value.trim().toLowerCase()
    : fallback;
}

function normalizeMessageFont(input: unknown, defaults: MessageFont): MessageFont {
  const font = isRecord(input) ? input : {};
  const strokeWidth = finiteNumber(font.strokeWidth);
  const shadowBlur = finiteNumber(font.shadowBlur);
  return {
    bold: typeof font.bold === "boolean" ? font.bold : defaults.bold,
    color: normalizeColor(font.color, defaults.color, true),
    stroke: typeof font.stroke === "boolean" ? font.stroke : defaults.stroke,
    strokeWidth:
      strokeWidth === null
        ? defaults.strokeWidth
        : Math.max(0, Math.min(4, Math.round(strokeWidth * 10) / 10)),
    strokeColor: normalizeColor(font.strokeColor, defaults.strokeColor),
    shadow: typeof font.shadow === "boolean" ? font.shadow : defaults.shadow,
    shadowBlur:
      shadowBlur === null
        ? defaults.shadowBlur
        : Math.max(0, Math.min(16, Math.round(shadowBlur))),
    shadowColor: normalizeColor(font.shadowColor, defaults.shadowColor),
  };
}

function normalizeTypewriter(input: unknown): ChatTypewriterSettings {
  const row = isRecord(input) ? input : {};
  const speed = finiteNumber(row.charsPerSecond);
  return {
    enabled: row.enabled !== false,
    charsPerSecond:
      speed === null ? DEFAULT_TYPEWRITER.charsPerSecond : Math.max(5, Math.min(60, Math.round(speed))),
  };
}

function normalizeBubblePosition(value: unknown): BubblePosition {
  return value === "left" || value === "right" || value === "auto" ? value : "top";
}

function normalizeFontPresetBubble(input: unknown): FontPreset["bubble"] {
  const bubble = normalizeBubble(input);
  return {
    fontSize: bubble.fontSize,
    opacity: bubble.opacity,
    position: bubble.position,
    maxWidth: bubble.maxWidth,
    plainText: bubble.plainText,
    indent: bubble.indent,
    font: bubble.font,
  };
}

function normalizeFontPresets(input: unknown): FontPreset[] {
  const list = Array.isArray(input) ? input : [];
  const presets: FontPreset[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!id || !name || seen.has(id)) continue;
    if (presets.length >= 10) break;
    seen.add(id);
    presets.push({
      id,
      name: name.slice(0, 12),
      messageFont: normalizeMessageFont(item.messageFont, DEFAULT_MESSAGE_FONT),
      bubble: normalizeFontPresetBubble(item.bubble),
    });
  }
  return presets;
}

function normalizeBubble(input: unknown): BubbleSettings {
  const row = isRecord(input) ? input : {};
  const fontSize = finiteNumber(row.fontSize);
  const opacity = finiteNumber(row.opacity);
  const maxWidth = finiteNumber(row.maxWidth);
  const autoHide = finiteNumber(row.autoHideSeconds);
  const rounds = finiteNumber(row.rounds);
  return {
    fontSize:
      fontSize === null
        ? DEFAULT_BUBBLE.fontSize
        : Math.max(8, Math.min(64, Math.round(fontSize))),
    opacity:
      opacity === null
        ? DEFAULT_BUBBLE.opacity
        : Math.max(20, Math.min(100, Math.round(opacity))),
    position: normalizeBubblePosition(row.position),
    maxWidth:
      maxWidth === null
        ? DEFAULT_BUBBLE.maxWidth
        : Math.max(180, Math.min(420, Math.round(maxWidth))),
    plainText: row.plainText === true,
    indent: row.indent !== false,
    autoHideSeconds:
      autoHide === null
        ? DEFAULT_BUBBLE.autoHideSeconds
        : Math.max(0, Math.min(300, Math.round(autoHide))),
    rounds:
      rounds === null ? DEFAULT_BUBBLE.rounds : Math.max(1, Math.min(5, Math.round(rounds))),
    font: normalizeMessageFont(row.font, DEFAULT_BUBBLE_FONT),
  };
}

function normalizeCommentary(input: unknown): CommentarySettings {
  const row = isRecord(input) ? input : {};
  const rawMin = finiteNumber(row.minSeconds) ?? 30;
  const rawMax = finiteNumber(row.maxSeconds) ?? 300;
  const minSeconds = Math.max(
    COMMENTARY_MIN_SECONDS,
    Math.min(COMMENTARY_MAX_SECONDS, Math.round(rawMin)),
  );
  const maxSeconds = Math.max(
    minSeconds,
    Math.min(COMMENTARY_MAX_SECONDS, Math.round(rawMax)),
  );
  return {
    enabled: row.enabled === true,
    minSeconds,
    maxSeconds,
  };
}

function normalizeBackground(input: unknown): ChatBackgroundConfig {
  const background = isRecord(input) ? input : {};
  const chat = finiteNumber(background.chatOpacity);
  const image =
    typeof background.image === "string" &&
    /^background\.(png|jpe?g|webp)$/i.test(background.image.trim())
      ? background.image.trim()
      : null;
  return {
    chatOpacity: chat === null ? null : Math.max(0, Math.min(100, Math.round(chat))),
    panelOpacity: normalizeOpacity(background.panelOpacity, 92),
    extend: background.extend === true,
    image,
  };
}

function normalizeChatUi(input: unknown): ChatUiConfig {
  const ui = isRecord(input) ? input : {};
  const mode = ui.mode === "full" ? "full" : "compact";
  return {
    mode,
    compactBounds: normalizeBounds(ui.compactBounds),
    fullBounds: normalizeBounds(ui.fullBounds),
    fullPinned: ui.fullPinned === true,
    notifications: ui.notifications !== false,
    cacheLimit:
      finiteNumber(ui.cacheLimit) !== null
        ? Math.max(500, Math.round(finiteNumber(ui.cacheLimit) as number))
        : DEFAULT_CHAT_UI.cacheLimit,
    cacheMaxMb:
      finiteNumber(ui.cacheMaxMb) !== null
        ? Math.max(50, Math.round(finiteNumber(ui.cacheMaxMb) as number))
        : DEFAULT_CHAT_UI.cacheMaxMb,
    cacheDir:
      typeof ui.cacheDir === "string" && ui.cacheDir.trim()
        ? ui.cacheDir.trim()
        : null,
    theme: normalizeTheme(ui.theme),
    themePresets: normalizePresets(ui.themePresets),
    fontScale: normalizeFontScale(ui.fontScale),
    lineHeight: normalizeLineHeight(ui.lineHeight),
    messageFont: normalizeMessageFont(ui.messageFont, DEFAULT_MESSAGE_FONT),
    typewriter: normalizeTypewriter(ui.typewriter),
    fontPresets: normalizeFontPresets(ui.fontPresets),
    background: normalizeBackground(ui.background),
  };
}

function normalizeConfig(input: unknown): PetConfig {
  const diary = isRecord(input) && isRecord(input.diary) ? input.diary : {};
  const hosts = Array.isArray(diary.hosts)
    ? diary.hosts.filter((host): host is string => typeof host === "string" && host.trim().length > 0)
    : DEFAULT_CONFIG.diary.hosts;
  const normalizedHosts = hosts.length > 0 ? hosts : DEFAULT_CONFIG.diary.hosts;
  const chat = isRecord(input) && isRecord(input.chat) ? input.chat : {};
  const chatHosts = Array.isArray(chat.hosts)
    ? chat.hosts.filter(
        (host): host is string => typeof host === "string" && host.trim().length > 0,
      )
    : normalizedHosts;

  return {
    autoLaunch: isRecord(input) && input.autoLaunch === true,
    commentary: normalizeCommentary(isRecord(input) ? input.commentary : null),
    bubble: normalizeBubble(isRecord(input) ? input.bubble : null),
    migrations:
      isRecord(input) && Array.isArray(input.migrations)
        ? input.migrations.filter(
            (item): item is string =>
              typeof item === "string" && item.trim().length > 0,
          )
        : [],
    diary: {
      hosts: normalizedHosts,
      port:
        typeof diary.port === "number" && Number.isFinite(diary.port)
          ? diary.port
          : DEFAULT_CONFIG.diary.port,
      username:
        typeof diary.username === "string" && diary.username.trim()
          ? diary.username.trim()
          : DEFAULT_CONFIG.diary.username,
      privateKeyPath:
        typeof diary.privateKeyPath === "string" && diary.privateKeyPath.trim()
          ? diary.privateKeyPath.trim()
          : DEFAULT_CONFIG.diary.privateKeyPath,
      remoteDir:
        typeof diary.remoteDir === "string" && diary.remoteDir.trim()
          ? diary.remoteDir.trim()
          : DEFAULT_CONFIG.diary.remoteDir,
      memoryDir:
        typeof diary.memoryDir === "string" && diary.memoryDir.trim()
          ? diary.memoryDir.trim()
          : DEFAULT_CONFIG.diary.memoryDir,
      memoryDirInContainer:
        typeof diary.memoryDirInContainer === "string" &&
        diary.memoryDirInContainer.trim()
          ? diary.memoryDirInContainer.trim()
          : DEFAULT_CONFIG.diary.memoryDirInContainer,
      containerName:
        typeof diary.containerName === "string" && diary.containerName.trim()
          ? diary.containerName.trim()
          : DEFAULT_CONFIG.diary.containerName,
    },
    chat: {
      hosts: chatHosts.length > 0 ? chatHosts : normalizedHosts,
      port:
        typeof chat.port === "number" && Number.isFinite(chat.port)
          ? chat.port
          : DEFAULT_CONFIG.chat.port,
      apiKey:
        typeof chat.apiKey === "string"
          ? chat.apiKey.trim()
          : DEFAULT_CONFIG.chat.apiKey,
      timeoutMs:
        typeof chat.timeoutMs === "number" && Number.isFinite(chat.timeoutMs)
          ? Math.max(1000, chat.timeoutMs)
          : DEFAULT_CONFIG.chat.timeoutMs,
      pollMs:
        typeof chat.pollMs === "number" && Number.isFinite(chat.pollMs)
          ? Math.max(250, chat.pollMs)
          : DEFAULT_CONFIG.chat.pollMs,
      ui: normalizeChatUi(chat.ui),
    },
  };
}

async function readRawConfig(): Promise<Record<string, unknown>> {
  const path = await ensureConfig();
  try {
    const raw = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeRawConfig(config: Record<string, unknown>): Promise<void> {
  const path = await ensureConfig();
  // Windows 上杀毒 / 索引服务偶尔会短暂占用目标文件；用唯一临时名 + 重试避免写坏配置。
  const tmp = `${path}.${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  try {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await fs.rename(tmp, path);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw error;
        await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
      }
    }
    await fs.rename(tmp, path);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

export async function ensureConfig(): Promise<string> {
  const path = configPath();
  try {
    await fs.access(path);
  } catch {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
  }
  return path;
}

export async function readConfig(): Promise<PetConfig> {
  const raw = await readRawConfig();
  const config = normalizeConfig(raw);
  // 旧默认字号 13 → 新默认 20，只迁移一次；用户之后手动改回 13 不会被反复覆盖。
  if (!config.migrations.includes(BUBBLE_FONT_MIGRATION)) {
    const nextBubble =
      config.bubble.fontSize === 13
        ? { ...config.bubble, fontSize: DEFAULT_BUBBLE.fontSize }
        : config.bubble;
    const migrations = [...config.migrations, BUBBLE_FONT_MIGRATION];
    config.bubble = nextBubble;
    config.migrations = migrations;
    try {
      await writeRawConfig({
        ...raw,
        bubble: {
          ...(isRecord(raw.bubble) ? raw.bubble : {}),
          fontSize: nextBubble.fontSize,
        },
        migrations,
      });
    } catch (error) {
      // 写盘失败也先把迁移后的值返回给当前进程，下次启动再试。
      console.warn("[config] 保存字号迁移失败", error);
    }
  }
  return config;
}

export async function updateChatUi(
  patch: Partial<ChatUiConfig>,
): Promise<ChatUiConfig> {
  const raw = await readRawConfig();
  const chat = isRecord(raw.chat) ? raw.chat : {};
  const current = normalizeChatUi(chat.ui);
  const next = normalizeChatUi({ ...current, ...patch });
  await writeRawConfig({
    ...raw,
    chat: {
      ...chat,
      ui: next,
    },
  });
  return next;
}

/** 记录用户是否开启过开机自启；升级后据此把自启路径修到当前 exe。 */
export async function updateAutoLaunch(enabled: boolean): Promise<void> {
  const raw = await readRawConfig();
  await writeRawConfig({ ...raw, autoLaunch: enabled });
}

export async function updateCommentary(
  patch: Partial<CommentarySettings>,
): Promise<CommentarySettings> {
  const raw = await readRawConfig();
  const current = normalizeCommentary(raw.commentary);
  const next = normalizeCommentary({ ...current, ...patch });
  await writeRawConfig({ ...raw, commentary: next });
  return next;
}

export async function updateBubble(
  patch: Partial<Omit<BubbleSettings, "font">> & { font?: Partial<MessageFont> },
): Promise<BubbleSettings> {
  const raw = await readRawConfig();
  const current = normalizeBubble(raw.bubble);
  const { font, ...rest } = patch;
  const next = normalizeBubble({
    ...current,
    ...rest,
    font: font ? { ...current.font, ...font } : current.font,
  });
  await writeRawConfig({ ...raw, bubble: next });
  return next;
}

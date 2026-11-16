import { app } from "electron";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ChatBackgroundConfig,
  ChatBounds,
  ChatFontScale,
  ChatLineHeight,
  ChatTheme,
  ChatThemeMode,
  ChatThemePreset,
  ChatUiConfig,
  PetConfig,
} from "../shared/types";

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

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
  background: {
    chatOpacity: null,
    panelOpacity: 92,
    extend: false,
    image: null,
  },
};

const DEFAULT_CONFIG: PetConfig = {
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
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await fs.rename(tmp, path);
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
  return normalizeConfig(await readRawConfig());
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

import { app, dialog, type BrowserWindow } from "electron";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type {
  BubbleSettings,
  ChatBackground,
  ChatSettingsExport,
  ChatSettingsExportResult,
  ChatSettingsImportResult,
  ChatTheme,
  ChatThemePreset,
  ChatTypewriterSettings,
  ChatUiConfig,
  CommentarySettings,
  FontPreset,
  MessageFont,
  PetConfig,
} from "../../shared/types";
import { readConfig, updateBubble, updateChatUi, updateCommentary } from "../config";

const FORMAT = "monosaba-chat-settings";
const VERSION = 1;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function dateStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

/** 只包含聊天个性化设置：主题、背景透明度、气泡、两套字体、逐字、点评间隔与预设。 */
export function buildChatSettingsExport(config: PetConfig): ChatSettingsExport {
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    appearance: {
      theme: config.chat.ui.theme,
      themePresets: config.chat.ui.themePresets,
      messageFont: config.chat.ui.messageFont,
      typewriter: config.chat.ui.typewriter,
    },
    background: {
      chatOpacity: config.chat.ui.background.chatOpacity,
      panelOpacity: config.chat.ui.background.panelOpacity,
      extend: config.chat.ui.background.extend,
    },
    bubble: config.bubble,
    commentary: {
      minSeconds: config.commentary.minSeconds,
      maxSeconds: config.commentary.maxSeconds,
    },
    fontPresets: config.chat.ui.fontPresets,
  };
}

export async function exportChatSettings(
  win: BrowserWindow | null,
): Promise<ChatSettingsExportResult> {
  try {
    const config = await readConfig();
    const data = buildChatSettingsExport(config);
    const options = {
      title: "导出聊天设置",
      defaultPath: join(
        app.getPath("documents"),
        `monosaba-chat-settings-${dateStamp()}.json`,
      ),
      filters: [{ name: "JSON", extensions: ["json"] }],
    };
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return { ok: false, error: "已取消导出。", canceled: true };
    }
    await fs.writeFile(result.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    return { ok: true, path: result.filePath };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "导出设置失败。",
    };
  }
}

function backgroundPatch(
  input: Record<string, unknown>,
  current: ChatBackground,
): ChatBackground {
  return {
    chatOpacity:
      input.chatOpacity === null
        ? null
        : typeof input.chatOpacity === "number" && Number.isFinite(input.chatOpacity)
          ? Math.max(0, Math.min(100, Math.round(input.chatOpacity)))
          : current.chatOpacity,
    panelOpacity:
      typeof input.panelOpacity === "number" && Number.isFinite(input.panelOpacity)
        ? Math.max(0, Math.min(100, Math.round(input.panelOpacity)))
        : current.panelOpacity,
    extend: typeof input.extend === "boolean" ? input.extend : current.extend,
  };
}

/** 读取导入文件，只覆盖文件中出现的字段；所有值仍走 config 的归一化。 */
export async function importChatSettings(
  win: BrowserWindow | null,
): Promise<ChatSettingsImportResult> {
  try {
    const options = {
      title: "导入聊天设置",
      properties: ["openFile" as const],
      filters: [{ name: "JSON", extensions: ["json"] }],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, error: "已取消导入。", canceled: true };
    }
    const path = result.filePaths[0];
    const stat = await fs.stat(path);
    if (stat.size > MAX_IMPORT_BYTES) {
      return { ok: false, error: "设置文件大于 2 MB，已拒绝导入。" };
    }
    const raw = await fs.readFile(path, "utf8");
    let data: unknown;
    try {
      data = JSON.parse(raw.replace(/^\uFEFF/, ""));
    } catch {
      return { ok: false, error: "不是有效的 JSON 文件。" };
    }
    if (!isRecord(data) || data.format !== FORMAT) {
      return { ok: false, error: "这不是 MONOSABA 聊天设置文件。" };
    }
    if (data.version !== VERSION) {
      return { ok: false, error: `不支持的设置版本：${String(data.version)}` };
    }

    const config = await readConfig();
    const patch: Partial<ChatUiConfig> = {};
    const applied: string[] = [];

    const appearance = isRecord(data.appearance) ? data.appearance : {};
    if (isRecord(appearance.theme)) {
      patch.theme = appearance.theme as unknown as ChatTheme;
      applied.push("主题");
    }
    if (Array.isArray(appearance.themePresets)) {
      patch.themePresets = appearance.themePresets as ChatThemePreset[];
      applied.push("色彩预设");
    }
    if (isRecord(appearance.messageFont)) {
      patch.messageFont = appearance.messageFont as unknown as MessageFont;
      applied.push("聊天字体");
    }
    if (isRecord(appearance.typewriter)) {
      patch.typewriter = appearance.typewriter as unknown as ChatTypewriterSettings;
      applied.push("逐字输出");
    }
    if (Array.isArray(data.fontPresets)) {
      patch.fontPresets = data.fontPresets as FontPreset[];
      applied.push(`${(data.fontPresets as FontPreset[]).length} 个字体预设`);
    }
    if (isRecord(data.background)) {
      patch.background = {
        ...config.chat.ui.background,
        ...backgroundPatch(data.background, config.chat.ui.background),
      };
      applied.push("背景");
    }
    if (Object.keys(patch).length > 0) {
      await updateChatUi(patch);
    }

    if (isRecord(data.bubble)) {
      await updateBubble(
        data.bubble as Partial<Omit<BubbleSettings, "font">> & {
          font?: Partial<MessageFont>;
        },
      );
      applied.push("桌宠气泡");
    }

    if (isRecord(data.commentary)) {
      const next: Partial<CommentarySettings> = {};
      if (
        typeof data.commentary.minSeconds === "number" &&
        Number.isFinite(data.commentary.minSeconds)
      ) {
        next.minSeconds = data.commentary.minSeconds;
      }
      if (
        typeof data.commentary.maxSeconds === "number" &&
        Number.isFinite(data.commentary.maxSeconds)
      ) {
        next.maxSeconds = data.commentary.maxSeconds;
      }
      if (Object.keys(next).length > 0) {
        await updateCommentary(next);
        applied.push("点评间隔");
      }
    }

    return { ok: true, applied };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "导入设置失败。",
    };
  }
}

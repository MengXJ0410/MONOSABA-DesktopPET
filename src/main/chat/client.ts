import type {
  ChatBootstrapData,
  ChatBootstrapResult,
  ChatCommandsData,
  ChatConfig,
  ChatErrorKind,
  ChatHistoryData,
  ChatHistoryResult,
  ChatMediaData,
  ChatMediaKind,
  ChatMediaResult,
  ChatPollData,
  ChatQuote,
  ChatResult,
  ChatRetractData,
  ChatRetractResult,
  ChatSendData,
  ChatSendResult,
  ChatStatusData,
} from "../../shared/types";
import { readConfig } from "../config";

const BRIDGE_PLUGIN = "astrbot_plugin_desktoppet_bridge";
const ROUTE_PREFIX = `/api/v1/plugins/extensions/${BRIDGE_PLUGIN}`;

type Envelope =
  | { status: "ok"; data?: unknown }
  | { status: "error"; message?: unknown; data?: unknown };

let cachedHost: string | null = null;

function normalizeBase(host: string, port: number): string {
  const trimmed = host.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}:${port}`;
}

function hostCandidates(config: ChatConfig): string[] {
  const bases = config.hosts
    .map((host) => normalizeBase(host, config.port))
    .filter(Boolean);
  if (cachedHost && bases.includes(cachedHost)) {
    return [cachedHost, ...bases.filter((base) => base !== cachedHost)];
  }
  return bases;
}

function fail(kind: ChatErrorKind, error: string): ChatResult<never> {
  return { ok: false, kind, error };
}

function classifyNetworkError(error: unknown): ChatResult<never> {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") {
    return fail("offline", "无法连接");
  }
  return fail("offline", "无法连接");
}

async function requestFromHost<T>(
  base: string,
  path: string,
  config: ChatConfig,
  init: RequestInit = {},
  timeoutMs = config.timeoutMs,
): Promise<ChatResult<T>> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${config.apiKey}`);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");

  let response: Response;
  try {
    response = await fetch(`${base}${ROUTE_PREFIX}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return classifyNetworkError(error);
  }

  if (response.status === 401 || response.status === 403) {
    return fail("auth", "AstrBot 密钥无效");
  }
  if (response.status === 404) {
    return fail("server", "桥接插件未安装");
  }
  if (!response.ok) {
    return fail("server", `桥接插件异常（HTTP ${response.status}）`);
  }

  let raw = "";
  try {
    raw = await response.text();
  } catch (error) {
    console.warn("[chat] read response body failed", base, path, error);
    return fail("offline", "无法连接");
  }

  let payload: Envelope;
  try {
    payload = JSON.parse(raw) as Envelope;
  } catch {
    console.warn(
      "[chat] non-JSON response",
      base,
      path,
      response.status,
      response.headers.get("content-type"),
      raw.length,
      raw.slice(0, 500),
    );
    return fail("server", "桥接插件返回格式不正确");
  }

  if (payload.status === "ok") {
    cachedHost = base;
    return { ok: true, data: payload.data as T };
  }
  const message =
    typeof payload.message === "string" && payload.message.trim()
      ? payload.message.trim()
      : "桥接插件返回错误";
  return fail("server", message);
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs?: number,
): Promise<ChatResult<T>> {
  const config = (await readConfig()).chat;
  if (!config.apiKey) {
    return fail("auth", "未配置 AstrBot 密钥");
  }
  const bases = hostCandidates(config);
  if (bases.length === 0) {
    return fail("offline", "无法连接");
  }

  const timeout = Math.max(config.timeoutMs, timeoutMs ?? 0);
  const isPost = (init.method ?? "GET").toUpperCase() === "POST";
  let last: ChatResult<T> = fail("offline", "无法连接");
  for (const base of bases) {
    const startedAt = Date.now();
    const result = await requestFromHost<T>(base, path, config, init, timeout);
    if (result.ok) return result;
    last = result;
    // 密钥 / 插件问题换地址也没用，直接返回。
    if (result.kind === "auth" || result.kind === "server") return result;
    // 写请求不能因为“超时”就在别的地址重发：桥接可能已经收下并处理了，
    // 重发会变成两条点评 / 两条消息。快速失败（连接被拒）才继续换地址。
    if (isPost && Date.now() - startedAt > 5_000) return result;
  }
  return last;
}

export async function loadHistory(limit?: number): Promise<ChatHistoryResult> {
  const config = (await readConfig()).chat;
  const size = Math.max(1, Math.min(100, Math.round(limit ?? 40)));
  // 历史可能带最近 8 张图，给长一点的超时，避免半路截断导致 JSON 解析失败。
  return request<ChatHistoryData>(
    `/history?limit=${size}`,
    {},
    Math.max(config.timeoutMs, 30_000),
  );
}

export async function bootstrapChat(): Promise<ChatBootstrapResult> {
  const config = (await readConfig()).chat;
  return request<ChatBootstrapData>(
    "/bootstrap",
    {},
    Math.max(config.timeoutMs, 60_000),
  );
}

export async function sendMessage(
  text: string,
  imageBase64?: string | null,
  commentary = false,
  options: {
    clientId?: string;
    quote?: ChatQuote | null;
    /** 希罗指针是否开启；桥接据此给模型补一句「你可以操控第二指针」。 */
    pointerEnabled?: boolean;
  } = {},
): Promise<ChatSendResult> {
  const body: Record<string, unknown> = { text };
  if (imageBase64) {
    body.image = { mime: "image/jpeg", data: imageBase64 };
  }
  if (commentary) {
    body.commentary = true;
  }
  if (options.clientId) {
    body.clientId = options.clientId;
  }
  if (options.quote) {
    body.quote = options.quote;
  }
  if (options.pointerEnabled) {
    body.pointerEnabled = true;
  }
  const config = (await readConfig()).chat;
  // 带截图 / 点评的请求体大，且桥接可能正排在模型回合后面；
  // 15 秒默认超时太短，会把已经成功注入的回合误判成失败。
  const timeout = imageBase64
    ? Math.max(config.timeoutMs, 60_000)
    : config.timeoutMs;
  return request<ChatSendData>(
    "/send",
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    timeout,
  );
}

/** 桥接返回的 AI 指针观察结果。action 为 null 表示模型觉得不用动。 */
export type PointerObservation = {
  action: {
    /** 0~1，相对截图。 */
    nx: number;
    ny: number;
    durationMs: number;
    holdMs: number;
    /** 连续轨迹（画圈 / 晃动 / 连续指两处）；缺省表示单点移动。 */
    steps?: Array<{
      nx: number;
      ny: number;
      durationMs: number;
      holdMs: number;
    }>;
    reason?: string;
    /** 她随口说的一句话；桥接已写进桌面聊天日志。 */
    say?: string;
  } | null;
  /** 成功时桥接返回的闲聊文本（和 action.say 相同）。 */
  say?: string;
};

/**
 * AI 指针观察：把压缩截图交给桥接，由希罗的人格决定要不要移动指针。
 * hint 是用户刚从桌面发出的那句话，让观察不必等会话历史落盘就能执行。
 */
export async function requestPointer(
  imageBase64: string,
  screen: { width: number; height: number },
  hint?: string,
): Promise<ChatResult<PointerObservation>> {
  const config = (await readConfig()).chat;
  return request<PointerObservation>(
    "/pointer",
    {
      method: "POST",
      body: JSON.stringify({
        image: { mime: "image/jpeg", data: imageBase64 },
        screen,
        ...(hint ? { hint } : {}),
      }),
    },
    Math.max(config.timeoutMs, 90_000),
  );
}

/** 撤回一轮桌面消息；桥接会中止生成并清理本轮日志 / 会话历史。 */
export async function retractMessage(clientId: string): Promise<ChatRetractResult> {
  // 桥接要等前半轮历史写完再裁剪，可能接近 6 秒。
  return request<ChatRetractData>(
    "/retract",
    {
      method: "POST",
      body: JSON.stringify({ clientId }),
    },
    15_000,
  );
}

export async function pollMessages(
  after: number,
  limit = 100,
): Promise<ChatResult<ChatPollData>> {
  const size = Math.max(1, Math.min(200, Math.round(limit)));
  return request<ChatPollData>(`/messages?after=${Math.max(0, after)}&limit=${size}`);
}

export async function loadChatStatus(): Promise<ChatResult<ChatStatusData>> {
  return request<ChatStatusData>("/status");
}

export async function loadCommands(): Promise<ChatResult<ChatCommandsData>> {
  return request<ChatCommandsData>("/commands", {}, 20_000);
}

export async function loadMedia(
  media: string,
  kind: ChatMediaKind,
): Promise<ChatMediaResult> {
  const result = await request<ChatMediaData>(
    `/media?media=${encodeURIComponent(media)}&kind=${kind}`,
    {},
    30_000,
  );
  if (!result.ok) return { ok: false, error: result.error };
  const data = result.data;
  if (!data || typeof data.base64 !== "string" || !data.base64) {
    return { ok: false, error: "图片为空。" };
  }
  const mime = typeof data.mime === "string" && data.mime ? data.mime : "image/webp";
  return {
    ok: true,
    mime,
    dataUrl: `data:${mime};base64,${data.base64}`,
  };
}

export async function pingBridge(): Promise<
  ChatResult<{ platform: boolean; qqConnected: boolean }>
> {
  return request<{ platform: boolean; qqConnected: boolean }>("/ping");
}

export function resetChatHostCache(): void {
  cachedHost = null;
}

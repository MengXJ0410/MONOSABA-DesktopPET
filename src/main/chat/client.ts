import type {
  ChatConfig,
  ChatErrorKind,
  ChatHistoryData,
  ChatHistoryResult,
  ChatPollData,
  ChatResult,
  ChatSendData,
  ChatSendResult,
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
      signal: AbortSignal.timeout(config.timeoutMs),
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

  let payload: Envelope;
  try {
    payload = (await response.json()) as Envelope;
  } catch {
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
): Promise<ChatResult<T>> {
  const config = (await readConfig()).chat;
  if (!config.apiKey) {
    return fail("auth", "未配置 AstrBot 密钥");
  }
  const bases = hostCandidates(config);
  if (bases.length === 0) {
    return fail("offline", "无法连接");
  }

  let last: ChatResult<T> = fail("offline", "无法连接");
  for (const base of bases) {
    const result = await requestFromHost<T>(base, path, config, init);
    if (result.ok) return result;
    last = result;
    // 密钥 / 插件问题换地址也没用，直接返回。
    if (result.kind === "auth" || result.kind === "server") return result;
  }
  return last;
}

export async function loadHistory(limit?: number): Promise<ChatHistoryResult> {
  const config = (await readConfig()).chat;
  const size = Math.max(1, Math.min(100, Math.round(limit ?? 40)));
  return request<ChatHistoryData>(`/history?limit=${size}`);
}

export async function sendMessage(
  text: string,
  imageBase64?: string | null,
): Promise<ChatSendResult> {
  const body: Record<string, unknown> = { text };
  if (imageBase64) {
    body.image = { mime: "image/jpeg", data: imageBase64 };
  }
  return request<ChatSendData>("/send", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function pollMessages(
  after: number,
  limit = 100,
): Promise<ChatResult<ChatPollData>> {
  const size = Math.max(1, Math.min(200, Math.round(limit)));
  return request<ChatPollData>(`/messages?after=${Math.max(0, after)}&limit=${size}`);
}

export async function pingBridge(): Promise<
  ChatResult<{ platform: boolean; qqConnected: boolean }>
> {
  return request<{ platform: boolean; qqConnected: boolean }>("/ping");
}

export function resetChatHostCache(): void {
  cachedHost = null;
}

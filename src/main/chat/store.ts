import { app } from "electron";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ChatAttachment,
  ChatMessage,
  ChatQuote,
} from "../../shared/types";
import { isCommentarySameReply } from "../commentary-marker";

const CACHE_DIR_NAME = "chat-cache";
const MESSAGES_FILE = "messages.jsonl";
const META_FILE = "meta.json";
const THUMBS_DIR = "thumbs";
const HISTORY_SPACING_MS = 60_000;

type CacheMeta = {
  epoch: string;
  cursor: number;
  updatedAt: number;
  version: 1;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toInt(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.round(parsed);
  }
  return fallback;
}

function normalizeAttachment(value: unknown): ChatAttachment | null {
  if (!isRecord(value)) return null;
  if (value.type !== "image") return null;
  const media = typeof value.media === "string" ? value.media.trim() : "";
  if (!/^[0-9a-f]{16,64}\.[a-z0-9]{2,5}$/i.test(media)) return null;
  return {
    type: "image",
    media,
    mime: typeof value.mime === "string" && value.mime ? value.mime : "image/webp",
    width: Math.max(0, toInt(value.width)),
    height: Math.max(0, toInt(value.height)),
    animated: value.animated === true,
    bytes: Math.max(0, toInt(value.bytes)),
  };
}

function normalizeQuote(value: unknown): ChatQuote | null {
  if (!isRecord(value)) return null;
  if (value.role !== "user" && value.role !== "assistant") return null;
  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (!text) return null;
  return {
    id: value.id === undefined ? undefined : Math.max(0, toInt(value.id)),
    role: value.role,
    text,
    ts: Math.max(0, toInt(value.ts)),
  };
}

export function normalizeMessage(value: unknown): ChatMessage | null {
  if (!isRecord(value)) return null;
  const role = value.role;
  if (role !== "user" && role !== "assistant") return null;
  const attachments = Array.isArray(value.attachments)
    ? value.attachments
        .map(normalizeAttachment)
        .filter((item): item is ChatAttachment => item !== null)
    : [];
  const text = typeof value.text === "string" ? value.text : "";
  const image = typeof value.image === "string" && value.image ? value.image : null;
  if (!text.trim() && attachments.length === 0 && !image) return null;
  const id = toInt(value.id);
  const ts = Math.max(0, toInt(value.ts));
  const origin =
    value.origin === "qq" || value.origin === "desktop" ? value.origin : null;
  const turn = typeof value.turn === "string" && value.turn.trim()
    ? value.turn.trim()
    : undefined;
  return {
    id,
    ts,
    role,
    origin,
    text,
    turn,
    quote: normalizeQuote(value.quote),
    image,
    attachments,
    live: value.live === true,
    approximate: value.approximate === true,
  };
}

/** 文本归一化，只用于判断「同一条消息」，不会写回消息。 */
function fingerprint(message: ChatMessage): string {
  const text = message.text
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
  return `${message.role}\u0000${text}`;
}

function sortMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      if (a.message.ts !== b.message.ts) return a.message.ts - b.message.ts;
      return a.index - b.index;
    })
    .map((item) => item.message);
}

function dedupeAdjacent(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const message of messages) {
    const prev = result[result.length - 1];
    if (prev && fingerprint(prev) === fingerprint(message)) {
      // 同一条消息在历史和发送日志里重复出现时，保留信息更全的一份。
      if (
        (message.attachments?.length ?? 0) > (prev.attachments?.length ?? 0) ||
        (message.image && !prev.image)
      ) {
        result[result.length - 1] = { ...message, ts: prev.ts || message.ts };
      }
      continue;
    }
    result.push(message);
  }
  return result;
}

/**
 * 把 AstrBot 会话历史（没有时间戳）和桥接发送日志合并成一条时间线。
 *
 * 日志是「插件安装之后实际发出的每一条消息」，通常等于会话历史的一段后缀；
 * 找到最长的后缀 / 子串匹配后，只保留一份，并给历史部分补上近似时间。
 */
export function mergeHistoryAndLog(
  history: ChatMessage[],
  log: ChatMessage[],
): ChatMessage[] {
  const hist = dedupeAdjacent(
    history
      .filter(
        (item) => !(item.role === "assistant" && isCommentarySameReply(item.text)),
      )
      .map((item) => ({ ...item })),
  );
  const entries = dedupeAdjacent(
    log
      .filter(
        (item) => !(item.role === "assistant" && isCommentarySameReply(item.text)),
      )
      .map((item) => ({ ...item })),
  );
  if (hist.length === 0) return sortMessages(entries);
  if (entries.length === 0) {
    return sortMessages(withApproximateTimes(hist, Date.now()));
  }

  const maxK = Math.min(hist.length, entries.length);
  let best = { historyStart: hist.length, logStart: 0, length: 0 };
  for (let logStart = 0; logStart < Math.min(entries.length, 200); logStart += 1) {
    const limit = Math.min(maxK, entries.length - logStart);
    for (let length = limit; length >= 1; length -= 1) {
      if (length <= best.length) break;
      let matched = true;
      for (let offset = 0; offset < length; offset += 1) {
        if (
          fingerprint(hist[hist.length - length + offset]) !==
          fingerprint(entries[logStart + offset])
        ) {
          matched = false;
          break;
        }
      }
      if (matched) {
        best = {
          historyStart: hist.length - length,
          logStart,
          length,
        };
        break;
      }
    }
  }

  let merged: ChatMessage[];
  if (best.length > 0) {
    if (best.length === hist.length) {
      // 会话历史整段都在发送日志里：日志就是完整时间线。
      merged = [...entries];
    } else {
      // 日志从历史中间开始：保留历史前缀，再接完整日志。
      merged = [...hist.slice(0, hist.length - best.length), ...entries];
    }
  } else {
    merged = [...hist, ...entries];
  }

  merged = dedupeAdjacent(merged);
  const firstLogTs = entries.find((item) => item.ts > 0)?.ts ?? Date.now();
  const historyCount = merged.filter((item) => !item.ts || item.approximate).length;
  // 给没有时间戳的历史消息按 1 分钟间隔倒推，保证日期分隔和排序稳定。
  let cursorTs = firstLogTs;
  for (let index = merged.length - 1; index >= 0; index -= 1) {
    const message = merged[index];
    if (message.ts > 0 && !message.approximate) {
      cursorTs = Math.min(cursorTs, message.ts);
      continue;
    }
    if (!message.ts) {
      cursorTs -= HISTORY_SPACING_MS;
      message.ts = cursorTs;
      message.approximate = true;
    }
  }
  if (historyCount > 0) {
    void historyCount;
  }
  return sortMessages(merged);
}

function withApproximateTimes(
  messages: ChatMessage[],
  endTs: number,
): ChatMessage[] {
  let cursor = endTs;
  const result = messages.map((message) => ({ ...message }));
  for (let index = result.length - 1; index >= 0; index -= 1) {
    if (result[index].ts > 0) {
      cursor = Math.min(cursor, result[index].ts);
      continue;
    }
    cursor -= HISTORY_SPACING_MS;
    result[index].ts = cursor;
    result[index].approximate = true;
  }
  return result;
}

function messageBytes(message: ChatMessage): number {
  try {
    return Buffer.byteLength(JSON.stringify(message), "utf8") + 1;
  } catch {
    return 0;
  }
}

export class ChatStore {
  readonly dir: string;
  readonly messagesPath: string;
  readonly metaPath: string;
  readonly thumbsDir: string;

  private messages: ChatMessage[] = [];
  private nextSyntheticId = -1;
  private seenIds = new Set<number>();
  private cursor = 0;
  private epoch = "";
  private totalBytes = 0;
  private cacheLimit = 20_000;
  private cacheMaxBytes = 500 * 1024 * 1024;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private savePromise: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(rootDir?: string) {
    const root = rootDir ?? ChatStore.defaultDir();
    this.dir = root;
    this.messagesPath = join(root, MESSAGES_FILE);
    this.metaPath = join(root, META_FILE);
    this.thumbsDir = join(root, THUMBS_DIR);
  }

  static defaultDir(): string {
    return join(app.getPath("userData"), CACHE_DIR_NAME);
  }

  async load(limit: number, maxBytes: number): Promise<void> {
    this.cacheLimit = Math.max(500, Math.round(limit));
    this.cacheMaxBytes = Math.max(50 * 1024 * 1024, Math.round(maxBytes));
    await fs.mkdir(this.dir, { recursive: true });
    await fs.mkdir(this.thumbsDir, { recursive: true });

    try {
      const rawMeta = await fs.readFile(this.metaPath, "utf8");
      const parsed = JSON.parse(rawMeta) as unknown;
      if (isRecord(parsed)) {
        this.epoch = typeof parsed.epoch === "string" ? parsed.epoch : "";
        this.cursor = Math.max(0, toInt(parsed.cursor));
      }
    } catch {
      this.epoch = "";
      this.cursor = 0;
    }

    const loaded: ChatMessage[] = [];
    try {
      const raw = await fs.readFile(this.messagesPath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const message = normalizeMessage(JSON.parse(line) as unknown);
          if (
            message &&
            !(message.role === "assistant" && isCommentarySameReply(message.text))
          ) {
            loaded.push(message);
          }
        } catch {
          // 损坏的一行跳过，不影响其它缓存。
        }
      }
    } catch {
      // 没有缓存时就是空列表。
    }

    this.messages = sortMessages(loaded);
    this.renumber();
    this.totalBytes = this.messages.reduce(
      (sum, message) => sum + messageBytes(message),
      0,
    );
    await this.trim(false);
    this.dirty = false;
  }

  getCursor(): number {
    return this.cursor;
  }

  getEpoch(): string {
    return this.epoch;
  }

  total(): number {
    return this.messages.length;
  }

  getAll(): ChatMessage[] {
    return this.messages;
  }

  getRecent(limit: number): ChatMessage[] {
    const size = Math.max(0, Math.floor(limit));
    if (size === 0) return [];
    return this.messages.slice(-size);
  }

  getBefore(beforeId: number, limit: number): ChatMessage[] {
    const size = Math.max(1, Math.floor(limit));
    let index = this.messages.findIndex((message) => message.id === beforeId);
    if (index < 0) {
      // 页码可能来自旧列表；退化成按时间戳找位置。
      index = this.messages.length;
    }
    const start = Math.max(0, index - size);
    return this.messages.slice(start, index);
  }

  async applyBootstrap(
    history: ChatMessage[],
    log: ChatMessage[],
    cursor: number,
    epoch: string,
  ): Promise<ChatMessage[]> {
    const epochReset = Boolean(epoch && this.epoch && epoch !== this.epoch);
    if (epochReset) {
      // 桥接日志重置后 id 会从 1 重新开始，旧消息改用本地合成 id，
      // 避免和新的日志 id 混淆，也避免被当成过期记录删掉。
      for (const message of this.messages) message.id = 0;
    }

    const fresh = mergeHistoryAndLog(history, log);
    const freshIds = new Set(fresh.filter((item) => item.id > 0).map((item) => item.id));
    const firstFreshTs = fresh.length > 0 ? fresh[0].ts : 0;
    const firstFreshId =
      fresh.find((item) => item.id > 0)?.id ?? Number.MAX_SAFE_INTEGER;

    const preserved: ChatMessage[] = [];
    for (const message of this.messages) {
      if (message.id > 0) {
        if (!freshIds.has(message.id) && message.id < firstFreshId) {
          preserved.push({ ...message, live: false });
        }
        continue;
      }
      // 历史缓存只在服务器历史被清空 / 缩短时保留，避免重复。
      if (
        message.ts > 0 &&
        message.ts < firstFreshTs &&
        !fresh.some(
          (item) => item.role === message.role && item.text.trim() === message.text.trim(),
        )
      ) {
        preserved.push({ ...message, live: false });
      }
    }

    this.messages = sortMessages([
      ...preserved,
      ...fresh.map((item) => ({ ...item, live: false })),
    ]);
    this.renumber();
    this.totalBytes = this.messages.reduce(
      (sum, message) => sum + messageBytes(message),
      0,
    );
    this.cursor = Math.max(0, cursor);
    if (epoch) this.epoch = epoch;
    this.dirty = true;
    await this.trim(true);
    await this.save();
    return this.messages;
  }

  async append(incoming: ChatMessage[]): Promise<ChatMessage[]> {
    const added: ChatMessage[] = [];
    for (const item of incoming) {
      const message = normalizeMessage(item);
      if (!message) continue;
      if (message.id > 0) {
        if (this.seenIds.has(message.id)) continue;
        this.seenIds.add(message.id);
        message.live = true;
        added.push(message);
      } else {
        message.id = this.nextSyntheticId;
        this.nextSyntheticId -= 1;
        message.live = true;
        added.push(message);
      }
    }
    if (added.length === 0) return [];
    this.messages.push(...added);
    this.messages = sortMessages(this.messages);
    this.renumber();
    this.totalBytes += added.reduce(
      (sum, message) => sum + messageBytes(message),
      0,
    );
    this.dirty = true;
    await this.trim(true);
    this.scheduleSave();
    return added;
  }

  /** 撤回：按回合 id 删掉本地缓存里的这一轮（user + 已被轮询到的回复）。 */
  async removeTurn(turn: string): Promise<number[]> {
    if (!turn) return [];
    const removed: number[] = [];
    this.messages = this.messages.filter((message) => {
      if (message.turn !== turn) return true;
      removed.push(message.id);
      this.totalBytes -= messageBytes(message);
      return false;
    });
    if (removed.length === 0) return [];
    // 只重建 id 索引，不改其它消息的 id：渲染层手上还拿着旧 id。
    this.seenIds.clear();
    for (const message of this.messages) {
      if (message.id > 0) this.seenIds.add(message.id);
    }
    this.totalBytes = Math.max(0, this.totalBytes);
    this.dirty = true;
    await this.save();
    return removed;
  }

  async setCursor(cursor: number, epoch?: string): Promise<void> {    const next = Math.max(0, Math.round(cursor));
    const epochChanged = Boolean(epoch && epoch !== this.epoch);
    if (next === this.cursor && !epochChanged) return;
    this.cursor = next;
    if (epoch) this.epoch = epoch;
    this.dirty = true;
    this.scheduleSave();
  }

  private renumber(): void {
    this.seenIds.clear();
    let synthetic = -1;
    for (const message of this.messages) {
      if (message.id > 0) {
        if (this.seenIds.has(message.id)) {
          message.id = synthetic;
          synthetic -= 1;
        } else {
          this.seenIds.add(message.id);
        }
      } else {
        message.id = synthetic;
        synthetic -= 1;
      }
    }
    this.nextSyntheticId = synthetic;
  }

  private async trim(schedule: boolean): Promise<void> {
    let changed = false;
    while (this.messages.length > this.cacheLimit) {
      this.messages.shift();
      changed = true;
    }
    if (this.totalBytes > this.cacheMaxBytes || changed) {
      this.totalBytes = this.messages.reduce(
        (sum, message) => sum + messageBytes(message),
        0,
      );
      while (this.messages.length > 0 && this.totalBytes > this.cacheMaxBytes) {
        const removed = this.messages.shift();
        if (!removed) break;
        this.totalBytes -= messageBytes(removed);
        changed = true;
      }
    }
    if (changed) {
      this.renumber();
      this.dirty = true;
      if (schedule) this.scheduleSave();
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 800);
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    this.savePromise = this.savePromise.then(async () => {
      try {
        await fs.mkdir(dirname(this.messagesPath), { recursive: true });
        const tmp = `${this.messagesPath}.tmp`;
        const handle = await fs.open(tmp, "w");
        try {
          for (const message of this.messages) {
            await handle.write(`${JSON.stringify(message)}\n`);
          }
        } finally {
          await handle.close();
        }
        await fs.rename(tmp, this.messagesPath);
        const meta: CacheMeta = {
          epoch: this.epoch,
          cursor: this.cursor,
          updatedAt: Date.now(),
          version: 1,
        };
        const metaTmp = `${this.metaPath}.tmp`;
        await fs.writeFile(metaTmp, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
        await fs.rename(metaTmp, this.metaPath);
      } catch (error) {
        this.dirty = true;
        console.warn("[chat-cache] save failed", error);
      }
    });
    await this.savePromise;
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.save();
  }

  /** 清空本地聊天记录与缩略图，保留 epoch 和窗口偏好。 */
  async clear(): Promise<void> {
    this.messages = [];
    this.seenIds.clear();
    this.nextSyntheticId = -1;
    this.totalBytes = 0;
    this.dirty = true;
    try {
      await fs.rm(this.thumbsDir, { recursive: true, force: true });
      await fs.mkdir(this.thumbsDir, { recursive: true });
    } catch (error) {
      console.warn("[chat-cache] clear thumbs failed", error);
    }
    await this.save();
  }
}

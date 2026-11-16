import { app } from "electron";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type {
  ChatAvatarHistoryItem,
  ChatProfileData,
  ChatProfileRole,
} from "../shared/types";

const PROFILE_VERSION = 1;
const HISTORY_LIMIT = 12;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MAX_NAME_LENGTH = 16;

const DEFAULT_NAMES: Record<ChatProfileRole, string> = {
  hiro: "希罗",
  me: "我",
};

type StoredAvatar = {
  id: string;
  createdAt: number;
};

type StoredEntry = {
  name: string;
  avatar: string | null;
  history: StoredAvatar[];
};

type StoredProfile = {
  version: number;
  hiro: StoredEntry;
  me: StoredEntry;
};

const DATA_URL = /^data:image\/(png|jpeg|webp);base64,([a-z0-9+/=\s]+)$/i;

function defaultEntry(role: ChatProfileRole): StoredEntry {
  return { name: DEFAULT_NAMES[role], avatar: null, history: [] };
}

function normalizeEntry(input: unknown, role: ChatProfileRole): StoredEntry {
  if (!input || typeof input !== "object") return defaultEntry(role);
  const record = input as Record<string, unknown>;
  const name =
    typeof record.name === "string" && record.name.trim()
      ? record.name.trim().slice(0, MAX_NAME_LENGTH)
      : DEFAULT_NAMES[role];
  const avatar = typeof record.avatar === "string" && record.avatar ? record.avatar : null;
  const history = Array.isArray(record.history)
    ? record.history
        .map((item): StoredAvatar | null => {
          if (!item || typeof item !== "object") return null;
          const row = item as Record<string, unknown>;
          const id = typeof row.id === "string" ? row.id.trim() : "";
          if (!/^[a-z0-9-]{4,64}$/i.test(id)) return null;
          return {
            id,
            createdAt:
              typeof row.createdAt === "number" && Number.isFinite(row.createdAt)
                ? Math.round(row.createdAt)
                : Date.now(),
          };
        })
        .filter((item): item is StoredAvatar => item !== null)
        .slice(0, HISTORY_LIMIT)
    : [];
  return { name, avatar, history };
}

function decodeDataUrl(value: string): { data: Buffer } | null {
  const match = DATA_URL.exec(value.trim());
  if (!match) return null;
  try {
    const data = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
    if (data.length === 0 || data.length > MAX_AVATAR_BYTES) return null;
    return { data };
  } catch {
    return null;
  }
}

function toDataUrl(data: Buffer, mime = "image/png"): string {
  return `data:${mime};base64,${data.toString("base64")}`;
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeProfileName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\r\n\t]+/g, " ").trim();
  if (!name) return null;
  const length = [...name].length;
  if (length < 1 || length > MAX_NAME_LENGTH) return null;
  return name;
}

class ProfileStore {
  private root = "";
  private jsonPath = "";
  private data: StoredProfile | null = null;
  private urls = new Map<string, string>();
  private loading: Promise<StoredProfile> | null = null;

  private ensurePaths(): void {
    if (this.root) return;
    this.root = join(app.getPath("userData"), "profile");
    this.jsonPath = join(this.root, "profile.json");
  }

  get dir(): string {
    this.ensurePaths();
    return this.root;
  }

  private avatarDir(role: ChatProfileRole): string {
    return join(this.dir, "avatars", role);
  }

  private avatarPath(role: ChatProfileRole, id: string): string {
    return join(this.avatarDir(role), `${id}.png`);
  }

  private async load(): Promise<StoredProfile> {
    if (this.data) return this.data;
    if (this.loading) return this.loading;
    this.ensurePaths();
    this.loading = (async () => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(await fs.readFile(this.jsonPath, "utf8"));
      } catch {
        parsed = null;
      }
      const record = (parsed ?? {}) as Record<string, unknown>;
      this.data = {
        version: PROFILE_VERSION,
        hiro: normalizeEntry(record.hiro, "hiro"),
        me: normalizeEntry(record.me, "me"),
      };
      return this.data;
    })();
    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  private async save(): Promise<void> {
    const data = this.data;
    if (!data) return;
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.jsonPath}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await fs.rename(tmp, this.jsonPath);
  }

  private async readAvatarUrl(role: ChatProfileRole, id: string): Promise<string | null> {
    const key = `${role}:${id}`;
    const cached = this.urls.get(key);
    if (cached) return cached;
    try {
      const raw = await fs.readFile(this.avatarPath(role, id));
      const url = toDataUrl(raw);
      this.urls.set(key, url);
      return url;
    } catch {
      return null;
    }
  }

  async getData(): Promise<ChatProfileData> {
    const data = await this.load();
    const build = async (role: ChatProfileRole) => {
      const entry = data[role];
      const avatar =
        entry.avatar !== null ? await this.readAvatarUrl(role, entry.avatar) : null;
      return { role, name: entry.name, avatar };
    };
    const [hiro, me] = await Promise.all([build("hiro"), build("me")]);
    return { hiro, me };
  }

  async setName(role: ChatProfileRole, raw: string): Promise<ChatProfileData> {
    const name = normalizeProfileName(raw);
    if (!name) throw new Error("名称需要 1–16 个字，且不能包含换行。");
    const data = await this.load();
    data[role].name = name;
    await this.save();
    return this.getData();
  }

  async saveAvatar(role: ChatProfileRole, dataUrl: string): Promise<ChatProfileData> {
    const decoded = decodeDataUrl(dataUrl);
    if (!decoded) throw new Error("头像图片读取失败，请换一张图试试。");
    const data = await this.load();
    const id = newId();
    await fs.mkdir(this.avatarDir(role), { recursive: true });
    await fs.writeFile(this.avatarPath(role, id), decoded.data);
    const entry = data[role];
    entry.avatar = id;
    entry.history = [
      { id, createdAt: Date.now() },
      ...entry.history.filter((item) => item.id !== id),
    ].slice(0, HISTORY_LIMIT);
    await this.cleanupHistory(role, entry);
    await this.save();
    return this.getData();
  }

  private async cleanupHistory(role: ChatProfileRole, entry: StoredEntry): Promise<void> {
    const kept = new Set(entry.history.map((item) => item.id));
    try {
      const files = await fs.readdir(this.avatarDir(role));
      for (const file of files) {
        const id = file.replace(/\.png$/i, "");
        if (!file.toLowerCase().endsWith(".png")) continue;
        if (kept.has(id)) continue;
        await fs.rm(join(this.avatarDir(role), file), { force: true });
        this.urls.delete(`${role}:${id}`);
      }
    } catch {
      // 目录还不存在时无需清理。
    }
  }

  async selectAvatar(role: ChatProfileRole, id: string | null): Promise<ChatProfileData> {
    const data = await this.load();
    const entry = data[role];
    if (id === null) {
      entry.avatar = null;
    } else {
      if (!entry.history.some((item) => item.id === id)) {
        throw new Error("这张头像已经不在历史里了。");
      }
      entry.avatar = id;
    }
    await this.save();
    return this.getData();
  }

  async resetAvatar(role: ChatProfileRole): Promise<ChatProfileData> {
    const data = await this.load();
    data[role].avatar = null;
    await this.save();
    return this.getData();
  }

  async history(role: ChatProfileRole): Promise<ChatAvatarHistoryItem[]> {
    const data = await this.load();
    const rows = await Promise.all(
      data[role].history.map(async (item) => {
        const src = await this.readAvatarUrl(role, item.id);
        return src ? { id: item.id, src, createdAt: item.createdAt } : null;
      }),
    );
    return rows.filter((item): item is ChatAvatarHistoryItem => item !== null);
  }

  async readPhoto(role: ChatProfileRole, id: string): Promise<string | null> {
    return this.readAvatarUrl(role, id);
  }
}

export const profileStore = new ProfileStore();

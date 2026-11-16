import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ChatMediaKind, ChatMediaResult } from "../../shared/types";
import { loadMedia } from "./client";

const MEDIA_ID_RE = /^[0-9a-f]{16,64}\.[a-z0-9]{2,5}$/i;
const MAX_THUMB_CACHE_BYTES = 200 * 1024 * 1024;
const MAX_MEMORY_ENTRIES = 240;

const MIME_BY_EXT: Record<string, string> = {
  gif: "image/gif",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  bmp: "image/bmp",
};

// 桥接插件生成的缩略图可能是 webp / png / jpg，按实际扩展名缓存。
const THUMB_EXT_BY_MIME: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
};

const THUMB_EXTS = ["webp", "png", "jpg", "gif"];

type CachedData = { dataUrl: string; mime: string };

function mimeFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "image/webp";
}

function thumbStem(media: string): string {
  return media.replace(/\.[a-z0-9]{2,5}$/i, "");
}

export class MediaCache {
  private readonly dir: string;
  private readonly memory = new Map<string, CachedData>();
  private pruneAt = 0;

  constructor(thumbsDir: string) {
    this.dir = thumbsDir;
  }

  private remember(key: string, data: CachedData): CachedData {
    this.memory.set(key, data);
    while (this.memory.size > MAX_MEMORY_ENTRIES) {
      const oldest = this.memory.keys().next().value;
      if (typeof oldest !== "string") break;
      this.memory.delete(oldest);
    }
    return data;
  }

  private async readLocalThumb(media: string): Promise<CachedData | null> {
    const stem = thumbStem(media);
    for (const ext of THUMB_EXTS) {
      try {
        const raw = await fs.readFile(join(this.dir, `${stem}.${ext}`));
        const mime = MIME_BY_EXT[ext] ?? "image/webp";
        return {
          mime,
          dataUrl: `data:${mime};base64,${raw.toString("base64")}`,
        };
      } catch {
        continue;
      }
    }
    return null;
  }

  async get(media: string, kind: ChatMediaKind): Promise<ChatMediaResult> {
    if (!MEDIA_ID_RE.test(media)) {
      return { ok: false, error: "图片 id 不正确。" };
    }
    const cacheKey = `${kind}:${media}`;
    const cached = this.memory.get(cacheKey);
    if (cached) {
      return { ok: true, dataUrl: cached.dataUrl, mime: cached.mime };
    }

    if (kind === "thumb") {
      const local = await this.readLocalThumb(media);
      if (local) {
        return { ok: true, ...this.remember(cacheKey, local) };
      }
    }

    const result = await loadMedia(media, kind);
    if (!result.ok) return result;

    if (kind === "thumb") {
      const comma = result.dataUrl.indexOf(",");
      if (comma > 0) {
        try {
          const raw = Buffer.from(result.dataUrl.slice(comma + 1), "base64");
          const ext = THUMB_EXT_BY_MIME[result.mime] ?? "webp";
          await fs.mkdir(this.dir, { recursive: true });
          const target = join(this.dir, `${thumbStem(media)}.${ext}`);
          const tmp = `${target}.tmp`;
          await fs.writeFile(tmp, raw);
          await fs.rename(tmp, target);
          await this.pruneIfNeeded();
        } catch (error) {
          console.warn("[chat-media] cache thumbnail failed", error);
        }
      }
    }

    const data: CachedData = { dataUrl: result.dataUrl, mime: result.mime };
    if (kind === "thumb") this.remember(cacheKey, data);
    return { ok: true, dataUrl: data.dataUrl, mime: data.mime };
  }

  private async pruneIfNeeded(): Promise<void> {
    const now = Date.now();
    if (now < this.pruneAt) return;
    this.pruneAt = now + 10 * 60_000;
    try {
      const entries = await fs.readdir(this.dir, { withFileTypes: true });
      const files: { path: string; size: number; mtime: number }[] = [];
      let total = 0;
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.endsWith(".tmp")) continue;
        try {
          const stat = await fs.stat(join(this.dir, entry.name));
          total += stat.size;
          files.push({
            path: join(this.dir, entry.name),
            size: stat.size,
            mtime: stat.mtimeMs,
          });
        } catch {
          continue;
        }
      }
      if (total <= MAX_THUMB_CACHE_BYTES) return;
      files.sort((a, b) => a.mtime - b.mtime);
      for (const file of files) {
        if (total <= MAX_THUMB_CACHE_BYTES * 0.75) break;
        try {
          await fs.unlink(file.path);
          total -= file.size;
        } catch {
          continue;
        }
      }
    } catch (error) {
      console.warn("[chat-media] prune failed", error);
    }
  }
}

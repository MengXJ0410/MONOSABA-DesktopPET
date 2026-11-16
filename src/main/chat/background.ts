import { app } from "electron";
import { promises as fs } from "node:fs";
import { join } from "node:path";

const FOLDER = "background";
const FILE_PATTERN = /^background\.(png|jpe?g|webp)$/i;
const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=\s]+)$/i;
const MAX_BYTES = 12 * 1024 * 1024;

function dirPath(): string {
  return join(app.getPath("userData"), FOLDER);
}

function extFor(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}

function mimeFor(file: string): string {
  const ext = file.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

function toDataUrl(data: Buffer, mime: string): string {
  return `data:${mime};base64,${data.toString("base64")}`;
}

class BackgroundStore {
  async load(): Promise<string | null> {
    try {
      const dir = dirPath();
      const files = await fs.readdir(dir);
      const file = files.find((name) => FILE_PATTERN.test(name));
      if (!file) return null;
      const data = await fs.readFile(join(dir, file));
      return toDataUrl(data, mimeFor(file));
    } catch {
      return null;
    }
  }

  async save(dataUrl: string): Promise<{ image: string; dataUrl: string }> {
    const match = DATA_URL.exec(dataUrl.trim());
    if (!match) throw new Error("背景图格式不正确，请换一张图片。");
    const mime = match[1].toLowerCase();
    const data = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
    if (data.length === 0) throw new Error("背景图读取失败，请换一张图片。");
    if (data.length > MAX_BYTES) {
      throw new Error("背景图太大了，请换一张 12MB 以内的图片。");
    }

    const dir = dirPath();
    await fs.mkdir(dir, { recursive: true });
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    for (const file of files) {
      if (FILE_PATTERN.test(file)) {
        await fs.rm(join(dir, file), { force: true });
      }
    }
    const image = `background.${extFor(mime)}`;
    await fs.writeFile(join(dir, image), data);
    return { image, dataUrl: toDataUrl(data, mime) };
  }

  async clear(): Promise<void> {
    const dir = dirPath();
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (FILE_PATTERN.test(file)) {
          await fs.rm(join(dir, file), { force: true });
        }
      }
    } catch {
      // 目录不存在时无需清理。
    }
  }
}

export const backgroundStore = new BackgroundStore();

import { app } from "electron";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PetConfig } from "../shared/types";

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
  },
};

export function configPath(): string {
  return join(app.getPath("userData"), "config.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeConfig(input: unknown): PetConfig {
  const diary = isRecord(input) && isRecord(input.diary) ? input.diary : {};
  const hosts = Array.isArray(diary.hosts)
    ? diary.hosts.filter((host): host is string => typeof host === "string" && host.trim().length > 0)
    : DEFAULT_CONFIG.diary.hosts;

  return {
    diary: {
      hosts: hosts.length > 0 ? hosts : DEFAULT_CONFIG.diary.hosts,
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
    },
  };
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
  const path = await ensureConfig();
  try {
    const raw = await fs.readFile(path, "utf8");
    return normalizeConfig(JSON.parse(raw.replace(/^\uFEFF/, "")) as unknown);
  } catch {
    return normalizeConfig(DEFAULT_CONFIG);
  }
}

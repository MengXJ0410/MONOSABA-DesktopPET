import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DiaryConfig, DiaryPayload, MemoryPayload } from "../../shared/types";
import { readConfig } from "../config";

const execFileAsync = promisify(execFile);
const MAX_BYTES = 4 * 1024 * 1024;
const SSH_TIMEOUT_MS = 20_000;

class DiaryRemoteError extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "network" | "remote" | "missing-ssh",
  ) {
    super(message);
    this.name = "DiaryRemoteError";
  }
}

function pythonScript(dir: string, requestedBook: string | null): string {
  const requested = requestedBook
    ? JSON.stringify(requestedBook)
    : "None";

  return `
import json, os, re, sys

DIR = ${JSON.stringify(dir)}
REQUESTED = ${requested}
MAX = ${MAX_BYTES}
PATTERN = re.compile(r"^日记本(?:-(\\d+))?\\.md$")

def volume(name):
    m = PATTERN.match(name)
    return int(m.group(1)) if m and m.group(1) else 1

def empty():
    print(json.dumps({
        "books": [], "book": None, "content": "", "size": 0,
        "mtime": 0, "truncated": False,
    }, ensure_ascii=False))
    sys.exit(0)

try:
    names = os.listdir(DIR)
except FileNotFoundError:
    empty()

books = []
for name in names:
    m = PATTERN.match(name)
    if not m:
        continue
    path = os.path.join(DIR, name)
    if not os.path.isfile(path):
        continue
    st = os.stat(path)
    books.append({
        "name": name,
        "size": st.st_size,
        "mtime": int(st.st_mtime * 1000),
        "_volume": volume(name),
    })

if not books:
    empty()

books.sort(key=lambda item: item["_volume"])

chosen = None
if REQUESTED:
    for item in books:
        if item["name"] == REQUESTED:
            chosen = item
            break
if chosen is None:
    for item in books:
        if item["name"] == "日记本.md":
            chosen = item
            break
if chosen is None:
    chosen = books[-1]

path = os.path.join(DIR, chosen["name"])
st = os.stat(path)
size = st.st_size
truncated = False

if size > MAX:
    with open(path, "rb") as handle:
        handle.seek(max(0, size - MAX))
        text = handle.read().decode("utf-8", "replace")
    first_newline = text.find("\\n")
    if first_newline >= 0:
        text = text[first_newline + 1:]
    content = "（日记本超过 4MB，只显示最新部分）\\n\\n" + text
    truncated = True
else:
    with open(path, "rb") as handle:
        content = handle.read().decode("utf-8", "replace")

for item in books:
    item.pop("_volume", None)

print(json.dumps({
    "name": chosen["name"],
    "size": size,
    "mtime": int(st.st_mtime * 1000),
    "books": books,
    "book": chosen["name"],
    "content": content,
    "truncated": truncated,
}, ensure_ascii=False))
`;
}

function isAuthError(message: string): boolean {
  return /permission denied|authentication failed|no supported authentication/i.test(message);
}

function isHostKeyError(message: string): boolean {
  return /host key verification failed|remote host identification has changed/i.test(message);
}

/** 远端脚本可能被 shell 提示信息包住，取最后一行完整 JSON。 */
function extractJson(raw: string): string {
  const text = raw.trim();
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{") && line.endsWith("}"))
      .pop() ?? text
  );
}

async function runSsh(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("ssh", args, {
      encoding: "utf8",
      timeout: SSH_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;

    // 便携版没有继承开发终端的 PATH 时，回退到 Windows 自带 OpenSSH。
    const windowsSsh = join(
      process.env.WINDIR ?? "C:\\Windows",
      "System32",
      "OpenSSH",
      "ssh.exe",
    );
    try {
      await fs.access(windowsSsh);
    } catch {
      throw new DiaryRemoteError(
        "找不到 ssh 命令，请确认 Windows OpenSSH 客户端已安装。",
        "missing-ssh",
      );
    }
    return execFileAsync(windowsSsh, args, {
      encoding: "utf8",
      timeout: SSH_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
  }
}

function buildArgs(config: DiaryConfig, host: string, remoteCommand: string): string[] {
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "LogLevel=ERROR",
    "-i",
    config.privateKeyPath,
    "-p",
    String(config.port),
    `${config.username}@${host}`,
    remoteCommand,
  ];
}

async function loadFromHost(
  config: DiaryConfig,
  host: string,
  requestedBook: string | null,
): Promise<DiaryPayload> {
  const script = pythonScript(config.remoteDir, requestedBook);
  const encoded = Buffer.from(script, "utf8").toString("base64");
  // 用 base64 把 Python 脚本送到远端，避开中文、引号和换行在 SSH 命令里的转义问题。
  const remoteCommand = `printf %s '${encoded}' | base64 -d | python3 -`;

  const { stdout, stderr } = await runSsh(buildArgs(config, host, remoteCommand));
  const text = extractJson(stdout);
  if (!text) {
    throw new DiaryRemoteError(
      `日记本返回为空。${stderr ? ` ${stderr.trim()}` : ""}`.trim(),
      "remote",
    );
  }

  let payload: DiaryPayload;
  try {
    payload = JSON.parse(text) as DiaryPayload;
  } catch {
    throw new DiaryRemoteError("日记本返回格式不正确。", "remote");
  }
  return payload;
}

function toHostError(error: unknown): DiaryRemoteError {
  if (error instanceof DiaryRemoteError) return error;
  const stderr = (error as { stderr?: string } | null)?.stderr?.trim();
  const message =
    stderr || (error instanceof Error ? error.message : String(error));
  if (isAuthError(message)) {
    return new DiaryRemoteError(
      "SSH 认证失败，检查 config.json 里的 privateKeyPath。",
      "auth",
    );
  }
  if (isHostKeyError(message)) {
    return new DiaryRemoteError(
      "服务器主机密钥校验失败，请检查本机 known_hosts。",
      "auth",
    );
  }
  return new DiaryRemoteError(message || "连接失败", "network");
}

/** 本机是否具备打开日记的条件（只检查 SSH 私钥是否存在）。 */
export async function diaryAvailability(): Promise<boolean> {
  const config = (await readConfig()).diary;
  try {
    await fs.access(config.privateKeyPath);
    return true;
  } catch {
    return false;
  }
}

export async function loadDiary(requestedBook?: string | null): Promise<DiaryPayload> {
  const config = (await readConfig()).diary;

  try {
    await fs.access(config.privateKeyPath);
  } catch {
    throw new DiaryRemoteError(
      `读不到 SSH 私钥：${config.privateKeyPath}`,
      "auth",
    );
  }

  let lastError: DiaryRemoteError | null = null;

  for (const host of config.hosts) {
    try {
      return await loadFromHost(config, host, requestedBook ?? null);
    } catch (error) {
      const mapped = toHostError(error);
      if (mapped.kind === "missing-ssh" || mapped.kind === "auth") {
        throw mapped;
      }
      lastError = mapped;
      console.warn(`[diary] ${host} 连接失败`, mapped.message);
    }
  }

  throw lastError ?? new DiaryRemoteError(
    "连不上日记本，确认 EasyTier 在线。",
    "network",
  );
}

function memoryScript(dir: string): string {
  return `
import glob, json, os

DIR = ${JSON.stringify(dir)}
rows = []
days = set()

for path in sorted(glob.glob(os.path.join(DIR, "*.jsonl"))):
    try:
        handle = open(path, "r", encoding="utf-8", errors="replace")
    except OSError:
        continue
    with handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except Exception:
                continue
            date = str(item.get("date") or "")
            text = str(item.get("text") or "")
            if not date or not text:
                continue
            try:
                imp = int(item.get("imp") or 0)
            except Exception:
                imp = 0
            rows.append({
                "date": date,
                "kind": str(item.get("kind") or ""),
                "imp": imp,
                "text": text,
                "scope": str(item.get("scope") or ""),
            })
            days.add(date)

rows.sort(key=lambda row: row["date"], reverse=True)
print(json.dumps({"entries": rows, "days": len(days), "count": len(rows)}, ensure_ascii=False))
`;
}

/** 通过同一套 SSH 通道跑一段脚本，并解析最后一行 JSON。 */
async function runRemoteJson<T>(
  config: DiaryConfig,
  script: string,
  label: string,
  fallbackError: string,
): Promise<T> {
  const encoded = Buffer.from(script, "utf8").toString("base64");
  const remoteCommand = `printf %s '${encoded}' | base64 -d | python3 -`;

  let lastError: DiaryRemoteError | null = null;
  for (const host of config.hosts) {
    try {
      const { stdout, stderr } = await runSsh(buildArgs(config, host, remoteCommand));
      const text = extractJson(stdout);
      if (!text) {
        throw new DiaryRemoteError(
          `返回为空。${stderr ? ` ${stderr.trim()}` : ""}`.trim(),
          "remote",
        );
      }
      return JSON.parse(text) as T;
    } catch (error) {
      const mapped = toHostError(error);
      if (mapped.kind === "missing-ssh" || mapped.kind === "auth") {
        throw mapped;
      }
      lastError = mapped;
      console.warn(`[${label}] ${host} 连接失败`, mapped.message);
    }
  }

  throw lastError ?? new DiaryRemoteError(fallbackError, "network");
}

/** 读取服务器上的长久记忆（只读，一次取全部 JSONL）。 */
export async function loadMemory(): Promise<MemoryPayload> {
  const config = (await readConfig()).diary;

  try {
    await fs.access(config.privateKeyPath);
  } catch {
    throw new DiaryRemoteError(
      `读不到 SSH 私钥：${config.privateKeyPath}`,
      "auth",
    );
  }

  return runRemoteJson<MemoryPayload>(
    config,
    memoryScript(config.memoryDir),
    "memory",
    "连不上记忆库，确认 EasyTier 在线。",
  );
}

export { DiaryRemoteError };

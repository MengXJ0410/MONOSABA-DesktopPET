import { app } from "electron";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * 主进程的轻量日志。写入 userData/logs，超过 512KB 轮换一次。
 * 日志失败不影响业务。
 */
async function appendLog(name: string, line: string): Promise<void> {
  try {
    const dir = join(app.getPath("userData"), "logs");
    await mkdir(dir, { recursive: true });
    const file = join(dir, name);
    try {
      const info = await stat(file);
      if (info.size > 512 * 1024) {
        await rename(file, join(dir, name.replace(/\.log$/, ".1.log")));
      }
    } catch {
      // 文件还不存在。
    }
    await appendFile(file, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    // 日志失败不影响业务。
  }
}

/** 启动来源、第二实例、自启维护记录。 */
export function logStartup(line: string): void {
  void appendLog("startup.log", line);
}

/** 聊天窗口创建、切换、加载失败、自动恢复记录。 */
export function logChatWindow(line: string): void {
  void appendLog("chat-window.log", line);
}

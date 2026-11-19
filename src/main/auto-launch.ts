import { app } from "electron";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readConfig, updateAutoLaunch } from "./config";
import { logStartup } from "./logs";

type LaunchTarget = { path: string; args: string[] };

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const APP_RUN_NAME = "com.mengxj.monosaba.desktop-pet";
/** 计划任务名；不能带路径分隔符。 */
const TASK_NAME = "MONOSABA DesktopPET";
const AUTOSTART_FLAG = "--autostart";

/**
 * 便携版每次运行都会解压到临时目录，进程自身的 execPath 会失效；
 * electron-builder 会给出原始 exe 路径，开机自启要登记这个路径。
 * `--autostart` 让第二实例知道这次是开机拉起，只露桌宠、不弹聊天。
 */
function resolveLaunchTarget(): LaunchTarget {
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portableExe && existsSync(portableExe)) {
    return { path: portableExe, args: [AUTOSTART_FLAG] };
  }
  if (app.isPackaged) {
    return { path: process.execPath, args: [AUTOSTART_FLAG] };
  }
  // 开发模式：开机时用 Electron 可执行文件重新打开当前项目。
  return { path: process.execPath, args: [app.getAppPath(), AUTOSTART_FLAG] };
}

function systemRoot(): string {
  return process.env.SystemRoot ?? "C:\\Windows";
}

function powershell(script: string): { ok: boolean; output: string } {
  const exe = `${systemRoot()}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  try {
    const output = execFileSync(
      exe,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 30_000 },
    );
    return { ok: true, output };
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? "";
    const stderr = (error as { stderr?: string }).stderr ?? "";
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, output: `${stdout}${stderr}${message}`.trim() };
  }
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function readRunEntries(): { name: string; command: string }[] {
  if (process.platform !== "win32") return [];
  const reg = `${systemRoot()}\\System32\\reg.exe`;
  try {
    const output = execFileSync(reg, ["query", RUN_KEY], {
      encoding: "utf8",
      windowsHide: true,
    });
    const entries: { name: string; command: string }[] = [];
    for (const line of output.split(/\r?\n/)) {
      const match = /^\s{2,}(.+?)\s{4,}REG_(?:EXPAND_)?SZ\s{4,}(.+)$/.exec(line);
      if (!match) continue;
      entries.push({ name: match[1].trim(), command: match[2].trim() });
    }
    return entries;
  } catch {
    return [];
  }
}

/** 旧版本登记过自启（路径可能已经因为换版本失效）。 */
function hasLegacyRunEntry(): boolean {
  return readRunEntries().some(
    (entry) =>
      entry.name.toLowerCase() === APP_RUN_NAME ||
      /monosaba/i.test(entry.name) ||
      /MONOSABA-DesktopPET/i.test(entry.command),
  );
}

function runEntryExists(): boolean {
  return readRunEntries().some(
    (entry) => entry.name.toLowerCase() === APP_RUN_NAME,
  );
}

function writeRunEntry(target: LaunchTarget): boolean {
  const reg = `${systemRoot()}\\System32\\reg.exe`;
  const command = [`"${target.path}"`, ...target.args].join(" ").trim();
  try {
    execFileSync(
      reg,
      ["add", RUN_KEY, "/v", APP_RUN_NAME, "/t", "REG_SZ", "/d", command, "/f"],
      { windowsHide: true, stdio: "ignore" },
    );
    return true;
  } catch (error) {
    logStartup(`写入 Run 项失败 ${String(error)}`);
    return false;
  }
}

function removeRunEntry(): void {
  if (process.platform !== "win32") return;
  const reg = `${systemRoot()}\\System32\\reg.exe`;
  try {
    execFileSync(reg, ["delete", RUN_KEY, "/v", APP_RUN_NAME, "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } catch {
    // 本来就没有。
  }
}

function taskExists(): boolean {
  if (process.platform !== "win32") return false;
  try {
    execFileSync(`${systemRoot()}\\System32\\schtasks.exe`, ["/Query", "/TN", TASK_NAME], {
      windowsHide: true,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function taskEnabled(): boolean {
  if (process.platform !== "win32") return false;
  const script = [
    `$t = Get-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -ErrorAction SilentlyContinue`,
    "if ($t) { $t.State } else { 'Missing' }",
  ].join("\n");
  const result = powershell(script);
  const state = result.output.trim().toLowerCase();
  return result.ok && state.length > 0 && state !== "missing" && state !== "disabled";
}

function deleteTask(): void {
  if (process.platform !== "win32") return;
  try {
    execFileSync(`${systemRoot()}\\System32\\schtasks.exe`, ["/Delete", "/TN", TASK_NAME, "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } catch {
    // 本来就没有。
  }
}

/**
 * 用当前用户的登录计划任务代替 Run 项：
 * 0.3.7 的 Run 项虽然被 Windows 执行了，但登录后要等约 100 秒才拉起，
 * 用户往往已经手动开过一次，第二个实例被单实例锁吞掉，看起来就像没自启。
 * 计划任务可以指定登录后延迟，并由 Task Scheduler 记录实际执行时间。
 */
function registerTask(target: LaunchTarget): boolean {
  const args = target.args.join(" ");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$name = ${psQuote(TASK_NAME)}`,
    `$exe = ${psQuote(target.path)}`,
    `$arg = ${psQuote(args)}`,
    '$user = "$env:USERDOMAIN\\$env:USERNAME"',
    "$action = New-ScheduledTaskAction -Execute $exe -Argument $arg",
    "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user",
    "$trigger.Delay = 'PT12S'",
    "$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited",
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)",
    "Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null",
    "Write-Output 'ok'",
  ].join("\n");
  const result = powershell(script);
  if (!result.ok) {
    logStartup(`计划任务创建失败 ${result.output}`);
    return false;
  }
  return true;
}

/**
 * `Get-ScheduledTask` 要走一次 PowerShell，约 1.5 秒；设置面板每次打开都会读，
 * 放在主进程同步执行会卡住窗口。启动时 `ensureAutoLaunch()` 已经确认过一次，
 * 这里缓存结果，只有启动流程没跑到（开发模式）时才真正查询。
 */
let cachedEnabled: boolean | null = null;

export function getAutoLaunchEnabled(): boolean {
  if (process.platform === "win32") {
    if (cachedEnabled === null) cachedEnabled = getAutoLaunchEnabledNow();
    return cachedEnabled;
  }
  try {
    const target = resolveLaunchTarget();
    return app.getLoginItemSettings({ path: target.path, args: target.args }).openAtLogin;
  } catch (error) {
    console.warn("[auto-launch] read failed", error);
    return false;
  }
}

/**
 * 启动时调用：沿用用户上次的选择，并把自启路径修到当前 exe。
 * 便携版的 exe 名带版本号，升级后旧登记会指向已删除的文件。
 */
export async function ensureAutoLaunch(): Promise<void> {
  if (!app.isPackaged || process.platform !== "win32") return;
  try {
    const config = await readConfig();
    let intent = config.autoLaunch;
    if (!intent && (taskExists() || hasLegacyRunEntry())) {
      // 升级前开过自启：登记还在，但路径是旧版本，迁移成“开启”意图。
      intent = true;
      await updateAutoLaunch(true);
      logStartup("检测到旧自启登记，迁移为开启意图");
    }
    if (!intent) {
      deleteTask();
      removeRunEntry();
      cachedEnabled = false;
      return;
    }

    const target = resolveLaunchTarget();
    if (registerTask(target)) {
      if (runEntryExists()) {
        removeRunEntry();
        logStartup("计划任务已接管自启，已删除旧 Run 项");
      }
      logStartup(`自启计划任务已登记 ${target.path} ${target.args.join(" ")}`);
      cachedEnabled = true;
      return;
    }

    // 计划任务不可用（组策略、权限限制等）时退回 Run 项，至少保证还能自启。
    logStartup("计划任务不可用，回退到 Run 项");
    if (writeRunEntry(target)) {
      logStartup(`Run 项已写入 ${target.path} ${target.args.join(" ")}`);
      cachedEnabled = true;
    }
  } catch (error) {
    logStartup(`ensureAutoLaunch 失败 ${String(error)}`);
    console.warn("[auto-launch] ensure failed", error);
  }
}

export async function setAutoLaunchEnabled(enabled: boolean): Promise<boolean> {
  if (process.platform === "win32") {
    const target = resolveLaunchTarget();
    if (enabled) {
      if (registerTask(target)) {
        removeRunEntry();
        logStartup("设置里开启自启：计划任务已登记");
      } else if (writeRunEntry(target)) {
        logStartup("设置里开启自启：计划任务失败，已回退 Run 项");
      }
    } else {
      deleteTask();
      removeRunEntry();
      logStartup("设置里关闭自启：已清理计划任务和 Run 项");
    }
  } else {
    try {
      const target = resolveLaunchTarget();
      app.setLoginItemSettings({
        openAtLogin: enabled,
        path: target.path,
        args: target.args,
      });
    } catch (error) {
      console.warn("[auto-launch] write failed", error);
    }
  }
  try {
    await updateAutoLaunch(enabled);
  } catch (error) {
    console.warn("[auto-launch] persist failed", error);
  }
  // 刚写过的登记就是当前状态；用 30ms 的 schtasks 查询核对，不再花 1.5 秒走 PowerShell。
  cachedEnabled = getAutoLaunchEnabledNow();
  return cachedEnabled;
}

/** 绕过缓存真实查询一次，供设置切换后核对结果。 */
function getAutoLaunchEnabledNow(): boolean {
  if (process.platform !== "win32") return getAutoLaunchEnabled();
  // 没有计划任务时直接看 Run 项，避免为了返回 false 还等一次 PowerShell。
  if (!taskExists()) return runEntryExists();
  // 计划任务可能是被禁用状态，这种情况才需要读 State。
  return taskEnabled();
}

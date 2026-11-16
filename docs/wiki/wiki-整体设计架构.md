---
title: 整体设计架构
summary: Electron 全屏透明覆盖层 + Live2D + AstrBot 桥接：桌宠、日记和仿 QQ 聊天终端是怎么拼起来的。
tags: [桌宠, Electron, Live2D, AstrBot, 架构]
order: 100
---

> 发布信息（复制到编辑器对应输入框，正文从分隔线后开始）
>
> - 标题：整体设计架构
> - 摘要：Electron 全屏透明覆盖层 + Live2D + AstrBot 桥接：桌宠、日记和仿 QQ 聊天终端是怎么拼起来的。
> - 标签：桌宠、Electron、Live2D、AstrBot、架构

---

MONOSABA DesktopPET 是把网站里的希罗 / 艾玛 Live2D 看板娘搬到 Windows 桌面的独立程序。它不是一个缩小版网页，而是三层结构：**全屏透明覆盖层负责人物与桌面交互，本地主进程负责窗口 / 配置 / 存储，AstrBot 桥接插件负责和手机 QQ 共用同一个会话**。

当前桌面版本 **0.2.0**，服务器桥接插件 **0.3.1**。

## 为什么是全屏透明覆盖层

网页版的布局、气泡、控制面板、拖拽和视线跟随都依赖「整个视口都是人物的画布」，改成小窗口会推翻全部布局。所以桌宠直接铺满所在屏幕的工作区：

- 无边框、透明、置顶、不占任务栏；
- 窗口 `focusable: false`（Windows 下对应 `WS_EX_NOACTIVATE`），点击、拖拽、滚轮都响应，但不会把前台窗口切走；
- 需要点击穿透时用 `setIgnoreMouseEvents(true, { forward: true })`，只把人物实际 alpha 区域、齿轮、面板和小窗「接管」回来；
- 命中判定放在渲染层用 `mousemove` 的 `clientX/clientY` 做，避免缩放屏下主进程坐标和渲染坐标错位。

**已知限制**：全屏覆盖层会让部分播放器（典型是 B 站桌面客户端）在黑屏检测上误判。`focusable: false` 只能缓解，不能彻底解决；最终没有继续修。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 壳 | Electron 45 + electron-vite 6 |
| 渲染 | React 19 + TypeScript |
| Live2D | PixiJS 8 + `untitled-pixi-live2d-engine` + Cubism 5 |
| 打包 | electron-builder，Windows x64 便携版 |
| 服务端 | AstrBot 4.29 + 自写桥接插件 + NapCat（OneBot v11） |

不使用 Next.js、数据库和前端路由：桌宠是单页多视图（人物视图 / 聊天视图 / 日记窗口），路由成本高于收益。

## 进程与视图

```
main
 ├─ window.ts            全屏透明覆盖层、置顶、屏幕切换、强制顶层
 ├─ mouse-passthrough.ts 原生鼠标穿透 + 渲染层命中并集
 ├─ cursor-hit-test.ts   按人物 alpha / 控件矩形决定是否接管鼠标
 ├─ tray.ts              托盘菜单、未读红点图标
 ├─ config.ts            %APPDATA%\monosaba-desktoppet\config.json
 ├─ auto-launch.ts       开机自启（写 HKCU Run）
 ├─ diary/               系统 OpenSSH 读日记与记忆（ssh2 在 Electron 主进程会卡死，弃用）
 ├─ chat/                聊天服务、桥接客户端、截图、缓存、媒体
 ├─ profile.ts           本机资料：显示名 + 头像 + 历史头像
 ├─ diary-window.ts      独立可聚焦日记窗口
 └─ chat-window.ts       小窗 / 完整版聊天窗口与全部 chat:* IPC

preload
 └─ contextBridge 暴露 window.petApi（人物、日记、聊天、资料、主题、存储）

renderer
 ├─ 人物视图（全屏透明）
 ├─ 聊天视图 ?view=chat
 └─ 日记视图 ?view=diary
```

聊天窗口和日记窗口都是独立的 `BrowserWindow`，与人物覆盖层分开：人物层永远不可聚焦，聊天 / 日记需要键盘输入时可以正常抢焦点。

## 人物与桌面交互

- **点击**：随机表情 + 气泡；艾玛有 75% 概率播放点击音效（冷却 1 秒）。
- **拖拽**：左键按住 ≥0.5 秒且位移 >4px，或直接中键拖动；位置写入 localStorage。
- **缩放**：控制面板滑杆 10%–300%，与位置一起持久化。
- **双击右下角图标**：打开聊天（240ms 判定，单击仍然是控制面板，艾玛不接入聊天）。
- **屏幕切换**：按坐标排序编号「屏幕 1 / 屏幕 2 / …」，主屏标注；托盘也有兜底入口。
- **强制顶层**：开启后窗口扩展到整屏（含任务栏）并压在置顶层最前；关闭时先改尺寸、再声明 `alwaysOnTop`、最后 `moveTop`，否则窗口会掉到最底层。
- **自动轮换**：5–600 秒区间随机，悬停滑杆设置；人物隐藏或面板打开时暂停。
- **悬停变淡**：常态 / 悬停两档不透明度，开启穿透后鼠标移到人物上 0.3 秒渐变，移开 0.2 秒恢复。
- **面板主题**：根节点 `data-pet-character="hiro|ema"` 切换黑红 / 白粉两套令牌，面板尺寸和布局不变，只换颜色。

## 日记与记忆

日记和记忆不经过网站 API，直接用系统 OpenSSH 读服务器上的文件：

```
ssh <user>@<host> "cat …/diary/<date>.json"
ssh <user>@<host> "cat …/memory/*.jsonl"
```

- 独立小窗口，右上角最小化 / 关闭；保留网页版咒语 `hiro110`，输错会提示正确密钥。
- 「重新载入」是左下角红色环形刷新图标，「合上日记」是左下角折纸角 + 纸张色 ✖。
- 记忆入口在右下角，平时隐藏、悬停渐显；切到记忆页时用 `capturePage` 做 16px 方块的马赛克溶解。
- 「篡改记忆の魔法」：华文行楷红字入口，开启后 64px 钢笔光标；选中一条可改正文，其余内容被黑色为主的随机马赛克遮罩并轻微抽搐。写入走 SSH + `docker exec`，改完触发记忆插件重建当天索引。

## 聊天与 QQ 互通

这是整个项目最复杂的部分，单独成篇：**《仿QQ聊天终端》**。这里只放总体拓扑：

```
桌面聊天窗口 ──HTTP(Bearer)──▶ astrbot_plugin_desktoppet_bridge
      ▲                              │
      │  /bootstrap /messages        │ 注入 AstrBotMessage（假 bot，只回桌面）
      │  /send /status /media        ▼
      └────────────────────────  AstrBot 会话（UMO: Hiro:FriendMessage:1955272576）
                                     │
                                     ├─ 正式回复 → NapCat → 手机 QQ
                                     └─ 发送层被插件包装 → 写入桌面日志
```

关键约束：

- 桌面消息**只回桌面**，不投递到 QQ；手机 QQ 的消息靠桥接插件在发送层逐条记录，桌面增量轮询。
- 会话、人格、长期记忆与手机 QQ 完全共用，所以桌面和手机看到的是同一个希罗。
- 桥接需要 `plugin` scope 的 API Key；Key 只在本地配置和服务器数据库里。

## 本地存储

| 数据 | 位置 |
| --- | --- |
| 配置 | `%APPDATA%\monosaba-desktoppet\config.json` |
| 聊天记录 | 默认 `%APPDATA%\monosaba-desktoppet\chat-cache\`（可迁移） |
| 缩略图 | 同目录 `thumbs/` |
| 本机资料 | `%APPDATA%\monosaba-desktoppet\profile\profile.json` |
| 自定义头像 | 同目录 `avatars\<角色>\<id>.png`，每角色保留 12 张 |
| 人物位置 / 缩放 / 开关 | 渲染层 localStorage |

聊天记录支持在设置里改到任意可写目录：先复制 `messages.jsonl`、`meta.json`、`thumbs/` 到新目录再切换，旧目录保留为备份；目标目录已有聊天记录会拒绝，失败不动原数据。

## 构建与发布

```bash
npm install
npm run typecheck
npm run build          # electron-vite build
npm run build:win      # 产出 dist/MONOSABA-DesktopPET-<version>-portable.exe
```

- 默认人物决定 exe 图标：`VITE_DEFAULT_CHARACTER=ema` 使用 `build/icon-ema.ico`，否则用希罗 `build/icon.ico`。
- 便携版不写注册表，双击即用；首次启动会在 `%APPDATA%` 建配置目录，聊天记录与头像都在用户目录。
- 开机自启写 `HKCU\...\Run`，指向当前 exe 路径；移动 exe 后需要重新开关一次。

## 已知限制

- 全屏透明覆盖层与个别播放器的黑屏检测冲突（B 站客户端），未能彻底解决。
- 人物窗口不可聚焦，控制面板里的键盘快捷键（Esc、方向键）不可用。
- 日记 / 记忆依赖 EasyTier + 本机 OpenSSH；外部机器没有网络时只能看到「啥也没写」。
- 桥接插件的发送层捕获依赖 AstrBot 内部结构，升级大版本后需要回归 `/ping` 的 `capture.wrapped`。

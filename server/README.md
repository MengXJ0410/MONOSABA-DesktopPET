# AstrBot 桥接插件

`astrbot_plugin_desktoppet_bridge` 让 MONOSABA DesktopPET 的聊天窗口和手机 QQ 私聊共用同一个 AstrBot 会话。

当前版本 **0.4.3**：新增 `GET /skills`，给桌面端左侧栏「SKILL」读取指针 SKILL 统计 / 正文 / 最近改动，以及 `/AstrBot/data/skills/` 下的自定义 SKILL；保留 0.4.2 的 `steps`、SKILL 注入、撤回与引用。配套 real interaction 0.1.1、mood 1.5.0、sleep 0.1.4、life 0.1.9。

- 桌面消息注入 `Hiro:FriendMessage:1955272576`，走完整管线（人格 / 记忆 / 会话）。
- 注入事件使用假 bot，希罗对桌面消息的回复不会发到 QQ。
- 在 bot 的**实际发送层**（`send_private_msg`）逐条记录消息，保留 QQ 的分段节奏、表情包和指令回复。
- 手机 QQ 的用户消息由 `on_llm_request` 记录。
- 支持图片 / GIF：原图存 `media/`，日志只存元数据，缩略图按需生成。
- 桌面端可以使用全部 AstrBot 指令（注入事件按管理员处理）。
- `/retract` 撤回刚发的这一轮，`/pointer` 让希罗看屏并决定第二指针动作（单点或 `steps` 连续轨迹）。
- 指针观察前从 `astrbot_plugin_hiro_interaction` 取 SKILL + 最近落点，动作后回写轨迹；插件缺失时 fail-open。

## 部署

```bash
scp -r astrbot_plugin_desktoppet_bridge \
  mxjserver@10.144.144.1:/home/mxjserver/astrbot/data/plugins/
ssh mxjserver@10.144.144.1 "docker restart astrbot"
```

启动日志里应出现：

```text
[desktoppet] 桥接 0.4.3 已加载 umo=Hiro:FriendMessage:1955272576 platform=Hiro ...
[desktoppet] 发送捕获循环已启动
[desktoppet] 已安装发送层捕获 bot=CQHttp replaced=functools.partial(...)
```

## API Key

```bash
scp create_api_key.py mxjserver@10.144.144.1:/tmp/
ssh mxjserver@10.144.144.1 \
  "docker exec -i astrbot python3 - < /tmp/create_api_key.py"
```

输出一行 `abk_...`，写入桌宠 `config.json` 的 `chat.apiKey`。脚本会撤销旧的 `DesktopPET` key，再生成新的；`scopes` 为 `["plugin"]`。

验证：

```bash
curl -H "Authorization: Bearer abk_..." \
  http://10.144.144.1:6185/api/v1/plugins/extensions/astrbot_plugin_desktoppet_bridge/ping
```

## 接口

前缀：`/api/v1/plugins/extensions/astrbot_plugin_desktoppet_bridge/`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/ping` | `{platform, qqConnected, epoch, capture, capabilities}` |
| POST | `/send` | `{text, image?, commentary?, clientId?, quote?, pointerEnabled?}` → 注入同一会话，返回日志条目；支持 `/` 指令 |
| POST | `/retract` | `{clientId}` → 撤回刚发的这一轮：中止生成、删日志、裁会话历史 |
| POST | `/pointer` | `{image, screen?, hint?}` → 读屏一次，让模型决定单点 / `steps` 指针动作（不写会话历史 / 记忆 / 心情） |
| GET | `/skills` | 只读返回指针 SKILL（统计 / 五分区 / 最近改动）与 `/AstrBot/data/skills` 自定义 SKILL |
| GET | `/messages?after=&limit=` | 增量消息 + `cursor` + `hasMore` + `qqConnected` + `epoch` |
| GET | `/bootstrap?` | 首次全量回填：全部日志 + 会话历史（默认 500 条）+ `epoch` / `version` / `capabilities` |
| GET | `/status?` | 心情 / 好感面板数据（读取 `mood.json`，复刻半衰期与好感衰减） |
| GET | `/media?media=&kind=thumb\|original` | 图片缩略图 / 原图，base64 JSON |
| GET | `/commands` | 动态读取 AstrBot 指令列表（失败时用内置兜底，含 `/交互`） |
| GET | `/history?limit=` | 兼容旧版：当前会话最近 N 条，最近 8 张图带缩略图 |

`/pointer` 的请求 / 响应：

```json
// 请求
{ "image": { "mime": "image/jpeg", "data": "<base64>" }, "screen": { "width": 1707, "height": 1067 }, "hint": "把指针绕着我画个圈" }

// 单点
{ "status": "ok", "data": { "action": { "nx": 0.42, "ny": 0.66, "durationMs": 900, "holdMs": 1500, "say": "你在看这个呀，我凑近点", "reason": "……" }, "say": "你在看这个呀，我凑近点" } }

// 连续轨迹：顶层 nx / ny 取最后一步
{ "status": "ok", "data": { "action": { "nx": 0.50, "ny": 0.35, "durationMs": 450, "holdMs": 1400, "steps": [ { "nx": 0.50, "ny": 0.35, "durationMs": 450, "holdMs": 0 }, { "nx": 0.62, "ny": 0.50, "durationMs": 450, "holdMs": 0 }, { "nx": 0.50, "ny": 0.65, "durationMs": 450, "holdMs": 0 }, { "nx": 0.38, "ny": 0.50, "durationMs": 450, "holdMs": 0 }, { "nx": 0.50, "ny": 0.35, "durationMs": 450, "holdMs": 1400 } ], "say": "看好啦，绕着你转了一圈", "reason": "绕角色画圈" }, "say": "看好啦，绕着你转了一圈" } }
```

`action` 为 `null` 表示模型选择不动（或睡着 / 上一轮还没跑完）。`hint` 是用户刚在桌面聊天里说的话，会优先照做；`say` 会作为 `pointer: true` 的 assistant 消息写进桥接日志（桌面可见），但不写 AstrBot 历史。

`/skills` 是只读接口，返回：

```json
{
  "pointer": {
    "available": true,
    "name": "希罗指针操作 SKILL",
    "version": 1,
    "sections": [{ "name": "落点与避让直觉", "items": ["..."] }],
    "stats": { "bullets": 17, "episodes": 0, "sinceReflect": 0, "reflectEveryN": 15 },
    "changes": [{ "version": 1, "ts": 1795266978000, "source": "seed", "change": "初始 SKILL" }]
  },
  "custom": [
    { "id": "SKILL", "name": "二阶堂希罗 · 详细背景设定", "active": true, "markdown": "# ..." }
  ]
}
```

指针部分来自真实交互插件的 `get_pointer_skill_view()`；自定义部分扫描 `/AstrBot/data/skills/*/SKILL.md`，过滤 `documents` / `pdf` / `spreadsheets` / `skill-creator`，并去掉 `[reference:nn]` 角标。

`/send` 的 `image` 形如：

```json
{ "mime": "image/jpeg", "data": "<不带 data: 前缀的 base64>" }
```

插件会把它作为 `Image.fromBase64(...)` 附加到注入消息里；桌面截图由 Windows 端的 `desktopCapturer` 生成，最长边 1280，JPEG 85。

`commentary: true` 用于随机点评：插件给注入文本加 `〔桌面屏幕点评〕` 标记，不写桌面消息日志、不落盘截图；`/bootstrap`、`/history` 返回桌面时过滤带该标记的 user 消息。希罗的回复照常由发送层记录，所以桌面只看到点评内容，AstrBot 的上下文和记忆里保留完整回合。

点评事件同时设置 `mood_skip_appraisal`、`mood_skip_affection`、`mood_skip_all`；配套的 `astrbot_plugin_hiro_mood` **1.5.0** 在 `on_llm_request` 与 `on_llm_response` 开头检查前两个标记并整轮跳过。这样用户不回复点评也不会改变心情 / 好感、不会进入冷战或写强情绪记忆。旧版 mood 1.4.9 只认 `mood_skip_affection`，需要升级到 1.5.0 才能完全跳过。

睡着时（sleep 插件 `is_sleeping(umo)` 为真）`/send` 的 `commentary` 会直接返回 `{ "sleeping": true, "reply": "zzZ" }`，不注入回合、不保存截图、不计睡眠消息。`/status` 额外返回 `sleeping`、`sleepStatus` 和 `sleep` 对象。

`/messages` 返回结构：

```json
{
  "messages": [
    {
      "id": 12,
      "ts": 1794796822202,
      "role": "assistant",
      "origin": "qq",
      "text": "我刚刚泡了杯茶。",
      "attachments": [
        {
          "type": "image",
          "media": "1f3c...9a.png",
          "mime": "image/png",
          "width": 320,
          "height": 320,
          "animated": false,
          "bytes": 3885
        }
      ]
    }
  ],
  "cursor": 12,
  "hasMore": false,
  "qqConnected": true,
  "epoch": "6f1c..."
}
```

- `cursor` 是**最后一条实际返回的消息 id**，不是请求里的 `after`。
- `hasMore` 为 true 时桌面端会立刻再拉一次。
- `epoch` 变化表示日志已被重置（例如 `messages.jsonl` 被删），桌面端会清空 cursor 并重新 bootstrap。
- `/bootstrap` 的 `history` 不带图片，避免响应过大；图片以发送层日志里的 `attachments` 为准。

## 消息记录

```
手机 QQ / 桌面注入 → AstrBot 管线 → send_private_msg（被包装）
  → 原始发送成功
  → 解析 OneBot 消息段 → 写入 messages.jsonl
```

- 包装函数每 3 秒自检一次；AstrBot 重启、平台重连或插件重载后会自动重装。收到消息和发起 LLM 请求前也会主动检查一次。
- 自检看的是「包装函数是否仍是当前 `bot.send_private_msg`」，而不是实例上的标记位。aiocqhttp 的 `CQHttp.__getattr__` 会给任何未知属性返回一个可调用的 `functools.partial`，用 `getattr` 判断标记会被它骗过去。
- 只记录目标 `user_id` 的私聊。
- `text` 拼接；`image` 下载后落盘成 `attachments`；`face` → `[表情]`；`record` → `[语音]`；`video` → `[视频]`；`at` → `@昵称`；`file` → `[文件]`；`reply` / `forward` / `node` 忽略。
- 同一条消息链里的多段文本合并成一条；AstrBot 分段回复是多次发送，所以会保留成多条消息。
- `message` 是字符串、单个消息段或 `MessageChain` 时也能记录。

`/ping` 的 `capture` 用来确认发送层是否在工作：

```json
{
  "capture": {
    "wrapped": true,
    "task": true,
    "captured": 18,
    "lastCaptureAt": 1794801234567,
    "note": "已安装"
  }
}
```

`wrapped` 为 `false` 时说明当前 bot 上的包装失效（通常是平台刚重连），最多等 3 秒会自动补装。

## 唤醒词截断

AstrBot 的 `WakingCheckStage` 只要发现消息以 `wake_prefix` 开头，就会把它从 `message_str` 里删掉——即使私聊本来不需要唤醒词。例如 `wake_prefix` 配了「希罗」：

```text
希罗酱，你在吗   →   酱，你在吗
```

模型和会话历史都只看到后半句。桥接在收到这个会话的消息时会用原始消息组件重建一次 `message_str`，把前缀补回来；桌面注入和手机 QQ 两个方向都生效。日志里会出现：

```text
[desktoppet] 已恢复唤醒词截断：'酱，你在吗' -> '希罗酱，你在吗'
```

## 存储

```text
/AstrBot/data/plugin_data/astrbot_plugin_desktoppet_bridge/
  ├─ messages.jsonl      发送日志，最多 max_log（默认 2000）条
  ├─ messages.meta.json  epoch
  └─ media/              图片原图（按 sha1 命名）+ 按需缩略图
```

`media_max_mb`（默认 500）只做容量告警，不会自动删除仍被日志引用的图片。

## 配置

`_conf_schema.json` 里的配置一般不需要改：

| 字段 | 默认 | 说明 |
|---|---|---|
| `umo` | `Hiro:FriendMessage:1955272576` | 共享会话 |
| `platform_id` | `Hiro` | QQ 平台适配器 ID |
| `user_id` | `1955272576` | 用户 QQ 号 |
| `self_id` | `1169321938` | 机器人 QQ 号 |
| `user_nickname` | `他` | 注入消息昵称 |
| `history_limit` | `40` | 旧 `/history` 的条数 |
| `bootstrap_history_limit` | `500` | 首次回填的会话历史条数，0 关闭 |
| `max_log` | `2000` | 发送日志上限 |
| `media_max_mb` | `500` | 媒体目录告警阈值 |
| `mood_data_path` | 空 | 留空用 `plugin_data/astrbot_plugin_hiro_mood/mood.json` |
| `mood_config_path` | 空 | 留空用 `config/astrbot_plugin_hiro_mood_config.json` |
| `mood_timezone` | `Asia/Shanghai` | 「今日好感增减」的日期边界 |
| `screen_hint` | 见下 | 带截图的桌面消息临时注入的设定 |
| `pointer_hint` | 见下 | 指针开启时随桌面消息临时注入的能力提示，留空关闭 |

`pointer_hint` 默认会告诉她：桌面上那个小光标是她自己的第二指针，可以移动但不能点击；如果用户在聊天里让她指某个东西就答应，桌面端会立刻把指针移过去。提示里还会带上最近几条指针闲聊和最后落点方位。

`screen_hint` 默认内容：

> 这张截图来自他的电脑屏幕；画面里的 Live2D 桌宠人物是希罗本人（也就是你），不是其他人。聊天窗口是你们正在用的桌面聊天框。

它通过 `TextPart(...).mark_as_temp()` 注入，不写进会话历史；留空即关闭。

## 注意

- 桌面端已放开全部 `/` 指令；注入事件 `role = "admin"`。危险指令由**桌面端**发送前二次确认，插件侧不拦截。
- 指令回复如果被某个插件直接调用 QQ 发送接口，会真的发到 QQ，同时也被发送层记录。
- 注入事件依赖 `Hiro` 适配器已加载；QQ / NapCat 没连上也能聊，只是手机消息同步不过来。
- 插件改动后重启一次 AstrBot；API Key 是数据库里的，不需要跟着重启。
- `mood.json` 不存在或字段缺失时，`/status` 返回 `available: false`，桌面端会隐藏状态面板的数据而不是报错。

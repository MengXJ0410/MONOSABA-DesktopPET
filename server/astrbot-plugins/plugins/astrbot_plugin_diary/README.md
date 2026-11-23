# 希罗酱の日记（astrbot_plugin_diary）

让 AstrBot 每天定时写一篇日记，**追加进同一本「日记本」文件**，可选定时把当天日记分享到主私聊。

当前版本：`0.4.8`。

> **会话范围**：日记只读写主私聊 UMO；`/diary` 也只在主私聊可用。群聊和其他私聊发送会拒绝，不会生成或发送主私聊日记。

文件由插件自己写，不依赖 `computer_use_runtime`，也不给任何会话开放文件工具。

## 产出

```text
容器内：/AstrBot/data/workspaces/<UMO>/diary/日记本.md
宿主机：/home/<user>/astrbot/data/workspaces/<UMO>/diary/日记本.md
```

默认 UMO `Hiro:FriendMessage:195*****76`，对应目录 `Hiro_FriendMessage_195*****76`。

单篇格式，条目之间用 `---` 分隔：

```markdown
2026年11月06日

## 我的生活
傍晚自己煮了饭，艾玛又添了一道汤，两个人坐在桌边吃得挺饱。

## 和他的聊天

### 片段 1/2
他讲了昨晚的梦，梦里我被人杀了，艾玛一直守着我说我还活着。我听着有点发闷。

（他讲这些的时候语气很轻，我却不太想接话。）

### 片段 2/2
他今天把记忆持久化的东西弄完了，还考我记不记得这一周的事。我说记得。

（他记得这些，我有点意外，也有点高兴。）

（他说不管我是不是真的希罗，我是他认识的希罗酱，这话我听着心里发烫。）

---

2026年11月07日
……
```

- 「我的生活」有聊天日 20–60 字；**无聊天日 200–500 字**。超过上限只在日志里记 warning，**不改正文**。
- 「和他的聊天」一般 30–300 字/段；内容确实多时可以继续写，插件会自动拆成 `### 片段 i/N`，最多 4 段，总上限 `300 × N`。称呼用 `user_alias`（默认「他」），不出现「主人」。
- 每个聊天片段结尾可以自然写一句自己的想法，用普通括号 `（）` 包起来，**最多 200 字**，不是每段都必须写。
- **最后一段普通括号永远是整篇心里话**，20–200 字；段末想法写在对应片段内部。`thought_enabled` 关闭后整段不写。
- 当天没有聊天记录时，聊天部分**整段省略**（提示词要求 + 代码兜底删除，双保险）；`我的生活` 会写 200–500 字，并结合画像和近期高重要度记忆做自然回忆。
- 无聊天日第一次不足 200 字时，会**自动重写一次**；重写后仍不足只警告。
- 所有字数上限都**只警告不截断**，避免把模型写得好的句子硬切掉。

## 长聊天日：按时间分篇

| 当天聊天字数 | 篇数 | 时间标签 |
|---|---|---|
| ≤ 8000 | 1 | 无 |
| 8001–16000 | 2 | 上午 / 下午+晚上 |
| 16001–24000 | 3 | 上午 / 下午 / 晚上 |
| > 24000 | 3 | 最早部分用当天记忆条目摘要，最近 24000 字原文 |

- 时间边界：上午 05–12，下午 12–18，晚上 18–05；00:00–04:59 归到当天晚上。
- 每篇都是完整日记，有自己的「我的生活 / 聊天 / 心里话」。
- 多篇日的条目头是 `2026年11月06日 上午`、`2026年11月06日 下午+晚上` 等。
- 旧格式（只有 `2026年11月06日` 一个标题）视为已完成，不重写；补写只补缺失的篇。
- 超过 24000 字时，从 `plugin_data/astrbot_plugin_hiro_memory/memory/YYYY-MM-DD.jsonl`
  读当天记忆条目，补最早的部分；读不到就保持原文不压缩。
- 颜文字由 `kaomoji_enabled` 控制（默认开），提示词限定每篇 1–2 个，例如 `(≧◡≦)`、`(-_-;)`、`(*/ω＼*)`；关掉后提示词会明确禁止颜文字和 emoji。
- 段落标题可用 `chat_section_title` 改，例如「和SB的聊天」「和MXJ的聊天」。

## 日记本永不删除，超过 500MB 自动分卷

`日记本.md` → `日记本-2.md` → `日记本-3.md`……每次写入前检查当前卷大小，达到 `book_max_mb`（默认 500）就开下一卷。代码里没有任何删除逻辑。

## 新配置（2026-11-06）

| 键 | 默认 | 说明 |
|---|---|---|
| `max_context_chars` | `8000` | 单篇阈值；超过后按时间分篇 |
| `two_entry_max_chars` | `16000` | 分 2 篇的上限 |
| `max_daily_chars` | `24000` | 当天聊天总上限；超过用记忆摘要补最早部分 |
| `segment_max` | `4` | 单篇聊天正文最多拆几段 |
| `life_min_chars` / `life_max_chars` | `20` / `60` | 有聊天日「我的生活」目标范围 |
| `chat_min_chars` / `chat_max_chars` | `30` / `300` | 聊天单段目标范围 |
| `segment_thought_enabled` | `true` | 允许聊天段末想法 |
| `thought_min_chars` / `thought_max_chars` | `20` / `200` | 心里话 / 段末想法目标范围 |
| `no_chat_life_min_chars` / `no_chat_life_max_chars` | `200` / `500` | 无聊天日「我的生活」目标范围 |
| `no_chat_recall_days` | `14` | 无聊天日回忆回溯天数 |
| `no_chat_recall_limit` | `8` | 无聊天日最多注入几条近期记忆 |
| `share_retry_enabled` | `true` | 23:30 分享失败是否自动重试 |
| `share_retry_interval_minutes` | `5` | 重试间隔 |
| `share_retry_max_hours` | `24` | 最多重试多久；超过标记失败 |

## 分享失败重试（2026-11-07）

23:30 分享失败时，不再只写日志，而是写入持久化发件箱：

```text
/AstrBot/data/plugin_data/astrbot_plugin_diary/share_state.json
```

- 每 5 分钟重试一次，成功即停止。
- 多段消息只补发未成功的段落，不会重复发已发段落。
- 插件重启后从发件箱继续。
- 最多重试 24 小时；超过后标记失败，日记正文仍在日记本里。
- 00:05 补写出来的日记，如果还没分享成功，也会补发。
- 普通 `notify`、`/diary` 手动发送、即时日记**不走**这个重试队列。

## 三个定时任务

| 任务 | 默认时间 | 开关 | 作用 |
| --- | --- | --- | --- |
| `diary_daily` | 每天 23:30 | `share_enabled = false` 时 | 写当天日记，`notify` 开着就顺手发 |
| `diary_share` | 每天 23:30 | `share_enabled = true` 时 | **写好并发送**，接管写入 |
| `diary_catchup` | 每天 00:05 | `catchup_days > 0` | 补写最近 N 天缺失的日记 |

> 分享重试不是 cron，而是插件启动时创建的后台任务，每 60 秒检查一次
> `share_state.json`；到期的条目每 5 分钟重试一次。

### 写与分享的时序

- 没开分享：`cron_expression`（默认 23:30）写；`notify` 开着就写完立刻发。
- 开了分享：不再单独跑写作任务，改由 `share_cron`（默认 23:30）一次性「写 + 发」，**同一天只写一篇、只分享一次**。
- 分享时如果当天条目已存在且还没成功分享，直接把那一篇发出去；已经成功分享则跳过。
- 睡眠插件开启时：如果 `share_cron` 晚于「实际睡眠时间 - 5 分钟」，睡眠插件会在睡前 5 分钟调用 `share_for_date()` 提前写+发；实际睡眠时间包含聊天导致的延后。分享失败会在睡前重试，仍失败等起床补发。
- 分享只发**当天这一篇**，不会把整本日记本发出去。

分享消息格式：

```text
这是今天的「希罗酱の日记」，想给你看一下
2026年11月03日

## 我的生活
……
```

前缀可用 `notify_prefix` 改。

## 「现在立刻写一则日记」

配置里打开 `instant_trigger` 并保存（WebUI 保存会热重载插件），插件会立刻：

1. 只取今天 00:00 到现在的聊天素材，写一篇日记；
2. 以 `2026年11月03日 15:30` 这种**带时间**的条目头追加进同一本日记本；
3. 发到目标会话。

即时日记不影响当天 23:30 的固定日记（固定日记的条目头不带时间，两者互不覆盖）。插件把开关状态记在数据目录 `state.json`，只有「关 → 开」才触发一次，反复重载不会重复写。写完记得把开关关掉，下次才能再触发。

> AstrBot 的 `_conf_schema.json` 没有按钮类型，所以这里用「开关 + 保存即触发」实现按钮效果。

## 依赖的 AstrBot 内部 API

| 用途 | API |
| --- | --- |
| 定时任务 | `context.cron_manager.add_basic_job(..., persistent=False)` |
| 会话历史 | `context.conversation_manager.get_conversations()` / `get_curr_conversation_id()` |
| 人格 | `context.persona_manager.get_persona_v3_by_id()` |
| 模型 | `context.get_using_provider(umo=...)` → `text_chat()` |
| 主动发消息 | `context.send_message(umo, MessageChain(...))` |

`persistent=False` 是必须的：basic job 的 handler 存在内存字典里，`persistent=True` 会在重启后恢复任务但找不到 handler，触发时抛 `Basic cron job handler not found`。

## 人格与日记格式的冲突

插件会把人格提示词原样带上（保留希罗的语气和设定），再追加一段「日记模式」提示词，明确覆盖人格里的对话格式限制：

- 允许 Markdown 二级标题（人格里禁止 Markdown）；
- 不发表情包、不 @ 人、不调用工具、不用『伪证』格式；
- 只输出日记正文，不要前言和解释。

不需要你手动维护提示词，装好就按这个跑；想微调语气可以用 `extra_instruction` 追加。

## 定时任务自愈

`initialize()` 会先删除同名 basic job（`diary_daily` / `diary_share` / `diary_catchup`）再重新注册，所以 WebUI 里反复「重载插件」不会产生重复任务。

## 部署

```bash
scp -r deploy/astrbot/plugin-diary/. <server>:/home/<user>/astrbot/data/plugins/astrbot_plugin_diary/
ssh <server> 'docker restart astrbot'
ssh <server> 'docker logs --tail 50 astrbot 2>&1 | grep -i diary'
```

首次加载后 AstrBot 会按 `_conf_schema.json` 生成配置文件，可在 WebUI → 插件 → 希罗酱の日记 → 配置 里改。保存会热重载插件，定时任务自动重新注册。

## 手动测试

QQ 私聊发送（仅管理员，且只在主私聊 UMO 生效）：

```text
/diary              # 今天：没有就写，已有就重发
/diary 2026-11-02   # 指定日期
```

## 回滚

```bash
ssh <server> 'rm -rf /home/<user>/astrbot/data/plugins/astrbot_plugin_diary'
ssh <server> 'docker restart astrbot'
```

日记本文件不会被删。

## 已知限制

- 聊天素材来自 `conversations.history`，日期和时间藏在用户消息的 `<system_reminder>` 里；如果 AstrBot 改了历史格式，需要同步改 `_extract_day()`。
- 「今天是否已写」只扫日记本尾部 64KB；补写很久以前的日期时可能扫不到，理论上会重复追加。
- 超过 24000 字且当天 `memory/YYYY-MM-DD.jsonl` 还没落盘时，不压缩，保留原文；等记忆插件补上后下次才会用摘要。
- 补写默认关闭（`catchup_days=0`）；打开后每次补写都是一次真实的模型调用。
- 分卷后 `_book_path()` 只指向当前卷，跨卷去重不生效。
- 分享重试只覆盖 23:30 分享和 00:05 补写补发；普通 `notify`、`/diary`、即时日记失败不会自动重试。
- `send_message` 返回成功只代表 AstrBot/NapCat 接受，**不能保证 QQ 客户端一定收到**；静默丢失无法感知。
- 分享按“至少一次”语义：发送成功后、写 `share_state.json` 前进程崩溃，重启可能重复发一段。
- 段末想法和整篇心里话都靠“位置”区分：**最后一段普通括号是整篇心里话**。如果模型漏写整篇心里话，最后一段的段末想法会被当成心里话。
- 无聊天日的画像回忆只对“今天 / 昨天”生效；更早的手动补写只用按日期过滤的近期记忆，避免画像里混进未来事件。
- 无聊天日「我的生活」不足 200 字时，自动重写会**多一次模型调用**。

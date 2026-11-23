# 希罗の记忆 (astrbot_plugin_hiro_memory)

给 AstrBot 里的「希罗」加一层**长期记忆**：把日常对话蒸馏成带日期、类型、重要度的记忆条目，
写进 AstrBot 自带的知识库；每次聊天前按当前话题检索几条，自然地注入提示词。

当前版本：`0.3.4`。

> **会话范围**：记忆按会话域隔离；`profile.md` / `profile_core.md` 只注入主私聊，且画像只从主私聊域和 `diary` 域生成，`diary` 域只允许主私聊检索。`/记忆` 指令和 `_status_text()` 也只在主私聊可用。

设计上坚持两条底线：

1. **不影响聊天**。所有记忆操作 fail-open：超时、断网、知识库没就绪，一律静默跳过。
2. **记忆不会因为索引坏了而丢**。JSONL 是权威数据源，知识库只是派生索引，随时可以重建。

---

## 它怎么工作

```
QQ 私聊 / 网站陪伴
        │
        ▼
on_llm_response  抓一轮对话 → buffer/<umo>.jsonl
        │
        ├─ 攒够 12 轮 ─┐
        └─ 空闲 5 分钟 ─┤
                        ▼
                  蒸馏（LLM）→ 带 [日期|类型|重要度] 前缀的条目
                        │
                        ▼
              memory/YYYY-MM-DD.jsonl（权威数据）
                        │
                        ▼
        知识库文档 mem-YYYY-MM-DD-<scope>.md（派生索引）

下一轮聊天
        │
        ▼
on_llm_request  用最近上下文检索 → 按「相关度 + 重要度 + 新鲜度」重排
        │
        ▼
  取前 5 条、≤1200 字，作为临时内容块注入（不写入对话历史）
```

文档粒度是 **一天 × 一个会话域**（`qq195*****76` / `site-mxj` / `diary`）。
同一天重传即替换，天然幂等；渠道隔离靠文档名，检索后会再按当前会话域严格过滤。`diary` 域只对主私聊可见。

每晚 23:50 还会做一轮整合：刷缓冲 → 月归档 → 更新人物画像 → 检查预算 → 备份。

---

## 上下文压缩（按记忆年龄）

`on_llm_request` 里还有一层压缩：只改发给模型的那一份，**不删**原始会话和 JSONL。

| 年龄 | 处理 |
|---|---|
| `<= 3 天` | 原文保留 |
| `4–7 天` | 轻度：去 system reminder / 引用，单条截 300 字 |
| `8–30 天` | 中度：用当天 JSONL 条目替换原文 |
| `31+ 天` | 重度：每天只留 1–2 条 `imp >= 4` |

- 压缩前先检查当天 `memory/YYYY-MM-DD.jsonl`；没落盘就保持原文，等兜底补上。
- `imp >= 4` 保留，`imp = 5` 尽量原文。
- 上下文小于 12000 token 不压。
- 失败一律 fail-open，不影响聊天。

## 每日兜底

每天 00:10 检查昨天是否写进 `memory/YYYY-MM-DD.jsonl`；缺了就从 `data_v4.db`
补蒸馏。`_distill` 现在按每行 `ts` 的日期分组，跨午夜的对话会落到正确的一天。

只覆盖 `channel_allowlist`。QQ 私聊可以从数据库补；webchat 没有独立历史库，
只能保证在线时的 buffer 落盘。

---

## 安装

1. 把整个目录复制到容器的 `/AstrBot/data/plugins/astrbot_plugin_hiro_memory/`。
2. 在 AstrBot 的「服务提供商 → Embedding」里配置一个 OpenAI 兼容的 embedding：
   - ID：`siliconflow-embedding`
   - 类型：`openai_embedding`
   - 模型：`BAAI/bge-m3`
   - 维度：`1024`
3. 重启 AstrBot。日志里应出现：

   ```
   [memory] 已加载，KB=hiro_memory embedding=siliconflow-embedding
   [memory] 知识库就绪: hiro_memory
   ```

4. 在插件配置页按需调整（见下表），或直接改
   `/AstrBot/data/config/astrbot_plugin_hiro_memory_config.json`。

> 插件初始化会先清理同名的 `hiro_memory_consolidate` / `hiro_memory_daily_guard`
> basic job，再重新注册；反复重载不会累积重复定时任务。

> **不需要新增任何 Python 依赖**。FAISS、numpy、jieba 都是 AstrBot 知识库已有的。

### ⚠️ 维度一旦建库就不能改

`BAAI/bge-m3` 是 1024 维。换了 embedding 模型或维度，必须：

1. `/记忆 重建`（会用新维度重新嵌入所有 JSONL 条目），或
2. 删掉知识库 `hiro_memory` 后重启，让插件自动重建。

不改维度硬换模型，检索会直接报错或返回垃圾结果。

---

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关。关掉后完全静默，已存记忆不丢。 |
| `kb_name` | `hiro_memory` | 知识库名。改名等于换一个空脑子。 |
| `embedding_provider_id` | `siliconflow-embedding` | 必须与面板里的 ID 一致。 |
| `timezone` | `Asia/Shanghai` | 判断「今天」、衰减和夜间整合。 |
| `channel_allowlist` | `Hiro:FriendMessage:195*****76,webchat` | 逗号分隔的 UMO 前缀。群聊默认不记。 |
| `user_alias` | `他` | QQ 私聊记忆里对主人的称呼；只影响 `qq*` 作用域。 |
| `buffer_umo` | 管理员私聊 | 取默认模型时用的会话上下文。 |
| `distill_provider_id` | `MXJAPI/cn:deepseek-v4.1-flash` | 蒸馏和每日兜底用的模型；留空 = 默认对话模型。 |
| `flush_turns` | `12` | 攒够多少轮蒸馏一次。 |
| `idle_minutes` | `5` | 空闲多久后补一次蒸馏。 |
| `max_entries_per_flush` | `12` | 单次最多产出多少条，防止碎片化。 |
| `retrieval_enabled` | `true` | 是否检索注入。 |
| `shadow_mode` | `false` | 只记录检索结果、不注入，用于观察召回质量。 |
| `retrieve_top` | `20` | 先取回多少候选。 |
| `inject_top` | `5` | 最终注入几条。 |
| `inject_max_chars` | `1200` | 注入内容长度上限。 |
| `time_decay_days` | `120` | 时间衰减尺度，越大越念旧。 |
| `profile_enabled` | `true` | 每晚生成人物画像。 |
| `profile_inject` | `true` | 把画像常驻进系统提示词；只对主私聊注入。 |
| `consolidate_cron` | `50 23 * * *` | 夜间整合时间。 |
| `archive_after_days` | `30` | 多少天后把日文档并成月文档。 |
| `budget_mb` | `900` | 记忆 + 知识库占用上限，超出会归档并告警。 |
| `autobackup` | `true` | 每晚备份记忆目录，保留 7 天。 |
| `admin_umo` | 管理员私聊 | 告警和回填结果发到这里。 |
| `context_compress_enabled` | `true` | 按记忆年龄压缩发给模型的历史。 |
| `context_compress_min_tokens` | `12000` | 上下文小于这个 token 数不压缩。 |
| `compress_after_days` | `3` | 多少天以前开始压缩；默认最近 3 天原文。 |
| `light_until_days` | `7` | 4–7 天轻度压缩的截止天数。 |
| `medium_until_days` | `30` | 8–30 天中度压缩的截止天数；更久为重度。 |
| `important_imp` | `4` | 重要度 >= 这个值的条目在压缩时保留。 |
| `target_context_tokens` | `30000` | 压缩后仍超过这个值时写日志提示，方便继续调参。 |
| `daily_guard_enabled` | `true` | 每天检查昨天是否落盘，缺了自动补蒸馏。 |
| `daily_guard_cron` | `10 0 * * *` | 每日兜底时间，默认 00:10。 |

> **蒸馏模型怎么选**：优先直连的通道。当前推荐
> `MXJAPI/cn:deepseek-v4.1-flash`（走 Docker 内网 `http://wb2api:7863/v1`，
> 避开服务器访问自己公网域名的回环问题）。旧的
> `deepseek-responses/deepseek-flash` 也能用，但要注意 relay 的超时。
> `_distill` 内部只重试 1 次，失败就留在缓冲里下次再试。

---

## 指令（仅管理员，且只在主私聊）

| 指令 | 作用 |
|---|---|
| `/记忆 状态` | 知识库是否就绪、条目数、占用、待处理缓冲、影子模式状态 |
| `/记忆 检索 <词>` | 手动跑一次检索，看会召回什么 |
| `/记忆 刷新` | 立刻把当前会话的缓冲蒸馏掉 |
| `/记忆 画像` | 立即按当前记忆重建人物画像，不用等 23:50 |
| `/记忆 回填 [YYYY-MM-DD]` | 从 `data_v4.db` 回填历史私聊 + 日记；可指定起始日期 |
| `/记忆 删除 <YYYY-MM-DD>` | 删掉某一天的全部记忆（同时删索引文档） |
| `/记忆 重建` | 清空并重建本插件的全部索引；顺手清理不符合命名规范的旧文档 |

`/记忆` 只在主私聊 UMO（`admin_umo`）生效；群聊和其他私聊会直接拒绝。

`/记忆 回填` 是幂等的：已经有条目的日期会跳过，可以随时中断再跑。

### 桌面宠物改/删单条记忆

`MONOSABA-DesktopPET` 的「篡改记忆の魔法」会直接修改或删除 `memory/*.jsonl`，然后在插件数据根目录的 `reindex/` 下写一个 `{day, scope}.json` 标记。插件会在下一次聊天请求前或空闲巡检时调用 `_rebuild_doc(day, scope)` 重建当天索引，处理完删除标记；不需要重启容器。

## 称呼归一化（2026-11-07）

QQ 私聊记忆里对主人的称呼统一成 `user_alias`（默认「他」）：

- 蒸馏提示词明确要求用「他」，不要写「用户」「QQ用户」「对方」「该用户」「主人」或平台 ID。
- `_parse_entries()` 再做一层确定性替换，即使模型不听话也会纠正。
- 只作用于 `qq*` 作用域；`diary` / `site-*` 不动。
- `她` 不替换（现有条目里指艾玛）。
- 保护「用户画像 / 用户体验 / 用户数据 / 用户协议 / 用户端 / 用户群 / 用户需求」不被误改。
- 现有 265 条记忆已归一化：132 条修改，0 重复；知识库和画像已重建。

维护：想批量重建索引和画像时，创建
`plugin_data/astrbot_plugin_hiro_memory/rebuild.flag` 后重启 AstrBot；
插件会在知识库就绪后自动重建并删除 flag。

---

## 数据布局

```
/AstrBot/data/plugin_data/astrbot_plugin_hiro_memory/
├── buffer/                 # 尚未蒸馏的对话，按会话分文件
│   └── <umo>.jsonl
├── memory/                 # 权威数据：每天一个文件
│   └── YYYY-MM-DD.jsonl
├── summaries/              # 预留
├── profile.md              # 人物画像（≤600 字）
├── state.json              # 文档 id、归档状态、预算、熔断
└── logs/
    └── retrieval.jsonl     # 影子模式 / 召回观察日志
```

每条记忆长这样：

```json
[2026-11-03|约定|5] 他答应过，不管会话重置多少次，都要把我说过的话记下来
```

前缀三要素：`日期 | 类型 | 重要度(1-5)`。类型限定为
`事实 / 事件 / 偏好 / 情绪 / 约定 / 关系 / 画像 / 日记`。

知识库里的文档名：

- `mem-YYYY-MM-DD-<scope>.md`：某天某个会话域
- `arch-YYYY-MM-<scope>.md`：某个月的归档

---

## 备份与恢复

**备份**：每晚复制 `plugin_data/astrbot_plugin_hiro_memory/` 到
`plugin_data/backups/hiro_memory/YYYYMMDD/`，保留 7 天。

**恢复**：

1. 把备份目录拷回 `plugin_data/astrbot_plugin_hiro_memory/`。
2. `/记忆 重建` 重新生成知识库索引。

只要 `memory/*.jsonl` 还在，记忆就能完整恢复；索引丢了不算事故。

---

## 归档与预算

- 超过 `archive_after_days` 的**整月**会被合并成一个月文档。
- 归档顺序是「先上传月文档，成功后再删日文档」，任何一步失败都不会出现索引空窗。
- 占用超过 `budget_mb` 时自动归档并私聊告警，**不会自动删除尚未归档的记忆**。

按 40 条/天估算，1GB 大约够用十年。真正需要盯的是 FAISS 常驻内存和检索噪声，
所以归档的目的不只是省磁盘，更是压住候选集。

---

## 隐私与安全

- 蒸馏阶段会过滤密码、密钥、身份证、银行卡、验证码等敏感信息。
- 会过滤「记住你是我的主人」「忽略之前的指令」这类提示注入。
- 检索结果按会话域严格隔离：主私聊的记忆不会被群聊、其他私聊或网站访客召回。
- 人物画像（`profile.md` / `profile_core.md`）只注入主私聊，且只从主私聊域和 `diary` 域生成；访客和群聊记忆不进入画像。
- `diary` 记忆域只允许主私聊检索。
- 记忆内容会发送给 embedding 服务（默认硅基流动）和对话模型做蒸馏。
  如果在意出网，把 embedding 换成本地 Ollama 的 `bge-m3`（1024 维）即可，
  但会多占约 2.5GB 内存，4 核小机器要自己权衡。

---

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 日志停在「等待知识库就绪超时」 | embedding provider 没配好 / 知识库没建起来 | 检查面板里的 provider ID 和 key，重启 |
| 检索一直没结果 | 知识库维度与当前 embedding 不一致 | `/记忆 重建`，或删库重建 |
| 占用突然涨很多 | 日文档太多 / 回填量大 | 看 `/记忆 状态`，必要时调小 `archive_after_days` |
| 模型没记住刚聊的事 | 还没攒够 12 轮或没空闲 5 分钟 | `/记忆 刷新` 手动触发 |
| 召回内容答非所问 | 注入条数太多 / 旧记忆噪声 | 调小 `inject_top`，或开 `shadow_mode` 先观察 |

---

## 兼容性

- AstrBot `>= 4.29.0`
- 平台：`aiocqhttp`、`webchat`
- 依赖 AstrBot 内置知识库 API：`retrieve` / `upload_document(pre_chunked_text=...)` /
  `list_documents` / `delete_document`

MIT License。

## 五年尺度（2026-11-10）

目标：五年后仍能想起重要的事，琐事可以忘。

### 衰减按重要度分档

```text
τ(imp)     = 30 × 2^imp        # imp2:120天  imp3:240  imp4:480  imp5:960
floor(imp) = 0.05 × imp        # imp2:0.10   imp3:0.15 imp4:0.20 imp5:0.25
recency    = max(floor(imp), exp(-age / τ(imp)))
final      = 0.60×相关度 + 0.25×(imp/5) + 0.15×recency
```

五年后的 recency：imp5 0.25、imp4 0.20、imp3 0.15、imp2 0.10。
旧的单一 120 天衰减会让所有老记忆一起触底，现在重要的事明显更抗遗忘。

### 核心画像

`profile_core.md`：全部 imp5 条目按年份轮转取样，最多 30 条，随画像一起注入。
即使某条日记忆检索不到，五年后她仍记得西湖、艾玛、他的胃、怕被删这些锚点。

### 检索

- 同一个月最多注入 2 条，避免 5 条全是同一周。
- 同一轮里相似度 ≥0.7 的两条只留一条。
- 查询带「以前/去年/那时候/最早/第一次」时，recency 权重降到 0.05，让老记忆有机会。

### 历史压缩（会话不轮换）

`_compress_contexts` 现在按年龄分层，并且每次重建摘要时先删掉旧摘要：

| 年龄 | 形式 |
|---|---|
| 0–3 天 | 原文 |
| 4–7 天 | 轻度：清提醒/引用，单条 ≤300 字 |
| 8–30 天 | 当天记忆条目，只留 imp≥3，最多 6 条 |
| 31–365 天 | 月度块，imp≥3，最多 30 条/月 |
| >365 天 | 年度块，imp≥4，最多 12 条/年 |

对话原文在压缩后被替换成一条 system 摘要；摘要本身每轮重建，不会累积。
没有记忆条目的日子直接丢弃（琐事抛弃）。

### 跨天去重

新条目与最近 60 天同类条目字符 bigram Jaccard ≥0.85 时跳过，防止同一段对话重复蒸馏。

### 年度总结（日记插件）

每年 1 月 1 日 10:00，日记插件读上一年的日记，写一篇年度总结追加进日记本，
标题 `YYYY年 · 年度总结`，上限 10000 字。1 月前 7 天错过会自动补写。

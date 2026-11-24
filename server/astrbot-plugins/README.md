# 希罗 AstrBot 插件集

本目录是希罗「服务端大脑」的**权威源码副本**：9 个 AstrBot 插件 + 人格文本 + 相关交接文档。
从此**源码以本仓库为准**，网站仓库（JxmFUN）不再持有这些插件的源码。

> 本目录只做搬迁归档：9 个插件的**代码与配置**与网站仓库归档分支 `archive/hiro-before-split`（tag `hiro-freeze-20261123`）中的 `deploy/astrbot/` 逐字节一致。
> `deploy/astrbot/` 是**历史归档路径，非当前路径**，网站仓库不再维护这些插件；当前源码只在本仓库。

## 目录结构

```text
server/
├─ astrbot_plugin_desktoppet_bridge/   # 桌面端桥接插件（保持原位，不属本目录）
└─ astrbot-plugins/
   ├─ README.md                        # 本文件
   ├─ MANIFEST.md                      # 版本与来源清单（F-M3 生成）
   ├─ plugins/                         # 9 个核心插件
   ├─ persona/                         # 人格文本
   └─ docs/                            # 交接 / 设计文档
```

## 插件清单

| 目录 | 显示名 | 版本 | 作用 |
| --- | --- | --- | --- |
| `astrbot_plugin_hiro_memory` | 希罗の记忆 | 0.3.4 | 把对话蒸馏成带日期/类型/重要度的记忆条目写入知识库，每轮按上下文检索并自然注入；支持历史回填、夜间整合与画像生成 |
| `astrbot_plugin_hiro_mood` | 希罗酱の内心想法 | 1.5.0 | 给希罗一份会残留、会消退的心情：每轮自评本轮对话，心情跨轮影响回复，强情绪写入长期记忆 |
| `astrbot_plugin_hiro_sleep` | 希罗酱的睡眠 | 0.1.4 | 会困、会睡、会被吵醒的作息：随机入睡/起床、拖睡、zzZ、起床补回 |
| `astrbot_plugin_life` | 希罗酱的生活 | 0.1.9 | 让角色有自己的生活：每天生成生活事件，注入聊天，偶尔主动私聊分享 |
| `astrbot_plugin_diary` | 希罗酱の日记 | 0.4.8 | 定时让希罗写日记，追加进同一本日记本文件，可定时分享当天的日记 |
| `astrbot_plugin_hiro_interaction` | 希罗酱の真实交互 | 0.1.1 | 让希罗自己维护一份指针操作 SKILL：每次移动带上它，按夸奖/纠正与周期复盘持续改写 |
| `astrbot_plugin_hiro_mind` | 希罗酱の读心 | 0.2.0 | 记录模型回复前的真实思考，用 `/读心` 查看最近几轮 |
| `astrbot_plugin_immersion` | 人格沉浸 | 1.2.0 | 清掉 AstrBot 每轮塞进系统提示词的系统腔包装，并断开历史思考回传 |
| `astrbot_plugin_empty_guard` | 空输出兜底 | 1.0.0 | 把「只有思考、没有正文」判定为空输出，触发自动重试与 fallback |

版本号以各插件 `metadata.yaml` 的 `version` 字段为准；`MANIFEST.md` 列出完整来源对应关系。

## 部署

> 以下只是文档说明，**不自动执行**。

1. 把需要的插件目录整体复制到 AstrBot 的插件目录：

   ```text
   <AstrBot>/data/plugins/
   ```

   AstrBot 按**目录名**加载插件，目录名与 `metadata.yaml` 的 `name` 字段必须一致（本目录 9 个均已对齐）。

2. 重启 AstrBot 使其重新扫描插件：

   ```bash
   docker restart astrbot
   ```

3. 首次加载后，在 AstrBot WebUI 的「插件」页确认 9 个插件均为启用状态，并按需在配置页填写各插件参数。

依赖顺序提示：`astrbot_plugin_hiro_interaction` 为指针 SKILL 的来源，桥接插件缺失时 fail-open；`astrbot_plugin_hiro_mood` 需 ≥ 1.5.0 才支持桥接点评的跳过标记。

## 人格

`persona/hiro.md` 是希罗的人格设定正文，`persona/README.md` 说明其来源与使用方式。

导入方式：在 AstrBot WebUI 的**人格 / Persona** 设置里新建人格，把 `persona/hiro.md` 的内容粘贴进去并设为默认；人格文本本身不随插件加载，需要单独配置一次。

## 文档

`docs/` 存放希罗服务端的交接与设计文档，仅作参考阅读，不参与运行：

- `docs/希罗长期记忆RAG方案.md`

## 源码归属

- 本目录的插件源码以**本仓库**为唯一真源；网站仓库（JxmFUN）的 `deploy/astrbot/` 是**历史归档路径，非当前路径**，已在 `archive/hiro-before-split`（tag `hiro-freeze-20261123`）冻结，不再修改。
- 桌面端桥接插件 `server/astrbot_plugin_desktoppet_bridge/` 仍在原位，负责桌面聊天窗口与 QQ 私聊共用同一 AstrBot 会话，与本目录的核心插件互补。
- 迁移只做位置与目录名的调整，**未改动任何插件逻辑**。

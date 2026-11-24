# MANIFEST · 希罗 AstrBot 插件来源清单

> 本清单记录 `server/astrbot-plugins/plugins/` 下 9 个插件的版本与来源，供 F 轨验收与后续升级核对。

## 插件清单

| 插件目录 | 版本（`metadata.yaml`） | 来源路径（归档分支内） |
| --- | --- | --- |
| `astrbot_plugin_hiro_memory` | 0.3.4 | `deploy/astrbot/plugin-memory` |
| `astrbot_plugin_hiro_mood` | 1.5.0 | `deploy/astrbot/plugin-mood` |
| `astrbot_plugin_hiro_sleep` | 0.1.4 | `deploy/astrbot/plugin-sleep` |
| `astrbot_plugin_life` | 0.1.9 | `deploy/astrbot/plugin-life` |
| `astrbot_plugin_diary` | 0.4.8 | `deploy/astrbot/plugin-diary` |
| `astrbot_plugin_hiro_interaction` | 0.1.1 | `deploy/astrbot/plugin-interaction` |
| `astrbot_plugin_hiro_mind` | 0.2.0 | `deploy/astrbot/plugin-mind` |
| `astrbot_plugin_immersion` | 1.2.0 | `deploy/astrbot/plugin-immersion` |
| `astrbot_plugin_empty_guard` | 1.0.0 | `deploy/astrbot/plugin-empty-guard` |

## 其他迁移件

| 目录 | 内容 | 来源路径（归档分支内） |
| --- | --- | --- |
| `persona/` | `hiro.md`、`README.md` | `deploy/astrbot/persona/` |
| `docs/` | `希罗长期记忆RAG方案.md` | `docs/希罗长期记忆RAG方案.md` |

> 另有 3 份含敏感信息的交接文档（`Astrbot希罗AI机器人交接.md`、`HANDOFF-astrbot-diary.希罗日记与AstrBot运维交接.md`、`希罗的记忆接口.md`）经站长裁定**不迁入 Git 仓库**，继续留在 JxmFUN 工作区；详见 `docs/07-miku/HANDOFF-miku-F-M2.md`。

## 来源信息

| 项 | 值 |
| --- | --- |
| 来源分支 | `archive/hiro-before-split`（JxmFUN 仓库） |
| 来源 tag | `hiro-freeze-20261123` |
| 来源提交 | `ab0517133cbfea3c21aab72ce604255e004062b1`（短哈希 `ab05171`） |
| 迁移节点 | F-M1（`25949f9`） |
| 迁移日期 | 2026-11-23 |

## 说明

- 迁移只做位置与目录名的调整，插件**代码与配置**与来源 tag 逐字节一致（36 个迁移件已用 blob 哈希逐一比对）。
- `metadata.yaml` 的 `name` 字段与目录名 9/9 一致，AstrBot 可按目录名正常加载。
- 打包验证：`electron-builder.yml` 的 `files` 仅含 `out/**` 与 `package.json`，`server/**` 不会进入安装包（见 `docs/07-miku/HANDOFF-miku-F-M3.md`）。

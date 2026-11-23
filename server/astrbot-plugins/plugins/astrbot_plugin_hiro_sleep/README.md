# 希罗酱的睡眠

给希罗一个会困、会睡、会被吵醒的作息。只作用于主人私聊，群聊不受影响。

当前版本：`0.1.4`。

> **点评隔离**：事件带 `mood_skip_appraisal`（屏幕点评）时，`on_llm_request` 直接返回，不更新 `last_user_at`、不计睡眠消息、不触发拖睡 / 吵醒。

> **会话范围**：睡眠状态和 `/睡眠` 指令都只对 `umo`（默认主私聊）生效。群聊和其他私聊没有睡眠状态，发 `/睡眠` 会直接拒绝，不会读取或修改主私聊的作息。`_status_text()`、`get_status()`、`_affection_state()`、`_is_cold_war()` 也会二次校验 UMO，非主私聊一律返回拒绝/空值。

## 工作方式

1. 每晚在 `sleep_window_start`–`sleep_window_end`（默认 22:30–00:30）之间随机一个入睡点。
2. 次日早晨在 `wake_window_start`–`wake_window_end`（默认 06:30–08:30）之间随机一个起床点。
3. 到入睡点前 `quiet_minutes`（默认 15 分钟）没有对话就睡；有对话则按「最后一条对话 +15 分钟」顺延。
4. 顺延最多到原入睡点 +`max_delay_minutes`（默认 60 分钟）；到上限严重困倦，说晚安并强制睡。
5. 睡眠中普通消息固定回 `zzZ`，不调用 LLM；第 `wake_after_messages + 1` 条（默认第 6 条）把她吵醒，从这一条开始正常回复。
6. 被吵醒后 `return_sleep_minutes`（默认 5 分钟）无对话回睡；离起床点不足 `wake_guard_minutes`（默认 30 分钟）则不再回睡。
7. 起床后逐条回复睡眠期间没被正常回复的消息；每条只发一段，不再分段。

## 问候与好感

- 好感 >`greeting_affection_threshold`（默认 70）才主动发晚安/早安。
- 好感 ≤70 只睡、只醒，不主动发。
- 被强制睡（拖到上限）时，无论好感都发一句晚安。
- 冷战期间不主动晚安/早安，也不回 `zzZ`；分手挽回期不主动问候。
- 被吵醒时「累」设为 `tired_on_wake`（默认 0.8），起床后降到 `tired_on_morning`（默认 0.2）。

## 噩梦联动

生活插件在发噩梦前调用 `begin_nightmare(umo)`，发完后调用 `end_nightmare(umo)`：

- 惊醒后按生活插件的 3–6 段发完，不拦截；
- 这 5 分钟内用户回她，她正常回；
- 5 分钟后无对话回睡；
- 噩梦不占日常分享额度。

## 和别的插件的约定

```python
is_sleeping(umo)      # 只有 status == sleeping
is_night_rest(umo)    # delaying / sleeping / woken / nightmare
begin_nightmare(umo)  # 生活插件发噩梦前
end_nightmare(umo)    # 噩梦消息发完后
```

- `mood`：夜间休息时跳过分手提议。
- `life`：夜间休息时暂停分享、未回复升级；噩梦最低好感 `nightmare_min_affection`。
- `diary`：夜间只写不发，起床后 `share_pending()` 补发昨天日记；如果日记配置的分享时间晚于「睡前 N 分钟」，会在睡前 N 分钟主动分享当天日记（N 默认 5，按包含聊天延后的实际睡眠时间计算）。

## 指令

仅管理员，且只在主私聊（`umo`）生效；群聊和其他私聊会提示没有睡眠状态。`/` 开头会穿透睡眠：

```text
/睡眠                 查看状态
/睡眠 状态            同上
/睡眠 强制睡          立刻进入睡眠（测试用）
/睡眠 强制醒 [正常]   立刻醒来；加「正常」会补回睡眠消息
/睡眠 重置            重新随机今晚作息
/睡眠 晚安            手动发晚安
/睡眠 早安            手动发早安
```

## 数据

```text
data/plugin_data/astrbot_plugin_hiro_sleep/sleep.json
```

关键字段：`cycle_date`、`sleep_at`、`wake_at`、`status`、`last_activity_at`、`sleep_msgs`、`return_sleep_at`、`goodnight_sent`、`goodmorning_sent`。

重启后读取状态文件恢复；如果已过入睡点且没有近期对话，直接进入睡眠；超过 1 小时上限则不补晚安直接睡。

## 配置要点

- `umo`：生效的私聊 UMO，默认 `Hiro:FriendMessage:1955272576`。
- `sleep_window_*` / `wake_window_*`：随机作息窗口。
- `quiet_minutes` / `max_delay_minutes`：拖睡规则。
- `wake_after_messages`：睡眠中第几条消息吵醒（默认 5，即第 6 条）。
- `return_sleep_minutes` / `wake_guard_minutes`：回睡与起床保护。
- `greeting_affection_threshold`：主动晚安/早安的好感门槛。
- `allow_commands`：`/` 命令是否穿透睡眠。
- `generate_greetings`：晚安/早安是否用 LLM 生成；失败时用固定短句。
- `provider_id` / `persona_id` / `persona_name` / `user_alias`：问候文案使用的模型和人设。
- `diary_share_delay_seconds`：起床后延迟多久补发日记，避免和补回消息撞在一起。
- `diary_pre_sleep_minutes`：睡前提前分享日记的分钟数（默认 5；0 表示关闭）。
- `debug`：打印状态切换日志。

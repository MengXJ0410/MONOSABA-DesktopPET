# AstrBot 桥接插件

`astrbot_plugin_desktoppet_bridge` 让 MONOSABA DesktopPET 的聊天窗口和手机 QQ 私聊共用同一个 AstrBot 会话。

- 桌面消息注入 `Hiro:FriendMessage:1955272576`，走完整管线（人格 / 记忆 / 会话）。
- 注入事件使用假 bot，希罗对桌面消息的回复不会发到 QQ。
- 记录手机 QQ 的完整收发消息（`on_llm_request` / `on_decorating_result`），桌面增量拉取。
- 回复从装饰后的 MessageChain 取文本，不受 NapCat 控制台日志「多行截断」影响。

## 部署

```bash
scp -r astrbot_plugin_desktoppet_bridge \
  mxjserver@10.144.144.1:/home/mxjserver/astrbot/data/plugins/
ssh mxjserver@10.144.144.1 "docker restart astrbot"
```

启动日志里应出现：

```text
[desktoppet] 桥接已加载 umo=Hiro:FriendMessage:1955272576 platform=Hiro ...
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
| GET | `/ping` | `{platform, qqConnected}` |
| POST | `/send` | `{text, image?}` → 注入同一会话，返回日志条目 |
| GET | `/messages?after=&limit=` | 增量消息 + `cursor` + `qqConnected` |
| GET | `/history?limit=` | 当前会话最近 N 条 + `cursor` + `qqConnected`；最近 8 张图片带 data URL |

`/send` 的 `image` 形如：

```json
{ "mime": "image/jpeg", "data": "<不带 data: 前缀的 base64>" }
```

插件会把它作为 `Image.fromBase64(...)` 附加到注入消息里；桌面截图由 Windows 端的 `desktopCapturer` 生成，最长边 1280，JPEG 85。

`/history` 里的图片是插件用 Pillow 生成的 480px JPEG 缩略图，不是原图；原图仍保存在 AstrBot 会话里供模型使用。这样避免历史响应几 MB、EasyTier 较慢时被截断。

消息日志存放在：

```text
/AstrBot/data/plugin_data/astrbot_plugin_desktoppet_bridge/messages.jsonl
```

最多 500 条，重启后继续。`/history` 从 AstrBot 当前会话读取，因此回填内容包含桥接插件安装之前的对话。

## 配置

`_conf_schema.json` 里的 `umo` / `platform_id` / `user_id` / `self_id` / `user_nickname` / `history_limit` / `max_log` 都有默认值，通常不需要改。

`screen_hint` 是带截图的桌面消息临时注入给模型的设定，默认：

> 这张截图来自他的电脑屏幕；画面里的 Live2D 桌宠人物是希罗本人（也就是你），不是其他人。聊天窗口是你们正在用的桌面聊天框。

它通过 `TextPart(...).mark_as_temp()` 注入，不写进会话历史；留空即关闭。

## 注意

- 桌面 `/send` 会拒绝 `/` 开头的指令，避免个别插件绕过假 bot 把消息发到 QQ。
- 注入事件依赖 `Hiro` 适配器已加载；QQ / NapCat 没连上也能聊，只是手机消息同步不过来。
- 插件改动后重启一次 AstrBot；API Key 是数据库里的，不需要跟着重启。

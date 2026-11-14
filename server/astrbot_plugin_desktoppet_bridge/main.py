"""MONOSABA DesktopPET ↔ AstrBot 桥接插件。

目标：
- 让桌面聊天框与 QQ 私聊共用同一个 AstrBot 会话（人格 / 记忆 / 上下文）。
- 桌面发来的消息注入指定 UMO，走完整管线。
- 注入事件使用假 bot，希罗的回复不会发到 QQ。
- 记录手机 QQ 和桌面的完整收发消息，供桌面增量拉取。

设计边界：
- 只处理一个固定 UMO（默认 Hiro:FriendMessage:1955272576）。
- 桌面消息可以附带一张屏幕截图；图片 / 语音 / 表情在日志里转成占位文字。
- Windows 端通过 /api/v1/plugins/extensions/... 访问，需要 plugin scope 的 API Key。
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import re
import time
import uuid
from pathlib import Path

from PIL import Image as PILImage

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register
from astrbot.api.web import request as web_request
from astrbot.core.agent.message import TextPart
from astrbot.core.message.components import Image, Plain
from astrbot.core.platform.astrbot_message import AstrBotMessage, MessageMember
from astrbot.core.platform.message_type import MessageType
from astrbot.core.platform.sources.aiocqhttp.aiocqhttp_message_event import (
    AiocqhttpMessageEvent,
)
from astrbot.core.utils.astrbot_path import get_astrbot_plugin_data_path

PLUGIN_NAME = "astrbot_plugin_desktoppet_bridge"

DEFAULT_UMO = "Hiro:FriendMessage:1955272576"
DEFAULT_PLATFORM_ID = "Hiro"
DEFAULT_USER_ID = "1955272576"
DEFAULT_SELF_ID = "1169321938"
DEFAULT_NICKNAME = "他"

MAX_MESSAGE_CHARS = 2000
MAX_LOG_TEXT = 4000
MAX_IMAGE_BASE64 = 8_000_000
MAX_HISTORY_IMAGES = 8

_EMOTION_RE = re.compile(r"&&[^&\n]{1,12}&&")
_SYSTEM_RE = re.compile(r"<system_reminder>.*?</system_reminder>", re.S)
_QUOTE_RE = re.compile(r"<Quoted Message>.*?</Quoted Message>", re.S)
_IMAGE_PLACEHOLDER_RE = re.compile(r"\[Image \d+:[^\]]*\]", re.I)
_MULTI_IMAGE_RE = re.compile(r"(?:\[图片\]){2,}")


def _clean(text: str, limit: int = MAX_LOG_TEXT) -> str:
    """把 AstrBot / 模型输出清洗成适合聊天框展示的纯文本。"""
    if not isinstance(text, str):
        text = str(text or "")
    text = _SYSTEM_RE.sub("", text)
    text = _QUOTE_RE.sub("", text)
    text = text.replace("<attachment>", "[附件]")
    text = _IMAGE_PLACEHOLDER_RE.sub("", text)
    text = _MULTI_IMAGE_RE.sub("[图片]", text)
    text = _EMOTION_RE.sub("", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if limit and len(text) > limit:
        text = text[:limit] + "…"
    return text


def _component_text(comp: object) -> str:
    """把消息组件转成日志里的文本占位。"""
    name = type(comp).__name__
    if name == "Plain":
        return getattr(comp, "text", "") or ""
    if name == "Image":
        return "[图片]"
    if name == "Record":
        return "[语音]"
    if name == "Video":
        return "[视频]"
    if name == "Face":
        return "[表情]"
    if name == "At":
        at_name = getattr(comp, "name", None)
        at_qq = getattr(comp, "qq", None)
        return f"@{at_name or at_qq or ''}"
    if name in ("Node", "Nodes", "Forward"):
        return "[合并转发]"
    if name == "File":
        return "[文件]"
    text = getattr(comp, "text", None)
    return str(text) if text else ""


def _chain_text(chain: object) -> str:
    """把回复的 MessageChain 转成文本。"""
    if not chain:
        return ""
    try:
        components = list(chain)  # type: ignore[arg-type]
    except TypeError:
        return ""
    return "".join(_component_text(comp) for comp in components).strip()


def _event_text(event: AstrMessageEvent) -> str:
    """取用户消息文本；纯图片消息回退成 [图片]。"""
    text = (event.message_str or "").strip()
    if text:
        return text
    try:
        messages = event.get_messages()
    except Exception:
        messages = getattr(event.message_obj, "message", []) or []
    joined = "".join(_component_text(comp) for comp in messages).strip()
    return joined or "[消息]"


def _content_text(content: object) -> str:
    """解析 conversations 表里的 OpenAI 格式 content。"""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        kind = part.get("type")
        if kind == "text":
            parts.append(str(part.get("text") or ""))
        elif kind in ("image_url", "input_image", "image"):
            parts.append("[图片]")
        elif kind in ("audio", "input_audio"):
            parts.append("[语音]")
        elif kind == "file":
            parts.append("[文件]")
    return "".join(parts)


def _content_image(content: object) -> str | None:
    """取 conversations 里第一张 data URL 图片，给桌面缩略图用。"""
    if not isinstance(content, list):
        return None
    for part in content:
        if not isinstance(part, dict):
            continue
        if part.get("type") != "image_url":
            continue
        payload = part.get("image_url")
        url = payload.get("url") if isinstance(payload, dict) else payload
        if isinstance(url, str) and url.startswith("data:image/"):
            return url
    return None


def _thumbnail_image(url: str | None, max_size: int = 480) -> str | None:
    """把会话里的图片压成小缩略图，避免 /history 返回几 MB 的 base64。"""
    if not isinstance(url, str) or not url.startswith("data:image/"):
        return None
    try:
        _, _, body = url.partition(",")
        raw = base64.b64decode(body)
        with PILImage.open(io.BytesIO(raw)) as image:
            image.thumbnail((max_size, max_size))
            if image.mode not in ("RGB", "L"):
                image = image.convert("RGB")
            out = io.BytesIO()
            image.save(out, format="JPEG", quality=75)
        return "data:image/jpeg;base64," + base64.b64encode(out.getvalue()).decode()
    except Exception:
        return None


class _DesktopBot:
    """假 bot：吞掉所有发送，保证桌面消息的回复不会漏到 QQ。"""

    def __init__(self, self_id: str) -> None:
        self.self_id = self_id

    async def send_private_msg(self, **_kwargs: object) -> dict:
        return {"message_id": 0}

    async def send_group_msg(self, **_kwargs: object) -> dict:
        return {"message_id": 0}

    async def send(self, **_kwargs: object) -> dict:
        return {"message_id": 0}

    async def call_action(self, *_args: object, **_kwargs: object) -> dict:
        return {"message_id": 0}

    def __getattr__(self, _name: str):
        async def _noop(*_args: object, **_kwargs: object) -> dict:
            return {"message_id": 0}

        return _noop


@register(
    PLUGIN_NAME,
    "MXJ",
    "MONOSABA DesktopPET 与 QQ 私聊共享同一个 AstrBot 会话；桌面消息只回桌面，不投递到 QQ。",
    "0.2.0",
)
class DesktopPetBridge(Star):
    def __init__(self, context: Context, config: dict | None = None) -> None:
        super().__init__(context)
        self.config = config or {}

        self.umo = str(self.config.get("umo") or DEFAULT_UMO).strip() or DEFAULT_UMO
        self.platform_id = (
            str(self.config.get("platform_id") or DEFAULT_PLATFORM_ID).strip()
            or DEFAULT_PLATFORM_ID
        )
        self.user_id = (
            str(self.config.get("user_id") or DEFAULT_USER_ID).strip()
            or DEFAULT_USER_ID
        )
        self.self_id = (
            str(self.config.get("self_id") or DEFAULT_SELF_ID).strip()
            or DEFAULT_SELF_ID
        )
        self.nickname = (
            str(self.config.get("user_nickname") or DEFAULT_NICKNAME).strip()
            or DEFAULT_NICKNAME
        )
        self.history_limit = max(1, int(self.config.get("history_limit") or 40))
        self.max_log = max(50, int(self.config.get("max_log") or 500))
        self.screen_hint = str(
            self.config.get("screen_hint")
            or "这张截图来自他的电脑屏幕；画面里的 Live2D 桌宠人物是希罗本人（也就是你），不是其他人。聊天窗口是你们正在用的桌面聊天框。",
        ).strip()

        self._entries: list[dict] = []
        self._next_id = 1
        self._lock = asyncio.Lock()
        self._log_path = (
            Path(get_astrbot_plugin_data_path()) / PLUGIN_NAME / "messages.jsonl"
        )

    # ------------------------------------------------------------------ 生命周期
    async def initialize(self) -> None:
        await asyncio.to_thread(self._load_log)

        self.context.register_web_api(
            f"/{PLUGIN_NAME}/ping",
            self._api_ping,
            ["GET"],
            "桌面聊天桥接：平台与 QQ 连接状态",
        )
        self.context.register_web_api(
            f"/{PLUGIN_NAME}/send",
            self._api_send,
            ["POST"],
            "桌面聊天桥接：把桌面消息注入同一 AstrBot 会话",
        )
        self.context.register_web_api(
            f"/{PLUGIN_NAME}/messages",
            self._api_messages,
            ["GET"],
            "桌面聊天桥接：增量拉取消息",
        )
        self.context.register_web_api(
            f"/{PLUGIN_NAME}/history",
            self._api_history,
            ["GET"],
            "桌面聊天桥接：从当前会话回填历史",
        )
        logger.info(
            "[desktoppet] 桥接已加载 umo=%s platform=%s log=%s",
            self.umo,
            self.platform_id,
            self._log_path,
        )

    # ------------------------------------------------------------------ 日志
    def _load_log(self) -> None:
        path = self._log_path
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.exists():
                self._entries = []
                self._next_id = 1
                return

            entries: list[dict] = []
            with path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        item = json.loads(line)
                    except Exception:
                        continue
                    if not isinstance(item, dict):
                        continue
                    try:
                        item["id"] = int(item["id"])
                    except Exception:
                        continue
                    text = item.get("text")
                    if not isinstance(text, str) or not text:
                        continue
                    entries.append(item)

            entries.sort(key=lambda item: item["id"])
            trimmed = len(entries) > self.max_log
            if trimmed:
                entries = entries[-self.max_log :]
            self._entries = entries
            self._next_id = (entries[-1]["id"] + 1) if entries else 1
            if trimmed:
                self._rewrite_log()
        except Exception:
            logger.exception("[desktoppet] 读取消息日志失败，使用空日志")
            self._entries = []
            self._next_id = 1

    def _rewrite_log(self) -> None:
        path = self._log_path
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        with tmp.open("w", encoding="utf-8", newline="\n") as handle:
            for item in self._entries:
                handle.write(json.dumps(item, ensure_ascii=False) + "\n")
        os.replace(tmp, path)

    def _append_log(self, entry: dict) -> None:
        path = self._log_path
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")

    async def _append(
        self,
        role: str,
        text: str,
        origin: str | None,
    ) -> dict | None:
        cleaned = _clean(text)
        if not cleaned:
            return None
        async with self._lock:
            entry = {
                "id": self._next_id,
                "ts": int(time.time() * 1000),
                "role": role,
                "origin": origin,
                "text": cleaned,
            }
            self._next_id += 1
            self._entries.append(entry)
            try:
                if len(self._entries) > self.max_log:
                    self._entries = self._entries[-self.max_log :]
                    await asyncio.to_thread(self._rewrite_log)
                else:
                    await asyncio.to_thread(self._append_log, entry)
            except Exception:
                logger.exception("[desktoppet] 写入消息日志失败")
            return entry

    def _last_id(self) -> int:
        return self._entries[-1]["id"] if self._entries else 0

    # ------------------------------------------------------------------ 平台与 QQ 状态
    def _adapter(self):
        try:
            return self.context.get_platform_inst(self.platform_id)
        except Exception:
            logger.exception("[desktoppet] 获取平台实例失败")
            return None

    def _qq_connected(self) -> bool:
        adapter = self._adapter()
        bot = getattr(adapter, "bot", None) if adapter is not None else None
        if bot is None:
            return False
        for attr in ("_wsr_api_clients", "_wsr_event_clients"):
            try:
                if getattr(bot, attr, None):
                    return True
            except Exception:
                continue
        return False

    # ------------------------------------------------------------------ 历史
    async def _history(self, limit: int) -> list[dict]:
        try:
            manager = self.context.conversation_manager
            conversation_id = await manager.get_curr_conversation_id(self.umo)
            if not conversation_id:
                return []
            conversation = await manager.get_conversation(
                self.umo,
                conversation_id,
            )
            if conversation is None or not conversation.history:
                return []
            rows = json.loads(conversation.history)
        except Exception:
            logger.exception("[desktoppet] 读取会话历史失败")
            return []

        if not isinstance(rows, list):
            return []

        messages: list[dict] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            role = row.get("role")
            if role not in ("user", "assistant"):
                continue
            text = _clean(_content_text(row.get("content")))
            if not text:
                continue
            messages.append(
                {
                    "id": 0,
                    "ts": 0,
                    "role": role,
                    "origin": None,
                    "text": text,
                    "image": _content_image(row.get("content")),
                },
            )

        result = messages[-limit:]
        image_positions = [
            index for index, message in enumerate(result) if message.get("image")
        ]
        keep = set(image_positions[-MAX_HISTORY_IMAGES:])
        for index, message in enumerate(result):
            if index in keep:
                # 只把最近 8 张压成缩略图，避免历史响应过大、传输超时。
                message["image"] = _thumbnail_image(message.get("image"))
            else:
                message["image"] = None
        return result

    # ------------------------------------------------------------------ 发送
    async def _inject(self, text: str, image_data: str | None = None) -> dict | None:
        adapter = self._adapter()
        if adapter is None:
            return None

        components = [Plain(text=text)]
        if image_data:
            components.append(Image.fromBase64(image_data))

        abm = AstrBotMessage()
        abm.type = MessageType.FRIEND_MESSAGE
        abm.self_id = self.self_id
        abm.session_id = self.user_id
        abm.message_id = f"desktoppet-{uuid.uuid4().hex}"
        abm.group = None
        abm.sender = MessageMember(user_id=self.user_id, nickname=self.nickname)
        abm.message = components
        abm.message_str = text
        abm.raw_message = None
        abm.timestamp = int(time.time())

        event = AiocqhttpMessageEvent(
            message_str=text,
            message_obj=abm,
            platform_meta=adapter.meta(),
            session_id=self.user_id,
            bot=_DesktopBot(self.self_id),
        )
        event.set_extra("_desktoppet_origin", "desktop")
        event.set_extra("_desktoppet_logged", True)
        if image_data:
            event.set_extra("_desktoppet_has_screen", True)
        adapter.commit_event(event)
        return {"queued": True}

    # ------------------------------------------------------------------ Web API
    async def _api_ping(self):
        return {
            "status": "ok",
            "data": {
                "platform": self._adapter() is not None,
                "qqConnected": self._qq_connected(),
            },
        }

    async def _api_send(self):
        try:
            payload = await web_request.json(default={})
        except Exception:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}

        text = str(payload.get("text") or "").strip()
        if not text:
            return {"status": "error", "message": "消息不能为空。"}
        if len(text) > MAX_MESSAGE_CHARS:
            return {"status": "error", "message": "消息太长了。"}
        if text.startswith("/"):
            return {"status": "error", "message": "桌面聊天暂不支持指令。"}

        image_data = None
        image = payload.get("image")
        if isinstance(image, dict):
            data = image.get("data")
            if isinstance(data, str):
                data = data.strip()
                if len(data) > MAX_IMAGE_BASE64:
                    return {"status": "error", "message": "截图太大了。"}
                try:
                    base64.b64decode(data, validate=True)
                except Exception:
                    return {"status": "error", "message": "截图格式不正确。"}
                image_data = data

        adapter = self._adapter()
        if adapter is None:
            return {"status": "error", "message": "平台 Hiro 未加载。"}

        entry = await self._append(
            "user",
            text + ("\n[图片]" if image_data else ""),
            "desktop",
        )
        try:
            await self._inject(text, image_data)
        except Exception:
            logger.exception("[desktoppet] 注入消息失败")
            return {"status": "error", "message": "注入消息失败。"}
        return {"status": "ok", "data": {"message": entry}}

    async def _api_messages(self):
        try:
            after = int(web_request.query.get("after", 0) or 0)
        except (TypeError, ValueError):
            after = 0
        try:
            limit = int(web_request.query.get("limit", 100) or 100)
        except (TypeError, ValueError):
            limit = 100
        limit = max(1, min(200, limit))

        messages = [item for item in self._entries if item["id"] > after][:limit]
        return {
            "status": "ok",
            "data": {
                "messages": messages,
                "cursor": self._last_id(),
                "qqConnected": self._qq_connected(),
            },
        }

    async def _api_history(self):
        try:
            limit = int(
                web_request.query.get("limit", self.history_limit) or self.history_limit,
            )
        except (TypeError, ValueError):
            limit = self.history_limit
        limit = max(1, min(100, limit))

        # 先取 cursor 再读会话：读取期间新到的消息 id 一定大于 cursor，会被增量拉取补上。
        cursor = self._last_id()
        return {
            "status": "ok",
            "data": {
                "messages": await self._history(limit),
                "cursor": cursor,
                "qqConnected": self._qq_connected(),
            },
        }

    # ------------------------------------------------------------------ 钩子：记录手机消息与回复
    @filter.on_llm_request(priority=999999)
    async def _on_llm_request(self, event: AstrMessageEvent, req: object) -> None:
        try:
            if event.unified_msg_origin != self.umo:
                return

            # 带截图的桌面消息：临时告诉模型画面里的 Live2D 是她自己。
            if (
                event.get_extra("_desktoppet_has_screen")
                and not event.get_extra("_desktoppet_hint_added")
                and self.screen_hint
            ):
                event.set_extra("_desktoppet_hint_added", True)
                parts = getattr(req, "extra_user_content_parts", None)
                if isinstance(parts, list):
                    parts.append(TextPart(text=self.screen_hint).mark_as_temp())

            if event.get_extra("_desktoppet_logged"):
                return
            event.set_extra("_desktoppet_logged", True)
            await self._append("user", _event_text(event), "qq")
        except Exception:
            logger.exception("[desktoppet] 记录用户消息失败")

    @filter.on_decorating_result(priority=-1000)
    async def _on_decorating_result(self, event: AstrMessageEvent) -> None:
        try:
            if event.unified_msg_origin != self.umo:
                return
            if event.get_extra("_desktoppet_reply_logged"):
                return
            result = event.get_result()
            if result is None:
                return
            text = _chain_text(getattr(result, "chain", None))
            if not text:
                return
            event.set_extra("_desktoppet_reply_logged", True)
            origin = (
                "desktop"
                if event.get_extra("_desktoppet_origin") == "desktop"
                else "qq"
            )
            await self._append("assistant", text, origin)
        except Exception:
            logger.exception("[desktoppet] 记录回复失败")

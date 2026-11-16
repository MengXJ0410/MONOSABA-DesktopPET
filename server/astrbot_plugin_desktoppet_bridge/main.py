"""MONOSABA DesktopPET ↔ AstrBot 桥接插件。

目标：
- 让桌面聊天框与 QQ 私聊共用同一个 AstrBot 会话（人格 / 记忆 / 上下文）。
- 桌面发来的消息注入指定 UMO，走完整管线。
- 注入事件使用假 bot，希罗的回复不会发到 QQ。
- 在 bot 的“实际发送层”逐条记录，保留 QQ 的分段节奏、表情包和指令回复。

0.3.0 变更：
- 不再在 on_decorating_result 记录整段回复，改为包装 send_private_msg。
- 消息支持 attachments（图片 / GIF），原图存 media 目录，日志只存元数据。
- 新增 /bootstrap、/status、/media、/commands。
- 放开桌面端的 / 指令；桌面注入事件按管理员处理。
- /messages 的 cursor 改为“最后一条实际返回的消息 id”，并返回 hasMore。

设计边界：
- 只处理一个固定 UMO（默认 Hiro:FriendMessage:1955272576）。
- 媒体原图保存在 plugin_data/<plugin>/media；缩略图按需生成。
- Windows 端通过 /api/v1/plugins/extensions/... 访问，需要 plugin scope 的 API Key。
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import math
import os
import re
import time
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote, urlparse
from zoneinfo import ZoneInfo

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
PLUGIN_VERSION = "0.3.0"

DEFAULT_UMO = "Hiro:FriendMessage:1955272576"
DEFAULT_PLATFORM_ID = "Hiro"
DEFAULT_USER_ID = "1955272576"
DEFAULT_SELF_ID = "1169321938"
DEFAULT_NICKNAME = "他"

MAX_MESSAGE_CHARS = 2000
MAX_LOG_TEXT = 4000
MAX_IMAGE_BASE64 = 12_000_000
MAX_MEDIA_BYTES = 12_000_000
MAX_HISTORY_IMAGES = 8
DEFAULT_BOOTSTRAP_HISTORY = 500
DEFAULT_MEDIA_MAX_MB = 500
THUMB_MAX_SIZE = 480
THUMB_QUALITY = 78

EMOTIONS = ("委屈", "生气", "开心", "害羞", "担心", "失落", "累", "吃醋")

# 和 astrbot_plugin_hiro_mood 保持一致。
HALF_LIFE = {
    "生气": 3.0,
    "开心": 1.5,
    "委屈": 12.0,
    "害羞": 2.0,
    "担心": 6.0,
    "失落": 6.0,
    "累": 8.0,
    "吃醋": 6.0,
}
RESIDUAL_FLOOR = 0.08

MOOD_DEFAULTS = {
    "timezone": "Asia/Shanghai",
    "affection_enabled": True,
    "affection_initial": 30.0,
    "affection_decay_floor": 0.2,
    "affection_decay_days_20_to_1": 30.0,
    "affection_daily_gain_cap": 5.0,
    "affection_daily_loss_cap": 5.0,
    "affection_boost_enabled": True,
    "affection_boost_gain_cap": 20.0,
    "affection_boost_threshold": 0.7,
    "affection_confession_threshold": 100.0,
    "affection_partner_max": 200.0,
}

_EMOTION_RE = re.compile(r"&&[^&\n]{1,12}&&")
_SYSTEM_RE = re.compile(r"<system_reminder>.*?</system_reminder>", re.S)
_QUOTE_RE = re.compile(r"<Quoted Message>.*?</Quoted Message>", re.S)
_IMAGE_PLACEHOLDER_RE = re.compile(r"\[Image \d+:[^\]]*\]", re.I)
_MULTI_IMAGE_RE = re.compile(r"(?:\[图片\]){2,}")
_MEDIA_ID_RE = re.compile(r"^[0-9a-f]{16,64}\.[a-z0-9]{2,5}$")

_MIME_EXT = {
    "image/gif": "gif",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/bmp": "bmp",
}
_PIL_MIME = {
    "GIF": "image/gif",
    "PNG": "image/png",
    "JPEG": "image/jpeg",
    "WEBP": "image/webp",
    "BMP": "image/bmp",
}

# 子指令里命中这些词时也视为危险。
DANGEROUS_ROOTS = {
    "reset",
    "new",
    "del",
    "delete",
    "clear",
    "清除",
    "清空",
    "重置",
    "provider",
    "model",
    "persona",
    "plugin",
    "op",
    "dashboard_update",
    "ni",
    "ni重置",
    "删图",
    "存tag",
    "应用tag",
    "删除tag",
    "搜图",
    "自动搜图立即执行",
    "心情表情刷新",
}
DANGEROUS_SUBCOMMANDS = {
    "心情": {"重置", "冷战", "解除冷战", "结束冷战", "uncold", "reset", "clear"},
    "好感": {"设置", "set"},
    "记忆": {"刷新", "flush", "删除", "delete", "回填", "backfill", "重建", "rebuild", "画像", "profile"},
}
DANGEROUS_KEYWORDS = (
    "重置",
    "清空",
    "清除",
    "删除",
    "删图",
    "重建",
    "回填",
    "冷战",
    "设置好感",
    "生图",
    "画图",
    "搜图",
    "ni重置",
)

FALLBACK_COMMANDS = [
    {"name": "/心情", "description": "查看希罗现在的心情（管理员）"},
    {"name": "/好感", "description": "查看好感度（管理员）"},
    {"name": "/记忆 状态", "description": "查看记忆插件状态（管理员）"},
    {"name": "/记忆 检索 关键词", "description": "检索长期记忆（管理员）"},
    {"name": "/help", "description": "查看 AstrBot 指令帮助"},
    {"name": "/ping", "description": "检查机器人是否在线"},
    {"name": "/version", "description": "查看 AstrBot 版本"},
]


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


def _thumbnail_data_url(url: str | None, max_size: int = THUMB_MAX_SIZE) -> str | None:
    """把会话里的图片压成小缩略图，避免 /history 返回几 MB 的 base64。"""
    if not isinstance(url, str) or not url.startswith("data:image/"):
        return None
    try:
        _, _, body = url.partition(",")
        raw = base64.b64decode(body)
        with PILImage.open(io.BytesIO(raw)) as image:
            image.seek(0)
            if image.mode not in ("RGB", "L", "RGBA"):
                image = image.convert("RGBA")
            image.thumbnail((max_size, max_size))
            out = io.BytesIO()
            if image.mode == "RGBA":
                image.save(out, format="PNG")
                mime = "image/png"
            else:
                image.convert("RGB").save(out, format="JPEG", quality=75)
                mime = "image/jpeg"
        return f"data:{mime};base64," + base64.b64encode(out.getvalue()).decode()
    except Exception:
        return None


def _norm_command(value: object) -> str:
    name = str(value or "").strip()
    if not name:
        return ""
    return name if name.startswith("/") else f"/{name}"


def _command_root(name: str) -> str:
    return name.lstrip("/").split(" ", 1)[0].strip()


def _command_sub(name: str) -> str:
    parts = name.lstrip("/").split(" ", 1)
    return parts[1].strip().split(" ", 1)[0] if len(parts) > 1 else ""


def _is_dangerous_command(name: str) -> bool:
    root = _command_root(name)
    sub = _command_sub(name)
    if root in DANGEROUS_ROOTS:
        return True
    if sub and sub in DANGEROUS_SUBCOMMANDS.get(root, set()):
        return True
    lowered = name.lstrip("/").lower()
    return any(word.lower() in lowered for word in DANGEROUS_KEYWORDS)


class MediaStore:
    """原图 + 按需生成的缩略图。"""

    def __init__(self, root: Path, max_bytes: int) -> None:
        self.root = root
        self.media_dir = root / "media"
        self.thumb_dir = root / "thumbs"
        self.max_bytes = max(16 * 1024 * 1024, max_bytes)

    def _ensure_dirs(self) -> None:
        self.media_dir.mkdir(parents=True, exist_ok=True)
        self.thumb_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _detect(raw: bytes) -> tuple[str, str, int, int, bool]:
        mime = ""
        width = 0
        height = 0
        animated = False
        try:
            with PILImage.open(io.BytesIO(raw)) as image:
                mime = _PIL_MIME.get(str(image.format or "").upper(), "")
                width, height = image.size
                animated = bool(getattr(image, "is_animated", False)) and int(
                    getattr(image, "n_frames", 1) or 1
                ) > 1
        except Exception:
            if raw[:3] == b"GIF":
                mime = "image/gif"
            elif raw[:8] == b"\x89PNG\r\n\x1a\n":
                mime = "image/png"
            elif raw[:2] == b"\xff\xd8":
                mime = "image/jpeg"
            elif raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
                mime = "image/webp"
        if not mime:
            mime = "application/octet-stream"
        return mime, _MIME_EXT.get(mime, "bin"), width, height, animated

    def save(self, raw: bytes, hint: str | None = None) -> dict | None:
        if not raw or len(raw) > MAX_MEDIA_BYTES:
            return None
        mime, ext, width, height, animated = self._detect(raw)
        if mime == "application/octet-stream" and hint:
            suffix = Path(hint).suffix.lower().lstrip(".")
            if suffix in {"gif", "png", "jpg", "jpeg", "webp", "bmp"}:
                ext = "jpg" if suffix == "jpeg" else suffix
                mime = {
                    "gif": "image/gif",
                    "png": "image/png",
                    "jpg": "image/jpeg",
                    "webp": "image/webp",
                    "bmp": "image/bmp",
                }[ext]
        digest = hashlib.sha1(raw).hexdigest()[:20]
        media_id = f"{digest}.{ext}"
        self._ensure_dirs()
        target = self.media_dir / media_id
        if not target.exists():
            tmp = target.with_suffix(target.suffix + ".tmp")
            tmp.write_bytes(raw)
            os.replace(tmp, target)
        return {
            "type": "image",
            "media": media_id,
            "mime": mime,
            "width": width,
            "height": height,
            "animated": animated,
            "bytes": len(raw),
        }

    def _find(self, media_id: str) -> Path | None:
        if not _MEDIA_ID_RE.fullmatch(media_id):
            return None
        path = self.media_dir / media_id
        return path if path.is_file() else None

    def original(self, media_id: str) -> tuple[bytes, str, dict] | None:
        path = self._find(media_id)
        if path is None:
            return None
        try:
            raw = path.read_bytes()
        except Exception:
            return None
        mime, _, width, height, animated = self._detect(raw)
        return raw, mime, {
            "media": media_id,
            "width": width,
            "height": height,
            "animated": animated,
            "bytes": len(raw),
        }

    def thumb(self, media_id: str) -> tuple[bytes, str, dict] | None:
        path = self._find(media_id)
        if path is None:
            return None
        self._ensure_dirs()
        stem = Path(media_id).stem
        for ext, mime in (("webp", "image/webp"), ("png", "image/png"), ("jpg", "image/jpeg")):
            cached = self.thumb_dir / f"{stem}.{ext}"
            if cached.is_file():
                try:
                    raw = cached.read_bytes()
                    meta = self._meta_for_thumb(media_id, raw)
                    return raw, mime, meta
                except Exception:
                    continue
        try:
            raw = path.read_bytes()
            with PILImage.open(io.BytesIO(raw)) as image:
                image.seek(0)
                if image.mode not in ("RGB", "L", "RGBA"):
                    image = image.convert("RGBA")
                image.thumbnail((THUMB_MAX_SIZE, THUMB_MAX_SIZE))
                out = io.BytesIO()
                mime = "image/webp"
                try:
                    image.save(out, format="WEBP", quality=THUMB_QUALITY, method=4)
                    ext = "webp"
                except Exception:
                    out = io.BytesIO()
                    if image.mode == "RGBA":
                        image.save(out, format="PNG")
                        mime = "image/png"
                        ext = "png"
                    else:
                        image.convert("RGB").save(out, format="JPEG", quality=THUMB_QUALITY)
                        mime = "image/jpeg"
                        ext = "jpg"
                data = out.getvalue()
            target = self.thumb_dir / f"{stem}.{ext}"
            tmp = target.with_suffix(target.suffix + ".tmp")
            tmp.write_bytes(data)
            os.replace(tmp, target)
            meta = self._meta_for_thumb(media_id, data)
            return data, mime, meta
        except Exception:
            logger.exception("[desktoppet] 生成缩略图失败 media=%s", media_id)
            return None

    def _meta_for_thumb(self, media_id: str, raw: bytes) -> dict:
        width = 0
        height = 0
        animated = False
        try:
            with PILImage.open(io.BytesIO(raw)) as image:
                width, height = image.size
        except Exception:
            pass
        return {
            "media": media_id,
            "width": width,
            "height": height,
            "animated": animated,
            "bytes": len(raw),
        }

    def total_bytes(self) -> int:
        total = 0
        for directory in (self.media_dir, self.thumb_dir):
            try:
                for path in directory.iterdir():
                    if path.is_file():
                        total += path.stat().st_size
            except Exception:
                continue
        return total

    def cleanup(self, referenced: set[str]) -> None:
        self._ensure_dirs()
        now = time.time()
        try:
            for path in self.media_dir.iterdir():
                if not path.is_file() or path.name.endswith(".tmp"):
                    continue
                if path.name in referenced:
                    continue
                try:
                    if now - path.stat().st_mtime < 3600:
                        continue
                    path.unlink()
                except Exception:
                    continue
            valid = {path.stem for path in self.media_dir.iterdir() if path.is_file()}
            for path in self.thumb_dir.iterdir():
                if path.is_file() and path.stem not in valid:
                    try:
                        path.unlink()
                    except Exception:
                        continue
            if self.total_bytes() > self.max_bytes:
                logger.warning(
                    "[desktoppet] 媒体目录超过上限：%s / %s bytes",
                    self.total_bytes(),
                    self.max_bytes,
                )
        except Exception:
            logger.exception("[desktoppet] 清理媒体目录失败")


class _DesktopBot:
    """假 bot：吞掉所有发送，同时把每一条实际发送记录到桥接插件。"""

    def __init__(self, self_id: str, bridge: "DesktopPetBridge") -> None:
        self.self_id = self_id
        self.bridge = bridge

    async def send_private_msg(self, **kwargs: object) -> dict:
        try:
            message = kwargs.get("message")
            await self.bridge._capture_onebot_message(message, "desktop")
        except Exception:
            logger.exception("[desktoppet] 记录桌面回复失败")
        return {"message_id": 0}

    async def send_group_msg(self, **_kwargs: object) -> dict:
        return {"message_id": 0}

    async def send(self, **kwargs: object) -> dict:
        try:
            message = kwargs.get("message")
            await self.bridge._capture_onebot_message(message, "desktop")
        except Exception:
            logger.exception("[desktoppet] 记录桌面回复失败")
        return {"message_id": 0}

    async def call_action(self, action: str, **kwargs: object) -> dict:
        if action in ("send_private_msg", "send_msg"):
            try:
                message = kwargs.get("message")
                await self.bridge._capture_onebot_message(message, "desktop")
            except Exception:
                logger.exception("[desktoppet] 记录桌面回复失败")
        return {"message_id": 0}

    def __getattr__(self, _name: str):
        async def _noop(*_args: object, **_kwargs: object) -> dict:
            return {"message_id": 0}

        return _noop


@register(
    PLUGIN_NAME,
    "MXJ",
    "MONOSABA DesktopPET 与 QQ 私聊共享同一个 AstrBot 会话；桌面消息只回桌面，不投递到 QQ。",
    PLUGIN_VERSION,
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
        self.max_log = max(50, int(self.config.get("max_log") or 2000))
        self.bootstrap_history_limit = max(
            0, int(self.config.get("bootstrap_history_limit") or DEFAULT_BOOTSTRAP_HISTORY)
        )
        self.screen_hint = str(
            self.config.get("screen_hint")
            or "这张截图来自他的电脑屏幕；画面里的 Live2D 桌宠人物是希罗本人（也就是你），不是其他人。聊天窗口是你们正在用的桌面聊天框。",
        ).strip()

        data_root = Path(get_astrbot_plugin_data_path())
        self.data_dir = data_root / PLUGIN_NAME
        self.log_path = self.data_dir / "messages.jsonl"
        self.meta_path = self.data_dir / "messages.meta.json"
        self.mood_data_path = Path(
            str(self.config.get("mood_data_path") or "")
            or (data_root / "astrbot_plugin_hiro_mood" / "mood.json")
        )
        self.mood_config_path = Path(
            str(self.config.get("mood_config_path") or "")
            or (data_root.parent / "config" / "astrbot_plugin_hiro_mood_config.json")
        )
        self.mood_timezone = str(
            self.config.get("mood_timezone") or MOOD_DEFAULTS["timezone"]
        ).strip() or MOOD_DEFAULTS["timezone"]
        media_max_bytes = int(
            float(self.config.get("media_max_mb") or DEFAULT_MEDIA_MAX_MB) * 1024 * 1024
        )
        self._media = MediaStore(self.data_dir, media_max_bytes)

        self._entries: list[dict] = []
        self._next_id = 1
        self._epoch = uuid.uuid4().hex
        self._lock = asyncio.Lock()
        self._capture_task: asyncio.Task | None = None
        self._closed = False
        self._mood_config: dict = {}
        self._affection_k: float | None = None

    # ------------------------------------------------------------------ 生命周期
    async def initialize(self) -> None:
        await asyncio.to_thread(self._load_log)
        await asyncio.to_thread(self._load_mood_config)

        self.context.register_web_api(
            f"/{PLUGIN_NAME}/ping",
            self._api_ping,
            ["GET"],
            "桌面聊天桥接：平台、QQ 连接状态与能力",
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
            "桌面聊天桥接：从当前会话回填历史（兼容旧客户端）",
        )
        self.context.register_web_api(
            f"/{PLUGIN_NAME}/bootstrap",
            self._api_bootstrap,
            ["GET"],
            "桌面聊天桥接：首次启动的完整日志与会话历史",
        )
        self.context.register_web_api(
            f"/{PLUGIN_NAME}/status",
            self._api_status,
            ["GET"],
            "桌面聊天桥接：心情 / 好感度状态",
        )
        self.context.register_web_api(
            f"/{PLUGIN_NAME}/media",
            self._api_media,
            ["GET"],
            "桌面聊天桥接：读取图片原图 / 缩略图",
        )
        self.context.register_web_api(
            f"/{PLUGIN_NAME}/commands",
            self._api_commands,
            ["GET"],
            "桌面聊天桥接：动态读取 AstrBot 指令列表",
        )

        self._capture_task = asyncio.create_task(self._capture_loop())
        logger.info(
            "[desktoppet] 桥接 %s 已加载 umo=%s platform=%s log=%s epoch=%s",
            PLUGIN_VERSION,
            self.umo,
            self.platform_id,
            self.log_path,
            self._epoch,
        )

    async def terminate(self) -> None:
        self._closed = True
        if self._capture_task is not None:
            self._capture_task.cancel()
            try:
                await self._capture_task
            except Exception:
                pass
            self._capture_task = None
        self._restore_capture()

    async def _capture_loop(self) -> None:
        while not self._closed:
            try:
                self._ensure_capture()
            except Exception:
                logger.exception("[desktoppet] 安装发送捕获失败")
            await asyncio.sleep(3)

    # ------------------------------------------------------------------ 日志
    def _load_meta(self) -> dict:
        try:
            if self.meta_path.is_file():
                data = json.loads(self.meta_path.read_text(encoding="utf-8"))
                if isinstance(data, dict) and isinstance(data.get("epoch"), str):
                    return data
        except Exception:
            pass
        return {}

    def _save_meta(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        tmp = self.meta_path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps({"epoch": self._epoch}, ensure_ascii=False),
            encoding="utf-8",
        )
        os.replace(tmp, self.meta_path)

    def _load_log(self) -> None:
        path = self.log_path
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            meta = self._load_meta()
            existing = path.is_file() and path.stat().st_size > 0
            if existing and isinstance(meta.get("epoch"), str):
                self._epoch = meta["epoch"]
            else:
                self._epoch = uuid.uuid4().hex
            self._save_meta()

            entries: list[dict] = []
            if path.is_file():
                with path.open("r", encoding="utf-8") as handle:
                    for line in handle:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            item = json.loads(line)
                        except Exception:
                            continue
                        normalized = self._normalize_entry(item)
                        if normalized:
                            entries.append(normalized)

            entries.sort(key=lambda item: item["id"])
            trimmed = len(entries) > self.max_log
            if trimmed:
                entries = entries[-self.max_log :]
            self._entries = entries
            self._next_id = (entries[-1]["id"] + 1) if entries else 1
            if trimmed:
                self._rewrite_log()
                self._cleanup_media()
        except Exception:
            logger.exception("[desktoppet] 读取消息日志失败，使用空日志")
            self._entries = []
            self._next_id = 1

    def _normalize_entry(self, item: object) -> dict | None:
        if not isinstance(item, dict):
            return None
        try:
            entry_id = int(item["id"])
        except Exception:
            return None
        if entry_id <= 0:
            return None
        role = item.get("role")
        if role not in ("user", "assistant"):
            return None
        text = item.get("text")
        if not isinstance(text, str):
            text = ""
        attachments = item.get("attachments")
        normalized_attachments: list[dict] = []
        if isinstance(attachments, list):
            for attachment in attachments:
                if not isinstance(attachment, dict):
                    continue
                media = attachment.get("media")
                if not isinstance(media, str) or not _MEDIA_ID_RE.fullmatch(media):
                    continue
                normalized_attachments.append(
                    {
                        "type": "image",
                        "media": media,
                        "mime": str(attachment.get("mime") or "image/webp"),
                        "width": int(attachment.get("width") or 0),
                        "height": int(attachment.get("height") or 0),
                        "animated": bool(attachment.get("animated")),
                    }
                )
        if not text and not normalized_attachments:
            return None
        try:
            ts = int(item.get("ts") or 0)
        except Exception:
            ts = 0
        return {
            "id": entry_id,
            "ts": ts,
            "role": role,
            "origin": item.get("origin"),
            "text": text,
            "attachments": normalized_attachments,
        }

    def _rewrite_log(self) -> None:
        path = self.log_path
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        with tmp.open("w", encoding="utf-8", newline="\n") as handle:
            for item in self._entries:
                handle.write(json.dumps(item, ensure_ascii=False) + "\n")
        os.replace(tmp, path)

    def _append_log(self, entry: dict) -> None:
        path = self.log_path
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def _cleanup_media(self) -> None:
        referenced: set[str] = set()
        for entry in self._entries:
            for attachment in entry.get("attachments") or []:
                media = attachment.get("media")
                if isinstance(media, str):
                    referenced.add(media)
        self._media.cleanup(referenced)

    async def _append(
        self,
        role: str,
        text: str,
        origin: str | None,
        attachments: list[dict] | None = None,
    ) -> dict | None:
        cleaned = _clean(text)
        normalized = [item for item in (attachments or []) if isinstance(item, dict)]
        if not cleaned and not normalized:
            return None
        async with self._lock:
            entry = {
                "id": self._next_id,
                "ts": int(time.time() * 1000),
                "role": role,
                "origin": origin,
                "text": cleaned,
                "attachments": normalized,
            }
            self._next_id += 1
            self._entries.append(entry)
            try:
                if len(self._entries) > self.max_log:
                    self._entries = self._entries[-self.max_log :]
                    await asyncio.to_thread(self._rewrite_log)
                    await asyncio.to_thread(self._cleanup_media)
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

    # ------------------------------------------------------------------ 发送捕获
    def _ensure_capture(self) -> None:
        adapter = self._adapter()
        bot = getattr(adapter, "bot", None) if adapter is not None else None
        if bot is None:
            return
        owner = getattr(bot, "_desktoppet_capture_owner", None)
        if owner is not None:
            # 插件重载后把记录目标指向新实例，避免旧实例继续接收。
            bot._desktoppet_capture_owner = self
            return
        original = bot.send_private_msg

        async def wrapped(*args: object, **kwargs: object) -> object:
            result = await original(*args, **kwargs)
            try:
                current = getattr(bot, "_desktoppet_capture_owner", None)
                if current is not None:
                    await current._capture_bot_send(kwargs)
            except Exception:
                logger.exception("[desktoppet] 记录 QQ 回复失败")
            return result

        try:
            bot.send_private_msg = wrapped
            bot._desktoppet_original_send_private = original
            bot._desktoppet_capture_owner = self
            logger.info("[desktoppet] 已安装发送层捕获")
        except Exception:
            logger.exception("[desktoppet] 无法安装发送层捕获")

    def _restore_capture(self) -> None:
        adapter = self._adapter()
        bot = getattr(adapter, "bot", None) if adapter is not None else None
        if bot is None:
            return
        try:
            if getattr(bot, "_desktoppet_capture_owner", None) is not self:
                return
            original = getattr(bot, "_desktoppet_original_send_private", None)
            if original is not None:
                bot.send_private_msg = original
            for attr in (
                "_desktoppet_capture_owner",
                "_desktoppet_original_send_private",
            ):
                try:
                    delattr(bot, attr)
                except Exception:
                    pass
        except Exception:
            logger.exception("[desktoppet] 恢复发送层失败")

    async def _capture_bot_send(self, kwargs: dict) -> None:
        user_id = kwargs.get("user_id")
        if user_id is not None and str(user_id) != self.user_id:
            return
        message = kwargs.get("message")
        if isinstance(message, list):
            await self._capture_onebot_message(message, "qq")

    async def _capture_onebot_message(
        self,
        message: object,
        origin: str,
    ) -> dict | None:
        if isinstance(message, dict):
            message = [message]
        if not isinstance(message, list):
            return None
        texts: list[str] = []
        attachments: list[dict] = []
        for segment in message:
            if not isinstance(segment, dict):
                continue
            kind = segment.get("type")
            data = segment.get("data")
            if not isinstance(data, dict):
                data = {}
            if kind == "text":
                texts.append(str(data.get("text") or ""))
            elif kind == "image":
                raw = await self._resolve_image_data(data)
                attachment = (
                    await asyncio.to_thread(self._media.save, raw, data.get("file"))
                    if raw
                    else None
                )
                if attachment:
                    attachments.append(attachment)
                else:
                    texts.append("[图片]")
            elif kind == "face":
                texts.append("[表情]")
            elif kind == "record":
                texts.append("[语音]")
            elif kind == "video":
                texts.append("[视频]")
            elif kind == "at":
                texts.append(f"@{data.get('name') or data.get('qq') or ''}")
            elif kind == "file":
                texts.append("[文件]")
            elif kind in ("reply", "forward", "node"):
                continue
            else:
                text = data.get("text")
                if isinstance(text, str) and text:
                    texts.append(text)
        text = "".join(texts).strip()
        if not text and not attachments:
            return None
        return await self._append("assistant", text, origin, attachments)

    async def _resolve_image_data(self, data: dict) -> bytes | None:
        file_value = data.get("file")
        url_value = data.get("url")
        path_value = data.get("path")
        for value in (file_value, path_value):
            if not isinstance(value, str) or not value:
                continue
            if value.startswith("base64://"):
                try:
                    raw = base64.b64decode(value[len("base64://") :], validate=False)
                    return raw if len(raw) <= MAX_MEDIA_BYTES else None
                except Exception:
                    continue
            if value.startswith("data:image/"):
                try:
                    raw = base64.b64decode(value.partition(",")[2], validate=False)
                    return raw if len(raw) <= MAX_MEDIA_BYTES else None
                except Exception:
                    continue
            if value.startswith("file://"):
                try:
                    path = Path(unquote(urlparse(value).path))
                    if path.is_file():
                        return path.read_bytes()
                except Exception:
                    continue
            if value.startswith(("http://", "https://")):
                raw = await self._fetch_bytes(value)
                if raw:
                    return raw
                continue
            try:
                path = Path(value)
                if path.is_file():
                    return path.read_bytes()
            except Exception:
                continue
        if isinstance(url_value, str) and url_value.startswith(("http://", "https://")):
            return await self._fetch_bytes(url_value)
        return None

    async def _resolve_component_image(self, comp: object) -> bytes | None:
        try:
            converter = getattr(comp, "convert_to_file_path", None)
            if callable(converter):
                path = await converter()
                if path:
                    raw = await asyncio.to_thread(Path(path).read_bytes)
                    return raw if len(raw) <= MAX_MEDIA_BYTES else None
        except Exception:
            pass
        data = {
            "file": getattr(comp, "file", None),
            "url": getattr(comp, "url", None),
            "path": getattr(comp, "path", None),
        }
        return await self._resolve_image_data(data)

    async def _fetch_bytes(self, url: str) -> bytes | None:
        try:
            import httpx

            async with httpx.AsyncClient(
                timeout=20,
                follow_redirects=True,
            ) as client:
                response = await client.get(url)
                response.raise_for_status()
                if len(response.content) > MAX_MEDIA_BYTES:
                    return None
                return response.content
        except Exception:
            logger.warning("[desktoppet] 下载图片失败：%s", url)
            return None

    # ------------------------------------------------------------------ 历史
    async def _history(self, limit: int, include_images: bool = True) -> list[dict]:
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
            image = _content_image(row.get("content")) if include_images else None
            if not text and not image:
                continue
            messages.append(
                {
                    "id": 0,
                    "ts": 0,
                    "role": role,
                    "origin": None,
                    "text": text,
                    "image": image,
                },
            )

        result = messages[-limit:] if limit > 0 else []
        if include_images:
            image_positions = [
                index for index, message in enumerate(result) if message.get("image")
            ]
            keep = set(image_positions[-MAX_HISTORY_IMAGES:])
            for index, message in enumerate(result):
                if index in keep:
                    message["image"] = _thumbnail_data_url(message.get("image"))
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
            bot=_DesktopBot(self.self_id, self),
        )
        # 桌面端通过 API Key 鉴权，注入事件按管理员处理，
        # 这样 /心情、/好感、/记忆 等管理员指令可以直接用。
        event.role = "admin"
        event.set_extra("_desktoppet_origin", "desktop")
        event.set_extra("_desktoppet_logged", True)
        if image_data:
            event.set_extra("_desktoppet_has_screen", True)
        adapter.commit_event(event)
        return {"queued": True}

    # ------------------------------------------------------------------ 心情 / 好感
    def _load_mood_config(self) -> None:
        config = dict(MOOD_DEFAULTS)
        try:
            if self.mood_config_path.is_file():
                raw = self.mood_config_path.read_text(encoding="utf-8-sig")
                data = json.loads(raw)
                if isinstance(data, dict):
                    for key in MOOD_DEFAULTS:
                        if key in data:
                            config[key] = data[key]
                    config["timezone"] = str(
                        data.get("timezone") or config["timezone"]
                    )
        except Exception:
            logger.exception("[desktoppet] 读取心情配置失败，使用默认值")
        self._mood_config = config
        self._affection_k = None

    def _affection_floor(self) -> float:
        try:
            return max(0.0, min(1.0, float(self._mood_config.get("affection_decay_floor") or 0.2)))
        except Exception:
            return 0.2

    def _affection_target_days(self) -> float:
        try:
            return max(0.1, float(self._mood_config.get("affection_decay_days_20_to_1") or 30.0))
        except Exception:
            return 30.0

    def _solve_affection_k(self) -> float:
        if self._affection_k is not None:
            return self._affection_k
        floor = self._affection_floor()
        target_days = self._affection_target_days()

        def time_to_drop(k: float) -> float:
            value = 20.0
            total = 0.0
            step = 0.01
            while value > 1.0:
                u = max(0.0, min(1.0, value / 100.0))
                rate = k * (
                    floor
                    + (1.0 - floor)
                    * (1.0 - math.cos(2.0 * math.pi * u))
                    / 2.0
                )
                if rate <= 1e-9:
                    break
                dx = min(step, value - 1.0)
                total += dx / rate
                value -= dx
            return total

        low, high = 1e-6, 100.0
        for _ in range(60):
            mid = (low + high) / 2.0
            if time_to_drop(mid) > target_days:
                low = mid
            else:
                high = mid
        self._affection_k = (low + high) / 2.0
        return self._affection_k

    def _affection_rate(self, value: float, cap: float) -> float:
        if cap <= 0:
            return 0.0
        u = max(0.0, min(1.0, value / cap))
        floor = self._affection_floor()
        return self._solve_affection_k() * (
            floor
            + (1.0 - floor)
            * (1.0 - math.cos(2.0 * math.pi * u))
            / 2.0
        )

    def _decayed_emotion(self, name: str, item: dict, now: float) -> float:
        try:
            base = float(item.get("intensity") or 0)
            ts = float(item.get("ts") or 0)
        except (TypeError, ValueError):
            return 0.0
        if base <= 0 or ts <= 0:
            return 0.0
        if item.get("pinned"):
            return max(0.0, min(1.0, base))
        hours = max(0.0, (now - ts) / 3600.0)
        half = HALF_LIFE.get(name, 8.0)
        value = base * (0.5 ** (hours / half))
        try:
            residual_until = float(item.get("residual_until") or 0)
        except (TypeError, ValueError):
            residual_until = 0.0
        if residual_until and now < residual_until:
            value = max(value, RESIDUAL_FLOOR)
        return value

    def _affection_cap(self, session: dict) -> float:
        affection = session.get("affection") or {}
        if affection.get("partner"):
            return float(self._mood_config.get("affection_partner_max") or 200.0)
        return float(self._mood_config.get("affection_confession_threshold") or 100.0)

    def _affection_stage(self, value: float, partner: bool) -> str:
        v = max(0.0, value)
        if partner:
            if v >= 150:
                return "灵魂伴侣"
            if v >= 120:
                return "热恋"
            if v >= 100:
                return "暧昧"
            if v >= 80:
                return "伴侣线低谷"
            return "分手边缘"
        if v >= 100:
            return "密友 / 死党（满好感）"
        if v >= 70:
            return "密友 / 死党"
        if v >= 50:
            return "好朋友"
        if v >= 30:
            return "熟人"
        if v >= 20:
            return "聊得来"
        if v >= 10:
            return "初识"
        return "陌生人"

    def _affection_gain_cap_today(self, session: dict, now: float) -> float:
        affection = session.get("affection") or {}
        try:
            stored = float(
                affection.get("gain_cap_today")
                or self._mood_config.get("affection_daily_gain_cap")
                or 5.0
            )
        except (TypeError, ValueError):
            stored = 5.0
        cap = max(float(self._mood_config.get("affection_daily_gain_cap") or 5.0), stored)
        if not self._mood_config.get("affection_boost_enabled", True):
            return cap
        threshold = float(self._mood_config.get("affection_boost_threshold") or 0.7)
        emotions = session.get("emotions") or {}
        for name in ("开心", "害羞"):
            item = emotions.get(name)
            if not isinstance(item, dict):
                return cap
            if self._decayed_emotion(name, item, now) <= threshold:
                return cap
        return max(
            cap,
            float(self._mood_config.get("affection_boost_gain_cap") or 20.0),
        )

    def _decayed_affection(self, session: dict, now: float) -> tuple[float, float]:
        affection = session.get("affection") or {}
        try:
            value = float(affection.get("value") or 0.0)
            last = float(affection.get("ts") or now)
        except (TypeError, ValueError):
            return 0.0, 0.0
        cap = self._affection_cap(session)
        elapsed_days = (now - last) / 86400.0 if last > 0 else 0.0
        if elapsed_days <= 0:
            return value, cap
        remaining = elapsed_days
        steps = 0
        while remaining > 0 and steps < 2000:
            dt = min(0.25, remaining)
            if remaining > 500:
                dt = remaining / 2000.0
            rate = self._affection_rate(value, cap)
            value = max(0.0, value - rate * dt)
            remaining -= dt
            steps += 1
            if value <= 0:
                break
        return value, cap

    def _read_status_sync(self) -> dict:
        path = self.mood_data_path
        if not path.is_file():
            return {
                "available": False,
                "error": f"没有找到 {path}",
            }
        try:
            raw = path.read_text(encoding="utf-8")
            data = json.loads(raw)
        except Exception as exc:
            return {"available": False, "error": f"读取心情数据失败：{exc}"}
        if not isinstance(data, dict):
            return {"available": False, "error": "心情数据格式不正确"}
        sessions = data.get("sessions")
        session = sessions.get(self.umo) if isinstance(sessions, dict) else None
        if not isinstance(session, dict):
            session = {}
        now = time.time()
        tz = ZoneInfo(self.mood_timezone)

        emotions: list[dict] = []
        raw_emotions = session.get("emotions") or {}
        for name in EMOTIONS:
            item = raw_emotions.get(name) if isinstance(raw_emotions, dict) else None
            if not isinstance(item, dict):
                item = {}
            intensity = self._decayed_emotion(name, item, now)
            try:
                ts = float(item.get("ts") or 0)
            except (TypeError, ValueError):
                ts = 0.0
            emotions.append(
                {
                    "name": name,
                    "intensity": round(max(0.0, min(1.0, intensity)), 4),
                    "reason": str(item.get("reason") or "").strip(),
                    "ts": int(ts * 1000) if ts else 0,
                }
            )

        affection_raw = session.get("affection") or {}
        affection = None
        if isinstance(affection_raw, dict) and affection_raw:
            value, cap = self._decayed_affection(session, now)
            partner = bool(affection_raw.get("partner"))
            today = datetime.fromtimestamp(now, tz).strftime("%Y-%m-%d")
            day_changed = str(affection_raw.get("day") or "") != today
            gain_today = 0.0 if day_changed else float(affection_raw.get("gain_today") or 0.0)
            loss_today = 0.0 if day_changed else float(affection_raw.get("loss_today") or 0.0)
            try:
                cold_since = float(session.get("cold_war_since") or 0)
            except (TypeError, ValueError):
                cold_since = 0.0
            affection = {
                "value": round(value, 2),
                "cap": round(cap, 2),
                "stage": self._affection_stage(value, partner),
                "partner": partner,
                "gainToday": round(gain_today, 2),
                "lossToday": round(loss_today, 2),
                "gainCapToday": round(
                    self._affection_gain_cap_today(session, now),
                    2,
                ),
                "breakupPending": bool(affection_raw.get("breakup_pending")),
                "coldWar": bool(session.get("cold_war")),
                "coldWarSince": int(cold_since * 1000) if cold_since else 0,
                "coldWarReason": str(session.get("cold_war_reason") or ""),
            }

        recent_raw = session.get("recent")
        recent: list[dict] = []
        if isinstance(recent_raw, list):
            for row in recent_raw[-5:]:
                if not isinstance(row, dict):
                    continue
                recent.append(
                    {
                        "user": str(row.get("u") or "").strip(),
                        "assistant": str(row.get("a") or "").strip(),
                        "ts": int(float(row.get("t") or 0) * 1000),
                    }
                )

        try:
            thought_ts = float(session.get("thought_ts") or 0)
        except (TypeError, ValueError):
            thought_ts = 0.0
        try:
            updated = float(session.get("updated") or 0)
        except (TypeError, ValueError):
            updated = 0.0

        return {
            "available": True,
            "umo": self.umo,
            "updatedAt": int(updated * 1000) if updated else 0,
            "thoughtAt": int(thought_ts * 1000) if thought_ts else 0,
            "lastThought": str(session.get("last_thought") or "").strip(),
            "affection": affection,
            "emotions": emotions,
            "recent": recent,
            "coldWar": bool(session.get("cold_war")),
        }

    # ------------------------------------------------------------------ Web API
    async def _api_ping(self):
        try:
            self._ensure_capture()
        except Exception:
            pass
        return {
            "status": "ok",
            "data": {
                "platform": self._adapter() is not None,
                "qqConnected": self._qq_connected(),
                "version": PLUGIN_VERSION,
                "epoch": self._epoch,
                "capabilities": [
                    "bootstrap",
                    "status",
                    "media",
                    "commands",
                    "attachments",
                    "send-layer",
                ],
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

        image_data = None
        image_attachment = None
        image = payload.get("image")
        if isinstance(image, dict):
            data = image.get("data")
            if isinstance(data, str):
                data = data.strip()
                if len(data) > MAX_IMAGE_BASE64:
                    return {"status": "error", "message": "截图太大了。"}
                try:
                    raw = base64.b64decode(data, validate=True)
                except Exception:
                    return {"status": "error", "message": "截图格式不正确。"}
                image_attachment = await asyncio.to_thread(
                    self._media.save,
                    raw,
                    "screenshot.jpg",
                )
                if image_attachment is None:
                    return {"status": "error", "message": "截图格式不正确。"}
                image_data = data

        adapter = self._adapter()
        if adapter is None:
            return {"status": "error", "message": "平台 Hiro 未加载。"}

        try:
            self._ensure_capture()
        except Exception:
            pass

        attachments = [image_attachment] if image_attachment else []
        entry = await self._append("user", text, "desktop", attachments)
        try:
            await self._inject(text, image_data)
        except Exception:
            logger.exception("[desktoppet] 注入消息失败")
            return {"status": "error", "message": "注入消息失败。"}
        return {
            "status": "ok",
            "data": {
                "message": entry,
                "capabilities": ["attachments"],
            },
        }

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

        pending = [item for item in self._entries if item["id"] > after]
        messages = pending[:limit]
        cursor = messages[-1]["id"] if messages else self._last_id()
        return {
            "status": "ok",
            "data": {
                "messages": messages,
                "cursor": cursor,
                "hasMore": len(pending) > len(messages),
                "qqConnected": self._qq_connected(),
                "epoch": self._epoch,
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

        cursor = self._last_id()
        return {
            "status": "ok",
            "data": {
                "messages": await self._history(limit, include_images=True),
                "cursor": cursor,
                "qqConnected": self._qq_connected(),
                "epoch": self._epoch,
            },
        }

    async def _api_bootstrap(self):
        messages = list(self._entries)
        cursor = messages[-1]["id"] if messages else 0
        history = await self._history(
            self.bootstrap_history_limit,
            include_images=False,
        )
        return {
            "status": "ok",
            "data": {
                "messages": messages,
                "history": history,
                "cursor": cursor,
                "epoch": self._epoch,
                "qqConnected": self._qq_connected(),
                "version": PLUGIN_VERSION,
                "capabilities": [
                    "bootstrap",
                    "status",
                    "media",
                    "commands",
                    "attachments",
                    "send-layer",
                ],
                "logLimit": self.max_log,
            },
        }

    async def _api_status(self):
        data = await asyncio.to_thread(self._read_status_sync)
        if not data.get("available"):
            return {
                "status": "ok",
                "data": data,
            }
        return {"status": "ok", "data": data}

    async def _api_media(self):
        media_id = str(web_request.query.get("media", "") or "").strip()
        kind = str(web_request.query.get("kind", "thumb") or "thumb").strip().lower()
        if not _MEDIA_ID_RE.fullmatch(media_id):
            return {"status": "error", "message": "图片 id 不正确。"}
        if kind == "original":
            result = await asyncio.to_thread(self._media.original, media_id)
        else:
            result = await asyncio.to_thread(self._media.thumb, media_id)
        if result is None:
            return {"status": "error", "message": "图片不存在。"}
        raw, mime, meta = result
        return {
            "status": "ok",
            "data": {
                **meta,
                "mime": mime,
                "base64": base64.b64encode(raw).decode(),
            },
        }

    async def _api_commands(self):
        rows: list[dict] = []
        source = "astrbot"
        try:
            from astrbot.core.star.command_management import list_commands

            rows = await list_commands()
        except Exception:
            logger.exception("[desktoppet] 读取 AstrBot 指令列表失败，使用内置列表")
            rows = []
            source = "fallback"

        commands: list[dict] = []
        if isinstance(rows, list):
            for row in rows:
                if not isinstance(row, dict):
                    continue
                if not row.get("enabled", True):
                    continue
                if "plugin_activated" in row and not row.get("plugin_activated"):
                    continue
                name = _norm_command(row.get("effective_command"))
                if not name:
                    continue
                subcommands: list[dict] = []
                raw_subs = row.get("sub_commands")
                if isinstance(raw_subs, list):
                    for sub in raw_subs:
                        if not isinstance(sub, dict):
                            continue
                        if not sub.get("enabled", True):
                            continue
                        sub_name = _norm_command(sub.get("effective_command"))
                        if not sub_name:
                            continue
                        subcommands.append(
                            {
                                "name": sub_name,
                                "description": str(sub.get("description") or ""),
                                "dangerous": _is_dangerous_command(sub_name),
                                "permission": str(sub.get("permission") or "everyone"),
                            }
                        )
                commands.append(
                    {
                        "name": name,
                        "aliases": [
                            _norm_command(alias)
                            for alias in (row.get("aliases") or [])
                            if _norm_command(alias)
                        ],
                        "description": str(row.get("description") or ""),
                        "permission": str(row.get("permission") or "everyone"),
                        "plugin": str(
                            row.get("plugin_display_name")
                            or row.get("plugin")
                            or ""
                        ),
                        "dangerous": _is_dangerous_command(name),
                        "subcommands": subcommands,
                    }
                )

        if not commands:
            source = "fallback"
            commands = [
                {
                    "name": item["name"],
                    "aliases": [],
                    "description": item["description"],
                    "permission": "admin" if item["name"].startswith(("/心情", "/好感", "/记忆")) else "everyone",
                    "plugin": "内置",
                    "dangerous": _is_dangerous_command(item["name"]),
                    "subcommands": [],
                }
                for item in FALLBACK_COMMANDS
            ]

        commands.sort(key=lambda item: item["name"].lower())
        return {
            "status": "ok",
            "data": {
                "commands": commands,
                "source": source,
                "generatedAt": int(time.time() * 1000),
            },
        }

    # ------------------------------------------------------------------ 钩子：记录手机消息与桌面提示
    @filter.event_message_type(filter.EventMessageType.PRIVATE_MESSAGE, priority=100)
    async def _on_private_message(self, event: AstrMessageEvent) -> None:
        try:
            if event.unified_msg_origin != self.umo:
                return
            if event.get_extra("_desktoppet_logged"):
                return
            event.set_extra("_desktoppet_logged", True)
            await self._capture_event_user(event)
        except Exception:
            logger.exception("[desktoppet] 记录用户消息失败")

    async def _capture_event_user(self, event: AstrMessageEvent) -> None:
        texts: list[str] = []
        attachments: list[dict] = []
        try:
            components = event.get_messages()
        except Exception:
            components = getattr(event.message_obj, "message", []) or []
        for comp in components:
            name = type(comp).__name__
            if name == "Plain":
                texts.append(getattr(comp, "text", "") or "")
            elif name == "Image":
                raw = await self._resolve_component_image(comp)
                attachment = (
                    await asyncio.to_thread(self._media.save, raw)
                    if raw
                    else None
                )
                if attachment:
                    attachments.append(attachment)
                else:
                    texts.append("[图片]")
            elif name == "Face":
                texts.append("[表情]")
            elif name == "Record":
                texts.append("[语音]")
            elif name == "Video":
                texts.append("[视频]")
            elif name == "At":
                texts.append(
                    f"@{getattr(comp, 'name', None) or getattr(comp, 'qq', None) or ''}"
                )
            elif name in ("Node", "Nodes", "Forward"):
                texts.append("[合并转发]")
            elif name == "File":
                texts.append("[文件]")
            else:
                text = getattr(comp, "text", None)
                if text:
                    texts.append(str(text))
        text = "".join(texts).strip()
        if not text and not attachments:
            return
        await self._append("user", text, "qq", attachments)

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
            await self._capture_event_user(event)
        except Exception:
            logger.exception("[desktoppet] 记录用户消息失败")

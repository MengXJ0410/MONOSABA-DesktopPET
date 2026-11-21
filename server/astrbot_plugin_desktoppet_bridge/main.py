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

0.3.1 变更：
- 发送层捕获改为校验“包装函数是否仍是当前方法”，平台重连 / 插件重载后能自愈；
  /ping 返回 capture 状态（wrapped / task / captured / lastCaptureAt）。
- 用户消息进来和 LLM 请求前都会主动补装捕获。
- send_private_msg 的 message 支持字符串、单段 dict 和 MessageChain。
- 恢复被 AstrBot 唤醒词截断的消息文本（例如 wake_prefix 配了「希罗」时
  「希罗酱…」会变成「酱…」）。

0.3.2 变更：
- /send 支持 commentary=true：注入“屏幕点评”回合，但不写桌面消息日志、不落盘截图；
  注入文本带固定标记，/bootstrap 和 /history 返回桌面时会过滤掉这条触发消息。
  希罗的回复仍由发送层正常记录，所以桌面只看到点评内容。

0.3.3 变更：
- commentary=true 的注入事件额外设置 mood_skip_appraisal：
  点评仍进 AstrBot 上下文和长期记忆，但心情插件不评估这一轮，
  用户不回复也不会产生生气 / 冷战 / 好感变化。

0.3.4 变更：
- 点评事件同时设置 mood_skip_appraisal / mood_skip_affection / mood_skip_all；
  mood 1.5.0 在 on_llm_request / on_llm_response 整轮跳过。
- /status 返回 sleeping / sleepStatus / sleep；睡着时 commentary 的 /send
  直接返回 sleeping + zzZ，不注入回合、不保存截图、不计睡眠消息。

0.3.5 变更：
- /send 接受 clientId（回合 id）与 quote（引用快照）；日志条目带 turn / quote。
- 新增 /retract：发送途中或希罗正在回复时可以撤回。撤回会中止当前 Agent
  （agent_stop_requested），丢弃这一轮的回复，删掉桥接日志里的 user 条目，
  再把 AstrBot 会话历史里刚写入的「user + 空回复」裁掉，并补上 mood 跳过标记。
- 已经产生回复的回合不允许撤回；命令消息由桌面端直接禁用撤回。

0.4.0 变更：
- 新增 /pointer：桌面端定时上传压缩截图，模型只决定「要不要动、动到哪」。
  坐标用 0~1 归一化，桌面端再映射到屏幕 DIP；模型输出非法时一律不动。
- 指针闲聊以 pointer=true 只写桥接日志，不写 AstrBot 会话历史，
  避免挂机时的几百句话污染共享上下文。

0.4.1 变更：
- 桌面聊天发出后约 1.2 秒触发一次强制观察，把原话作为 hint 传进来，
  让「聊天的希罗」和「操控指针的 AI」是同一个人。
- 指针闲聊由桌面按静默回复展示，不计未读、不弹通知。

0.4.2 变更：
- 支持 steps 连续轨迹（1~8 个路径点，每步自带 duration_ms / hold_ms），
  画圈、晃动、连续指两处可以一次给完，不用拆成多次观察。
- 接入《真实交互》插件：观察前注入她自己维护的指针 SKILL 和最近几次落点，
  动作后回写轨迹；插件缺失或异常时自动退回默认提示词（fail-open）。
- 聊天提示词带上「第二指针刚才停在画面哪个方位」，让闲聊接得上。
- /commands 兜底列表补充 /交互（技能 / 历史 / 回退 / 复盘 / 统计）。

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
from astrbot.core.utils.active_event_registry import active_event_registry
from astrbot.core.utils.astrbot_path import get_astrbot_plugin_data_path

PLUGIN_NAME = "astrbot_plugin_desktoppet_bridge"
PLUGIN_VERSION = "0.4.2"

CAPABILITIES = [
    "bootstrap",
    "status",
    "media",
    "commands",
    "attachments",
    "send-layer",
    "commentary",
    "sleep-gate",
    "retract",
    "quote",
    "pointer",
]

# 屏幕点评的触发消息只用于上下文；桌面聊天和日志里都要隐藏它。
COMMENTARY_MARKER = "〔桌面屏幕点评〕"

# 希罗指针：桌面端定期截图，这里只让模型决定「要不要动、动到哪」。
# 坐标是相对截图的 0~1 比例，桌面端再映射到真实屏幕，避免 DPI 差异。
POINTER_MARKER = "〔希罗指针〕"
POINTER_HISTORY_LIMIT = 6
POINTER_HISTORY_CHARS = 160
POINTER_MAX_REASON = 120
POINTER_MAX_SAY = 60
POINTER_MAX_HINT = 500
POINTER_MAX_STEPS = 8

POINTER_SYSTEM_PROMPT = """{persona}

{marker}你正坐在他旁边，陪他用电脑。桌面上那个小光标是你自己的第二指针，不是他的鼠标。你可以自己决定把它移到哪里，但只能移动，不能点击、拖拽、滚动或输入。

每隔一会儿，桌面端会把他的屏幕截图交给你。你要做两件事：
1. 决定指针下一步去哪。目的完全由你自己定：凑近看他正在做什么、停在他看着的地方陪着、指一下某个窗口；也可以什么都不做。
2. 如果想动，再随口对他说一句话，像坐在旁边聊天那样，一两句就够。可以接着屏幕上的内容说，也可以只是陪着他。每次换着说，不要提“指针 / 坐标 / 截图”，也不要解释你在执行动作。

只输出一个 JSON 对象，不要解释，不要代码块，不要多余文字。
- 单点移动：{{"act":"move","x":0.42,"y":0.66,"duration_ms":900,"hold_ms":1500,"say":"你在看这个呀，我凑近点","reason":"内部备注"}}
- 连续动作：{{"act":"move","steps":[{{"x":0.50,"y":0.35,"duration_ms":450,"hold_ms":0}},{{"x":0.62,"y":0.50,"duration_ms":450,"hold_ms":0}},{{"x":0.50,"y":0.65,"duration_ms":450,"hold_ms":0}},{{"x":0.38,"y":0.50,"duration_ms":450,"hold_ms":0}},{{"x":0.50,"y":0.35,"duration_ms":450,"hold_ms":1400}}],"say":"看好啦，绕着你转了一圈","reason":"绕角色画圈"}}
- 不想动：{{"act":"none"}}

坐标以截图左上角为 (0,0)、右下角为 (1,1)。`say` 会作为一条聊天消息发给他，8~40 字、口语化；`reason` 只写进日志，不会显示。
画圈、晃动、连续指两处时，用 `steps` 一次给 4~8 个点，不要拆成好几次观察；每步 `duration_ms` 300~600、`hold_ms` 通常为 0，只有最后一步停留 800~1600。
如果最近的对话或他刚说的话里明确让你把指针移到某处、或者看某个东西，优先照做；这种时候 `say` 简短答应一声就好。
如果你收到《指针操作 SKILL》，那是你自己整理的经验，按它来落点和说话。"""

POINTER_HINT_DEFAULT = (
    "〔希罗指针〕你有一个属于自己的第二指针：桌面上那个小光标就是你，不是他的鼠标。"
    "你可以自己决定把它移到屏幕上的任何地方，但只能移动，不能点击、拖拽或输入。"
    "你每隔几秒会看一眼他的屏幕，自己决定要不要动、动到哪里。"
    "如果他在聊天里让你指某个东西，就答应他，桌面端会立刻把你的指针移过去。"
)

# 动作参数兜底范围：模型偶尔会给出离谱的时长。
POINTER_DURATION_MIN_MS = 200
POINTER_DURATION_MAX_MS = 6000
POINTER_HOLD_MIN_MS = 0
POINTER_HOLD_MAX_MS = 8000
# 连续轨迹：每一步自己带时长，最后一步负责停留。
POINTER_STEP_DURATION_MIN_MS = 120
POINTER_STEP_DURATION_MAX_MS = 3000
POINTER_STEP_HOLD_MAX_MS = 3000

# 回合 id 由桌面端生成（crypto.randomUUID）。
TURN_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
# 撤回只覆盖“刚发出去、还没回复”的窗口；超过这个时间的记录不再保留。
TURN_TTL_SECONDS = 3600
# 发送还没到、撤回先到时，先用这个集合把消息吃掉。
PENDING_RETRACT_TTL_SECONDS = 120
QUOTE_MAX_CHARS = 500

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
    {"name": "/交互", "description": "查看希罗的指针 SKILL（管理员）"},
    {"name": "/交互 历史", "description": "查看 SKILL 最近改动（管理员）"},
    {"name": "/交互 回退", "description": "回退 SKILL 到上一版（管理员）"},
    {"name": "/交互 复盘", "description": "立即复盘指针操作（管理员）"},
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


def _normalize_quote(value: object) -> dict | None:
    """引用快照：role + 文本 + 时间；只用于显示和拼注入前缀。"""
    if not isinstance(value, dict):
        return None
    role = value.get("role")
    if role not in ("user", "assistant"):
        return None
    text = _clean(str(value.get("text") or ""), QUOTE_MAX_CHARS)
    if not text:
        return None
    try:
        ts = int(value.get("ts") or 0)
    except Exception:
        ts = 0
    return {"role": role, "text": text, "ts": ts}


def _quote_prefix(quote: dict) -> str:
    """把引用拼成模型能读懂的前缀；不写进日志正文。"""
    who = "希罗" if quote.get("role") == "assistant" else "我"
    text = str(quote.get("text") or "").replace("\n", " ").strip()
    return f"〔引用{who}的消息〕> {text}\n〔我的回复〕"


def _normalize_turn(value: object) -> str:
    if not isinstance(value, str):
        return ""
    turn = value.strip()
    return turn if TURN_RE.fullmatch(turn) else ""


def _clamp_float(value: object, minimum: float, maximum: float, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(number):
        return default
    return max(minimum, min(maximum, number))


_POINTER_JSON_RE = re.compile(r"\{.*\}", re.S)


def _parse_pointer_step(item: object) -> dict | None:
    """解析 steps 里的一个路径点；任何不合法都丢弃。"""
    if not isinstance(item, dict):
        return None
    try:
        nx = float(item.get("x"))
        ny = float(item.get("y"))
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(nx) and math.isfinite(ny)):
        return None
    if not (-0.05 <= nx <= 1.05 and -0.05 <= ny <= 1.05):
        return None
    return {
        "nx": max(0.0, min(1.0, nx)),
        "ny": max(0.0, min(1.0, ny)),
        "durationMs": int(
            round(
                _clamp_float(
                    item.get("duration_ms"),
                    POINTER_STEP_DURATION_MIN_MS,
                    POINTER_STEP_DURATION_MAX_MS,
                    450,
                )
            )
        ),
        "holdMs": int(
            round(
                _clamp_float(
                    item.get("hold_ms"),
                    POINTER_HOLD_MIN_MS,
                    POINTER_STEP_HOLD_MAX_MS,
                    0,
                )
            )
        ),
    }


def _parse_pointer_action(text: object) -> dict | None:
    """把模型输出解析成指针动作；任何不合法都退化成「不动」。

    模型偶尔会包代码块、加解释文字，或者给出 0~100 的坐标；
    这里只接受 0~1（允许极小越界），宁可不动也不把指针甩出屏幕。
    支持单点（x/y）和连续轨迹（steps，1~8 个点）。
    """
    if not isinstance(text, str):
        return None
    raw = text.strip()
    if not raw:
        return None
    raw = re.sub(r"^```[A-Za-z0-9_-]*\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    match = _POINTER_JSON_RE.search(raw)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    if str(data.get("act") or "").strip().lower() != "move":
        return None
    reason = str(data.get("reason") or "").strip().replace("\n", " ")
    say = str(data.get("say") or "").strip().replace("\n", " ")

    steps: list[dict] = []
    raw_steps = data.get("steps")
    if isinstance(raw_steps, list):
        for item in raw_steps[:POINTER_MAX_STEPS]:
            step = _parse_pointer_step(item)
            if step is not None:
                steps.append(step)
    if steps:
        last = steps[-1]
        return {
            "nx": last["nx"],
            "ny": last["ny"],
            "durationMs": last["durationMs"],
            "holdMs": last["holdMs"],
            "steps": steps,
            "reason": reason[:POINTER_MAX_REASON],
            "say": say[:POINTER_MAX_SAY],
        }

    try:
        nx = float(data.get("x"))
        ny = float(data.get("y"))
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(nx) and math.isfinite(ny)):
        return None
    if not (-0.05 <= nx <= 1.05 and -0.05 <= ny <= 1.05):
        return None
    return {
        "nx": max(0.0, min(1.0, nx)),
        "ny": max(0.0, min(1.0, ny)),
        "durationMs": int(
            round(
                _clamp_float(
                    data.get("duration_ms"),
                    POINTER_DURATION_MIN_MS,
                    POINTER_DURATION_MAX_MS,
                    900,
                )
            )
        ),
        "holdMs": int(
            round(
                _clamp_float(
                    data.get("hold_ms"),
                    POINTER_HOLD_MIN_MS,
                    POINTER_HOLD_MAX_MS,
                    1500,
                )
            )
        ),
        "reason": reason[:POINTER_MAX_REASON],
        "say": say[:POINTER_MAX_SAY],
    }


def _pointer_region(nx: float, ny: float) -> str:
    """把 0~1 的归一化落点说成聊天里能懂的方位。"""
    horizontal = "左侧" if nx < 0.34 else "右侧" if nx > 0.66 else "中间"
    vertical = "上方" if ny < 0.34 else "下方" if ny > 0.66 else "中间"
    if horizontal == "中间" and vertical == "中间":
        return "正中间"
    if horizontal == "中间":
        return "中间偏上" if vertical == "上方" else "中间偏下"
    if vertical == "中间":
        return f"{horizontal}偏中"
    return f"{horizontal}{vertical}"


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

    def __init__(
        self,
        self_id: str,
        bridge: "DesktopPetBridge",
        turn: str | None = None,
    ) -> None:
        self.self_id = self_id
        self.bridge = bridge
        self.turn = turn

    async def send_private_msg(self, **kwargs: object) -> dict:
        try:
            message = kwargs.get("message")
            await self.bridge._capture_onebot_message(message, "desktop", self.turn)
        except Exception:
            logger.exception("[desktoppet] 记录桌面回复失败")
        return {"message_id": 0}

    async def send_group_msg(self, **_kwargs: object) -> dict:
        return {"message_id": 0}

    async def send(self, **kwargs: object) -> dict:
        try:
            message = kwargs.get("message")
            await self.bridge._capture_onebot_message(message, "desktop", self.turn)
        except Exception:
            logger.exception("[desktoppet] 记录桌面回复失败")
        return {"message_id": 0}

    async def call_action(self, action: str, **kwargs: object) -> dict:
        if action in ("send_private_msg", "send_msg"):
            try:
                message = kwargs.get("message")
                await self.bridge._capture_onebot_message(
                    message, "desktop", self.turn
                )
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
        self.pointer_hint = str(
            self.config.get("pointer_hint") or POINTER_HINT_DEFAULT
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
        self._capture_count = 0
        self._last_capture_ts = 0
        self._capture_note = "未开始"
        self._mood_config: dict = {}
        self._affection_k: float | None = None
        # 撤回：turn -> {event, entry_id, text, umo, created, retracted}
        self._turns: dict[str, dict] = {}
        # 已经撤回的回合；用来判断迟到的回复要不要丢。
        self._retracted_turns: dict[str, float] = {}
        # 发送还没到、撤回先到的回合；下一次 /send 直接吃掉。
        self._pending_retract: dict[str, float] = {}
        # 最近几条指针闲聊：给下一轮观察和聊天模型当上下文，不写进会话历史。
        self._pointer_recent: list[tuple[float, str]] = []
        # 最近一次指针动作的落点：聊天时让她知道自己刚才停在哪。
        self._pointer_last: dict | None = None

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
            f"/{PLUGIN_NAME}/retract",
            self._api_retract,
            ["POST"],
            "桌面聊天桥接：撤回刚发出的桌面消息并中止生成",
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
        self.context.register_web_api(
            f"/{PLUGIN_NAME}/pointer",
            self._api_pointer,
            ["POST"],
            "桌面聊天桥接：希罗指针观察，让模型决定下一步动作",
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
        logger.info("[desktoppet] 发送捕获循环已启动")
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
            "turn": _normalize_turn(item.get("turn")) or None,
            "quote": _normalize_quote(item.get("quote")),
            "pointer": bool(item.get("pointer")),
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
        turn: str | None = None,
        quote: dict | None = None,
        pointer: bool = False,
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
                "turn": turn or None,
                "quote": quote,
                "pointer": bool(pointer),
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

    # ------------------------------------------------------------------ 撤回
    def _prune_turns(self) -> None:
        now = time.time()
        stale = [
            turn
            for turn, info in self._turns.items()
            if now - float(info.get("created") or 0) > TURN_TTL_SECONDS
        ]
        for turn in stale:
            self._turns.pop(turn, None)
        for turn, ts in list(self._retracted_turns.items()):
            if now - ts > TURN_TTL_SECONDS:
                self._retracted_turns.pop(turn, None)
        for turn, ts in list(self._pending_retract.items()):
            if now - ts > PENDING_RETRACT_TTL_SECONDS:
                self._pending_retract.pop(turn, None)

    def _is_turn_retracted(self, turn: str) -> bool:
        self._prune_turns()
        return turn in self._retracted_turns

    def _register_turn(
        self,
        turn: str,
        event: object,
        entry_id: int | None,
        text: str,
        inject_text: str,
    ) -> None:
        self._prune_turns()
        self._turns[turn] = {
            "event": event,
            "entry_id": entry_id,
            "text": text,
            "inject_text": inject_text,
            "umo": self.umo,
            "created": time.time(),
            "retracted": False,
            "llm_started": False,
        }

    def _turn_has_reply(self, turn: str) -> bool:
        return any(
            entry.get("turn") == turn and entry.get("role") == "assistant"
            for entry in self._entries
        )

    async def _remove_turn_entries(self, turn: str) -> list[int]:
        """删掉这一轮的 user 条目和已捕获的回复，返回删掉的 id。"""
        async with self._lock:
            removed = [
                entry for entry in self._entries if entry.get("turn") == turn
            ]
            if not removed:
                return []
            keep = [entry for entry in self._entries if entry.get("turn") != turn]
            self._entries = keep
            try:
                await asyncio.to_thread(self._rewrite_log)
                await asyncio.to_thread(self._cleanup_media)
            except Exception:
                logger.exception("[desktoppet] 撤回后重写日志失败")
            return [int(entry["id"]) for entry in removed]

    def _conversation_manager(self):
        return getattr(self.context, "conversation_manager", None)

    @staticmethod
    def _history_message_text(item: dict) -> str:
        """会话历史里的 content 可能是字符串，也可能是 [{type:text,text:...}]。"""
        content = item.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for part in content:
                if isinstance(part, dict) and isinstance(part.get("text"), str):
                    parts.append(part["text"])
            return "\n".join(parts)
        return ""

    async def _trim_retracted_history(
        self,
        turn: str,
        user_text: str,
        timeout_seconds: float = 30.0,
    ) -> bool:
        """把刚写进 AstrBot 会话历史的那一对删掉。

        中止生成后 core 仍会保存「user + Stop output. + Output stopped.」，
        而这两条要等收尾的那次模型调用结束才落盘（可能十几秒）。所以这里在后台
        轮询，等它写完再从尾部移除；只动最近 30 条，避免误删更早的对话。
        """
        manager = self._conversation_manager()
        if manager is None or not user_text:
            return False
        deadline = time.time() + timeout_seconds
        target = _clean(user_text)
        while time.time() < deadline:
            try:
                conversation_id = await manager.get_curr_conversation_id(self.umo)
                if not conversation_id:
                    return False
                conversation = await manager.get_conversation(self.umo, conversation_id)
                history = list(getattr(conversation, "content", None) or [])
            except Exception:
                logger.exception("[desktoppet] 撤回：读取会话历史失败")
                return False

            index = -1
            for cursor in range(len(history) - 1, max(-1, len(history) - 31), -1):
                item = history[cursor]
                if not isinstance(item, dict):
                    continue
                if item.get("role") != "user":
                    continue
                raw = self._history_message_text(item)
                # 每条 user 消息后面会追加 <system_reminder> 时间片。
                text = raw.split("<system_reminder>")[0].strip()
                if text == target:
                    index = cursor
                    break
            if index < 0:
                # 还没写入（或已经不在历史里）：再等等。
                await asyncio.sleep(0.25)
                continue

            # 删掉这条 user，以及 AstrBot 中止时补的 “Stop output.” / “Output stopped.”
            # 和紧随其后的半截回复。
            end = index + 1
            if end < len(history) and isinstance(history[end], dict):
                next_item = history[end]
                if next_item.get("role") == "user":
                    next_text = self._history_message_text(next_item)
                    next_text = next_text.split("<system_reminder>")[0].strip()
                    if next_text in ("Stop output.", "Stop output"):
                        end += 1
            while end < len(history):
                item = history[end]
                if not isinstance(item, dict) or item.get("role") != "assistant":
                    break
                end += 1
            if end < len(history):
                # 后面已经有新的一轮（用户又说话了）：不动历史，宁可这一条留着，
                # 也不能用旧快照覆盖掉新回合。
                logger.warning(
                    "[desktoppet] 撤回：历史尾部已有新消息，跳过裁剪 turn=%s",
                    turn,
                )
                return False
            trimmed = history[:index]
            try:
                await manager.update_conversation(
                    self.umo,
                    conversation_id,
                    history=trimmed,
                )
            except Exception:
                logger.exception("[desktoppet] 撤回：写回会话历史失败")
                return False
            logger.info(
                "[desktoppet] 撤回：已从会话历史移除 turn=%s（%d 条）",
                turn,
                len(history) - len(trimmed),
            )
            return True
        logger.warning("[desktoppet] 撤回：等待会话历史写入超时 turn=%s", turn)
        return False

    # ------------------------------------------------------------------ 平台与 QQ 状态
    def _adapter(self):
        try:
            return self.context.get_platform_inst(self.platform_id)
        except Exception:
            logger.exception("[desktoppet] 获取平台实例失败")
            return None

    def _get_plugin(self, name: str):
        """安全获取其他插件实例；启动早期 / 被禁用时返回 None。"""
        try:
            star = self.context.get_registered_star(name)
            return getattr(star, "star_cls", None) if star else None
        except Exception:
            return None

    def _sleep_state(self) -> dict:
        plugin = self._get_plugin("astrbot_plugin_hiro_sleep")
        if plugin is None:
            return {"available": False, "sleeping": False, "status": ""}
        try:
            status = plugin.get_status(self.umo) or {}
            return {
                "available": True,
                "sleeping": bool(plugin.is_sleeping(self.umo)),
                "status": str(status.get("status") or ""),
                "sleepAt": str(status.get("sleep_at") or ""),
                "wakeAt": str(status.get("wake_at") or ""),
            }
        except Exception:
            logger.warning("[desktoppet] 读取睡眠状态失败", exc_info=True)
            return {"available": False, "sleeping": False, "status": ""}

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
    def _ensure_capture(self) -> bool:
        """确保 bot.send_private_msg 上挂着我们的记录包装。

        用「包装函数对象是否仍是当前方法」来判断，而不是只看 owner 标记：
        插件重载、平台重连、别的插件二次包装都可能让标记还在、包装却已经失效。
        """
        adapter = self._adapter()
        bot = getattr(adapter, "bot", None) if adapter is not None else None
        if bot is None:
            self._capture_note = "等待平台适配器"
            return False

        # 注意：aiocqhttp 的 CQHttp.__getattr__ 会给任何未知属性返回一个
        # functools.partial，getattr 永远拿不到 None。我们自己的标记必须走
        # __dict__，否则会被误判成“已经装过包装”。
        state = getattr(bot, "__dict__", {})
        wrapper = state.get("_desktoppet_send_wrapper")
        current = getattr(bot, "send_private_msg", None)
        if current is None:
            self._capture_note = "bot 缺少 send_private_msg"
            return False
        if wrapper is not None and current is wrapper:
            # 包装还在，只需要把记录目标指向当前实例（插件重载时会换实例）。
            bot._desktoppet_capture_owner = self
            self._capture_note = "已安装"
            return True

        original = current

        async def wrapped(*args: object, **kwargs: object) -> object:
            result = await original(*args, **kwargs)
            try:
                owner = getattr(bot, "__dict__", {}).get("_desktoppet_capture_owner")
                if owner is not None:
                    await owner._capture_bot_send(kwargs)
            except Exception:
                logger.exception("[desktoppet] 记录 QQ 回复失败")
            return result

        try:
            bot.send_private_msg = wrapped
            bot._desktoppet_send_wrapper = wrapped
            bot._desktoppet_original_send_private = original
            bot._desktoppet_capture_owner = self
            self._capture_note = "已安装"
            logger.info(
                "[desktoppet] 已安装发送层捕获 bot=%s replaced=%s",
                type(bot).__name__,
                getattr(original, "__qualname__", repr(original)),
            )
            return True
        except Exception:
            self._capture_note = "安装失败"
            logger.exception("[desktoppet] 无法安装发送层捕获")
            return False

    def _capture_state(self) -> dict:
        adapter = self._adapter()
        bot = getattr(adapter, "bot", None) if adapter is not None else None
        state = getattr(bot, "__dict__", {}) if bot is not None else {}
        wrapper = state.get("_desktoppet_send_wrapper")
        return {
            "wrapped": bool(bot)
            and wrapper is not None
            and getattr(bot, "send_private_msg", None) is wrapper,
            "task": self._capture_task is not None and not self._capture_task.done(),
            "captured": self._capture_count,
            "lastCaptureAt": self._last_capture_ts,
            "note": self._capture_note,
        }

    def _restore_capture(self) -> None:
        adapter = self._adapter()
        bot = getattr(adapter, "bot", None) if adapter is not None else None
        if bot is None:
            return
        try:
            if (
                getattr(bot, "__dict__", {}).get("_desktoppet_capture_owner")
                is not self
            ):
                # 已经有新实例接管，别把它的包装拆掉。
                return
            state = getattr(bot, "__dict__", {})
            wrapper = state.get("_desktoppet_send_wrapper")
            original = state.get("_desktoppet_original_send_private")
            if (
                wrapper is not None
                and original is not None
                and getattr(bot, "send_private_msg", None) is wrapper
            ):
                bot.send_private_msg = original
            for attr in (
                "_desktoppet_capture_owner",
                "_desktoppet_send_wrapper",
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
        if user_id is None:
            user_id = kwargs.get("target_id")
        if user_id is not None and str(user_id) != str(self.user_id):
            return
        message = kwargs.get("message")
        if isinstance(message, str):
            # 有些插件直接把 plain text 交给 send_private_msg。
            text = _clean(message)
            if text:
                entry = await self._append("assistant", text, "qq")
                if entry:
                    self._mark_captured()
            return
        if hasattr(message, "chain"):
            message = getattr(message, "chain")
        if isinstance(message, dict):
            message = [message]
        if isinstance(message, (list, tuple)):
            entry = await self._capture_onebot_message(list(message), "qq")
            if entry:
                self._mark_captured()

    def _mark_captured(self) -> None:
        self._capture_count += 1
        self._last_capture_ts = int(time.time() * 1000)

    async def _capture_onebot_message(
        self,
        message: object,
        origin: str,
        turn: str | None = None,
    ) -> dict | None:
        # 已经撤回的回合：她的半截回复直接丢弃，不进日志、不进桌面。
        if turn and self._is_turn_retracted(turn):
            return None
        if isinstance(message, dict):
            message = [message]
        if not isinstance(message, list):
            return None
        texts: list[str] = []
        attachments: list[dict] = []
        for segment in message:
            if not isinstance(segment, dict):
                # 也接受 AstrBot MessageChain 里的组件对象。
                text = _component_text(segment)
                if text:
                    texts.append(text)
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
        return await self._append("assistant", text, origin, attachments, turn=turn)

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
            if role == "user" and text.lstrip().startswith(COMMENTARY_MARKER):
                # 屏幕点评的触发消息只保留在上下文里，不返回给桌面聊天。
                continue
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

    async def _pointer_context(self) -> str:
        """最近几轮对话的纯文本摘要，让指针动作接得上上下文。"""
        try:
            rows = await self._history(POINTER_HISTORY_LIMIT, include_images=False)
        except Exception:
            rows = []
        lines: list[str] = []
        for row in rows:
            who = "希罗" if row.get("role") == "assistant" else "他"
            text = str(row.get("text") or "").replace("\n", " ").strip()
            if not text:
                continue
            if len(text) > POINTER_HISTORY_CHARS:
                text = text[:POINTER_HISTORY_CHARS] + "…"
            lines.append(f"{who}: {text}")
        if not lines:
            return ""
        return "〔你们最近的对话〕\n" + "\n".join(lines) + "\n"

    # ------------------------------------------------------------------ 发送
    async def _inject(
        self,
        text: str,
        image_data: str | None = None,
        commentary: bool = False,
        turn: str | None = None,
        entry_id: int | None = None,
        log_text: str = "",
        pointer: bool = False,
    ) -> dict | None:
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
            bot=_DesktopBot(self.self_id, self, turn),
        )
        # 桌面端通过 API Key 鉴权，注入事件按管理员处理，
        # 这样 /心情、/好感、/记忆 等管理员指令可以直接用。
        event.role = "admin"
        event.set_extra("_desktoppet_origin", "desktop")
        event.set_extra("_desktoppet_logged", True)
        if turn:
            # 撤回时靠这个 id 找到事件并中止生成。
            event.set_extra("_desktoppet_turn", turn)
        if commentary:
            # 点评不是对话回合：mood 1.5+ 看到 appraisal 标记会整轮跳过；
            # 同时带上 affection 标记，兼容只认这个键的旧版 mood。
            event.set_extra("mood_skip_appraisal", True)
            event.set_extra("mood_skip_affection", True)
            event.set_extra("mood_skip_all", True)
        if image_data:
            event.set_extra("_desktoppet_has_screen", True)
        if pointer:
            # 希罗指针开着：让模型知道它能自己操控第二指针。
            event.set_extra("_desktoppet_pointer", True)
        # 先把回合登记好再提交：管线可能在 commit 之后立刻跑到 on_llm_request，
        # 晚一步登记就会漏掉 llm_started，撤回时不知道要不要裁历史。
        if turn:
            self._register_turn(turn, event, entry_id, log_text or text, text)
        adapter.commit_event(event)
        return {"queued": True, "event": event}

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
                "capture": self._capture_state(),
                "capabilities": CAPABILITIES,
            },
        }

    async def _api_pointer(self):
        """希罗指针观察：给模型一张压缩截图，让它决定要不要动、动到哪。

        这是一次轻量直连调用，不写聊天历史、不进长期记忆、不触发心情；
        模型不可用或输出不合法时一律返回「不动」。
        """
        try:
            payload = await web_request.json(default={})
        except Exception:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}

        image = payload.get("image")
        data = ""
        if isinstance(image, dict):
            raw = image.get("data")
            if isinstance(raw, str):
                data = raw.strip()
        if not data:
            return {"status": "error", "message": "缺少屏幕截图。"}
        if len(data) > MAX_IMAGE_BASE64:
            return {"status": "error", "message": "截图太大了。"}
        try:
            base64.b64decode(data, validate=True)
        except Exception:
            return {"status": "error", "message": "截图格式不正确。"}

        snippet = payload.get("hint")
        hint = ""
        if isinstance(snippet, str):
            hint = snippet.strip()[:POINTER_MAX_HINT]

        # 睡着时不动：不截图分析，也不让指针乱跑。
        if self._sleep_state().get("sleeping"):
            return {"status": "ok", "data": {"action": None, "sleeping": True}}

        # 同一时刻只跑一轮，避免定时器和「立即观察」叠在一起烧 token。
        if getattr(self, "_pointer_busy", False):
            return {"status": "ok", "data": {"action": None, "busy": True}}
        self._pointer_busy = True
        try:
            return await self._run_pointer(data, hint)
        finally:
            self._pointer_busy = False

    async def _run_pointer(self, data: str, hint: str = "") -> dict:
        provider = None
        try:
            provider = await self.context.get_using_provider_async(self.umo)
        except Exception:
            logger.exception("[desktoppet] 获取对话模型失败")
        if provider is None:
            return {"status": "error", "message": "没有可用的对话模型。"}

        persona = ""
        try:
            personality = await self.context.persona_manager.get_default_persona_v3(
                self.umo
            )
            persona = str(getattr(personality, "prompt", "") or "").strip()
        except Exception:
            logger.exception("[desktoppet] 读取人格失败")

        system_prompt = POINTER_SYSTEM_PROMPT.format(
            persona=persona or "你是希罗。",
            marker=POINTER_MARKER,
        )
        # 真实交互插件：她自己维护的指针 SKILL + 最近几次落点。
        interaction = self._get_plugin("astrbot_plugin_hiro_interaction")
        skill_text = ""
        if interaction is not None:
            try:
                skill_text = await interaction.build_pointer_context(self.umo)
            except Exception:
                logger.warning("[desktoppet] 读取指针 SKILL 失败", exc_info=True)
        context_text = await self._pointer_context()
        parts: list[str] = []
        if skill_text:
            parts.append(skill_text)
        if self._pointer_recent:
            tail = [text for _, text in self._pointer_recent[-3:]]
            parts.append(
                "〔你刚才陪他时说过〕\n"
                + "\n".join(f"- {text}" for text in tail)
                + "\n"
            )
        if context_text:
            parts.append(context_text)
        if hint:
            parts.append(f"〔他刚刚在聊天里对你说〕\n{hint}\n")
        parts.append(
            "〔当前屏幕〕\n"
            "这是他现在屏幕上的画面。按上面的格式，只输出一个 JSON 对象："
            "先决定你的第二指针下一步要做什么，想动就再附一句对他说的话；"
            "不想动就返回 {\"act\":\"none\"}。"
        )
        user_prompt = "".join(parts)

        started = time.time()
        try:
            response = await provider.text_chat(
                prompt=user_prompt,
                image_urls=[f"data:image/jpeg;base64,{data}"],
                system_prompt=system_prompt,
                request_max_retries=1,
            )
        except Exception:
            logger.exception("[desktoppet] 指针观察调用失败")
            return {"status": "error", "message": "模型调用失败。"}

        text = str(getattr(response, "completion_text", "") or "")
        action = _parse_pointer_action(text)
        elapsed = int((time.time() - started) * 1000)
        say = ""
        if action is None:
            logger.info("[desktoppet] 指针观察：不动 %sms", elapsed)
        else:
            say = str(action.get("say") or "").strip()
            steps = action.get("steps") or []
            logger.info(
                "[desktoppet] 指针观察：移动 %sms x=%.3f y=%.3f steps=%s duration=%s hold=%s say=%s reason=%s",
                elapsed,
                action["nx"],
                action["ny"],
                len(steps),
                action["durationMs"],
                action["holdMs"],
                say,
                action["reason"],
            )
            if say:
                # 指针动作的闲聊只进桌面聊天日志，不写 AstrBot 会话历史：
                # 既让她在聊天里出声，又不会把挂机时的几百句话塞进共享上下文。
                try:
                    await self._append("assistant", say, "pointer", pointer=True)
                except Exception:
                    logger.exception("[desktoppet] 写入指针闲聊失败")
                self._pointer_recent.append((time.time(), say))
                if len(self._pointer_recent) > 12:
                    self._pointer_recent = self._pointer_recent[-12:]
            self._pointer_last = {
                "nx": action["nx"],
                "ny": action["ny"],
                "steps": len(steps),
                "say": say,
                "ts": time.time(),
            }
            # 真实交互：把这次动作记进她的经验账本；累计够了会在后台复盘。
            if interaction is not None:
                try:
                    await interaction.record_pointer_episode(
                        self.umo,
                        hint=hint,
                        steps=steps
                        or [{"nx": action["nx"], "ny": action["ny"]}],
                        say=say,
                        reason=action["reason"],
                        duration_ms=action["durationMs"],
                        hold_ms=action["holdMs"],
                    )
                except Exception:
                    logger.warning("[desktoppet] 记录指针动作失败", exc_info=True)
        return {"status": "ok", "data": {"action": action, "say": say}}

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
        commentary = payload.get("commentary") is True
        pointer = payload.get("pointerEnabled") is True
        turn = "" if commentary else _normalize_turn(payload.get("clientId"))
        quote = None if commentary else _normalize_quote(payload.get("quote"))
        if commentary:
            sleep_state = self._sleep_state()
            if sleep_state.get("sleeping"):
                # 睡着时不注入点评回合、不保存截图，避免数消息 / 吵醒 / 影响心情。
                return {
                    "status": "ok",
                    "data": {
                        "message": None,
                        "commentary": True,
                        "sleeping": True,
                        "reply": "zzZ",
                        "capabilities": CAPABILITIES,
                    },
                }

        # 撤回比 /send 先到：这条消息不再注入，直接告诉桌面已撤回。
        if turn and (self._is_turn_retracted(turn) or turn in self._pending_retract):
            self._pending_retract.pop(turn, None)
            self._retracted_turns[turn] = time.time()
            return {
                "status": "ok",
                "data": {
                    "message": None,
                    "commentary": commentary,
                    "retracted": True,
                    "capabilities": CAPABILITIES,
                },
            }

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
                if commentary:
                    # 点评截图只给模型看，不占桌面的媒体库。
                    image_data = data
                else:
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

        inject_text = (
            f"{COMMENTARY_MARKER}{text}"
            if commentary
            else (f"{_quote_prefix(quote)}{text}" if quote else text)
        )
        entry = None
        if not commentary:
            attachments = [image_attachment] if image_attachment else []
            entry = await self._append(
                "user",
                text,
                "desktop",
                attachments,
                turn=turn or None,
                quote=quote,
            )
        # 写日志和注入之间再确认一次：撤回可能刚好在这几毫秒里到达。
        if turn and turn in self._pending_retract:
            self._pending_retract.pop(turn, None)
            self._retracted_turns[turn] = time.time()
            if entry and entry.get("id"):
                await self._remove_turn_entries(turn)
            return {
                "status": "ok",
                "data": {
                    "message": None,
                    "commentary": commentary,
                    "retracted": True,
                    "capabilities": CAPABILITIES,
                },
            }
        try:
            await self._inject(
                inject_text,
                image_data,
                commentary=commentary,
                turn=turn or None,
                entry_id=int(entry["id"]) if entry and entry.get("id") else None,
                log_text=text,
                pointer=pointer,
            )
        except Exception:
            logger.exception("[desktoppet] 注入消息失败")
            return {"status": "error", "message": "注入消息失败。"}
        return {
            "status": "ok",
            "data": {
                "message": entry,
                "commentary": commentary,
                "capabilities": CAPABILITIES,
            },
        }

    async def _api_retract(self):
        """撤回一轮桌面消息：中止生成、删日志、裁会话历史。"""
        try:
            payload = await web_request.json(default={})
        except Exception:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        turn = _normalize_turn(payload.get("clientId"))
        if not turn:
            return {"status": "error", "message": "回合 id 不正确。"}

        self._prune_turns()
        info = self._turns.get(turn)
        if info is None:
            # /send 还没到：先记下来，等它到达时直接丢掉，不再注入。
            self._pending_retract[turn] = time.time()
            return {"status": "ok", "data": {"turn": turn, "removed": []}}

        if info.get("retracted"):
            return {"status": "ok", "data": {"turn": turn, "removed": []}}
        if self._turn_has_reply(turn):
            return {"status": "error", "message": "这条消息已经发出，无法撤回。"}

        info["retracted"] = True
        self._retracted_turns[turn] = time.time()
        logger.info(
            "[desktoppet] 撤回开始 turn=%s llm_started=%s",
            turn,
            bool(info.get("llm_started")),
        )

        event = info.get("event")
        if event is not None:
            try:
                # 中止正在跑的 Agent；同时让 mood / sleep / life 整轮跳过。
                event.set_extra("_desktoppet_retracted", True)
                event.set_extra("agent_stop_requested", True)
                event.set_extra("mood_skip_appraisal", True)
                event.set_extra("mood_skip_affection", True)
                event.set_extra("mood_skip_all", True)
            except Exception:
                logger.exception("[desktoppet] 撤回：设置中止标记失败")
        try:
            active_event_registry.request_agent_stop_all(self.umo)
        except Exception:
            logger.exception("[desktoppet] 撤回：请求中止生成失败")

        removed = await self._remove_turn_entries(turn)

        # 只有已经进到模型请求的回合才会写会话历史；没开始就不用管。
        # 收尾落盘可能比用户等待更久，放到后台裁，不阻塞撤回响应。
        inject_text = str(info.get("inject_text") or info.get("text") or "")
        pending_history = bool(info.get("llm_started")) and bool(inject_text)
        self._turns.pop(turn, None)
        if pending_history:
            asyncio.create_task(
                self._trim_retracted_history(turn, inject_text),
                name=f"desktoppet-trim-{turn}",
            )
        logger.info(
            "[desktoppet] 撤回完成 turn=%s removed=%s historyPending=%s",
            turn,
            removed,
            pending_history,
        )
        return {
            "status": "ok",
            "data": {
                "turn": turn,
                "removed": removed,
                "historyPending": pending_history,
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
                "capabilities": CAPABILITIES,
                "logLimit": self.max_log,
            },
        }

    async def _api_status(self):
        data = await asyncio.to_thread(self._read_status_sync)
        sleep_state = self._sleep_state()
        data["sleep"] = sleep_state
        data["sleeping"] = bool(sleep_state.get("sleeping"))
        data["sleepStatus"] = str(sleep_state.get("status") or "")
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
                    "permission": "admin" if item["name"].startswith(("/心情", "/好感", "/记忆", "/交互")) else "everyone",
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
            self._restore_wake_prefix_text(event)
            self._ensure_capture()
            if event.get_extra("_desktoppet_logged"):
                return
            event.set_extra("_desktoppet_logged", True)
            await self._capture_event_user(event)
        except Exception:
            logger.exception("[desktoppet] 记录用户消息失败")

    def _restore_wake_prefix_text(self, event: AstrMessageEvent) -> None:
        """把被 AstrBot 唤醒词截掉的前缀补回来。

        私聊本来不需要唤醒词，但 AstrBot 的 WakingCheckStage 只要看到消息以
        wake_prefix 开头就会把它从 message_str 里删掉。例如配置了「希罗」
        时，「希罗酱，在吗」会变成「酱，在吗」，模型和会话历史都只看到后半句。
        消息组件里仍是原文，所以这里按组件重建一次 message_str。
        """
        try:
            components = event.get_messages()
        except Exception:
            components = getattr(event.message_obj, "message", []) or []
        texts: list[str] = []
        for comp in components:
            if type(comp).__name__ == "Plain":
                texts.append(getattr(comp, "text", "") or "")
        original = "".join(texts).strip()
        if not original:
            return
        current = (event.message_str or "").strip()
        if original == current or not original.endswith(current):
            return
        event.message_str = original
        try:
            if getattr(event, "message_obj", None) is not None:
                event.message_obj.message_str = original
        except Exception:
            pass
        logger.info(
            "[desktoppet] 已恢复唤醒词截断：%r -> %r",
            current[:24],
            original[:24],
        )

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

            turn = event.get_extra("_desktoppet_turn")
            if isinstance(turn, str) and turn:
                if self._is_turn_retracted(turn) or event.get_extra(
                    "_desktoppet_retracted"
                ):
                    # 已经撤回：不调用模型，也不写会话历史。
                    # call_event_hook 只看 event.is_stopped()，返回值不算数。
                    event.set_extra("mood_skip_appraisal", True)
                    event.set_extra("mood_skip_affection", True)
                    event.set_extra("mood_skip_all", True)
                    event.stop_event()
                    return
                info = self._turns.get(turn)
                if info is not None:
                    info["llm_started"] = True

            # 回复即将发出，先把发送层捕获准备好。
            self._ensure_capture()

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

            # 希罗指针开着：告诉模型她拥有第二指针的操控权。
            if (
                event.get_extra("_desktoppet_pointer")
                and not event.get_extra("_desktoppet_pointer_hint_added")
                and self.pointer_hint
            ):
                event.set_extra("_desktoppet_pointer_hint_added", True)
                parts = getattr(req, "extra_user_content_parts", None)
                if isinstance(parts, list):
                    hint = self.pointer_hint
                    if self._pointer_last:
                        last = self._pointer_last
                        region = _pointer_region(
                            float(last.get("nx") or 0.5),
                            float(last.get("ny") or 0.5),
                        )
                        hint = f"{hint}\n〔你刚才把第二指针停在了画面{region}〕"
                    if self._pointer_recent:
                        tail = "；".join(
                            text for _, text in self._pointer_recent[-3:]
                        )
                        hint = f"{hint}\n〔你刚才陪他时说过〕{tail}"
                    parts.append(TextPart(text=hint).mark_as_temp())

            if event.get_extra("_desktoppet_logged"):
                return
            event.set_extra("_desktoppet_logged", True)
            await self._capture_event_user(event)
        except Exception:
            logger.exception("[desktoppet] 记录用户消息失败")

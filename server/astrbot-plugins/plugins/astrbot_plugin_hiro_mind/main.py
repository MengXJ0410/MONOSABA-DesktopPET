"""astrbot_plugin_hiro_mind — 读心

把「模型在写出回复之前，实际生成的那段思考」留下来，供管理员查看。

背景（2026-11-17 复核）：
模型每轮确实会产出 reasoning_content，AstrBot 也会把它拼进最终 response，
并作为 think 段写进当轮历史。但 plugin-immersion 会在下一次请求前把历史里
的 think 剥掉，而 AstrBot 保存历史时用的是「剥过的那份」再追加新回复——
所以数据库里永远只剩最后一轮的 think（线上 184 条 assistant 消息只看得到
1 条，是这个原因），更早的思考已经查不回来了。

由此，本插件不依赖历史，而是在当场留一份副本：

1. on_llm_response 把（他说了什么 / 她回了什么 / 那段草稿）存进环形缓冲；
2. 额外包一层 ProviderOpenAIOfficial._query_stream 兜底：万一某个网关/
   版本没把 reasoning 回填到最终 completion，就从流式 chunk 累积，
   挂到 _hiro_mind_reasoning 上（不写回 reasoning_content，避免污染历史）；
3. /读心 [X] 打印最近 X 轮，默认 3、上限 32；/读心 清空 清掉记录。

注意：草稿是模型的工作语言，可能是英文、第三人称、带「应该怎么回」的
指令口吻，不是希罗的内心独白。它不保证完整，也可能与实际回复不完全一致。
它只用来回答一个问题：她回之前，把你说的话理解成了什么。
"""

from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.provider import LLMResponse
from astrbot.api.star import Context, Star, register
from astrbot.core.utils.astrbot_path import get_astrbot_plugin_data_path

try:
    from astrbot.core.provider.sources.openai_source import ProviderOpenAIOfficial
except Exception:  # pragma: no cover - 核心结构变化时安全降级
    ProviderOpenAIOfficial = None  # type: ignore[assignment]

PLUGIN_NAME = "astrbot_plugin_hiro_mind"
DEFAULT_TZ = "Asia/Shanghai"
REASONING_ATTR = "_hiro_mind_reasoning"
PATCHED_FLAG = "_hiro_mind_patched"
MAX_MSG_CHARS = 900


def _clip(text, limit: int) -> str:
    value = str(text or "").strip()
    if len(value) <= limit:
        return value
    return value[: limit - 1] + "…"


def _chunk_text(text: str, limit: int = MAX_MSG_CHARS) -> list[str]:
    """按换行优先切成不超长的消息段。"""
    if len(text) <= limit:
        return [text]
    parts: list[str] = []
    rest = text
    while len(rest) > limit:
        cut = rest.rfind("\n", 0, limit)
        if cut < limit // 2:
            cut = limit
        parts.append(rest[:cut])
        rest = rest[cut:].lstrip("\n")
    if rest:
        parts.append(rest)
    return parts


def _patch_query_stream() -> bool:
    """让流式响应把 reasoning_content 带回最终 response。"""
    if ProviderOpenAIOfficial is None:
        logger.warning("[mind] 找不到 openai_source，读心补丁跳过")
        return False
    if getattr(ProviderOpenAIOfficial, PATCHED_FLAG, False):
        return True

    original = ProviderOpenAIOfficial._query_stream

    async def patched(self, payloads, tools, **kwargs):
        acc = ""
        async for resp in original(self, payloads, tools, **kwargs):
            try:
                is_chunk = bool(getattr(resp, "is_chunk", False))
                if is_chunk:
                    piece = getattr(resp, "reasoning_content", None)
                    if piece:
                        piece = str(piece)
                        # 少数服务端每个 chunk 回的是累计值而不是增量
                        if acc and piece.startswith(acc):
                            acc = piece
                        else:
                            acc += piece
                elif acc and not getattr(resp, "reasoning_content", None):
                    try:
                        setattr(resp, REASONING_ATTR, acc)
                    except Exception:  # noqa: BLE001
                        pass
            except Exception:  # noqa: BLE001
                pass
            yield resp

    patched.__name__ = getattr(original, "__name__", "_query_stream")
    ProviderOpenAIOfficial._query_stream = patched
    setattr(ProviderOpenAIOfficial, PATCHED_FLAG, True)
    return True


@register(
    PLUGIN_NAME,
    "MXJ",
    "读心：查看模型回复前的真实思考，用来排查误解",
    "0.2.0",
)
class MindPlugin(Star):
    def __init__(self, context: Context, config=None):
        super().__init__(context)
        self.config = config or {}
        self.enabled = self._bool("enabled", True)
        self.capture = self._bool("capture_reasoning", True)
        self.default_count = max(1, self._int("default_count", 3))
        self.max_count = max(1, self._int("max_count", 32))
        self.max_entries = max(self.max_count, self._int("max_entries", 64))
        self.tz = ZoneInfo(str(self.config.get("timezone") or DEFAULT_TZ))

        self.root = Path(get_astrbot_plugin_data_path()) / PLUGIN_NAME
        self.state_path = self.root / "mind.json"
        self.sessions = self._load_state()

        ok = _patch_query_stream() if (self.enabled and self.capture) else False
        logger.info(
            "[mind] 已加载：捕获=%s（补丁%s），会话 %d 个，查看默认 %d 轮 / 上限 %d 轮",
            self.capture,
            "已生效" if ok else "未生效",
            len(self.sessions),
            self.default_count,
            self.max_count,
        )

    # ------------------------------------------------------------------ 配置
    def _bool(self, key: str, default: bool) -> bool:
        value = self.config.get(key, default)
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)

    def _int(self, key: str, default: int) -> int:
        try:
            return int(self.config.get(key) or default)
        except (TypeError, ValueError):
            return default

    # ------------------------------------------------------------------ 存储
    def _load_state(self) -> dict:
        try:
            raw = json.loads(self.state_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except Exception as e:  # noqa: BLE001
            logger.warning("[mind] 读取记录失败：%s", e)
            return {}
        sessions = raw.get("sessions") if isinstance(raw, dict) else None
        if not isinstance(sessions, dict):
            return {}
        return sessions

    def _save_state(self) -> None:
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            payload = json.dumps(
                {"version": 1, "sessions": self.sessions},
                ensure_ascii=False,
            )
            tmp = self.state_path.with_suffix(".json.tmp")
            tmp.write_text(payload, encoding="utf-8")
            os.replace(tmp, self.state_path)
        except Exception as e:  # noqa: BLE001
            logger.warning("[mind] 写入记录失败：%s", e)

    def _append(self, umo: str, entry: dict) -> None:
        items = self.sessions.get(umo)
        if not isinstance(items, list):
            items = []
        items.append(entry)
        if len(items) > self.max_entries:
            items = items[-self.max_entries :]
        self.sessions[umo] = items
        self._save_state()

    # ------------------------------------------------------------------ 抓取
    @filter.on_llm_response()
    async def on_llm_response(self, event: AstrMessageEvent, resp: LLMResponse) -> None:
        if not self.enabled:
            return
        try:
            umo = event.unified_msg_origin
            if not umo:
                return
            reasoning = (
                getattr(resp, REASONING_ATTR, None)
                or getattr(resp, "reasoning_content", None)
                or ""
            )
            reply = (getattr(resp, "completion_text", "") or "").strip()
            user = (event.message_str or "").strip()
            if not reply and not reasoning:
                return
            if reasoning:
                logger.info("[mind] 捕获本轮思考 %d 字", len(reasoning))
            else:
                logger.info("[mind] 本轮没有思考内容（模型没产出或网关没回填）")
            self._append(
                umo,
                {
                    "t": datetime.now(self.tz).timestamp(),
                    "u": _clip(user, 600),
                    "a": _clip(reply, 600),
                    "r": _clip(reasoning, 6000),
                },
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("[mind] 记录失败：%s", e)

    # ------------------------------------------------------------------ 指令
    @filter.command("读心", alias={"/读心"})
    async def mind_command(self, event: AstrMessageEvent):
        if not event.is_admin():
            yield event.plain_result("这个只有管理员能看。")
            return

        umo = event.unified_msg_origin or ""
        if "GroupMessage" in umo:
            yield event.plain_result("读心只能在私聊里用。")
            return

        args = [a for a in (event.message_str or "").split()[1:] if a]
        head = args[0] if args else ""

        if head in ("清空", "clear"):
            self.sessions.pop(umo, None)
            self._save_state()
            yield event.plain_result("记录已清空。")
            return

        count = self.default_count
        if head:
            if not head.isdigit():
                yield event.plain_result(
                    f"用法：/读心 查看最近 {self.default_count} 轮；"
                    f"/读心 N 指定轮数（上限 {self.max_count}）；/读心 清空 清掉记录。"
                )
                return
            count = int(head)
            if count <= 0:
                yield event.plain_result(f"轮数要大于 0，最多 {self.max_count}。")
                return
            if count > self.max_count:
                count = self.max_count

        items = self.sessions.get(umo) or []
        if not items:
            yield event.plain_result(
                "还没有记录。装好之后聊一轮再来，我只能看到装上之后的对话。"
            )
            return

        picked = list(reversed(items))[:count]
        total = len(picked)
        yield event.plain_result(f"【后台草稿 · 最近 {total} 轮】")
        await asyncio.sleep(0.2)

        for i, entry in enumerate(picked, 1):
            block = self._entry_text(i, total, entry)
            # 一轮尽量一条消息发完，超长才按换行切开
            for piece in _chunk_text(block):
                yield event.plain_result(piece)
                await asyncio.sleep(0.3)

    def _entry_text(self, idx: int, total: int, entry: dict) -> str:
        try:
            stamp = datetime.fromtimestamp(
                float(entry.get("t") or 0), self.tz
            ).strftime("%m-%d %H:%M")
        except Exception:  # noqa: BLE001
            stamp = ""
        # 轮数多时收窄每轮展示量，避免一次刷几十条长消息
        if total <= 8:
            user_limit, draft_limit, reply_limit = 300, 1600, 200
        else:
            user_limit, draft_limit, reply_limit = 200, 800, 120
        lines = [f"[{idx}/{total}] {stamp}".rstrip()]
        user = str(entry.get("u") or "").strip()
        if user:
            lines.append("你：" + _clip(user, user_limit))
        reasoning = str(entry.get("r") or "").strip()
        if reasoning:
            lines.append("草稿：" + _clip(reasoning, draft_limit))
        else:
            lines.append("草稿：（这轮模型没返回思考内容）")
        reply = str(entry.get("a") or "").strip()
        if reply:
            lines.append("她：" + _clip(reply, reply_limit))
        return "\n".join(lines)

    async def terminate(self) -> None:
        self._save_state()

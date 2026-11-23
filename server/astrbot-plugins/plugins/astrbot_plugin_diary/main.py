"""希罗酱の日记 —— 单文件「日记本」模式的定时日记插件。

设计要点：
- 所有日记追加到同一本 `日记本.md`，模拟真实日记本；文件永不删除，超过阈值自动分卷。
- 不依赖 `computer_use_runtime`，文件由插件自己写，模型只负责生成正文。
- 聊天素材只取目标 UMO（默认主人的私聊）当天的记录。
- 定时任务用 `context.cron_manager.add_basic_job(persistent=False)`，
  每次插件初始化时重新注册，避免重启后 handler 丢失。
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, MessageChain, filter
from astrbot.api.message_components import Plain
from astrbot.api.star import Context, Star, register
from astrbot.core.utils.astrbot_path import (
    get_astrbot_plugin_data_path,
    get_astrbot_workspaces_path,
)

try:  # 4.29 起才有，缺失时退回本地实现
    from astrbot.core.workspace import normalize_umo_for_workspace
except Exception:  # pragma: no cover
    normalize_umo_for_workspace = None

PLUGIN_NAME = "astrbot_plugin_diary"
JOB_DAILY = "diary_daily"
JOB_CATCHUP = "diary_catchup"
JOB_SHARE = "diary_share"
JOB_YEARLY = "diary_yearly"

DEFAULT_UMO = "Hiro:FriendMessage:195*****76"
DEFAULT_CRON = "30 23 * * *"
DEFAULT_CATCHUP_CRON = "5 0 * * *"
DEFAULT_SHARE_CRON = "30 23 * * *"
DEFAULT_TZ = "Asia/Shanghai"
DEFAULT_ALIAS = "他"
DEFAULT_CHAT_TITLE = "和他的聊天"
DEFAULT_BOOK_FILE = "日记本.md"
DEFAULT_PREFIX = "这是今天的「希罗酱の日记」，想给你看一下"

LLM_TIMEOUT_SECONDS = 240
PROVIDER_WAIT_SECONDS = 120
MAX_CONVERSATIONS = 5
TAIL_BYTES = 65536
BOOK_SEPARATOR = "\n---\n\n"

PERIODS = ("上午", "下午", "晚上")
DEFAULT_TWO_ENTRY_MAX = 16000
DEFAULT_MAX_DAILY = 24000
DEFAULT_SEGMENT_MAX = 4
DEFAULT_LIFE_MAX = 60
DEFAULT_CHAT_MAX = 300
DEFAULT_THOUGHT_MAX = 200
DEFAULT_NO_CHAT_LIFE_MIN = 200
DEFAULT_NO_CHAT_LIFE_MAX = 500
DEFAULT_NO_CHAT_RECALL_DAYS = 14
DEFAULT_NO_CHAT_RECALL_LIMIT = 8

SHARE_STATE_FILE = "share_state.json"
SHARE_RETRY_WORKER_INTERVAL = 60  # 秒
SHARE_DONE_KEEP_DAYS = 30
DEFAULT_SHARE_RETRY_INTERVAL = 5
DEFAULT_SHARE_RETRY_MAX_HOURS = 24

WEEKDAYS = ("星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日")

# 用户消息里会附带 <system_reminder>Current datetime: 2026-11-02 22:53 (CST)...</system_reminder>
_DATETIME_RE = re.compile(r"Current datetime:\s*(\d{4}-\d{2}-\d{2})")
_DATETIME_FULL_RE = re.compile(
    r"Current datetime:\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})?"
)
_REMINDER_RE = re.compile(r"<system_reminder>.*?</system_reminder>", re.S)
_CODE_FENCE_RE = re.compile(r"^```[a-zA-Z]*\s*|\s*```$")
_LEADING_DATE_RE = re.compile(r"^\s*#*\s*\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日[^\n]*\n+")
_DATE_ARG_RE = re.compile(r"(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})")

DIARY_SYSTEM_PROMPT = """你现在要写一篇日记。这是只给自己看的私密记录，不是聊天。

【格式要求，优先于人格设定里的对话格式限制】
- 写日记时允许使用 Markdown 二级标题。
- 不要发表情包，不要 @ 任何人，不要调用任何工具，不要使用『伪证』格式。
- 只输出日记正文：不要前言，不要解释，不要问句，不要写日期标题。{kaomoji_rule}{piece_rule}

【正文结构】
## 我的生活
{life_rule}

## {chat_title}
用第一人称总结今天和{alias}聊了什么。
一般 30 到 300 个字；如果今天聊的内容确实很多，可以继续写到最多 1200 个字，
插件会按 300 字左右自动分段，不要为了凑字数而写。
称呼对方为「{alias}」，不要用「主人」「您」之类的称呼。
如果今天没有聊天记录，整个部分都不要写，也不要提到「今天没聊天」。{segment_thought_rule}
{thought_block}"""

LIFE_RULE_CHAT = """写 1 到 2 件今天真实发生的小事：吃了什么、做了什么、和艾玛一起做了什么。
控制在 20 到 60 个字，允许少量超出，但不要超过 80 个字。
只记事，不抒情，不要写「今天很安静」这类空话。"""

LIFE_RULE_NO_CHAT = """今天没有聊天记录。写 2 到 3 个今天真实发生的小场景：和艾玛的日常、做饭、整理、散步等。
可以自然回忆 1 到 2 件最近和他有关的事，但不要编造他今天做了什么。
控制在 200 到 500 个字，不要超过 500 个字。
不要写「今天没聊天」，不要写成流水账。"""

LIFE_RULE_EVENTS_CHAT = """只从下面「今天真实发生的事」里选 1 到 2 件写；噩梦只是可选素材，不必每篇都写。
不要新编，不要添加没发生过的细节。
控制在 20 到 60 个字，允许少量超出，但不要超过 80 个字。
只记事，不抒情，不要写「今天很安静」这类空话。"""

LIFE_RULE_EVENTS_NO_CHAT = """只从下面「今天真实发生的事」里选 2 到 3 件写；噩梦只是可选素材，不必每篇都写。
不要新编，不要添加没发生过的细节。
可以写你的感受和细节，但不要改变事实。
控制在 200 到 500 个字，不要超过 500 个字。
不要写「今天没聊天」，不要写成流水账。"""

SEGMENT_THOUGHT_RULE = """
如果聊天分成多段，用 `### 片段 i/N` 分段；每段结尾可以自然写一句自己的想法，
用普通括号（）包起来，最多 200 字，不计入这段 300 字。不是每段都必须写；
有情绪、有反差、有具体细节才写。整篇心里话仍然写在全文最后一段。"""

KAOMOJI_RULE = (
    "\n- 可以自然地用颜文字表达情绪，比如开心 (≧◡≦)、无奈 (-_-;)、"
    "害羞 (*/ω＼*)、发呆 ( ๑ • ̯ • ๑ )；一篇里用 1 到 2 个就够，"
    "不要每句都加，也不要用 emoji。"
)
NO_KAOMOJI_RULE = "\n- 不要使用颜文字或 emoji。"

THOUGHT_BLOCK = """
最后空一行，另起一段，写 1 到 3 句只有自己知道的心里话：今天真实的心情、后悔或得意的小事、想说又没说出口的话。
控制在 20 到 200 个字，口语一点，可以带一点情绪。
整段必须用中文全角括号（）包起来，例如：（今天其实有点累，但不想让他看出来。）
这一段是日记的最后一段，不要加小标题，不要写「心里想的」「心里话」之类的字样，也不要用「——」开头。
不要总结今天，不要复述前面写过的事，不要写成给别人看的句子。"""


def _as_int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_bool(value, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    if value is None:
        return default
    return bool(value)


def _safe_workspace_name(umo: str) -> str:
    if normalize_umo_for_workspace is not None:
        try:
            return normalize_umo_for_workspace(umo)
        except Exception:  # noqa: BLE001
            pass
    return re.sub(r"[^A-Za-z0-9._-]", "_", umo)


def _safe_filename(name: str, fallback: str) -> str:
    name = (name or "").strip().strip("/\\")
    if not name or ".." in Path(name).parts:
        return fallback
    return name


def _split_message(text: str, limit: int) -> list[str]:
    """按段落切分长消息，尽量不把一句话拆断。"""
    if limit <= 0:
        return [text]
    chunks: list[str] = []
    buf = ""
    for line in text.splitlines(keepends=True):
        if len(line) > limit:  # 超长单行，硬切
            if buf:
                chunks.append(buf)
                buf = ""
            for i in range(0, len(line), limit):
                chunks.append(line[i : i + limit])
            continue
        if len(buf) + len(line) > limit:
            chunks.append(buf)
            buf = line
        else:
            buf += line
    if buf:
        chunks.append(buf)
    return chunks or [text]


@register("astrbot_plugin_diary", "MXJ", "单文件日记本：定时写希罗日记并可选分享", "0.4.8")
class DiaryPlugin(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)
        self.config = config or {}

        self.umo = str(self.config.get("umo") or DEFAULT_UMO).strip()
        self.cron_expression = str(self.config.get("cron_expression") or DEFAULT_CRON).strip()
        self.catchup_cron = str(self.config.get("catchup_cron") or DEFAULT_CATCHUP_CRON).strip()
        self.share_cron = str(self.config.get("share_cron") or DEFAULT_SHARE_CRON).strip()
        self.share_umo = str(self.config.get("share_umo") or "").strip() or self.umo
        self.persona_id = str(self.config.get("persona_id") or "").strip()
        self.provider_id = str(self.config.get("provider_id") or "").strip()
        self.extra_instruction = str(self.config.get("extra_instruction") or "").strip()
        # 年度总结：每年 1 月 1 日写一篇，上限 1 万字
        self.yearly_summary_enabled = _as_bool(
            self.config.get("yearly_summary_enabled"), True
        )
        self.yearly_summary_cron = str(
            self.config.get("yearly_summary_cron") or "0 10 1 1 *"
        ).strip()
        self.yearly_summary_max_chars = max(
            1000, int(self.config.get("yearly_summary_max_chars") or 10000)
        )
        self.user_alias = str(self.config.get("user_alias") or DEFAULT_ALIAS).strip() or DEFAULT_ALIAS
        self.chat_section_title = (
            str(self.config.get("chat_section_title") or DEFAULT_CHAT_TITLE).strip()
            or DEFAULT_CHAT_TITLE
        )
        self.kaomoji_enabled = _as_bool(self.config.get("kaomoji_enabled"), True)
        self.thought_enabled = _as_bool(self.config.get("thought_enabled"), True)
        self.notify_prefix = str(self.config.get("notify_prefix") or DEFAULT_PREFIX).strip()

        self.overwrite = False  # 追加模式，保留字段避免旧配置报错
        self.notify = _as_bool(self.config.get("notify"), True)
        self.share_enabled = _as_bool(self.config.get("share_enabled"), False)
        self.share_retry_enabled = _as_bool(
            self.config.get("share_retry_enabled"), True
        )
        self.share_retry_interval = max(
            1,
            _as_int(
                self.config.get("share_retry_interval_minutes"),
                DEFAULT_SHARE_RETRY_INTERVAL,
            ),
        )
        self.share_retry_max_hours = max(
            1,
            _as_int(
                self.config.get("share_retry_max_hours"),
                DEFAULT_SHARE_RETRY_MAX_HOURS,
            ),
        )
        self.instant_trigger = _as_bool(self.config.get("instant_trigger"), False)
        self.life_events_enabled = _as_bool(
            self.config.get("life_events_enabled"), True
        )
        self.life_events_dir = str(self.config.get("life_events_dir") or "").strip()
        self.life_events_max = max(
            1, _as_int(self.config.get("life_events_max"), 8)
        )
        self.max_context_chars = _as_int(self.config.get("max_context_chars"), 8000)
        self.max_message_chars = _as_int(self.config.get("max_message_chars"), 1000)
        self.two_entry_max_chars = max(
            self.max_context_chars,
            _as_int(self.config.get("two_entry_max_chars"), DEFAULT_TWO_ENTRY_MAX),
        )
        self.max_daily_chars = max(
            self.two_entry_max_chars,
            _as_int(self.config.get("max_daily_chars"), DEFAULT_MAX_DAILY),
        )
        self.segment_max = max(1, _as_int(self.config.get("segment_max"), DEFAULT_SEGMENT_MAX))
        self.life_min = _as_int(self.config.get("life_min_chars"), 20)
        self.life_max = max(self.life_min, _as_int(self.config.get("life_max_chars"), DEFAULT_LIFE_MAX))
        self.chat_min = _as_int(self.config.get("chat_min_chars"), 30)
        self.chat_max = max(self.chat_min, _as_int(self.config.get("chat_max_chars"), DEFAULT_CHAT_MAX))
        self.thought_min = _as_int(self.config.get("thought_min_chars"), 20)
        self.thought_max = max(
            self.thought_min,
            _as_int(self.config.get("thought_max_chars"), DEFAULT_THOUGHT_MAX),
        )
        self.segment_thought_enabled = _as_bool(
            self.config.get("segment_thought_enabled"), True
        )
        self.no_chat_life_min = max(
            1,
            _as_int(
                self.config.get("no_chat_life_min_chars"),
                DEFAULT_NO_CHAT_LIFE_MIN,
            ),
        )
        self.no_chat_life_max = max(
            self.no_chat_life_min,
            _as_int(
                self.config.get("no_chat_life_max_chars"),
                DEFAULT_NO_CHAT_LIFE_MAX,
            ),
        )
        self.no_chat_recall_days = max(
            0,
            _as_int(
                self.config.get("no_chat_recall_days"),
                DEFAULT_NO_CHAT_RECALL_DAYS,
            ),
        )
        self.no_chat_recall_limit = max(
            0,
            _as_int(
                self.config.get("no_chat_recall_limit"),
                DEFAULT_NO_CHAT_RECALL_LIMIT,
            ),
        )
        self.catchup_days = _as_int(self.config.get("catchup_days"), 0)
        self.book_max_mb = max(1, _as_int(self.config.get("book_max_mb"), 500))

        self.diary_dir = _safe_filename(self.config.get("diary_dir") or "diary", "diary")
        self.book_file = _safe_filename(
            self.config.get("book_file") or DEFAULT_BOOK_FILE, DEFAULT_BOOK_FILE
        )

        tz_name = str(self.config.get("timezone") or DEFAULT_TZ).strip()
        try:
            self.tz = ZoneInfo(tz_name)
        except Exception:  # noqa: BLE001
            logger.warning("[diary] invalid timezone %r, fallback to %s", tz_name, DEFAULT_TZ)
            self.tz = ZoneInfo(DEFAULT_TZ)

        self._lock = asyncio.Lock()
        self._state_path = Path(get_astrbot_plugin_data_path()) / PLUGIN_NAME / "state.json"
        self._share_state_path = (
            Path(get_astrbot_plugin_data_path()) / PLUGIN_NAME / SHARE_STATE_FILE
        )
        self._share_lock = asyncio.Lock()
        self._share_retry_task: asyncio.Task | None = None

    # ------------------------------------------------------------------ 生命周期

    async def initialize(self) -> None:
        manager = getattr(self.context, "cron_manager", None)
        if manager is None:
            logger.error("[diary] cron_manager 不可用，日记功能不会定时运行")
            return

        await self._remove_jobs(manager)

        try:
            if self.share_enabled:
                # 开启分享时，写入与发送合并到分享任务，避免同一天写两篇
                await manager.add_basic_job(
                    name=JOB_SHARE,
                    cron_expression=self.share_cron,
                    handler=self._job_share,
                    description="写当天日记并分享到目标会话",
                    timezone=str(self.tz),
                    persistent=False,
                )
                logger.info(
                    "[diary] 已注册 %s：cron=%r → %s（写入+分享）",
                    JOB_SHARE,
                    self.share_cron,
                    self.share_umo,
                )
            else:
                await manager.add_basic_job(
                    name=JOB_DAILY,
                    cron_expression=self.cron_expression,
                    handler=self._job_daily,
                    description="每天生成希罗日记",
                    timezone=str(self.tz),
                    persistent=False,
                )
                logger.info(
                    "[diary] 已注册 %s：cron=%r tz=%s umo=%s",
                    JOB_DAILY,
                    self.cron_expression,
                    self.tz,
                    self.umo,
                )
        except Exception as e:  # noqa: BLE001
            logger.error("[diary] 注册写入任务失败：%s", e)

        if self.catchup_days > 0:
            try:
                await manager.add_basic_job(
                    name=JOB_CATCHUP,
                    cron_expression=self.catchup_cron,
                    handler=self._job_catchup,
                    description=f"补写最近 {self.catchup_days} 天缺失的日记",
                    timezone=str(self.tz),
                    persistent=False,
                )
                logger.info("[diary] 已注册 %s：cron=%r", JOB_CATCHUP, self.catchup_cron)
            except Exception as e:  # noqa: BLE001
                logger.error("[diary] 注册补写任务失败：%s", e)

        if self.yearly_summary_enabled:
            try:
                await manager.add_basic_job(
                    name=JOB_YEARLY,
                    cron_expression=self.yearly_summary_cron,
                    handler=self._job_yearly_summary,
                    description="每年 1 月 1 日写一篇上一年的年度总结",
                    timezone=str(self.tz),
                    persistent=False,
                )
                logger.info(
                    "[diary] 已注册 %s：cron=%r", JOB_YEARLY, self.yearly_summary_cron
                )
            except Exception as e:  # noqa: BLE001
                logger.error("[diary] 注册年度总结任务失败：%s", e)

        await self._maybe_trigger_instant()

        if self.share_retry_enabled and self.share_enabled:
            self._share_retry_task = asyncio.create_task(self._share_retry_loop())
            logger.info(
                "[diary] 分享重试已启用：每 %d 分钟重试，最多 %d 小时",
                self.share_retry_interval,
                self.share_retry_max_hours,
            )

    async def terminate(self) -> None:
        if self._share_retry_task and not self._share_retry_task.done():
            self._share_retry_task.cancel()
        manager = getattr(self.context, "cron_manager", None)
        if manager is not None:
            await self._remove_jobs(manager)

    async def _remove_jobs(self, manager) -> None:
        try:
            jobs = await manager.list_jobs(job_type="basic")
        except Exception as e:  # noqa: BLE001
            logger.warning("[diary] 读取任务列表失败：%s", e)
            return
        for job in jobs:
            if getattr(job, "name", "") in {JOB_DAILY, JOB_CATCHUP, JOB_SHARE, JOB_YEARLY}:
                try:
                    await manager.delete_job(job.job_id)
                    logger.info("[diary] 已清理旧任务 %s(%s)", job.name, job.job_id)
                except Exception as e:  # noqa: BLE001
                    logger.warning("[diary] 删除旧任务 %s 失败：%s", job.name, e)

    # ------------------------------------------------------------------ 定时入口

    def _sleep_plugin(self):
        try:
            star = self.context.get_registered_star(
                "astrbot_plugin_hiro_sleep"
            )
            return getattr(star, "star_cls", None) if star else None
        except Exception:  # noqa: BLE001
            return None

    def _is_night_rest(self) -> bool:
        """睡眠插件是否在夜间休息；读不到就当作没睡。"""
        plugin = self._sleep_plugin()
        fn = getattr(plugin, "is_night_rest", None)
        if not callable(fn):
            return False
        try:
            return bool(fn(self.umo))
        except Exception as e:  # noqa: BLE001
            logger.debug("[diary] 读取睡眠状态失败：%s", e)
            return False

    def _is_sleeping(self) -> bool:
        plugin = self._sleep_plugin()
        fn = getattr(plugin, "is_sleeping", None)
        if not callable(fn):
            return False
        try:
            return bool(fn(self.umo))
        except Exception as e:  # noqa: BLE001
            logger.debug("[diary] 读取入睡状态失败：%s", e)
            return False

    def _is_cold_war(self) -> bool:
        """心情插件是否处于冷战；冷战时暂停主动分享。"""
        try:
            star = self.context.get_registered_star(
                "astrbot_plugin_hiro_mood"
            )
            plugin = getattr(star, "star_cls", None) if star else None
            fn = getattr(plugin, "is_cold_war", None)
            if callable(fn):
                return bool(fn(self.umo))
        except Exception as e:  # noqa: BLE001
            logger.debug("[diary] 读取冷战状态失败：%s", e)
        return False

    async def _job_daily(self, **_kwargs) -> None:
        today = datetime.now(self.tz).date()
        night = self._is_night_rest()
        # 分享开启时由 _job_share 统一发送，避免同一篇日记先通知再分享。
        send_notify = self.notify and not night and not self.share_enabled
        if night and self.notify:
            logger.info("[diary] 夜间休息，日记只写不发")
        ok, info = await self._ensure_daily_entry(today, send=send_notify)
        if not ok:
            logger.info("[diary] 每日任务跳过：%s", info)
        await self._maybe_yearly_catchup(today)

    async def _job_share(self, **_kwargs) -> None:
        if not self.share_enabled:
            return
        today = datetime.now(self.tz).date()
        if self._is_cold_war():
            logger.info("[diary] 冷战中，暂停日记分享")
            return
        if self._is_night_rest():
            ok, info = await self._ensure_daily_entry(
                today, send=False, share=False
            )
            if ok:
                logger.info("[diary] 夜间休息，日记只写不发，等起床补发")
            else:
                logger.warning("[diary] 夜间写日记失败：%s", info)
            return
        ok, info = await self._ensure_daily_entry(today, send=True, share=True)
        if ok:
            logger.info(
                "[diary] 分享任务 %s：%s → %s",
                today.isoformat(),
                info,
                self.share_umo,
            )
        else:
            logger.warning("[diary] 分享失败：%s", info)

    async def _job_catchup(self, **_kwargs) -> None:
        if self.catchup_days <= 0:
            return
        night = self._is_night_rest()
        if night:
            logger.info("[diary] 夜间休息，补写只写不发")
        today = datetime.now(self.tz).date()
        for offset in range(1, self.catchup_days + 1):
            target = today - timedelta(days=offset)
            if self._has_daily_entry(self._date_header(target)):
                # 旧格式一天一篇：已经写好，只在还没分享成功时补发。
                if (
                    self.share_enabled
                    and not night
                    and not self._share_done(target)
                ):
                    entry = self._read_entry(self._date_header(target)) or ""
                    if entry:
                        await self._share_entry(entry, target)
                continue
            logger.info("[diary] 补写 %s", target.isoformat())
            ok, info = await self._ensure_daily_entry(target, send=False)
            if not ok:
                logger.info("[diary] 补写 %s 失败：%s", target.isoformat(), info)
                await asyncio.sleep(5)
                continue
            if (
                self.share_enabled
                and not night
                and not self._share_done(target)
            ):
                entry = await self._read_target_entry(target)
                if entry:
                    await self._share_entry(entry, target)
            await asyncio.sleep(5)

    # ------------------------------------------------------------------ 年度总结

    @staticmethod
    def _yearly_header(year: int) -> str:
        return f"{year}年 · 年度总结"

    def _book_text(self) -> str:
        try:
            path = self._book_path()
            if path.exists():
                return path.read_text(encoding="utf-8", errors="replace")
        except Exception as e:  # noqa: BLE001
            logger.warning("[diary] 读取日记本失败：%s", e)
        return ""

    def _year_entries(self, text: str, year: int) -> list[str]:
        prefix = f"{year}年"
        out: list[str] = []
        for block in text.split(BOOK_SEPARATOR):
            block = block.strip()
            if block.startswith(prefix):
                out.append(block)
        return out

    async def _job_yearly_summary(self, **_kwargs) -> None:
        if not self.yearly_summary_enabled:
            return
        today = datetime.now(self.tz).date()
        target_year = today.year - 1
        header = self._yearly_header(target_year)
        if header in self._book_text():
            logger.info("[diary] %s 已存在，跳过", header)
            return
        ok, info = await self._generate_yearly_summary(target_year)
        if ok:
            logger.info("[diary] 年度总结 %d：%s", target_year, info)
        else:
            logger.warning("[diary] 年度总结 %d 失败：%s", target_year, info)

    async def _maybe_yearly_catchup(self, today: date) -> None:
        """1 月 1 日错过时，前 7 天补写上一年的总结。"""
        if not self.yearly_summary_enabled:
            return
        if today.month != 1 or today.day > 7:
            return
        target_year = today.year - 1
        header = self._yearly_header(target_year)
        if header in self._book_text():
            return
        ok, info = await self._generate_yearly_summary(target_year)
        if ok:
            logger.info("[diary] 年度总结补写 %d：%s", target_year, info)
        else:
            logger.info("[diary] 年度总结补写 %d 跳过：%s", target_year, info)

    async def _generate_yearly_summary(self, year: int) -> tuple[bool, str]:
        entries = self._year_entries(self._book_text(), year)
        if not entries:
            return False, f"{year} 年没有日记"
        provider = await self._wait_provider()
        if provider is None:
            return False, "没有可用的模型提供方"

        digest_parts: list[str] = []
        used = 0
        for block in entries:
            piece = block if len(block) <= 1200 else block[:1200] + "…"
            if used + len(piece) > 80000:
                break
            digest_parts.append(piece)
            used += len(piece)
        digest = "\n\n".join(digest_parts)

        persona_prompt = await self._persona_prompt()
        system_prompt = (
            f"{persona_prompt}\n\n"
            "现在你在写自己这一年的年度总结，写进日记本里。"
            "第一人称，以重大事件和心里的变化为主，不要逐日流水账，不要罗列日期，不要写成报告。"
            f"不超过 {self.yearly_summary_max_chars} 字。"
        )
        prompt = (
            f"下面是 {year} 年你自己的日记。请回头看这一年，写一篇年度总结。\n\n"
            f"===== {year} 年日记 =====\n{digest}\n===== 结束 ====="
        )
        try:
            text = await self._call_text_chat(provider, prompt, system_prompt)
        except Exception as e:  # noqa: BLE001
            return False, f"模型调用失败：{e}"
        body = (text or "").strip()
        if not body:
            return False, "模型返回了空内容"
        if len(body) > self.yearly_summary_max_chars:
            body = body[: self.yearly_summary_max_chars].rstrip() + "…"
        try:
            path = self._append_entry(self._yearly_header(year), body)
        except Exception as e:  # noqa: BLE001
            return False, f"写入失败：{e}"
        return True, f"已写入 {path}（{len(body)} 字）"

    # ------------------------------------------------------------------ 即时日记

    async def _maybe_trigger_instant(self) -> None:
        state = self._load_state()
        previous = bool(state.get("instant_trigger"))
        if self.instant_trigger and not previous:
            logger.info("[diary] 检测到「现在立刻写一则日记」开关被打开，开始写")
            asyncio.create_task(self._run_instant())
        state["instant_trigger"] = self.instant_trigger
        self._save_state(state)

    async def _run_instant(self) -> None:
        now = datetime.now(self.tz)
        try:
            ok, info = await self._ensure_instant_entry(now, send=True)
            if ok:
                logger.info("[diary] 即时日记完成：%s", info)
            else:
                logger.warning("[diary] 即时日记失败：%s", info)
        except Exception as e:  # noqa: BLE001
            logger.error("[diary] 即时日记异常：%s", e, exc_info=True)

    async def _ensure_instant_entry(self, now: datetime, *, send: bool) -> tuple[bool, str]:
        header = f"{self._date_header(now.date())} {now:%H:%M}"
        async with self._lock:
            body = await self._generate_body(now.date())
            if not body:
                return False, "模型返回了空内容"
            path = self._append_entry(header, body)
            entry = f"{header}\n\n{body}"
            logger.info("[diary] 已追加即时日记 %s → %s", header, path)
            if send:
                await self._notify(entry)
            return True, str(path)

    def _load_state(self) -> dict:
        try:
            return json.loads(self._state_path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return {}

    def _save_state(self, state: dict) -> None:
        try:
            self._state_path.parent.mkdir(parents=True, exist_ok=True)
            self._state_path.write_text(
                json.dumps(state, ensure_ascii=False), encoding="utf-8"
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("[diary] 写入状态文件失败：%s", e)

    # ------------------------------------------------------------------ 手动入口

    @filter.command("diary", alias={"/diary"})
    async def diary_command(self, event: AstrMessageEvent):
        """手动生成日记：/diary [YYYY-MM-DD]，仅管理员可用。"""
        if not event.is_admin():
            yield event.plain_result("只有主人能用这个指令。")
            return
        if event.unified_msg_origin != self.umo:
            yield event.plain_result("日记只对主私聊生效。")
            return

        target = datetime.now(self.tz).date()
        match = _DATE_ARG_RE.search(event.message_str or "")
        if match:
            try:
                target = date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
            except ValueError:
                yield event.plain_result("日期不合法，格式示例：/diary 2026-11-02")
                return

        if self._lock.locked():
            yield event.plain_result("正在写另一篇日记，稍等一下。")
            return

        yield event.plain_result(f"开始处理 {target.isoformat()} 的日记。")

        ok, info = await self._ensure_daily_entry(target, send=True)
        if not ok:
            yield event.plain_result(f"没写成：{info}")

    # ------------------------------------------------------------------ 日记本

    def _diary_root(self) -> Path:
        return Path(get_astrbot_workspaces_path()) / _safe_workspace_name(self.umo) / self.diary_dir

    def _book_path(self) -> Path:
        """当前应写入的日记本文件；超过阈值时自动切到下一卷。"""
        base = self._diary_root() / self.book_file
        limit = self.book_max_mb * 1024 * 1024
        if not base.exists() or base.stat().st_size < limit:
            return base

        stem, suffix = base.stem, base.suffix
        index = 2
        while True:
            candidate = base.with_name(f"{stem}-{index}{suffix}")
            if not candidate.exists() or candidate.stat().st_size < limit:
                return candidate
            index += 1

    @staticmethod
    def _date_header(target: date, label: str = "") -> str:
        base = f"{target.year}年{target.month:02d}月{target.day:02d}日"
        return f"{base} {label}".strip() if label else base

    def _tail_text(self, path: Path, size: int = TAIL_BYTES) -> str:
        try:
            with path.open("rb") as handle:
                handle.seek(0, 2)
                total = handle.tell()
                handle.seek(max(0, total - size))
                return handle.read().decode("utf-8", errors="ignore")
        except Exception as e:  # noqa: BLE001
            logger.warning("[diary] 读取日记本失败 %s：%s", path, e)
            return ""

    def _has_daily_entry(self, header: str) -> bool:
        path = self._book_path()
        if not path.exists():
            return False
        for line in self._tail_text(path).splitlines():
            if line.strip() == header:
                return True
        return False

    def _read_entry(self, header: str) -> str | None:
        path = self._book_path()
        if not path.exists():
            return None
        for chunk in reversed(self._tail_text(path).split(BOOK_SEPARATOR)):
            text = chunk.strip("\n")
            if not text:
                continue
            first_line = text.split("\n", 1)[0].strip()
            if first_line == header:
                return text.strip()
        return None

    def _append_entry(self, header: str, body: str) -> Path:
        path = self._book_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        prefix = BOOK_SEPARATOR if path.exists() and path.stat().st_size > 0 else ""
        entry = f"{header}\n\n{body.strip()}\n"
        with path.open("a", encoding="utf-8") as handle:
            handle.write(prefix + entry)
        self._relax_permissions(path)
        return path

    @staticmethod
    def _relax_permissions(path: Path) -> None:
        """让同机的网站容器（非 root）也能读写日记本。

        日记由容器里的 root 创建，默认 644；网站以 node 运行，只能读不能写。
        这里把目录放开到 777、文件放开到 666，网站才能做「编辑」并原子替换。
        """
        try:
            os.chmod(path.parent, 0o777)
            os.chmod(path, 0o666)
        except OSError as e:
            logger.warning("[diary] 调整日记本权限失败 %s：%s", path, e)

    # ------------------------------------------------------------------ 生成主流程

    def _read_day_entry(
        self, target: date, expected: list[tuple[str, str]]
    ) -> str:
        entries: list[str] = []
        for _label, header in expected:
            entry = self._read_entry(header)
            if entry:
                entries.append(entry)
        if entries:
            return BOOK_SEPARATOR.join(entries)
        base = self._read_entry(self._date_header(target))
        return base or ""

    async def _read_target_entry(self, target: date) -> str:
        messages = await self._load_day_messages(target)
        pieces = self._plan_pieces(messages, target)
        expected = [
            (label, self._date_header(target, label)) for label, _, _ in pieces
        ]
        return self._read_day_entry(target, expected)

    def _share_done(self, target: date) -> bool:
        state = self._load_share_state()
        status = (state.get("done") or {}).get(target.isoformat(), {}).get("status")
        return status in ("sent", "failed")

    async def _ensure_daily_entry(
        self, target: date, *, send: bool, share: bool = False,
        force_send: bool = False,
    ) -> tuple[bool, str]:
        async with self._lock:
            messages = await self._load_day_messages(target)
            pieces = self._plan_pieces(messages, target)
            expected = [
                (label, self._date_header(target, label)) for label, _, _ in pieces
            ]

            # 旧格式：只有日期标题，没有时间标签。视为已完成，不重写。
            base_header = self._date_header(target)
            if self._has_daily_entry(base_header):
                entry = self._read_entry(base_header)
                sent = True
                if entry and send:
                    sent = (
                        await self._share_entry(
                            entry, target, force=force_send
                        )
                        if share
                        else await self._notify(entry)
                    )
                return True, self._send_info("已存在（旧格式），跳过生成", sent, share)

            missing = [
                (label, header)
                for label, header in expected
                if not self._has_daily_entry(header)
            ]
            if not missing:
                sent = True
                if send:
                    entry = self._read_day_entry(target, expected)
                    sent = (
                        await self._share_entry(
                            entry, target, force=force_send
                        )
                        if share
                        else await self._notify(entry)
                    )
                return True, self._send_info("已存在，跳过生成", sent, share)

            provider = await self._wait_provider()
            if provider is None:
                return False, "没有可用的模型提供方"
            persona_prompt = await self._persona_prompt()

            generated: list[str] = []
            for label, header in missing:
                piece = next((p for p in pieces if p[0] == label), None)
                if piece is None:
                    continue
                _, piece_messages, preamble = piece
                body = await self._generate_piece(
                    provider,
                    target,
                    label,
                    piece_messages,
                    preamble,
                    persona_prompt,
                )
                if not body:
                    continue
                try:
                    path = self._append_entry(header, body)
                except Exception as e:  # noqa: BLE001
                    logger.error("[diary] 写入日记本失败：%s", e, exc_info=True)
                    return False, f"写入失败：{e}"
                generated.append(header)
                logger.info(
                    "[diary] 已追加 %s → %s（正文 %d 字）",
                    header,
                    path,
                    len(body),
                )

            if not generated:
                return False, "模型返回了空内容"

            sent = True
            if send:
                entry = self._read_day_entry(target, expected)
                sent = (
                    await self._share_entry(
                        entry, target, force=force_send
                    )
                    if share
                    else await self._notify(entry)
                )

            return True, self._send_info(f"写入 {len(generated)} 篇", sent, share)

    @staticmethod
    def _send_info(info: str, sent: bool, share: bool) -> str:
        if sent:
            return info
        if share:
            return f"{info}；发送失败，已加入重试队列"
        return f"{info}；发送失败"

    async def _notify(self, entry: str, umo: str | None = None) -> bool:
        target = umo or self.share_umo
        text = f"{self.notify_prefix}\n{entry}" if self.notify_prefix else entry
        for chunk in _split_message(text, self.max_message_chars):
            try:
                await self.context.send_message(target, MessageChain(chain=[Plain(chunk)]))
            except Exception as e:  # noqa: BLE001
                logger.error("[diary] 发送失败：%s", e)
                return False
            await asyncio.sleep(0.5)
        return True

    # ------------------------------------------------------------------ 分享重试
    def _load_share_state(self) -> dict:
        try:
            data = json.loads(self._share_state_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                data.setdefault("done", {})
                data.setdefault("outbox", [])
                return data
        except FileNotFoundError:
            pass
        except Exception as e:  # noqa: BLE001
            logger.warning("[diary] 读取分享状态失败：%s", e)
        return {"done": {}, "outbox": []}

    def _save_share_state(self, state: dict) -> None:
        try:
            self._share_state_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._share_state_path.with_suffix(".json.tmp")
            tmp.write_text(
                json.dumps(state, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            os.replace(tmp, self._share_state_path)
        except Exception as e:  # noqa: BLE001
            logger.warning("[diary] 写入分享状态失败：%s", e)

    def _prune_share_done(self, state: dict) -> None:
        cutoff = (
            datetime.now(self.tz).date() - timedelta(days=SHARE_DONE_KEEP_DAYS)
        ).isoformat()
        done = state.get("done") or {}
        state["done"] = {k: v for k, v in done.items() if k >= cutoff}

    def _mark_share_done(self, state: dict, day: date, status: str) -> None:
        state.setdefault("done", {})[day.isoformat()] = {
            "status": status,
            "at": datetime.now(self.tz).isoformat(timespec="seconds"),
        }
        self._prune_share_done(state)

    def _parse_share_time(self, value: str | None) -> datetime | None:
        if not value:
            return None
        try:
            dt = datetime.fromisoformat(value)
        except ValueError:
            return None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=self.tz)
        return dt.astimezone(self.tz)

    @staticmethod
    def _share_key(day: date, umo: str) -> str:
        return f"{day.isoformat()}|{umo}"

    def _share_text(self, entry: str) -> str:
        return f"{self.notify_prefix}\n{entry}" if self.notify_prefix else entry

    async def _share_try_send(
        self,
        item: dict,
        state: dict | None = None,
    ) -> bool:
        """发送 item 剩余的 chunks；每成功一段就落盘，重启可续。"""
        chunks = item.get("chunks") or []
        sent = int(item.get("sent") or 0)
        for idx in range(sent, len(chunks)):
            try:
                await self.context.send_message(
                    item.get("umo") or self.share_umo,
                    MessageChain(chain=[Plain(chunks[idx])]),
                )
            except Exception as e:  # noqa: BLE001
                item["attempts"] = int(item.get("attempts") or 0) + 1
                item["last_error"] = f"{type(e).__name__}: {e}"[:300]
                item["next_retry_at"] = (
                    datetime.now(self.tz)
                    + timedelta(minutes=self.share_retry_interval)
                ).isoformat(timespec="seconds")
                logger.warning(
                    "[diary] 分享发送失败（第 %d 次），%d 分钟后重试：%s",
                    item["attempts"],
                    self.share_retry_interval,
                    item["last_error"],
                )
                return False
            item["sent"] = idx + 1
            if state is not None:
                self._save_share_state(state)
            await asyncio.sleep(0.5)
        return True

    async def _share_entry(
        self,
        entry: str,
        day: date,
        umo: str | None = None,
        *,
        force: bool = False,
    ) -> bool:
        """分享入口：立即尝试，失败入队；由 worker 每 5 分钟重试。"""
        if self._is_cold_war():
            logger.info("[diary] 冷战中，分享延后：%s", day.isoformat())
            return False
        if force:
            if self._is_sleeping():
                logger.info(
                    "[diary] 已经睡着，分享延后到起床：%s", day.isoformat()
                )
                return False
        elif self._is_night_rest():
            logger.info(
                "[diary] 夜间休息，分享延后到起床：%s", day.isoformat()
            )
            return False
        if not self.share_retry_enabled:
            return await self._notify(entry, umo)
        target = umo or self.share_umo
        key = self._share_key(day, target)
        text = self._share_text(entry)
        async with self._share_lock:
            state = self._load_share_state()
            done = state.setdefault("done", {})
            status = (done.get(day.isoformat()) or {}).get("status")
            if status == "sent":
                return True
            if status == "failed":
                return True
            item = next(
                (i for i in state.setdefault("outbox", []) if i.get("key") == key),
                None,
            )
            if item is None:
                now = datetime.now(self.tz).isoformat(timespec="seconds")
                item = {
                    "key": key,
                    "date": day.isoformat(),
                    "umo": target,
                    "chunks": _split_message(text, self.max_message_chars),
                    "sent": 0,
                    "attempts": 0,
                    "created_at": now,
                    "next_retry_at": now,
                    "last_error": "",
                }
                state["outbox"].append(item)
            else:
                next_at = self._parse_share_time(item.get("next_retry_at"))
                if next_at is not None and next_at > datetime.now(self.tz):
                    # 已经在队列里且还没到重试时间，交给 worker，不在这里提前发。
                    return False
            ok = await self._share_try_send(item, state)
            if ok:
                self._mark_share_done(state, day, "sent")
                state["outbox"] = [
                    i for i in state.get("outbox", []) if i.get("key") != key
                ]
                logger.info("[diary] 分享发送成功：%s", key)
            else:
                logger.info(
                    "[diary] 分享已加入重试队列：%s（下次 %s）",
                    key,
                    item.get("next_retry_at"),
                )
            self._save_share_state(state)
            return ok

    def get_share_time(self) -> time | None:
        """从 share_cron 解析出每天的分享时间；复杂 cron 返回 None。"""
        fields = str(self.share_cron or "").split()
        if len(fields) < 2:
            return None
        try:
            minute = int(fields[0])
            hour = int(fields[1])
        except ValueError:
            return None
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            return None
        return time(hour, minute)

    async def share_for_date(self, day: date, *, force: bool = False) -> bool:
        """睡前主动分享指定日期的日记；已分享过则直接返回 True。"""
        if not self.share_enabled:
            return False
        if self._is_cold_war():
            return False
        if force:
            if self._is_sleeping():
                return False
        elif self._is_night_rest():
            return False
        ok, _info = await self._ensure_daily_entry(
            day, send=True, share=True, force_send=force
        )
        return bool(ok and self._share_done(day))

    async def share_pending(self) -> int:
        """起床后补发睡眠期间没发出去的日记，返回成功补发的天数。"""
        if not self.share_enabled or self._is_night_rest():
            return 0
        today = datetime.now(self.tz).date()
        lookback = max(1, min(3, self.catchup_days or 1))
        sent = 0
        for offset in range(1, lookback + 1):
            target = today - timedelta(days=offset)
            if self._share_done(target):
                continue
            entry = await self._read_target_entry(target)
            if not entry:
                entry = self._read_entry(self._date_header(target)) or ""
            if not entry:
                continue
            if await self._share_entry(entry, target):
                sent += 1
                logger.info(
                    "[diary] 起床后补发 %s 的日记", target.isoformat()
                )
            await asyncio.sleep(1)
        return sent

    async def _share_process_due(self) -> None:
        if not self.share_retry_enabled:
            return
        if self._is_night_rest():
            return
        async with self._share_lock:
            state = self._load_share_state()
            outbox = state.get("outbox") or []
            if not outbox:
                return
            now = datetime.now(self.tz)
            remaining: list[dict] = []
            changed = False
            for item in sorted(outbox, key=lambda i: i.get("created_at") or ""):
                try:
                    day = date.fromisoformat(str(item.get("date") or ""))
                except ValueError:
                    logger.warning("[diary] 分享队列日期异常，丢弃：%s", item.get("key"))
                    changed = True
                    continue
                created = self._parse_share_time(item.get("created_at"))
                if (
                    created is not None
                    and now - created > timedelta(hours=self.share_retry_max_hours)
                ):
                    self._mark_share_done(state, day, "failed")
                    logger.warning(
                        "[diary] 分享重试超过 %d 小时，停止重试：%s",
                        self.share_retry_max_hours,
                        item.get("key"),
                    )
                    changed = True
                    continue
                next_at = self._parse_share_time(item.get("next_retry_at"))
                if next_at is not None and next_at > now:
                    remaining.append(item)
                    continue
                ok = await self._share_try_send(item, state)
                if ok:
                    self._mark_share_done(state, day, "sent")
                    logger.info("[diary] 分享重试成功：%s", item.get("key"))
                    changed = True
                else:
                    remaining.append(item)
                    changed = True
            state["outbox"] = remaining
            if changed:
                self._save_share_state(state)

    async def _share_retry_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(SHARE_RETRY_WORKER_INTERVAL)
                await self._share_process_due()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                logger.warning("[diary] 分享重试 worker 异常：%s", e)

    # ------------------------------------------------------------------ 取素材

    async def _load_day_messages(self, target: date) -> list[tuple[str, str, str]]:
        cm = getattr(self.context, "conversation_manager", None)
        if cm is None:
            logger.warning("[diary] conversation_manager 不可用，按无聊天记录处理")
            return []

        start = int(datetime(target.year, target.month, target.day, tzinfo=self.tz).timestamp())
        end = start + 86400

        conversations = []
        try:
            conversations = await cm.get_conversations(self.umo)
        except Exception as e:  # noqa: BLE001
            logger.warning("[diary] 读取会话列表失败：%s", e)

        picked = [
            c
            for c in conversations
            if start <= _as_int(getattr(c, "updated_at", 0), 0) < end
        ]
        if not picked:
            # 时间戳异常时退回当前会话，至少不丢当天的尾部对话
            try:
                cid = await cm.get_curr_conversation_id(self.umo)
                if cid:
                    conv = await cm.get_conversation(self.umo, cid)
                    if conv is not None:
                        picked = [conv]
            except Exception as e:  # noqa: BLE001
                logger.warning("[diary] 读取当前会话失败：%s", e)

        picked.sort(key=lambda c: _as_int(getattr(c, "created_at", 0), 0))

        result: list[tuple[str, str, str]] = []
        for conv in picked[-MAX_CONVERSATIONS:]:
            try:
                history = json.loads(getattr(conv, "history", "[]") or "[]")
            except Exception as e:  # noqa: BLE001
                logger.warning("[diary] 解析历史失败：%s", e)
                continue
            for item in self._extract_day(history, target.isoformat()):
                if result and result[-1] == item:
                    continue
                result.append(item)
        return result

    @staticmethod
    def _extract_day(history: list, target_iso: str) -> list[tuple[str, str, str]]:
        """从会话历史里抽出某一天的消息。

        历史条目形如 {"role": "user", "content": [{"type": "text", "text": "..."}]}，
        日期和时间只存在于用户消息的 system_reminder 文本里，助手消息沿用上一条。
        返回 (说话人, 正文, HH:MM)。
        """
        out: list[tuple[str, str, str]] = []
        current_date: str | None = None
        current_time = "12:00"

        for msg in history or []:
            if not isinstance(msg, dict):
                continue
            role = msg.get("role")
            if role not in ("user", "assistant"):
                continue

            pieces: list[str] = []
            for part in msg.get("content") or []:
                if not isinstance(part, dict):
                    continue
                ptype = part.get("type")
                if ptype == "text":
                    pieces.append(str(part.get("text") or ""))
                elif ptype == "image":
                    pieces.append("[图片]")
                elif ptype == "file":
                    pieces.append("[文件]")
                elif ptype == "record":
                    pieces.append("[语音]")
                elif ptype == "video":
                    pieces.append("[视频]")
                elif ptype == "at":
                    pieces.append(f"@{part.get('name') or part.get('user_id') or ''}")

            joined = "".join(pieces)
            match = _DATETIME_FULL_RE.search(joined)
            if match:
                current_date = match.group(1)
                current_time = match.group(2) or "12:00"

            cleaned = _REMINDER_RE.sub("", joined).strip()
            if not cleaned or current_date != target_iso:
                continue

            out.append(("我" if role == "assistant" else "", cleaned, current_time))

        return out

    def _render_transcript(self, messages: list[tuple[str, str, str]], budget: int) -> str:
        lines = [
            f"{item[0] or self.user_alias}：{item[1]}" for item in messages
        ]
        if budget > 0:
            total = sum(len(line) + 1 for line in lines)
            while lines and total > budget:
                total -= len(lines[0]) + 1
                lines.pop(0)
        return "\n".join(lines)

    # ------------------------------------------------------------------ 模型

    def _resolve_provider(self):
        ctx = self.context
        if self.provider_id:
            getter = getattr(ctx, "get_provider_by_id", None)
            if callable(getter):
                try:
                    provider = getter(self.provider_id)
                    if provider is not None:
                        return provider
                except Exception as e:  # noqa: BLE001
                    logger.warning("[diary] 指定 provider %r 不可用：%s", self.provider_id, e)

        try:
            provider = ctx.get_using_provider(umo=self.umo)
        except TypeError:
            provider = ctx.get_using_provider()
        except Exception as e:  # noqa: BLE001
            logger.warning("[diary] 获取默认 provider 失败：%s", e)
            provider = None

        if provider is None:
            try:
                provider = ctx.get_using_provider()
            except Exception:  # noqa: BLE001
                provider = None
        return provider

    async def _persona_prompt(self) -> str:
        if not self.persona_id:
            return ""
        manager = getattr(self.context, "persona_manager", None)
        if manager is None:
            return ""
        try:
            persona = manager.get_persona_v3_by_id(self.persona_id)
            if persona:
                return str(persona.get("prompt") or "")
        except Exception as e:  # noqa: BLE001
            logger.warning("[diary] 读取人格 %r 失败：%s", self.persona_id, e)
        try:
            persona = await manager.get_persona(self.persona_id)
            return str(getattr(persona, "system_prompt", "") or "")
        except Exception as e:  # noqa: BLE001
            logger.warning("[diary] 人格 %r 不存在：%s", self.persona_id, e)
            return ""

    def _system_prompt(
        self,
        persona_prompt: str,
        piece_label: str = "",
        *,
        no_chat: bool = False,
        has_life_events: bool = False,
    ) -> str:
        thought_block = THOUGHT_BLOCK if self.thought_enabled else ""
        segment_thought_rule = (
            SEGMENT_THOUGHT_RULE
            if (self.segment_thought_enabled and self.thought_enabled)
            else ""
        )
        piece_rule = ""
        if piece_label:
            piece_rule = (
                f"\n这次只写【{piece_label}】这一段时间的日记，不要写其他时间段。"
            )
        if has_life_events:
            life_rule = (
                LIFE_RULE_EVENTS_NO_CHAT if no_chat else LIFE_RULE_EVENTS_CHAT
            )
        else:
            life_rule = LIFE_RULE_NO_CHAT if no_chat else LIFE_RULE_CHAT
        diary_prompt = DIARY_SYSTEM_PROMPT.format(
            kaomoji_rule=KAOMOJI_RULE if self.kaomoji_enabled else NO_KAOMOJI_RULE,
            thought_block=thought_block,
            segment_thought_rule=segment_thought_rule,
            life_rule=life_rule,
            chat_title=self.chat_section_title,
            alias=self.user_alias,
            piece_rule=piece_rule,
        )
        parts = [persona_prompt, diary_prompt]
        if self.extra_instruction:
            parts.append(self.extra_instruction)
        return "\n\n".join(part for part in parts if part)

    async def _wait_provider(self, timeout: float = PROVIDER_WAIT_SECONDS):
        """等模型提供方就绪。

        AstrBot 启动时插件 initialize() 早于 provider 加载完成，此时取不到模型；
        「现在立刻写一则日记」在启动阶段触发就会直接失败，所以这里轮询等待。
        """
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            provider = self._resolve_provider()
            if provider is not None:
                return provider
            if loop.time() >= deadline:
                return None
            await asyncio.sleep(5)

    def _build_prompt(
        self,
        target: date,
        transcript: str,
        piece_label: str,
        has_chat: bool,
        life_events_text: str = "",
    ) -> str:
        weekday = WEEKDAYS[target.weekday()]
        prompt_lines = [
            f"今天是 {target.year}年{target.month:02d}月{target.day:02d}日（{weekday}）。"
        ]
        if piece_label:
            prompt_lines.append(f"这次只写【{piece_label}】这一段时间。")
        if life_events_text:
            prompt_lines.append(
                "\n【今天真实发生的事（只从里面选，不要新编）】\n"
                + life_events_text
                + "\n「我的生活」只能从上面的真实事件里选，不要写上面没有的事。"
            )
        if transcript:
            prompt_lines.append(f"\n【今天和{self.user_alias}的聊天记录】\n{transcript}")
        else:
            prompt_lines.append(
                f"\n今天没有任何聊天记录。这次只写「## 我的生活」一个部分，"
                f"不要出现「## {self.chat_section_title}」这个标题，"
                "也不要在正文里交代「今天没聊天」这件事。"
                f"\n「我的生活」控制在 {self.no_chat_life_min} 到 "
                f"{self.no_chat_life_max} 个字，可以写今天的生活细节，"
                "也可以自然回忆最近和他有关的事；不要编造他今天做了什么。"
            )
        prompt_lines.append("\n请写今天的日记。")
        return "\n".join(prompt_lines)

    async def _call_text_chat(
        self, provider, prompt: str, system_prompt: str
    ) -> str:
        response = await asyncio.wait_for(
            provider.text_chat(
                prompt=prompt,
                contexts=[],
                system_prompt=system_prompt,
            ),
            timeout=LLM_TIMEOUT_SECONDS,
        )
        return getattr(response, "completion_text", None) or ""

    def _postprocess_body(
        self, text: str, *, has_chat: bool, warn: bool = True
    ) -> str:
        body = self._normalize_body(text)
        if not has_chat:
            body = self._strip_chat_section(body)
        body = self._ensure_thought_parentheses(body)
        body = self._split_chat_section(body)
        if warn:
            self._warn_section_lengths(body, has_chat)
        return body

    async def _maybe_expand_no_chat(
        self,
        provider,
        prompt: str,
        system_prompt: str,
        body: str,
    ) -> str:
        head, _ = self._split_thought(body)
        life = self._section_text(head, "我的生活")
        if len(life) >= self.no_chat_life_min:
            self._warn_section_lengths(body, False)
            return body
        logger.info(
            "[diary] 无聊天日「我的生活」只有 %d 字，自动重写一次", len(life)
        )
        rewrite_prompt = (
            f"{prompt}\n\n"
            f"【上一版太短了，只有 {len(life)} 字】\n{body}\n\n"
            f"请重写一篇完整日记：只写「## 我的生活」，控制在 "
            f"{self.no_chat_life_min} 到 {self.no_chat_life_max} 个字；"
            + (
                "只从上面「今天真实发生的事」里选，不要新编；可以多写一点感受和细节；"
                if "今天真实发生的事" in prompt
                else "可以多写一点今天的生活细节和最近的自然回忆；"
            )
            + "保留最后一段心里话（20 到 200 字）。"
            "不要写「今天没聊天」，不要编造他今天做了什么。"
        )
        try:
            text = await self._call_text_chat(
                provider, rewrite_prompt, system_prompt
            )
            rewritten = self._postprocess_body(
                text, has_chat=False, warn=False
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("[diary] 无聊天日重写失败（保留第一版）：%s", e)
            self._warn_section_lengths(body, False)
            return body

        new_head, _ = self._split_thought(rewritten)
        new_life = self._section_text(new_head, "我的生活")
        if len(new_life) >= len(life):
            body = rewritten
        self._warn_section_lengths(body, False)
        return body

    async def _generate_piece(
        self,
        provider,
        target: date,
        piece_label: str,
        messages: list[tuple[str, str, str]],
        preamble: str,
        persona_prompt: str,
    ) -> str:
        no_chat = not messages
        transcript = self._render_transcript(messages, self.max_daily_chars)
        if preamble:
            transcript = (preamble + "\n\n" + transcript).strip()
        life_events_text = self._render_life_events(
            self._load_life_events(target, piece_label)
        )
        prompt = self._build_prompt(
            target,
            transcript,
            piece_label,
            has_chat=not no_chat,
            life_events_text=life_events_text,
        )
        system_prompt = self._system_prompt(
            persona_prompt,
            piece_label,
            no_chat=no_chat,
            has_life_events=bool(life_events_text),
        )
        if no_chat:
            recall = self._no_chat_recall(target)
            if recall:
                prompt += "\n\n" + recall
        text = await self._call_text_chat(provider, prompt, system_prompt)
        body = self._postprocess_body(
            text, has_chat=not no_chat, warn=not no_chat
        )
        if no_chat:
            body = await self._maybe_expand_no_chat(
                provider, prompt, system_prompt, body
            )
        return body

    async def _generate_pieces(self, target: date) -> list[tuple[str, str]]:
        provider = await self._wait_provider()
        if provider is None:
            logger.warning("[diary] 等不到可用的模型提供方，放弃这次生成")
            raise RuntimeError("没有可用的模型提供方")

        messages = await self._load_day_messages(target)
        pieces = self._plan_pieces(messages, target)
        persona_prompt = await self._persona_prompt()
        out: list[tuple[str, str]] = []
        for label, piece_messages, preamble in pieces:
            body = await self._generate_piece(
                provider,
                target,
                label,
                piece_messages,
                preamble,
                persona_prompt,
            )
            if body:
                out.append((label, body))
        return out

    async def _generate_body(self, target: date) -> str:
        pieces = await self._generate_pieces(target)
        if not pieces:
            return ""
        if len(pieces) == 1:
            return pieces[0][1]
        return "\n\n".join(body for _, body in pieces)

    @staticmethod
    def _normalize_body(text: str) -> str:
        text = (text or "").strip()
        text = _CODE_FENCE_RE.sub("", text).strip()
        text = _LEADING_DATE_RE.sub("", text).strip()
        return text

    def _strip_chat_section(self, text: str) -> str:
        """无聊天记录时，兜底删掉模型自行补出来的聊天段落。"""
        pattern = re.compile(
            r"\n#{1,6}\s*" + re.escape(self.chat_section_title) + r"[^\n]*\n"
        )
        match = pattern.search(text)
        if match:
            return text[: match.start()].rstrip()
        return text

    @staticmethod
    def _section_text(body: str, title: str) -> str:
        pattern = re.compile(
            r"#{1,6}\s*" + re.escape(title) + r"[^\n]*\n(.*?)(?=\n#{1,6}\s|\Z)", re.S
        )
        match = pattern.search(body)
        return match.group(1).strip() if match else ""

    def _chat_section(self, body: str) -> str:
        """取聊天段落；把 ### 片段 当作段落内部标题，遇到下一个二级标题才结束。"""
        pattern = re.compile(
            r"^#{1,6}\s*" + re.escape(self.chat_section_title)
            + r"[^\n]*\n(.*?)(?=^\s*#{1,2}\s|\Z)",
            re.S | re.M,
        )
        match = pattern.search(body)
        return match.group(1).strip() if match else ""

    @staticmethod
    def _period_of(time_str: str) -> str:
        try:
            hour = int(str(time_str or "12:00").split(":")[0])
        except (ValueError, IndexError):
            hour = 12
        if 5 <= hour < 12:
            return "上午"
        if 12 <= hour < 18:
            return "下午"
        return "晚上"

    def _plan_pieces(
        self,
        messages: list[tuple[str, str, str]],
        target: date,
    ) -> list[tuple[str, list[tuple[str, str, str]], str]]:
        total = sum(len(text) for _, text, _ in messages)
        preamble = ""
        if total > self.max_daily_chars:
            kept: list[tuple[str, str, str]] = []
            used = 0
            for msg in reversed(messages):
                used += len(msg[1])
                if used > self.max_daily_chars and kept:
                    break
                kept.append(msg)
            kept.reverse()
            older = messages[: len(messages) - len(kept)]
            summary = self._memory_summary(target)
            if summary and older:
                preamble = (
                    "【更早的记忆摘要（当天聊天超过 "
                    f"{self.max_daily_chars} 字，以下为更早部分的记忆条目）】\n"
                    + summary
                )
                messages = kept
            elif older:
                logger.warning(
                    "[diary] %s 聊天超过 %d 字，但记忆条目缺失，保留原文不压缩",
                    target.isoformat(),
                    self.max_daily_chars,
                )
            total = sum(len(text) for _, text, _ in messages)

        if total <= self.max_context_chars:
            return [("", messages, preamble)]

        if total <= self.two_entry_max_chars:
            morning = [m for m in messages if self._period_of(m[2]) == "上午"]
            rest = [m for m in messages if self._period_of(m[2]) != "上午"]
            if morning and rest:
                return [("上午", morning, preamble), ("下午+晚上", rest, "")]
            if morning:
                return [("上午", morning, preamble)]
            if rest:
                return [("下午+晚上", rest, preamble)]
            return [("", messages, preamble)]

        pieces: list[tuple[str, list[tuple[str, str, str]], str]] = []
        for label in PERIODS:
            chunk = [m for m in messages if self._period_of(m[2]) == label]
            if not chunk:
                continue
            pieces.append((label, chunk, preamble if not pieces else ""))
        if not pieces:
            return [("", messages, preamble)]
        return pieces

    def _memory_summary(self, target: date) -> str:
        """当天聊天超过 24000 字时，用记忆条目补最早的部分。"""
        try:
            root = (
                Path(get_astrbot_plugin_data_path())
                / "astrbot_plugin_hiro_memory"
                / "memory"
            )
            path = root / f"{target.isoformat()}.jsonl"
            if not path.exists():
                return ""
            rows: list[dict] = []
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
            lines: list[str] = []
            for row in rows[:40]:
                text = str(row.get("text") or "").strip()
                if not text:
                    continue
                kind = str(row.get("kind") or "事件")
                if len(text) > 120:
                    text = text[:110] + "…"
                lines.append(f"- [{kind}] {text}")
            return "\n".join(lines)
        except Exception as e:  # noqa: BLE001
            logger.warning("[diary] 读取记忆摘要失败：%s", e)
            return ""

    # ------------------------------------------------------------------ 生活事件
    def _resolve_life_events_dir(self) -> Path | None:
        if self.life_events_dir:
            path = Path(self.life_events_dir)
            return path if path.exists() else None
        root = Path(get_astrbot_plugin_data_path())
        for name in ("astrbot_plugin_life", "astrbot_plugin_hiro_life"):
            path = root / name / "events"
            if path.exists():
                return path
        return None

    @staticmethod
    def _life_period_matches(period: str, occurred_at: str) -> bool:
        if not period:
            return True
        try:
            hour = datetime.fromisoformat(occurred_at).hour
        except (TypeError, ValueError):
            return True
        if period == "上午":
            return hour < 12
        if period == "下午+晚上":
            return hour >= 12
        if period == "下午":
            return 12 <= hour < 18
        if period == "晚上":
            return hour >= 18
        return True

    def _load_life_events(self, target: date, period: str = "") -> list[dict]:
        if not self.life_events_enabled:
            return []
        root = self._resolve_life_events_dir()
        if root is None:
            return []
        path = root / f"{target.isoformat()}.jsonl"
        if not path.exists():
            return []
        rows: list[dict] = []
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(row, dict):
                continue
            if str(row.get("date") or "") != target.isoformat():
                continue
            if str(row.get("privacy") or "") == "secret":
                continue
            occurred_text = str(row.get("occurred_at") or "")
            if occurred_text:
                try:
                    occurred_dt = datetime.fromisoformat(occurred_text)
                    if occurred_dt.tzinfo is None:
                        occurred_dt = occurred_dt.replace(tzinfo=self.tz)
                    if occurred_dt > datetime.now(self.tz):
                        continue
                except ValueError:
                    pass
            if not self._life_period_matches(period, occurred_text):
                continue
            rows.append(row)
        rows.sort(key=lambda r: str(r.get("occurred_at") or ""))
        return rows[: self.life_events_max]

    @staticmethod
    def _render_life_events(events: list[dict]) -> str:
        lines: list[str] = []
        for row in events:
            occurred = str(row.get("occurred_at") or "")
            stamp = occurred[11:16] if len(occurred) >= 16 else ""
            text = str(row.get("summary") or row.get("title") or "").strip()
            if not text:
                continue
            detail = str(row.get("detail") or "").strip()
            if detail and len(detail) <= 120 and detail != text:
                text = f"{text}（{detail}）"
            lines.append(f"- {stamp} {text}".strip())
        return "\n".join(lines)

    def _no_chat_recall(self, target: date) -> str:
        """无聊天日：用画像 + 近期高重要度记忆给模型一点回忆素材。"""
        try:
            root = (
                Path(get_astrbot_plugin_data_path())
                / "astrbot_plugin_hiro_memory"
            )
            parts: list[str] = []
            profile_path = root / "profile.md"
            today = datetime.now(self.tz).date()
            include_profile = target >= today - timedelta(days=1)
            if include_profile and profile_path.exists():
                profile = profile_path.read_text(
                    encoding="utf-8", errors="replace"
                ).strip()
                if profile.startswith("【"):
                    profile = profile.split("\n", 1)[-1].strip()
                if profile:
                    if len(profile) > 900:
                        profile = profile[:900] + "…"
                    parts.append("关于他：\n" + profile)
            memory_dir = root / "memory"
            rows: list[tuple[str, dict]] = []
            for offset in range(1, self.no_chat_recall_days + 1):
                day = (target - timedelta(days=offset)).isoformat()
                path = memory_dir / f"{day}.jsonl"
                if not path.exists():
                    continue
                for line in path.read_text(
                    encoding="utf-8", errors="replace"
                ).splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    scope = str(row.get("scope") or "")
                    if not scope.startswith("qq"):
                        continue
                    try:
                        imp = int(row.get("imp") or 3)
                    except (TypeError, ValueError):
                        imp = 3
                    if imp < 3:
                        continue
                    rows.append((day, row))
            rows.sort(key=lambda item: item[0], reverse=True)
            recent: list[str] = []
            for day, row in rows[: self.no_chat_recall_limit]:
                text = str(row.get("text") or "").strip()
                if not text:
                    continue
                if len(text) > 100:
                    text = text[:90] + "…"
                kind = str(row.get("kind") or "事件")
                recent.append(
                    f"- {day[5:].replace('-', '月')}日 · {kind}：{text}"
                )
            if recent:
                parts.append("最近：\n" + "\n".join(recent))
            if not parts:
                return ""
            header = "【最近记得的事（可以自然回忆，不要逐条罗列，不要编造）】"
            return header + "\n" + "\n".join(parts)
        except Exception as e:  # noqa: BLE001
            logger.warning("[diary] 读取无聊天日回忆失败：%s", e)
            return ""

    @staticmethod
    def _split_thought(body: str) -> tuple[str, str]:
        """把正文和最后一段心里话分开；心里话由提示词要求空一行另起一段。"""
        text = (body or "").strip()
        if not text:
            return "", ""
        parts = text.rsplit("\n\n", 1)
        if len(parts) != 2:
            return text, ""
        head, tail = parts[0].rstrip(), parts[1].strip()
        if not tail or re.match(r"^#{1,6}\s", tail):
            return text, ""
        return head, tail

    def _ensure_thought_parentheses(self, body: str) -> str:
        if not self.thought_enabled:
            return body
        head, tail = self._split_thought(body)
        if not tail:
            return body
        return (head + "\n\n" + self._wrap_parentheses(tail)).strip()

    @staticmethod
    def _wrap_parentheses(text: str) -> str:
        value = (text or "").strip()
        if (value.startswith("（") and value.endswith("）")) or (
            value.startswith("(") and value.endswith(")")
        ):
            value = value[1:-1].strip()
        return f"（{value}）"

    @staticmethod
    def _is_parenthesized(text: str) -> bool:
        value = (text or "").strip()
        return (
            (value.startswith("（") and value.endswith("）"))
            or (value.startswith("(") and value.endswith(")"))
        )

    def _parse_chat_segments(self, chat: str) -> list[tuple[str, str]]:
        """按 ### 片段 切块；每块末尾的普通括号作为该段想法。"""
        if not chat or not chat.strip():
            return []
        blocks = re.split(r"^\s*#{1,6}\s*片段[^\n]*\n", chat, flags=re.M)
        blocks = [block.strip() for block in blocks if block.strip()]
        if not blocks:
            blocks = [chat.strip()]
        out: list[tuple[str, str]] = []
        for block in blocks:
            thought = ""
            parts = block.rsplit("\n\n", 1)
            if len(parts) == 2 and self._is_parenthesized(parts[1].strip()):
                block, thought = parts[0].rstrip(), parts[1].strip()
            out.append((block, thought))
        return out

    def _split_chat_section(self, body: str) -> str:
        head, final_thought = self._split_thought(body)
        chat = self._chat_section(head)
        if not chat:
            return body
        segments = self._parse_chat_segments(chat)
        if not segments:
            return body

        planned: list[tuple[str, str]] = []
        for chat_text, thought in segments:
            chat_text = chat_text.strip()
            if not chat_text:
                continue
            if len(chat_text) > self.chat_max and len(planned) < self.segment_max:
                remaining = self.segment_max - len(planned)
                n = min(
                    remaining,
                    max(2, math.ceil(len(chat_text) / self.chat_max)),
                )
                chunks = self._split_text_evenly(chat_text, n)
                for i, chunk in enumerate(chunks):
                    planned.append(
                        (chunk, thought if i == len(chunks) - 1 else "")
                    )
            else:
                planned.append((chat_text, thought))

        if not planned:
            return body
        if len(planned) > self.segment_max:
            keep = planned[: self.segment_max - 1]
            merged_text = "\n\n".join(
                text for text, _ in planned[self.segment_max - 1 :]
            )
            merged_thought = next(
                (th for _, th in reversed(planned) if th), ""
            )
            keep.append((merged_text, merged_thought))
            planned = keep

        if len(planned) == 1 and not planned[0][1]:
            return body

        if len(planned) == 1:
            chat_text, thought = planned[0]
            new_chat = chat_text + (f"\n\n{thought}" if thought else "")
        else:
            parts = []
            for i, (chat_text, thought) in enumerate(planned, 1):
                part = f"### 片段 {i}/{len(planned)}\n{chat_text}"
                if thought:
                    part += f"\n\n{thought}"
                parts.append(part)
            new_chat = "\n\n".join(parts)

        pattern = re.compile(
            r"(^#{1,6}\s*" + re.escape(self.chat_section_title)
            + r"[^\n]*\n)(.*?)(?=^\s*#{1,2}\s|\Z)",
            re.S | re.M,
        )
        match = pattern.search(head)
        if not match:
            return body
        new_body = (
            head[: match.start()]
            + match.group(1)
            + "\n"
            + new_chat
            + head[match.end() :]
        )
        return new_body + ("\n\n" + final_thought if final_thought else "")

    @staticmethod
    def _split_text_evenly(text: str, n: int) -> list[str]:
        text = (text or "").strip()
        if n <= 1 or not text:
            return [text] if text else []
        sentences = re.split(r"(?<=[。！？!?；;])\s*", text)
        sentences = [s for s in sentences if s.strip()]
        if not sentences:
            return [text]
        total = sum(len(s) for s in sentences)
        target = total / n
        chunks: list[str] = []
        buf = ""
        for sentence in sentences:
            if buf and len(buf) + len(sentence) > target and len(chunks) < n - 1:
                chunks.append(buf.strip())
                buf = sentence
            else:
                buf += sentence
        if buf.strip():
            chunks.append(buf.strip())
        if len(chunks) > n:
            chunks = chunks[: n - 1] + ["".join(chunks[n - 1 :])]
        return chunks

    @staticmethod
    def _thought_inner(text: str) -> str:
        value = (text or "").strip()
        if (value.startswith("（") and value.endswith("）")) or (
            value.startswith("(") and value.endswith(")")
        ):
            value = value[1:-1].strip()
        return value

    def _warn_section_lengths(self, body: str, has_chat: bool) -> None:
        head, thought = self._split_thought(body)
        life = self._section_text(head, "我的生活")
        if has_chat:
            if life and len(life) > self.life_max:
                logger.warning(
                    "[diary] 「我的生活」有 %d 字，超出目标 %d（仅警告，不截断）",
                    len(life),
                    self.life_max,
                )
        else:
            if life and len(life) < self.no_chat_life_min:
                logger.warning(
                    "[diary] 无聊天日「我的生活」只有 %d 字，低于目标 %d（仅警告）",
                    len(life),
                    self.no_chat_life_min,
                )
            if life and len(life) > self.no_chat_life_max:
                logger.warning(
                    "[diary] 无聊天日「我的生活」有 %d 字，超出目标 %d（仅警告）",
                    len(life),
                    self.no_chat_life_max,
                )
        if self.thought_enabled:
            inner = self._thought_inner(thought)
            if inner and len(inner) > self.thought_max:
                logger.warning(
                    "[diary] 心里话有 %d 字，超出目标 %d（仅警告，不截断）",
                    len(inner),
                    self.thought_max,
                )
        if has_chat:
            chat = self._chat_section(head)
            for i, (chat_text, seg_thought) in enumerate(
                self._parse_chat_segments(chat), 1
            ):
                if len(chat_text) > self.chat_max:
                    logger.warning(
                        "[diary] 聊天片段 %d 有 %d 字，超出目标 %d（仅警告，不截断）",
                        i,
                        len(chat_text),
                        self.chat_max,
                    )
                inner = self._thought_inner(seg_thought)
                if inner and len(inner) > self.thought_max:
                    logger.warning(
                        "[diary] 聊天片段 %d 的想法有 %d 字，超出目标 %d（仅警告，不截断）",
                        i,
                        len(inner),
                        self.thought_max,
                    )

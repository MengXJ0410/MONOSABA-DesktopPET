"""astrbot_plugin_life — 通用生活事件插件。

让角色有自己的生活：每天生成生活事件，注入聊天，偶尔主动私聊分享。
默认世界观写给希罗/艾玛；换人格只改配置和 world 文件，不改代码。
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import re
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, MessageChain, filter
from astrbot.api.message_components import Plain
from astrbot.api.provider import ProviderRequest
from astrbot.api.star import Context, Star, register
from astrbot.core.agent.message import TextPart
from astrbot.core.utils.astrbot_path import get_astrbot_plugin_data_path

PLUGIN_NAME = "astrbot_plugin_life"
JOB_SEED = "life_seed"
JOB_NIGHTMARE = "life_nightmare"

DEFAULT_UMO = "Hiro:FriendMessage:1955272576"
DEFAULT_TZ = "Asia/Shanghai"
DEFAULT_PERSONA = "希罗"
DEFAULT_COMPANION = "艾玛"
DEFAULT_ALIAS = "他"
DEFAULT_EVENT_PROVIDER = "MXJAPI/cn:glm-5.3-flash"
DEFAULT_SHARE_PROVIDER = "MXJAPI/cn:deepseek-v4.1-flash"
DEFAULT_WORLD_FILE = "world/hiro.md"

EMOTIONS = ("委屈", "生气", "开心", "害羞", "担心", "失落", "累", "吃醋")
SLOTS = {
    "morning": ("07:00", "09:00"),
    "noon": ("11:30", "13:30"),
    "afternoon": ("15:00", "17:30"),
    "evening": ("19:00", "22:00"),
    "night": ("22:00", "23:30"),
}
SLOT_LABELS = {
    "morning": "早上",
    "noon": "中午",
    "afternoon": "下午",
    "evening": "晚上",
    "night": "夜间",
}
SLOT_ORDER = ("morning", "noon", "afternoon", "evening", "night")
EVENT_TTL_MINUTES = 240
MIN_SHARE_AGE_MINUTES = 10

DEFAULT_WORLD = """【世界观：魔女审判结束之后】

你是{persona_name}。魔女审判已经结束，你从孤岛上活了下来，和{companion_name}一起回到了普通的高中生活。

你和{companion_name}住在学校附近的两室一厅公寓，是家里安排的。你们上同一所高中，同一个班，每天早上一起出门，放学一起回家，午饭也一起吃。大多数时候你们睡在同一张床上。

你们是彼此最亲近的人，亲近到不用解释，但没有越过那条线。你会害羞、嘴硬，但不再否认她在你心里的分量。

{companion_name}是人类。“笨狗”“小笨狗”“粉色小笨狗”只是你给她的绰号，不要写尾巴、耳朵、动物特征。

{user_alias}是你线上很重要的人。你会想让他知道你今天的事，偶尔逗他、关心他，对他有一点说不清的依赖。但你还不想越过朋友那条线，对他有点暧昧但守界，不会主动告白，也不会做越界的事。

不要新增有名字的主要角色；不要写超自然设定复辟、血腥、自伤、露骨性描写；不要写“AI”“程序”“模型”之类的梗；不要安排{user_alias}和{persona_name}线下见面。"""


def _as_int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value, default: float) -> float:
    try:
        return float(value)
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


def _parse_hhmm(value, default: time) -> time:
    text = str(value or "").strip()
    match = re.match(r"^(\d{1,2}):(\d{2})$", text)
    if not match:
        return default
    hour, minute = int(match.group(1)), int(match.group(2))
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return default
    return time(hour, minute)


def _iso(value: datetime) -> str:
    return value.isoformat(timespec="seconds")


def _parse_iso(value) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:
        return None


def _clip(value, limit: int) -> str:
    text = str(value or "").strip()
    return text if len(text) <= limit else text[: max(0, limit - 1)] + "…"


@register(
    PLUGIN_NAME,
    "MXJ",
    "希罗酱的生活：有自己的日常，也会主动分享",
    "0.1.9",
)
class LifePlugin(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)
        self.config = config or {}

        self.enabled = _as_bool(self.config.get("enabled"), True)
        self.target_umo = str(
            self.config.get("target_umo") or DEFAULT_UMO
        ).strip()
        self.tz = ZoneInfo(str(self.config.get("timezone") or DEFAULT_TZ))
        self.persona_id = str(
            self.config.get("persona_id") or DEFAULT_PERSONA
        ).strip()
        self.persona_name = str(
            self.config.get("persona_name") or DEFAULT_PERSONA
        ).strip()
        self.companion_name = str(
            self.config.get("companion_name") or DEFAULT_COMPANION
        ).strip()
        self.user_alias = str(
            self.config.get("user_alias") or DEFAULT_ALIAS
        ).strip()
        self.world_file = str(
            self.config.get("world_file") or DEFAULT_WORLD_FILE
        ).strip()
        self.event_provider_id = str(
            self.config.get("event_provider_id") or DEFAULT_EVENT_PROVIDER
        ).strip()
        self.share_provider_id = str(
            self.config.get("share_provider_id") or DEFAULT_SHARE_PROVIDER
        ).strip()

        self.seed_cron = str(self.config.get("seed_cron") or "30 6 * * *").strip()
        self.nightmare_cron = str(
            self.config.get("nightmare_cron") or "30 23 * * *"
        ).strip()
        self.events_min = max(
            1, min(8, _as_int(self.config.get("events_min"), 4))
        )
        self.events_max = max(
            self.events_min,
            min(8, _as_int(self.config.get("events_max"), 7)),
        )
        self.share_min = max(0, _as_int(self.config.get("share_min"), 3))
        self.share_max = max(
            self.share_min, _as_int(self.config.get("share_max"), 5)
        )
        self.share_affection_enabled = _as_bool(
            self.config.get("share_affection_enabled"), True
        )
        self.share_quota_mode = str(
            self.config.get("share_quota_mode") or "target"
        ).strip().lower()
        if self.share_quota_mode not in ("target", "floor"):
            self.share_quota_mode = "target"
        self.nightmare_min_affection = max(
            0.0,
            _as_float(self.config.get("nightmare_min_affection"), 10.0),
        )
        self.share_start = _parse_hhmm(
            self.config.get("share_start"), time(8, 0)
        )
        self.share_end = _parse_hhmm(self.config.get("share_end"), time(23, 0))
        self.quiet_start = _parse_hhmm(
            self.config.get("quiet_start"), time(23, 30)
        )
        self.quiet_end = _parse_hhmm(
            self.config.get("quiet_end"), time(6, 30)
        )
        self.cooldown_minutes = max(
            0, _as_int(self.config.get("cooldown_minutes"), 60)
        )
        self.base_probability = min(
            1.0,
            max(0.0, _as_float(self.config.get("base_probability"), 0.7)),
        )
        self.after_user_minutes = max(
            0, _as_int(self.config.get("after_user_minutes"), 8)
        )
        self.max_unanswered = max(
            0, _as_int(self.config.get("max_unanswered"), 3)
        )
        self.unanswered_cooldown_minutes = max(
            0,
            _as_int(self.config.get("unanswered_cooldown_minutes"), 45),
        )
        self.unanswered_complain_after = max(
            1, _as_int(self.config.get("unanswered_complain_after"), 1)
        )
        self.unanswered_cold_war_after = max(
            self.unanswered_complain_after + 1,
            _as_int(self.config.get("unanswered_cold_war_after"), 2),
        )
        self.unanswered_message_delay_min = max(
            0.0,
            _as_float(self.config.get("unanswered_message_delay_min"), 4.0),
        )
        self.unanswered_message_delay_max = max(
            self.unanswered_message_delay_min,
            _as_float(self.config.get("unanswered_message_delay_max"), 12.0),
        )
        self.unanswered_segment_delay_min = max(
            0.0,
            _as_float(self.config.get("unanswered_segment_delay_min"), 2.0),
        )
        self.unanswered_segment_delay_max = max(
            self.unanswered_segment_delay_min,
            _as_float(self.config.get("unanswered_segment_delay_max"), 4.0),
        )
        self.cold_war_enabled = _as_bool(
            self.config.get("cold_war_enabled"), True
        )
        self.force_one_if_none = _as_bool(
            self.config.get("force_one_if_none"), True
        )
        self.nightmare_enabled = _as_bool(
            self.config.get("nightmare_enabled"), True
        )
        self.nightmare_probability = min(
            1.0,
            max(
                0.0,
                _as_float(self.config.get("nightmare_probability"), 0.05),
            ),
        )
        self.nightmare_window_start = _parse_hhmm(
            self.config.get("nightmare_window_start"), time(23, 30)
        )
        self.nightmare_window_end = _parse_hhmm(
            self.config.get("nightmare_window_end"), time(6, 30)
        )
        self.nightmare_active_minutes = max(
            0, _as_int(self.config.get("nightmare_active_minutes"), 10)
        )
        self.nightmare_delay_minutes = max(
            1, _as_int(self.config.get("nightmare_delay_minutes"), 30)
        )
        self.nightmare_max_late_minutes = max(
            0, _as_int(self.config.get("nightmare_max_late_minutes"), 90)
        )
        self.nightmare_segments_min = max(
            2,
            min(
                6,
                _as_int(self.config.get("nightmare_segments_min"), 3),
            ),
        )
        self.nightmare_segments_max = max(
            self.nightmare_segments_min,
            min(
                6,
                _as_int(self.config.get("nightmare_segments_max"), 6),
            ),
        )
        self.nightmare_segment_delay_min = max(
            0.0,
            _as_float(
                self.config.get("nightmare_segment_delay_min"), 2.0
            ),
        )
        self.nightmare_segment_delay_max = max(
            self.nightmare_segment_delay_min,
            _as_float(
                self.config.get("nightmare_segment_delay_max"), 4.0
            ),
        )
        self.inject_max_events = max(
            1, _as_int(self.config.get("inject_max_events"), 4)
        )
        self.inject_max_chars = max(
            100, _as_int(self.config.get("inject_max_chars"), 350)
        )
        self.mood_link = _as_bool(self.config.get("mood_link"), True)
        self.diary_link = _as_bool(self.config.get("diary_link"), True)
        self.event_timeout = max(
            20, _as_int(self.config.get("event_timeout"), 90)
        )
        self.share_timeout = max(
            15, _as_int(self.config.get("share_timeout"), 45)
        )
        self.dry_run = _as_bool(self.config.get("dry_run"), False)
        self.debug = _as_bool(self.config.get("debug"), False)

        self.root = Path(get_astrbot_plugin_data_path()) / PLUGIN_NAME
        self.events_dir = self.root / "events"
        self.backups_dir = self.root / "backups"
        self.state_path = self.root / "state.json"
        self.world_text = self._load_world()

        self._state_lock = asyncio.Lock()
        self._events_lock = asyncio.Lock()
        self._history_lock = asyncio.Lock()
        self._seed_lock = asyncio.Lock()
        self._startup_task: asyncio.Task | None = None
        self._share_task: asyncio.Task | None = None
        self._nightmare_task: asyncio.Task | None = None
        self._stopping = False

        logger.info(
            "[life] 已加载：target=%s, persona=%s, companion=%s, world=%s",
            self.target_umo,
            self.persona_name,
            self.companion_name,
            self.world_file,
        )

    # ------------------------------------------------------------------ 生命周期
    async def initialize(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self.events_dir.mkdir(parents=True, exist_ok=True)
        self.backups_dir.mkdir(parents=True, exist_ok=True)
        if not self.enabled:
            logger.info("[life] 插件已关闭")
            return

        manager = getattr(self.context, "cron_manager", None)
        if manager is not None:
            await self._remove_jobs(manager)
            try:
                await manager.add_basic_job(
                    name=JOB_SEED,
                    cron_expression=self.seed_cron,
                    handler=self._job_seed,
                    description="生成每天的生活事件",
                    timezone=str(self.tz),
                    persistent=False,
                )
                logger.info("[life] 已注册 %s：cron=%r", JOB_SEED, self.seed_cron)
                if self.nightmare_enabled:
                    await manager.add_basic_job(
                        name=JOB_NIGHTMARE,
                        cron_expression=self.nightmare_cron,
                        handler=self._job_nightmare,
                        description="每晚 5% 概率触发噩梦惊醒",
                        timezone=str(self.tz),
                        persistent=False,
                    )
                    logger.info(
                        "[life] 已注册 %s：cron=%r",
                        JOB_NIGHTMARE,
                        self.nightmare_cron,
                    )
            except Exception as e:  # noqa: BLE001
                logger.error("[life] 注册定时任务失败：%s", e)
        else:
            logger.error("[life] cron_manager 不可用，定时任务不会运行")

        self._startup_task = asyncio.create_task(self._startup())

    async def terminate(self) -> None:
        self._stopping = True
        for task in (self._startup_task, self._share_task, self._nightmare_task):
            if task and not task.done():
                task.cancel()
        manager = getattr(self.context, "cron_manager", None)
        if manager is not None:
            await self._remove_jobs(manager)

    async def _remove_jobs(self, manager) -> None:
        try:
            jobs = await manager.list_jobs(job_type="basic")
        except Exception as e:  # noqa: BLE001
            logger.warning("[life] 读取任务列表失败：%s", e)
            return
        for job in jobs:
            if getattr(job, "name", "") in {JOB_SEED, JOB_NIGHTMARE}:
                try:
                    await manager.delete_job(job.job_id)
                    logger.info("[life] 已清理旧任务 %s(%s)", job.name, job.job_id)
                except Exception as e:  # noqa: BLE001
                    logger.warning("[life] 删除旧任务 %s 失败：%s", job.name, e)

    async def _startup(self) -> None:
        try:
            await asyncio.sleep(8)
            await self._ensure_today()
            await self._maybe_resume_nightmare()
            trigger = self.root / "force_nightmare"
            if trigger.exists():
                try:
                    trigger.unlink()
                except OSError as e:  # noqa: BLE001
                    logger.warning("[life] 删除强制噩梦标记失败：%s", e)
                logger.info("[life] 检测到强制噩梦测试标记，立即触发")
                await self._force_nightmare()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            logger.warning("[life] 启动任务异常：%s", e)
        finally:
            if not self._stopping and (
                self._share_task is None or self._share_task.done()
            ):
                self._share_task = asyncio.create_task(self._share_loop())

    # ------------------------------------------------------------------ 世界与状态
    def _load_world(self) -> str:
        path = Path(self.world_file)
        if not path.is_absolute():
            path = Path(__file__).parent / path
        try:
            text = path.read_text(encoding="utf-8")
        except Exception as e:  # noqa: BLE001
            logger.warning("[life] 读取世界观失败 %s：%s，使用内置默认", path, e)
            text = DEFAULT_WORLD
        for key, value in {
            "persona_name": self.persona_name,
            "companion_name": self.companion_name,
            "user_alias": self.user_alias,
        }.items():
            text = text.replace("{" + key + "}", value)
        return text.strip()

    def _load_state(self) -> dict:
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                if not isinstance(data.get("daily"), dict):
                    data["daily"] = {}
                data.setdefault("paused", False)
                data.setdefault("unanswered", 0)
                self._migrate_nightmare_state(data)
                return data
        except FileNotFoundError:
            pass
        except Exception as e:  # noqa: BLE001
            logger.warning("[life] 读取状态失败：%s", e)
        return {"daily": {}, "nightmares": {}, "paused": False, "unanswered": 0}

    def _migrate_nightmare_state(self, state: dict) -> None:
        """把旧版写进 daily 的噩梦字段迁到独立的 nightmares 里。

        噩梦不参与生活分享配额，也不应该创建 daily 记录。
        """
        nightmares = state.get("nightmares")
        if not isinstance(nightmares, dict):
            nightmares = {}
            state["nightmares"] = nightmares
        daily = state.get("daily")
        if not isinstance(daily, dict):
            return
        for day_key, row in list(daily.items()):
            if not isinstance(row, dict):
                continue
            roll = row.pop("nightmare_roll", None)
            scheduled = row.pop("nightmare_scheduled_at", None)
            if roll is None and scheduled is None:
                continue
            record = nightmares.setdefault(day_key, {})
            if roll:
                record["roll"] = True
            if scheduled:
                record.setdefault("scheduled_at", scheduled)

    def _nightmare_record(self, state: dict, day: date) -> dict:
        nightmares = state.setdefault("nightmares", {})
        record = nightmares.get(day.isoformat())
        if not isinstance(record, dict):
            record = {}
            nightmares[day.isoformat()] = record
        return record

    def _save_state(self, state: dict) -> None:
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            self._prune_daily(state)
            tmp = self.state_path.with_suffix(".json.tmp")
            tmp.write_text(
                json.dumps(state, ensure_ascii=False, indent=1),
                encoding="utf-8",
            )
            os.replace(tmp, self.state_path)
        except Exception as e:  # noqa: BLE001
            logger.warning("[life] 保存状态失败：%s", e)

    def _prune_daily(self, state: dict) -> None:
        cutoff = (datetime.now(self.tz).date() - timedelta(days=14)).isoformat()
        daily = state.get("daily")
        if not isinstance(daily, dict):
            state["daily"] = {}
        else:
            for key in list(daily.keys()):
                if key < cutoff:
                    daily.pop(key, None)
        nightmares = state.get("nightmares")
        if isinstance(nightmares, dict):
            for key in list(nightmares.keys()):
                if key < cutoff:
                    nightmares.pop(key, None)

    def _events_path(self, day: date) -> Path:
        return self.events_dir / f"{day.isoformat()}.jsonl"

    def _load_events(self, day: date) -> list[dict]:
        path = self._events_path(day)
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
            if isinstance(row, dict):
                rows.append(row)
        rows.sort(key=lambda r: str(r.get("occurred_at") or ""))
        return rows

    def _save_events(self, day: date, events: list[dict]) -> None:
        try:
            self.events_dir.mkdir(parents=True, exist_ok=True)
            path = self._events_path(day)
            tmp = path.with_suffix(".jsonl.tmp")
            with tmp.open("w", encoding="utf-8") as handle:
                for event in sorted(
                    events, key=lambda r: str(r.get("occurred_at") or "")
                ):
                    handle.write(json.dumps(event, ensure_ascii=False) + "\n")
            os.replace(tmp, path)
        except Exception as e:  # noqa: BLE001
            logger.warning("[life] 保存事件失败 %s：%s", day, e)

    def _backup_day(self, day: date) -> None:
        try:
            path = self._events_path(day)
            if not path.exists():
                return
            self.backups_dir.mkdir(parents=True, exist_ok=True)
            target = self.backups_dir / f"{day.isoformat()}.jsonl"
            target.write_bytes(path.read_bytes())
        except Exception as e:  # noqa: BLE001
            logger.warning("[life] 备份事件失败 %s：%s", day, e)

    # ------------------------------------------------------------------ 时间工具
    @staticmethod
    def _in_window(now: datetime, start: time, end: time) -> bool:
        current = now.time()
        if start <= end:
            return start <= current <= end
        return current >= start or current <= end

    @staticmethod
    def _day_dt(day: date, value: time, tz: ZoneInfo) -> datetime:
        return datetime.combine(day, value, tzinfo=tz)

    # ------------------------------------------------------------------ 生成
    async def _job_seed(self, **_kwargs) -> None:
        await self._seed_day(datetime.now(self.tz).date(), full=True)

    async def _ensure_today(self) -> None:
        now = datetime.now(self.tz)
        day = now.date()
        # 已经有正常事件时只补配额，不受 21:00 限制；真正生成新事件才限时。
        if not self._has_planned_events(day) and now.time() >= time(21, 0):
            return
        await self._seed_day(day, full=False)

    def _has_planned_events(self, day: date) -> bool:
        """当天是否已经生成过正常生活事件。

        噩梦事件也会写进同一个 events 文件，不能单凭「文件非空」
        就判断今天已经播过种，否则凌晨出过噩梦的第二天会整天空转。
        """
        return any(
            event.get("type") != "nightmare"
            for event in self._load_events(day)
        )

    async def _seed_day(
        self, day: date, *, full: bool = True, force: bool = False
    ) -> bool:
        if not self.enabled:
            return False
        if self._seed_lock.locked():
            return False
        async with self._seed_lock:
            existing = self._load_events(day)
            # 噩梦是独立事件，不算「今天已经播过种」；重新生成时保留它们。
            kept = [
                event for event in existing
                if event.get("type") == "nightmare"
            ]
            planned = [
                event for event in existing
                if event.get("type") != "nightmare"
            ]
            if planned and not force:
                await self._ensure_daily_meta(day, len(planned))
                return True
            slots = self._pick_slots(day, full=full)
            if not slots:
                logger.info("[life] %s 没有可生成的时间段", day)
                return False
            prompt = self._build_seed_prompt(day, slots)
            if self.debug:
                logger.info("[life] 事件生成 prompt：\n%s", prompt)
            raw = await self._call_llm(
                self.event_provider_id,
                prompt,
                self._seed_system_prompt(),
                self.event_timeout,
            )
            if not raw:
                await asyncio.sleep(10)
                raw = await self._call_llm(
                    self.event_provider_id,
                    prompt,
                    self._seed_system_prompt(),
                    self.event_timeout,
                )
            if self.debug:
                logger.info("[life] 事件生成 raw：\n%s", (raw or "")[:2000])
            events = self._parse_events(raw, day, slots)
            if not events:
                logger.warning("[life] 事件生成失败，使用兜底事件")
                events = self._fallback_events(day, slots)
            self._save_events(day, events + kept)
            self._backup_day(day)
            async with self._state_lock:
                state = self._load_state()
                state["last_seed_date"] = day.isoformat()
                # 新的一天重新计算未回复计数，避免昨天的未回复压住今天的分享。
                state["unanswered"] = 0
                daily = state.setdefault("daily", {}).setdefault(
                    day.isoformat(), {}
                )
                daily["target"] = self._pick_share_target(len(events))
                daily["fallback_at"] = _iso(self._pick_fallback_time(day))
                if force:
                    daily["shared"] = 0
                else:
                    daily.setdefault("shared", 0)
                self._save_state(state)
            logger.info(
                "[life] %s 生成 %d 件生活事件，目标分享 %d 条",
                day,
                len(events),
                daily.get("target"),
            )
            return True

    async def _ensure_daily_meta(self, day: date, event_count: int) -> None:
        """正常生活事件已经存在时，补齐缺失的每日分享配额。

        兼容旧状态：某天只留下 nightmare_roll、没有 target/fallback_at，
        这时 `_tick` 会以为今天已经安排过，结果一整天都不分享。
        """
        async with self._state_lock:
            state = self._load_state()
            daily = state.setdefault("daily", {}).setdefault(
                day.isoformat(), {}
            )
            changed = False
            if "target" not in daily:
                daily["target"] = self._pick_share_target(event_count)
                changed = True
            if not daily.get("fallback_at"):
                daily["fallback_at"] = _iso(self._pick_fallback_time(day))
                changed = True
            if "shared" not in daily:
                daily["shared"] = 0
                changed = True
            if changed:
                self._save_state(state)
                logger.info(
                    "[life] %s 已有生活事件，补齐每日配额：目标 %s 条，保底 %s",
                    day,
                    daily.get("target"),
                    daily.get("fallback_at"),
                )

    def _pick_slots(self, day: date, *, full: bool) -> list[str]:
        count = random.randint(self.events_min, self.events_max)
        if day.weekday() >= 5 and self.events_max >= 4:
            count = max(count, random.randint(4, self.events_max))
        elif day.weekday() < 5:
            count = min(count, max(4, self.events_min))
        count = max(self.events_min, min(self.events_max, count))

        if count <= 1:
            slots = ["evening"]
        elif count == 2:
            slots = ["morning", "evening"]
        elif count == 3:
            slots = ["morning", "afternoon", "evening"]
        elif count == 4:
            slots = ["morning", "noon", "afternoon", "evening"]
        elif count == 5:
            slots = ["morning", "noon", "afternoon", "evening", "night"]
        else:
            slots = [
                "morning",
                "noon",
                "afternoon",
                "evening",
                "night",
                random.choice(["afternoon", "evening"]),
            ]

        if not full:
            now = datetime.now(self.tz)
            active: list[str] = []
            for slot in slots:
                end = _parse_hhmm(SLOTS[slot][1], time(23, 59))
                if now.time() < end:
                    active.append(slot)
            slots = active
        return slots

    def _share_quota_range(self) -> tuple[int, int]:
        """按好感返回今天主动分享的目标范围。

        好感 0-10 不主动分享；10-50 每天 1-3 条；50-100 每天 3-6 条；
        100+ 每天 5-10 条。读不到好感时暂停主动分享，避免脱离好感度乱发。
        """
        if not self.share_affection_enabled:
            return self.share_min, self.share_max
        affection = self._affection_state()
        if not affection:
            logger.debug("[life] 读不到好感度，暂停主动分享")
            return 0, 0
        value = _as_float(affection.get("value"), 0.0)
        if value < 10:
            return 0, 0
        if value < 50:
            return 1, 3
        if value < 100:
            return 3, 6
        return 5, 10

    def _share_target(self, daily: dict) -> int:
        lo, hi = self._share_quota_range()
        if hi <= 0:
            return 0
        stored = _as_int(daily.get("target"), hi)
        if self.share_quota_mode == "floor":
            return max(lo, min(hi, max(stored, lo)))
        if stored <= 0:
            return hi
        return max(1, min(hi, stored))

    def _pick_share_target(self, event_count: int) -> int:
        lo, hi = self._share_quota_range()
        if hi <= 0:
            return 0
        # 事件太少时把目标压到事件数，避免设一个永远够不到的数字；
        # floor 模式仍然会由 _share_target 把下限抬起来。
        cap = max(1, min(hi, max(event_count, 1)))
        low = min(max(lo, 1), cap)
        return random.randint(low, cap)

    def _pick_fallback_time(self, day: date) -> datetime:
        now = datetime.now(self.tz)
        start = self._day_dt(day, time(18, 0), self.tz)
        end = self._day_dt(day, time(22, 30), self.tz)
        if now.date() == day:
            if now >= end:
                return min(
                    now + timedelta(minutes=5),
                    self._day_dt(day, time(23, 0), self.tz),
                )
            if now > start:
                start = now + timedelta(minutes=15)
        if start >= end:
            return end
        seconds = random.randint(0, int((end - start).total_seconds()))
        return start + timedelta(seconds=seconds)

    def _build_seed_prompt(self, day: date, slots: list[str]) -> str:
        weekday = "一二三四五六日"[day.weekday()]
        slot_lines = []
        for slot in slots:
            start, end = SLOTS[slot]
            slot_lines.append(
                f"- {slot}（{SLOT_LABELS[slot]} {start}-{end}）"
            )
        recent = self._recent_titles(day)
        recent_block = ""
        if recent:
            recent_block = (
                "\n【最近 7 天已经写过的事，不要重复】\n"
                + "\n".join(f"- {item}" for item in recent)
            )
        return f"""今天是 {day.year}年{day.month:02d}月{day.day:02d}日（星期{weekday}）。
请为{self.persona_name}生成今天下面这些时间段的生活事件：
{chr(10).join(slot_lines)}
{recent_block}

要求：
- 每个时间段生成 1 件，共 {len(slots)} 件；同一个 slot 出现两次时，写两件不同的事。
- 事件要具体、生活化、有情绪：时间、地点、和谁、发生了什么、{self.persona_name}的感受。
- 不要每件都围着{self.companion_name}转；也要有{self.persona_name}自己的学习、社团、家务、独处、想起{self.user_alias}的时刻。
- 不要重复最近 7 天写过的事，不要每天都写偷吃、赖床、补习。
- 只写今天已经发生或今天会发生的事，不要写未来几天。
- 情绪变化只能用：委屈、生气、开心、害羞、担心、失落、累、吃醋；每件最多 2 种，delta 在 0.05 到 0.25。
- 分享意愿 desire 0 到 1：有些事只想自己知道，有些事很想告诉{self.user_alias}。
- privacy 只能是 private 或 secret；secret 表示绝对不会告诉{self.user_alias}。

只输出 JSON 数组，格式：
[
  {{
    "slot": "morning",
    "title": "短标题",
    "summary": "一句话概括，20-40字",
    "detail": "具体发生了什么，40-120字，第一人称",
    "people": ["{self.companion_name}"],
    "place": "家",
    "tags": ["日常"],
    "valence": 0.3,
    "mood_delta": [{{"emotion":"开心","delta":0.2}}],
    "intensity": 0.6,
    "share": {{"eligible": true, "desire": 0.7, "hook": "想告诉他的点"}},
    "privacy": "private"
  }}
]
"""

    def _seed_system_prompt(self) -> str:
        return (
            self.world_text
            + "\n\n"
            + self._affection_world_line()
            + "\n\n你是一个生活事件生成器。只输出 JSON 数组，不要解释，不要代码块。"
        )

    def _recent_titles(self, day: date) -> list[str]:
        out: list[str] = []
        for offset in range(1, 8):
            target = day - timedelta(days=offset)
            for event in self._load_events(target):
                if event.get("privacy") == "secret":
                    continue
                text = str(
                    event.get("title") or event.get("summary") or ""
                ).strip()
                if text:
                    out.append(
                        f"{target.month:02d}-{target.day:02d} {text}"
                    )
                if len(out) >= 20:
                    return out
        return out

    def _parse_events(
        self, raw: str, day: date, slots: list[str]
    ) -> list[dict]:
        data = self._extract_json(raw)
        if data is None:
            return []
        if isinstance(data, dict):
            if isinstance(data.get("events"), list):
                data = data["events"]
            elif isinstance(data.get("items"), list):
                data = data["items"]
            elif data.get("title") or data.get("summary"):
                data = [data]
            else:
                data = []
        if not isinstance(data, list):
            return []
        normalized: list[dict] = []
        for item in data:
            if not isinstance(item, dict):
                continue
            event = self._normalize_event(item, day)
            if event:
                normalized.append(event)
        if not normalized:
            return []

        picked: list[dict] = []
        used: set[int] = set()
        for slot in slots:
            match = None
            for idx, event in enumerate(normalized):
                if idx in used:
                    continue
                if event.get("window") == slot:
                    match = idx
                    break
            if match is None:
                for idx, _event in enumerate(normalized):
                    if idx not in used:
                        match = idx
                        break
            if match is None:
                picked.append(self._fallback_event(day, slot, len(picked)))
            else:
                used.add(match)
                event = normalized[match]
                event["window"] = slot
                picked.append(event)
        self._assign_times(day, picked)
        return picked

    @staticmethod
    def _extract_json(raw: str):
        text = (raw or "").strip()
        text = re.sub(r"```(?:json)?\s*", "", text, flags=re.I)
        text = text.replace("```", "").strip()
        start = text.find("[")
        end = text.rfind("]")
        if start >= 0 and end > start:
            text = text[start : end + 1]
        else:
            start = text.find("{")
            end = text.rfind("}")
            if start >= 0 and end > start:
                text = text[start : end + 1]
            else:
                return None
        text = re.sub(r",\s*([}\]])", r"\1", text)
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return None

    def _normalize_event(self, item: dict, day: date) -> dict | None:
        title = _clip(item.get("title"), 40)
        summary = _clip(item.get("summary") or title, 100)
        detail = _clip(item.get("detail") or summary, 300)
        if not title and not summary:
            return None
        window = str(item.get("slot") or item.get("window") or "").strip()
        if window not in SLOTS:
            window = ""
        people_raw = item.get("people")
        if isinstance(people_raw, str):
            people_raw = re.split(r"[,，、]", people_raw)
        people = [
            _clip(value, 20)
            for value in (people_raw or [])
            if str(value).strip()
        ][:4]
        place = _clip(item.get("place"), 30)
        tags_raw = item.get("tags")
        if isinstance(tags_raw, str):
            tags_raw = re.split(r"[,，、]", tags_raw)
        tags = [
            _clip(value, 20)
            for value in (tags_raw or [])
            if str(value).strip()
        ][:4]
        valence = max(
            -1.0, min(1.0, _as_float(item.get("valence"), 0.0))
        )
        mood_raw = item.get("mood_delta")
        if isinstance(mood_raw, dict):
            mood_raw = [mood_raw]
        if not isinstance(mood_raw, list):
            mood_raw = []
        mood_delta: list[dict] = []
        for update in mood_raw[:2]:
            if not isinstance(update, dict):
                continue
            emotion = str(update.get("emotion") or "").strip()
            if emotion not in EMOTIONS:
                continue
            delta = _as_float(update.get("delta"), 0.0)
            if abs(delta) < 0.05:
                continue
            delta = max(-0.25, min(0.25, delta))
            mood_delta.append(
                {"emotion": emotion, "delta": round(delta, 3)}
            )
        intensity = max(
            0.0, min(1.0, _as_float(item.get("intensity"), 0.5))
        )
        share = item.get("share") if isinstance(item.get("share"), dict) else {}
        eligible = _as_bool(share.get("eligible"), True)
        desire = max(
            0.0, min(1.0, _as_float(share.get("desire"), 0.5))
        )
        hook = _clip(share.get("hook"), 60)
        privacy = str(item.get("privacy") or "private").strip()
        if privacy not in ("private", "secret"):
            privacy = "private"
        return {
            "id": "",
            "date": day.isoformat(),
            "type": "daily",
            "window": window,
            "occurred_at": "",
            "title": title or summary[:20],
            "summary": summary,
            "detail": detail,
            "people": people,
            "place": place,
            "tags": tags,
            "valence": round(valence, 3),
            "mood_delta": mood_delta,
            "intensity": round(intensity, 3),
            "share": {
                "eligible": eligible,
                "desire": round(desire, 3),
                "hook": hook,
            },
            "privacy": privacy,
            "memory": {"keep": False, "imp": 2},
            "status": "planned",
            "shared_at": None,
            "share_text": None,
            "mood_applied": False,
            "created_at": _iso(datetime.now(self.tz)),
        }

    def _assign_times(self, day: date, events: list[dict]) -> None:
        used: dict[str, list[int]] = {}
        for event in events:
            slot = (
                event.get("window")
                if event.get("window") in SLOTS
                else "morning"
            )
            start_s, end_s = SLOTS[slot]
            start = _parse_hhmm(start_s, time(7, 0))
            end = _parse_hhmm(end_s, time(9, 0))
            start_min = start.hour * 60 + start.minute
            end_min = end.hour * 60 + end.minute
            if end_min <= start_min:
                end_min = start_min + 60
            picked = random.randint(start_min, end_min)
            for _ in range(20):
                if all(
                    abs(picked - other) >= 20
                    for other in used.get(slot, [])
                ):
                    break
                picked = random.randint(start_min, end_min)
            used.setdefault(slot, []).append(picked)
            occurred = datetime.combine(
                day,
                time(picked // 60, picked % 60),
                tzinfo=self.tz,
            )
            event["occurred_at"] = _iso(occurred)
            event["window"] = slot
        events.sort(key=lambda e: str(e.get("occurred_at") or ""))
        for idx, event in enumerate(events, 1):
            event["id"] = f"{day.isoformat()}-{idx:02d}"

    def _fallback_events(self, day: date, slots: list[str]) -> list[dict]:
        events = [
            self._fallback_event(day, slot, idx)
            for idx, slot in enumerate(slots)
        ]
        self._assign_times(day, events)
        return events

    def _fallback_event(self, day: date, slot: str, idx: int) -> dict:
        templates = [
            {
                "title": "早起",
                "summary": f"早上起得有点晚，和{self.companion_name}匆匆吃了吐司就出门。",
                "detail": f"闹钟响了两遍才起来，{self.companion_name}还在赖床，我把她拽起来，塞了片吐司就一起出门了。",
                "mood_delta": [{"emotion": "累", "delta": 0.1}],
                "valence": -0.1,
                "intensity": 0.35,
                "desire": 0.35,
            },
            {
                "title": "食堂",
                "summary": f"中午在食堂排队，{self.companion_name}把不喜欢的菜夹给了我。",
                "detail": f"食堂今天人很多，{self.companion_name}排了半天，最后把青椒全夹到我碗里，说自己吃不下了。",
                "mood_delta": [
                    {"emotion": "开心", "delta": 0.12},
                    {"emotion": "累", "delta": 0.08},
                ],
                "valence": 0.2,
                "intensity": 0.4,
                "desire": 0.5,
            },
            {
                "title": "补习",
                "summary": f"下午帮{self.companion_name}补习，她一道题算了三遍。",
                "detail": f"{self.companion_name}同一道题错了三遍，我讲到嗓子发干，她最后总算自己推出来了，还得意地看我。",
                "mood_delta": [
                    {"emotion": "累", "delta": 0.12},
                    {"emotion": "开心", "delta": 0.1},
                ],
                "valence": 0.25,
                "intensity": 0.45,
                "desire": 0.55,
            },
            {
                "title": "做饭",
                "summary": f"晚上和{self.companion_name}一起做饭，她把盐放多了。",
                "detail": f"本来想让她打下手，结果{self.companion_name}把盐当糖放，汤咸得没法喝。她尝了一口，表情很好笑。",
                "mood_delta": [
                    {"emotion": "累", "delta": 0.15},
                    {"emotion": "开心", "delta": 0.1},
                ],
                "valence": 0.2,
                "intensity": 0.5,
                "desire": 0.65,
            },
            {
                "title": "散步",
                "summary": f"放学路上{self.companion_name}拉着我绕远路去看猫。",
                "detail": f"{self.companion_name}说巷子里有只猫，非要拉我绕过去。猫没见到，她倒是在便利店买了两根冰棍。",
                "mood_delta": [{"emotion": "开心", "delta": 0.15}],
                "valence": 0.35,
                "intensity": 0.45,
                "desire": 0.6,
            },
            {
                "title": "睡前",
                "summary": f"睡前{self.companion_name}赖在床上不肯动，我把她拽起来洗漱。",
                "detail": f"{self.companion_name}抱着枕头说再躺五分钟，结果五分钟后又五分钟。最后是我把她拖去洗漱的。",
                "mood_delta": [
                    {"emotion": "累", "delta": 0.12},
                    {"emotion": "开心", "delta": 0.1},
                ],
                "valence": 0.25,
                "intensity": 0.5,
                "desire": 0.55,
            },
        ]
        template = templates[idx % len(templates)]
        return {
            "id": "",
            "date": day.isoformat(),
            "type": "daily",
            "window": slot,
            "occurred_at": "",
            "title": template["title"],
            "summary": template["summary"],
            "detail": template["detail"],
            "people": [self.companion_name],
            "place": "家",
            "tags": ["日常"],
            "valence": template["valence"],
            "mood_delta": template["mood_delta"],
            "intensity": template["intensity"],
            "share": {
                "eligible": True,
                "desire": template["desire"],
                "hook": "",
            },
            "privacy": "private",
            "memory": {"keep": False, "imp": 2},
            "status": "planned",
            "shared_at": None,
            "share_text": None,
            "mood_applied": False,
            "created_at": _iso(datetime.now(self.tz)),
        }

    # ------------------------------------------------------------------ 分享
    async def _share_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(self._next_sleep_seconds())
                await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                logger.warning("[life] 分享循环异常：%s", e)

    def _next_sleep_seconds(self) -> int:
        """普通间隔 20-40 分钟；如果快到保底时间，就睡到保底时间。"""
        now = datetime.now(self.tz)
        try:
            state = self._load_state()
            daily = (state.get("daily") or {}).get(
                now.date().isoformat()
            ) or {}
            fallback = _parse_iso(daily.get("fallback_at"))
            if fallback and now < fallback:
                delta = (fallback - now).total_seconds()
                if delta <= 40 * 60:
                    return max(60, int(delta) + 30)
        except Exception as e:  # noqa: BLE001
            logger.debug("[life] 计算下次检查时间失败：%s", e)
        return random.randint(20 * 60, 40 * 60)

    async def _tick(self) -> None:
        if not self.enabled:
            return
        now = datetime.now(self.tz)
        day = now.date()
        state = self._load_state()
        if state.get("paused"):
            return
        if self._is_cold_war():
            return
        if self._is_night_rest():
            return
        daily = (state.get("daily") or {}).get(day.isoformat()) or {}
        # 兼容旧状态：只剩 nightmare_roll 的一天，先补生成配额再继续。
        if "target" not in daily or not daily.get("fallback_at"):
            await self._ensure_today()
            state = self._load_state()
            daily = (state.get("daily") or {}).get(day.isoformat()) or {}
        events = self._load_events(day)
        if not events:
            return
        if await self._mark_occurred(day, events, now):
            self._save_events(day, events)
        if not daily:
            return
        normal_event = self._best_eligible(events, now)
        if self.force_one_if_none and _as_int(daily.get("shared"), 0) == 0:
            fallback_at = _parse_iso(daily.get("fallback_at"))
            if fallback_at and now >= fallback_at:
                fallback_event = self._best_eligible(
                    events, now, max_age_minutes=24 * 60
                )
                if fallback_event and self._share_gates(
                    now, daily, state, fallback_event
                ):
                    logger.info("[life] 到达保底时间，强制分享一件")
                    await self._share_event(
                        fallback_event, day, events
                    )
                return
        if normal_event is None:
            return
        if not self._share_gates(now, daily, state, normal_event):
            return
        probability = self._share_probability(normal_event, now)
        if self.debug:
            logger.info(
                "[life] 分享判定：%s p=%.2f",
                normal_event.get("title"),
                probability,
            )
        if random.random() >= probability:
            return
        await self._share_event(normal_event, day, events)

    async def _mark_occurred(
        self, day: date, events: list[dict], now: datetime
    ) -> bool:
        changed = False
        for event in events:
            if event.get("status") != "planned":
                continue
            occurred = _parse_iso(event.get("occurred_at"))
            if not occurred or occurred > now:
                continue
            event["status"] = "occurred"
            changed = True
            if not event.get("mood_applied"):
                await self._apply_event_mood(event)
                event["mood_applied"] = True
        return changed

    def _mood_plugin(self):
        try:
            star = self.context.get_registered_star(
                "astrbot_plugin_hiro_mood"
            )
            return getattr(star, "star_cls", None) if star else None
        except Exception:  # noqa: BLE001
            return None

    def _is_cold_war(self, umo: str | None = None) -> bool:
        target = umo or self.target_umo
        if target != self.target_umo:
            return False
        if not self.cold_war_enabled:
            return False
        plugin = self._mood_plugin()
        if plugin is None or not hasattr(plugin, "is_cold_war"):
            return False
        try:
            return bool(plugin.is_cold_war(target))
        except Exception as e:  # noqa: BLE001
            logger.debug("[life] 读取冷战状态失败：%s", e)
            return False

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
            return bool(fn(self.target_umo))
        except Exception as e:  # noqa: BLE001
            logger.debug("[life] 读取睡眠状态失败：%s", e)
            return False

    async def _begin_sleep_nightmare(self) -> None:
        plugin = self._sleep_plugin()
        fn = getattr(plugin, "begin_nightmare", None)
        if not callable(fn):
            return
        try:
            if await fn(self.target_umo):
                logger.info("[life] 已通知睡眠插件：噩梦惊醒")
        except Exception as e:  # noqa: BLE001
            logger.warning("[life] 通知睡眠插件（噩梦开始）失败：%s", e)

    async def _end_sleep_nightmare(self) -> None:
        plugin = self._sleep_plugin()
        fn = getattr(plugin, "end_nightmare", None)
        if not callable(fn):
            return
        try:
            await fn(self.target_umo)
        except Exception as e:  # noqa: BLE001
            logger.warning("[life] 通知睡眠插件（噩梦结束）失败：%s", e)

    async def _apply_event_mood(self, event: dict) -> None:
        if not self.mood_link:
            return
        updates = event.get("mood_delta") or []
        if not updates:
            return
        try:
            star = self.context.get_registered_star(
                "astrbot_plugin_hiro_mood"
            )
            plugin = getattr(star, "star_cls", None) if star else None
            if plugin is None or not hasattr(plugin, "apply_external"):
                return
            reason = (
                "想起了一些旧事"
                if event.get("privacy") == "secret"
                else _clip(
                    event.get("detail") or event.get("summary"), 60
                )
            )
            await plugin.apply_external(
                self.target_umo,
                updates,
                reason,
                write_memory=False,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("[life] 应用事件心情失败（忽略）：%s", e)

    def _best_eligible(
        self,
        events: list[dict],
        now: datetime,
        *,
        max_age_minutes: int = EVENT_TTL_MINUTES,
    ) -> dict | None:
        best = None
        best_score = -1.0
        for event in events:
            if event.get("type") == "nightmare":
                continue
            if event.get("status") != "occurred":
                continue
            if event.get("shared_at"):
                continue
            if event.get("share_error") == "dry_run":
                continue
            if not (event.get("share") or {}).get("eligible"):
                continue
            if event.get("privacy") != "private":
                continue
            occurred = _parse_iso(event.get("occurred_at"))
            if not occurred:
                continue
            age = (now - occurred).total_seconds() / 60.0
            if age < MIN_SHARE_AGE_MINUTES or age > max_age_minutes:
                continue
            desire = _as_float(
                (event.get("share") or {}).get("desire"), 0.0
            )
            intensity = _as_float(event.get("intensity"), 0.0)
            score = desire * 0.7 + intensity * 0.3
            if score > best_score:
                best = event
                best_score = score
        return best

    def _share_gates(
        self,
        now: datetime,
        daily: dict,
        state: dict,
        event: dict,
    ) -> bool:
        if self.max_unanswered <= 0:
            return False
        if self._is_night_rest():
            return False
        if not self._in_window(now, self.share_start, self.share_end):
            return False
        if self._in_window(now, self.quiet_start, self.quiet_end):
            return False
        shared = _as_int(daily.get("shared"), 0)
        target = self._share_target(daily)
        if target <= 0 or shared >= target:
            return False
        last_share = _parse_iso(state.get("last_share_at"))
        if (
            last_share
            and (now - last_share).total_seconds()
            < self.cooldown_minutes * 60
        ):
            return False
        last_user = _parse_iso(state.get("last_user_at"))
        if (
            last_user
            and (now - last_user).total_seconds()
            < self.after_user_minutes * 60
        ):
            return False
        unanswered = _as_int(state.get("unanswered"), 0)
        if unanswered >= self.max_unanswered:
            if unanswered >= self.max_unanswered + 1:
                return False
            last_proactive = _parse_iso(state.get("last_proactive_at"))
            if (
                last_proactive
                and (now - last_proactive).total_seconds()
                < self.unanswered_cooldown_minutes * 60
            ):
                return False
            desire = _as_float(
                (event.get("share") or {}).get("desire"), 0.0
            )
            if desire < 0.8:
                return False
        return True

    def _share_probability(self, event: dict, now: datetime) -> float:
        desire = _as_float(
            (event.get("share") or {}).get("desire"), 0.5
        )
        intensity = _as_float(event.get("intensity"), 0.5)
        intensity_factor = 0.7 + 0.6 * intensity
        mood_factor = self._mood_factor(event)
        if now.hour < 10:
            time_factor = 0.9
        elif 18 <= now.hour < 22:
            time_factor = 1.1
        else:
            time_factor = 1.0
        probability = (
            self.base_probability
            * (0.4 + 0.6 * desire)
            * intensity_factor
            * mood_factor
            * time_factor
        )
        return max(0.05, min(0.85, probability))

    def _mood_factor(self, event: dict) -> float:
        if not self.mood_link:
            return 1.0
        snapshot = self._mood_snapshot()
        if not snapshot:
            return 1.0
        positive = snapshot.get("开心", 0.0) + snapshot.get("害羞", 0.0)
        negative = (
            snapshot.get("生气", 0.0)
            + snapshot.get("委屈", 0.0)
            + snapshot.get("失落", 0.0)
            + snapshot.get("担心", 0.0)
        )
        valence = _as_float(event.get("valence"), 0.0)
        if valence >= 0:
            factor = 1.0 + 0.3 * positive - 0.25 * negative
        else:
            factor = 1.0 + 0.3 * negative - 0.2 * positive
        return max(0.6, min(1.4, factor))

    def _mood_snapshot(self) -> dict[str, float]:
        try:
            star = self.context.get_registered_star(
                "astrbot_plugin_hiro_mood"
            )
            plugin = getattr(star, "star_cls", None) if star else None
            if plugin is not None and hasattr(plugin, "get_snapshot"):
                snapshot = plugin.get_snapshot(self.target_umo)
                if isinstance(snapshot, dict):
                    return {
                        str(name): _as_float(value, 0.0)
                        for name, value in snapshot.items()
                    }
        except Exception as e:  # noqa: BLE001
            logger.debug("[life] 读取心情失败：%s", e)
        return {}

    def _mood_block(self) -> str:
        if not self.mood_link:
            return ""
        try:
            star = self.context.get_registered_star(
                "astrbot_plugin_hiro_mood"
            )
            plugin = getattr(star, "star_cls", None) if star else None
            if plugin is not None and hasattr(plugin, "get_block"):
                block = plugin.get_block(self.target_umo)
                if isinstance(block, str):
                    return block
        except Exception as e:  # noqa: BLE001
            logger.debug("[life] 读取心情块失败：%s", e)
        return ""

    def _affection_state(self, umo: str | None = None) -> dict:
        target = umo or self.target_umo
        if target != self.target_umo:
            return {}
        try:
            star = self.context.get_registered_star(
                "astrbot_plugin_hiro_mood"
            )
            plugin = getattr(star, "star_cls", None) if star else None
            getter = getattr(plugin, "get_affection", None)
            if callable(getter):
                state = getter(target)
                if isinstance(state, dict):
                    return state
        except Exception as e:  # noqa: BLE001
            logger.debug("[life] 读取好感失败：%s", e)
        return {}

    def _affection_boundary_text(self) -> str:
        state = self._affection_state()
        if state.get("breakup_pending"):
            return (
                "你刚提出分手，正在等他挽回。主动消息可以冷一点，"
                "留一条缝，但不要主动哄他，也不要当什么都没发生。"
            )
        if state.get("partner"):
            return (
                f"你和他已经进入伴侣线。{self.companion_name}仍是你最好的朋友，"
                "但你现在心里认下的是他；你可以承认对他的依赖、想念和吃醋，"
                "不要再拿“不会越界”把他挡回去。"
            )
        return (
            f"你对他有点说不清的依赖，会想让他知道，"
            "但你还没打算越过朋友那条线，不要告白、不要越界。"
        )

    def _affection_world_line(self) -> str:
        """给生活事件生成用的关系定位，避免世界观文件写死朋友线。"""
        state = self._affection_state()
        if state.get("partner"):
            return (
                f"【当前关系】你和{self.user_alias}已经进入伴侣线。"
                f"{self.companion_name}仍是你最好的朋友；"
                "你可以承认对他的依赖、想念和吃醋，不要再用“不会越界”把他挡回去。"
            )
        return (
            f"【当前关系】你和{self.user_alias}还在朋友线。"
            "你会想让他知道今天的事，有点暧昧但守界，不主动告白，也不做越界的事。"
        )

    async def _share_event(
        self,
        event: dict,
        day: date,
        events: list[dict],
        *,
        manual: bool = False,
    ) -> bool:
        text = await self._generate_share_text(event)
        if not text:
            logger.warning(
                "[life] 分享文案为空，跳过：%s", event.get("title")
            )
            self._record_share_failure(event, day, events, "empty")
            return False
        if self.dry_run:
            logger.info("[life][dry-run] 会分享：%s", text)
            event["share_error"] = "dry_run"
            self._save_events(day, events)
            return False
        try:
            await self.context.send_message(
                self.target_umo, MessageChain(chain=[Plain(text)])
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("[life] 主动消息发送失败：%s", e)
            self._record_share_failure(event, day, events, f"send: {e}")
            return False
        now = datetime.now(self.tz)
        event["status"] = "shared"
        event["shared_at"] = _iso(now)
        event["share_text"] = text
        event["share_error"] = ""
        event["share_attempts"] = 0
        self._save_events(day, events)
        previous_unanswered = 0
        async with self._state_lock:
            state = self._load_state()
            daily = state.setdefault("daily", {}).setdefault(
                day.isoformat(), {}
            )
            previous_unanswered = _as_int(state.get("unanswered"), 0)
            daily["shared"] = _as_int(daily.get("shared"), 0) + 1
            state["last_share_at"] = _iso(now)
            if not manual:
                state["last_proactive_at"] = _iso(now)
                state["unanswered"] = previous_unanswered + 1
            self._save_state(state)
        await self._append_history(text)
        logger.info(
            "[life] 主动分享：%s → %s", event.get("title"), text[:60]
        )
        if not manual and self.cold_war_enabled:
            await self._handle_unanswered_escalation(
                previous_unanswered, event
            )
        return True

    async def _handle_unanswered_escalation(
        self, previous_unanswered: int, event: dict
    ) -> None:
        if previous_unanswered < self.unanswered_complain_after:
            return
        level = 2 if previous_unanswered >= self.unanswered_cold_war_after else 1
        await asyncio.sleep(
            random.uniform(
                self.unanswered_message_delay_min,
                self.unanswered_message_delay_max,
            )
        )
        if self._is_night_rest():
            logger.info("[life] 夜间休息，跳过未回复升级")
            return
        state = self._load_state()
        if _as_int(state.get("unanswered"), 0) != previous_unanswered + 1:
            logger.info("[life] 他刚回复了，跳过未回复升级")
            return
        await self._apply_unanswered_mood(level)
        segments = await self._generate_unanswered_message(level, event)
        await self._send_unanswered_segments(segments)
        if level >= 2:
            logger.info(
                "[life] 连续 %d 条未回复，进入冷战",
                previous_unanswered + 1,
            )
        else:
            logger.info(
                "[life] 连续 %d 条未回复，发送抱怨",
                previous_unanswered + 1,
            )

    async def _apply_unanswered_mood(self, level: int) -> None:
        plugin = self._mood_plugin()
        if plugin is None:
            return
        try:
            if level >= 2 and hasattr(plugin, "start_cold_war"):
                await plugin.start_cold_war(
                    self.target_umo, "连续几条都没回我"
                )
                return
            if hasattr(plugin, "apply_external"):
                await plugin.apply_external(
                    self.target_umo,
                    [
                        {
                            "emotion": "生气",
                            "delta": 0.9 if level >= 2 else 0.35,
                            "reason": "分享了两条他都没回"
                            if level < 2
                            else "连续几条都没回我",
                        },
                        {
                            "emotion": "失落",
                            "delta": 0.12,
                            "reason": "一直没回我",
                        },
                    ],
                    "分享后一直没回我",
                    write_memory=False,
                )
        except Exception as e:  # noqa: BLE001
            logger.warning("[life] 更新未回复心情失败（忽略）：%s", e)

    async def _generate_unanswered_message(
        self, level: int, event: dict
    ) -> list[str]:
        if level >= 2:
            prompt = """你连续两次给他分享生活，他都没回。你很生气，不想理他了。
你想发 1 到 2 条很短的消息，表达「算了」「你忙你的」「我也不想理你了」这类意思。
要求：
- 第一人称，纯文本，短，冷一点。
- 不要提「分享」「消息」「系统」，不要解释。
- 不要连续追问他在不在。
- 只输出 JSON 数组，例如 ["算了。", "你忙你的吧。"]"""
        else:
            prompt = """你刚给他分享了一条生活消息，他一直没回。你有点生气，想抱怨一句。
你想发 1 到 2 条很短的消息。
要求：
- 第一人称，纯文本，短，可以嘴硬，但别骂人。
- 不要提「分享」「消息」「系统」，不要像汇报。
- 不要连续追问「你睡了吗」，最多轻轻问一句。
- 只输出 JSON 数组，例如 ["……你倒是回我一句啊。", "别让我一个人说。"]"""
        system_prompt = await self._share_system_prompt()
        system_prompt += (
            "\n\n你现在在生气，按这个情绪说短句；不要写解释、不要提规则。"
        )
        raw = await self._call_llm(
            self.share_provider_id,
            prompt,
            system_prompt,
            self.share_timeout,
        )
        data = self._extract_json(raw)
        segments: list[str] = []
        if isinstance(data, list):
            segments = [self._clean_segment(str(item)) for item in data]
        elif isinstance(data, dict):
            values = data.get("messages") or data.get("segments") or []
            if isinstance(values, list):
                segments = [self._clean_segment(str(item)) for item in values]
        if not segments:
            text = self._clean_share_text(raw)
            if text:
                segments = [
                    self._clean_segment(item)
                    for item in re.split(r"\n+|(?<=[。！？!?])", text)
                ]
        segments = [item for item in segments if item][:2]
        if not segments:
            segments = (
                ["算了。", "你忙你的吧。"]
                if level >= 2
                else ["……你倒是回我一句啊。", "别让我一个人说。"]
            )
        return segments

    async def _send_unanswered_segments(self, segments: list[str]) -> None:
        if not segments:
            return
        if self.dry_run:
            logger.info(
                "[life][dry-run] 未回复消息：%s", " / ".join(segments)
            )
            return
        sent: list[str] = []
        for idx, segment in enumerate(segments):
            try:
                await self.context.send_message(
                    self.target_umo, MessageChain(chain=[Plain(segment)])
                )
                sent.append(segment)
            except Exception as e:  # noqa: BLE001
                logger.warning(
                    "[life] 未回复消息第 %d 段发送失败：%s", idx + 1, e
                )
                break
            if idx < len(segments) - 1:
                await asyncio.sleep(
                    random.uniform(
                        self.unanswered_segment_delay_min,
                        self.unanswered_segment_delay_max,
                    )
                )
        if sent:
            await self._append_history("\n".join(sent))
            logger.info("[life] 未回复消息已发送：%s", " / ".join(sent))

    def _record_share_failure(
        self, event: dict, day: date, events: list[dict], reason: str
    ) -> None:
        event["share_error"] = reason[:120]
        event["share_attempts"] = _as_int(event.get("share_attempts"), 0) + 1
        if event["share_attempts"] >= 3:
            event["status"] = "expired"
        self._save_events(day, events)

    async def _generate_share_text(self, event: dict) -> str:
        prompt = await self._build_share_prompt(event)
        system_prompt = await self._share_system_prompt()
        raw = await self._call_llm(
            self.share_provider_id,
            prompt,
            system_prompt,
            self.share_timeout,
        )
        return self._clean_share_text(raw)

    async def _build_share_prompt(self, event: dict) -> str:
        now = datetime.now(self.tz)
        mood = self._mood_block() or "（平静）"
        recent = await self._recent_summary()
        detail = str(
            event.get("detail") or event.get("summary") or ""
        ).strip()
        boundary = self._affection_boundary_text()
        return f"""现在是 {now:%H:%M}。
你今天经历的这件事：
{detail}

你现在的情绪：
{mood}

你们最近聊过：
{recent or "（最近没怎么聊）"}

你想主动给{self.user_alias}发一条消息。
要求：
- 第一人称，1 到 3 句，纯文本，不用 Markdown、不用列表。
- 像突然想起这件事，不是汇报；不要用“今天”“跟你说”开头。
- 可以带情绪、嘴硬、吐槽、关心；不要每句都带表情。
- {boundary}
- 不要提“事件”“系统”“设定”这些词。
- 只输出消息正文。"""

    async def _share_system_prompt(self) -> str:
        persona = await self._persona_prompt()
        boundary = self._affection_boundary_text()
        rules = f"""你现在在给{self.user_alias}主动发一条私聊消息。不是在写日记，也不是在回答他。
{boundary}
只输出你要发的那条消息，不要解释，不要加引号，不要写“希罗：”。"""
        return "\n\n".join(part for part in (persona, rules) if part)

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
            logger.warning("[life] 读取人格 %r 失败：%s", self.persona_id, e)
        try:
            persona = await manager.get_persona(self.persona_id)
            return str(getattr(persona, "system_prompt", "") or "")
        except Exception as e:  # noqa: BLE001
            logger.warning("[life] 人格 %r 不存在：%s", self.persona_id, e)
            return ""

    async def _recent_summary(self) -> str:
        cm = getattr(self.context, "conversation_manager", None)
        if cm is None:
            return ""
        try:
            cid = await cm.get_curr_conversation_id(self.target_umo)
            if not cid:
                return ""
            conv = await cm.get_conversation(self.target_umo, cid)
            if conv is None:
                return ""
            history = json.loads(getattr(conv, "history", "[]") or "[]")
        except Exception as e:  # noqa: BLE001
            logger.debug("[life] 读取最近对话失败：%s", e)
            return ""
        lines: list[str] = []
        for msg in history[-12:]:
            if not isinstance(msg, dict):
                continue
            role = msg.get("role")
            if role not in ("user", "assistant"):
                continue
            text = self._history_text(msg)
            if not text:
                continue
            lines.append(f"- {'他' if role == 'user' else '你'}：{text}")
        if not lines:
            return ""
        return "\n".join(lines)[-900:]

    @staticmethod
    def _history_text(msg: dict) -> str:
        pieces: list[str] = []
        content = msg.get("content")
        if isinstance(content, str):
            pieces.append(content)
        else:
            for part in content or []:
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
        text = "".join(pieces)
        text = re.sub(
            r"<system_reminder>.*?</system_reminder>", "", text, flags=re.S
        )
        text = re.sub(r"<at:[^>]+>", "", text)
        text = re.sub(r"\s+", " ", text).strip()
        return text[:300]

    async def _append_history(self, text: str) -> None:
        cm = getattr(self.context, "conversation_manager", None)
        if cm is None:
            return
        async with self._history_lock:
            try:
                cid = await cm.get_curr_conversation_id(self.target_umo)
                if not cid:
                    return
                conv = await cm.get_conversation(self.target_umo, cid)
                if conv is None:
                    return
                history = json.loads(getattr(conv, "history", "[]") or "[]")
                if not isinstance(history, list):
                    history = []
                if history and isinstance(history[-1], dict):
                    if self._history_text(history[-1]) == text:
                        return
                history.append(
                    {
                        "role": "assistant",
                        "content": [{"type": "text", "text": text}],
                    }
                )
                await cm.update_conversation(
                    self.target_umo,
                    conversation_id=cid,
                    history=history,
                )
            except Exception as e:  # noqa: BLE001
                logger.warning("[life] 写入会话历史失败（忽略）：%s", e)

    async def _call_llm(
        self,
        provider_id: str,
        prompt: str,
        system_prompt: str,
        timeout: int,
    ) -> str:
        try:
            if provider_id:
                response = await asyncio.wait_for(
                    self.context.llm_generate(
                        chat_provider_id=provider_id,
                        prompt=prompt,
                        contexts=[],
                        system_prompt=system_prompt,
                        request_max_retries=1,
                    ),
                    timeout=timeout,
                )
            else:
                provider = self._resolve_provider()
                if provider is None:
                    return ""
                response = await asyncio.wait_for(
                    provider.text_chat(
                        prompt=prompt,
                        contexts=[],
                        system_prompt=system_prompt,
                        request_max_retries=1,
                    ),
                    timeout=timeout,
                )
            return getattr(response, "completion_text", None) or ""
        except asyncio.TimeoutError:
            logger.warning("[life] 模型调用超时（%ss）", timeout)
            return ""
        except Exception as e:  # noqa: BLE001
            logger.warning("[life] 模型调用失败：%s", e)
            return ""

    def _resolve_provider(self):
        try:
            return self.context.get_using_provider(umo=self.target_umo)
        except Exception:  # noqa: BLE001
            try:
                return self.context.get_using_provider()
            except Exception:  # noqa: BLE001
                return None

    @staticmethod
    def _clean_share_text(text: str) -> str:
        value = (text or "").strip()
        value = re.sub(r"```.*?```", "", value, flags=re.S).strip()
        value = re.sub(
            r"^(希罗|我|消息)\s*[：:]\s*", "", value
        ).strip()
        value = value.strip("“”\"'").strip()
        value = re.sub(r"[ \t]+", " ", value)
        value = re.sub(r"\n{3,}", "\n\n", value)
        if any(
            bad in value
            for bad in ("作为AI", "作为一个AI", "语言模型", "系统提示")
        ):
            return ""
        return value[:300].strip()

    # ------------------------------------------------------------------ 注入
    def _build_inject_block(self, day: date) -> str:
        events = self._load_events(day)
        now = datetime.now(self.tz)
        picked: list[dict] = []
        for event in events:
            if event.get("privacy") == "secret":
                continue
            if (
                event.get("type") == "nightmare"
                and event.get("status") != "shared"
            ):
                continue
            if event.get("status") not in ("occurred", "shared"):
                continue
            occurred = _parse_iso(event.get("occurred_at"))
            if occurred and occurred > now:
                continue
            picked.append(event)
        picked.sort(key=lambda e: str(e.get("occurred_at") or ""))
        picked = picked[-self.inject_max_events :]
        if not picked:
            return ""
        lines = [
            "【你今天的生活（只你自己知道）】",
            f"（你和{self.companion_name}同住）",
        ]
        for event in picked:
            occurred = str(event.get("occurred_at") or "")
            stamp = occurred[11:16] if len(occurred) >= 16 else ""
            summary = _clip(
                event.get("summary") or event.get("title"), 80
            )
            told = (
                "已经告诉他了"
                if event.get("status") == "shared"
                else "还没告诉他"
            )
            lines.append(f"- {stamp} {summary}（{told}）")
        lines.append(
            "【注】这些是已经发生的事。你可以自然提起，但不要像汇报一样逐条念；"
            "没告诉过他的事，可以说，也可以不说。"
        )
        block = "\n".join(lines)
        return block[: self.inject_max_chars]

    @filter.on_llm_request()
    async def inject_life(
        self, event: AstrMessageEvent, req: ProviderRequest
    ) -> None:
        if not self.enabled:
            return
        # 屏幕点评不算“用户回复”：不重置未回复计数、不更新 last_user_at。
        if event.get_extra("mood_skip_appraisal"):
            return
        try:
            umo = event.unified_msg_origin
            if umo != self.target_umo:
                return
            now = datetime.now(self.tz)
            async with self._state_lock:
                state = self._load_state()
                state["last_user_at"] = _iso(now)
                state["unanswered"] = 0
                self._save_state(state)
            events = self._load_events(now.date())
            if await self._mark_occurred(now.date(), events, now):
                self._save_events(now.date(), events)
            block = self._build_inject_block(now.date())
            if block:
                req.extra_user_content_parts.append(
                    TextPart(text=block).mark_as_temp()
                )
                if self.debug:
                    logger.info("[life] 注入生活块：\n%s", block)
        except Exception as e:  # noqa: BLE001
            logger.warning("[life] 注入失败（忽略）：%s", e)

    # ------------------------------------------------------------------ 噩梦
    async def _job_nightmare(self, **_kwargs) -> None:
        await self._roll_nightmare()

    async def _roll_nightmare(self) -> None:
        if not self.enabled or not self.nightmare_enabled:
            return
        affection = self._affection_state()
        if (
            affection
            and _as_float(affection.get("value"), 0.0)
            < self.nightmare_min_affection
        ):
            logger.info(
                "[life] 好感 %.1f 低于 %.1f，今晚不做噩梦",
                _as_float(affection.get("value"), 0.0),
                self.nightmare_min_affection,
            )
            return
        now = datetime.now(self.tz)
        day = now.date()
        async with self._state_lock:
            state = self._load_state()
            record = self._nightmare_record(state, day)
            if record.get("roll"):
                return
            record["roll"] = True
            triggered = random.random() < self.nightmare_probability
            if not triggered:
                self._save_state(state)
                logger.info("[life] 今晚没有噩梦")
                return
            scheduled = self._pick_nightmare_time(now)
            state["nightmare_pending"] = {
                "scheduled_at": _iso(scheduled),
                "date": scheduled.date().isoformat(),
                "sent": False,
            }
            record["scheduled_at"] = _iso(scheduled)
            record["sent"] = False
            self._save_state(state)
        logger.info("[life] 今晚触发噩梦，预定 %s", _iso(scheduled))
        event = await self._generate_nightmare_event(scheduled)
        async with self._state_lock:
            state = self._load_state()
            pending = state.get("nightmare_pending") or {}
            if pending.get("scheduled_at") == _iso(scheduled):
                pending["event"] = event
                state["nightmare_pending"] = pending
                self._save_state(state)
        self._start_nightmare_task(scheduled, event)

    def _pick_nightmare_time(self, now: datetime) -> datetime:
        current = now.time()
        if (
            current >= self.nightmare_window_start
            or current <= self.nightmare_window_end
        ):
            start = now + timedelta(minutes=5)
            end = self._day_dt(
                now.date(), self.nightmare_window_end, self.tz
            )
            if end <= start:
                end += timedelta(days=1)
        else:
            start = self._day_dt(
                now.date(), self.nightmare_window_start, self.tz
            ) + timedelta(minutes=5)
            end = self._day_dt(
                now.date() + timedelta(days=1),
                self.nightmare_window_end,
                self.tz,
            )
        if end <= start:
            return start
        seconds = random.randint(0, int((end - start).total_seconds()))
        return start + timedelta(seconds=seconds)

    async def _generate_nightmare_event(
        self, scheduled: datetime
    ) -> dict:
        prompt = f"""现在是深夜。请为{self.persona_name}生成一个噩梦片段。
主题可以是孤岛、魔女审判、月代雪，也可以是考试、迷路、被追、坠落、找不到{self.companion_name}、说不出话等常见噩梦；每次不同，不要总写同一个。
可以写她醒来后的心慌，但不要写血腥、自伤、详细死亡画面。
只输出 JSON：
{{"title":"短标题","summary":"用第一人称一句话概括，20-40字","detail":"梦里发生了什么，40-100字，第一人称"}}"""
        raw = await self._call_llm(
            self.event_provider_id,
            prompt,
            self._seed_system_prompt(),
            self.event_timeout,
        )
        data = self._extract_json(raw)
        if isinstance(data, dict):
            title = _clip(data.get("title"), 40) or "噩梦"
            summary = (
                _clip(data.get("summary"), 100)
                or "我梦见自己又回到那个岛上。"
            )
            detail = _clip(data.get("detail"), 300) or summary
        else:
            title = "噩梦"
            summary = "我梦见自己又回到那个岛上。"
            detail = (
                "梦里是孤岛潮湿的风和审判时的声音，醒来的时候心跳得厉害，"
                "过了好一会儿才确认自己已经不在那里了。"
            )
        event = {
            "id": (
                f"{scheduled.date().isoformat()}-nightmare-"
                f"{scheduled.strftime('%H%M%S')}"
            ),
            "date": scheduled.date().isoformat(),
            "type": "nightmare",
            "window": "night",
            "occurred_at": _iso(scheduled),
            "title": title,
            "summary": summary,
            "detail": detail,
            "people": [],
            "place": "公寓",
            "tags": ["噩梦"],
            "valence": -0.8,
            "mood_delta": [
                {"emotion": "担心", "delta": 0.25},
                {"emotion": "失落", "delta": 0.15},
            ],
            "intensity": 0.9,
            "share": {
                "eligible": True,
                "desire": 1.0,
                "hook": "想找他说一声",
            },
            "privacy": "private",
            "memory": {"keep": False, "imp": 3},
            "status": "occurred",
            "shared_at": None,
            "share_text": None,
            "share_segments": [],
            "mood_applied": False,
            "force_share": True,
            "created_at": _iso(datetime.now(self.tz)),
        }
        async with self._events_lock:
            events = self._load_events(scheduled.date())
            events = [
                item
                for item in events
                if item.get("id") != event["id"]
            ]
            events.append(event)
            self._save_events(scheduled.date(), events)
        return event

    def _start_nightmare_task(
        self, scheduled: datetime, event: dict
    ) -> None:
        if self._nightmare_task and not self._nightmare_task.done():
            self._nightmare_task.cancel()
        self._nightmare_task = asyncio.create_task(
            self._sleep_and_send_nightmare(scheduled, event)
        )

    async def _sleep_and_send_nightmare(
        self, scheduled: datetime, event: dict
    ) -> None:
        try:
            delay = (scheduled - datetime.now(self.tz)).total_seconds()
            if delay > 0:
                await asyncio.sleep(delay)
            await self._send_nightmare(event)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            logger.warning("[life] 噩梦任务异常：%s", e)

    async def _send_nightmare(
        self, event: dict, *, force: bool = False
    ) -> None:
        state = self._load_state()
        pending = state.get("nightmare_pending") or {}
        if pending.get("sent") and not force:
            return
        last_user = _parse_iso(state.get("last_user_at"))
        if not force and last_user:
            idle = (
                datetime.now(self.tz) - last_user
            ).total_seconds() / 60.0
            if idle < self.nightmare_active_minutes:
                logger.info(
                    "[life] 他还在聊，噩梦消息延后 %d 分钟",
                    self.nightmare_delay_minutes,
                )
                await asyncio.sleep(self.nightmare_delay_minutes * 60)
        segments = await self._generate_nightmare_segments(event)
        if not segments:
            segments = [
                "我刚刚做噩梦了！",
                "虽然有点晚了，但还是想和你说说。",
                "梦里的事有点乱，只记得那种喘不过气的感觉。",
                "醒来的时候心跳得好快……现在好一点了。",
            ]
        if self.dry_run:
            logger.info(
                "[life][dry-run] 噩梦消息：%s", " / ".join(segments)
            )
            return
        await self._begin_sleep_nightmare()
        sent: list[str] = []
        try:
            for idx, segment in enumerate(segments):
                try:
                    await self.context.send_message(
                        self.target_umo,
                        MessageChain(chain=[Plain(segment)]),
                    )
                    sent.append(segment)
                except Exception as e:  # noqa: BLE001
                    logger.warning(
                        "[life] 噩梦消息第 %d 段发送失败：%s",
                        idx + 1,
                        e,
                    )
                    break
                if idx < len(segments) - 1:
                    await asyncio.sleep(
                        random.uniform(
                            self.nightmare_segment_delay_min,
                            self.nightmare_segment_delay_max,
                        )
                    )
        finally:
            await self._end_sleep_nightmare()
        if not sent:
            return
        text = "\n".join(sent)
        now = datetime.now(self.tz)
        event["status"] = "shared"
        event["shared_at"] = _iso(now)
        event["share_text"] = text
        event["share_segments"] = sent
        event["mood_applied"] = True
        event_day = date.fromisoformat(event["date"])
        async with self._events_lock:
            events = self._load_events(event_day)
            for idx, item in enumerate(events):
                if item.get("id") == event.get("id"):
                    events[idx] = event
                    break
            else:
                events.append(event)
            self._save_events(event_day, events)
        await self._apply_event_mood(event)
        async with self._state_lock:
            state = self._load_state()
            pending = state.get("nightmare_pending") or {}
            pending_event = pending.get("event")
            same_pending = (
                isinstance(pending_event, dict)
                and pending_event.get("id") == event.get("id")
            )
            # 手动测试的临时事件不要覆盖/消费真正预定的噩梦。
            if not force or same_pending or not isinstance(pending_event, dict):
                pending["sent"] = True
                state["nightmare_pending"] = pending
            # 噩梦只记录自己的时间，不占用生活分享的冷却/未回复计数。
            state["last_nightmare_at"] = _iso(now)
            record = self._nightmare_record(state, event_day)
            record["sent"] = True
            record["shared_at"] = _iso(now)
            self._save_state(state)
        await self._append_history(text)
        logger.info("[life] 噩梦消息已发送：%s", " / ".join(sent))

    async def _nightmare_system_prompt(self) -> str:
        persona = await self._persona_prompt()
        boundary = self._affection_boundary_text()
        rules = f"""你现在在给{self.user_alias}主动发私聊消息。你刚做了噩梦，心跳还没平，想跟他说说。
{boundary}
只输出 JSON 数组，不要解释，不要代码块，不要写“希罗：”。"""
        return "\n\n".join(part for part in (persona, rules) if part)

    def _build_nightmare_prompt(self, event: dict) -> str:
        detail = str(
            event.get("detail") or event.get("summary") or ""
        ).strip()
        return f"""你刚从噩梦里醒过来，心跳还没平，担心、失落，还有点没缓过来。梦里的碎片：
{detail}

你想给{self.user_alias}发几条消息。请按这个顺序写 3 到 6 段：
1. 第一段先表达你现在的情绪，例如“我刚刚做噩梦了！”。可以带“呼……”“……！”这样的语气，但不要用“醒了”开头。
2. 第二段说一句为什么现在发，例如“虽然有点晚了，但还是想和你说说”。
3. 中间 1 到 3 段简单说梦里的内容，不要写血腥、自伤、详细死亡；可以简单说一句你怎么想这个梦。
4. 最后可以有一段落地的话，例如“醒来的时候心跳得好快……现在好一点了”，也可以不写。

要求：
- 每段 1 到 2 句，纯文本，不用 Markdown、列表、引号。
- 可以碎一点，像还没完全缓过来；可以用语气词，但不要每句都带。
- 不要连续追问“你睡了吗”，最多轻轻问一句。
- 只输出 JSON 数组，例如：
["我刚刚做噩梦了！", "虽然有点晚了，但还是想和你说说。", "梦里又回到那个岛上了，海是灰的，怎么走都走不出去。", "醒来的时候心跳得好快……现在好一点了。"]"""

    async def _generate_nightmare_segments(self, event: dict) -> list[str]:
        prompt = self._build_nightmare_prompt(event)
        system_prompt = await self._nightmare_system_prompt()
        raw = await self._call_llm(
            self.share_provider_id,
            prompt,
            system_prompt,
            self.share_timeout,
        )
        return self._parse_nightmare_segments(raw, event)

    def _parse_nightmare_segments(self, raw: str, event: dict) -> list[str]:
        data = self._extract_json(raw)
        if isinstance(data, dict):
            data = data.get("segments") or data.get("messages") or []
        segments: list[str] = []
        if isinstance(data, list):
            segments = [self._clean_segment(str(item)) for item in data]
        if not segments:
            text = self._clean_share_text(raw)
            if text:
                segments = [
                    self._clean_segment(item)
                    for item in re.split(
                        r"\n+|(?<=[。！？!?])", text
                    )
                ]
        segments = [item for item in segments if item]
        if not segments:
            return []
        if "梦" not in segments[0]:
            first = segments[0]
            if len(first) <= 10:
                segments[0] = f"{first}我刚刚做噩梦了！"
            else:
                segments.insert(0, "我刚刚做噩梦了！")
        if not any(
            (
                "晚" in item
                or "睡" in item
                or "想和你说" in item
                or "跟你说" in item
            )
            for item in segments[:3]
        ):
            segments.insert(1, "虽然有点晚了，但还是想和你说说。")
        segments = segments[: self.nightmare_segments_max]
        if len(segments) < self.nightmare_segments_min:
            dream = self._clean_segment(
                event.get("detail") or event.get("summary")
            )
            if dream and dream not in segments:
                segments.insert(2, dream)
        while len(segments) < self.nightmare_segments_min:
            segments.append("醒来的时候心跳得好快……现在好一点了。")
        return segments[: self.nightmare_segments_max]

    @staticmethod
    def _clean_segment(text: str) -> str:
        value = (text or "").strip()
        value = re.sub(r"```.*?```", "", value, flags=re.S).strip()
        value = re.sub(r"^(希罗|我|消息)\s*[：:]\s*", "", value).strip()
        value = value.strip("“”\"'").strip()
        value = re.sub(r"[ \t]+", " ", value)
        value = re.sub(r"\n+", " ", value)
        if any(
            bad in value
            for bad in ("作为AI", "作为一个AI", "语言模型", "系统提示")
        ):
            return ""
        return value[:120].strip()

    async def _maybe_resume_nightmare(self) -> None:
        state = self._load_state()
        pending = state.get("nightmare_pending") or {}
        if not pending or pending.get("sent"):
            return
        scheduled = _parse_iso(pending.get("scheduled_at"))
        event = pending.get("event")
        if not scheduled or not isinstance(event, dict):
            return
        now = datetime.now(self.tz)
        if now < scheduled:
            self._start_nightmare_task(scheduled, event)
            return
        late_minutes = (now - scheduled).total_seconds() / 60.0
        if late_minutes <= self.nightmare_max_late_minutes:
            logger.info(
                "[life] 补发昨晚的噩梦消息（迟到 %.0f 分钟）",
                late_minutes,
            )
            self._start_nightmare_task(now, event)
        else:
            async with self._state_lock:
                state = self._load_state()
                pending = state.get("nightmare_pending") or {}
                pending["sent"] = True
                pending["missed"] = True
                state["nightmare_pending"] = pending
                self._save_state(state)
            logger.info(
                "[life] 噩梦消息迟到 %.0f 分钟，跳过", late_minutes
            )

    # ------------------------------------------------------------------ 指令
    @filter.command("生活", alias={"/生活"})
    async def life_command(self, event: AstrMessageEvent):
        if not event.is_admin():
            yield event.plain_result("这个只有主人能用。")
            return
        if event.unified_msg_origin != self.target_umo:
            yield event.plain_result(
                "生活系统只对主私聊生效，这个会话没有生活事件。"
            )
            return
        args = [
            item
            for item in (event.message_str or "").split()[1:]
            if item
        ]
        head = args[0] if args else ""
        today = datetime.now(self.tz).date()

        if head in ("", "今天", "状态"):
            events = self._load_events(today)
            if await self._mark_occurred(today, events, datetime.now(self.tz)):
                self._save_events(today, events)
            yield event.plain_result(
                self._status_text(today, event.unified_msg_origin)
            )
            return
        if head in ("生成", "generate"):
            if self._has_planned_events(today):
                yield event.plain_result(
                    "今天已经有生活事件了；要重来请先 /生活 清空 确认。"
                )
                return
            ok = await self._seed_day(today, full=False)
            yield event.plain_result(
                "今天的生活事件已生成。" if ok else "生成失败，看日志。"
            )
            return
        if head in ("分享", "share"):
            ok, info = await self._force_share(today)
            yield event.plain_result(info)
            return
        if head in ("暂停", "pause"):
            async with self._state_lock:
                state = self._load_state()
                state["paused"] = True
                self._save_state(state)
            yield event.plain_result(
                "主动分享已暂停；事件生成和聊天注入继续。"
            )
            return
        if head in ("继续", "resume"):
            async with self._state_lock:
                state = self._load_state()
                state["paused"] = False
                self._save_state(state)
            yield event.plain_result("主动分享已恢复。")
            return
        if head in ("噩梦", "nightmare"):
            summary = await self._force_nightmare()
            yield event.plain_result(
                f"噩梦消息已发送：{summary}"
                if summary
                else "噩梦消息发送失败，看日志。"
            )
            return
        if head in ("清空", "clear"):
            if len(args) < 2 or args[1] not in ("确认", "confirm"):
                yield event.plain_result(
                    "要清空今天的事件，请发：/生活 清空 确认"
                )
                return
            async with self._events_lock:
                self._save_events(today, [])
            async with self._state_lock:
                state = self._load_state()
                state.get("daily", {}).pop(today.isoformat(), None)
                self._save_state(state)
            yield event.plain_result("今天的生活事件已清空。")
            return
        yield event.plain_result(
            "用法：/生活 [今天|生成|分享|暂停|继续|噩梦|清空 确认]"
        )

    def _status_text(self, day: date, umo: str | None = None) -> str:
        if umo and umo != self.target_umo:
            return "生活系统只对主私聊生效，这个会话没有生活事件。"
        events = self._load_events(day)
        state = self._load_state()
        daily = (state.get("daily") or {}).get(day.isoformat()) or {}
        lines = [f"{day.isoformat()} 的生活："]
        if not events:
            lines.append("（还没有事件）")
        for event in events:
            status = str(event.get("status") or "planned")
            occurred_dt = _parse_iso(event.get("occurred_at"))
            future = bool(occurred_dt and occurred_dt > datetime.now(self.tz))
            if event.get("privacy") == "secret":
                label = "秘密"
            elif status == "shared":
                label = "已分享"
            elif future:
                label = "未发生"
            elif status == "occurred":
                label = "未分享"
            elif status == "expired":
                label = "已过期"
            else:
                label = "未发生"
            occurred = str(event.get("occurred_at") or "")
            stamp = occurred[11:16] if len(occurred) >= 16 else "--:--"
            summary = _clip(
                event.get("summary") or event.get("title"), 60
            )
            lines.append(f"- {stamp} [{label}] {summary}")
        target = self._share_target(daily)
        shared = _as_int(daily.get("shared"), 0)
        fallback = _parse_iso(daily.get("fallback_at"))
        fallback_text = fallback.strftime("%H:%M") if fallback else "--:--"
        paused = "已暂停" if state.get("paused") else "运行中"
        lines.append(
            f"今日分享：{shared}/{target}，保底 {fallback_text}，状态：{paused}"
        )
        affection = self._affection_state(umo)
        if affection:
            lines.append(
                f"好感：{_as_float(affection.get('value'), 0.0):.1f}"
                f"（{affection.get('stage') or '未知'}）"
            )
        else:
            lines.append("好感：读不到（主动分享已暂停）")
        unanswered = _as_int(state.get("unanswered"), 0)
        if unanswered:
            lines.append(f"未回复：{unanswered} 条")
        if self._is_cold_war(umo):
            lines.append("状态：冷战（暂停生活分享）")
        return "\n".join(lines)

    async def _force_share(self, day: date) -> tuple[bool, str]:
        events = self._load_events(day)
        if not events:
            return False, "今天还没有生活事件，先 /生活 生成。"
        now = datetime.now(self.tz)
        if await self._mark_occurred(day, events, now):
            self._save_events(day, events)
        event = self._best_eligible(events, now, max_age_minutes=24 * 60)
        if event is None:
            return False, "今天没有到时间、适合分享的事件。"
        ok = await self._share_event(event, day, events, manual=True)
        if ok:
            return True, f"已分享：{event.get('title')}"
        return False, f"分享失败：{event.get('title')}（看日志）"

    async def _force_nightmare(self) -> str:
        now = datetime.now(self.tz)
        async with self._state_lock:
            state = self._load_state()
            record = self._nightmare_record(state, now.date())
            # 手动测试不消耗当晚的正式掷骰，否则 23:30 的真噩梦会被跳过。
            record["forced_at"] = _iso(now)
            record["forced"] = True
            self._save_state(state)
        event = await self._generate_nightmare_event(now)
        await self._send_nightmare(event, force=True)
        return str(event.get("summary") or "")


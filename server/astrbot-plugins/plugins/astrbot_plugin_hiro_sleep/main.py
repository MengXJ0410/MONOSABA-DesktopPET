"""astrbot_plugin_hiro_sleep — 希罗酱的睡眠

给希罗一个会困、会睡、会被吵醒的作息：

- 每晚在配置的窗口里随机入睡，次日随机起床；
- 入睡前如果还在聊天，就按“最后一条对话 + 安静分钟数”顺延，
  最多顺延到原入睡点 + 上限，到上限就严重困倦、拒绝再聊、说晚安并强制睡；
- 睡眠中普通消息固定回 zzZ，超过阈值后第 N 条把她吵醒，正常回复；
- 被吵醒后一段时间没有对话就回睡，接近起床点则不再回睡；
- 起床后逐条补回睡眠期间没被正常回复的消息，每条只发一段；
- 好感过门槛才主动说晚安/早安，冷战和分手挽回期不主动问候；
- 睡眠状态会持久化，重启后恢复；
- 生活分享、日记分享、未回复升级在睡眠期间暂停，起床后补发日记。

只对配置的私聊 UMO 生效，群聊不受影响。所有跨插件调用都 fail-open。
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

PLUGIN_NAME = "astrbot_plugin_hiro_sleep"
DEFAULT_UMO = "Hiro:FriendMessage:1955272576"
DEFAULT_TZ = "Asia/Shanghai"

STATUS_AWAKE = "awake"
STATUS_DELAYING = "delaying"
STATUS_SLEEPING = "sleeping"
STATUS_WOKEN = "woken"
STATUS_NIGHTMARE = "nightmare"

SLEEP_STATUSES = {STATUS_SLEEPING, STATUS_WOKEN, STATUS_NIGHTMARE}
NIGHT_REST_STATUSES = {
    STATUS_DELAYING,
    STATUS_SLEEPING,
    STATUS_WOKEN,
    STATUS_NIGHTMARE,
}

_DATETIME_RE = re.compile(
    r"Current datetime:\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})?"
)


def _as_bool(value, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


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


def _parse_hhmm(value, default: time) -> time:
    text = str(value or "").strip()
    if not text:
        return default
    try:
        hour, minute = text.split(":", 1)
        return time(int(hour), int(minute))
    except (ValueError, TypeError):
        logger.warning("[sleep] 时间格式错误：%r，使用默认 %s", value, default)
        return default


def _iso(value: datetime | None) -> str:
    if value is None:
        return ""
    return value.isoformat(timespec="seconds")


def _parse_iso(value) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        return None
    return dt


def _clip(text, limit: int) -> str:
    value = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(value) <= limit:
        return value
    return value[: max(0, limit - 1)].rstrip() + "…"


def _normalize_reply(text) -> str:
    value = str(text or "").strip()
    value = re.sub(r"```.*?```", "", value, flags=re.S).strip()
    value = re.sub(r"^(希罗|我|消息|回复)\s*[：:]\s*", "", value)
    value = value.strip("“”\"'「」").strip()
    value = re.sub(r"\s+", " ", value)
    if any(
        bad in value
        for bad in ("作为AI", "作为一个AI", "语言模型", "系统提示", "睡眠系统")
    ):
        return ""
    return value[:240].strip()


@register(
    "astrbot_plugin_hiro_sleep",
    "MXJ",
    "希罗酱的睡眠：随机作息、zzZ、吵醒、起床补回",
    "0.1.4",
)
class HiroSleepPlugin(Star):
    def __init__(self, context: Context, config=None):
        super().__init__(context)
        self.config = config or {}

        self.enabled = _as_bool(self.config.get("enabled"), True)
        self.umo = str(self.config.get("umo") or DEFAULT_UMO).strip()
        tz_name = str(self.config.get("timezone") or DEFAULT_TZ).strip()
        try:
            self.tz = ZoneInfo(tz_name)
        except Exception:  # noqa: BLE001
            logger.warning("[sleep] 时区 %r 无效，使用 %s", tz_name, DEFAULT_TZ)
            self.tz = ZoneInfo(DEFAULT_TZ)

        self.sleep_start = _parse_hhmm(
            self.config.get("sleep_window_start"), time(22, 30)
        )
        self.sleep_end = _parse_hhmm(
            self.config.get("sleep_window_end"), time(0, 30)
        )
        self.wake_start = _parse_hhmm(
            self.config.get("wake_window_start"), time(6, 30)
        )
        self.wake_end = _parse_hhmm(
            self.config.get("wake_window_end"), time(8, 30)
        )

        self.quiet_minutes = max(
            1, _as_int(self.config.get("quiet_minutes"), 15)
        )
        self.max_delay_minutes = max(
            0, _as_int(self.config.get("max_delay_minutes"), 60)
        )
        self.wake_guard_minutes = max(
            1, _as_int(self.config.get("wake_guard_minutes"), 30)
        )
        self.sleep_reply = str(
            self.config.get("sleep_reply") or "zzZ"
        ).strip() or "zzZ"
        self.wake_after_messages = max(
            0, _as_int(self.config.get("wake_after_messages"), 5)
        )
        self.return_sleep_minutes = max(
            1, _as_int(self.config.get("return_sleep_minutes"), 5)
        )
        self.catchup_enabled = _as_bool(
            self.config.get("catchup_enabled"), True
        )
        self.catchup_max_messages = max(
            1, _as_int(self.config.get("catchup_max_messages"), 20)
        )

        self.tired_on_sleep = min(
            1.0, max(0.0, _as_float(self.config.get("tired_on_sleep"), 0.55))
        )
        self.tired_on_delay = min(
            1.0, max(0.0, _as_float(self.config.get("tired_on_delay"), 0.5))
        )
        self.tired_on_forced = min(
            1.0,
            max(
                0.61,
                _as_float(self.config.get("tired_on_forced"), 0.9),
            ),
        )
        self.tired_on_wake = min(
            1.0,
            max(
                0.61,
                _as_float(self.config.get("tired_on_wake"), 0.8),
            ),
        )
        self.tired_on_morning = min(
            1.0, max(0.0, _as_float(self.config.get("tired_on_morning"), 0.2))
        )

        self.greeting_affection_threshold = max(
            0.0,
            _as_float(
                self.config.get("greeting_affection_threshold"), 70.0
            ),
        )
        self.goodnight_enabled = _as_bool(
            self.config.get("goodnight_enabled"), True
        )
        self.goodmorning_enabled = _as_bool(
            self.config.get("goodmorning_enabled"), True
        )
        self.allow_commands = _as_bool(
            self.config.get("allow_commands"), True
        )
        self.generate_greetings = _as_bool(
            self.config.get("generate_greetings"), True
        )
        self.provider_id = str(
            self.config.get("provider_id") or ""
        ).strip()
        self.persona_id = str(
            self.config.get("persona_id") or "希罗"
        ).strip()
        self.persona_name = str(
            self.config.get("persona_name") or "希罗"
        ).strip()
        self.user_alias = str(
            self.config.get("user_alias") or "他"
        ).strip()
        self.generation_timeout = max(
            10, _as_int(self.config.get("generation_timeout"), 30)
        )
        self.diary_share_delay_seconds = max(
            0, _as_int(self.config.get("diary_share_delay_seconds"), 45)
        )
        self.diary_pre_sleep_minutes = max(
            0, _as_int(self.config.get("diary_pre_sleep_minutes"), 5)
        )
        self.debug = _as_bool(self.config.get("debug"), False)

        self.root = Path(get_astrbot_plugin_data_path()) / PLUGIN_NAME
        self.state_path = self.root / "sleep.json"
        self.state = self._load_state()

        self._lock = asyncio.Lock()
        self._history_lock = asyncio.Lock()
        self._tick_task: asyncio.Task | None = None
        self._post_wake_task: asyncio.Task | None = None
        self._tasks: set[asyncio.Task] = set()
        self._stopping = False
        self._diary_pre_sleep_running = False
        self._diary_pre_sleep_done: set[str] = set()
        self._persona_cache = ""

        logger.info(
            "[sleep] 已加载：umo=%s，入睡窗口 %s-%s，起床窗口 %s-%s，"
            "安静 %d 分钟，最多顺延 %d 分钟",
            self.umo,
            self.sleep_start.strftime("%H:%M"),
            self.sleep_end.strftime("%H:%M"),
            self.wake_start.strftime("%H:%M"),
            self.wake_end.strftime("%H:%M"),
            self.quiet_minutes,
            self.max_delay_minutes,
        )

    # ------------------------------------------------------------------ 生命周期
    async def initialize(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        if not self.enabled:
            logger.info("[sleep] 插件已关闭")
            return
        self._tick_task = asyncio.create_task(self._tick_loop())
        self._spawn(self._startup_restore())
        logger.info("[sleep] 睡眠循环已启动")

    async def terminate(self) -> None:
        self._stopping = True
        for task in (
            self._tick_task,
            self._post_wake_task,
            *list(self._tasks),
        ):
            if task and not task.done():
                task.cancel()
        self._tasks.clear()

    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._tasks.add(task)

        def _done(item: asyncio.Task) -> None:
            self._tasks.discard(item)
            try:
                item.result()
            except asyncio.CancelledError:
                pass
            except Exception as e:  # noqa: BLE001
                logger.warning("[sleep] 后台任务异常：%s", e)

        task.add_done_callback(_done)
        return task

    async def _startup_restore(self) -> None:
        try:
            await asyncio.sleep(5)
            async with self._lock:
                await self._restore_locked(datetime.now(self.tz))
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            logger.warning("[sleep] 启动恢复异常：%s", e)

    # ------------------------------------------------------------------ 状态
    def _new_state(self) -> dict:
        return {
            "version": 1,
            "cycle_date": "",
            "sleep_at": "",
            "wake_at": "",
            "status": STATUS_AWAKE,
            "status_since": "",
            "last_activity_at": "",
            "last_user_at": "",
            "last_bot_at": "",
            "sleep_msg_count": 0,
            "sleep_msgs": [],
            "wake_reason": "",
            "return_sleep_at": "",
            "goodnight_sent": False,
            "goodmorning_sent": False,
            "last_goodnight_date": "",
            "last_goodmorning_date": "",
            "nightmare_started_at": "",
            "forced": False,
            "updated": "",
        }

    def _load_state(self) -> dict:
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            data = None
        except Exception as e:  # noqa: BLE001
            logger.warning("[sleep] 读取睡眠状态失败：%s", e)
            data = None
        state = self._new_state()
        if isinstance(data, dict):
            state.update({k: data.get(k) for k in state if k in data})
        if not isinstance(state.get("sleep_msgs"), list):
            state["sleep_msgs"] = []
        if state.get("status") not in {
            STATUS_AWAKE,
            STATUS_DELAYING,
            STATUS_SLEEPING,
            STATUS_WOKEN,
            STATUS_NIGHTMARE,
        }:
            state["status"] = STATUS_AWAKE
        return state

    def _save_state_locked(self) -> None:
        try:
            self.state["updated"] = _iso(datetime.now(self.tz))
            self.root.mkdir(parents=True, exist_ok=True)
            tmp = self.state_path.with_suffix(".json.tmp")
            tmp.write_text(
                json.dumps(self.state, ensure_ascii=False, indent=1),
                encoding="utf-8",
            )
            os.replace(tmp, self.state_path)
        except Exception as e:  # noqa: BLE001
            logger.warning("[sleep] 保存睡眠状态失败：%s", e)

    def _save_state(self) -> None:
        self._save_state_locked()

    def _state_dt(self, key: str) -> datetime | None:
        value = _parse_iso(self.state.get(key))
        if value is None:
            return None
        return value.astimezone(self.tz)

    def _set_status_locked(self, status: str, now: datetime) -> None:
        if self.state.get("status") != status:
            if self.debug:
                logger.info(
                    "[sleep] 状态切换：%s → %s",
                    self.state.get("status"),
                    status,
                )
            self.state["status"] = status
            self.state["status_since"] = _iso(now)

    # ------------------------------------------------------------------ 时间与作息
    def _at(self, day: date, value: time) -> datetime:
        return datetime.combine(day, value, tzinfo=self.tz)

    def _span(
        self, day: date, start: time, end: time
    ) -> tuple[datetime, datetime]:
        first = self._at(day, start)
        second = self._at(day, end)
        if second <= first:
            second += timedelta(days=1)
        return first, second

    def _next_night_date(self, now: datetime) -> date:
        """当前/即将到来的那个夜晚属于哪一天。"""
        if now.time() >= self.sleep_start:
            return now.date()
        if now.time() <= self.wake_end:
            return now.date() - timedelta(days=1)
        return now.date()

    def _make_cycle(self, night_date: date) -> dict:
        sleep_start, sleep_end = self._span(
            night_date, self.sleep_start, self.sleep_end
        )
        total = max(0.0, (sleep_end - sleep_start).total_seconds())
        sleep_at = sleep_start + timedelta(
            seconds=random.uniform(0, total) if total > 0 else 0
        )

        wake_day = night_date + timedelta(days=1)
        wake_start_dt, wake_end_dt = self._span(
            wake_day, self.wake_start, self.wake_end
        )
        total_wake = max(
            0.0, (wake_end_dt - wake_start_dt).total_seconds()
        )
        wake_at = wake_start_dt + timedelta(
            seconds=random.uniform(0, total_wake) if total_wake > 0 else 0
        )

        if wake_at <= sleep_at + timedelta(hours=3):
            wake_at = sleep_at + timedelta(hours=4)

        return {
            "cycle_date": night_date.isoformat(),
            "sleep_at": _iso(sleep_at),
            "wake_at": _iso(wake_at),
        }

    def _ensure_cycle_locked(self, now: datetime) -> None:
        sleep_at = self._state_dt("sleep_at")
        wake_at = self._state_dt("wake_at")
        if (
            sleep_at is not None
            and wake_at is not None
            and now <= wake_at + timedelta(minutes=5)
        ):
            return

        night_date = self._next_night_date(now)
        cycle = self._make_cycle(night_date)
        candidate_wake = _parse_iso(cycle["wake_at"])
        if candidate_wake is not None and candidate_wake <= now + timedelta(
            minutes=5
        ):
            night_date = now.date()
            cycle = self._make_cycle(night_date)

        logger.info(
            "[sleep] 新作息：%s 夜 → 入睡 %s，起床 %s",
            cycle["cycle_date"],
            str(cycle["sleep_at"])[11:16],
            str(cycle["wake_at"])[11:16],
        )
        self.state.update(cycle)
        self.state["status"] = STATUS_AWAKE
        self.state["status_since"] = _iso(now)
        self.state["sleep_msg_count"] = 0
        self.state["sleep_msgs"] = []
        self.state["wake_reason"] = ""
        self.state["return_sleep_at"] = ""
        self.state["nightmare_started_at"] = ""
        self.state["goodnight_sent"] = False
        self.state["goodmorning_sent"] = False
        self.state["forced"] = False
        self._save_state_locked()

    def _near_wake(self, now: datetime, wake_at: datetime) -> bool:
        return now >= wake_at - timedelta(minutes=self.wake_guard_minutes)

    # ------------------------------------------------------------------ 状态机
    async def _tick_loop(self) -> None:
        while not self._stopping:
            try:
                await asyncio.sleep(30)
                await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                logger.warning("[sleep] 睡眠循环异常：%s", e)

    async def _tick(self) -> None:
        if not self.enabled:
            return
        async with self._lock:
            now = datetime.now(self.tz)
            self._ensure_cycle_locked(now)
            await self._evaluate_locked(now)
        await self._maybe_schedule_diary_pre_sleep(now)

    async def _evaluate_locked(self, now: datetime) -> None:
        sleep_at = self._state_dt("sleep_at")
        wake_at = self._state_dt("wake_at")
        if sleep_at is None or wake_at is None:
            return

        status = str(self.state.get("status") or STATUS_AWAKE)

        if now >= wake_at:
            if status in NIGHT_REST_STATUSES:
                await self._wake_up_locked(now)
            return

        if status == STATUS_AWAKE:
            if now >= sleep_at:
                await self._enter_night_locked(now, startup=False)
            return

        if status == STATUS_DELAYING:
            await self._enter_night_locked(now, startup=False)
            return

        if status in (STATUS_WOKEN, STATUS_NIGHTMARE):
            if self._near_wake(now, wake_at):
                return
            return_at = self._state_dt("return_sleep_at")
            if return_at is None:
                return_at = now + timedelta(minutes=self.return_sleep_minutes)
                self.state["return_sleep_at"] = _iso(return_at)
                self._save_state_locked()
            if now >= return_at:
                await self._return_to_sleep_locked(now)

    async def _enter_night_locked(
        self, now: datetime, *, startup: bool
    ) -> None:
        sleep_at = self._state_dt("sleep_at")
        wake_at = self._state_dt("wake_at")
        if sleep_at is None or wake_at is None or now >= wake_at:
            return

        last_activity = self._state_dt("last_activity_at")
        target = sleep_at
        if last_activity is not None and last_activity + timedelta(
            minutes=self.quiet_minutes
        ) > sleep_at:
            target = min(
                last_activity + timedelta(minutes=self.quiet_minutes),
                sleep_at + timedelta(minutes=self.max_delay_minutes),
            )

        hard_at = sleep_at + timedelta(minutes=self.max_delay_minutes)
        if now >= hard_at:
            recent = bool(
                last_activity is not None
                and (now - last_activity).total_seconds()
                <= max(30, self.quiet_minutes * 2) * 60
            )
            await self._begin_sleep_locked(
                now,
                forced=True,
                announce=(recent and not startup),
                keep_pending=True,
            )
            return

        if now >= target:
            await self._begin_sleep_locked(
                now,
                forced=False,
                announce=not startup,
                keep_pending=True,
            )
            return

        was_delaying = (
            str(self.state.get("status") or "") == STATUS_DELAYING
        )
        self._set_status_locked(STATUS_DELAYING, now)
        self.state["return_sleep_at"] = _iso(target)
        self._save_state_locked()
        if not was_delaying:
            await self._set_tired(self.tired_on_delay, "快到睡觉时间了")

    async def _begin_sleep_locked(
        self,
        now: datetime,
        *,
        forced: bool,
        announce: bool,
        keep_pending: bool,
    ) -> None:
        self._set_status_locked(STATUS_SLEEPING, now)
        self.state["sleep_msg_count"] = 0
        if not keep_pending:
            self.state["sleep_msgs"] = []
        self.state["wake_reason"] = ""
        self.state["return_sleep_at"] = ""
        self.state["nightmare_started_at"] = ""
        self.state["forced"] = bool(forced)
        self._save_state_locked()

        tired = self.tired_on_forced if forced else self.tired_on_sleep
        await self._set_tired(tired, "困得撑不住了" if forced else "准备睡了")
        if announce:
            self._spawn(self._send_goodnight(forced=forced))
        logger.info(
            "[sleep] 进入睡眠（%s）：%s，待补回 %d 条",
            "强制" if forced else "正常",
            now.strftime("%H:%M:%S"),
            len(self.state.get("sleep_msgs") or []),
        )

    async def _return_to_sleep_locked(self, now: datetime) -> None:
        self._set_status_locked(STATUS_SLEEPING, now)
        self.state["sleep_msg_count"] = 0
        self.state["return_sleep_at"] = ""
        self.state["wake_reason"] = ""
        self.state["nightmare_started_at"] = ""
        self.state["forced"] = False
        self._save_state_locked()
        await self._set_tired(self.tired_on_sleep, "又睡着了")
        logger.info("[sleep] 回睡（%s）", now.strftime("%H:%M:%S"))

    async def _wake_up_locked(self, now: datetime) -> None:
        was = str(self.state.get("status") or "")
        self._set_status_locked(STATUS_AWAKE, now)
        self.state["sleep_msg_count"] = 0
        self.state["return_sleep_at"] = ""
        self.state["wake_reason"] = ""
        self.state["nightmare_started_at"] = ""
        self.state["forced"] = False
        self.state["goodmorning_sent"] = False
        pending = [
            item
            for item in (self.state.get("sleep_msgs") or [])
            if isinstance(item, dict)
        ]
        self._save_state_locked()
        await self._set_tired(self.tired_on_morning, "睡醒了")

        cold_war = self._is_cold_war()
        if cold_war:
            pending = []
            self.state["sleep_msgs"] = []
            self._save_state_locked()
        logger.info(
            "[sleep] 起床（%s）：之前状态 %s，待补回 %d 条",
            now.strftime("%H:%M:%S"),
            was,
            len(pending),
        )
        self._schedule_post_wake(now, pending, cold_war=cold_war)

    async def _restore_locked(self, now: datetime) -> None:
        self._ensure_cycle_locked(now)
        if not self.state.get("last_activity_at"):
            inferred = await self._infer_last_activity()
            if inferred is not None:
                self.state["last_activity_at"] = _iso(inferred)
                self._save_state_locked()
        sleep_at = self._state_dt("sleep_at")
        wake_at = self._state_dt("wake_at")
        if sleep_at is None or wake_at is None:
            return
        status = str(self.state.get("status") or STATUS_AWAKE)

        if status in NIGHT_REST_STATUSES and now >= wake_at:
            await self._wake_up_locked(now)
            return

        if status == STATUS_SLEEPING:
            if now >= sleep_at:
                if self.debug:
                    logger.info("[sleep] 重启恢复：继续睡")
                return
            await self._wake_up_locked(now)
            return

        if status in (STATUS_WOKEN, STATUS_NIGHTMARE):
            if now >= sleep_at and not self._near_wake(now, wake_at):
                if not self.state.get("return_sleep_at"):
                    self.state["return_sleep_at"] = _iso(
                        now + timedelta(minutes=self.return_sleep_minutes)
                    )
                    self._save_state_locked()
                return
            await self._wake_up_locked(now)
            return

        if status == STATUS_DELAYING and now >= sleep_at:
            await self._enter_night_locked(now, startup=True)
            return

        if sleep_at <= now < wake_at:
            await self._enter_night_locked(now, startup=True)
        else:
            self._set_status_locked(STATUS_AWAKE, now)
            self._save_state_locked()

    # ------------------------------------------------------------------ 消息入口
    @filter.on_llm_request(priority=100)
    async def on_llm_request(
        self, event: AstrMessageEvent, req: ProviderRequest
    ) -> None:
        if not self.enabled:
            return
        # 屏幕点评等非对话回合：不更新 last_user_at、不计睡眠消息、不触发拖睡/吵醒。
        if event.get_extra("mood_skip_appraisal"):
            return
        try:
            umo = event.unified_msg_origin
            if umo != self.umo:
                return
            text = (event.message_str or "").strip()
            is_command = text.startswith("/") or text.startswith("#")
            if is_command:
                if text.startswith("/睡眠") or text.startswith("#睡眠"):
                    return
                if self.allow_commands:
                    return

            action, block = await self._handle_message(umo, text)
            if action == "zzz":
                try:
                    await self.context.send_message(
                        umo,
                        MessageChain(
                            chain=[Plain(self.sleep_reply or "zzZ")]
                        ),
                    )
                except Exception as e:  # noqa: BLE001
                    logger.warning("[sleep] 发送 zzZ 失败：%s", e)
                event.should_call_llm(False)
                event.stop_event()
                return
            if action == "forced_sleep":
                await self._send_goodnight(
                    forced=True,
                    context_text=text,
                    admin=False,
                )
                event.should_call_llm(False)
                event.stop_event()
                return
            if block:
                req.extra_user_content_parts.append(
                    TextPart(text=block).mark_as_temp()
                )
        except Exception as e:  # noqa: BLE001
            logger.warning("[sleep] 睡眠请求处理失败（放行）：%s", e)

    async def _handle_message(
        self, umo: str, text: str
    ) -> tuple[str, str]:
        """返回 (action, 注入块)。action: allow / zzz / forced_sleep。"""
        async with self._lock:
            if umo != self.umo:
                return "allow", ""
            now = datetime.now(self.tz)
            self._ensure_cycle_locked(now)
            status_before = str(self.state.get("status") or STATUS_AWAKE)
            if status_before in (
                STATUS_SLEEPING,
                STATUS_WOKEN,
                STATUS_NIGHTMARE,
            ):
                await self._evaluate_locked(now)
            sleep_at = self._state_dt("sleep_at")
            wake_at = self._state_dt("wake_at")
            if sleep_at is None or wake_at is None:
                return "allow", ""

            self.state["last_user_at"] = _iso(now)
            status = str(self.state.get("status") or STATUS_AWAKE)

            if status in (
                STATUS_AWAKE,
                STATUS_DELAYING,
                STATUS_WOKEN,
                STATUS_NIGHTMARE,
            ):
                self.state["last_activity_at"] = _iso(now)

            if status == STATUS_AWAKE and now >= sleep_at and now < wake_at:
                hard_at = sleep_at + timedelta(
                    minutes=self.max_delay_minutes
                )
                if now >= hard_at:
                    await self._begin_sleep_locked(
                        now,
                        forced=True,
                        announce=False,
                        keep_pending=True,
                    )
                    return "forced_sleep", ""
                await self._enter_night_locked(now, startup=False)
                status = str(self.state.get("status") or STATUS_AWAKE)
            elif status == STATUS_DELAYING:
                hard_at = sleep_at + timedelta(
                    minutes=self.max_delay_minutes
                )
                if now >= hard_at:
                    await self._begin_sleep_locked(
                        now,
                        forced=True,
                        announce=False,
                        keep_pending=True,
                    )
                    return "forced_sleep", ""
                await self._enter_night_locked(now, startup=False)
                status = str(self.state.get("status") or STATUS_AWAKE)

            if status == STATUS_DELAYING:
                hard_at = sleep_at + timedelta(
                    minutes=self.max_delay_minutes
                )
                if now >= hard_at:
                    await self._begin_sleep_locked(
                        now,
                        forced=True,
                        announce=False,
                        keep_pending=True,
                    )
                    return "forced_sleep", ""
                self.state["last_activity_at"] = _iso(now)
                self._save_state_locked()
                return (
                    "allow",
                    "【睡眠状态】你已经很困了，眼皮在打架，快到睡觉时间。"
                    "回复短一点、带一点困意，但不要提睡眠系统、规则或数值。",
                )

            if status == STATUS_SLEEPING:
                if self._is_cold_war():
                    # 冷战优先：不回复 zzZ，交给心情插件按冷战处理。
                    self._save_state_locked()
                    return "allow", ""
                previous = [
                    item
                    for item in (self.state.get("sleep_msgs") or [])
                    if isinstance(item, dict)
                ]
                self.state["sleep_msg_count"] = (
                    _as_int(self.state.get("sleep_msg_count"), 0) + 1
                )
                count = self.state["sleep_msg_count"]
                item = {
                    "text": _clip(text or "[非文字消息]", 500),
                    "at": _iso(now),
                }
                previous.append(item)
                self.state["sleep_msgs"] = previous[-50:]
                if count <= self.wake_after_messages:
                    self._save_state_locked()
                    if self.debug:
                        logger.info(
                            "[sleep] 睡眠中第 %d 条消息 → zzZ", count
                        )
                    return "zzz", ""

                # 第 N+1 条：把这一条从待补回里拿掉，因为马上正常回复。
                pending = [
                    entry
                    for entry in self.state.get("sleep_msgs") or []
                    if entry is not item
                ]
                self.state["sleep_msgs"] = pending[-50:]
                self.state["sleep_msg_count"] = 0
                self._set_status_locked(STATUS_WOKEN, now)
                self.state["wake_reason"] = "被吵醒"
                self.state["return_sleep_at"] = _iso(
                    now + timedelta(minutes=self.return_sleep_minutes)
                )
                self._save_state_locked()
                await self._set_tired(self.tired_on_wake, "被吵醒了")
                logger.info(
                    "[sleep] 被第 %d 条消息吵醒，待补回 %d 条",
                    count,
                    len(pending),
                )
                block = (
                    "【睡眠状态】你刚被消息吵醒，很累（累 0.8），"
                    "脑子还没完全清醒，可能有一点起床气。"
                    "回复短一点、慢一点，带困意；不要提睡眠系统、规则或数值。"
                    "睡眠期间还有几条消息没回，那些等早上再补，"
                    "这一轮不用逐条回应。"
                )
                return "allow", block

            if status in (STATUS_WOKEN, STATUS_NIGHTMARE):
                if not self._near_wake(now, wake_at):
                    self.state["return_sleep_at"] = _iso(
                        now + timedelta(minutes=self.return_sleep_minutes)
                    )
                self._save_state_locked()
                if status == STATUS_NIGHTMARE:
                    return (
                        "allow",
                        "【睡眠状态】你刚从噩梦里惊醒，心跳还没平，"
                        "现在能正常回他，但还很困。不要提睡眠系统、规则或数值。",
                    )
                return (
                    "allow",
                    "【睡眠状态】你还没完全醒，很累，"
                    "回复短一点、带困意。不要提睡眠系统、规则或数值。",
                )

            self._save_state_locked()
            return "allow", ""

    @filter.on_llm_response(priority=100)
    async def on_llm_response(self, event, resp) -> None:
        if not self.enabled:
            return
        try:
            if event.unified_msg_origin != self.umo:
                return
            now = datetime.now(self.tz)
            async with self._lock:
                self.state["last_activity_at"] = _iso(now)
                self.state["last_bot_at"] = _iso(now)
                status = str(self.state.get("status") or STATUS_AWAKE)
                if status in (STATUS_WOKEN, STATUS_NIGHTMARE):
                    wake_at = self._state_dt("wake_at")
                    if wake_at is None or not self._near_wake(now, wake_at):
                        self.state["return_sleep_at"] = _iso(
                            now
                            + timedelta(minutes=self.return_sleep_minutes)
                        )
                self._save_state_locked()
        except Exception as e:  # noqa: BLE001
            logger.warning("[sleep] 更新对话时间失败（忽略）：%s", e)

    # ------------------------------------------------------------------ 起床后
    def _schedule_post_wake(
        self,
        now: datetime,
        pending: list[dict],
        *,
        cold_war: bool,
    ) -> None:
        if self._post_wake_task and not self._post_wake_task.done():
            self._post_wake_task.cancel()
        self._post_wake_task = asyncio.create_task(
            self._post_wake(now, pending, cold_war=cold_war)
        )

    async def _post_wake(
        self,
        woke_at: datetime,
        pending: list[dict],
        *,
        cold_war: bool,
    ) -> None:
        try:
            now = datetime.now(self.tz)
            if now - woke_at > timedelta(hours=4):
                logger.info("[sleep] 起床已超过 4 小时，跳过补回")
                await self._clear_pending([])
                return

            if cold_war:
                logger.info("[sleep] 冷战中，不主动早安、不补回")
                await self._clear_pending([])
                return

            await self._persona_prompt()
            affection = self._affection_state()
            allow_greeting = (
                self.goodmorning_enabled
                and self._affection_above(affection)
                and not self._is_breakup_pending(affection)
                and now - woke_at <= timedelta(hours=2)
            )
            if pending and self.catchup_enabled:
                await self._send_catchup(pending, greet=allow_greeting)
            elif allow_greeting:
                await self._send_goodmorning()
            if pending and not self.catchup_enabled:
                logger.info("[sleep] 补回已关闭，丢弃 %d 条睡眠消息", len(pending))
                await self._clear_pending([])

            # 日记在睡眠期间只写不发，起床后补发。
            if self.diary_share_delay_seconds > 0:
                await asyncio.sleep(self.diary_share_delay_seconds)
            await self._share_pending_diary()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            logger.warning("[sleep] 起床后处理异常：%s", e)

    async def _clear_pending(self, remaining: list[dict]) -> None:
        async with self._lock:
            self.state["sleep_msgs"] = remaining[-50:]
            self._save_state_locked()

    async def _send_catchup(self, pending: list[dict], *, greet: bool) -> None:
        if not pending:
            return

        messages = pending[-self.catchup_max_messages :]
        if len(pending) > len(messages):
            logger.info(
                "[sleep] 睡眠消息 %d 条，只补回最近 %d 条",
                len(pending),
                len(messages),
            )
        lines = []
        for idx, item in enumerate(messages, 1):
            at = str(item.get("at") or "")
            stamp = at[11:16] if len(at) >= 16 else "--:--"
            lines.append(f"{idx}. [{stamp}] {item.get('text') or ''}")
        prompt = (
            f"你刚睡醒，看到{self.user_alias}在你睡觉时发来的消息。\n"
            "请按顺序逐条回复下面每条消息。\n"
            "规则：\n"
            "- 每条回复只写一段，不要分段，不要换行。\n"
            "- 每条 1 到 2 句，第一人称，口语，带一点刚醒的困意。\n"
            "- 不要提睡眠系统、规则、数值、zzZ，也不要解释你为什么没回。\n"
            + (
                "- 第一条可以顺带说一句早安，但不要单独多写一段。\n"
                if greet
                else ""
            )
            + "- 只输出 JSON 数组，元素是字符串，数量与消息数一致。\n\n"
            + "消息：\n"
            + "\n".join(lines)
            + "\n\n请输出 JSON 数组。"
        )
        raw = await self._call_llm(
            prompt,
            await self._catchup_system_prompt(),
        )
        replies = self._parse_catchup_replies(raw, len(messages))
        if not replies:
            replies = [
                "唔……这条我看到了，刚醒，脑子还有点慢。"
                for _ in messages
            ]

        sent_any = False
        for idx, text in enumerate(replies):
            if idx >= len(messages):
                break
            value = _normalize_reply(text)
            if not value:
                value = "唔……这条我看到了，刚醒，脑子还有点慢。"
            try:
                await self.context.send_message(
                    self.umo, MessageChain(chain=[Plain(value)])
                )
                await self._append_history(value)
                sent_any = True
            except Exception as e:  # noqa: BLE001
                logger.warning("[sleep] 补回第 %d 条发送失败：%s", idx + 1, e)
                break
            if idx < len(messages) - 1:
                await asyncio.sleep(random.uniform(1.2, 2.6))

        if sent_any:
            await self._clear_pending([])
            logger.info("[sleep] 已补回 %d 条睡眠消息", len(messages))
        else:
            logger.warning("[sleep] 补回消息全部发送失败，保留待补回")

    def _parse_catchup_replies(self, raw: str, count: int) -> list[str]:
        data = self._extract_json(raw)
        if isinstance(data, dict):
            data = data.get("replies") or data.get("messages")
        if not isinstance(data, list):
            return []
        replies: list[str] = []
        for item in data:
            value = _normalize_reply(item)
            if value:
                replies.append(value)
            if len(replies) >= count:
                break
        while len(replies) < count:
            replies.append("唔……这条我看到了，刚醒，脑子还有点慢。")
        return replies[:count]

    async def _catchup_system_prompt(self) -> str:
        persona = await self._persona_prompt()
        rules = f"""你是{self.persona_name}。你刚睡醒，正在回复{self.user_alias}在你睡觉时发来的消息。
只输出 JSON 数组，不要解释，不要代码块，不要写“希罗：”。"""
        return "\n\n".join(part for part in (persona, rules) if part)

    async def _send_goodnight(
        self,
        *,
        forced: bool = False,
        context_text: str = "",
        admin: bool = False,
    ) -> None:
        if not self.goodnight_enabled and not admin:
            return
        affection = self._affection_state()
        if not forced and not admin and not self._affection_above(affection):
            return
        if self._is_cold_war():
            logger.info("[sleep] 冷战中，不主动说晚安")
            return
        if self._is_breakup_pending(affection):
            logger.info("[sleep] 分手挽回期，不主动说晚安")
            return
        today = datetime.now(self.tz).date().isoformat()
        async with self._lock:
            if self.state.get("goodnight_sent"):
                return
            if str(self.state.get("last_goodnight_date") or "") == today:
                return
        text = await self._generate_greeting(
            "goodnight",
            forced=forced,
            context_text=context_text,
        )
        if not text:
            return
        try:
            await self.context.send_message(
                self.umo, MessageChain(chain=[Plain(text)])
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("[sleep] 晚安发送失败：%s", e)
            return
        await self._append_history(text)
        async with self._lock:
            self.state["goodnight_sent"] = True
            self.state["last_goodnight_date"] = today
            self._save_state_locked()
        logger.info("[sleep] 晚安：%s", text[:60])

    async def _send_goodmorning(self) -> None:
        if not self.goodmorning_enabled:
            return
        affection = self._affection_state()
        if not self._affection_above(affection):
            return
        if self._is_cold_war():
            return
        if self._is_breakup_pending(affection):
            return
        today = datetime.now(self.tz).date().isoformat()
        async with self._lock:
            if self.state.get("goodmorning_sent"):
                return
            if str(self.state.get("last_goodmorning_date") or "") == today:
                return
        text = await self._generate_greeting("goodmorning")
        if not text:
            return
        try:
            await self.context.send_message(
                self.umo, MessageChain(chain=[Plain(text)])
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("[sleep] 早安发送失败：%s", e)
            return
        await self._append_history(text)
        async with self._lock:
            self.state["goodmorning_sent"] = True
            self.state["last_goodmorning_date"] = today
            self._save_state_locked()
        logger.info("[sleep] 早安：%s", text[:60])

    async def _share_pending_diary(self) -> None:
        try:
            star = self.context.get_registered_star("astrbot_plugin_diary")
            plugin = getattr(star, "star_cls", None) if star else None
            fn = getattr(plugin, "share_pending", None)
            if callable(fn):
                await fn()
        except Exception as e:  # noqa: BLE001
            logger.warning("[sleep] 补发日记失败（忽略）：%s", e)

    # ------------------------------------------------------------------ 睡前日记
    def _diary_plugin(self):
        try:
            star = self.context.get_registered_star("astrbot_plugin_diary")
            return getattr(star, "star_cls", None) if star else None
        except Exception:  # noqa: BLE001
            return None

    def _effective_sleep_at(self) -> datetime | None:
        """当前这晚实际会睡的时间，包含聊天导致的延后。"""
        sleep_at = self._state_dt("sleep_at")
        if sleep_at is None:
            return None
        status = str(self.state.get("status") or "")
        if status == STATUS_DELAYING:
            return self._state_dt("return_sleep_at") or sleep_at
        if status in NIGHT_REST_STATUSES:
            return None
        last_activity = self._state_dt("last_activity_at")
        if last_activity is not None:
            delayed = last_activity + timedelta(minutes=self.quiet_minutes)
            if delayed > sleep_at:
                return min(
                    delayed,
                    sleep_at + timedelta(minutes=self.max_delay_minutes),
                )
        return sleep_at

    def _cycle_date(self) -> date | None:
        raw = str(self.state.get("cycle_date") or "")
        try:
            return date.fromisoformat(raw)
        except ValueError:
            return None

    async def _maybe_schedule_diary_pre_sleep(self, now: datetime) -> None:
        if self.diary_pre_sleep_minutes <= 0:
            return
        if self._diary_pre_sleep_running:
            return
        effective = self._effective_sleep_at()
        if effective is None:
            return
        target = effective - timedelta(minutes=self.diary_pre_sleep_minutes)
        if now < target or now >= effective:
            return
        diary = self._diary_plugin()
        if diary is None or not getattr(diary, "share_enabled", False):
            return
        cycle = self._cycle_date()
        if cycle is None:
            return
        if cycle.isoformat() in self._diary_pre_sleep_done:
            return
        getter = getattr(diary, "get_share_time", None)
        share_time = getter() if callable(getter) else None
        if share_time is not None:
            share_dt = datetime.combine(cycle, share_time, tzinfo=self.tz)
            if share_dt <= target:
                return
        self._diary_pre_sleep_running = True
        logger.info(
            "[sleep] 睡前分享日记：%s（睡前 %d 分钟，计划睡眠 %s）",
            cycle.isoformat(),
            self.diary_pre_sleep_minutes,
            effective.strftime("%H:%M"),
        )
        self._spawn(self._share_diary_before_sleep(cycle))

    async def _share_diary_before_sleep(self, cycle: date) -> None:
        try:
            diary = self._diary_plugin()
            if diary is None:
                return
            fn = getattr(diary, "share_for_date", None)
            if not callable(fn):
                return
            ok = await fn(cycle, force=True)
            if ok:
                self._diary_pre_sleep_done.add(cycle.isoformat())
                logger.info("[sleep] 睡前分享日记：%s", cycle.isoformat())
            else:
                logger.info(
                    "[sleep] 睡前分享日记未完成，睡前继续重试：%s",
                    cycle.isoformat(),
                )
        except Exception as e:  # noqa: BLE001
            logger.warning("[sleep] 睡前分享日记失败（忽略）：%s", e)
        finally:
            self._diary_pre_sleep_running = False

    # ------------------------------------------------------------------ 文案生成
    async def _generate_greeting(
        self,
        kind: str,
        *,
        forced: bool = False,
        context_text: str = "",
    ) -> str:
        fallback = (
            "……晚安。"
            if kind == "goodnight"
            else "……早。"
        )
        if forced:
            fallback = "……我真的撑不住了，晚安。"
        if not self.generate_greetings:
            return fallback
        affection = self._affection_state()
        stage = str(affection.get("stage") or "朋友")
        if kind == "goodnight":
            prompt = (
                f"现在是晚上，你要睡了。给{self.user_alias}发一条晚安。\n"
                f"你们现在的关系阶段：{stage}。\n"
                "只写 1 句话，第一人称，短，带一点困意；"
                "不要提睡眠系统、规则、数值或时间。"
            )
            if forced:
                prompt = (
                    f"你已经困到撑不住了，{self.user_alias}还在说话。"
                    "你要拒绝继续聊，说一句晚安。\n"
                    f"你们现在的关系阶段：{stage}。\n"
                    f"他刚才说：{_clip(context_text, 200)}\n"
                    "只写 1 到 2 句，第一人称，困、但不要凶；"
                    "不要提睡眠系统、规则或数值。"
                )
        else:
            prompt = (
                f"现在是早上，你刚醒。给{self.user_alias}发一条早安。\n"
                f"你们现在的关系阶段：{stage}。\n"
                "只写 1 句话，第一人称，短，带一点刚醒的迷糊；"
                "不要提睡眠系统、规则、数值或时间。"
            )
        system = (
            f"你是{self.persona_name}。不要写解释、不要提规则、"
            "不要用 Markdown。只输出正文。"
        )
        persona = await self._persona_prompt()
        if persona:
            system = persona + "\n\n" + system
        raw = await self._call_llm(prompt, system)
        text = _normalize_reply(raw)
        return text or fallback

    async def _call_llm(self, prompt: str, system_prompt: str) -> str:
        try:
            if self.provider_id:
                response = await asyncio.wait_for(
                    self.context.llm_generate(
                        chat_provider_id=self.provider_id,
                        prompt=prompt,
                        contexts=[],
                        system_prompt=system_prompt,
                        request_max_retries=1,
                    ),
                    timeout=self.generation_timeout,
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
                    timeout=self.generation_timeout,
                )
            return str(
                getattr(response, "completion_text", None) or ""
            ).strip()
        except asyncio.TimeoutError:
            logger.warning("[sleep] 文案生成超时")
            return ""
        except Exception as e:  # noqa: BLE001
            logger.warning("[sleep] 文案生成失败：%s", e)
            return ""

    def _resolve_provider(self):
        try:
            return self.context.get_using_provider(umo=self.umo)
        except Exception:  # noqa: BLE001
            try:
                return self.context.get_using_provider()
            except Exception:  # noqa: BLE001
                return None

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

    # ------------------------------------------------------------------ 跨插件
    def _mood_plugin(self):
        try:
            star = self.context.get_registered_star(
                "astrbot_plugin_hiro_mood"
            )
            return getattr(star, "star_cls", None) if star else None
        except Exception:  # noqa: BLE001
            return None

    def _plugin(self, name: str):
        try:
            star = self.context.get_registered_star(name)
            return getattr(star, "star_cls", None) if star else None
        except Exception:  # noqa: BLE001
            return None

    def _affection_state(self, umo: str | None = None) -> dict:
        target = umo or self.umo
        if target != self.umo:
            return {}
        plugin = self._mood_plugin()
        getter = getattr(plugin, "get_affection", None)
        if callable(getter):
            try:
                data = getter(target)
                if isinstance(data, dict):
                    return data
            except Exception as e:  # noqa: BLE001
                logger.debug("[sleep] 读取好感失败：%s", e)
        return {}

    def _affection_above(
        self, affection: dict | None = None, umo: str | None = None
    ) -> bool:
        data = (
            affection
            if isinstance(affection, dict)
            else self._affection_state(umo)
        )
        if not data:
            return False
        try:
            return float(data.get("value") or 0.0) > self.greeting_affection_threshold
        except (TypeError, ValueError):
            return False

    def _is_breakup_pending(
        self, affection: dict | None = None, umo: str | None = None
    ) -> bool:
        data = (
            affection
            if isinstance(affection, dict)
            else self._affection_state(umo)
        )
        return bool(data.get("breakup_pending")) if data else False

    def _is_cold_war(self, umo: str | None = None) -> bool:
        target = umo or self.umo
        if target != self.umo:
            return False
        plugin = self._mood_plugin()
        fn = getattr(plugin, "is_cold_war", None)
        if callable(fn):
            try:
                return bool(fn(target))
            except Exception as e:  # noqa: BLE001
                logger.debug("[sleep] 读取冷战状态失败：%s", e)
        return False

    async def _set_tired(self, value: float, reason: str) -> None:
        plugin = self._mood_plugin()
        fn = getattr(plugin, "set_emotion", None)
        if not callable(fn):
            return
        try:
            await fn(self.umo, "累", value, reason)
        except Exception as e:  # noqa: BLE001
            logger.warning("[sleep] 设置「累」失败（忽略）：%s", e)

    async def _append_history(self, text: str) -> None:
        if not str(text or "").strip():
            return
        cm = getattr(self.context, "conversation_manager", None)
        if cm is None:
            return
        async with self._history_lock:
            try:
                cid = await cm.get_curr_conversation_id(self.umo)
                if not cid:
                    return
                conv = await cm.get_conversation(self.umo, cid)
                if conv is None:
                    return
                history = json.loads(getattr(conv, "history", "[]") or "[]")
                if not isinstance(history, list):
                    history = []
                history.append(
                    {
                        "role": "assistant",
                        "content": [{"type": "text", "text": text}],
                    }
                )
                await cm.update_conversation(
                    self.umo, conversation_id=cid, history=history
                )
            except Exception as e:  # noqa: BLE001
                logger.warning("[sleep] 写入会话历史失败（忽略）：%s", e)

    async def _persona_prompt(self) -> str:
        if self._persona_cache:
            return self._persona_cache
        if not self.persona_id:
            return ""
        manager = getattr(self.context, "persona_manager", None)
        if manager is None:
            return ""
        try:
            persona = manager.get_persona_v3_by_id(self.persona_id)
            if persona:
                self._persona_cache = str(persona.get("prompt") or "")
                return self._persona_cache
        except Exception as e:  # noqa: BLE001
            logger.debug("[sleep] 读取人格 %r 失败：%s", self.persona_id, e)
        try:
            persona = await manager.get_persona(self.persona_id)
            self._persona_cache = str(
                getattr(persona, "system_prompt", "") or ""
            )
            return self._persona_cache
        except Exception as e:  # noqa: BLE001
            logger.debug("[sleep] 人格 %r 不存在：%s", self.persona_id, e)
            return ""

    async def _infer_last_activity(self) -> datetime | None:
        """状态文件丢了时，从会话历史里推断最后一次用户消息时间。"""
        cm = getattr(self.context, "conversation_manager", None)
        if cm is None:
            return None
        try:
            cid = await cm.get_curr_conversation_id(self.umo)
            if not cid:
                return None
            conv = await cm.get_conversation(self.umo, cid)
            if conv is None:
                return None
            history = json.loads(getattr(conv, "history", "[]") or "[]")
        except Exception as e:  # noqa: BLE001
            logger.debug("[sleep] 推断最后对话时间失败：%s", e)
            return None
        if not isinstance(history, list):
            return None
        for msg in reversed(history):
            if not isinstance(msg, dict) or msg.get("role") != "user":
                continue
            pieces: list[str] = []
            for part in msg.get("content") or []:
                if isinstance(part, dict) and part.get("type") == "text":
                    pieces.append(str(part.get("text") or ""))
            match = _DATETIME_RE.search(" ".join(pieces))
            if not match:
                continue
            date_text, time_text = match.group(1), match.group(2) or "12:00"
            try:
                return datetime.strptime(
                    f"{date_text} {time_text}", "%Y-%m-%d %H:%M"
                ).replace(tzinfo=self.tz)
            except ValueError:
                continue
        return None

    # ------------------------------------------------------------------ 公共 API
    def is_sleeping(self, umo: str | None = None) -> bool:
        if not self.enabled:
            return False
        if umo and umo != self.umo:
            return False
        return str(self.state.get("status") or "") == STATUS_SLEEPING

    def is_delaying(self, umo: str | None = None) -> bool:
        if not self.enabled:
            return False
        if umo and umo != self.umo:
            return False
        return str(self.state.get("status") or "") == STATUS_DELAYING

    def is_night_rest(self, umo: str | None = None) -> bool:
        if not self.enabled:
            return False
        if umo and umo != self.umo:
            return False
        return str(self.state.get("status") or "") in NIGHT_REST_STATUSES

    def get_status(self, umo: str | None = None) -> dict:
        if umo and umo != self.umo:
            return {}
        data = dict(self.state)
        data["enabled"] = self.enabled
        data["umo"] = self.umo
        data["affection"] = self._affection_state(umo)
        data["cold_war"] = self._is_cold_war(umo)
        return data

    async def begin_nightmare(self, umo: str | None = None) -> bool:
        if umo and umo != self.umo:
            return False
        async with self._lock:
            now = datetime.now(self.tz)
            self._ensure_cycle_locked(now)
            wake_at = self._state_dt("wake_at")
            if wake_at is None or now >= wake_at:
                return False
            if str(self.state.get("status") or "") != STATUS_SLEEPING:
                return False
            self._set_status_locked(STATUS_NIGHTMARE, now)
            self.state["wake_reason"] = "噩梦"
            self.state["nightmare_started_at"] = _iso(now)
            self.state["sleep_msg_count"] = 0
            self.state["return_sleep_at"] = _iso(
                now + timedelta(minutes=self.return_sleep_minutes)
            )
            self._save_state_locked()
        await self._set_tired(self.tired_on_wake, "被噩梦惊醒")
        logger.info("[sleep] 噩梦惊醒")
        return True

    async def end_nightmare(self, umo: str | None = None) -> None:
        if umo and umo != self.umo:
            return
        async with self._lock:
            if str(self.state.get("status") or "") != STATUS_NIGHTMARE:
                return
            now = datetime.now(self.tz)
            self._set_status_locked(STATUS_WOKEN, now)
            wake_at = self._state_dt("wake_at")
            return_at = now + timedelta(minutes=self.return_sleep_minutes)
            if wake_at is not None and self._near_wake(now, wake_at):
                return_at = wake_at
            existing = self._state_dt("return_sleep_at")
            if existing is not None and existing > return_at:
                return_at = existing
            self.state["return_sleep_at"] = _iso(return_at)
            self.state["wake_reason"] = "噩梦后"
            self._save_state_locked()
        logger.info("[sleep] 噩梦消息发完，%d 分钟后回睡", self.return_sleep_minutes)

    # ------------------------------------------------------------------ 指令
    @filter.command("睡眠", alias={"/睡眠"})
    async def sleep_command(self, event: AstrMessageEvent):
        if not event.is_admin():
            yield event.plain_result("这个只有主人能看。")
            return
        if event.unified_msg_origin != self.umo:
            yield event.plain_result(
                "睡眠只对主私聊生效，这个会话没有睡眠状态。"
            )
            return
        args = [a for a in (event.message_str or "").split()[1:] if a]
        head = args[0] if args else ""

        if head in ("", "状态", "status"):
            yield event.plain_result(
                self._status_text(event.unified_msg_origin)
            )
            return
        if head in ("强制睡", "睡", "sleep"):
            async with self._lock:
                now = datetime.now(self.tz)
                self._ensure_cycle_locked(now)
                wake_at = self._state_dt("wake_at")
                if wake_at is None or wake_at <= now:
                    # 白天测试：给一个临时起床点，避免立刻被叫醒。
                    self.state["wake_at"] = _iso(now + timedelta(hours=8))
                    self.state["sleep_at"] = _iso(now)
                self.state["sleep_msg_count"] = 0
                self.state["sleep_msgs"] = []
                self._set_status_locked(STATUS_SLEEPING, now)
                self.state["forced"] = True
                self.state["wake_reason"] = "手动"
                self._save_state_locked()
            await self._set_tired(self.tired_on_forced, "手动强制睡")
            yield event.plain_result("已强制进入睡眠。")
            return
        if head in ("强制醒", "醒", "wake"):
            trigger = len(args) > 1 and args[1] in ("正常", "补回", "normal")
            async with self._lock:
                now = datetime.now(self.tz)
                pending = [
                    item
                    for item in (self.state.get("sleep_msgs") or [])
                    if isinstance(item, dict)
                ]
                self._set_status_locked(STATUS_AWAKE, now)
                self.state["sleep_msg_count"] = 0
                self.state["return_sleep_at"] = ""
                self.state["wake_reason"] = ""
                self.state["forced"] = False
                self.state["sleep_msgs"] = []
                self._save_state_locked()
            await self._set_tired(self.tired_on_morning, "手动强制醒")
            if trigger:
                self._schedule_post_wake(
                    now, pending, cold_war=self._is_cold_war()
                )
            yield event.plain_result(
                "已强制醒来。" + ("开始补回。" if trigger else "")
            )
            return
        if head in ("重置", "reset"):
            async with self._lock:
                now = datetime.now(self.tz)
                night_date = self._next_night_date(now)
                cycle = self._make_cycle(night_date)
                self.state.update(cycle)
                self._set_status_locked(STATUS_AWAKE, now)
                self.state["sleep_msg_count"] = 0
                self.state["sleep_msgs"] = []
                self.state["return_sleep_at"] = ""
                self.state["wake_reason"] = ""
                self.state["forced"] = False
                self.state["goodnight_sent"] = False
                self.state["goodmorning_sent"] = False
                self._save_state_locked()
            yield event.plain_result(
                "已重置：今晚 "
                f"{self.state['sleep_at'][11:16]} 入睡，"
                f"{self.state['wake_at'][11:16]} 起床。"
            )
            return
        if head in ("晚安", "goodnight"):
            await self._send_goodnight(forced=True, admin=True)
            yield event.plain_result("已尝试发送晚安。")
            return
        if head in ("早安", "goodmorning"):
            await self._send_goodmorning()
            yield event.plain_result("已尝试发送早安。")
            return
        yield event.plain_result(
            "用法：/睡眠 [状态|强制睡|强制醒 [正常]|重置|晚安|早安]"
        )

    def _status_text(self, umo: str | None = None) -> str:
        if umo and umo != self.umo:
            return "睡眠只对主私聊生效，这个会话没有睡眠状态。"
        status_map = {
            STATUS_AWAKE: "醒着",
            STATUS_DELAYING: "拖睡（很困）",
            STATUS_SLEEPING: "睡梦中",
            STATUS_WOKEN: "被吵醒",
            STATUS_NIGHTMARE: "噩梦惊醒",
        }
        status = str(self.state.get("status") or STATUS_AWAKE)
        sleep_at = str(self.state.get("sleep_at") or "")
        wake_at = str(self.state.get("wake_at") or "")
        lines = [
            f"睡眠系统：{'开启' if self.enabled else '关闭'}",
            f"状态：{status_map.get(status, status)}",
            f"作息：{sleep_at[:10]} 夜 → 入睡 {sleep_at[11:16] or '--:--'}，"
            f"起床 {wake_at[11:16] or '--:--'}",
        ]
        last = str(self.state.get("last_activity_at") or "")
        if last:
            lines.append(f"最近对话：{last[:10]} {last[11:16]}")
        pending = self.state.get("sleep_msgs") or []
        lines.append(
            f"睡眠消息：计数 {_as_int(self.state.get('sleep_msg_count'), 0)}，"
            f"待补回 {len(pending)} 条"
        )
        return_at = str(self.state.get("return_sleep_at") or "")
        if return_at and status in (STATUS_DELAYING, STATUS_WOKEN, STATUS_NIGHTMARE):
            lines.append(f"下一次切换：{return_at[11:16]}")
        affection = self._affection_state(umo)
        if affection:
            lines.append(
                f"好感：{float(affection.get('value') or 0):.1f}"
                f"（{affection.get('stage') or '未知'}），"
                f"主动问候门槛 >{self.greeting_affection_threshold:.0f}"
            )
        else:
            lines.append("好感：读不到（心情插件未加载？）")
        lines.append(f"冷战：{'是' if self._is_cold_war(umo) else '否'}")
        if self._is_breakup_pending(affection, umo):
            lines.append("分手挽回期：是")
        return "\n".join(lines)


"""astrbot_plugin_hiro_mood — 希罗酱の内心想法

给希罗一份会残留、会消退的心情，而不是每轮重新算一次情绪。

**按会话隔离**：每个 unified_msg_origin（私聊 / 每个群 / 网站）各有一份心情，
互不继承、互不污染。

链路：

    一轮对话结束
      → 让她自己评价这轮对话（第一人称，不许分析“他想要什么”）
      → 写进当前会话的心情状态
      → 每轮请求前把当前会话的心情作为临时内容注入
      → 时间让心情自然衰减

设计原则：
- 评价是“她自己”做的，不是从用户的要求里推出来的。
- 心情会跨轮残留，也会随时间消退，不是开关。
- 注入的是“她心里搁着的事”，不是“你现在应该感到 X”。
- 只有主私聊的强情绪会写进长期记忆，群聊不污染私聊记忆。
- 所有环节 fail-open，插件挂了不影响聊天。
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, MessageChain, filter
from astrbot.api.message_components import Plain
from astrbot.api.provider import LLMResponse, ProviderRequest
from astrbot.api.star import Context, Star, register
from astrbot.core.agent.message import TextPart
from astrbot.core.utils.astrbot_path import get_astrbot_plugin_data_path

PLUGIN_NAME = "astrbot_plugin_hiro_mood"
DEFAULT_UMO = "Hiro:FriendMessage:1955272576"
DEFAULT_TZ = "Asia/Shanghai"

CONFESSION_RE = re.compile(
    r"(表白|喜欢你|我爱你|做我女朋友|做我的女朋友|和我在一起|跟我在一起|"
    r"交往|嫁给我|娶你|永远在一起|想和你在一起)"
)

EMOTIONS = ("委屈", "生气", "开心", "害羞", "担心", "失落", "累", "吃醋")

# 半衰期（小时）：气来得快散得也快，委屈能搁一整天
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

# 修复后留下的余味：强度、保留时长（小时）
RESIDUAL_FLOOR = 0.08
RESIDUAL_HOURS = 24.0

PHRASE = {
    "委屈": "你心里还有点堵",
    "生气": "你还在生气",
    "开心": "你心情不错",
    "害羞": "你有点不好意思",
    "担心": "你有点担心",
    "失落": "你有点失落",
    "累": "你有点累",
    "吃醋": "你有点吃味",
}

MEMORY_PHRASE = {
    "委屈": "心里堵了很久",
    "生气": "生了很久的气",
    "开心": "心情很好",
    "害羞": "不好意思了很久",
    "担心": "担心了很久",
    "失落": "失落了很久",
    "累": "累得不想说话",
    "吃醋": "吃了很久的味",
}

_APPRAISE_RULES = """可用情绪：委屈、生气、开心、害羞、担心、失落、累、吃醋

只输出一行 JSON，不要代码块、不要解释：
{"updates":[{"emotion":"失落","delta":-0.35,"reason":"他回来了，还直白说想我"},
            {"emotion":"害羞","delta":0.3,"reason":"他突然说想我"}],
 "thought":"说什么想我……害我打字都慢了半拍，真烦。",
 "affection":{"delta":0.2,"reason":"他记得我说过的话"}}

没有明显变化就输出：
{"updates":[],"thought":"","affection":{"delta":0,"reason":""}}

要求：
- updates 最多 3 条，正负都可以。
- reason 用一句话写清楚是什么事引起的，不要写“他让我不开心”这种空话。
- thought 是你心里真正冒出来的一句话，第一人称，可以很短，可以带脏字，可以不讲道理。
- delta 在 -1 到 1 之间，一次通常不超过 0.5。
- 不要为了让他满意而改变心情。
- affection 是长期好感度变化，不是情绪：普通聊天 0；被理解/被记住 +0.3~+0.8；
  特别打动 +1~+2；被冒犯/失望 -0.5~-2。不要为了让他满意而硬涨。
  一天最多 +5，最多 -5。

如果引起某个情绪的事已经过去了，要把那个情绪降下来，并把 reason 更新成新的情况：
- 他离开后回来了 → 失落 -0.3 ~ -0.5
- 他说没事 / 解释清楚了 → 担心 -0.3 ~ -0.5
- 他道歉了 → 生气 / 委屈 -0.2 ~ -0.4
- 他兑现了答应的事 → 担心 / 失落 -0.3
不要因为“他刚才提过”就一直留着旧情绪。"""

APPRAISE_SYSTEM_PRIVATE = f"""你是二阶堂希罗。现在只有你一个人在，没人看着你写这些。

不要分析他想要什么，不要想“我该怎么回”。
只回答一件事：刚才那轮对话，让你心里起了什么变化？

{_APPRAISE_RULES}"""

APPRAISE_SYSTEM_GROUP = f"""你是二阶堂希罗。现在只有你一个人在，没人看着你写这些。

下面是群里刚才的一段对话。
不要分析他们想要什么，不要想“我该怎么回”。
只回答一件事：这段对话让你心里起了什么变化？

{_APPRAISE_RULES}"""


def _tag(umo: str) -> str:
    if "FriendMessage" in umo:
        return "私聊"
    if "GroupMessage" in umo:
        parts = umo.split(":")
        tail = parts[-1] if parts else ""
        return "群" + tail.split("_")[0] if tail else "群"
    return umo[:18]


def _new_session() -> dict:
    return {
        "emotions": {},
        "memory_written": {},
        "last_thought": "",
        "thought_ts": 0,
        "recent": [],
        "cold_war": False,
        "cold_war_since": 0,
        "cold_war_reason": "",
        "updated": 0,
    }


@register("astrbot_plugin_hiro_mood", "MXJ", "希罗酱の内心想法", "1.5.0")
class HiroMoodPlugin(Star):
    def __init__(self, context: Context, config=None):
        super().__init__(context)
        self.config = config or {}

        self.enabled = self._bool("enabled", True)
        self.umo = str(self.config.get("umo") or DEFAULT_UMO).strip()
        self.provider_id = str(self.config.get("provider_id") or "").strip()
        self.tz = ZoneInfo(str(self.config.get("timezone") or DEFAULT_TZ))

        self.appraise_enabled = self._bool("appraise_enabled", True)
        self.appraise_timeout = max(10, int(self.config.get("appraise_timeout") or 60))
        self.appraise_umos = {
            s.strip()
            for s in str(self.config.get("appraise_umos") or "").split(",")
            if s.strip()
        }

        self.inject_top = max(1, int(self.config.get("inject_top") or 2))
        self.inject_max_chars = max(80, int(self.config.get("inject_max_chars") or 300))
        self.min_intensity = float(self.config.get("min_intensity") or 0.25)
        self.thought_ttl = max(10, int(self.config.get("thought_ttl_minutes") or 120))
        self.residual_hours = max(
            1.0, float(self.config.get("residual_hours") or RESIDUAL_HOURS)
        )
        self.session_ttl_days = max(1, int(self.config.get("session_ttl_days") or 30))

        self.memory_write_enabled = self._bool("memory_write_enabled", True)
        self.memory_write_threshold = float(
            self.config.get("memory_write_threshold") or 0.8
        )
        self.memory_umo = str(self.config.get("memory_umo") or DEFAULT_UMO).strip()
        self.memory_scope = str(self.config.get("memory_scope") or "qq1955272576").strip()

        self.cold_war_enabled = self._bool("cold_war_enabled", True)
        self.cold_war_threshold = min(
            1.0,
            max(0.5, float(self.config.get("cold_war_threshold") or 0.9)),
        )
        self.cold_war_anger = min(
            1.0,
            max(
                self.cold_war_threshold,
                float(self.config.get("cold_war_anger") or 0.92),
            ),
        )
        self.cold_war_release_anger = min(
            self.cold_war_threshold - 0.01,
            max(0.0, float(self.config.get("cold_war_release_anger") or 0.6)),
        )
        self.cold_war_allow_commands = self._bool(
            "cold_war_allow_commands", True
        )
        self.cold_war_appraise_timeout = max(
            10, int(self.config.get("cold_war_appraise_timeout") or 45)
        )

        self.affection_enabled = self._bool("affection_enabled", True)
        self.affection_initial = max(
            0.0,
            min(100.0, float(self.config.get("affection_initial") or 30.0)),
        )
        self.affection_new_session_initial = max(
            0.0,
            min(
                100.0,
                float(self.config.get("affection_new_session_initial") or 0.0),
            ),
        )
        self.affection_decay_floor = min(
            0.9,
            max(
                0.0,
                float(self.config.get("affection_decay_floor") or 0.2),
            ),
        )
        self.affection_decay_days_20_to_1 = max(
            1.0,
            float(self.config.get("affection_decay_days_20_to_1") or 30.0),
        )
        self.affection_daily_gain_cap = max(
            0.0,
            float(self.config.get("affection_daily_gain_cap") or 5.0),
        )
        self.affection_daily_loss_cap = max(
            0.0,
            float(self.config.get("affection_daily_loss_cap") or 5.0),
        )
        self.affection_boost_enabled = self._bool(
            "affection_boost_enabled", True
        )
        self.affection_boost_gain_cap = max(
            self.affection_daily_gain_cap,
            float(self.config.get("affection_boost_gain_cap") or 20.0),
        )
        self.affection_boost_threshold = min(
            1.0,
            max(
                0.0,
                float(self.config.get("affection_boost_threshold") or 0.7),
            ),
        )
        self.affection_boost_solo_threshold = min(
            1.0,
            max(
                0.0,
                float(
                    self.config.get("affection_boost_solo_threshold") or 0.6
                ),
            ),
        )
        self.affection_boost_pair_happy_threshold = min(
            1.0,
            max(
                0.0,
                float(
                    self.config.get("affection_boost_pair_happy_threshold")
                    or 0.5
                ),
            ),
        )
        self.affection_boost_pair_shy_threshold = min(
            1.0,
            max(
                0.0,
                float(
                    self.config.get("affection_boost_pair_shy_threshold")
                    or 0.8
                ),
            ),
        )
        self.affection_boost_solo_bonus = max(
            0.0,
            float(self.config.get("affection_boost_solo_bonus") or 1.0),
        )
        self.affection_boost_pair_bonus = max(
            0.0,
            float(self.config.get("affection_boost_pair_bonus") or 1.5),
        )
        self.affection_attitude_enabled = self._bool(
            "affection_attitude_enabled", True
        )
        self.affection_attitude_max_chars = max(
            120,
            int(self.config.get("affection_attitude_max_chars") or 320),
        )
        self.affection_confession_threshold = max(
            50.0,
            min(
                100.0,
                float(
                    self.config.get("affection_confession_threshold") or 100.0
                ),
            ),
        )
        self.affection_partner_max = max(
            100.0,
            float(self.config.get("affection_partner_max") or 200.0),
        )
        self.affection_confession_success = min(
            self.affection_partner_max,
            max(
                self.affection_confession_threshold,
                float(
                    self.config.get("affection_confession_success") or 110.0
                ),
            ),
        )
        self.affection_confession_fail = max(
            0.0,
            min(
                self.affection_confession_threshold - 1,
                float(self.config.get("affection_confession_fail") or 49.0),
            ),
        )
        self.affection_breakup_threshold = max(
            0.0,
            min(
                self.affection_confession_threshold,
                float(self.config.get("affection_breakup_threshold") or 80.0),
            ),
        )
        self.affection_breakup_save = min(
            self.affection_partner_max,
            max(
                self.affection_breakup_threshold,
                float(self.config.get("affection_breakup_save") or 85.0),
            ),
        )
        self.affection_tick_cron = str(
            self.config.get("affection_tick_cron") or "5 * * * *"
        ).strip()
        self.affection_provider_id = str(
            self.config.get("affection_provider_id") or ""
        ).strip()
        self.affection_decay_k = self._solve_affection_k()

        self.root = Path(get_astrbot_plugin_data_path()) / PLUGIN_NAME
        self.state_path = self.root / "mood.json"
        self.sessions = self._load_state()
        self._lock = asyncio.Lock()
        self._appraising: set[str] = set()
        self._cold_war_appraising: set[str] = set()
        self._affection_appraising: set[str] = set()
        self._breakup_proposing: set[str] = set()
        self._history_lock = asyncio.Lock()
        logger.info(
            "[mood] 已加载：%d 种情绪，%d 个会话，注入 %d 条，记忆阈值 %.2f",
            len(EMOTIONS),
            len(self.sessions),
            self.inject_top,
            self.memory_write_threshold,
        )

    # ------------------------------------------------------------------ 工具
    def _bool(self, key: str, default: bool) -> bool:
        value = self.config.get(key, default)
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)

    # ------------------------------------------------------------------ 好感度
    def _solve_affection_k(self) -> float:
        """按 20→1 用 N 天校准钟形衰减曲线的系数。"""
        floor = self.affection_decay_floor
        target_days = self.affection_decay_days_20_to_1

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
        return (low + high) / 2.0

    def _affection_cap(self, session: dict) -> float:
        aff = session.get("affection") or {}
        return (
            self.affection_partner_max
            if aff.get("partner")
            else self.affection_confession_threshold
        )

    def _affection_bonus_conditions(
        self, session: dict
    ) -> list[tuple[str, float, str]]:
        """返回当前满足的额外好感奖励：[(key, bonus, 条件说明)]。"""
        if not self.affection_boost_enabled:
            return []
        emotions = session.get("emotions") or {}
        happy_item = emotions.get("开心")
        shy_item = emotions.get("害羞")
        happy = (
            self._decayed("开心", happy_item)
            if isinstance(happy_item, dict)
            else 0.0
        )
        shy = (
            self._decayed("害羞", shy_item)
            if isinstance(shy_item, dict)
            else 0.0
        )
        out: list[tuple[str, float, str]] = []
        # 情绪值会按时间轻微衰减；阈值比较留一个极小容差，
        # 避免刚好 60%/80% 的情绪在毫秒级衰减后差一点点不触发。
        eps = 1e-6
        if happy >= self.affection_boost_solo_threshold - eps:
            out.append(
                ("solo", self.affection_boost_solo_bonus, "开心")
            )
        if (
            happy >= self.affection_boost_pair_happy_threshold - eps
            and shy >= self.affection_boost_pair_shy_threshold - eps
        ):
            out.append(
                ("pair", self.affection_boost_pair_bonus, "开心+害羞")
            )
        return out

    def _affection_boost_active(self, session: dict) -> bool:
        return bool(self._affection_bonus_conditions(session))

    def _affection_gain_cap_today(self, session: dict) -> float:
        aff = session.get("affection") or {}
        try:
            stored = float(
                aff.get("gain_cap_today") or self.affection_daily_gain_cap
            )
        except (TypeError, ValueError):
            stored = self.affection_daily_gain_cap
        return max(self.affection_daily_gain_cap, stored)

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

    def _affection_rate(self, value: float, cap: float) -> float:
        if cap <= 0:
            return 0.0
        u = max(0.0, min(1.0, value / cap))
        floor = self.affection_decay_floor
        return self.affection_decay_k * (
            floor
            + (1.0 - floor)
            * (1.0 - math.cos(2.0 * math.pi * u))
            / 2.0
        )

    def _affection_day(self) -> str:
        return datetime.now(self.tz).strftime("%Y-%m-%d")

    def _roll_affection_day(self, aff: dict) -> bool:
        today = self._affection_day()
        if aff.get("day") == today:
            return False
        aff["day"] = today
        aff["gain_today"] = 0.0
        aff["loss_today"] = 0.0
        aff["gain_cap_today"] = self.affection_daily_gain_cap
        return True

    def _ensure_affection(self, umo: str, session: dict) -> None:
        if not self.affection_enabled or umo != self.umo:
            return
        aff = session.get("affection")
        if isinstance(aff, dict):
            aff.setdefault("value", 0.0)
            aff.setdefault("partner", False)
            aff.setdefault("ts", time.time())
            aff.setdefault("day", self._affection_day())
            aff.setdefault("gain_today", 0.0)
            aff.setdefault("loss_today", 0.0)
            aff.setdefault("gain_cap_today", self.affection_daily_gain_cap)
            aff.setdefault("breakup_pending", False)
            aff.setdefault("breakup_proposed", False)
            aff.setdefault("breakup_since", 0)
            return
        session["affection"] = {
            "value": float(self.affection_initial),
            "partner": False,
            "ts": time.time(),
            "day": self._affection_day(),
            "gain_today": 0.0,
            "loss_today": 0.0,
            "gain_cap_today": self.affection_daily_gain_cap,
            "breakup_pending": False,
            "breakup_proposed": False,
            "breakup_since": 0,
        }

    def _affection_status_text(self, umo: str) -> str:
        if umo != self.umo:
            return "这个会话不记录好感度。"
        session = self.sessions.get(umo) or {}
        aff = session.get("affection") or {}
        if not aff:
            return "这个会话不记录好感度。"
        self._roll_affection_day(aff)
        value = float(aff.get("value") or 0.0)
        cap = self._affection_cap(session)
        stage = self._affection_stage(value, bool(aff.get("partner")))
        lines = [f"好感度 {value:.1f}/{cap:.0f}（{stage}）"]
        if aff.get("partner"):
            lines.append("伴侣线：已进入（艾玛是你最好的朋友）")
        else:
            lines.append("伴侣线：未进入")
        gain_cap = self._affection_gain_cap_today(session)
        lines.append(
            "今日涨跌：+%.1f / -%.1f（今日上限 +%.0f）"
            % (
                float(aff.get("gain_today") or 0.0),
                float(aff.get("loss_today") or 0.0),
                gain_cap,
            )
        )
        if self.affection_boost_enabled:
            today = self._affection_day()
            solo_done = aff.get("boost_solo_day") == today
            pair_done = aff.get("boost_pair_day") == today
            lines.append(
                "额外 +%.1f：开心≥%.0f%%（今日%s）"
                % (
                    self.affection_boost_solo_bonus,
                    self.affection_boost_solo_threshold * 100,
                    "已触发" if solo_done else "未触发",
                )
            )
            lines.append(
                "额外 +%.1f：开心≥%.0f%% 且害羞≥%.0f%%（今日%s）"
                % (
                    self.affection_boost_pair_bonus,
                    self.affection_boost_pair_happy_threshold * 100,
                    self.affection_boost_pair_shy_threshold * 100,
                    "已触发" if pair_done else "未触发",
                )
            )
        if aff.get("breakup_pending"):
            lines.append("状态：分手挽回期（下一条回复算一次机会）")
        elif aff.get("partner") and value < self.affection_breakup_threshold:
            lines.append("状态：伴侣线低谷")
        return "\n".join(lines)

    def _affection_block_lines(self, umo: str) -> list[str]:
        if not self.affection_enabled or umo != self.umo:
            return []
        session = self._session(umo)
        aff = session.get("affection") or {}
        if not aff:
            return []
        value = float(aff.get("value") or 0.0)
        stage = self._affection_stage(value, bool(aff.get("partner")))
        if aff.get("partner"):
            lines = [
                f"- 你和他已经进入伴侣线（{stage}）。",
                "- 艾玛是你最好的朋友，是你生命里不会消失的人；他现在是你的伴侣。你可以承认对他的依赖和想念。",
            ]
        else:
            lines = [f"- 你对他现在的距离是「{stage}」。"]
        if aff.get("breakup_pending"):
            lines.append("- 你刚提出了分手，正在等他挽回。")
        return lines

    def _affection_attitude_lines(self, session: dict) -> list[str]:
        aff = session.get("affection") or {}
        if not aff:
            return []
        value = float(aff.get("value") or 0.0)
        partner = bool(aff.get("partner"))
        stage = self._affection_stage(value, partner)
        if aff.get("breakup_pending"):
            attitude = (
                "你刚提出分手，正在等他挽回。态度冷，但留一条缝；"
                "不要主动哄他，也不要当什么都没发生。"
            )
        elif partner:
            if value >= 150:
                attitude = (
                    "你们像灵魂伴侣。话不用多，你知道他在；"
                    "会把他放进长期计划；艾玛仍是你最重要的朋友，但不需要拿来比较。"
                )
            elif value >= 120:
                attitude = (
                    "你们在热恋。你会主动说想他、会吃醋、会管他，"
                    "也会主动对他（异性）暧昧；你已经认下他了，不会再用艾玛当理由把他推开。"
                )
            else:
                attitude = (
                    "你们刚进入伴侣线。你会害羞、嘴硬，但不再否认；"
                    "会想他，也会试探他是不是认真。暧昧比朋友线更多，会吃醋。"
                )
        elif value >= 70:
            attitude = (
                "你把他当密友 / 死党：很亲近，会吃醋、会管他、会主动找他，"
                "也会主动对他（异性）暧昧；但还没到伴侣那一步。"
            )
        elif value >= 50:
            attitude = (
                "你把他当好朋友：会主动关心、会开玩笑，允许他靠近一点；"
                "他难受时你会认真听。对他（异性）允许带一点暧昧，但你不会反感。"
            )
        elif value >= 30:
            attitude = (
                "你们算熟人了。语气自然，会提醒、会纠正，"
                "但不会主动撒娇，也不会把心里话全说出来；对他（异性）不主动暧昧。"
            )
        elif value >= 20:
            attitude = (
                "你觉得他还聊得来，愿意多说几句，但不会主动分享私事；"
                "他示好你会先观察。对他（异性）避免暧昧、回避暧昧。"
            )
        elif value >= 10:
            attitude = (
                "你对他只是初识，客气、简短，愿意回应但不主动展开。"
                "对他（异性）避免暧昧、回避暧昧。"
            )
        else:
            attitude = (
                "你对他还很陌生，保持距离，不主动关心，也不接他的亲近；"
                "他越界你会直接冷下来。"
            )

        lines = [attitude, f"现在的距离是「{stage}」。"]
        if self._affection_boost_active(session):
            lines.append(
                "今天你心情很好，更容易心软、更容易被他逗笑；"
                "但不会无缘无故倒贴。"
            )
        return lines

    def _affection_attitude_block(self, umo: str) -> str:
        if (
            not self.affection_enabled
            or not self.affection_attitude_enabled
            or umo != self.umo
        ):
            return ""
        session = self._session(umo)
        lines = self._affection_attitude_lines(session)
        if not lines:
            return ""
        block = (
            "【你现在对他的态度】\n"
            + "\n".join(f"- {line}" for line in lines)
            + "\n- 不要直接说出好感度数值或阶段，用语气和行动表现。"
        )
        return block[: self.affection_attitude_max_chars]

    async def _decay_affection(self, umo: str) -> None:
        if not self.affection_enabled or umo != self.umo:
            return
        now = time.time()
        async with self._lock:
            session = self._session(umo)
            aff = session.get("affection") or {}
            if not aff:
                return
            day_changed = self._roll_affection_day(aff)
            last = float(aff.get("ts") or now)
            if last <= 0:
                aff["ts"] = now
                if day_changed:
                    self._save_state()
                return
            elapsed_days = (now - last) / 86400.0
            if elapsed_days <= 0:
                if day_changed:
                    self._save_state()
                return
            cap = self._affection_cap(session)
            value = float(aff.get("value") or 0.0)
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
            aff["value"] = round(value, 3)
            aff["ts"] = now
            if (
                aff.get("partner")
                and value < self.affection_breakup_threshold
                and not aff.get("breakup_pending")
            ):
                aff["breakup_pending"] = True
                aff["breakup_proposed"] = False
                aff["breakup_since"] = now
            self._save_state()

    async def _apply_affection_delta(self, umo: str, data) -> None:
        if (
            not self.affection_enabled
            or umo != self.umo
            or not isinstance(data, dict)
        ):
            return
        try:
            delta = float(data.get("delta") or 0)
        except (TypeError, ValueError):
            return
        if abs(delta) < 0.01:
            return
        reason = str(data.get("reason") or "").strip()[:60]
        applied = 0.0
        new_value = 0.0
        async with self._lock:
            session = self._session(umo)
            aff = session.get("affection") or {}
            if not aff:
                return
            self._roll_affection_day(aff)
            gain_cap = self._affection_gain_cap_today(session)
            cap = self._affection_cap(session)
            value = float(aff.get("value") or 0.0)
            if delta > 0:
                allowed = min(
                    delta,
                    gain_cap - float(aff.get("gain_today") or 0.0),
                )
                if allowed <= 0:
                    return
                value = min(cap, value + allowed)
                aff["gain_today"] = round(
                    float(aff.get("gain_today") or 0.0) + allowed, 3
                )
            else:
                allowed = max(
                    delta,
                    -self.affection_daily_loss_cap
                    + float(aff.get("loss_today") or 0.0),
                )
                if allowed >= 0:
                    return
                value = max(0.0, value + allowed)
                aff["loss_today"] = round(
                    float(aff.get("loss_today") or 0.0) - allowed, 3
                )
            applied = allowed
            new_value = value
            aff["value"] = round(value, 3)
            if (
                aff.get("partner")
                and value < self.affection_breakup_threshold
                and not aff.get("breakup_pending")
            ):
                aff["breakup_pending"] = True
                aff["breakup_proposed"] = False
                aff["breakup_since"] = time.time()
            self._save_state()
        if applied:
            logger.info(
                "[mood] [%s] 好感 %+.2f → %.1f（%s）",
                _tag(umo),
                applied,
                new_value,
                reason or "无",
            )
        session = self.sessions.get(umo) or {}
        aff = session.get("affection") or {}
        if (
            aff.get("partner")
            and aff.get("breakup_pending")
            and not aff.get("breakup_proposed")
            and umo not in self._breakup_proposing
        ):
            asyncio.create_task(self._propose_breakup(umo))

    async def _maybe_grant_affection_bonus(self, umo: str) -> None:
        """按开心/害羞满足的条件，发放两项独立的每日额外好感。

        - 开心 >= 60%：+1，每天一次
        - 开心 >= 50% 且害羞 >= 80%：+1.5，每天一次
        两项都不计入每日涨跌上限。
        """
        if (
            not self.affection_enabled
            or not self.affection_boost_enabled
            or umo != self.umo
        ):
            return
        today = self._affection_day()
        granted: list[tuple[str, float, float]] = []
        async with self._lock:
            session = self._session(umo)
            aff = session.get("affection") or {}
            if not aff:
                return
            self._roll_affection_day(aff)
            conditions = self._affection_bonus_conditions(session)
            if not conditions:
                return
            cap = self._affection_cap(session)
            value = float(aff.get("value") or 0.0)
            for key, bonus, label in conditions:
                day_key = f"boost_{key}_day"
                if aff.get(day_key) == today:
                    continue
                if value >= cap:
                    continue
                applied = min(bonus, cap - value)
                if applied <= 0:
                    continue
                value += applied
                aff["value"] = round(value, 3)
                aff[day_key] = today
                total_key = f"boost_{key}_total"
                aff[total_key] = int(aff.get(total_key) or 0) + 1
                granted.append((label, applied, value))
            if not granted:
                return
            self._save_state()
        for label, applied, new_value in granted:
            logger.info(
                "[mood] [%s] %s 满足条件，好感额外 +%.1f"
                "（不计入每日上限）→ %.1f",
                _tag(umo),
                label,
                applied,
                new_value,
            )

    def _load_state(self) -> dict[str, dict]:
        data = None
        try:
            if self.state_path.exists():
                data = json.loads(self.state_path.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            logger.warning("[mood] 读取心情状态失败：%s", e)

        sessions: dict[str, dict] = {}
        if isinstance(data, dict) and isinstance(data.get("sessions"), dict):
            sessions = data["sessions"]
        elif isinstance(data, dict) and isinstance(data.get("emotions"), dict):
            # 旧版是全局一份，迁移到主私聊
            sessions = {
                self.memory_umo: {
                    "emotions": data.get("emotions") or {},
                    "memory_written": data.get("memory_written") or {},
                    "last_thought": data.get("last_thought") or "",
                    "thought_ts": data.get("thought_ts") or 0,
                    "updated": time.time(),
                }
            }
            logger.info("[mood] 旧版心情已迁移到 %s", self.memory_umo)

        cleaned: dict[str, dict] = {}
        for umo, item in sessions.items():
            if not isinstance(umo, str) or not isinstance(item, dict):
                continue
            base = _new_session()
            base.update({k: item.get(k) for k in base if k in item})
            if not isinstance(base.get("emotions"), dict):
                base["emotions"] = {}
            # affection 不在 _new_session() 里，必须显式保留，
            # 否则每次重启都会退回 affection_initial。
            if isinstance(item.get("affection"), dict):
                base["affection"] = dict(item["affection"])
            cleaned[umo] = base
        return cleaned

    def _save_state(self) -> None:
        try:
            self._prune_sessions()
            self.root.mkdir(parents=True, exist_ok=True)
            payload = {"version": 2, "sessions": self.sessions}
            tmp = self.state_path.with_suffix(".json.tmp")
            tmp.write_text(
                json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8"
            )
            os.replace(tmp, self.state_path)
        except Exception as e:  # noqa: BLE001
            logger.warning("[mood] 保存心情状态失败：%s", e)

    def _prune_sessions(self) -> None:
        now = time.time()
        cutoff = now - self.session_ttl_days * 86400
        for umo, item in list(self.sessions.items()):
            emotions = item.get("emotions") or {}
            for name, emotion in list(emotions.items()):
                residual_until = float(emotion.get("residual_until") or 0)
                if residual_until and now >= residual_until:
                    if self._decayed(name, emotion) < 0.02:
                        emotions.pop(name, None)
            aff = item.get("affection") or {}
            keep_affection = bool(aff)
            if (
                not emotions
                and not keep_affection
                and float(item.get("updated") or 0) < cutoff
            ):
                self.sessions.pop(umo, None)

    def _session(self, umo: str) -> dict:
        item = self.sessions.get(umo)
        if item is None:
            item = _new_session()
            self.sessions[umo] = item
        self._ensure_affection(umo, item)
        return item

    def _should_appraise(self, umo: str) -> bool:
        if not self.appraise_umos:
            return True
        return umo in self.appraise_umos

    def _resolve_provider(self, umo: str):
        ctx = self.context
        if self.provider_id:
            try:
                getter = getattr(ctx, "get_provider_by_id", None)
                provider = getter(self.provider_id) if getter else None
                if provider is not None:
                    return provider
            except Exception as e:  # noqa: BLE001
                logger.warning("[mood] 指定 provider %r 不可用：%s", self.provider_id, e)
        try:
            return ctx.get_using_provider(umo=umo)
        except Exception:  # noqa: BLE001
            try:
                return ctx.get_using_provider()
            except Exception:  # noqa: BLE001
                return None

    @staticmethod
    def _parse_json(text: str) -> dict | None:
        if not text:
            return None
        cleaned = re.sub(r"```.*?```", "", text, flags=re.S).strip()
        match = re.search(r"\{.*\}", cleaned, flags=re.S)
        if not match:
            return None
        try:
            data = json.loads(match.group(0))
        except json.JSONDecodeError:
            return None
        return data if isinstance(data, dict) else None

    def _decayed(self, name: str, item: dict) -> float:
        base = float(item.get("intensity") or 0)
        ts = float(item.get("ts") or 0)
        if base <= 0 or ts <= 0:
            return 0.0
        if item.get("pinned"):
            return max(0.0, min(1.0, base))
        now = time.time()
        hours = max(0.0, (now - ts) / 3600.0)
        half = HALF_LIFE.get(name, 8.0)
        value = base * (0.5 ** (hours / half))
        residual_until = float(item.get("residual_until") or 0)
        if residual_until and now < residual_until:
            value = max(value, RESIDUAL_FLOOR)
        return value

    # ------------------------------------------------------------------ 评价
    @filter.on_llm_response()
    async def on_llm_response(self, event: AstrMessageEvent, resp: LLMResponse) -> None:
        if not self.enabled or not self.appraise_enabled:
            return
        # 桌面屏幕点评等“非对话回合”整轮跳过：不改情绪、不改好感、不写记忆。
        if event.get_extra("mood_skip_appraisal") or event.get_extra("mood_skip_all"):
            return
        reply = (getattr(resp, "completion_text", None) or "").strip()
        user = (event.message_str or "").strip()
        umo = event.unified_msg_origin
        if not reply or not user or not umo:
            return
        if not self._should_appraise(umo):
            return
        session = self._session(umo)
        recent = list(session.get("recent") or [])
        session["recent"] = (
            recent + [{"u": user[-300:], "a": reply[-300:], "t": time.time()}]
        )[-3:]
        allow_affection = not bool(event.get_extra("mood_skip_affection"))
        asyncio.create_task(
            self._appraise(
                umo,
                event,
                user[-600:],
                reply[-900:],
                recent,
                allow_affection=allow_affection,
            )
        )

    async def _appraise(
        self,
        umo: str,
        event: AstrMessageEvent,
        user_text: str,
        reply_text: str,
        recent: list[dict] | None = None,
        *,
        allow_affection: bool = True,
    ) -> None:
        if umo in self._appraising:
            return
        self._appraising.add(umo)
        try:
            provider = self._resolve_provider(umo)
            if provider is None:
                return

            context_lines: list[str] = []
            for item in (recent or [])[-3:]:
                try:
                    stamp = datetime.fromtimestamp(
                        float(item.get("t") or 0), self.tz
                    ).strftime("%H:%M")
                except Exception:  # noqa: BLE001
                    stamp = ""
                u = str(item.get("u") or "").strip()
                a = str(item.get("a") or "").strip()
                if u:
                    context_lines.append(f"{stamp} 他：{u}")
                if a:
                    context_lines.append(f"{stamp} 你：{a}")
            history_text = "\n".join(context_lines) or "（没有更早的记录）"

            current_lines: list[str] = []
            session = self._session(umo)
            for name, item in (session.get("emotions") or {}).items():
                if name not in EMOTIONS:
                    continue
                value = self._decayed(name, item)
                if value < 0.02:
                    continue
                reason = str(item.get("reason") or "").strip()
                current_lines.append(
                    f"- {name} {value:.2f}" + (f"（{reason}）" if reason else "")
                )
            current_text = "\n".join(current_lines) or "（平静）"

            is_group = "GroupMessage" in umo
            if is_group:
                sender = ""
                try:
                    sender = str(event.get_sender_name() or "").strip()
                except Exception:  # noqa: BLE001
                    sender = ""
                prompt = (
                    "【刚才群里这几轮】\n"
                    f"{history_text}\n\n"
                    "【你现在的情绪】\n"
                    f"{current_text}\n\n"
                    "【这一轮】\n"
                    f"{sender or '群里的人'}：{user_text}\n\n"
                    "【你刚才回的】\n"
                    f"{reply_text}\n\n"
                    "现在没人看着，说说你心里起了什么变化。"
                )
                system_prompt = APPRAISE_SYSTEM_GROUP
            else:
                prompt = (
                    "【刚才这几轮】\n"
                    f"{history_text}\n\n"
                    "【你现在的情绪】\n"
                    f"{current_text}\n\n"
                    "【这一轮】\n"
                    f"他：{user_text}\n\n"
                    "【你刚才回的】\n"
                    f"{reply_text}\n\n"
                    "现在没人看着，说说你心里起了什么变化。"
                )
                system_prompt = APPRAISE_SYSTEM_PRIVATE
            if not allow_affection:
                system_prompt += (
                    "\n\n这轮不要输出 affection 字段，也不要改变好感度。"
                )

            response = await asyncio.wait_for(
                provider.text_chat(
                    prompt=prompt,
                    contexts=[],
                    system_prompt=system_prompt,
                    request_max_retries=1,
                ),
                timeout=self.appraise_timeout,
            )
            raw = (getattr(response, "completion_text", None) or "").strip()
            data = self._parse_json(raw)
            if not data:
                return
            await self._apply(umo, data)
            if allow_affection:
                await self._apply_affection_delta(
                    umo, data.get("affection")
                )
                await self._maybe_grant_affection_bonus(umo)
        except asyncio.TimeoutError:
            logger.debug("[mood] [%s] 评价超时，跳过本轮", _tag(umo))
        except Exception as e:  # noqa: BLE001
            logger.debug("[mood] [%s] 评价失败（忽略）：%s", _tag(umo), e)
        finally:
            self._appraising.discard(umo)

    async def _apply(
        self, umo: str, data: dict, *, write_memory: bool = True
    ) -> None:
        thought = str(data.get("thought") or "").strip()[:80]
        raw_updates = data.get("updates")
        if isinstance(raw_updates, list):
            updates = [u for u in raw_updates if isinstance(u, dict)]
        elif data.get("emotion"):
            updates = [data]
        else:
            updates = []

        now = time.time()
        async with self._lock:
            session = self._session(umo)
            session["updated"] = now

            if thought:
                session["last_thought"] = thought
                session["thought_ts"] = now

            for update in updates[:3]:
                emotion = str(update.get("emotion") or "").strip()
                reason = str(update.get("reason") or "").strip()[:60]
                try:
                    delta = float(update.get("delta") or 0)
                except (TypeError, ValueError):
                    delta = 0.0
                if emotion not in EMOTIONS or abs(delta) < 0.05:
                    continue

                item = session["emotions"].get(emotion) or {}
                pinned = bool(item.get("pinned"))
                if emotion == "生气" and (pinned or session.get("cold_war")):
                    # 冷战期间生气只许升不许降，除非走 end_cold_war。
                    if delta < 0:
                        continue
                current = self._decayed(emotion, item) if item else 0.0
                if delta > 0:
                    # 越接近 1.0 越难再加，避免几轮就顶满
                    new_value = current + delta * (1.0 - current)
                else:
                    # 修复不打折
                    new_value = current + delta
                new_value = max(0.0, min(1.0, new_value))

                if new_value <= 0.05:
                    if delta < 0:
                        # 修复后留一点余味，最多保留 residual_hours
                        session["emotions"][emotion] = {
                            "intensity": RESIDUAL_FLOOR,
                            "ts": now,
                            "reason": reason,
                            "residual_until": now + self.residual_hours * 3600,
                        }
                        logger.info(
                            "[mood] [%s] 修复：%s %+.2f → 余味 %.2f（%s）",
                            _tag(umo),
                            emotion,
                            delta,
                            RESIDUAL_FLOOR,
                            reason or "无",
                        )
                    else:
                        session["emotions"].pop(emotion, None)
                        logger.info(
                            "[mood] [%s] 清空：%s %+.2f（%s）",
                            _tag(umo),
                            emotion,
                            delta,
                            reason or "无",
                        )
                    continue

                new_item = {
                    "intensity": round(new_value, 3),
                    "ts": now,
                    "reason": reason,
                }
                if pinned or (emotion == "生气" and session.get("cold_war")):
                    new_item["pinned"] = True
                    new_item["intensity"] = max(
                        round(new_value, 3), self.cold_war_anger
                    )
                session["emotions"][emotion] = new_item
                logger.info(
                    "[mood] [%s] 评价：%s %+.2f → %.2f（%s）",
                    _tag(umo),
                    emotion,
                    delta,
                    new_value,
                    reason or "无",
                )
                if write_memory and new_value >= self.memory_write_threshold:
                    self._write_memory(umo, emotion, new_value, reason)
            self._save_state()

    async def apply_external(
        self,
        umo: str,
        updates: list[dict],
        reason: str = "",
        *,
        write_memory: bool = False,
    ) -> None:
        """给其他插件用的入口：按事件调整情绪，默认不写长期记忆。"""
        normalized: list[dict] = []
        for update in updates or []:
            if not isinstance(update, dict):
                continue
            item = dict(update)
            if not str(item.get("reason") or "").strip():
                item["reason"] = reason
            normalized.append(item)
        if not normalized:
            return
        await self._apply(
            umo,
            {"updates": normalized, "thought": ""},
            write_memory=write_memory,
        )

    async def set_emotion(
        self,
        umo: str,
        name: str,
        value: float,
        reason: str = "",
        *,
        pinned: bool = False,
    ) -> None:
        """给其他插件用的入口：把某个情绪直接设成绝对强度。"""
        if not self.enabled or name not in EMOTIONS:
            return
        try:
            intensity = max(0.0, min(1.0, float(value)))
        except (TypeError, ValueError):
            return
        now = time.time()
        async with self._lock:
            session = self._session(umo)
            emotions = session.setdefault("emotions", {})
            if intensity <= 0.02:
                emotions.pop(name, None)
            else:
                emotions[name] = {
                    "intensity": intensity,
                    "ts": now,
                    "reason": str(reason or "")[:60],
                    "pinned": bool(pinned),
                }
            session["updated"] = now
            self._save_state()
        logger.info(
            "[mood] [%s] 设置情绪 %s = %.2f（%s）",
            _tag(umo),
            name,
            intensity,
            reason or "无",
        )

    def get_snapshot(self, umo: str) -> dict[str, float]:
        """返回当前会话衰减后的情绪，供其他插件读取。"""
        session = self.sessions.get(umo)
        if not session:
            return {}
        out: dict[str, float] = {}
        for name, item in (session.get("emotions") or {}).items():
            if name not in EMOTIONS:
                continue
            value = self._decayed(name, item)
            if value >= 0.02:
                out[name] = round(value, 3)
        return out

    def get_block(self, umo: str) -> str:
        """返回注入用的心情块，供主动消息复用。"""
        parts = [self._build_block(umo), self._affection_attitude_block(umo)]
        return "\n\n".join(part for part in parts if part)

    def get_affection(self, umo: str) -> dict:
        """只读返回当前好感状态，供生活/主动消息判断边界。"""
        if not self.affection_enabled or umo != self.umo:
            return {}
        session = self.sessions.get(umo) or {}
        aff = session.get("affection") or {}
        if not aff:
            return {}
        value = float(aff.get("value") or 0.0)
        partner = bool(aff.get("partner"))
        return {
            "value": value,
            "partner": partner,
            "stage": self._affection_stage(value, partner),
            "breakup_pending": bool(aff.get("breakup_pending")),
        }

    # ------------------------------------------------------------------ 冷战
    def is_cold_war(self, umo: str) -> bool:
        """当前会话是否处于冷战：显式标记，或生气已经到阈值。"""
        if not self.cold_war_enabled:
            return False
        session = self.sessions.get(umo)
        if not session:
            return False
        if session.get("cold_war"):
            return True
        anger = self._decayed(
            "生气", (session.get("emotions") or {}).get("生气") or {}
        )
        return anger >= self.cold_war_threshold

    async def start_cold_war(self, umo: str, reason: str = "") -> None:
        """把生气锁到阈值以上，进入冷战。"""
        if not self.cold_war_enabled:
            return
        now = time.time()
        async with self._lock:
            session = self._session(umo)
            session["cold_war"] = True
            session["cold_war_since"] = now
            session["cold_war_reason"] = str(reason or "")[:120]
            session["updated"] = now
            session["emotions"]["生气"] = {
                "intensity": self.cold_war_anger,
                "ts": now,
                "reason": str(reason or "不想理他了")[:60],
                "pinned": True,
            }
            self._save_state()
        logger.info("[mood] [%s] 进入冷战：%s", _tag(umo), reason or "无")

    async def end_cold_war(self, umo: str, reason: str = "") -> None:
        """解除冷战，把生气降到阈值以下，但仍保留一点余味。"""
        now = time.time()
        async with self._lock:
            session = self._session(umo)
            session["cold_war"] = False
            session["cold_war_reason"] = ""
            session["updated"] = now
            item = session["emotions"].get("生气")
            if item:
                item.pop("pinned", None)
                item["intensity"] = self.cold_war_release_anger
                item["ts"] = now
                if reason:
                    item["reason"] = str(reason)[:60]
            self._save_state()
        logger.info("[mood] [%s] 解除冷战：%s", _tag(umo), reason or "无")

    async def _appraise_cold_war(self, umo: str, user_text: str) -> dict:
        """冷战期间只评价用户这句话是不是在安慰，不生成正式回复。"""
        if umo in self._cold_war_appraising:
            return {}
        self._cold_war_appraising.add(umo)
        try:
            provider = self._resolve_provider(umo)
            if provider is None:
                return {}
            session = self._session(umo)
            anger = self._decayed(
                "生气", (session.get("emotions") or {}).get("生气") or {}
            )
            recent = list(session.get("recent") or [])[-3:]
            context_lines: list[str] = []
            for item in recent:
                try:
                    stamp = datetime.fromtimestamp(
                        float(item.get("t") or 0), self.tz
                    ).strftime("%H:%M")
                except Exception:  # noqa: BLE001
                    stamp = ""
                u = str(item.get("u") or "").strip()
                a = str(item.get("a") or "").strip()
                if u:
                    context_lines.append(f"{stamp} 他：{u}")
                if a:
                    context_lines.append(f"{stamp} 你：{a}")
            history_text = "\n".join(context_lines) or "（没有更早的记录）"
            prompt = (
                "【你现在的状态】\n"
                f"你正在和他冷战，生气 {anger:.2f}，不想理他。\n\n"
                "【刚才这几轮】\n"
                f"{history_text}\n\n"
                "【他刚才说】\n"
                f"{user_text[-600:]}\n\n"
                "先判断：这句话是不是在主动安慰你、道歉、哄你、解释，或者保证以后会回你？\n"
                "- 是：comfort=true，并给一句很短的回复（1-2 段，冷一点，但别太过）。\n"
                "- 不是：comfort=false，不要回复。\n"
                "他在质问、催促、发表情、只说「在吗」时，不算安慰。\n"
                "thought 写你心里的一句话，第一人称，很短。\n"
                "updates 只写其他情绪（委屈/失落/累/担心等），不要写生气；生气由插件锁定。\n"
                "只输出 JSON：\n"
                '{"comfort": true, "reply": ["……知道了。", "下不为例。"], '
                '"thought": "……", "updates": []}'
            )
            system_prompt = (
                "你是二阶堂希罗。你正在和他冷战。\n"
                "不要分析他想要什么，不要想「我该怎么回」。\n"
                "只判断他这句话是不是在主动安慰你，并写下你心里的一句话。\n"
                "只输出 JSON，不要代码块、不要解释。"
            )
            response = await asyncio.wait_for(
                provider.text_chat(
                    prompt=prompt,
                    contexts=[],
                    system_prompt=system_prompt,
                    request_max_retries=1,
                ),
                timeout=self.cold_war_appraise_timeout,
            )
            raw = (getattr(response, "completion_text", None) or "").strip()
            data = self._parse_json(raw)
            if not isinstance(data, dict):
                return {}
            comfort = bool(data.get("comfort"))
            raw_reply = data.get("reply")
            if isinstance(raw_reply, str):
                reply_parts = [raw_reply]
            elif isinstance(raw_reply, list):
                reply_parts = [str(x) for x in raw_reply if str(x).strip()]
            else:
                reply_parts = []
            reply = "\n".join(
                part.strip() for part in reply_parts[:2] if part.strip()
            )
            thought = str(data.get("thought") or "").strip()[:80]
            updates = data.get("updates")
            if not isinstance(updates, list):
                updates = []
            updates = [
                u
                for u in updates
                if isinstance(u, dict)
                and str(u.get("emotion") or "").strip() != "生气"
            ]
            if comfort:
                await self.end_cold_war(umo, "他主动来哄我了")
                if not reply:
                    reply = "……知道了。\n下不为例。"
            await self._apply(
                umo,
                {"updates": updates, "thought": thought},
                write_memory=False,
            )
            async with self._lock:
                session = self._session(umo)
                session["recent"] = (
                    list(session.get("recent") or [])
                    + [
                        {
                            "u": user_text[-300:],
                            "a": reply[-300:],
                            "t": time.time(),
                        }
                    ]
                )[-3:]
                self._save_state()
            return {"comfort": comfort, "reply": reply, "thought": thought}
        except asyncio.TimeoutError:
            logger.warning("[mood] 冷战评价超时（%s），保持冷战", _tag(umo))
            return {}
        except Exception as e:  # noqa: BLE001
            logger.warning("[mood] 冷战评价失败（忽略）：%s", e)
            return {}
        finally:
            self._cold_war_appraising.discard(umo)

    async def _handle_cold_war_request(
        self, event: AstrMessageEvent, umo: str
    ) -> None:
        text = (event.message_str or "").strip()
        if self.cold_war_allow_commands and (
            text.startswith("/") or text.startswith("#")
        ):
            return
        session = self._session(umo)
        if not session.get("cold_war"):
            await self.start_cold_war(umo, "生气到 0.9 了")
        result = await self._appraise_cold_war(umo, text)
        if result.get("comfort"):
            reply = str(result.get("reply") or "").strip()
            if reply:
                try:
                    await self.context.send_message(
                        umo, MessageChain(chain=[Plain(reply)])
                    )
                except Exception as e:  # noqa: BLE001
                    logger.warning("[mood] 冷战解除回复发送失败：%s", e)
            event.stop_event()
            return
        event.should_call_llm(False)
        event.stop_event()

    # ------------------------------------------------------------------ 好感事件
    def _affection_provider(self, umo: str):
        if self.affection_provider_id:
            try:
                getter = getattr(self.context, "get_provider_by_id", None)
                provider = getter(self.affection_provider_id) if getter else None
                if provider is not None:
                    return provider
            except Exception as e:  # noqa: BLE001
                logger.warning(
                    "[mood] 好感 provider %r 不可用：%s",
                    self.affection_provider_id,
                    e,
                )
        return self._resolve_provider(umo)

    def _recent_context(self, session: dict) -> str:
        lines: list[str] = []
        for item in (session.get("recent") or [])[-3:]:
            try:
                stamp = datetime.fromtimestamp(
                    float(item.get("t") or 0), self.tz
                ).strftime("%H:%M")
            except Exception:  # noqa: BLE001
                stamp = ""
            u = str(item.get("u") or "").strip()
            a = str(item.get("a") or "").strip()
            if u:
                lines.append(f"{stamp} 他：{u}")
            if a:
                lines.append(f"{stamp} 你：{a}")
        return "\n".join(lines) or "（没有更早的记录）"

    def _write_relation_memory(self, umo: str, text: str, imp: int = 5) -> None:
        if not self.memory_write_enabled or umo != self.memory_umo:
            return
        today = datetime.now(self.tz).strftime("%Y-%m-%d")
        root = Path(get_astrbot_plugin_data_path()) / "astrbot_plugin_hiro_memory"
        path = root / "memory" / f"{today}.jsonl"
        entry = {
            "date": today,
            "kind": "关系",
            "imp": imp,
            "text": text[:120],
            "scope": self.memory_scope,
        }
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
            marker_dir = root / "reindex"
            marker_dir.mkdir(parents=True, exist_ok=True)
            safe_scope = (
                re.sub(r"[^A-Za-z0-9_-]+", "-", self.memory_scope)[:40] or "x"
            )
            marker = marker_dir / f"{today}-{safe_scope}.json"
            marker.write_text(
                json.dumps(
                    {
                        "day": today,
                        "scope": self.memory_scope,
                        "op": "affection",
                        "ts": int(time.time()),
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("[mood] 写入关系记忆失败（忽略）：%s", e)

    async def _append_history(self, umo: str, text: str) -> None:
        if not text.strip():
            return
        cm = getattr(self.context, "conversation_manager", None)
        if cm is None:
            return
        async with self._history_lock:
            try:
                cid = await cm.get_curr_conversation_id(umo)
                if not cid:
                    return
                conv = await cm.get_conversation(umo, cid)
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
                    umo, conversation_id=cid, history=history
                )
            except Exception as e:  # noqa: BLE001
                logger.warning("[mood] 写入会话历史失败（忽略）：%s", e)

    async def _generate_breakup_text(self, umo: str) -> str:
        provider = self._affection_provider(umo)
        if provider is None:
            return "……我们到此为止吧。"
        prompt = (
            "你是二阶堂希罗。你和他已经进入伴侣线，但最近他冷落你，"
            "好感掉到 80 以下。你想主动提出分手。\n"
            "写 1 到 2 句，第一人称，冷一点，短，不要提数值，不要解释太多。\n"
            "只输出正文。"
        )
        system_prompt = (
            "你是二阶堂希罗。不要写解释、不要提规则、不要用 Markdown。"
        )
        try:
            response = await asyncio.wait_for(
                provider.text_chat(
                    prompt=prompt,
                    contexts=[],
                    system_prompt=system_prompt,
                    request_max_retries=1,
                ),
                timeout=self.cold_war_appraise_timeout,
            )
            text = (getattr(response, "completion_text", None) or "").strip()
            text = re.sub(r"^[「“\"']|[」”\"']$", "", text).strip()
            return text[:120] or "……我们到此为止吧。"
        except Exception as e:  # noqa: BLE001
            logger.warning("[mood] 分手文案生成失败（用兜底）：%s", e)
            return "……我们到此为止吧。"

    def _sleep_plugin(self):
        try:
            star = self.context.get_registered_star(
                "astrbot_plugin_hiro_sleep"
            )
            return getattr(star, "star_cls", None) if star else None
        except Exception:  # noqa: BLE001
            return None

    def _is_sleep_quiet(self, umo: str) -> bool:
        """睡眠插件是否处在夜间休息状态；读不到就按清醒处理。"""
        plugin = self._sleep_plugin()
        fn = getattr(plugin, "is_night_rest", None)
        if not callable(fn):
            return False
        try:
            return bool(fn(umo))
        except Exception as e:  # noqa: BLE001
            logger.debug("[mood] 读取睡眠状态失败：%s", e)
            return False

    async def _propose_breakup(self, umo: str) -> None:
        if umo in self._breakup_proposing:
            return
        if self._is_sleep_quiet(umo):
            logger.info("[mood] [%s] 夜间休息中，分手提议延后", _tag(umo))
            return
        self._breakup_proposing.add(umo)
        try:
            session = self.sessions.get(umo) or {}
            aff = session.get("affection") or {}
            if not aff.get("breakup_pending") or aff.get("breakup_proposed"):
                return
            text = await self._generate_breakup_text(umo)
            try:
                await self.context.send_message(
                    umo, MessageChain(chain=[Plain(text)])
                )
            except Exception as e:  # noqa: BLE001
                logger.warning("[mood] 分手消息发送失败：%s", e)
                return
            async with self._lock:
                session = self._session(umo)
                aff = session.get("affection") or {}
                aff["breakup_proposed"] = True
                aff["breakup_since"] = time.time()
                session["recent"] = (
                    list(session.get("recent") or [])
                    + [{"u": "", "a": text[-300:], "t": time.time()}]
                )[-3:]
                self._save_state()
            await self._append_history(umo, text)
            logger.info("[mood] [%s] 已提出分手：%s", _tag(umo), text[:60])
        finally:
            self._breakup_proposing.discard(umo)

    async def _appraise_breakup_save(self, umo: str, user_text: str) -> dict:
        if umo in self._affection_appraising:
            return {}
        self._affection_appraising.add(umo)
        try:
            provider = self._affection_provider(umo)
            if provider is None:
                return {}
            session = self._session(umo)
            context_text = self._recent_context(session)
            prompt = (
                "你刚提出了分手。他刚才说：\n"
                f"{user_text[-600:]}\n\n"
                "【刚才这几轮】\n"
                f"{context_text}\n\n"
                "先判断：他是在认真挽回、道歉、保证，还是只是随便说说/质问/发表情？\n"
                "- 如果是认真挽回：save=true，并给一句很短的回复（1-2 段，冷一点，但可以心软）。\n"
                "- 如果不是：save=false，不要回复。\n"
                "thought 写你心里的一句话，第一人称，很短。\n"
                "只输出 JSON：\n"
                '{"save": true, "reply": "……下不为例。", "thought": "……"}'
            )
            system_prompt = (
                "你是二阶堂希罗。你刚提出了分手，正在等他挽回。\n"
                "不要分析他想要什么，只判断他是不是在认真挽回。只输出 JSON。"
            )
            response = await asyncio.wait_for(
                provider.text_chat(
                    prompt=prompt,
                    contexts=[],
                    system_prompt=system_prompt,
                    request_max_retries=1,
                ),
                timeout=self.cold_war_appraise_timeout,
            )
            data = self._parse_json(
                (getattr(response, "completion_text", None) or "").strip()
            )
            if not isinstance(data, dict):
                return {}
            return {
                "save": bool(data.get("save")),
                "reply": str(data.get("reply") or "").strip()[:120],
                "thought": str(data.get("thought") or "").strip()[:80],
            }
        except asyncio.TimeoutError:
            logger.warning("[mood] 分手挽回评价超时（%s）", _tag(umo))
            return {}
        except Exception as e:  # noqa: BLE001
            logger.warning("[mood] 分手挽回评价失败（忽略）：%s", e)
            return {}
        finally:
            self._affection_appraising.discard(umo)

    async def _handle_breakup_reply(self, event, umo: str, req) -> bool:
        session = self.sessions.get(umo) or {}
        aff = session.get("affection") or {}
        if not aff.get("breakup_pending") or not aff.get("breakup_proposed"):
            return False
        user_text = (event.message_str or "").strip()
        if not user_text:
            return False
        if user_text.startswith("/") or user_text.startswith("#"):
            return False
        result = await self._appraise_breakup_save(umo, user_text)
        save = bool(result.get("save"))
        if not result:
            save = bool(
                re.search(
                    r"(对不起|我错了|别分手|不要分手|再给我|我会改|别走|"
                    r"挽留|原谅我|哄你|我陪你|不想失去你)",
                    user_text,
                )
            )
        async with self._lock:
            session = self._session(umo)
            aff = session.get("affection") or {}
            aff["breakup_pending"] = False
            aff["breakup_proposed"] = False
            aff["breakup_since"] = 0
            if save:
                aff["value"] = self.affection_breakup_save
                aff["partner"] = True
                note = (
                    "你刚提出了分手，但他刚才在认真挽回你。你心软了，"
                    "决定再给他一次机会。你们继续伴侣线。"
                )
                memory = (
                    "他挽回了我；我决定再给他一次机会，好感回到"
                    f"{self.affection_breakup_save:.0f}。"
                )
            else:
                aff["value"] = self.affection_confession_fail
                aff["partner"] = False
                note = (
                    "你刚提出了分手，他没有认真挽回/你没有接受。"
                    "你们已经分手，关系回到朋友线。"
                )
                memory = (
                    "我们分手了；好感掉到"
                    f"{self.affection_confession_fail:.0f}，关系回到朋友线。"
                )
            session["cold_war"] = False
            anger = (session.get("emotions") or {}).get("生气")
            if anger:
                anger.pop("pinned", None)
            self._save_state()
        self._write_relation_memory(umo, memory)
        req.system_prompt = (
            (req.system_prompt or "") + "\n\n【刚刚的分手结果】\n" + note
        )
        if result.get("reply"):
            req.system_prompt += "\n你可以参考这个方向：" + result["reply"]
        event.set_extra("mood_skip_affection", True)
        logger.info(
            "[mood] [%s] 分手挽回%s", _tag(umo), "成功" if save else "失败"
        )
        return True

    async def _classify_confession(self, umo: str, user_text: str) -> dict:
        if umo in self._affection_appraising:
            return {}
        self._affection_appraising.add(umo)
        try:
            provider = self._affection_provider(umo)
            if provider is None:
                return {}
            session = self._session(umo)
            aff = session.get("affection") or {}
            value = float(aff.get("value") or 0.0)
            cap = self._affection_cap(session)
            stage = self._affection_stage(value, bool(aff.get("partner")))
            context_text = self._recent_context(session)
            prompt = (
                "你和他已经聊了很久。现在好感度 "
                f"{value:.0f}/{cap:.0f}（{stage}）。\n"
                "艾玛是你最好的朋友，是你生命里不会消失的人；你和他的关系不会伤到她。\n\n"
                "【刚才这几轮】\n"
                f"{context_text}\n\n"
                "【他刚才说】\n"
                f"{user_text[-600:]}\n\n"
                "先判断：这是认真的表白，还是日常撒娇/玩笑/普通说「爱你」？\n"
                "- 如果不是认真表白：confession=false。\n"
                "- 如果是认真表白，并且好感度已经到 100：判断你是否接受。\n"
                "  接受的条件：你对他确实有伴侣线的心意，气氛/时机/诚意足够；不是只看数值。\n"
                "- 如果好感度不到 100：confession=true，accept=false（正常拒绝，不掉好感）。\n"
                "reply_hint 写一句你可能会怎么回，短一点。\n"
                "thought 写你心里的一句话，第一人称，很短。\n"
                "只输出 JSON：\n"
                '{"confession": true, "accept": false, '
                '"reply_hint": "……", "thought": "……"}'
            )
            system_prompt = (
                "你是二阶堂希罗。不要分析他想要什么，只判断这是不是认真表白，"
                "以及你是否接受。只输出 JSON。"
            )
            response = await asyncio.wait_for(
                provider.text_chat(
                    prompt=prompt,
                    contexts=[],
                    system_prompt=system_prompt,
                    request_max_retries=1,
                ),
                timeout=self.cold_war_appraise_timeout,
            )
            data = self._parse_json(
                (getattr(response, "completion_text", None) or "").strip()
            )
            if not isinstance(data, dict):
                return {}
            return {
                "confession": bool(data.get("confession")),
                "accept": bool(data.get("accept")),
                "reply_hint": str(data.get("reply_hint") or "").strip()[:160],
                "thought": str(data.get("thought") or "").strip()[:80],
            }
        except asyncio.TimeoutError:
            logger.warning("[mood] 表白判定超时（%s）", _tag(umo))
            return {}
        except Exception as e:  # noqa: BLE001
            logger.warning("[mood] 表白判定失败（忽略）：%s", e)
            return {}
        finally:
            self._affection_appraising.discard(umo)

    async def _handle_confession(self, event, umo: str, req) -> bool:
        if not self.affection_enabled or umo != self.umo:
            return False
        text = (event.message_str or "").strip()
        if (
            not text
            or text.startswith("/")
            or text.startswith("#")
            or not CONFESSION_RE.search(text)
        ):
            return False
        session = self._session(umo)
        aff = session.get("affection") or {}
        if aff.get("partner"):
            return False
        result = await self._classify_confession(umo, text)
        if not result or not result.get("confession"):
            return False
        value = float(aff.get("value") or 0.0)
        if value < self.affection_confession_threshold:
            event.set_extra("mood_skip_affection", True)
            req.system_prompt = (
                (req.system_prompt or "")
                + "\n\n【刚刚的表白】\n"
                "他向你表白了，但你们还没到那一步。你正常拒绝他；"
                "这轮不要改变好感度。"
            )
            return True
        accept = bool(result.get("accept"))
        async with self._lock:
            session = self._session(umo)
            aff = session.get("affection") or {}
            if accept:
                aff["value"] = self.affection_confession_success
                aff["partner"] = True
                aff["breakup_pending"] = False
                aff["breakup_proposed"] = False
                note = (
                    "他向你表白了。你接受了他。你们进入伴侣线；"
                    "艾玛是你最好的朋友，她知道并为你高兴。"
                    "你可以在回复里承认他，不要再拿「不会越界」挡回去。"
                )
                memory = (
                    "他向我表白，我接受了；我们进入伴侣线。"
                    "艾玛是我最好的朋友，她知道并为我高兴。"
                )
            else:
                aff["value"] = self.affection_confession_fail
                aff["partner"] = False
                note = "他向你表白了。你拒绝了他。你们没有进入伴侣线。"
                memory = (
                    "他向我表白，我拒绝了；好感掉到"
                    f"{self.affection_confession_fail:.0f}。"
                )
            session["cold_war"] = False
            anger = (session.get("emotions") or {}).get("生气")
            if anger:
                anger.pop("pinned", None)
            self._save_state()
        self._write_relation_memory(umo, memory)
        req.system_prompt = (
            (req.system_prompt or "") + "\n\n【刚刚的表白结果】\n" + note
        )
        if result.get("reply_hint"):
            req.system_prompt += "\n你可以参考这个方向：" + result["reply_hint"]
        event.set_extra("mood_skip_affection", True)
        logger.info(
            "[mood] [%s] 表白%s → %.0f",
            _tag(umo),
            "接受" if accept else "拒绝",
            self.affection_confession_success
            if accept
            else self.affection_confession_fail,
        )
        return True

    # ------------------------------------------------------------------ 巡检
    async def _affection_tick(self, **_kwargs) -> None:
        if not self.affection_enabled:
            return
        umo = self.umo
        await self._decay_affection(umo)
        session = self.sessions.get(umo) or {}
        aff = session.get("affection") or {}
        if aff.get("breakup_pending") and not aff.get("breakup_proposed"):
            await self._propose_breakup(umo)

    async def _remove_jobs(self, manager) -> None:
        try:
            jobs = await manager.list_jobs(job_type="basic")
        except Exception as e:  # noqa: BLE001
            logger.warning("[mood] 读取任务列表失败：%s", e)
            return
        for job in jobs:
            if getattr(job, "name", "") == "mood_affection_tick":
                try:
                    await manager.delete_job(job.job_id)
                except Exception as e:  # noqa: BLE001
                    logger.warning("[mood] 删除旧任务失败：%s", e)

    async def initialize(self) -> None:
        if not self.enabled:
            return
        if self.affection_enabled:
            await self._decay_affection(self.umo)
            self._save_state()
        manager = getattr(self.context, "cron_manager", None)
        if manager is None:
            logger.warning("[mood] cron_manager 不可用，好感度巡检不会运行")
            return
        await self._remove_jobs(manager)
        try:
            await manager.add_basic_job(
                name="mood_affection_tick",
                cron_expression=self.affection_tick_cron,
                handler=self._affection_tick,
                description="好感度衰减与分手巡检",
                timezone=str(self.tz),
                persistent=False,
            )
            logger.info(
                "[mood] 已注册 mood_affection_tick：cron=%r",
                self.affection_tick_cron,
            )
        except Exception as e:  # noqa: BLE001
            logger.error("[mood] 注册好感度巡检失败：%s", e)

    async def terminate(self) -> None:
        manager = getattr(self.context, "cron_manager", None)
        if manager is not None:
            await self._remove_jobs(manager)

    # ------------------------------------------------------------------ 长期记忆
    def _write_memory(self, umo: str, emotion: str, intensity: float, reason: str) -> None:
        if not self.memory_write_enabled:
            return
        if umo != self.memory_umo:
            return
        now = time.time()
        session = self._session(umo)
        written = session.setdefault("memory_written", {})
        last = float(written.get(emotion) or 0)
        if now - last < 6 * 3600:
            return
        written[emotion] = now

        today = datetime.now(self.tz).strftime("%Y-%m-%d")
        phrase = MEMORY_PHRASE.get(emotion, "心里有波动")
        body = reason or "没有说清原因"
        text = f"希罗{phrase}：{body}"
        entry = {
            "date": today,
            "kind": "情绪",
            "imp": 4,
            "text": text[:120],
            "scope": self.memory_scope,
        }
        path = (
            Path(get_astrbot_plugin_data_path())
            / "astrbot_plugin_hiro_memory"
            / "memory"
            / f"{today}.jsonl"
        )
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
            logger.info("[mood] [%s] 写入长期记忆：%s", _tag(umo), text[:40])
        except Exception as e:  # noqa: BLE001
            logger.warning("[mood] 写入记忆失败（忽略）：%s", e)

    # ------------------------------------------------------------------ 注入
    def _build_block(self, umo: str) -> str:
        session = self._session(umo)
        items: list[tuple[float, str, dict]] = []
        for name, item in (session.get("emotions") or {}).items():
            if name not in EMOTIONS:
                continue
            value = self._decayed(name, item)
            if value >= self.min_intensity:
                items.append((value, name, item))
        items.sort(key=lambda x: x[0], reverse=True)

        lines: list[str] = list(self._affection_block_lines(umo))
        for _value, name, item in items[: self.inject_top]:
            reason = str(item.get("reason") or "").strip()
            phrase = PHRASE.get(name, "你心里有点事")
            lines.append(f"- {phrase}" + (f"：{reason}" if reason else ""))

        thought = str(session.get("last_thought") or "").strip()
        thought_ts = float(session.get("thought_ts") or 0)
        if thought and (time.time() - thought_ts) < self.thought_ttl * 60:
            lines.append(f"- 你心里还搁着一句：{thought}")

        if not lines:
            return ""
        block = "【你心里现在还搁着的事】\n" + "\n".join(lines)
        return block[: self.inject_max_chars]

    def _inject_blocks(self, umo: str, req: ProviderRequest) -> None:
        block = self._build_block(umo)
        if block:
            req.extra_user_content_parts.append(
                TextPart(text=block).mark_as_temp()
            )
        attitude = self._affection_attitude_block(umo)
        if attitude:
            req.extra_user_content_parts.append(
                TextPart(text=attitude).mark_as_temp()
            )

    @filter.on_llm_request()
    async def inject_mood(self, event: AstrMessageEvent, req: ProviderRequest) -> None:
        if not self.enabled:
            return
        # 点评等跳过回合不要触发好感衰减、表白 / 分手 / 冷战分支。
        if event.get_extra("mood_skip_appraisal") or event.get_extra("mood_skip_all"):
            return
        try:
            umo = event.unified_msg_origin
            if not umo:
                return
            text = (event.message_str or "").strip()
            is_command = text.startswith("/") or text.startswith("#")
            if self.affection_enabled and umo == self.umo and not is_command:
                await self._decay_affection(umo)
                if await self._handle_breakup_reply(event, umo, req):
                    self._inject_blocks(umo, req)
                    return
                if await self._handle_confession(event, umo, req):
                    self._inject_blocks(umo, req)
                    return
            if self.cold_war_enabled and self.is_cold_war(umo):
                await self._handle_cold_war_request(event, umo)
                return
            self._inject_blocks(umo, req)
        except Exception as e:  # noqa: BLE001
            logger.warning("[mood] 注入失败（忽略）：%s", e)

    # ------------------------------------------------------------------ 指令
    @filter.command("心情", alias={"/心情"})
    async def mood_command(self, event: AstrMessageEvent):
        if not event.is_admin():
            yield event.plain_result("这个只有主人能看。")
            return
        umo = event.unified_msg_origin
        args = [a for a in (event.message_str or "").split()[1:] if a]
        head = args[0] if args else ""

        if umo != self.umo and head in ("全部", "all"):
            yield event.plain_result("这个命令只能在主私聊用。")
            return
        if (
            umo != self.umo
            and head in ("重置", "reset", "清空")
            and len(args) > 1
            and args[1] in ("全部", "all")
        ):
            yield event.plain_result("这个命令只能在主私聊用。")
            return

        if head in ("全部", "all"):
            yield event.plain_result(self._all_status_text())
            return

        if head in ("冷战", "coldwar"):
            await self.start_cold_war(umo, "测试冷战")
            yield event.plain_result("已进入冷战（测试）。")
            return

        if head in ("解除冷战", "结束冷战", "uncold"):
            await self.end_cold_war(umo, "测试解除")
            yield event.plain_result("已解除冷战。")
            return

        if head in ("重置", "reset", "清空"):
            async with self._lock:
                if len(args) > 1 and args[1] in ("全部", "all"):
                    self.sessions.clear()
                    message = "所有会话的心情都清空了。"
                else:
                    self.sessions.pop(umo, None)
                    message = "这个会话的心情已经清空了。"
                self._save_state()
            yield event.plain_result(message)
            return

        yield event.plain_result(self._status_text(umo))

    @filter.command("好感", alias={"/好感"})
    async def affection_command(self, event: AstrMessageEvent):
        if not event.is_admin():
            yield event.plain_result("这个只有主人能看。")
            return
        umo = event.unified_msg_origin
        if not self.affection_enabled or umo != self.umo:
            yield event.plain_result("这个会话不记录好感度。")
            return
        await self._decay_affection(umo)
        args = [a for a in (event.message_str or "").split()[1:] if a]
        head = args[0] if args else ""
        if head in ("设置", "set"):
            if len(args) < 2:
                yield event.plain_result("用法：/好感 设置 30")
                return
            try:
                value = float(args[1])
            except ValueError:
                yield event.plain_result("用法：/好感 设置 30")
                return
            async with self._lock:
                session = self._session(umo)
                aff = session.get("affection") or {}
                cap = self._affection_cap(session)
                value = max(0.0, min(cap, value))
                aff["value"] = round(value, 3)
                aff["ts"] = time.time()
                aff["day"] = self._affection_day()
                aff["gain_today"] = 0.0
                aff["loss_today"] = 0.0
                aff["gain_cap_today"] = self.affection_daily_gain_cap
                if (
                    aff.get("partner")
                    and value < self.affection_breakup_threshold
                ):
                    aff["breakup_pending"] = True
                    aff["breakup_proposed"] = False
                    aff["breakup_since"] = time.time()
                else:
                    aff["breakup_pending"] = False
                    aff["breakup_proposed"] = False
                    aff["breakup_since"] = 0
                self._save_state()
            session = self.sessions.get(umo) or {}
            aff = session.get("affection") or {}
            if aff.get("breakup_pending") and not aff.get("breakup_proposed"):
                asyncio.create_task(self._propose_breakup(umo))
            yield event.plain_result(
                f"好感度已设为 {value:.0f}/{cap:.0f}。\n"
                + self._affection_status_text(umo)
            )
            return
        yield event.plain_result(
            "【好感度 · 私聊】\n" + self._affection_status_text(umo)
        )

    def _status_text(self, umo: str) -> str:
        lines = [f"【希罗现在的心情 · {_tag(umo)}】"]
        session = self.sessions.get(umo) or {}
        items = []
        for name, item in (session.get("emotions") or {}).items():
            if name not in EMOTIONS:
                continue
            value = self._decayed(name, item)
            if value > 0.02:
                items.append((value, name, item))
        items.sort(key=lambda x: x[0], reverse=True)
        if not items:
            lines.append("- 平静，没什么特别的。")
        now = time.time()
        for value, name, item in items:
            reason = str(item.get("reason") or "").strip()
            ts = float(item.get("ts") or 0)
            try:
                stamp = datetime.fromtimestamp(ts, self.tz).strftime("%H:%M")
            except Exception:  # noqa: BLE001
                stamp = ""
            age_h = (now - ts) / 3600 if ts else 0
            detail_parts: list[str] = []
            if stamp:
                detail_parts.append(stamp)
            if age_h > 2:
                detail_parts.append("旧事")
            if reason:
                detail_parts.append(reason)
            detail = " · ".join(detail_parts)
            lines.append(f"- {name} {value:.2f}" + (f"（{detail}）" if detail else ""))
        if session.get("cold_war"):
            lines.append("- 状态：冷战（等你来哄）")
        thought = str(session.get("last_thought") or "").strip()
        if thought:
            lines.append(f"- 最近一句心里话：{thought}")
        return "\n".join(lines)

    def _all_status_text(self) -> str:
        if not self.sessions:
            return "还没有任何会话的心情。"
        rows = sorted(
            self.sessions.items(),
            key=lambda kv: float(kv[1].get("updated") or 0),
            reverse=True,
        )
        lines = ["【所有会话的心情】"]
        for umo, session in rows[:20]:
            items = []
            for name, item in (session.get("emotions") or {}).items():
                if name not in EMOTIONS:
                    continue
                value = self._decayed(name, item)
                if value > 0.02:
                    items.append((value, name))
            items.sort(reverse=True)
            summary = "、".join(f"{n} {v:.2f}" for v, n in items[:3]) or "平静"
            lines.append(f"- [{_tag(umo)}] {umo}")
            lines.append(f"    {summary}")
        if len(rows) > 20:
            lines.append(f"……还有 {len(rows) - 20} 个会话")
        return "\n".join(lines)

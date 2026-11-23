"""astrbot_plugin_hiro_interaction — 希罗酱の真实交互

让希罗自己维护一份「怎么用第二指针」的 SKILL：

- 每次指针观察前，桥接从这里取当前 SKILL + 最近几次动作；
- 每次动作后，桥接把轨迹写回来；
- 你在聊天里夸她 / 纠正她，她在后台判断并改写 SKILL；
- 每累计 N 次动作，她自己复盘一次（原地微移、重复台词、动作单一）。

设计原则：
- 初版只服务【希罗指针】，但分区和接口给【随机点评】留了扩展位；
- 只认主私聊，群聊 / 网站访客不学习、不注入；
- 所有环节 fail-open：插件挂了，桥接自动退回默认提示词，不影响聊天和指针；
- SKILL 只写结构化条目，不整篇重写，避免模型越改越散。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.provider import LLMResponse
from astrbot.api.star import Context, Star, register
from astrbot.core.utils.astrbot_path import get_astrbot_plugin_data_path

PLUGIN_NAME = "astrbot_plugin_hiro_interaction"
PLUGIN_VERSION = "0.1.1"
DEFAULT_UMO = "Hiro:FriendMessage:1955272576"
DEFAULT_TZ = "Asia/Shanghai"

# 固定五个分区：模型只能往这些分区里加条目，不能自己发明结构。
SKILL_SECTIONS: tuple[tuple[str, str], ...] = (
    ("落点与避让直觉", "指针该停在哪、避开什么"),
    ("连续轨迹技巧", "画圈、晃动、指两处时怎么给 steps"),
    ("常见场景经验", "游戏 / 视频 / 代码 / 桌面闲置"),
    ("闲聊搭话风格", "移动时那句闲聊怎么说"),
    ("高优纠错与禁忌", "他明确夸过或批评过的点，权重最高"),
)
SECTION_NAMES = [name for name, _ in SKILL_SECTIONS]
SECTION_HINTS = {name: hint for name, hint in SKILL_SECTIONS}

MAX_BULLETS_PER_SECTION = 8
MAX_EDITS_PER_ROUND = 4
MAX_ITEM_CHARS = 160
CHANGELOG_KEEP = 20

SEED_SKILL = """## 落点与避让直觉
- 停在目标旁边，不压在目标正中央：留出半个身位，方便他继续看。
- 避开人脸、字幕条、对话框底部和密集文字；宁可停在窗口边缘的空白。
- 游戏里停在角色侧后方，不压血条、技能栏、任务追踪和小地图。
- 不确定时选画面里最空的一块，不要停在正在变化的内容上。

## 连续轨迹技巧
- 画圈、晃动、来回指要用 steps 一次给 4~8 个点，不要拆成好几次观察。
- 每步 duration_ms 300~600，hold_ms 通常为 0；只有最后一步停留 800~1600。
- 路径点首尾呼应：画圈最后回到起点附近，晃动左右各一次再回中间。
- 单点移动只用于凑近看某处，duration_ms 600~1200。

## 常见场景经验
- 看视频：停在画面右侧或下方空白，不盖字幕和人脸，动作幅度小一点。
- 玩游戏：停在角色侧边，跟着他看的方向，不挡战斗信息。
- 写代码或看文档：停在当前行右侧的空白，不压住代码。
- 桌面闲置：在人物附近慢慢游走，不要跑到屏幕角落。

## 闲聊搭话风格
- 每次移动说一句 8~40 字的话，像坐在旁边随口说，不解释自己在执行动作。
- 不要每次都用同一个开头；少用“好呀”“喏”，偶尔只描述看到的东西。
- 不提坐标、指针、截图、模型这些词。

## 高优纠错与禁忌
- 他说“挡住 / 画歪 / 太偏 / 别停这”时，下次必须换位置，并把修正写进这里。
- 他没要求时不要连续两次停在同一个点附近。
"""

FEEDBACK_SYSTEM = """你是希罗的指针操作复盘器，只负责判断：他刚才那句话，要不要更新希罗的《指针操作 SKILL》。
只输出一个 JSON 对象，不要解释，不要代码块，不要多余文字。

字段：
- verdict: "positive"（他肯定了刚才的操作）/ "negative"（他批评或纠正了）/ "new_rule"（他立了新规矩）/ "unrelated"（和指针无关）
- change: 一句话说明改了什么；不改就空字符串
- edits: 数组，最多 3 条；每条 {"section": 分区名, "op": "append" 或 "replace", "text": "一条经验，40 字以内"}

五个分区（section 必须原样使用）：
1. 落点与避让直觉
2. 连续轨迹技巧
3. 常见场景经验
4. 闲聊搭话风格
5. 高优纠错与禁忌

规则：
- 只有他的话确实在评价刚才的指针动作、位置、轨迹或那句闲聊时，才改。
- 普通聊天、聊游戏剧情、问别的事 → verdict="unrelated"，edits 为空。
- 他夸过的做法写成正面经验；他批评的写进「高优纠错与禁忌」，并给出替代做法。
- 不要写“他说……”，直接写成她下次能执行的规则。
- 不要重复已有条目；不要写超过 40 字的长句；一次最多改 3 条。"""

REFLECT_SYSTEM = """你是希罗的指针操作复盘器，只负责找问题并给出 SKILL 修正。
只输出一个 JSON 对象，不要解释，不要代码块。

字段：
- change: 一句话说明你改了什么；没问题就空字符串
- edits: 数组，最多 3 条；每条 {"section": 分区名, "op": "append" 或 "replace", "text": "一条经验，40 字以内"}

五个分区（section 必须原样使用）：
1. 落点与避让直觉
2. 连续轨迹技巧
3. 常见场景经验
4. 闲聊搭话风格
5. 高优纠错与禁忌

重点检查：
- 是否总在同一块区域原地微移；
- 闲聊是否反复用同一个开头 / 句式；
- 动作是否过于单一，几乎都是单点，没有用 steps 做连续动作。

没有问题就返回 {"change":"","edits":[]}。"""


def _bool(value: object, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    if isinstance(value, (int, float)):
        return bool(value)
    return default


def _clean_item(value: object) -> str:
    """把模型给的一条经验压成一行，去掉列表符号和多余空白。"""
    text = str(value or "").replace("\r", " ").replace("\n", " ").strip()
    text = re.sub(r"^[-*•\s]+", "", text)
    text = re.sub(r"\s+", " ", text)
    return text[:MAX_ITEM_CHARS]


def _parse_json(text: object) -> dict | None:
    if not isinstance(text, str) or not text.strip():
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


def _match_section(value: object) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    for name in SECTION_NAMES:
        if raw == name or raw in name or name in raw:
            return name
    keywords = {
        "落点与避让直觉": ("落点", "位置", "避让", "挡住", "停在", "边缘"),
        "连续轨迹技巧": ("轨迹", "画圈", "晃动", "steps", "连续", "路径"),
        "常见场景经验": ("场景", "游戏", "视频", "代码", "桌面", "浏览器"),
        "闲聊搭话风格": ("闲聊", "说话", "台词", "风格", "语气", "开口"),
        "高优纠错与禁忌": ("纠错", "禁忌", "批评", "偏好", "规矩", "夸奖"),
    }
    for name, words in keywords.items():
        if any(word in raw for word in words):
            return name
    return None


def _parse_skill(text: str) -> dict[str, list[str]]:
    """把 markdown 解析成 {分区: [条目]}；未知分区直接忽略。"""
    sections: dict[str, list[str]] = {name: [] for name in SECTION_NAMES}
    current: str | None = None
    for line in (text or "").splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            name = stripped[3:].strip()
            current = name if name in sections else None
            continue
        if current and stripped.startswith(("- ", "* ")):
            item = _clean_item(stripped[2:])
            if item and item not in sections[current]:
                sections[current].append(item)
    return sections


def _render_skill(
    sections: dict[str, list[str]],
    version: int,
    *,
    for_prompt: bool = False,
) -> str:
    if for_prompt:
        lines: list[str] = []
        for name in SECTION_NAMES:
            lines.append(f"【{name}】")
            items = sections.get(name) or []
            if items:
                lines.extend(f"- {item}" for item in items)
            else:
                lines.append("- （还没总结出经验）")
        return "\n".join(lines)
    lines = [
        f"# 希罗指针操作 SKILL · v{version}",
        "",
        "> 这是希罗自己整理的指针经验；每次移动前会读一遍，由她在后台持续改写。",
        "",
    ]
    for name, hint in SKILL_SECTIONS:
        lines.append(f"## {name}")
        lines.append(f"<!-- {hint} -->")
        items = sections.get(name) or []
        if items:
            lines.extend(f"- {item}" for item in items)
        else:
            lines.append("- （还没总结出经验）")
        lines.append("")
    return "\n".join(lines).strip() + "\n"


def _apply_edits(
    sections: dict[str, list[str]],
    edits: object,
    max_chars: int,
) -> list[tuple[str, str]]:
    """把模型给的 edits 合并进 SKILL；返回真正生效的 (分区, 条目)。"""
    changed: list[tuple[str, str]] = []
    if not isinstance(edits, list):
        return changed
    for edit in edits[:MAX_EDITS_PER_ROUND]:
        if not isinstance(edit, dict):
            continue
        section = _match_section(edit.get("section"))
        if section is None:
            continue
        text = _clean_item(edit.get("text"))
        if not text:
            continue
        op = str(edit.get("op") or "append").strip().lower()
        items = sections.setdefault(section, [])
        if op == "replace":
            if items == [text]:
                continue
            sections[section] = [text]
            changed.append((section, text))
        else:
            if text in items:
                continue
            items.append(text)
            changed.append((section, text))

    # 每节最多 8 条：新经验优先，旧条目从头部淘汰。
    for name in SECTION_NAMES:
        items = sections.get(name) or []
        if len(items) > MAX_BULLETS_PER_SECTION:
            sections[name] = items[-MAX_BULLETS_PER_SECTION:]

    # 总字数上限：从条目最多的分区删最旧的一条，每节至少留 2 条。
    while len(_render_skill(sections, 0, for_prompt=True)) > max_chars:
        candidates = [
            (len(sections.get(name) or []), name)
            for name in SECTION_NAMES
            if len(sections.get(name) or []) > 2
        ]
        if not candidates:
            break
        _, name = max(candidates)
        sections[name].pop(0)

    return changed


@register(PLUGIN_NAME, "MXJ", "希罗酱の真实交互", PLUGIN_VERSION)
class HiroInteractionPlugin(Star):
    def __init__(self, context: Context, config=None):
        super().__init__(context)
        self.config = config or {}

        self.enabled = _bool(self.config.get("enabled"), True)
        self.umo = str(self.config.get("umo") or DEFAULT_UMO).strip()
        self.provider_id = str(self.config.get("provider_id") or "").strip()
        self.tz = ZoneInfo(str(self.config.get("timezone") or DEFAULT_TZ))

        self.feedback_enabled = _bool(self.config.get("feedback_enabled"), True)
        self.feedback_window_sec = max(
            60, int(self.config.get("feedback_window_sec") or 600)
        )
        self.reflect_enabled = _bool(self.config.get("reflect_enabled"), True)
        self.reflect_every_n = max(3, int(self.config.get("reflect_every_n") or 15))
        self.skill_max_chars = max(400, int(self.config.get("skill_max_chars") or 900))
        self.episode_keep = max(20, int(self.config.get("episode_keep") or 200))
        self.recent_episodes = max(
            1, min(8, int(self.config.get("recent_episodes") or 3))
        )
        self.timeout = max(15, int(self.config.get("timeout") or 60))

        self.root = Path(get_astrbot_plugin_data_path()) / PLUGIN_NAME
        self.skill_path = self.root / "pointer_skill.md"
        self.episodes_path = self.root / "pointer_episodes.jsonl"
        self.changelog_path = self.root / "skill_changelog.jsonl"
        self.state_path = self.root / "skill_state.json"

        self._lock = asyncio.Lock()
        self._evaluating: set[str] = set()
        self._reflecting = False
        self._sections: dict[str, list[str]] = {name: [] for name in SECTION_NAMES}
        self._version = 1
        self._episodes: list[dict] = []
        self._changelog: list[dict] = []
        self._state: dict = {}
        self._loaded = False

    # ------------------------------------------------------------------ 生命周期
    async def initialize(self) -> None:
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            self._load_all()
            self._loaded = True
            logger.info(
                "[interaction] 已加载 v%s：%d 条经验，%d 次指针动作",
                self._version,
                sum(len(items) for items in self._sections.values()),
                len(self._episodes),
            )
        except Exception:
            logger.exception("[interaction] 初始化失败（fail-open）")

    async def terminate(self) -> None:
        self._loaded = False

    # ------------------------------------------------------------------ 公共接口（桥接调用）
    async def build_pointer_context(self, umo: str = "") -> str:
        """返回给指针观察模型的 SKILL + 最近动作；不适用时返回空串。"""
        if not self.enabled:
            return ""
        if umo and self.umo and umo != self.umo:
            return ""
        skill = _render_skill(self._sections, self._version, for_prompt=True)
        lines = ["〔你的指针操作 SKILL（你自己整理的，越用越准）〕", skill]
        recent = self._episodes[-self.recent_episodes :]
        if recent:
            lines.append("")
            lines.append("〔你最近几次把指针放到了哪〕")
            for episode in recent:
                lines.append(self._episode_line(episode))
        return "\n".join(lines) + "\n"

    async def get_pointer_skill_view(self) -> dict:
        """给桌面端左侧栏「SKILL」用的只读快照。"""
        if not self.enabled:
            return {"available": False, "error": "真实交互插件未启用。"}
        changes: list[dict] = []
        for entry in self._changelog[-5:]:
            ts = int(entry.get("ts") or 0)
            changes.append(
                {
                    "version": int(entry.get("version") or 0),
                    "ts": ts * 1000 if 0 < ts < 1_000_000_000_000 else ts,
                    "source": str(entry.get("source") or ""),
                    "change": str(entry.get("change") or ""),
                }
            )
        return {
            "available": True,
            "name": "希罗指针操作 SKILL",
            "version": self._version,
            "markdown": _render_skill(self._sections, self._version),
            "sections": [
                {"name": name, "items": list(self._sections.get(name) or [])}
                for name in SECTION_NAMES
            ],
            "stats": {
                "bullets": sum(len(items) for items in self._sections.values()),
                "episodes": len(self._episodes),
                "sinceReflect": max(
                    0, int(self._state.get("since_reflect") or 0)
                ),
                "reflectEveryN": self.reflect_every_n,
            },
            "changes": changes,
            "updatedAt": int(self._state.get("updated") or 0) * 1000
            or int(time.time() * 1000),
        }

    async def record_pointer_episode(
        self,
        umo: str = "",
        *,
        hint: str = "",
        steps: object = None,
        say: str = "",
        reason: str = "",
        duration_ms: int = 0,
        hold_ms: int = 0,
    ) -> None:
        """记录一次真实发生的指针动作；累计到阈值时安排一次后台复盘。"""
        if not self.enabled:
            return
        if umo and self.umo and umo != self.umo:
            return
        normalized: list[list[float]] = []
        if isinstance(steps, list):
            for item in steps[:8]:
                if not isinstance(item, dict):
                    continue
                try:
                    nx = float(item.get("nx"))
                    ny = float(item.get("ny"))
                except (TypeError, ValueError):
                    continue
                if not (0.0 <= nx <= 1.0 and 0.0 <= ny <= 1.0):
                    continue
                normalized.append([round(nx, 4), round(ny, 4)])
        if not normalized:
            return
        episode = {
            "ts": int(time.time() * 1000),
            "hint": _clean_item(hint)[:300],
            "steps": normalized,
            "say": _clean_item(say)[:120],
            "reason": _clean_item(reason)[:160],
            "duration_ms": max(0, int(duration_ms or 0)),
            "hold_ms": max(0, int(hold_ms or 0)),
        }
        due = False
        async with self._lock:
            self._episodes.append(episode)
            if len(self._episodes) > self.episode_keep:
                self._episodes = self._episodes[-self.episode_keep :]
                self._write_jsonl(self.episodes_path, self._episodes)
            else:
                self._append_jsonl(self.episodes_path, episode)
            since = int(self._state.get("since_reflect") or 0) + 1
            if self.reflect_enabled and since >= self.reflect_every_n:
                self._state["since_reflect"] = 0
                due = True
            else:
                self._state["since_reflect"] = since
            self._state["updated"] = int(time.time())
            self._save_state()
        if due:
            asyncio.create_task(self._reflect(self.umo))

    # ------------------------------------------------------------------ 反馈评估
    @filter.on_llm_response()
    async def on_llm_response(self, event: AstrMessageEvent, resp: LLMResponse) -> None:
        if not self.enabled or not self.feedback_enabled:
            return
        # 点评等非对话回合不参与学习。
        if event.get_extra("mood_skip_appraisal") or event.get_extra("mood_skip_all"):
            return
        umo = event.unified_msg_origin or ""
        if umo != self.umo:
            return
        user = (event.message_str or "").strip()
        reply = (getattr(resp, "completion_text", "") or "").strip()
        if not user or not reply:
            return
        if user.startswith("/") or user.startswith("#"):
            return
        episode = self._episodes[-1] if self._episodes else None
        if episode is None:
            return
        age = time.time() * 1000 - int(episode.get("ts") or 0)
        if age > self.feedback_window_sec * 1000:
            return
        if umo in self._evaluating:
            return
        self._evaluating.add(umo)
        asyncio.create_task(
            self._evaluate_feedback(umo, user[-600:], reply[-900:], episode)
        )

    async def _evaluate_feedback(
        self,
        umo: str,
        user_text: str,
        reply_text: str,
        episode: dict,
    ) -> None:
        try:
            provider = self._resolve_provider(umo)
            if provider is None:
                return
            skill = _render_skill(self._sections, self._version, for_prompt=True)
            recent = self._episodes[-3:]
            episode_text = "\n".join(self._episode_line(item) for item in recent)
            prompt = (
                "【当前 SKILL】\n"
                f"{skill}\n\n"
                "【最近几次指针动作】\n"
                f"{episode_text}\n\n"
                "【他刚才说】\n"
                f"{user_text}\n\n"
                "【你刚才回他】\n"
                f"{reply_text}\n\n"
                "判断他这句话是不是在评价刚才的指针操作。按格式只输出 JSON。"
            )
            response = await asyncio.wait_for(
                provider.text_chat(
                    prompt=prompt,
                    contexts=[],
                    system_prompt=FEEDBACK_SYSTEM,
                    request_max_retries=1,
                ),
                timeout=self.timeout,
            )
            raw = (getattr(response, "completion_text", "") or "").strip()
            data = _parse_json(raw)
            if not data:
                return
            verdict = str(data.get("verdict") or "").strip().lower()
            if verdict not in ("positive", "negative", "new_rule", "correction"):
                return
            change = _clean_item(data.get("change"))[:120]
            edits = data.get("edits")
            if not isinstance(edits, list) or not edits:
                return
            await self._apply_and_save(
                edits,
                source="feedback",
                verdict=verdict,
                change=change or "根据他的反馈微调",
                user=user_text,
            )
        except asyncio.TimeoutError:
            logger.debug("[interaction] 反馈评估超时，跳过")
        except Exception as e:  # noqa: BLE001
            logger.debug("[interaction] 反馈评估失败（忽略）：%s", e)
        finally:
            self._evaluating.discard(umo)

    # ------------------------------------------------------------------ 周期复盘
    async def _reflect(self, umo: str, *, manual: bool = False) -> dict:
        if not self.enabled or self._reflecting:
            return {"changed": 0, "message": "正在复盘，稍后再试。"}
        self._reflecting = True
        try:
            provider = self._resolve_provider(umo or self.umo)
            if provider is None:
                return {"changed": 0, "message": "没有可用的模型。"}
            episodes = self._episodes[-self.reflect_every_n :]
            if len(episodes) < 3:
                return {"changed": 0, "message": "指针动作还太少，先攒几次再复盘。"}
            skill = _render_skill(self._sections, self._version, for_prompt=True)
            episode_text = "\n".join(self._episode_line(item) for item in episodes)
            prompt = (
                "【当前 SKILL】\n"
                f"{skill}\n\n"
                f"【最近 {len(episodes)} 次指针动作】\n"
                f"{episode_text}\n\n"
                "请找问题并按格式输出 JSON。"
            )
            response = await asyncio.wait_for(
                provider.text_chat(
                    prompt=prompt,
                    contexts=[],
                    system_prompt=REFLECT_SYSTEM,
                    request_max_retries=1,
                ),
                timeout=self.timeout,
            )
            raw = (getattr(response, "completion_text", "") or "").strip()
            data = _parse_json(raw)
            if not data:
                return {"changed": 0, "message": "复盘结果解析失败，这轮不改。"}
            change = _clean_item(data.get("change"))[:120]
            edits = data.get("edits")
            if not isinstance(edits, list) or not edits:
                return {"changed": 0, "message": "复盘完成：没发现需要改的地方。"}
            changed = await self._apply_and_save(
                edits,
                source="reflect",
                verdict="reflect",
                change=change or "周期复盘微调",
                user="",
            )
            if not changed:
                return {"changed": 0, "message": "复盘完成：经验已经覆盖这些情况。"}
            return {
                "changed": len(changed),
                "message": f"复盘完成：更新了 {len(changed)} 条经验（v{self._version}）。",
            }
        except asyncio.TimeoutError:
            return {"changed": 0, "message": "复盘超时，这轮不改。"}
        except Exception as e:  # noqa: BLE001
            logger.debug("[interaction] 复盘失败（忽略）：%s", e)
            return {"changed": 0, "message": "复盘失败，这轮不改。"}
        finally:
            self._reflecting = False

    # ------------------------------------------------------------------ 指令
    @filter.command("交互", alias={"/交互"})
    async def interaction_command(self, event: AstrMessageEvent):
        if not event.is_admin():
            yield event.plain_result("这个只有主人能看。")
            return
        umo = event.unified_msg_origin or ""
        if umo != self.umo:
            yield event.plain_result("这个命令只能在主私聊用。")
            return
        args = [a for a in (event.message_str or "").split()[1:] if a]
        head = args[0] if args else ""

        if head in ("历史", "记录", "history"):
            yield event.plain_result(self._history_text())
            return
        if head in ("回退", "撤销", "rollback"):
            ok, message = await self.rollback_skill()
            yield event.plain_result(message)
            return
        if head in ("复盘", "reflect"):
            result = await self._reflect(self.umo, manual=True)
            yield event.plain_result(result["message"])
            return
        if head in ("统计", "状态", "status"):
            yield event.plain_result(self._status_text())
            return
        yield event.plain_result(self._skill_text())

    async def rollback_skill(self) -> tuple[bool, str]:
        async with self._lock:
            if len(self._changelog) < 2:
                return False, "还没有可回退的上一版。"
            previous = self._changelog[-2]
            skill_text = str(previous.get("skill") or "")
            sections = _parse_skill(skill_text)
            if not any(sections.values()):
                return False, "上一版内容损坏，回退失败。"
            self._version += 1
            self._sections = sections
            self._write_skill(sections, self._version)
            self._append_changelog(
                {
                    "version": self._version,
                    "ts": int(time.time()),
                    "source": "rollback",
                    "verdict": "rollback",
                    "change": f"回退到 v{previous.get('version')} 的经验",
                    "user": "",
                    "skill": _render_skill(sections, self._version),
                }
            )
            return True, (
                f"已回退到 v{previous.get('version')} 的经验"
                f"（当前记为 v{self._version}）。"
            )

    # ------------------------------------------------------------------ 落盘
    def _load_all(self) -> None:
        self._state = self._read_json(self.state_path) or {}
        self._version = max(1, int(self._state.get("version") or 1))
        self._changelog = self._read_jsonl(self.changelog_path)[-CHANGELOG_KEEP:]
        self._episodes = self._read_jsonl(self.episodes_path)[-self.episode_keep :]
        text = ""
        try:
            if self.skill_path.exists():
                text = self.skill_path.read_text(encoding="utf-8")
        except Exception:
            logger.exception("[interaction] 读取 pointer_skill.md 失败")
        sections = _parse_skill(text)
        if not any(sections.values()):
            sections = _parse_skill(SEED_SKILL)
            self._write_skill(sections, self._version)
        self._sections = sections
        if not self._changelog:
            # 记下初始版本，保证第一次改写后也能回退到种子经验。
            self._append_changelog(
                {
                    "version": self._version,
                    "ts": int(time.time()),
                    "source": "seed",
                    "verdict": "seed",
                    "change": "初始 SKILL",
                    "user": "",
                    "skill": _render_skill(sections, self._version),
                }
            )
        if not self._state:
            self._state = {
                "version": self._version,
                "since_reflect": 0,
                "updated": int(time.time()),
            }
            self._save_state()

    def _write_skill(self, sections: dict[str, list[str]], version: int) -> None:
        self._atomic_write(self.skill_path, _render_skill(sections, version))

    def _save_state(self) -> None:
        self._state["version"] = self._version
        self._atomic_write(
            self.state_path,
            json.dumps(self._state, ensure_ascii=False, indent=2) + "\n",
        )

    def _append_changelog(self, entry: dict) -> None:
        self._changelog.append(entry)
        if len(self._changelog) > CHANGELOG_KEEP:
            self._changelog = self._changelog[-CHANGELOG_KEEP:]
        self._write_jsonl(self.changelog_path, self._changelog)

    @staticmethod
    def _atomic_write(path: Path, text: str) -> None:
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)

    @staticmethod
    def _append_jsonl(path: Path, entry: dict) -> None:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")

    @staticmethod
    def _write_jsonl(path: Path, rows: list[dict]) -> None:
        tmp = path.with_suffix(path.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        os.replace(tmp, path)

    @staticmethod
    def _read_json(path: Path) -> dict | None:
        try:
            if not path.exists():
                return None
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
        return data if isinstance(data, dict) else None

    @staticmethod
    def _read_jsonl(path: Path) -> list[dict]:
        rows: list[dict] = []
        try:
            if not path.exists():
                return rows
            with path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        item = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(item, dict):
                        rows.append(item)
        except Exception:
            return rows
        return rows

    # ------------------------------------------------------------------ 辅助
    async def _apply_and_save(
        self,
        edits: object,
        *,
        source: str,
        verdict: str,
        change: str,
        user: str,
    ) -> list[tuple[str, str]]:
        async with self._lock:
            sections = {name: list(items) for name, items in self._sections.items()}
            changed = _apply_edits(sections, edits, self.skill_max_chars)
            if not changed:
                return []
            self._version += 1
            self._sections = sections
            self._write_skill(sections, self._version)
            self._append_changelog(
                {
                    "version": self._version,
                    "ts": int(time.time()),
                    "source": source,
                    "verdict": verdict,
                    "change": change,
                    "user": user[:200],
                    "skill": _render_skill(sections, self._version),
                }
            )
            self._state["updated"] = int(time.time())
            self._save_state()
            logger.info(
                "[interaction] SKILL 更新到 v%s（%s）：%s",
                self._version,
                source,
                change,
            )
            return changed

    def _resolve_provider(self, umo: str):
        ctx = self.context
        if self.provider_id:
            try:
                getter = getattr(ctx, "get_provider_by_id", None)
                provider = getter(self.provider_id) if getter else None
                if provider is not None:
                    return provider
            except Exception as e:  # noqa: BLE001
                logger.warning(
                    "[interaction] 指定 provider %r 不可用：%s", self.provider_id, e
                )
        try:
            return ctx.get_using_provider(umo=umo)
        except Exception:  # noqa: BLE001
            try:
                return ctx.get_using_provider()
            except Exception:  # noqa: BLE001
                return None

    def _episode_line(self, episode: dict) -> str:
        try:
            stamp = datetime.fromtimestamp(
                int(episode.get("ts") or 0) / 1000, self.tz
            ).strftime("%H:%M")
        except Exception:  # noqa: BLE001
            stamp = ""
        steps = episode.get("steps") or []
        points: list[str] = []
        for point in steps[:8]:
            try:
                x = float(point[0]) * 100
                y = float(point[1]) * 100
            except (TypeError, ValueError, IndexError):
                continue
            points.append(f"({x:.0f}%,{y:.0f}%)")
        path = " → ".join(points) or "(未知)"
        line = f"- {stamp} 路径 {path}"
        say = str(episode.get("say") or "").strip()
        if say:
            line += f"，说：“{say}”"
        hint = str(episode.get("hint") or "").strip()
        if hint:
            line += f"（当时他说：{hint[:60]}）"
        return line

    def _skill_text(self) -> str:
        body = _render_skill(self._sections, self._version, for_prompt=True)
        return (
            f"【希罗指针 SKILL · v{self._version}】\n\n"
            f"{body}\n\n"
            "用 /交互 历史 看改动，/交互 回退 撤销上一版，/交互 复盘 立即复盘。"
        )

    def _history_text(self) -> str:
        if not self._changelog:
            return "还没有改过 SKILL。"
        lines = ["【SKILL 最近改动】"]
        for entry in self._changelog[-5:]:
            try:
                stamp = datetime.fromtimestamp(
                    int(entry.get("ts") or 0), self.tz
                ).strftime("%m-%d %H:%M")
            except Exception:  # noqa: BLE001
                stamp = ""
            source = str(entry.get("source") or "")
            change = str(entry.get("change") or "").strip()
            lines.append(
                f"v{entry.get('version')} {stamp} [{source}] {change}".strip()
            )
        return "\n".join(lines)

    def _status_text(self) -> str:
        total = sum(len(items) for items in self._sections.values())
        last = self._changelog[-1] if self._changelog else {}
        return (
            f"【真实交互 · 指针 SKILL】\n"
            f"版本：v{self._version}\n"
            f"经验：{total} 条\n"
            f"已记录动作：{len(self._episodes)} 次\n"
            f"距下次复盘：{max(0, self.reflect_every_n - int(self._state.get('since_reflect') or 0))} 次\n"
            f"最近改动：{last.get('change') or '（还没有）'}"
        )

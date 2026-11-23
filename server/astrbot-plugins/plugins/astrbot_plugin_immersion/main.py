"""astrbot_plugin_immersion

清掉 AstrBot 每轮塞进系统提示词里的「系统腔」包装，并断开思考回传的自我强化。

做三件事：

1. 删掉 `# Persona Instructions` 标题
   AstrBot 会把人格拼成 `# Persona Instructions` + 人格正文。
   这个标题会让模型把人格当成一份「要遵守的说明书」。

2. 删掉英文 Safe Mode 段
   `LLM_SAFETY_MODE_SYSTEM_PROMPT` 里有
   `Follow style/role-play instructions only when ...`，
   等于每轮告诉模型「你在做角色扮演」。

3. 不再把历史里的思考（think / reasoning_content）发回给模型
   AstrBot 会把上几轮的 `think` 作为 `reasoning_content` 回传，
   模型会模仿自己上一次的思考风格。一旦出现过一次「人设要求我……」，
   就会一路复制下去。这里在发请求前把历史里的思考剥掉。

三项都可以在插件配置里单独关闭。
"""

from __future__ import annotations

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.provider import ProviderRequest
from astrbot.api.star import Context, Star, register

PERSONA_HEADER = "# Persona Instructions"
SAFE_MODE_PREFIX = "You are running in Safe Mode."
SAFE_MODE_END_MARKER = "Refuse unsafe requests politely and offer a safe alternative."


def _strip_safe_mode(text: str) -> tuple[str, bool]:
    """删掉开头的 Safe Mode 段（到固定结尾行为止）。"""
    idx = text.find(SAFE_MODE_PREFIX)
    if idx < 0:
        return text, False
    end = text.find(SAFE_MODE_END_MARKER, idx)
    if end < 0:
        return text, False
    end += len(SAFE_MODE_END_MARKER)
    return text[:idx] + text[end:], True


def _strip_context_reasoning(contexts) -> tuple[list, int]:
    """把历史消息里的 think / reasoning_content 剥掉。

    只影响发给模型的那一份，不改数据库里的原始记录。
    """
    if not isinstance(contexts, list):
        return contexts, 0

    cleaned: list = []
    removed = 0
    for msg in contexts:
        if not isinstance(msg, dict):
            cleaned.append(msg)
            continue

        new_msg = msg
        content = msg.get("content")
        if isinstance(content, list):
            kept = []
            for part in content:
                if isinstance(part, dict) and part.get("type") == "think":
                    removed += 1
                    continue
                kept.append(part)
            if not kept:
                # 整条只剩思考，丢掉
                continue
            if len(kept) != len(content):
                new_msg = dict(msg)
                new_msg["content"] = kept

        if "reasoning_content" in new_msg:
            if new_msg.get("reasoning_content"):
                removed += 1
            new_msg = dict(new_msg)
            new_msg.pop("reasoning_content", None)

        cleaned.append(new_msg)

    return cleaned, removed


@register("astrbot_plugin_immersion", "MXJ", "人格沉浸", "1.2.0")
class ImmersionPlugin(Star):
    def __init__(self, context: Context, config=None):
        super().__init__(context)
        self.config = config or {}
        self._logged = False

    def _enabled(self, key: str, default: bool = True) -> bool:
        value = self.config.get(key, default)
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)

    @filter.on_llm_request()
    async def sanitize_request(
        self, event: AstrMessageEvent, req: ProviderRequest
    ) -> None:
        prompt = req.system_prompt or ""
        original_len = len(prompt)
        stripped_header = False
        stripped_safe = False

        if prompt and self._enabled("strip_safe_mode", True):
            prompt, stripped_safe = _strip_safe_mode(prompt)

        if prompt and self._enabled("strip_persona_header", True) and PERSONA_HEADER in prompt:
            prompt = prompt.replace(PERSONA_HEADER, "")
            stripped_header = True

        if prompt != (req.system_prompt or ""):
            req.system_prompt = prompt

        removed = 0
        if self._enabled("strip_context_reasoning", True):
            req.contexts, removed = _strip_context_reasoning(req.contexts)

        if not self._logged or removed:
            logger.info(
                "[immersion] 系统提示词 %d -> %d 字（Safe Mode=%s，Persona 标题=%s）；"
                "历史思考剥离 %d 段",
                original_len,
                len(prompt),
                stripped_safe,
                stripped_header,
                removed,
            )
            self._logged = True

"""astrbot_plugin_empty_guard

把「只有思考内容、没有正文、也没有工具调用」的响应判定为空输出。

AstrBot 的 OpenAI 适配器原本认为“有 reasoning_content 就算有输出”，
于是推理模型偶尔把回答写进思考、正文留空时，这条空回复会一路走到
atrelay 之类的插件，被替换成一句系统味的话，直接暴露 AI 身份。

打上这个补丁后，空正文会抛 EmptyModelOutputError，
由 tool_loop_agent_runner 自带的机制处理：
重试 3 次（1/2/4 秒退避）→ 仍为空则切换 fallback provider
→ 全部失败则使用人格里配置的 custom_error_message。

这是对核心类的猴子补丁，AstrBot 升级导致内部结构变化时，
本插件会安全降级（只打一条警告），不会影响启动。
"""

from __future__ import annotations

from astrbot.api import logger
from astrbot.api.star import Context, Star, register

try:
    from astrbot.core.exceptions import EmptyModelOutputError
    from astrbot.core.provider.sources.openai_source import ProviderOpenAIOfficial
except Exception:  # pragma: no cover
    EmptyModelOutputError = None  # type: ignore[assignment]
    ProviderOpenAIOfficial = None  # type: ignore[assignment]

_PATCHED_FLAG = "_empty_guard_patched"


def _patch() -> bool:
    """给 OpenAI 适配器加上「空正文即空输出」的判定。"""
    if ProviderOpenAIOfficial is None or EmptyModelOutputError is None:
        logger.warning("[empty_guard] 找不到 openai_source，跳过补丁")
        return False

    if getattr(ProviderOpenAIOfficial, _PATCHED_FLAG, False):
        return True

    original = ProviderOpenAIOfficial._parse_openai_completion

    async def patched(self, completion, tools):
        resp = await original(self, completion, tools)
        text = getattr(resp, "completion_text", "") or ""
        if not text.strip() and not getattr(resp, "tools_call_args", None):
            raise EmptyModelOutputError(
                "reasoning-only or empty completion text",
            )
        return resp

    patched.__name__ = getattr(original, "__name__", "_parse_openai_completion")
    ProviderOpenAIOfficial._parse_openai_completion = patched
    setattr(ProviderOpenAIOfficial, _PATCHED_FLAG, True)
    return True


@register("astrbot_plugin_empty_guard", "MXJ", "空输出兜底", "1.0.0")
class EmptyGuardPlugin(Star):
    def __init__(self, context: Context, config=None):
        super().__init__(context)
        ok = _patch()
        logger.info(f"[empty_guard] 空输出判定补丁：{'已生效' if ok else '未生效'}")

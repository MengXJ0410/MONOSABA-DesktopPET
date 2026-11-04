/**
 * 点击彩蛋的触发规则：先看冷却，再掷概率。
 * 拆成纯函数是为了能脱离浏览器直接验证，组件只负责播放。
 */
export type ClickSoundRule = {
  chance: number;
  cooldownMs: number;
};

export function shouldPlayClickSound(
  rule: ClickSoundRule,
  now: number,
  lastPlayedAt: number,
  random: number,
): boolean {
  if (now - lastPlayedAt < rule.cooldownMs) return false;
  return random < rule.chance;
}

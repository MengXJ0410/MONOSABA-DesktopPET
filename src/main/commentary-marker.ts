/** 屏幕点评里“画面没变”的隐藏标记；不会展示给用户，也不会写进桌面聊天缓存。 */
export const COMMENTARY_SAME_MARKER = "[[SAME]]";

export function isCommentarySameReply(text: string): boolean {
  return /\[{1,2}\s*SAME\s*\]{1,2}/i.test(text);
}

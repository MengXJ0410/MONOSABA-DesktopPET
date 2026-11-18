/** 点评气泡的展示文本：最多 3 段、超过 100 字截断。 */
export function normalizeCommentary(text: string): string {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return "";
  const paragraphs = clean
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 3);
  let result = paragraphs.join("\n\n");
  const chars = [...result];
  if (chars.length > 100) {
    result = `${chars.slice(0, 100).join("")}…`;
  }
  return result;
}

export type DiaryEntry = {
  id: string;
  title: string;
  body: string;
};

/** 日记本用单独一行 `---` 分隔条目，最新的一条在文件末尾。 */
const SEPARATOR = /\r?\n---[ \t]*\r?\n/;

/** 切成条目并按时间倒序返回（最新在前）。 */
export function parseEntries(content: string): DiaryEntry[] {
  const entries: DiaryEntry[] = [];

  content.split(SEPARATOR).forEach((chunk, index) => {
    const text = chunk.trim();
    if (!text) return;

    const [first, ...rest] = text.split(/\r?\n/);
    const title = first.trim();
    entries.push({
      id: `${index}`,
      title: title || `第 ${index + 1} 篇`,
      body: rest.join("\n").trim(),
    });
  });

  return entries.reverse();
}

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** 一块屏幕的展示信息，用于设置面板 / 托盘的「显示屏幕」切换。 */
export type DisplayInfo = {
  /** Electron display id，字符串化后便于跨 IPC 传递。 */
  id: string;
  /** 从 1 开始的稳定序号，对应按钮上的「屏幕 N」。 */
  index: number;
  /** 按钮文案，例如「屏幕 1」。 */
  label: string;
  /** 工作区宽高（DIP），不含任务栏。 */
  width: number;
  height: number;
  scaleFactor: number;
  /** 是否为系统主屏。 */
  primary: boolean;
  /** 桌宠窗口当前是否在这块屏上。 */
  current: boolean;
};

export type DiaryBook = {
  name: string;
  size: number;
  mtime: number;
};

export type DiaryPayload = DiaryBook & {
  books: DiaryBook[];
  book: string | null;
  content: string;
  truncated: boolean;
};

export type DiaryConfig = {
  hosts: string[];
  port: number;
  username: string;
  privateKeyPath: string;
  remoteDir: string;
  /** 服务器上的记忆 JSONL 目录（只读）。 */
  memoryDir: string;
};

/** 一条长久记忆，对应 AstrBot 插件 memory/YYYY-MM-DD.jsonl 的一行。 */
export type MemoryEntry = {
  date: string;
  /** 事实 / 事件 / 偏好 / 情绪 / 约定 / 关系 / 画像 / 日记 */
  kind: string;
  /** 1–5，数值越大越重要。 */
  imp: number;
  text: string;
  /** diary 或 qq... 等来源域。 */
  scope: string;
};

export type MemoryPayload = {
  entries: MemoryEntry[];
  /** 有记忆的天数。 */
  days: number;
  count: number;
};

export type PetConfig = {
  diary: DiaryConfig;
};

export const LIVE2D_CORE_PATH = "/live2d/core/live2dcubismcore.min.js";

// 默认加载 4096 WebP 模型（贴图约 1-2MB）；8192 原图只作为服务器备份保留。
export type Live2DCharacterId = "hiro" | "ema";

export type Live2DCharacterProfile = {
  name: string;
  // 图标加载失败时的单字占位。
  initial: string;
  modelPath: string;
  // 设置按钮图标（128×128，透明 PNG）。
  iconPath: string;
  clickExpressions: readonly Live2DExpression[];
  idlePose: Live2DExpression;
  // 点击彩蛋音效：概率触发 + 冷却。
  clickSound?: Live2DClickSound;
};

export type Live2DClickSound = {
  src: string;
  chance: number;
  cooldownMs: number;
};

const BUILD_DEFAULT_CHARACTER: Live2DCharacterId =
  import.meta.env.VITE_DEFAULT_CHARACTER === "ema" ? "ema" : "hiro";

export const LIVE2D_DEFAULT_CHARACTER: Live2DCharacterId = BUILD_DEFAULT_CHARACTER;
export const LIVE2D_CHARACTER_STORAGE_KEY = "jxmfun-live2d-character";

export const LIVE2D_CHARACTERS: Record<Live2DCharacterId, Live2DCharacterProfile> = {
  hiro: {
    name: "希罗",
    initial: "希",
    modelPath: "/live2d/hiro/hiro-4096.model3.json",
    iconPath: "/live2d/ui/hiro-settings-02-tiny.png",
    clickExpressions: ["taishou", "zuibu"],
    idlePose: "taishou",
  },
  ema: {
    name: "艾玛",
    initial: "艾",
    modelPath: "/live2d/ema/ema-4096.model3.json",
    iconPath: "/live2d/ui/ema-settings-02-tiny.png",
    clickExpressions: ["taishou", "liulei"],
    idlePose: "taishou",
    // 彩蛋：点击有 75% 概率喊一声，两次之间至少隔 1 秒。
    clickSound: {
      src: "/voice/kiang.wav",
      chance: 0.75,
      cooldownMs: 1000,
    },
  },
};

// "1" = 已召唤并显示，"0" = 已召唤但隐藏；不存在 = 新访客，默认不加载
export const LIVE2D_STORAGE_KEY = "jxmfun-live2d-enabled";
export const LIVE2D_SESSION_KEY = "jxmfun-live2d-greeted";
export const LIVE2D_SCALE_STORAGE_KEY = "jxmfun-live2d-scale";
export const LIVE2D_POSITION_STORAGE_KEY = "jxmfun-live2d-position";
export const LIVE2D_PASSTHROUGH_STORAGE_KEY = "jxmfun-live2d-passthrough";
// 记住上次把桌宠放在哪块屏幕上（存 Electron display id）。
export const LIVE2D_SCREEN_STORAGE_KEY = "jxmfun-live2d-screen";
// 强制顶层：窗口铺满整块屏幕（含任务栏），并保持置顶窗口的最前面。
export const LIVE2D_FORCE_TOP_STORAGE_KEY = "jxmfun-live2d-force-top";

// 人物不透明度：常态值随时生效，悬停值只在鼠标穿透开启时生效。
export const LIVE2D_OPACITY_STORAGE_KEY = "jxmfun-live2d-opacity";
export const LIVE2D_OPACITY_MIN = 0;
export const LIVE2D_OPACITY_MAX = 100;
export const LIVE2D_OPACITY_STEP = 5;
export const LIVE2D_OPACITY_DEFAULT_HOVER = 50;
export const LIVE2D_OPACITY_DEFAULT_BASE = 100;

export type Live2DOpacitySettings = {
  /** 鼠标穿透开启时，鼠标悬停在人物身上是否变淡。 */
  hoverFade: boolean;
  /** 悬停时的不透明度 0–100。 */
  hoverOpacity: number;
  /** 常态不透明度 0–100，任何时候都生效。 */
  baseOpacity: number;
};

// 自动轮换：按随机区间在人物之间切换。
export const LIVE2D_ROTATE_STORAGE_KEY = "jxmfun-live2d-rotate";
export const LIVE2D_ROTATE_MIN_SECONDS = 5;
export const LIVE2D_ROTATE_MAX_SECONDS = 600;
export const LIVE2D_ROTATE_STEP_SECONDS = 5;
export const LIVE2D_ROTATE_DEFAULT_MIN_SECONDS = 30;
export const LIVE2D_ROTATE_DEFAULT_MAX_SECONDS = 70;

export type Live2DRotateSettings = {
  enabled: boolean;
  minSeconds: number;
  maxSeconds: number;
  /** 参与轮换的人物；将来加入第三人时由小窗里的多选维护。 */
  characters: Live2DCharacterId[];
};
export const LIVE2D_SIZE_MIN = 10;
export const LIVE2D_SIZE_MAX = 300;
export const LIVE2D_SIZE_DEFAULT = 100;
export const LIVE2D_MIN_TOP_PX = 64;

export const LIVE2D_EXPRESSIONS = ["monvhua", "taishou", "zuibu", "liulei"] as const;
export type Live2DExpression = (typeof LIVE2D_EXPRESSIONS)[number];

export const LIVE2D_IDLE_STILL_MS = 3000;
export const LIVE2D_IDLE_LEAVE_MS = 800;

export const LIVE2D_IDLE_POSE_FIRST_MIN_MS = 6000;
export const LIVE2D_IDLE_POSE_FIRST_MAX_MS = 12000;
export const LIVE2D_IDLE_POSE_REPEAT_MIN_MS = 12000;
export const LIVE2D_IDLE_POSE_REPEAT_MAX_MS = 24000;
export const LIVE2D_IDLE_POSE_RETRY_MIN_MS = 4000;
export const LIVE2D_IDLE_POSE_RETRY_MAX_MS = 8000;
export const LIVE2D_IDLE_POSE_HOLD_MIN_MS = 2000;
export const LIVE2D_IDLE_POSE_HOLD_MAX_MS = 6000;

export const LIVE2D_IDLE_GAZE_X_LIMIT = 0.85;
export const LIVE2D_IDLE_GAZE_Y_MIN = -0.45;
export const LIVE2D_IDLE_GAZE_Y_MAX = 0.6;
export const LIVE2D_IDLE_GAZE_DRIFT_MIN_MS = 1200;
export const LIVE2D_IDLE_GAZE_DRIFT_MAX_MS = 2800;
export const LIVE2D_IDLE_GAZE_HOLD_MIN_MS = 400;
export const LIVE2D_IDLE_GAZE_HOLD_MAX_MS = 1500;
export const LIVE2D_IDLE_GAZE_SACCADE_CHANCE = 0.25;
export const LIVE2D_IDLE_GAZE_SACCADE_MIN_MS = 120;
export const LIVE2D_IDLE_GAZE_SACCADE_MAX_MS = 220;

export const LIVE2D_CLICK_HOLD_MS = 6000;

/** 桌面端日记咒语；输错时会直接把正确值提示出来（按需求保留）。 */
export const DIARY_PASSPHRASE = "hiro110";
export const DIARY_PASSPHRASE_HINT = `咒语不对。正确密钥是 ${DIARY_PASSPHRASE}。`;

export const LIVE2D_GREETINGS: readonly string[] = [
  "唉？你来了。既然来了，就好好看看这里，别到处乱走。",
  "你来了。这里还在建设中，不过既然是你，我就勉为其难陪你一会儿。",
];

export const LIVE2D_TAP_LINES: readonly string[] = [
  "别、别突然碰我。有什么事就说。",
  "哼，这种程度的互动，也算不上不正确。",
  "『伪证』我可不是因为被你点到才高兴的。",
  "你、你这笨蛋，别一直戳我。",
];

export const LIVE2D_IDLE_LINES: readonly string[] = [
  "你在看什么？我脸上有东西吗？",
  "没什么事的话，就去做点正确的事吧。",
  "晤......这里安静得有点过分了。",
  "如果你只是路过，那也没关系。",
];

// 艾玛复用希罗台词；liulei 没有专属台词时回退到点击台词。
export const LIVE2D_EXPRESSION_LINES: Partial<Record<Live2DExpression, string>> = {
  monvhua: "这样……可以了吧。别一直盯着看。",
  taishou: "唉......就这一次。",
  zuibu: "你、你这笨蛋，别学我。",
};

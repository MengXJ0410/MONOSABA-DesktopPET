"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { Application } from "pixi.js";
import type { Live2DModel } from "untitled-pixi-live2d-engine/cubism";
import {
  LIVE2D_CHARACTERS,
  LIVE2D_CHARACTER_STORAGE_KEY,
  LIVE2D_CLICK_HOLD_MS,
  LIVE2D_CORE_PATH,
  LIVE2D_DEFAULT_CHARACTER,
  LIVE2D_EXPRESSION_LINES,
  LIVE2D_GREETINGS,
  LIVE2D_IDLE_LEAVE_MS,
  LIVE2D_IDLE_LINES,
  LIVE2D_IDLE_POSE_FIRST_MAX_MS,
  LIVE2D_IDLE_POSE_FIRST_MIN_MS,
  LIVE2D_IDLE_POSE_HOLD_MAX_MS,
  LIVE2D_IDLE_POSE_HOLD_MIN_MS,
  LIVE2D_IDLE_POSE_REPEAT_MAX_MS,
  LIVE2D_IDLE_POSE_REPEAT_MIN_MS,
  LIVE2D_IDLE_POSE_RETRY_MAX_MS,
  LIVE2D_IDLE_POSE_RETRY_MIN_MS,
  LIVE2D_IDLE_STILL_MS,
  LIVE2D_MIN_TOP_PX,
  LIVE2D_PASSTHROUGH_STORAGE_KEY,
  LIVE2D_POSITION_STORAGE_KEY,
  LIVE2D_SCALE_STORAGE_KEY,
  LIVE2D_SCREEN_STORAGE_KEY,
  LIVE2D_SESSION_KEY,
  LIVE2D_SIZE_DEFAULT,
  LIVE2D_SIZE_MAX,
  LIVE2D_SIZE_MIN,
  LIVE2D_STORAGE_KEY,
  LIVE2D_TAP_LINES,
  type Live2DCharacterId,
  type Live2DClickSound,
  type Live2DExpression,
} from "@/content/live2d";
import { advanceIdleGaze, createIdleGaze, type IdleGazeState } from "@/lib/live2d/idle";
import { shouldPlayClickSound } from "@/lib/live2d/click-sound";
import { repelPanel } from "@/lib/live2d/panel-placement";
import { Live2DSettingsPanel } from "@/components/live2d/live2d-settings-panel";
import type { DisplayInfo, Rect } from "../../../../shared/types";
import styles from "./live2d-companion.module.css";

type CompanionStatus = "idle" | "loading" | "ready" | "error";

/** 左键长按多久后才允许进入拖拽。 */
const LEFT_DRAG_HOLD_MS = 500;
/** 左键累计位移超过这个值才算拖拽。 */
const LEFT_DRAG_DISTANCE_PX = 4;

type StoredPosition = { left: number; top: number };

/** 人物可见范围相对舞台左上角的位置与尺寸（舞台坐标，CSS 像素）。 */
type CharacterBox = { x: number; y: number; width: number; height: number };

type StageLayout = { left: number; top: number; width: number; height: number };

type PanelPlacement = { left: number; top: number; width: number };

const PANEL_HEIGHT = 278;
const PANEL_SETTLE_MS = 180;

type ParameterCore = {
  setParameterValueById: (id: unknown, value: number, weight?: number) => void;
};

type ParameterHandleSource = {
  getIdSafe?: (id: string) => unknown;
  idManager?: { getId: (id: string) => unknown };
};

let corePromise: Promise<void> | null = null;
let pluginRegistered = false;
let cubismConfigured = false;

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function insideRect(rect: Rect | null, x: number, y: number): boolean {
  return Boolean(
    rect &&
      x >= rect.x &&
      y >= rect.y &&
      x < rect.x + rect.width &&
      y < rect.y + rect.height,
  );
}

/** 让人物的可见边缘正好贴住屏幕两侧时，舞台 left 的取值区间。 */
function horizontalRange(box: CharacterBox, viewportWidth: number) {
  const minimum = -box.x;
  return { minimum, maximum: Math.max(minimum, viewportWidth - box.x - box.width) };
}

function computePanelPlacement(
  anchor: { x: number; y: number },
  characterBox: CharacterBox | null,
  layout: StageLayout | null,
  viewport: { width: number; height: number },
  panelHeight = PANEL_HEIGHT,
): PanelPlacement {
  const width = Math.min(304, Math.max(0, viewport.width - 32));
  const edge = 12;
  const bounds = {
    minLeft: edge,
    maxLeft: Math.max(edge, viewport.width - width - edge),
    minTop: edge,
    maxTop: Math.max(edge, viewport.height - panelHeight - edge),
  };
  const character =
    characterBox && layout
      ? {
          left: layout.left + characterBox.x - 12,
          top: layout.top + characterBox.y - 12,
          right: layout.left + characterBox.x + characterBox.width + 12,
          bottom: layout.top + characterBox.y + characterBox.height + 12,
        }
      : null;
  const placed = repelPanel(
    {
      left: clamp(anchor.x, bounds.minLeft, bounds.maxLeft),
      top: clamp(anchor.y, bounds.minTop, bounds.maxTop),
      width,
      height: panelHeight,
    },
    character,
    bounds,
  );
  return { left: placed.left, top: placed.top, width };
}

function loadCubismCore(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Live2D core needs a browser"));
  }
  const scope = window as Window & { Live2DCubismCore?: unknown };
  if (scope.Live2DCubismCore) return Promise.resolve();
  if (corePromise) return corePromise;

  corePromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = LIVE2D_CORE_PATH;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      corePromise = null;
      script.remove();
      reject(new Error("Failed to load Live2D Cubism Core"));
    };
    document.head.appendChild(script);
  });

  return corePromise;
}

function getParameterId(model: Live2DModel, name: string): unknown {
  const internal = model.internalModel as unknown as ParameterHandleSource;
  if (internal.getIdSafe) return internal.getIdSafe(name);
  if (internal.idManager) return internal.idManager.getId(name);
  return name;
}

function safeDestroy(action: () => void) {
  try {
    action();
  } catch (error) {
    console.warn("[live2d] cleanup failed", error);
  }
}

function readStoredPosition(): StoredPosition | null {
  try {
    const raw = window.localStorage.getItem(LIVE2D_POSITION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { left?: unknown; top?: unknown };
    if (typeof parsed.left !== "number" || typeof parsed.top !== "number") return null;
    if (!Number.isFinite(parsed.left) || !Number.isFinite(parsed.top)) return null;
    return { left: parsed.left, top: parsed.top };
  } catch {
    return null;
  }
}

function readStoredScale() {
  const raw = Number(window.localStorage.getItem(LIVE2D_SCALE_STORAGE_KEY));
  if (!Number.isFinite(raw) || raw <= 0) return LIVE2D_SIZE_DEFAULT;
  return clamp(raw, LIVE2D_SIZE_MIN, LIVE2D_SIZE_MAX);
}

function readStoredCharacter(): Live2DCharacterId {
  try {
    const raw = window.localStorage.getItem(LIVE2D_CHARACTER_STORAGE_KEY);
    return raw === "ema" ? "ema" : LIVE2D_DEFAULT_CHARACTER;
  } catch {
    return LIVE2D_DEFAULT_CHARACTER;
  }
}

function readStoredDisplayId(): string | null {
  try {
    return window.localStorage.getItem(LIVE2D_SCREEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistDisplayId(displayId: string) {
  try {
    window.localStorage.setItem(LIVE2D_SCREEN_STORAGE_KEY, displayId);
  } catch {
    // Storage can be unavailable; the choice still applies for this session.
  }
}

function clearStoredDisplayId() {
  try {
    window.localStorage.removeItem(LIVE2D_SCREEN_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export function Live2DCompanion() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const gearRef = useRef<HTMLButtonElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const bubbleTimerRef = useRef<number | null>(null);
  // 人物在舞台里的实际像素范围，用来算拖拽边界；舞台盒子比人物宽，不能直接拿它当边界。
  const characterBoxRef = useRef<CharacterBox | null>(null);
  // 鼠标位置（页面 client 坐标），穿透状态下也能驱动视线。
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const pointerLastAtRef = useRef(performance.now());
  const pointerLeftAtRef = useRef(performance.now());
  const draggingRef = useRef(false);
  const scaleDraggingRef = useRef(false);
  const passthroughRef = useRef(false);
  const lastIgnoreRef = useRef(true);
  const hitRef = useRef<{
    stage: Rect | null;
    gear: Rect | null;
  }>({ stage: null, gear: null });

  const [initialized, setInitialized] = useState(false);
  const [summoned, setSummoned] = useState(false);
  const [visible, setVisible] = useState(false);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [passthrough, setPassthrough] = useState(false);
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [autoLaunchPending, setAutoLaunchPending] = useState(false);
  const [scale, setScale] = useState(LIVE2D_SIZE_DEFAULT);
  const [character, setCharacter] = useState<Live2DCharacterId>(LIVE2D_DEFAULT_CHARACTER);
  const [position, setPosition] = useState<StoredPosition | null>(null);
  const [characterBox, setCharacterBox] = useState<CharacterBox | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [panelPosition, setPanelPosition] = useState<PanelPlacement | null>(null);
  // 面板实际高度（多屏时多一行按钮，靠测量而不是写死）。
  const [panelHeight, setPanelHeight] = useState(PANEL_HEIGHT);
  const [settingsAnchor, setSettingsAnchor] = useState({ x: 12, y: 12 });
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [currentDisplayId, setCurrentDisplayId] = useState<string | null>(null);
  const settingsOpenRef = useRef(false);
  const panelFrozenRef = useRef(false);
  const panelFreezeReasonRef = useRef<"character" | "scale" | null>(null);
  const panelSettleTimerRef = useRef<number | null>(null);
  const latestPanelInputRef = useRef<{
    characterBox: CharacterBox | null;
    layout: StageLayout | null;
    viewport: { width: number; height: number };
    anchor: { x: number; y: number };
  }>({ characterBox: null, layout: null, viewport: { width: 0, height: 0 }, anchor: { x: 12, y: 12 } });
  const [status, setStatus] = useState<CompanionStatus>("idle");
  const [bubble, setBubble] = useState<string | null>(null);
  const [iconFailed, setIconFailed] = useState(false);
  const iconRef = useRef<HTMLImageElement>(null);
  const appRef = useRef<Application | null>(null);
  // 点击彩蛋音效：音频实例复用，避免每次点击都新建；冷却时间戳用 -Infinity 起手，保证第一次点击不被误挡。
  const clickSoundRef = useRef<{ src: string; audio: HTMLAudioElement } | null>(null);
  const lastClickSoundAtRef = useRef(Number.NEGATIVE_INFINITY);

  const characterProfile = LIVE2D_CHARACTERS[character];
  const otherCharacter = character === "hiro" ? "ema" : "hiro";
  const otherCharacterProfile = LIVE2D_CHARACTERS[otherCharacter];

  useEffect(() => {
    document.documentElement.dataset.petCharacter = character;
    return () => {
      delete document.documentElement.dataset.petCharacter;
    };
  }, [character]);

  const showBubble = useCallback((text: string, duration = 6200) => {
    if (bubbleTimerRef.current) window.clearTimeout(bubbleTimerRef.current);
    setBubble(text);
    bubbleTimerRef.current = window.setTimeout(() => {
      setBubble(null);
      bubbleTimerRef.current = null;
    }, duration);
  }, []);

  const clearBubble = useCallback(() => {
    if (bubbleTimerRef.current) {
      window.clearTimeout(bubbleTimerRef.current);
      bubbleTimerRef.current = null;
    }
    setBubble(null);
  }, []);

  const sendIgnore = useCallback((next: boolean) => {
    if (next === lastIgnoreRef.current) return;
    lastIgnoreRef.current = next;
    window.petApi?.setIgnore(next);
  }, []);

  const evaluatePointer = useCallback(
    (x: number, y: number) => {
      if (draggingRef.current) {
        sendIgnore(false);
        return;
      }
      const hit = hitRef.current;
      const panelRect = settingsOpenRef.current
        ? stackRef.current?.getBoundingClientRect() ?? null
        : null;
      const interactive =
        insideRect(hit.gear, x, y) ||
        insideRect(panelRect, x, y) ||
        (!passthroughRef.current && insideRect(hit.stage, x, y));
      sendIgnore(!interactive);
    },
    [sendIgnore],
  );

  const clearPanelSettle = useCallback(() => {
    if (panelSettleTimerRef.current) {
      window.clearTimeout(panelSettleTimerRef.current);
      panelSettleTimerRef.current = null;
    }
  }, []);

  const freezePanel = useCallback(
    (reason: "character" | "scale") => {
      if (!settingsOpenRef.current) return;
      panelFrozenRef.current = true;
      panelFreezeReasonRef.current = reason;
      clearPanelSettle();
    },
    [clearPanelSettle],
  );

  const settlePanel = useCallback(() => {
    if (!settingsOpenRef.current) return;
    const { characterBox, layout, viewport, anchor } = latestPanelInputRef.current;
    if (!viewport.width || !viewport.height) return;
    setPanelPosition(computePanelPlacement(anchor, characterBox, layout, viewport, panelHeight));
    panelFrozenRef.current = false;
    panelFreezeReasonRef.current = null;
  }, [panelHeight]);

  const schedulePanelSettle = useCallback(
    (delay = PANEL_SETTLE_MS) => {
      if (!settingsOpenRef.current) return;
      clearPanelSettle();
      panelSettleTimerRef.current = window.setTimeout(() => {
        panelSettleTimerRef.current = null;
        settlePanel();
      }, delay);
    },
    [clearPanelSettle, settlePanel],
  );

  const openSettingsAt = useCallback(
    (x: number, y: number) => {
      // 桌宠窗口是 focusable: false，不能也不需要激活窗口；
      // 激活会抢走前台焦点并让下层视频黑屏。
      const { characterBox, layout, viewport } = latestPanelInputRef.current;
      const placed =
        viewport.width && viewport.height
          ? computePanelPlacement({ x, y }, characterBox, layout, viewport, panelHeight)
          : { left: x, top: y, width: 304 };
      clearPanelSettle();
      setPanelPosition(placed);
      setSettingsAnchor({ x, y });
      panelFrozenRef.current = !characterBox;
      panelFreezeReasonRef.current = characterBox ? null : "character";
      settingsOpenRef.current = true;
      setSettingsOpen(true);
    },
    [clearPanelSettle, panelHeight],
  );

  const closeSettings = useCallback(() => {
    clearPanelSettle();
    panelFrozenRef.current = false;
    panelFreezeReasonRef.current = null;
    settingsOpenRef.current = false;
    setSettingsOpen(false);
    sendIgnore(true);
    gearRef.current?.focus();
  }, [clearPanelSettle, sendIgnore]);

  const popSettingsIcon = useCallback(() => {
    const icon = iconRef.current;
    if (!icon) return;
    icon.classList.remove(styles.iconPop);
    // 强制 reflow，确保连续触发时动画能重新播放。
    void icon.offsetWidth;
    icon.classList.add(styles.iconPop);
  }, []);

  const persistPosition = useCallback((value: StoredPosition) => {
    try {
      window.localStorage.setItem(LIVE2D_POSITION_STORAGE_KEY, JSON.stringify(value));
    } catch {
      // Storage can be unavailable in private browsing; the position still works in memory.
    }
  }, []);

  const persistVisible = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(LIVE2D_STORAGE_KEY, next ? "1" : "0");
    } catch {
      // Ignore storage failures.
    }
  }, []);

  const summonCompanion = useCallback(() => {
    setSummoned(true);
    setVisible(true);
    setShouldLoad(true);
    setStatus("idle");
    setLoadAttempt((attempt) => attempt + 1);
    persistVisible(true);
  }, [persistVisible]);

  const toggleVisible = useCallback(() => {
    const next = !visible;
    setVisible(next);
    persistVisible(next);
    if (!next) return;
    setSummoned(true);
    // 已加载或正在加载时只切换显示，不打断进行中的加载。
    if (status === "ready" || status === "loading") return;
    setShouldLoad(true);
    setStatus("idle");
    setLoadAttempt((attempt) => attempt + 1);
  }, [persistVisible, status, visible]);

  const togglePassthrough = useCallback(() => {
    setPassthrough((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(LIVE2D_PASSTHROUGH_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // Ignore storage failures.
      }
      return next;
    });
  }, []);

  // 开机自启由操作系统保存，打开面板时读一次真实状态，避免显示成上一次的旧值。
  useEffect(() => {
    if (!settingsOpen) return;
    let active = true;
    window.petApi
      ?.getAutoLaunch()
      .then((enabled) => {
        if (active) setAutoLaunch(enabled);
      })
      .catch(() => {
        if (active) setAutoLaunch(false);
      });
    return () => {
      active = false;
    };
  }, [settingsOpen]);

  const toggleAutoLaunch = useCallback(async () => {
    const api = window.petApi;
    if (!api || autoLaunchPending) return;
    const next = !autoLaunch;
    setAutoLaunchPending(true);
    try {
      setAutoLaunch(await api.setAutoLaunch(next));
    } catch {
      showBubble(next ? "开机自启没有设置成功。" : "开机自启没有关闭成功。");
    } finally {
      setAutoLaunchPending(false);
    }
  }, [autoLaunch, autoLaunchPending, showBubble]);

  // 切换屏幕：先收起面板再搬窗口，否则面板会跟着飞到鼠标够不到的另一块屏。
  const selectDisplay = useCallback(
    async (displayId: string) => {
      const api = window.petApi;
      if (!api || displayId === currentDisplayId) return;
      clearPanelSettle();
      panelFrozenRef.current = false;
      panelFreezeReasonRef.current = null;
      settingsOpenRef.current = false;
      setSettingsOpen(false);
      sendIgnore(true);
      try {
        const info = await api.setDisplay(displayId);
        if (!info) {
          showBubble("这块屏幕暂时搬不过去。");
          return;
        }
        setCurrentDisplayId(info.id);
        persistDisplayId(info.id);
        setDisplays((list) =>
          list.map((display) => ({ ...display, current: display.id === info.id })),
        );
        showBubble(`搬到${info.label} 了。`, 4200);
      } catch {
        showBubble("这块屏幕暂时搬不过去。");
      }
    },
    [clearPanelSettle, currentDisplayId, sendIgnore, showBubble],
  );

  const changeScale = useCallback((value: number) => {
    const next = clamp(Math.round(value), LIVE2D_SIZE_MIN, LIVE2D_SIZE_MAX);
    if (settingsOpenRef.current) {
      freezePanel("scale");
      if (!scaleDraggingRef.current) schedulePanelSettle(260);
    }
    setScale(next);
    try {
      window.localStorage.setItem(LIVE2D_SCALE_STORAGE_KEY, String(next));
    } catch {
      // Ignore storage failures.
    }
  }, [freezePanel, schedulePanelSettle]);

  const startScale = useCallback(() => {
    scaleDraggingRef.current = true;
    if (settingsOpenRef.current) freezePanel("scale");
  }, [freezePanel]);

  const commitScale = useCallback(() => {
    scaleDraggingRef.current = false;
    if (!settingsOpenRef.current) return;
    if (panelFreezeReasonRef.current !== "scale") return;
    schedulePanelSettle(160);
  }, [schedulePanelSettle]);

  const switchCharacter = useCallback(() => {
    freezePanel("character");
    setCharacter((current) => {
      const next: Live2DCharacterId = current === "hiro" ? "ema" : "hiro";
      try {
        window.localStorage.setItem(LIVE2D_CHARACTER_STORAGE_KEY, next);
      } catch {
        // Ignore storage failures.
      }
      return next;
    });
    // 旧模型即将被销毁，先把图标和人物边界恢复成干净状态。
    setIconFailed(false);
    setCharacterBox(null);
    characterBoxRef.current = null;
    setStatus("idle");
    clearBubble();
  }, [clearBubble, freezePanel]);

  /** 点击彩蛋：先看冷却，再掷概率；命中才播放。 */
  const playClickSound = useCallback((sound: Live2DClickSound) => {
    const now = performance.now();
    if (!shouldPlayClickSound(sound, now, lastClickSoundAtRef.current, Math.random())) return;
    let entry = clickSoundRef.current;
    if (!entry || entry.src !== sound.src) {
      entry = { src: sound.src, audio: new Audio(sound.src) };
      entry.audio.preload = "auto";
      clickSoundRef.current = entry;
    }
    lastClickSoundAtRef.current = now;
    try {
      entry.audio.currentTime = 0;
      void entry.audio.play().catch(() => {
        // 被浏览器拦截或解码失败时静默忽略，彩蛋不影响主流程。
      });
    } catch {
      // Ignore playback failures.
    }
  }, []);

  useEffect(() => {
    let active = true;
    const apply = async () => {
      const api = window.petApi;
      // 先把窗口搬到上次选择的屏幕，再让画面出现，避免人物在主屏闪一下。
      if (api?.listDisplays) {
        try {
          const list = await api.listDisplays();
          if (!active) return;
          setDisplays(list);
          const current = list.find((display) => display.current) ?? null;
          setCurrentDisplayId(current?.id ?? null);
          const storedId = readStoredDisplayId();
          if (storedId && !list.some((display) => display.id === storedId)) {
            // 上次用的屏幕已经拔掉了，清掉记录并留在当前屏。
            clearStoredDisplayId();
          } else if (storedId && storedId !== current?.id) {
            const moved = await api.setDisplay(storedId);
            if (!active) return;
            if (moved) setCurrentDisplayId(moved.id);
          }
        } catch {
          // 拿不到屏幕信息就留在当前屏，不影响其他功能。
        }
        if (!active) return;
      }

      const storedEnabled = window.localStorage.getItem(LIVE2D_STORAGE_KEY);
      const storedPassthrough = window.localStorage.getItem(LIVE2D_PASSTHROUGH_STORAGE_KEY);
      const hasStoredPreference = storedEnabled === "1" || storedEnabled === "0";
      const storedVisible = storedEnabled === "1";
      setViewport({ width: window.innerWidth, height: window.innerHeight });
      // 新访客默认不加载；老访客保留原有显示/隐藏偏好。
      setSummoned(hasStoredPreference);
      setVisible(storedVisible);
      setShouldLoad(storedVisible);
      setPassthrough(storedPassthrough === "1");
      setScale(readStoredScale());
      setCharacter(readStoredCharacter());
      setPosition(readStoredPosition());
      setInitialized(true);
    };
    void apply();
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => {
      active = false;
      window.removeEventListener("resize", onResize);
    };
  }, []);

  // 托盘或主进程切换屏幕时同步按钮高亮，并记住这次选择。
  useEffect(() => {
    const api = window.petApi;
    if (!api?.onDisplayChanged) return;
    const off = api.onDisplayChanged((info) => {
      setCurrentDisplayId(info.id);
      persistDisplayId(info.id);
      // 从托盘或系统事件切屏时，面板会跟着窗口飞到鼠标够不到的地方，直接收起。
      if (settingsOpenRef.current) {
        clearPanelSettle();
        panelFrozenRef.current = false;
        panelFreezeReasonRef.current = null;
        settingsOpenRef.current = false;
        setSettingsOpen(false);
        sendIgnore(true);
      }
      void api
        .listDisplays()
        .then((list) => setDisplays(list))
        .catch(() => {
          // 列表刷新失败时保留旧数据，高亮仍然按 info.id 走。
        });
    });
    return off;
  }, [clearPanelSettle, sendIgnore]);

  // 打开面板时刷新一次屏幕列表，应对热插拔之后的新屏幕。
  useEffect(() => {
    if (!settingsOpen) return;
    const api = window.petApi;
    if (!api?.listDisplays) return;
    let active = true;
    void api
      .listDisplays()
      .then((list) => {
        if (!active) return;
        setDisplays(list);
        const current = list.find((display) => display.current) ?? null;
        if (current) setCurrentDisplayId(current.id);
      })
      .catch(() => {
        // 忽略：保持上一次的列表。
      });
    return () => {
      active = false;
    };
  }, [settingsOpen]);

  // 面板高度会随「显示屏幕」这一行出现/换行变化，量出来用于避让和边界夹取。
  useEffect(() => {
    if (!settingsOpen) {
      setPanelHeight(PANEL_HEIGHT);
      return;
    }
    const element = stackRef.current;
    if (!element) return;
    const update = () => {
      const measured = Math.round(element.offsetHeight);
      if (measured > 0) setPanelHeight(measured);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [settingsOpen]);

  useEffect(() => {
    passthroughRef.current = passthrough;
  }, [passthrough]);

  // 用页面内的 clientX/clientY 判断是否该接管鼠标，避免 Windows 缩放坐标误差。
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY };
      pointerLastAtRef.current = performance.now();
      evaluatePointer(event.clientX, event.clientY);
    };

    const onLeave = () => {
      pointerRef.current = null;
      pointerLeftAtRef.current = performance.now();
      sendIgnore(true);
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    document.addEventListener("mouseleave", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseleave", onLeave);
    };
  }, [evaluatePointer, sendIgnore]);

  // 面板平滑移动时，即使鼠标不动，也持续用面板当前范围更新穿透状态。
  useEffect(() => {
    if (!settingsOpen) return;
    let frame = 0;
    const startedAt = performance.now();
    const tick = () => {
      const pointer = pointerRef.current;
      if (pointer) evaluatePointer(pointer.x, pointer.y);
      if (performance.now() - startedAt < 380) {
        frame = window.requestAnimationFrame(tick);
      }
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [evaluatePointer, panelPosition, settingsOpen]);

  // 设置面板关闭时点击空白处收起；打开时由主进程整层接管鼠标。
  useEffect(() => {
    if (!settingsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (stackRef.current?.contains(target)) return;
      if (gearRef.current?.contains(target)) return;
      settingsOpenRef.current = false;
      setSettingsOpen(false);
      sendIgnore(true);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      settingsOpenRef.current = false;
      setSettingsOpen(false);
      sendIgnore(true);
      gearRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [sendIgnore, settingsOpen]);

  const layout = useMemo(() => {
    if (!viewport.width || !viewport.height) return null;
    const mobile = viewport.width <= 760;
    const factor = scale / 100;
    const baseHeight = Math.min(
      mobile ? 380 : 640,
      viewport.height * (mobile ? 0.46 : 0.72),
    );
    // 10% 时人物要真的变小；300% 时允许超出屏幕，靠位置上限把它顶到视野里。
    const height = Math.max(48, baseHeight * factor);
    const baseWidth = mobile
      ? Math.min(viewport.width * 0.76, 340)
      : Math.min(420, viewport.width * 0.4);
    // 放大时舞台也要跟着变宽，否则宽度会先把模型卡住，300% 只能到 130% 左右。
    const width = baseWidth * Math.max(1, factor);
    const defaultLeft = Math.max(0, viewport.width - width);
    const defaultTop = Math.max(
      LIVE2D_MIN_TOP_PX,
      viewport.height - (height * 2) / 3,
    );
    const maxTop = Math.max(
      LIVE2D_MIN_TOP_PX,
      viewport.height - height / 3,
    );
    const leftRange = characterBox
      ? horizontalRange(characterBox, viewport.width)
      : { minimum: 0, maximum: Math.max(0, viewport.width - width) };
    const left = position
      ? clamp(position.left, leftRange.minimum, leftRange.maximum)
      : defaultLeft;
    const top = position
      ? clamp(position.top, LIVE2D_MIN_TOP_PX, maxTop)
      : defaultTop;
    return { left, top, width, height };
  }, [characterBox, position, scale, viewport]);

  const stackLayout = useMemo(() => {
    if (!panelPosition) return null;
    return {
      style: {
        left: panelPosition.left,
        top: panelPosition.top,
        width: panelPosition.width,
      } as CSSProperties,
    };
  }, [panelPosition]);

  // 保存最新的人物/布局/视口，供延迟解冻时计算面板位置。
  useEffect(() => {
    latestPanelInputRef.current = {
      characterBox,
      layout,
      viewport,
      anchor: settingsAnchor,
    };
  }, [characterBox, layout, settingsAnchor, viewport]);

  useEffect(() => {
    settingsOpenRef.current = settingsOpen;
  }, [settingsOpen]);

  // 切换人物后，等新模型真正就位再解冻面板。
  useEffect(() => {
    if (!settingsOpen || !panelFrozenRef.current) return;
    if (panelFreezeReasonRef.current !== "character") return;
    if (status === "ready" && characterBox) {
      schedulePanelSettle(140);
    }
  }, [characterBox, schedulePanelSettle, settingsOpen, status]);

  // 视口变化时重新夹住面板；冻结期间只夹边界，不重新避让人物。
  useEffect(() => {
    if (!settingsOpen || !viewport.width || !viewport.height) return;
    if (panelFrozenRef.current) {
      setPanelPosition((current) =>
        current
          ? {
              ...current,
              left: clamp(current.left, 12, Math.max(12, viewport.width - current.width - 12)),
              top: clamp(current.top, 12, Math.max(12, viewport.height - panelHeight - 12)),
            }
          : current,
      );
      return;
    }
    const { characterBox: box, layout: stage, anchor } = latestPanelInputRef.current;
    setPanelPosition(computePanelPlacement(anchor, box, stage, viewport, panelHeight));
  }, [panelHeight, settingsOpen, viewport.height, viewport.width]);

  useEffect(() => {
    return () => {
      if (panelSettleTimerRef.current) {
        window.clearTimeout(panelSettleTimerRef.current);
        panelSettleTimerRef.current = null;
      }
    };
  }, []);

  // 记录人物/齿轮的实际范围，供 mousemove 穿透判定使用。
  useEffect(() => {
    const gearRect = gearRef.current?.getBoundingClientRect();
    const stage =
      visible && layout && characterBox
        ? {
            x: layout.left + characterBox.x,
            y: layout.top + characterBox.y,
            width: characterBox.width,
            height: characterBox.height,
          }
        : null;
    hitRef.current = {
      stage,
      gear: gearRect
        ? {
            x: gearRect.x,
            y: gearRect.y,
            width: gearRect.width,
            height: gearRect.height,
          }
        : null,
    };
  }, [characterBox, layout, passthrough, viewport, visible]);

  useEffect(() => {
    if (!shouldLoad) return;
    const mount = mountRef.current;
    if (!mount) return;

    let cancelled = false;
    let app: Application | null = null;
    let model: Live2DModel | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let idleSpeechTimer: number | null = null;
    let idlePoseTimer: number | null = null;
    let expressionTimer: number | null = null;
    let greetingTimer: number | null = null;
    let startTimer: number | null = null;
    let removePointer: (() => void) | null = null;
    let removeVisibility: (() => void) | null = null;
    let removeCanvasPointer: (() => void) | null = null;
    let removeCanvasMouse: (() => void) | null = null;
    let removeWindowResize: (() => void) | null = null;
    let targetX = 0;
    let targetY = 0;
    let smoothX = 0;
    let smoothY = 0;
    let gazeMode: "follow" | "idle" = "follow";
    let expressionMode: "none" | "idle-pose" | "click" = "none";
    let idleGazeState: IdleGazeState | null = null;

    const headAnchorRef: { current: { x: number; y: number } | null } = { current: null };

    const fitModel = () => {
      if (!model || !app) return;
      const width = mount.clientWidth;
      const height = mount.clientHeight;
      if (!width || !height) return;
      const bounds = model.getLocalBounds();
      const modelWidth = Math.max(1, bounds.width || model.width);
      const modelHeight = Math.max(1, bounds.height || model.height);
      const nextScale = Math.min(width / modelWidth, height / modelHeight) * 0.98;
      model.scale.set(nextScale, nextScale);
      model.anchor.set(0.5, 1);
      model.position.set(width / 2, height);
    };

    const updateGaze = () => {
      const pointer = pointerRef.current;
      const head = headAnchorRef.current;
      if (!pointer || !head) return;
      targetX = clamp(
        (pointer.x - head.x) / (window.innerWidth * 0.5),
        -1,
        1,
      );
      targetY = clamp(
        (pointer.y - head.y) / (window.innerHeight * 0.5),
        -1,
        1,
      );
    };

    const scheduleIdleSpeech = () => {
      if (idleSpeechTimer) window.clearTimeout(idleSpeechTimer);
      idleSpeechTimer = window.setTimeout(() => {
        if (!cancelled && document.visibilityState === "visible") {
          showBubble(pick(LIVE2D_IDLE_LINES));
        }
        scheduleIdleSpeech();
      }, 25000 + Math.random() * 20000);
    };

    function startExpression(
      name: Live2DExpression,
      holdMs: number,
      mode: "idle-pose" | "click",
    ) {
      if (cancelled || !model) return;
      if (expressionTimer) {
        window.clearTimeout(expressionTimer);
        expressionTimer = null;
      }
      expressionMode = mode;
      void model.expression(name).catch((error: unknown) => {
        console.warn("[live2d] expression failed", error);
      });
      expressionTimer = window.setTimeout(() => {
        expressionTimer = null;
        if (cancelled) return;
        model?.internalModel.motionManager.expressionManager?.resetExpression();
        expressionMode = "none";
        if (gazeMode === "idle") {
          scheduleIdlePose(
            LIVE2D_IDLE_POSE_REPEAT_MIN_MS,
            LIVE2D_IDLE_POSE_REPEAT_MAX_MS,
          );
        }
      }, holdMs);
    }

    function scheduleIdlePose(minimumMs: number, maximumMs: number) {
      if (idlePoseTimer) {
        window.clearTimeout(idlePoseTimer);
        idlePoseTimer = null;
      }
      if (cancelled || gazeMode !== "idle") return;
      const delay =
        minimumMs + Math.random() * Math.max(0, maximumMs - minimumMs);
      idlePoseTimer = window.setTimeout(() => {
        idlePoseTimer = null;
        if (cancelled || gazeMode !== "idle") return;
        if (document.visibilityState !== "visible") return;
        if (expressionMode !== "none") {
          scheduleIdlePose(
            LIVE2D_IDLE_POSE_RETRY_MIN_MS,
            LIVE2D_IDLE_POSE_RETRY_MAX_MS,
          );
          return;
        }
        const hold =
          LIVE2D_IDLE_POSE_HOLD_MIN_MS +
          Math.random() *
            Math.max(
              0,
              LIVE2D_IDLE_POSE_HOLD_MAX_MS - LIVE2D_IDLE_POSE_HOLD_MIN_MS,
            );
        startExpression(characterProfile.idlePose, hold, "idle-pose");
      }, delay);
    }

    function enterIdle() {
      if (cancelled || gazeMode === "idle") return;
      gazeMode = "idle";
      const step = createIdleGaze(performance.now(), targetX, targetY);
      idleGazeState = step.state;
      targetX = step.x;
      targetY = step.y;
      scheduleIdlePose(
        LIVE2D_IDLE_POSE_FIRST_MIN_MS,
        LIVE2D_IDLE_POSE_FIRST_MAX_MS,
      );
    }

    function leaveIdle() {
      if (gazeMode === "follow") return;
      gazeMode = "follow";
      idleGazeState = null;
      if (idlePoseTimer) {
        window.clearTimeout(idlePoseTimer);
        idlePoseTimer = null;
      }
    }

    const start = async () => {
      setStatus("loading");
      try {
        await loadCubismCore();
        if (cancelled) return;

        const PIXI = await import("pixi.js");
        if (cancelled) return;
        // Pixi 的 path.toAbsolute 默认只识别 http(s)，在 app:// 自定义协议下会把
        // 根路径 /live2d/... 拼成 app://live2d/...。显式给 Resolver 一个根路径修正。
        const rendererRoot = `${window.location.origin}/`;
        if (PIXI.Assets?.resolver) {
          PIXI.Assets.resolver.basePath = rendererRoot;
          PIXI.Assets.resolver.rootPath = rendererRoot;
        }
        const LIVE2D = await import("untitled-pixi-live2d-engine/cubism");
        if (cancelled) return;

        if (!pluginRegistered) {
          PIXI.extensions.add(LIVE2D.Live2DPlugin);
          pluginRegistered = true;
        }
        if (!cubismConfigured) {
          LIVE2D.configureCubismSDK({ memorySizeMB: 32 });
          cubismConfigured = true;
        }

        const pixiApp = new PIXI.Application();
        app = pixiApp;
        appRef.current = pixiApp;
        await pixiApp.init({
          resizeTo: mount,
          backgroundAlpha: 0,
          autoDensity: true,
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          preference: "webgl",
          antialias: true,
        });
        if (cancelled) {
          pixiApp.destroy(true);
          return;
        }

        const canvas = pixiApp.canvas as HTMLCanvasElement;
        mount.appendChild(canvas);
        canvas.style.touchAction = "pan-y";
        canvas.setAttribute("aria-hidden", "true");
        pixiApp.ticker.maxFPS = window.matchMedia("(max-width: 760px)").matches ? 30 : 60;

        const live2dModel = await LIVE2D.Live2DModel.from(characterProfile.modelPath, {
          autoFocus: false,
          autoHitTest: false,
          anchorMode: "drawable",
          textureOptions: { lod: "full" },
        });
        model = live2dModel;
        if (cancelled) {
          live2dModel.destroy();
          pixiApp.destroy(true);
          return;
        }

        pixiApp.stage.addChild(live2dModel);
        fitModel();
        setStatus("ready");

        const core = live2dModel.internalModel.coreModel as unknown as ParameterCore;
        const idHeadX = getParameterId(live2dModel, "Param85");
        const idHeadY = getParameterId(live2dModel, "Param86");
        const idHeadZ = getParameterId(live2dModel, "Param87");
        const idEyeX = getParameterId(live2dModel, "ParamEyeBallX");
        const idEyeY = getParameterId(live2dModel, "ParamEyeBallY");

        const updateHeadAnchor = () => {
          if (!model) return;
          const rect = canvas.getBoundingClientRect();
          const bounds = model.getBounds();
          headAnchorRef.current = {
            x: rect.left + bounds.x + bounds.width / 2,
            y: rect.top + bounds.y + bounds.height * 0.12,
          };
          const nextBox = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
          const previousBox = characterBoxRef.current;
          if (
            !previousBox ||
            Math.abs(previousBox.x - nextBox.x) > 1 ||
            Math.abs(previousBox.y - nextBox.y) > 1 ||
            Math.abs(previousBox.width - nextBox.width) > 1 ||
            Math.abs(previousBox.height - nextBox.height) > 1
          ) {
            characterBoxRef.current = nextBox;
            setCharacterBox(nextBox);
          }
          if (gazeMode === "follow") updateGaze();
        };

        updateHeadAnchor();

        pixiApp.ticker.add((ticker) => {
          const now = performance.now();
          if (gazeMode === "follow") {
            if (pointerRef.current) {
              if (now - pointerLastAtRef.current > LIVE2D_IDLE_STILL_MS) enterIdle();
            } else if (now - pointerLeftAtRef.current > LIVE2D_IDLE_LEAVE_MS) {
              enterIdle();
            }
          } else if (
            gazeMode === "idle" &&
            pointerRef.current &&
            now - pointerLastAtRef.current < 500
          ) {
            // 主进程的系统鼠标事件在穿透状态下也能到达，用它把人物叫醒。
            leaveIdle();
            updateGaze();
          }
          if (gazeMode === "idle" && idleGazeState) {
            const step = advanceIdleGaze(idleGazeState, now);
            idleGazeState = step.state;
            targetX = step.x;
            targetY = step.y;
          }

          const delta = Math.min(ticker.deltaMS, 50);
          const ease = 1 - Math.exp(-delta / 140);
          smoothX += (targetX - smoothX) * ease;
          smoothY += (targetY - smoothY) * ease;
          core.setParameterValueById(idHeadX, smoothX * 28);
          core.setParameterValueById(idHeadY, smoothY * -24);
          core.setParameterValueById(idHeadZ, smoothX * 6);
          core.setParameterValueById(idEyeX, smoothX * 0.8);
          core.setParameterValueById(idEyeY, smoothY * -0.8);
        });

        const onPointerMove = (event: PointerEvent) => {
          pointerRef.current = { x: event.clientX, y: event.clientY };
          pointerLastAtRef.current = performance.now();
          if (gazeMode === "idle") leaveIdle();
          updateGaze();
        };
        const resetPointer = () => {
          pointerRef.current = null;
          pointerLeftAtRef.current = performance.now();
        };
        window.addEventListener("pointermove", onPointerMove, { passive: true });
        window.addEventListener("blur", resetPointer);
        document.addEventListener("pointerleave", resetPointer);
        removePointer = () => {
          window.removeEventListener("pointermove", onPointerMove);
          window.removeEventListener("blur", resetPointer);
          document.removeEventListener("pointerleave", resetPointer);
        };

        const react = () => {
          if (cancelled || !model) return;
          if (idlePoseTimer) {
            window.clearTimeout(idlePoseTimer);
            idlePoseTimer = null;
          }
          const expression = pick(characterProfile.clickExpressions);
          showBubble(LIVE2D_EXPRESSION_LINES[expression] ?? pick(LIVE2D_TAP_LINES));
          startExpression(expression, LIVE2D_CLICK_HOLD_MS, "click");
          if (characterProfile.clickSound) playClickSound(characterProfile.clickSound);
          scheduleIdleSpeech();
        };

        const beginDrag = (pointerId: number, clientX: number, clientY: number) => {
          if (cancelled) return;
          const wrapper = wrapperRef.current;
          if (!wrapper) return;
          const rect = wrapper.getBoundingClientRect();
          const startLeft = rect.left;
          const startTop = rect.top;
          const startX = clientX;
          const startY = clientY;
          // 边界按人物可见范围算，舞台盒子比人物宽，拿它当边界会在两侧留出空气墙。
          const box = characterBoxRef.current;
          const leftRange = box
            ? horizontalRange(box, window.innerWidth)
            : { minimum: 0, maximum: Math.max(0, window.innerWidth - rect.width) };
          const maxTop = Math.max(
            LIVE2D_MIN_TOP_PX,
            window.innerHeight - rect.height / 3,
          );
          let latest: StoredPosition = { left: startLeft, top: startTop };
          let moved = false;

          setSettingsOpen(false);
          draggingRef.current = true;
          sendIgnore(false);

          const onMove = (moveEvent: PointerEvent) => {
            if (moveEvent.pointerId !== pointerId) return;
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;
            if (!moved && Math.abs(dx) + Math.abs(dy) < 2) return;
            moved = true;
            const left = clamp(startLeft + dx, leftRange.minimum, leftRange.maximum);
            const top = clamp(startTop + dy, LIVE2D_MIN_TOP_PX, maxTop);
            latest = { left, top };
            setPosition({ left, top });
            window.requestAnimationFrame(() => {
              if (!cancelled) updateHeadAnchor();
            });
          };

          const finish = (finishEvent: PointerEvent) => {
            if (finishEvent.pointerId !== pointerId) return;
            canvas.removeEventListener("pointermove", onMove);
            canvas.removeEventListener("pointerup", finish);
            canvas.removeEventListener("pointercancel", finish);
            try {
              canvas.releasePointerCapture(pointerId);
            } catch {
              // The pointer may already be released.
            }
            draggingRef.current = false;
            if (moved) persistPosition(latest);
          };

          try {
            canvas.setPointerCapture(pointerId);
          } catch {
            // Pointer capture is best-effort.
          }
          canvas.addEventListener("pointermove", onMove);
          canvas.addEventListener("pointerup", finish);
          canvas.addEventListener("pointercancel", finish);
        };

        /**
         * 左键：先按住 0.5 秒，再移动超过 4px 才算拖拽；
         * 未达到阈值松开就是普通点击。
         */
        const startLeftPress = (event: PointerEvent) => {
          if (cancelled) return;
          const startX = event.clientX;
          const startY = event.clientY;
          let latestX = startX;
          let latestY = startY;
          let timerDone = false;
          let active = true;
          let dragStarted = false;
          let timer: number | null = null;

          const distance = () => Math.hypot(latestX - startX, latestY - startY);

          const cleanup = () => {
            if (!active) return;
            active = false;
            if (timer !== null) {
              window.clearTimeout(timer);
              timer = null;
            }
            canvas.removeEventListener("pointermove", onMove);
            canvas.removeEventListener("pointerup", onUp);
            canvas.removeEventListener("pointercancel", onCancel);
            try {
              canvas.releasePointerCapture(event.pointerId);
            } catch {
              // The pointer may already be released.
            }
          };

          const maybeStartDrag = () => {
            if (cancelled || !active || dragStarted || !timerDone) return;
            if (distance() <= LEFT_DRAG_DISTANCE_PX) return;
            dragStarted = true;
            const x = latestX;
            const y = latestY;
            cleanup();
            beginDrag(event.pointerId, x, y);
          };

          function onMove(moveEvent: PointerEvent) {
            if (moveEvent.pointerId !== event.pointerId) return;
            latestX = moveEvent.clientX;
            latestY = moveEvent.clientY;
            maybeStartDrag();
          }

          function onUp(upEvent: PointerEvent) {
            if (upEvent.pointerId !== event.pointerId) return;
            const wasActive = active;
            const movedDistance = distance();
            cleanup();
            if (wasActive && !dragStarted && movedDistance <= LEFT_DRAG_DISTANCE_PX) {
              react();
            }
          }

          function onCancel(cancelEvent: PointerEvent) {
            if (cancelEvent.pointerId !== event.pointerId) return;
            cleanup();
          }

          timer = window.setTimeout(() => {
            timer = null;
            timerDone = true;
            maybeStartDrag();
          }, LEFT_DRAG_HOLD_MS);

          try {
            canvas.setPointerCapture(event.pointerId);
          } catch {
            // Pointer capture is best-effort.
          }
          canvas.addEventListener("pointermove", onMove);
          canvas.addEventListener("pointerup", onUp);
          canvas.addEventListener("pointercancel", onCancel);
        };

        const noteInteraction = (event: PointerEvent) => {
          pointerRef.current = { x: event.clientX, y: event.clientY };
          pointerLastAtRef.current = performance.now();
          if (gazeMode === "idle") leaveIdle();
          updateGaze();
        };
        const onCanvasPointerDown = (event: PointerEvent) => {
          noteInteraction(event);
          if (event.pointerType === "mouse" && event.button === 1) {
            event.preventDefault();
            beginDrag(event.pointerId, event.clientX, event.clientY);
            return;
          }
          if (event.pointerType === "mouse" && event.button !== 0) return;
          if (event.pointerType !== "mouse") {
            react();
            return;
          }
          startLeftPress(event);
        };
        canvas.addEventListener("pointerdown", onCanvasPointerDown);
        removeCanvasPointer = () => canvas.removeEventListener("pointerdown", onCanvasPointerDown);

        const onMouseDown = (event: MouseEvent) => {
          if (event.button === 1) event.preventDefault();
        };
        const onAuxClick = (event: MouseEvent) => {
          if (event.button === 1) event.preventDefault();
        };
        canvas.addEventListener("mousedown", onMouseDown);
        canvas.addEventListener("auxclick", onAuxClick);
        removeCanvasMouse = () => {
          canvas.removeEventListener("mousedown", onMouseDown);
          canvas.removeEventListener("auxclick", onAuxClick);
        };

        const onVisibility = () => {
          if (!app) return;
          if (document.hidden) {
            app.ticker.stop();
            return;
          }
          app.ticker.start();
          if (
            gazeMode === "idle" &&
            !idlePoseTimer &&
            expressionMode === "none"
          ) {
            scheduleIdlePose(
              LIVE2D_IDLE_POSE_FIRST_MIN_MS,
              LIVE2D_IDLE_POSE_FIRST_MAX_MS,
            );
          }
        };
        document.addEventListener("visibilitychange", onVisibility);
        removeVisibility = () => document.removeEventListener("visibilitychange", onVisibility);

        const onWindowResize = () => {
          window.requestAnimationFrame(() => {
            if (!cancelled) updateHeadAnchor();
          });
        };
        window.addEventListener("resize", onWindowResize);
        removeWindowResize = () => window.removeEventListener("resize", onWindowResize);

        resizeObserver = new ResizeObserver(() => {
          if (!app) return;
          app.resize();
          fitModel();
          updateHeadAnchor();
        });
        resizeObserver.observe(mount);

        scheduleIdleSpeech();
        greetingTimer = window.setTimeout(() => {
          if (cancelled) return;
          if (!window.sessionStorage.getItem(LIVE2D_SESSION_KEY)) {
            window.sessionStorage.setItem(LIVE2D_SESSION_KEY, "1");
            showBubble(pick(LIVE2D_GREETINGS), 7200);
          }
        }, 900);
      } catch (error) {
        console.error("[live2d] failed to start", error);
        if (!cancelled) {
          if (model) {
            safeDestroy(() => model?.destroy());
            model = null;
          }
          if (app) {
            safeDestroy(() => app?.destroy(true, { children: true }));
            app = null;
          }
          appRef.current = null;
          // 失败后清掉偏好，刷新时回到未唤醒，避免反复自动加载慢资源。
          setStatus("error");
          setVisible(false);
          try {
            window.localStorage.removeItem(LIVE2D_STORAGE_KEY);
          } catch {
            // Ignore storage failures.
          }
        }
      }
    };

    startTimer = window.setTimeout(() => {
      void start();
    }, 900);

    return () => {
      cancelled = true;
      if (startTimer) window.clearTimeout(startTimer);
      if (idleSpeechTimer) window.clearTimeout(idleSpeechTimer);
      if (idlePoseTimer) window.clearTimeout(idlePoseTimer);
      if (expressionTimer) window.clearTimeout(expressionTimer);
      if (greetingTimer) window.clearTimeout(greetingTimer);
      removePointer?.();
      removeVisibility?.();
      removeCanvasPointer?.();
      removeCanvasMouse?.();
      removeWindowResize?.();
      resizeObserver?.disconnect();
      draggingRef.current = false;
      sendIgnore(true);
      if (model) {
        safeDestroy(() => model?.destroy());
        model = null;
      }
      if (app) {
        safeDestroy(() => app?.destroy(true, { children: true }));
        app = null;
      }
      appRef.current = null;
      setStatus("idle");
      clearBubble();
    };
  }, [characterProfile, playClickSound, shouldLoad, loadAttempt, showBubble, clearBubble, persistPosition, sendIgnore]);

  useEffect(() => {
    const app = appRef.current;
    if (!app) return;
    if (visible) {
      app.ticker.start();
    } else {
      app.ticker.stop();
    }
  }, [visible, status]);

  useEffect(() => {
    return () => {
      if (bubbleTimerRef.current) window.clearTimeout(bubbleTimerRef.current);
    };
  }, []);

  const onStageContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (passthrough) return;
    event.preventDefault();
    openSettingsAt(event.clientX, event.clientY);
  };

  const toggleSettingsFromGear = () => {
    if (settingsOpen) {
      settingsOpenRef.current = false;
      setSettingsOpen(false);
      sendIgnore(true);
      return;
    }
    const rect = gearRef.current?.getBoundingClientRect();
    if (!rect) return;
    openSettingsAt(Math.max(12, rect.left - 316), Math.max(12, rect.top - 8));
  };

  const iconState =
    !summoned || status === "error"
      ? "sleeping"
      : shouldLoad && visible && status !== "ready"
        ? "loading"
        : "awake";
  const iconLabel =
    iconState === "sleeping"
      ? `召唤${characterProfile.name}`
      : iconState === "loading"
        ? `${characterProfile.name}回溯中`
        : characterProfile.name;
  const iconTip =
    iconState === "sleeping"
      ? `召唤${characterProfile.name}`
      : iconState === "loading"
        ? `${characterProfile.name}回溯中……`
        : characterProfile.name;

  const onSettingsIconClick = () => {
    if (iconState === "loading") return;
    if (iconState === "sleeping") {
      summonCompanion();
      return;
    }
    // 人物只是被隐藏时，点一下先直接显示，不打开面板。
    if (!visible) {
      toggleVisible();
      return;
    }
    toggleSettingsFromGear();
  };

  return (
    <>
      {initialized && layout ? (
        <div
          ref={wrapperRef}
          className={styles.companion}
          style={{
            left: layout.left,
            top: layout.top,
            width: layout.width,
            height: layout.height,
          }}
        >
          {visible && bubble ? (
            <p className={styles.bubble} role="status" aria-live="polite">
              {bubble}
            </p>
          ) : null}
          <div
            ref={mountRef}
            className={`${styles.stage}${passthrough ? ` ${styles.stagePassthrough}` : ""}${visible ? "" : ` ${styles.stageHidden}`}`}
            onContextMenu={onStageContextMenu}
          >
            {visible && status !== "ready" && status !== "error" ? (
              <div className={styles.loadingCard} role="status" aria-live="polite">
                <span className={styles.loadingTitle}>{characterProfile.name}回溯中……</span>
                <span className={styles.loadingBar} aria-hidden="true" />
              </div>
            ) : null}
            {visible && status === "error" ? (
              <div className={styles.errorCard} role="alert">
                {characterProfile.name}加载失败
              </div>
            ) : null}
          </div>
          <div className={styles.controls}>
            <button
              ref={gearRef}
              type="button"
              className={`appearance-trigger ${styles.settingsButton}${settingsOpen ? ` ${styles.settingsActive}` : ""}`}
              aria-label={iconLabel}
              aria-expanded={iconState === "awake" ? settingsOpen : false}
              onPointerEnter={(event) => {
                if (event.pointerType === "mouse") popSettingsIcon();
              }}
              onPointerDown={popSettingsIcon}
              onClick={onSettingsIconClick}
            >
              {iconFailed ? (
                <span
                  className={`${styles.settingsIconFallback}${iconState === "awake" ? "" : ` ${styles.settingsDormant}`}`}
                  aria-hidden="true"
                >
                  {characterProfile.initial}
                </span>
              ) : (
                <img
                  key={character}
                  ref={iconRef}
                  className={`${styles.settingsIcon}${iconState === "awake" ? "" : ` ${styles.settingsDormant}`}`}
                  src={characterProfile.iconPath}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                  onError={() => setIconFailed(true)}
                  onAnimationEnd={(event) =>
                    event.currentTarget.classList.remove(styles.iconPop)
                  }
                />
              )}
              <span
                className={`${styles.settingsTip}${iconState === "sleeping" ? ` ${styles.settingsTipSummon}` : ""}`}
                aria-hidden="true"
              >
                {iconTip}
              </span>
            </button>
          </div>
        </div>
      ) : null}
      {settingsOpen && stackLayout ? (
        <div
          ref={stackRef}
          className={styles.stack}
          style={stackLayout.style}
        >
          <Live2DSettingsPanel
            visible={visible}
            passthrough={passthrough}
            autoLaunch={autoLaunch}
            autoLaunchPending={autoLaunchPending}
            scale={scale}
            character={character}
            characterName={characterProfile.name}
            nextCharacterName={otherCharacterProfile.name}
            displays={displays}
            currentDisplayId={currentDisplayId}
            onSwitchCharacter={switchCharacter}
            onSelectDisplay={selectDisplay}
            canViewDiary
            onOpenDiary={() => {
              settingsOpenRef.current = false;
              setSettingsOpen(false);
              sendIgnore(true);
              window.petApi?.openDiary();
            }}
            onClose={closeSettings}
            onToggleVisible={toggleVisible}
            onTogglePassthrough={togglePassthrough}
            onToggleAutoLaunch={toggleAutoLaunch}
            onScaleChange={changeScale}
            onScaleStart={startScale}
            onScaleCommit={commitScale}
          />
        </div>
      ) : null}
    </>
  );
}

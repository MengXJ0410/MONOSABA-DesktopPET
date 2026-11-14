import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type {
  ChatMessage,
  ChatStatus,
  DisplayInfo,
} from "../../../../shared/types";
import styles from "./chat-panel.module.css";

const STATUS_TEXT: Record<ChatStatus["state"], string> = {
  online: "已连接",
  "qq-offline": "QQ 未连接",
  offline: "无法连接",
  auth: "密钥无效",
  "bridge-missing": "桥接插件未安装",
};

const REPLY_TIMEOUT_MS = 90_000;
const MAX_INPUT_HEIGHT = 120;

function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
  return a.role === b.role && a.text === b.text;
}

export function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<ChatStatus>({
    state: "offline",
    detail: "正在连接……",
  });
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [captureEnabled, setCaptureEnabled] = useState(false);
  const [displayId, setDisplayId] = useState("");

  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const nearBottomRef = useRef(true);
  const seenIdsRef = useRef<Set<number>>(new Set());
  const pendingLiveRef = useRef<ChatMessage[]>([]);
  const historyLoadedRef = useRef(false);
  const awaitingRef = useRef(false);

  const blocking =
    status.state === "offline" ||
    status.state === "auth" ||
    status.state === "bridge-missing";

  useEffect(() => {
    document.documentElement.dataset.petCharacter = "hiro";
    return () => {
      delete document.documentElement.dataset.petCharacter;
    };
  }, []);

  useEffect(() => {
    setCaptureEnabled(window.localStorage.getItem("chat.capture.enabled") === "1");
    let cancelled = false;
    void window.petApi
      .listDisplays()
      .then((list) => {
        if (cancelled) return;
        setDisplays(list);
        const saved = window.localStorage.getItem("chat.capture.displayId") ?? "";
        const savedExists = list.some((item) => item.id === saved);
        const fallback =
          list.find((item) => item.current) ??
          list.find((item) => item.primary) ??
          list[0];
        setDisplayId(savedExists ? saved : (fallback?.id ?? ""));
      })
      .catch(() => {
        // 屏幕列表拿不到时仍然可以在主屏上截。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const appendLive = useCallback((incoming: ChatMessage[]) => {
    if (!Array.isArray(incoming) || incoming.length === 0) return;
    const fresh: ChatMessage[] = [];
    for (const message of incoming) {
      if (!message || typeof message.id !== "number" || message.id <= 0) continue;
      if (seenIdsRef.current.has(message.id)) continue;
      seenIdsRef.current.add(message.id);
      fresh.push(message);
    }
    if (fresh.length === 0) return;

    if (!historyLoadedRef.current) {
      pendingLiveRef.current.push(...fresh);
      return;
    }

    setMessages((prev) => [...prev, ...fresh]);
    if (awaitingRef.current && fresh.some((message) => message.role === "assistant")) {
      awaitingRef.current = false;
      setWaiting(false);
      setTimedOut(false);
    }
  }, []);

  useEffect(() => {
    const offMessages = window.petApi.onChatMessages(appendLive);
    const offStatus = window.petApi.onChatStatus((next) => setStatus(next));
    return () => {
      offMessages();
      offStatus();
    };
  }, [appendLive]);

  const load = useCallback(async () => {
    setLoading(true);
    setSendError(null);
    const result = await window.petApi.chatHistory();
    if (!result.ok) {
      const state: ChatStatus["state"] =
        result.kind === "auth"
          ? "auth"
          : result.kind === "server" && result.error.includes("未安装")
            ? "bridge-missing"
            : "offline";
      setStatus({ state, detail: result.error });
      setLoading(false);
      return;
    }

    const history = Array.isArray(result.data.messages) ? result.data.messages : [];
    const buffered = pendingLiveRef.current;
    pendingLiveRef.current = [];
    seenIdsRef.current = new Set();

    const tail = history[history.length - 1];
    const extra =
      tail === undefined
        ? buffered
        : buffered.filter((message) => !sameMessage(message, tail));
    for (const message of extra) {
      if (message.id > 0) seenIdsRef.current.add(message.id);
    }

    setMessages([...history, ...extra]);
    historyLoadedRef.current = true;
    // 回填期间最后几毫秒到达的消息还留在缓冲区里，补在历史后面。
    const late = pendingLiveRef.current;
    pendingLiveRef.current = [];
    if (late.length > 0) {
      for (const message of late) {
        if (message.id > 0) seenIdsRef.current.add(message.id);
      }
      setMessages((prev) => [...prev, ...late]);
    }
    setHistoryLoaded(true);
    setLoading(false);
    setStatus(
      result.data.qqConnected ? { state: "online" } : { state: "qq-offline" },
    );
    nearBottomRef.current = true;
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => {
      if (!awaitingRef.current) return;
      awaitingRef.current = false;
      setWaiting(false);
      setTimedOut(true);
    }, REPLY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [waiting]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || !nearBottomRef.current) return;
    list.scrollTop = list.scrollHeight;
  }, [messages, waiting, timedOut]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "0px";
    input.style.height = `${Math.min(MAX_INPUT_HEIGHT, input.scrollHeight)}px`;
  }, [draft]);

  useEffect(() => {
    if (!loading && !blocking) inputRef.current?.focus();
  }, [blocking, loading]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        window.petApi.closeChat();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const canSend = historyLoaded && !loading && !blocking && !sending;

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!text || !canSend) return;
    if (text.startsWith("/")) {
      setSendError("桌面聊天暂不支持指令。");
      return;
    }

    setSending(true);
    setSendError(null);
    // 先进入等待态：回复可能比 /send 的 HTTP 响应先到。
    awaitingRef.current = true;
    setWaiting(true);
    setTimedOut(false);

    const result = await window.petApi.chatSend(text, {
      captureScreen: captureEnabled,
      displayId: displayId || undefined,
    });
    setSending(false);

    if (!result.ok) {
      awaitingRef.current = false;
      setWaiting(false);
      setSendError(result.error);
      if (result.kind === "auth") {
        setStatus({ state: "auth", detail: result.error });
      } else if (result.kind === "offline") {
        setStatus({ state: "offline", detail: result.error });
      }
      return;
    }

    const message = result.data.message;
    if (message) {
      if (result.data.screenImage) {
        message.image = result.data.screenImage;
      }
      seenIdsRef.current.add(message.id);
      setMessages((prev) => {
        // 轮询可能比 /send 的响应先到，先把截图合并进已有气泡。
        const index = prev.findIndex((item) => item.id === message.id);
        if (index >= 0) {
          if (!result.data.screenImage || prev[index].image) {
            return prev;
          }
          const next = [...prev];
          next[index] = { ...prev[index], image: result.data.screenImage };
          return next;
        }
        return [...prev, message];
      });
    }
    if (result.data.captureFailed) {
      setSendError("截图失败，已只发送文字。");
    }
    setDraft("");
  }, [canSend, captureEnabled, displayId, draft]);

  const toggleCapture = () => {
    setCaptureEnabled((prev) => {
      const next = !prev;
      window.localStorage.setItem("chat.capture.enabled", next ? "1" : "0");
      return next;
    });
  };

  const changeCaptureDisplay = (value: string) => {
    setDisplayId(value);
    window.localStorage.setItem("chat.capture.displayId", value);
  };

  const onComposerKeyDown = (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  const onListScroll = () => {
    const list = listRef.current;
    if (!list) return;
    nearBottomRef.current =
      list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  };

  const statusText = STATUS_TEXT[status.state];
  const dotClass =
    status.state === "online"
      ? styles.dotOnline
      : status.state === "qq-offline"
        ? styles.dotWarn
        : styles.dotOffline;

  const banner = blocking
    ? status.detail || statusText
    : status.state === "qq-offline"
      ? "QQ 未连接，手机消息暂时同步不过来"
      : null;

  return (
    <div className={styles.shell}>
      <section className={styles.card} aria-label="与希罗的聊天">
        <header className={styles.header}>
          <span className={styles.title}>希罗</span>
          <span
            className={`${styles.dot} ${dotClass}`}
            role="status"
            aria-label={statusText}
            title={statusText}
          />
          <button
            type="button"
            className={styles.close}
            onClick={() => window.petApi.closeChat()}
            aria-label="关闭聊天"
          >
            ×
          </button>
        </header>

        <div className={styles.toolbar}>
          <button
            type="button"
            role="switch"
            aria-checked={captureEnabled}
            className={`${styles.captureToggle}${captureEnabled ? ` ${styles.captureOn}` : ""}`}
            onClick={toggleCapture}
          >
            <span className={styles.switchTrack} aria-hidden="true">
              <span className={styles.switchThumb} />
            </span>
            <span>获取屏幕</span>
          </button>
          {captureEnabled && displays.length > 1 ? (
            <select
              className={styles.displaySelect}
              value={displayId}
              onChange={(event) => changeCaptureDisplay(event.target.value)}
              aria-label="截图屏幕"
            >
              {displays.map((display) => (
                <option key={display.id} value={display.id}>
                  {display.label}
                  {display.primary ? "（主屏）" : ""}
                </option>
              ))}
            </select>
          ) : null}
        </div>

        {banner ? (
          <div
            className={`${styles.banner}${blocking ? "" : ` ${styles.bannerWarn}`}`}
            role="alert"
          >
            <span>{banner}</span>
            {blocking ? (
              <button
                type="button"
                className={styles.retry}
                onClick={() => void load()}
              >
                重试
              </button>
            ) : null}
          </div>
        ) : null}

        <div
          ref={listRef}
          className={styles.list}
          onScroll={onListScroll}
          role="log"
          aria-live="polite"
          aria-label="聊天记录"
        >
          {loading ? <div className={styles.placeholder}>连接中……</div> : null}
          {!loading && !blocking && messages.length === 0 ? (
            <div className={styles.placeholder}>还没有对话。</div>
          ) : null}
          {messages.map((message, index) => (
            <div
              key={message.id > 0 ? `m-${message.id}` : `h-${index}`}
              className={`${styles.row} ${
                message.role === "assistant" ? styles.rowAssistant : styles.rowUser
              }`}
            >
              <div
                className={`${styles.bubble} ${
                  message.role === "assistant"
                    ? styles.bubbleAssistant
                    : styles.bubbleUser
                }`}
              >
                {message.text ? <span>{message.text}</span> : null}
                {message.image ? (
                  <img
                    className={styles.thumb}
                    src={message.image}
                    alt="屏幕截图"
                    draggable={false}
                  />
                ) : null}
              </div>
            </div>
          ))}
          {waiting ? <div className={styles.typing}>希罗正在回复……</div> : null}
          {timedOut ? <div className={styles.typing}>希罗没有回应。</div> : null}
        </div>

        {sendError ? (
          <div className={styles.sendError} role="alert">
            {sendError}
          </div>
        ) : null}

        <div className={styles.composer}>
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder="和希罗说点什么……"
            aria-label="消息"
            rows={1}
            maxLength={2000}
            disabled={blocking || loading}
          />
          <button
            type="button"
            className={styles.send}
            onClick={() => void submit()}
            disabled={!canSend || !draft.trim()}
          >
            发送
          </button>
        </div>
      </section>
    </div>
  );
}

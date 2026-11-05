"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DIARY_PASSPHRASE, DIARY_PASSPHRASE_HINT } from "@/content/live2d";
import { parseEntries } from "@/lib/diary/parse";
import type {
  DiaryPayload,
  MemoryEntry,
  MemoryPayload,
} from "../../../../shared/types";
import { MosaicTransition, type MosaicRect } from "./mosaic-transition";
import styles from "./diary-panel.module.css";

type Book = { name: string; size: number; mtime: number };
type DiaryView = "diary" | "memory";

type DiaryPanelProps = {
  onClose: () => void;
  /** 独立日记窗口模式：卡片铺满窗口、标题栏可拖动。 */
  windowMode?: boolean;
  onSizeChange?: (size: { width: number; height: number }) => void;
};

const MEMORY_ICON_PATH = "/live2d/ui/hiro-memory.png";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
/** 截图失败时的兜底淡出时长。 */
const FALLBACK_SWITCH_MS = 220;

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ReloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path
        d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M21 3v5h-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DiaryPanel({ onClose, windowMode = false, onSizeChange }: DiaryPanelProps) {
  const [books, setBooks] = useState<Book[]>([]);
  const [book, setBook] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [size, setSize] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);

  // 日记本上锁：先念咒语，念对了才去取内容。
  const [unlocked, setUnlocked] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  // 日记 / 记忆两个视图
  const [view, setView] = useState<DiaryView>("diary");
  const [memory, setMemory] = useState<MemoryPayload | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const [snapshot, setSnapshot] = useState<{
    imageUrl: string;
    rect: MosaicRect;
  } | null>(null);

  const closeRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const memoryInFlightRef = useRef(false);
  const scrollPositionsRef = useRef<Record<DiaryView, number>>({
    diary: 0,
    memory: 0,
  });

  const applyPayload = useCallback((data: DiaryPayload) => {
    setBooks(Array.isArray(data.books) ? data.books : []);
    setBook(typeof data.book === "string" ? data.book : null);
    setContent(typeof data.content === "string" ? data.content : "");
    setSize(typeof data.size === "number" ? data.size : 0);
    setTruncated(data.truncated === true);
    setError(null);
    setLoading(false);
  }, []);

  const load = useCallback(
    async (target?: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const result = await window.petApi.loadDiary(target ?? null);
        if (!mountedRef.current) return;
        if (result.ok) applyPayload(result.data);
        else {
          setError(result.error || "日记本打不开。");
          setLoading(false);
        }
      } catch (caught) {
        if (!mountedRef.current) return;
        setError(caught instanceof Error ? caught.message : "日记本打不开。");
        setLoading(false);
      }
    },
    [applyPayload],
  );

  const loadMemory = useCallback(async () => {
    if (memoryInFlightRef.current) return;
    memoryInFlightRef.current = true;
    setMemoryLoading(true);
    setMemoryError(null);
    try {
      const result = await window.petApi.loadMemory();
      if (!mountedRef.current) return;
      if (result.ok) setMemory(result.data);
      else setMemoryError(result.error || "记忆暂时打不开。");
    } catch (caught) {
      if (!mountedRef.current) return;
      setMemoryError(caught instanceof Error ? caught.message : "记忆暂时打不开。");
    } finally {
      memoryInFlightRef.current = false;
      if (mountedRef.current) setMemoryLoading(false);
    }
  }, []);

  const unlock = useCallback(async () => {
    const value = keyInput.trim();
    if (!value || checking) return;

    if (value !== DIARY_PASSPHRASE) {
      setKeyError(DIARY_PASSPHRASE_HINT);
      return;
    }

    setChecking(true);
    setKeyError(null);
    setUnlocked(true);
    setKeyInput("");
    await load(null);
    // 解锁后在后台把记忆也取一份，点入口时切换几乎无等待。
    void loadMemory();
    if (mountedRef.current) setChecking(false);
  }, [checking, keyInput, load, loadMemory]);

  // 合上日记：先播 200ms 收合动画，再真正关掉窗口。
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (window.matchMedia(REDUCED_MOTION_QUERY).matches) {
      onClose();
      return;
    }
    setClosing(true);
    window.setTimeout(onClose, 200);
  }, [onClose]);

  useEffect(() => {
    mountedRef.current = true;
    window.petApi?.focus();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 不是所有电脑都有希罗的 SSH 私钥；没有密钥时直接显示空日记，不要咒语框。
  useEffect(() => {
    let active = true;
    const api = window.petApi;
    if (!api) {
      setAvailable(false);
      return;
    }
    void api
      .diaryAvailability()
      .then((value) => {
        if (active) setAvailable(Boolean(value));
      })
      .catch(() => {
        if (active) setAvailable(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useLayoutEffect(() => {
    const element = cardRef.current;
    if (!element) return;
    const report = () => {
      const rect = element.getBoundingClientRect();
      onSizeChange?.({
        width: Math.ceil(rect.width),
        height: Math.ceil(rect.height),
      });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    window.addEventListener("resize", report);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
    };
  }, [onSizeChange]);

  useEffect(() => {
    if (unlocked) closeRef.current?.focus();
    else inputRef.current?.focus();
  }, [unlocked]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      requestClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [requestClose]);

  // 切换视图后恢复该视图上次的滚动位置。
  useEffect(() => {
    const element = bodyRef.current;
    if (element) element.scrollTop = scrollPositionsRef.current[view];
  }, [view]);

  // 截图失败等异常情况下，别让 switching 卡住。
  useEffect(() => {
    if (!switching || snapshot) return;
    const timer = window.setTimeout(() => setSwitching(false), 1200);
    return () => window.clearTimeout(timer);
  }, [snapshot, switching]);

  const entries = useMemo(() => parseEntries(content), [content]);
  const meta = book ? `${formatSize(size)} · ${entries.length} 篇` : "";
  const locked = available === true && !unlocked;

  const memoryGroups = useMemo(() => {
    if (!memory) return [] as Array<{ date: string; items: MemoryEntry[] }>;
    const groups = new Map<string, MemoryEntry[]>();
    for (const entry of memory.entries) {
      const items = groups.get(entry.date);
      if (items) items.push(entry);
      else groups.set(entry.date, [entry]);
    }
    return Array.from(groups, ([date, items]) => ({ date, items }));
  }, [memory]);

  const memoryMeta = memory
    ? `${memory.count} 条 · ${memory.days} 天`
    : memoryLoading
      ? "正在回忆……"
      : "";

  const finishSwitch = useCallback(() => {
    setSnapshot(null);
    setSwitching(false);
  }, []);

  const toggleView = useCallback(async () => {
    if (switching) return;
    const next: DiaryView = view === "memory" ? "diary" : "memory";
    if (next === "memory" && !memory && !memoryLoading) void loadMemory();

    setSwitching(true);
    scrollPositionsRef.current[view] = bodyRef.current?.scrollTop ?? 0;

    const card = cardRef.current;
    let shot: { imageUrl: string; rect: MosaicRect } | null = null;

    if (card && !window.matchMedia(REDUCED_MOTION_QUERY).matches) {
      const rect = card.getBoundingClientRect();
      try {
        const result = await window.petApi.captureDiaryCard({
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        });
        if (result.ok && result.dataUrl) {
          shot = {
            imageUrl: result.dataUrl,
            rect: {
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
            },
          };
        }
      } catch {
        // 截图失败就退化成普通淡出。
      }
    }

    if (!mountedRef.current) return;
    setSnapshot(shot);
    setView(next);
    if (!shot) {
      window.setTimeout(() => {
        if (mountedRef.current) setSwitching(false);
      }, FALLBACK_SWITCH_MS);
    }
  }, [loadMemory, memory, memoryLoading, switching, view]);

  const reloadActiveView = () => {
    if (view === "memory") void loadMemory();
    else void load(book);
  };

  const activeLoading = view === "memory" ? memoryLoading : loading;

  return (
    <div className={`${styles.overlay}${windowMode ? ` ${styles.windowMode}` : ""}`}>
      <div
        ref={cardRef}
        data-diary-card=""
        className={`${styles.card}${locked ? ` ${styles.locked}` : ""}${
          minimized ? ` ${styles.minimized}` : ""
        }${view === "memory" ? ` ${styles.memoryMode}` : ""}${
          switching ? ` ${styles.switching}` : ""
        }${closing ? ` ${styles.closing}` : ""}`}
        style={snapshot ? { height: snapshot.rect.height } : undefined}
        role="dialog"
        aria-modal="false"
        aria-label={view === "memory" ? "希罗的记忆" : "希罗的日记"}
      >
        <header className={styles.header}>
          <span className={styles.title}>
            {view === "memory" ? "希罗的记忆" : "希罗的日记"}
          </span>
          {!minimized && unlocked && view === "diary" && books.length > 1 ? (
            <select
              className={styles.select}
              value={book ?? ""}
              aria-label="选择日记本"
              disabled={loading}
              onChange={(event) => {
                void load(event.target.value);
              }}
            >
              {books.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          ) : null}
          {!minimized && unlocked ? (
            <span className={styles.meta}>
              {view === "memory" ? memoryMeta : meta}
            </span>
          ) : null}
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.windowButton}
              aria-label={minimized ? "还原日记" : "最小化日记"}
              title={minimized ? "还原" : "最小化"}
              onClick={() => setMinimized((current) => !current)}
            >
              {minimized ? "▢" : "−"}
            </button>
            <button
              ref={closeRef}
              type="button"
              className={styles.close}
              aria-label="关闭日记"
              title="关闭"
              onClick={requestClose}
            >
              ×
            </button>
          </div>
        </header>

        {minimized ? null : available === null ? (
          <div className={styles.emptyState}>
            <p className={styles.hint}>正在翻日记本……</p>
          </div>
        ) : available === false ? (
          <div className={styles.emptyState}>
            <p className={styles.emptyText}>啥也没写</p>
          </div>
        ) : unlocked ? (
          <>
            <div className={styles.body} ref={bodyRef}>
              {view === "diary" ? (
                <>
                  {loading ? <p className={styles.hint}>正在翻日记本……</p> : null}

                  {!loading && error ? <p className={styles.error}>{error}</p> : null}

                  {!loading && !error && entries.length === 0 ? (
                    <p className={styles.hint}>希罗还没写日记。</p>
                  ) : null}

                  {!loading && !error
                    ? entries.map((entry) => (
                        <article key={entry.id} className={styles.entry}>
                          <h3 className={styles.entryTitle}>{entry.title}</h3>
                          <div className={styles.markdown}>
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {entry.body}
                            </ReactMarkdown>
                          </div>
                        </article>
                      ))
                    : null}
                </>
              ) : (
                <>
                  {memoryLoading && !memory ? (
                    <p className={styles.hint}>正在回忆……</p>
                  ) : null}

                  {!memoryLoading && memoryError ? (
                    <p className={styles.error}>{memoryError}</p>
                  ) : null}

                  {!memoryLoading && !memoryError && memory && memory.entries.length === 0 ? (
                    <p className={styles.hint}>希罗什么也想不起来。</p>
                  ) : null}

                  {memoryGroups.map((group) => (
                    <section key={group.date} className={styles.memoryDay}>
                      <h3 className={styles.memoryDate}>{group.date}</h3>
                      {group.items.map((entry, index) => (
                        <article
                          key={`${group.date}-${index}`}
                          className={styles.memoryItem}
                        >
                          <div className={styles.memoryMetaRow}>
                            <span className={styles.memoryKind}>
                              {entry.kind || "记忆"}
                            </span>
                            {entry.imp > 0 ? (
                              <span
                                className={styles.memoryStars}
                                aria-label={`重要度 ${entry.imp}`}
                              >
                                {"★".repeat(Math.max(0, Math.min(5, entry.imp)))}
                              </span>
                            ) : null}
                            <span className={styles.memoryScope}>
                              {entry.scope === "diary" ? "日记" : "对话"}
                            </span>
                          </div>
                          {entry.kind === "日记" ? (
                            <div className={styles.memoryMarkdown}>
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {entry.text}
                              </ReactMarkdown>
                            </div>
                          ) : (
                            <p className={styles.memoryText}>{entry.text}</p>
                          )}
                        </article>
                      ))}
                    </section>
                  ))}
                </>
              )}
            </div>

            <footer className={styles.footer}>
              <button
                type="button"
                className={styles.reloadButton}
                aria-label="重新载入"
                title="重新载入"
                disabled={activeLoading || switching}
                onClick={reloadActiveView}
              >
                <ReloadIcon />
              </button>
              {truncated && view === "diary" ? (
                <span className={styles.notice}>
                  超过 4MB，只显示最新部分。
                </span>
              ) : null}
              <button
                type="button"
                className={`${styles.memoryEntry}${
                  view === "memory" ? ` ${styles.memoryEntryActive}` : ""
                }`}
                aria-label={view === "memory" ? "返回日记" : "查看记忆"}
                aria-pressed={view === "memory"}
                title={view === "memory" ? "返回日记" : "查看记忆"}
                disabled={switching}
                onClick={() => void toggleView()}
              >
                <img src={MEMORY_ICON_PATH} alt="" aria-hidden="true" draggable={false} />
              </button>
            </footer>
          </>
        ) : (
          <form
            className={styles.lock}
            onSubmit={(event) => {
              event.preventDefault();
              void unlock();
            }}
          >
            <p className={styles.lockText}>视奸日记需要希罗の咒语</p>
            <input
              ref={inputRef}
              type="password"
              className={styles.lockInput}
              value={keyInput}
              autoComplete="off"
              spellCheck={false}
              aria-label="希罗の咒语"
              onChange={(event) => {
                setKeyInput(event.target.value);
                setKeyError(null);
              }}
            />
            {keyError ? <p className={styles.lockError}>{keyError}</p> : null}
            <button
              type="submit"
              className={`${styles.button} ${styles.primary}`}
              disabled={checking || !keyInput.trim()}
            >
              {checking ? "正在念咒……" : "翻开日记"}
            </button>
          </form>
        )}
        {unlocked && !minimized ? (
          <button
            type="button"
            className={styles.foldClose}
            aria-label="合上日记"
            onClick={requestClose}
          >
            <span aria-hidden="true">✖</span>
          </button>
        ) : null}
      </div>
      {snapshot ? (
        <MosaicTransition
          imageUrl={snapshot.imageUrl}
          rect={snapshot.rect}
          onDone={finishSwitch}
        />
      ) : null}
    </div>
  );
}

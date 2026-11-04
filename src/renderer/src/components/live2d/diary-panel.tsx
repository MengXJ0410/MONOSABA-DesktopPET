"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DIARY_PASSPHRASE, DIARY_PASSPHRASE_HINT } from "@/content/live2d";
import { parseEntries } from "@/lib/diary/parse";
import type { DiaryPayload } from "../../../../shared/types";
import styles from "./diary-panel.module.css";

type Book = { name: string; size: number; mtime: number };

type DiaryPanelProps = {
  onClose: () => void;
  /** 独立日记窗口模式：卡片铺满窗口、标题栏可拖动。 */
  windowMode?: boolean;
  onSizeChange?: (size: { width: number; height: number }) => void;
};

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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

  const closeRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

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
    if (mountedRef.current) setChecking(false);
  }, [checking, keyInput, load]);

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
      onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const entries = useMemo(() => parseEntries(content), [content]);
  const meta = book ? `${formatSize(size)} · ${entries.length} 篇` : "";
  const locked = available === true && !unlocked;

  return (
    <div className={`${styles.overlay}${windowMode ? ` ${styles.windowMode}` : ""}`}>
      <div
        ref={cardRef}
        data-diary-card=""
        className={`${styles.card}${locked ? ` ${styles.locked}` : ""}${minimized ? ` ${styles.minimized}` : ""}`}
        role="dialog"
        aria-modal="false"
        aria-label="希罗的日记"
      >
        <header className={styles.header}>
          <span className={styles.title}>希罗的日记</span>
          {!minimized && unlocked && books.length > 1 ? (
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
          {!minimized && unlocked ? <span className={styles.meta}>{meta}</span> : null}
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
              onClick={onClose}
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
            <div className={styles.body}>
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
            </div>

            <footer className={styles.footer}>
              {truncated ? (
                <span className={styles.notice}>
                  超过 4MB，只显示最新部分。
                </span>
              ) : null}
              <button
                type="button"
                className={styles.button}
                disabled={loading}
                onClick={() => void load(book)}
              >
                {loading ? "读取中……" : "重新载入"}
              </button>
              <button type="button" className={styles.button} onClick={onClose}>
                合上日记
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
      </div>
    </div>
  );
}

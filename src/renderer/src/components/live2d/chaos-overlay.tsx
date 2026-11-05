"use client";

import { useEffect, useRef } from "react";
import styles from "./chaos-overlay.module.css";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const REPAINT_MS = 120;

/**
 * 篡改记忆时的「混沌」遮罩：以黑色为主的随机马赛克块，不断重绘制造抽搐感。
 * 用 canvas 而不是固定棋盘格，让每次刷新的块大小、位置、红黑比例都不一样。
 */
export function ChaosOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;

    const reduced = window.matchMedia(REDUCED_MOTION_QUERY).matches;
    let timer = 0;

    const paint = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (!width || !height) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const pixelWidth = Math.round(width * dpr);
      const pixelHeight = Math.round(height * dpr);
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      // 大面积黑底，只留少量缝隙透出下面的字。
      ctx.fillStyle = "rgba(5, 3, 3, 0.96)";
      ctx.fillRect(0, 0, width, height);

      const tile = 18;
      for (let y = 0; y < height; y += tile) {
        for (let x = 0; x < width; x += tile) {
          const roll = Math.random();
          if (roll < 0.035) continue;
          const jitterX = x + (Math.random() - 0.5) * tile * 0.7;
          const jitterY = y + (Math.random() - 0.5) * tile * 0.7;
          const blockWidth = tile * 0.55 + Math.random() * tile * 1.1;
          const blockHeight = tile * 0.55 + Math.random() * tile * 1.1;

          if (roll < 0.1) {
            // 暗红块
            ctx.fillStyle = `rgba(104, 0, 0, ${0.4 + Math.random() * 0.45})`;
          } else if (roll < 0.14) {
            // 少量亮红块
            ctx.fillStyle = `rgba(205, 0, 0, ${0.22 + Math.random() * 0.32})`;
          } else {
            // 绝大多数还是黑色块
            ctx.fillStyle = `rgba(${2 + Math.random() * 8}, 1, 1, ${
              0.9 + Math.random() * 0.1
            })`;
          }
          ctx.fillRect(jitterX, jitterY, blockWidth, blockHeight);
        }
      }

      // 几块纯黑补丁，压住细节，保证整体以黑为主。
      for (let i = 0; i < 7; i += 1) {
        ctx.fillStyle = "rgba(0, 0, 0, 0.97)";
        ctx.fillRect(
          Math.random() * width,
          Math.random() * height,
          36 + Math.random() * 96,
          28 + Math.random() * 72,
        );
      }
    };

    paint();
    if (!reduced) {
      timer = window.setInterval(paint, REPAINT_MS);
    }
    const observer = new ResizeObserver(paint);
    observer.observe(host);

    return () => {
      if (timer) window.clearInterval(timer);
      observer.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />;
}

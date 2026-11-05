"use client";

import { useEffect, useRef } from "react";

export type MosaicRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type MosaicTransitionProps = {
  /** 切换前截下的卡片画面。 */
  imageUrl: string;
  /** 卡片在视口里的位置。 */
  rect: MosaicRect;
  onDone: () => void;
};

/** 马赛克格子大小（CSS 像素）。 */
const CELL_CSS_PX = 16;
/** 从右下角开始扩散的基础时长。 */
const SPREAD_MS = 300;
/** 每块随机延迟，避免整排一起消失。 */
const JITTER_MS = 120;
const TOTAL_MS = 480;

/**
 * 日记 / 记忆切换的马赛克溶解：把截图铺成像素块，再按「离右下角越近越先消失」
 * 的顺序擦掉，露出下面的新内容。纯 canvas，不依赖第三方库。
 */
export function MosaicTransition({ imageUrl, rect, onDone }: MosaicTransitionProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      onDoneRef.current();
      return;
    }

    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      onDoneRef.current();
      return;
    }

    let raf = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      onDoneRef.current();
    };

    const image = new Image();
    image.onload = () => {
      if (finished) return;
      const cols = Math.max(1, Math.ceil(width / CELL_CSS_PX));
      const rows = Math.max(1, Math.ceil(height / CELL_CSS_PX));

      // 先缩到 cols×rows，再关掉平滑放大，得到一块一块的马赛克。
      const small = document.createElement("canvas");
      small.width = cols;
      small.height = rows;
      const smallCtx = small.getContext("2d");
      if (!smallCtx) {
        finish();
        return;
      }
      smallCtx.imageSmoothingEnabled = true;
      smallCtx.drawImage(image, 0, 0, cols, rows);

      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(small, 0, 0, canvas.width, canvas.height);

      // 每块的消失时间：以右下角为原点，加一点随机抖动。
      const delays = new Float32Array(cols * rows);
      const maxDistance = Math.SQRT2;
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const dx = (cols - 1 - col) / Math.max(1, cols - 1);
          const dy = (rows - 1 - row) / Math.max(1, rows - 1);
          const distance = Math.sqrt(dx * dx + dy * dy) / maxDistance;
          delays[row * cols + col] =
            distance * SPREAD_MS + Math.random() * JITTER_MS;
        }
      }

      const cleared = new Uint8Array(cols * rows);
      const blockWidth = canvas.width / cols;
      const blockHeight = canvas.height / rows;
      const startedAt = performance.now();

      const tick = (now: number) => {
        const elapsed = now - startedAt;
        for (let row = 0; row < rows; row += 1) {
          for (let col = 0; col < cols; col += 1) {
            const index = row * cols + col;
            if (cleared[index]) continue;
            if (elapsed < delays[index]) continue;
            cleared[index] = 1;
            ctx.clearRect(
              col * blockWidth,
              row * blockHeight,
              blockWidth + 1,
              blockHeight + 1,
            );
          }
        }
        if (elapsed < TOTAL_MS) {
          raf = window.requestAnimationFrame(tick);
        } else {
          finish();
        }
      };
      raf = window.requestAnimationFrame(tick);
    };
    image.onerror = finish;
    image.src = imageUrl;

    return () => {
      finished = true;
      window.cancelAnimationFrame(raf);
    };
  }, [imageUrl, rect.height, rect.width]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "fixed",
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        zIndex: 90,
        pointerEvents: "none",
      }}
    />
  );
}

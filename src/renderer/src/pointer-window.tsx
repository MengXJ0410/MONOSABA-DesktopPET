import { useEffect, useRef } from "react";
import type { PointerUpdate } from "../../shared/types";
import { decodeAni, type AniCursor } from "./lib/pointer/ani";

/**
 * 第二指针的渲染页（?view=pointer）。
 *
 * 主进程为每块屏幕建一个透明置顶窗口；窗口只负责画光标，
 * 位置和大小由 `pointer:update` 推过来，相对当前显示器左上角。
 * 页面本身永远不接收鼠标（窗口层 setIgnoreMouseEvents）。
 */
export function PointerWindow() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cursorRef = useRef<AniCursor | null>(null);
  const lastUpdateRef = useRef<PointerUpdate | null>(null);

  useEffect(() => {
    let cancelled = false;
    let frameTimer: number | null = null;
    let stepIndex = 0;

    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const context = canvas.getContext("2d");

    const applyPosition = () => {
      const cursor = cursorRef.current;
      const update = lastUpdateRef.current;
      if (!cursor || !update) return;
      if (!update.visible) {
        wrap.style.display = "none";
        return;
      }
      // size 是光标在 CSS 像素下的宽度；按帧尺寸等比缩放，热点也跟着缩放。
      const size = Math.max(8, update.size > 0 ? update.size : cursor.width);
      const scale = size / cursor.width;
      wrap.style.display = "block";
      wrap.style.transform = `translate3d(${update.x - cursor.hotspotX * scale}px, ${update.y - cursor.hotspotY * scale}px, 0)`;
      canvas.style.width = `${size}px`;
      canvas.style.height = `${(size / cursor.width) * cursor.height}px`;
    };

    const drawFrame = () => {
      if (cancelled) return;
      const cursor = cursorRef.current;
      if (!cursor || !context) return;
      const step = cursor.steps[stepIndex % cursor.steps.length];
      stepIndex = (stepIndex + 1) % cursor.steps.length;
      if (step.frame.width !== canvas.width || step.frame.height !== canvas.height) {
        canvas.width = step.frame.width;
        canvas.height = step.frame.height;
        applyPosition();
      }
      context.putImageData(
        new ImageData(
          new Uint8ClampedArray(step.frame.rgba),
          step.frame.width,
          step.frame.height,
        ),
        0,
        0,
      );
      frameTimer = window.setTimeout(drawFrame, step.durationMs);
    };

    const load = async () => {
      const response = await fetch("cursors/hiro/Normal.ani");
      if (!response.ok) throw new Error(`加载光标皮肤失败：${response.status}`);
      const buffer = await response.arrayBuffer();
      if (cancelled) return;
      const cursor = decodeAni(buffer);
      cursorRef.current = cursor;
      canvas.width = cursor.width;
      canvas.height = cursor.height;
      applyPosition();
      drawFrame();
    };

    void load().catch((error: unknown) => {
      console.error("[pointer] load cursor failed", error);
    });

    const off = window.petApi?.onPointerUpdate?.((update) => {
      lastUpdateRef.current = update;
      applyPosition();
    });

    return () => {
      cancelled = true;
      if (frameTimer) window.clearTimeout(frameTimer);
      off?.();
    };
  }, []);

  return (
    <div ref={wrapRef} className="pointer-cursor" aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}

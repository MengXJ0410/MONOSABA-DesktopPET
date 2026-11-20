import { nativeImage } from "electron";

/**
 * 32×18 灰度缩略图指纹：只用于判断“画面是否发生了大的变化”。
 *
 * 随机点评用它决定要不要暂停，AI 指针用它决定要不要惊动模型；
 * 两边共用同一套算法，阈值各自独立（点评约 20%，指针约 8%）。
 */
export function screenFingerprint(dataUrl: string): string | null {
  try {
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) return null;
    const size = image.getSize();
    if (size.width <= 0 || size.height <= 0) return null;
    // 去掉底部约 8% 的任务栏（时钟每分钟变化会干扰比较）。
    const cropHeight = Math.max(
      1,
      Math.round(size.height - Math.min(72, size.height * 0.08)),
    );
    const cropped = image.crop({
      x: 0,
      y: 0,
      width: size.width,
      height: cropHeight,
    });
    const small = cropped.resize({ width: 32, height: 18, quality: "good" });
    const bitmap = small.toBitmap();
    const gray: number[] = [];
    for (let i = 0; i + 3 < bitmap.length; i += 4) {
      // BGRA
      gray.push(bitmap[i] * 0.114 + bitmap[i + 1] * 0.587 + bitmap[i + 2] * 0.299);
    }
    if (gray.length === 0) return null;
    const average = gray.reduce((sum, value) => sum + value, 0) / gray.length;
    return gray.map((value) => (value >= average ? "1" : "0")).join("");
  } catch {
    return null;
  }
}

/** 两个等长指纹之间不同位的数量。 */
export function fingerprintDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) distance += 1;
  }
  return distance;
}

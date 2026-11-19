/**
 * Windows 动画光标（.ani）解码。
 *
 * ANI 是 RIFF 容器：`anih` 头 + 可选的 `rate` / `seq` + `LIST fram` 里的若干 `icon`。
 * 每个 `icon` 就是一段 ICO：ICONDIR + 一条 ICONDIRENTRY + 图像。
 * 本项目的皮肤（temp/skin/Normal.ani）用的是 32×32、8bpp 索引色 + AND 掩码，
 * 这里同时支持 24bpp / 32bpp，方便以后换皮。
 *
 * Chromium 不能直接渲染 .ani / 索引色 ICO，所以由渲染层自己解成 RGBA 帧。
 */
export type AniFrame = {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
};

export type AniStep = {
  frame: AniFrame;
  durationMs: number;
};

export type AniCursor = {
  width: number;
  height: number;
  /** 热点（箭头尖）在帧内的像素坐标。 */
  hotspotX: number;
  hotspotY: number;
  steps: AniStep[];
};

type AniHeader = {
  frames: number;
  steps: number;
  rate: number;
};

type DecodedIcon = {
  frame: AniFrame;
  hotspotX: number;
  hotspotY: number;
};

function fourCC(bytes: Uint8Array, offset: number): string {
  if (offset + 4 > bytes.length) return "";
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

function readAniHeader(view: DataView, offset: number, size: number): AniHeader | null {
  if (size < 36) return null;
  return {
    frames: view.getUint32(offset + 4, true),
    steps: view.getUint32(offset + 8, true),
    rate: view.getUint32(offset + 28, true),
  };
}

/** 解一帧 ICO：优先 PNG 帧（直接标记不支持），否则按 BMP 处理。 */
function decodeIcon(
  bytes: Uint8Array,
  base: number,
  length: number,
): DecodedIcon | null {
  if (length < 22) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(base, true) !== 0) return null;
  const type = view.getUint16(base + 2, true);
  if (type !== 1 && type !== 2) return null;
  const count = view.getUint16(base + 4, true);
  if (count < 1) return null;

  const entry = base + 6;
  // ANI 把热点写在 ICO 目录项的 wPlanes / wBitCount 位置。
  const hotspotX = view.getUint16(entry + 4, true);
  const hotspotY = view.getUint16(entry + 6, true);
  const imageSize = view.getUint32(entry + 8, true);
  const imageOffset = view.getUint32(entry + 12, true);
  if (imageOffset + imageSize > length) return null;

  const image = base + imageOffset;
  // PNG 帧：当前皮肤没有，先明确报错，避免静默画出空白。
  if (
    bytes[image] === 0x89 &&
    bytes[image + 1] === 0x50 &&
    bytes[image + 2] === 0x4e &&
    bytes[image + 3] === 0x47
  ) {
    throw new Error("暂不支持 PNG 帧的 .ani 皮肤");
  }

  const frame = decodeBmpFrame(bytes, image, imageSize);
  if (!frame) return null;
  return { frame, hotspotX, hotspotY };
}

function decodeBmpFrame(
  bytes: Uint8Array,
  offset: number,
  size: number,
): AniFrame | null {
  if (size < 40) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = view.getUint32(offset, true);
  if (headerSize < 40 || headerSize > size) return null;

  const width = view.getInt32(offset + 4, true);
  const rawHeight = view.getInt32(offset + 8, true);
  const bitCount = view.getUint16(offset + 14, true);
  const compression = view.getUint32(offset + 16, true);
  if (width <= 0 || width > 1024 || rawHeight === 0 || compression !== 0) {
    return null;
  }

  const topDown = rawHeight < 0;
  const height = Math.floor(Math.abs(rawHeight) / 2);
  if (height <= 0 || height > 1024) return null;
  if (bitCount !== 8 && bitCount !== 24 && bitCount !== 32) return null;

  const colors = view.getUint32(offset + 32, true) || (bitCount === 8 ? 256 : 0);
  const paletteOffset = offset + headerSize;
  const pixelOffset = paletteOffset + colors * 4;
  const rowStride = Math.floor((width * bitCount + 31) / 32) * 4;
  const maskOffset = pixelOffset + rowStride * height;
  const maskStride = Math.floor((width + 31) / 32) * 4;
  const hasMask = maskOffset + maskStride * height <= offset + size;
  if (pixelOffset + rowStride * height > offset + size) return null;

  // 调色板是 BGR0。
  const palette = new Uint8Array(colors * 4);
  for (let i = 0; i < colors; i += 1) {
    const p = paletteOffset + i * 4;
    if (p + 4 > offset + size) return null;
    palette[i * 4] = bytes[p];
    palette[i * 4 + 1] = bytes[p + 1];
    palette[i * 4 + 2] = bytes[p + 2];
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceRow = topDown ? y : height - 1 - y;
    const pixelRow = pixelOffset + sourceRow * rowStride;
    const maskRow = maskOffset + sourceRow * maskStride;
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;

      if (bitCount === 8) {
        const index = bytes[pixelRow + x];
        r = palette[index * 4 + 2];
        g = palette[index * 4 + 1];
        b = palette[index * 4];
      } else if (bitCount === 24) {
        const p = pixelRow + x * 3;
        b = bytes[p];
        g = bytes[p + 1];
        r = bytes[p + 2];
      } else {
        const p = pixelRow + x * 4;
        b = bytes[p];
        g = bytes[p + 1];
        r = bytes[p + 2];
        a = bytes[p + 3];
      }

      // AND 掩码：1 = 透明。32bpp 优先用像素自带 alpha。
      if (hasMask) {
        const bit = (bytes[maskRow + (x >> 3)] >> (7 - (x & 7))) & 1;
        if (bit === 1) a = 0;
        else if (bitCount === 32 && a === 0) a = 255;
      }

      rgba[out] = r;
      rgba[out + 1] = g;
      rgba[out + 2] = b;
      rgba[out + 3] = a;
    }
  }

  return { width, height, rgba };
}

export function decodeAni(buffer: ArrayBuffer): AniCursor {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 12) throw new Error("ANI 文件太短");
  const view = new DataView(buffer);
  if (fourCC(bytes, 0) !== "RIFF" || fourCC(bytes, 8) !== "ACON") {
    throw new Error("不是 ANI 文件");
  }

  const riffEnd = Math.min(bytes.length, 8 + view.getUint32(4, true));
  let header: AniHeader | null = null;
  let rates: number[] = [];
  let sequence: number[] = [];
  const icons: DecodedIcon[] = [];
  let inFram = false;
  let pos = 12;

  while (pos + 8 <= riffEnd) {
    const id = fourCC(bytes, pos);
    const size = view.getUint32(pos + 4, true);
    const data = pos + 8;
    if (data + size > riffEnd + 8) break;
    if (size === 0) break;

    if (id === "LIST") {
      inFram = fourCC(bytes, data) === "fram";
      pos = data + 4;
      continue;
    }
    if (id === "RIFF") {
      pos = data + 4;
      continue;
    }
    if (id === "anih") {
      header = readAniHeader(view, data, size);
    } else if (id === "rate") {
      const count = Math.floor(size / 4);
      rates = [];
      for (let i = 0; i < count; i += 1) {
        rates.push(view.getUint32(data + i * 4, true));
      }
    } else if (id === "seq ") {
      sequence = Array.from(bytes.subarray(data, data + size));
    } else if (id === "icon" && inFram) {
      const icon = decodeIcon(bytes, data, size);
      if (icon) icons.push(icon);
    }
    pos = data + size + (size & 1);
  }

  if (icons.length === 0) throw new Error("ANI 里没有可用帧");

  const stepCount = header?.steps && header.steps > 0 ? header.steps : icons.length;
  const defaultRate = header?.rate && header.rate > 0 ? header.rate : 6;
  const order =
    sequence.length >= stepCount
      ? sequence.slice(0, stepCount)
      : Array.from({ length: stepCount }, (_, index) => index % icons.length);

  const steps: AniStep[] = order.map((frameIndex, index) => {
    const icon = icons[frameIndex % icons.length];
    const jiffies = rates[index] ?? defaultRate;
    return {
      frame: icon.frame,
      // ANI 的 rate 单位是 1/60 秒。
      durationMs: Math.max(16, Math.round((jiffies > 0 ? jiffies : defaultRate) * 1000 / 60)),
    };
  });

  const first = icons[0];
  return {
    width: first.frame.width,
    height: first.frame.height,
    hotspotX: first.hotspotX,
    hotspotY: first.hotspotY,
    steps,
  };
}

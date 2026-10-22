// Image caps: crop and downscale captures before encoding, and shrink any
// oversized PNG a tool returns. The plugin already downscales in Studio when
// told `maxPx`; this is the server-side guarantee (host-OS capture, older
// plugins, crops).
import { decodePngToRgba } from '../image-decode.js';
import { rgbaToPng } from '../png-encoder.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CaptureBudget {
  /** Longest side of the final image; 0 = no downscale. */
  maxPx: number;
  /** Region to keep, in viewport pixels. */
  crop?: Rect;
  /** Viewport size the crop was resolved against, when known. */
  viewport?: { width: number; height: number };
}

/** The fields of a raw capture response this module reads and rewrites. */
export interface CaptureLike {
  encoding?: string;
  data?: string;
  width?: number;
  height?: number;
  nativeWidth?: number;
  nativeHeight?: number;
  error?: string;
  /** Set once the fork has cropped the frame: the kept region in viewport px. */
  crop?: Rect;
}

export interface ImageInfo {
  w: number;
  h: number;
  bytes: number;
}

const MAX_PLUGIN_FRAME_PX = 4096;

export function parseRect(text: string): Rect | undefined {
  const parts = text.split(',').map((part) => part.trim());
  if (parts.length !== 4 || parts.some((part) => !/^-?\d+(\.\d+)?$/.test(part))) return undefined;
  const [x, y, w, h] = parts.map(Number);
  return w > 0 && h > 0 ? { x, y, w, h } : undefined;
}

/**
 * Longest frame side the plugin may capture at: small enough to save transfer,
 * large enough that a crop still has maxPx pixels after it is cut out.
 */
export function pluginFrameMaxPx(budget: CaptureBudget): number | undefined {
  if (budget.maxPx <= 0) return undefined;
  if (!budget.crop) return budget.maxPx;
  if (!budget.viewport) return undefined;
  const frame = Math.max(budget.viewport.width, budget.viewport.height);
  const region = Math.max(budget.crop.w, budget.crop.h);
  return Math.min(MAX_PLUGIN_FRAME_PX, Math.ceil(budget.maxPx * frame / region));
}

export function cropRgba(rgba: Buffer, width: number, rect: Rect): Buffer {
  const out = Buffer.alloc(rect.w * rect.h * 4);
  for (let row = 0; row < rect.h; row++) {
    const start = ((rect.y + row) * width + rect.x) * 4;
    rgba.copy(out, row * rect.w * 4, start, start + rect.w * 4);
  }
  return out;
}

/** Area-average downscale so the longest side is at most maxPx. */
export function downscaleRgba(rgba: Buffer, width: number, height: number, maxPx: number): { rgba: Buffer; width: number; height: number } {
  const longest = Math.max(width, height);
  if (maxPx <= 0 || longest <= maxPx) return { rgba, width, height };
  const scale = maxPx / longest;
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const out = Buffer.alloc(outW * outH * 4);
  const xStep = width / outW;
  const yStep = height / outH;
  for (let oy = 0; oy < outH; oy++) {
    const y0 = Math.floor(oy * yStep);
    const y1 = Math.max(y0 + 1, Math.min(height, Math.floor((oy + 1) * yStep)));
    for (let ox = 0; ox < outW; ox++) {
      const x0 = Math.floor(ox * xStep);
      const x1 = Math.max(x0 + 1, Math.min(width, Math.floor((ox + 1) * xStep)));
      let r = 0, g = 0, b = 0, a = 0;
      for (let y = y0; y < y1; y++) {
        let i = (y * width + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) {
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
          a += rgba[i + 3];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (oy * outW + ox) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { rgba: out, width: outW, height: outH };
}

function clampRect(rect: Rect, width: number, height: number): Rect | undefined {
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const right = Math.min(width, Math.round(rect.x + rect.w));
  const bottom = Math.min(height, Math.round(rect.y + rect.h));
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : undefined;
}

/** Crops and downscales a successful capture response; returns it as rgba8. */
export function applyCaptureBudget<T extends CaptureLike>(response: T, budget: CaptureBudget): T & CaptureLike {
  if (response.error || !response.data || response.width === undefined || response.height === undefined) return response;
  const nativeW = response.nativeWidth ?? response.width;
  const nativeH = response.nativeHeight ?? response.height;
  const oversized = budget.maxPx > 0 && Math.max(response.width, response.height) > budget.maxPx;
  if (!budget.crop && !oversized) return response;

  let width = response.width;
  let height = response.height;
  let rgba: Buffer;
  if (response.encoding === 'png') {
    let decoded: ReturnType<typeof decodePngToRgba>;
    try {
      decoded = decodePngToRgba(Buffer.from(response.data, 'base64'));
    } catch (error) {
      // Over the decoder's pixel limit: send the PNG as is, unless a crop was asked for.
      if (!budget.crop) return response;
      return { ...response, data: undefined, error: `cannot crop this PNG capture (${error instanceof Error ? error.message : String(error)}); use format jpeg` };
    }
    ({ width, height } = decoded);
    rgba = decoded.rgba;
  } else {
    rgba = Buffer.from(response.data, 'base64');
  }

  let crop: Rect | undefined;
  if (budget.crop) {
    crop = clampRect(budget.crop, nativeW, nativeH);
    if (!crop) {
      return { ...response, data: undefined, error: `crop ${budget.crop.x},${budget.crop.y},${budget.crop.w},${budget.crop.h} is outside the ${nativeW}x${nativeH} viewport` };
    }
    const sx = width / nativeW;
    const sy = height / nativeH;
    const inImage = clampRect({ x: crop.x * sx, y: crop.y * sy, w: crop.w * sx, h: crop.h * sy }, width, height)
      ?? { x: Math.min(width - 1, Math.floor(crop.x * sx)), y: Math.min(height - 1, Math.floor(crop.y * sy)), w: 1, h: 1 };
    rgba = cropRgba(rgba, width, inImage);
    width = inImage.w;
    height = inImage.h;
  }

  const scaled = downscaleRgba(rgba, width, height, budget.maxPx);
  return {
    ...response,
    encoding: 'rgba8',
    data: scaled.rgba.toString('base64'),
    width: scaled.width,
    height: scaled.height,
    ...(crop ? { crop } : {}),
  };
}

/** Width and height from a PNG or JPEG header; undefined for other data. */
export function imageSize(data: Buffer): { w: number; h: number } | undefined {
  if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47 && data.toString('ascii', 12, 16) === 'IHDR') {
    return { w: data.readUInt32BE(16), h: data.readUInt32BE(20) };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) return undefined;
      const marker = data[offset + 1];
      const length = data.readUInt16BE(offset + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return { w: data.readUInt16BE(offset + 7), h: data.readUInt16BE(offset + 5) };
      offset += 2 + length;
    }
  }
  return undefined;
}

type ImageBlock = { type: 'image'; data: string; mimeType: string };

function isImage(block: unknown): block is ImageBlock {
  return !!block && typeof block === 'object' && (block as ImageBlock).type === 'image' && typeof (block as ImageBlock).data === 'string';
}

/**
 * Last pass over a result's image blocks: PNGs larger than maxPx are decoded,
 * downscaled and re-encoded as PNG. JPEGs cannot be decoded here, so they are
 * only measured. Returns the new content and each image's final size.
 */
export function shrinkImageBlocks<T>(content: T[], maxPx: number): { content: T[]; images: ImageInfo[] } {
  const images: ImageInfo[] = [];
  const out = content.map((block) => {
    if (!isImage(block)) return block;
    let data: Buffer = Buffer.from(block.data, 'base64');
    let size = imageSize(data);
    if (maxPx > 0 && size && Math.max(size.w, size.h) > maxPx && block.mimeType === 'image/png') {
      try {
        const decoded = decodePngToRgba(data);
        const scaled = downscaleRgba(decoded.rgba, decoded.width, decoded.height, maxPx);
        data = rgbaToPng(scaled.rgba, scaled.width, scaled.height);
        size = { w: scaled.width, h: scaled.height };
        block = { ...block, data: data.toString('base64') };
      } catch {
        // Undecodable PNG variant: send as is, metrics still record its size.
      }
    }
    images.push({ w: size?.w ?? 0, h: size?.h ?? 0, bytes: data.length });
    return block;
  });
  return { content: out, images };
}

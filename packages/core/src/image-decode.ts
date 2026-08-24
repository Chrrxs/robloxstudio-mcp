import * as fs from 'fs';
import * as path from 'path';
import { inflateSync } from 'zlib';

export type DecodedRgbaImage = {
  width: number;
  height: number;
  rgba: Buffer;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_EDITABLE_IMAGE_DIMENSION = 1024;

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function bytesPerPixel(colorType: number): number {
  if (colorType === 6) return 4; // RGBA
  if (colorType === 2) return 3; // RGB
  if (colorType === 0) return 1; // grayscale
  if (colorType === 4) return 2; // grayscale + alpha
  throw new Error(`Unsupported PNG color type ${colorType}. Supported color types: 0, 2, 4, 6.`);
}

function convertScanlinesToRgba(raw: Buffer, width: number, height: number, colorType: number, bpp: number): Buffer {
  const stride = width * bpp;
  const expected = height * (stride + 1);
  if (raw.length < expected) {
    throw new Error(`PNG data ended early. Expected ${expected} bytes after inflate, got ${raw.length}.`);
  }

  const unfiltered = Buffer.alloc(width * height * bpp);
  let srcOffset = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[srcOffset++];
    const rowOffset = y * stride;
    const prevRowOffset = (y - 1) * stride;

    for (let x = 0; x < stride; x++) {
      const value = raw[srcOffset++];
      const left = x >= bpp ? unfiltered[rowOffset + x - bpp] : 0;
      const up = y > 0 ? unfiltered[prevRowOffset + x] : 0;
      const upLeft = y > 0 && x >= bpp ? unfiltered[prevRowOffset + x - bpp] : 0;

      let decoded: number;
      if (filter === 0) {
        decoded = value;
      } else if (filter === 1) {
        decoded = value + left;
      } else if (filter === 2) {
        decoded = value + up;
      } else if (filter === 3) {
        decoded = value + Math.floor((left + up) / 2);
      } else if (filter === 4) {
        decoded = value + paethPredictor(left, up, upLeft);
      } else {
        throw new Error(`Unsupported PNG filter type ${filter}.`);
      }

      unfiltered[rowOffset + x] = decoded & 0xff;
    }
  }

  if (colorType === 6) return unfiltered;

  const rgba = Buffer.alloc(width * height * 4);
  let si = 0;
  let di = 0;
  for (let i = 0; i < width * height; i++) {
    if (colorType === 2) {
      rgba[di++] = unfiltered[si++];
      rgba[di++] = unfiltered[si++];
      rgba[di++] = unfiltered[si++];
      rgba[di++] = 255;
    } else if (colorType === 0) {
      const gray = unfiltered[si++];
      rgba[di++] = gray;
      rgba[di++] = gray;
      rgba[di++] = gray;
      rgba[di++] = 255;
    } else {
      const gray = unfiltered[si++];
      const alpha = unfiltered[si++];
      rgba[di++] = gray;
      rgba[di++] = gray;
      rgba[di++] = gray;
      rgba[di++] = alpha;
    }
  }
  return rgba;
}

function resizeRgbaNearest(image: DecodedRgbaImage): DecodedRgbaImage {
  const longest = Math.max(image.width, image.height);
  if (longest <= MAX_EDITABLE_IMAGE_DIMENSION) return image;

  const scale = MAX_EDITABLE_IMAGE_DIMENSION / longest;
  const width = Math.max(1, Math.floor(image.width * scale));
  const height = Math.max(1, Math.floor(image.height * scale));
  const rgba = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    const sy = Math.min(image.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.floor(x / scale));
      const src = (sy * image.width + sx) * 4;
      const dst = (y * width + x) * 4;
      rgba[dst] = image.rgba[src];
      rgba[dst + 1] = image.rgba[src + 1];
      rgba[dst + 2] = image.rgba[src + 2];
      rgba[dst + 3] = image.rgba[src + 3];
    }
  }

  return { width, height, rgba };
}

export function decodePngToRgba(data: Buffer): DecodedRgbaImage {
  if (data.length < PNG_SIGNATURE.length || !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('Unsupported image format. generate_model currently supports PNG images.');
  }

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks: Buffer[] = [];

  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + length;
    if (chunkEnd + 4 > data.length) throw new Error(`Invalid PNG chunk length for ${type}.`);

    const chunk = data.subarray(chunkStart, chunkEnd);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
      const compression = chunk[10];
      const filter = chunk[11];
      interlace = chunk[12];
      if (compression !== 0 || filter !== 0) throw new Error('Unsupported PNG compression/filter method.');
    } else if (type === 'IDAT') {
      idatChunks.push(chunk);
    } else if (type === 'IEND') {
      break;
    }

    offset = chunkEnd + 4;
  }

  if (width <= 0 || height <= 0) throw new Error('PNG is missing a valid IHDR chunk.');
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth}. Only 8-bit PNG images are supported.`);
  if (interlace !== 0) throw new Error('Interlaced PNG images are not supported.');
  if (idatChunks.length === 0) throw new Error('PNG is missing image data.');

  const bpp = bytesPerPixel(colorType);
  const raw = inflateSync(Buffer.concat(idatChunks));
  const rgba = convertScanlinesToRgba(raw, width, height, colorType, bpp);
  return resizeRgbaNearest({ width, height, rgba });
}

export function decodeImagePathToRgba(imagePath: string): DecodedRgbaImage {
  const resolved = path.resolve(imagePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`image_path not found: ${imagePath}`);
  }
  return decodePngToRgba(fs.readFileSync(resolved));
}

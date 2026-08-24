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
// Decode runs synchronously and temporarily holds compressed, inflated, and unfiltered
// buffers together. These bounds keep request work finite while still admitting UHD 4K images.
const MAX_PNG_DIMENSION = 16 * 1024;
const MAX_PNG_PIXELS = 8 * 1024 * 1024;
const MAX_PNG_INPUT_BYTES = 32 * 1024 * 1024;
export const MAX_PNG_BASE64_CHARACTERS = 4 * Math.ceil(MAX_PNG_INPUT_BYTES / 3);
const MAX_PNG_CHUNK_BYTES = 32 * 1024 * 1024;
const MAX_PNG_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_PNG_CHUNKS = 65_536;
const MAX_PNG_INFLATED_BYTES = MAX_PNG_PIXELS * 4 + MAX_PNG_DIMENSION;

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

function validatePngInputSize(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error(`Invalid PNG input length ${byteLength}.`);
  }
  if (byteLength > MAX_PNG_INPUT_BYTES) {
    throw new Error(
      `PNG input length ${byteLength} exceeds the ${MAX_PNG_INPUT_BYTES}-byte limit.`,
    );
  }
}

function getBase64DecodedLength(encoded: string): number {
  if (encoded.length > MAX_PNG_BASE64_CHARACTERS) {
    throw new Error(
      `PNG base64 length ${encoded.length} exceeds the ${MAX_PNG_BASE64_CHARACTERS}-character limit.`,
    );
  }

  let padding = 0;
  if (encoded.endsWith('=')) padding++;
  if (encoded.endsWith('==')) padding++;
  const contentLength = encoded.length - padding;
  const remainder = contentLength % 4;
  if (
    remainder === 1
    || (padding > 0 && encoded.length % 4 !== 0)
    || (padding === 1 && remainder !== 3)
    || (padding === 2 && remainder !== 2)
  ) {
    throw new Error('Invalid PNG base64 data.');
  }

  const decodedLength = Math.floor(contentLength / 4) * 3
    + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0);
  validatePngInputSize(decodedLength);

  for (let index = 0; index < contentLength; index++) {
    const code = encoded.charCodeAt(index);
    const isAlphaNumeric = (
      (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a)
      || (code >= 0x30 && code <= 0x39)
    );
    if (!isAlphaNumeric && code !== 0x2b && code !== 0x2f) {
      throw new Error('Invalid PNG base64 data.');
    }
  }

  return decodedLength;
}

function readPngFileWithinLimit(resolved: string, imagePath: string): Buffer {
  let descriptor: number;
  try {
    // Avoid blocking on a FIFO before fstat can reject non-regular inputs.
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);
    descriptor = fs.openSync(resolved, flags);
  } catch (error) {
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      throw new Error(`image_path not found: ${imagePath}`);
    }
    throw error;
  }

  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new Error(`image_path must reference a regular file: ${imagePath}`);
    }
    validatePngInputSize(stats.size);

    // The sentinel byte detects growth after fstat without allowing an unbounded read.
    const data = Buffer.allocUnsafe(stats.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const bytesRead = fs.readSync(
        descriptor,
        data,
        offset,
        data.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== stats.size) {
      validatePngInputSize(offset);
      throw new Error(`image_path size changed while reading: ${imagePath}`);
    }
    return data.subarray(0, offset);
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateSourceDimensions(width: number, height: number): void {
  if (width <= 0 || height <= 0) {
    throw new Error('PNG IHDR dimensions must be positive.');
  }
  if (width > MAX_PNG_DIMENSION || height > MAX_PNG_DIMENSION) {
    throw new Error(
      `PNG dimensions ${width}x${height} exceed the ${MAX_PNG_DIMENSION}-pixel dimension limit.`,
    );
  }

  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_PNG_PIXELS) {
    throw new Error(
      `PNG pixel count ${pixelCount} exceeds the ${MAX_PNG_PIXELS}-pixel limit.`,
    );
  }
}

function getExpectedScanlineLength(width: number, height: number, bpp: number): number {
  const stride = width * bpp;
  const expected = height * (stride + 1);
  if (
    !Number.isSafeInteger(stride)
    || !Number.isSafeInteger(expected)
    || expected > MAX_PNG_INFLATED_BYTES
  ) {
    throw new Error(
      `PNG scanline data length ${expected} exceeds the ${MAX_PNG_INFLATED_BYTES}-byte limit.`,
    );
  }
  return expected;
}

function convertScanlinesToRgba(
  raw: Buffer,
  width: number,
  height: number,
  colorType: number,
  bpp: number,
  expectedLength: number,
): Buffer {
  const stride = width * bpp;
  if (raw.length !== expectedLength) {
    if (raw.length > expectedLength) {
      throw new Error(
        `Inflated PNG data exceeds the expected scanline length of ${expectedLength} bytes.`,
      );
    }
    throw new Error(
      `PNG data ended early. Expected ${expectedLength} bytes after inflate, got ${raw.length}.`,
    );
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
  validatePngInputSize(data.length);
  if (data.length < PNG_SIGNATURE.length || !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('Unsupported image format. generate_model currently supports PNG images.');
  }

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bpp = 0;
  let expectedScanlineLength = 0;
  let sawIhdr = false;
  let sawIend = false;
  let chunkCount = 0;
  let idatLength = 0;
  const idatChunks: Buffer[] = [];

  while (offset < data.length) {
    if (data.length - offset < 12) {
      throw new Error('PNG ended with a truncated chunk header.');
    }

    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    if (length > MAX_PNG_CHUNK_BYTES) {
      throw new Error(
        `PNG chunk ${type} length ${length} exceeds the ${MAX_PNG_CHUNK_BYTES}-byte chunk limit.`,
      );
    }
    if (++chunkCount > MAX_PNG_CHUNKS) {
      throw new Error(`PNG contains more than the ${MAX_PNG_CHUNKS}-chunk limit.`);
    }

    const chunkStart = offset + 8;
    if (length > data.length - chunkStart - 4) {
      throw new Error(`Invalid PNG chunk length for ${type}.`);
    }
    const chunkEnd = chunkStart + length;
    const chunk = data.subarray(chunkStart, chunkEnd);
    offset = chunkEnd + 4;

    if (!sawIhdr && type !== 'IHDR') {
      throw new Error('PNG IHDR chunk must be the first chunk.');
    }

    if (type === 'IHDR') {
      if (sawIhdr) throw new Error('PNG contains more than one IHDR chunk.');
      if (length !== 13) throw new Error('PNG IHDR chunk must be exactly 13 bytes.');

      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      const bitDepth = chunk[8];
      colorType = chunk[9];
      const compression = chunk[10];
      const filter = chunk[11];
      const interlace = chunk[12];

      if (compression !== 0 || filter !== 0) {
        throw new Error('Unsupported PNG compression/filter method.');
      }
      if (bitDepth !== 8) {
        throw new Error(`Unsupported PNG bit depth ${bitDepth}. Only 8-bit PNG images are supported.`);
      }
      if (interlace !== 0) throw new Error('Interlaced PNG images are not supported.');

      bpp = bytesPerPixel(colorType);
      validateSourceDimensions(width, height);
      expectedScanlineLength = getExpectedScanlineLength(width, height, bpp);
      sawIhdr = true;
    } else if (type === 'IDAT') {
      if (length > MAX_PNG_COMPRESSED_BYTES - idatLength) {
        throw new Error(
          `PNG image data exceeds the ${MAX_PNG_COMPRESSED_BYTES}-byte compressed-data limit.`,
        );
      }
      idatLength += length;
      idatChunks.push(chunk);
    } else if (type === 'IEND') {
      if (length !== 0) throw new Error('PNG IEND chunk must be empty.');
      sawIend = true;
      break;
    }
  }

  if (!sawIhdr) throw new Error('PNG is missing a valid IHDR chunk.');
  if (!sawIend) throw new Error('PNG is missing an IEND chunk.');
  if (idatChunks.length === 0) throw new Error('PNG is missing image data.');

  const compressed = idatChunks.length === 1
    ? idatChunks[0]
    : Buffer.concat(idatChunks, idatLength);
  let raw: Buffer;
  try {
    raw = inflateSync(compressed, { maxOutputLength: expectedScanlineLength });
  } catch (error) {
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'ERR_BUFFER_TOO_LARGE'
    ) {
      throw new Error(
        `Inflated PNG data exceeds the expected scanline length of ${expectedScanlineLength} bytes.`,
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid PNG compressed data: ${detail}`);
  }

  const rgba = convertScanlinesToRgba(
    raw,
    width,
    height,
    colorType,
    bpp,
    expectedScanlineLength,
  );
  return resizeRgbaNearest({ width, height, rgba });
}

export function decodePngBase64ToRgba(encoded: string): DecodedRgbaImage {
  const expectedLength = getBase64DecodedLength(encoded);
  const data = Buffer.from(encoded, 'base64');
  if (data.length !== expectedLength) {
    throw new Error('Invalid PNG base64 data.');
  }
  return decodePngToRgba(data);
}

export function decodeImagePathToRgba(imagePath: string): DecodedRgbaImage {
  const resolved = path.resolve(imagePath);
  return decodePngToRgba(readPngFileWithinLimit(resolved, imagePath));
}

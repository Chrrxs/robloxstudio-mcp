import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { deflateSync } from 'zlib';
import {
  decodeImagePathToRgba,
  decodePngBase64ToRgba,
  decodePngToRgba,
} from '../image-decode.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, data, Buffer.alloc(4)]);
}

function rgbaIhdr(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return ihdr;
}

function rgbaPngWithIdat(width: number, height: number, idat: Buffer): Buffer {
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', rgbaIhdr(width, height)),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function rgbaPng(width: number, height: number, scanlines: Buffer): Buffer {
  return rgbaPngWithIdat(width, height, deflateSync(scanlines));
}

describe('decodePngToRgba', () => {
  test('rejects inflated data larger than the declared scanlines', () => {
    const scanlines = Buffer.from([0, 0x11, 0x22, 0x33, 0xff, 0]);

    expect(() => decodePngToRgba(rgbaPng(1, 1, scanlines))).toThrow(
      /inflated PNG data exceeds the expected scanline length/i,
    );
  });

  test('caps highly compressed data at the declared scanline length', () => {
    const scanlines = Buffer.alloc(1024 * 1024);
    scanlines.set([0, 0x11, 0x22, 0x33, 0xff]);
    const png = rgbaPng(1, 1, scanlines);

    expect(png.length).toBeLessThan(2_048);
    expect(() => decodePngToRgba(png)).toThrow(
      /inflated PNG data exceeds the expected scanline length/i,
    );
  });

  test('decodes data whose length exactly matches the declared scanlines', () => {
    const decoded = decodePngToRgba(
      rgbaPng(1, 1, Buffer.from([0, 0x11, 0x22, 0x33, 0xff])),
    );

    expect(decoded).toEqual({
      width: 1,
      height: 1,
      rgba: Buffer.from([0x11, 0x22, 0x33, 0xff]),
    });
  });

  test('allows the source dimension boundary and resizes afterward', () => {
    const scanlines = Buffer.alloc(1 + 16_384 * 4);
    const decoded = decodePngToRgba(rgbaPng(16_384, 1, scanlines));

    expect(decoded.width).toBe(1_024);
    expect(decoded.height).toBe(1);
    expect(decoded.rgba).toHaveLength(1_024 * 4);
  });

  test('accepts image data split across multiple IDAT chunks', () => {
    const compressed = deflateSync(Buffer.from([0, 0x11, 0x22, 0x33, 0xff]));
    const split = Math.floor(compressed.length / 2);
    const png = Buffer.concat([
      PNG_SIGNATURE,
      pngChunk('IHDR', rgbaIhdr(1, 1)),
      pngChunk('IDAT', compressed.subarray(0, split)),
      pngChunk('IDAT', compressed.subarray(split)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);

    expect(decodePngToRgba(png).rgba).toEqual(Buffer.from([0x11, 0x22, 0x33, 0xff]));
  });

  test('rejects inflated data shorter than the declared scanlines', () => {
    expect(() => decodePngToRgba(
      rgbaPng(2, 1, Buffer.from([0, 0x11, 0x22, 0x33, 0xff])),
    )).toThrow(/PNG data ended early. Expected 9 bytes after inflate, got 5/i);
  });

  test('reports malformed compressed image data without allocating scanline buffers', () => {
    const png = rgbaPngWithIdat(1, 1, Buffer.from([0x78, 0x9c, 0]));

    expect(() => decodePngToRgba(png)).toThrow(/Invalid PNG compressed data:/i);
  });

  test('rejects PNG input larger than the compressed-input limit', () => {
    const png = Buffer.alloc(32 * 1024 * 1024 + 1);
    PNG_SIGNATURE.copy(png);

    expect(() => decodePngToRgba(png)).toThrow(
      /PNG input length 33554433 exceeds the 33554432-byte limit/i,
    );
  });

  test('rejects oversized source dimensions before inflating image data', () => {
    expect(() => decodePngToRgba(
      rgbaPngWithIdat(16_385, 1, Buffer.from('invalid zlib data')),
    )).toThrow(/PNG dimensions 16385x1 exceed the 16384-pixel dimension limit/i);
  });

  test('rejects an excessive source pixel count before inflating image data', () => {
    expect(() => decodePngToRgba(
      rgbaPngWithIdat(4_096, 2_049, Buffer.from('invalid zlib data')),
    )).toThrow(/PNG pixel count 8392704 exceeds the 8388608-pixel limit/i);
  });

  test('rejects malformed IHDR lengths with a controlled error', () => {
    const png = Buffer.concat([
      PNG_SIGNATURE,
      pngChunk('IHDR', rgbaIhdr(1, 1).subarray(0, 12)),
      pngChunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);

    expect(() => decodePngToRgba(png)).toThrow(/PNG IHDR chunk must be exactly 13 bytes/i);
  });

  test('rejects a chunk whose declared size exceeds the compressed-data limit', () => {
    const oversizedIdatHeader = Buffer.alloc(8);
    oversizedIdatHeader.writeUInt32BE(32 * 1024 * 1024 + 1, 0);
    oversizedIdatHeader.write('IDAT', 4, 4, 'ascii');
    const png = Buffer.concat([
      PNG_SIGNATURE,
      pngChunk('IHDR', rgbaIhdr(1, 1)),
      oversizedIdatHeader,
      Buffer.alloc(4),
    ]);

    expect(() => decodePngToRgba(png)).toThrow(
      /PNG chunk IDAT length 33554433 exceeds the 33554432-byte chunk limit/i,
    );
  });

  test('rejects excessive chunk counts before scanning the full input', () => {
    const chunks = [
      PNG_SIGNATURE,
      pngChunk('IHDR', rgbaIhdr(1, 1)),
    ];
    const emptyAncillaryChunk = pngChunk('tEXt', Buffer.alloc(0));
    for (let index = 0; index < 65_536; index++) {
      chunks.push(emptyAncillaryChunk);
    }

    expect(() => decodePngToRgba(Buffer.concat(chunks))).toThrow(
      /PNG contains more than the 65536-chunk limit/i,
    );
  });
});

describe('decodePngBase64ToRgba', () => {
  test('decodes standard padded and unpadded base64', () => {
    const png = rgbaPng(1, 1, Buffer.from([0, 0x11, 0x22, 0x33, 0xff]));
    const padded = png.toString('base64');
    const encodings = [padded, padded.replace(/=+$/u, '')];

    for (const encoded of encodings) {
      expect(decodePngBase64ToRgba(encoded).rgba).toEqual(
        Buffer.from([0x11, 0x22, 0x33, 0xff]),
      );
    }
  });

  test('rejects non-canonical whitespace instead of scanning it during decode', () => {
    const encoded = rgbaPng(1, 1, Buffer.from([0, 0, 0, 0, 0]))
      .toString('base64')
      .replace(/=+$/u, '');

    expect(() => decodePngBase64ToRgba(`${encoded}\n`)).toThrow(
      /Invalid PNG base64 data/i,
    );
  });

  test('rejects decoded data above the limit before allocating its Buffer', () => {
    const encoded = 'A'.repeat(44_739_244);
    expect(() => decodePngBase64ToRgba(encoded)).toThrow(
      /PNG input length 33554433 exceeds the 33554432-byte limit/i,
    );
  });
});

describe('decodeImagePathToRgba', () => {
  let tempDirectory: string;

  beforeEach(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-png-'));
  });

  afterEach(() => {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  test('decodes a regular file through the bounded read path', () => {
    const imagePath = path.join(tempDirectory, 'image.png');
    fs.writeFileSync(
      imagePath,
      rgbaPng(1, 1, Buffer.from([0, 0x11, 0x22, 0x33, 0xff])),
    );

    expect(decodeImagePathToRgba(imagePath).rgba).toEqual(
      Buffer.from([0x11, 0x22, 0x33, 0xff]),
    );
  });

  test('rejects an oversized regular file before reading its contents', () => {
    const imagePath = path.join(tempDirectory, 'oversized.png');
    const descriptor = fs.openSync(imagePath, 'w');
    try {
      fs.ftruncateSync(descriptor, 32 * 1024 * 1024 + 1);
    } finally {
      fs.closeSync(descriptor);
    }

    expect(() => decodeImagePathToRgba(imagePath)).toThrow(
      /PNG input length 33554433 exceeds the 33554432-byte limit/i,
    );
  });

  test('rejects a non-regular source without reading it to EOF', () => {
    if (process.platform === 'win32') return;
    expect(() => decodeImagePathToRgba('/dev/zero')).toThrow(
      /image_path must reference a regular file/i,
    );
  });

  test('preserves the image_path not-found error', () => {
    const imagePath = path.join(tempDirectory, 'missing.png');
    expect(() => decodeImagePathToRgba(imagePath)).toThrow(
      `image_path not found: ${imagePath}`,
    );
  });
});

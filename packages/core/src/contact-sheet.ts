// Composes several viewport frames into one labelled contact sheet so a caller
// can compare a sequence in a single image. Frames are laid out row-major,
// left to right then top to bottom, each tagged with its 1-based number.

export type RgbaFrame = { width: number; height: number; rgba: Buffer };

export type ContactSheet = RgbaFrame & { columns: number; rows: number; tileWidth: number; tileHeight: number };

const MAX_SHEET_WIDTH = 2048;
const GAP = 4;
const BACKGROUND = 32;
const LABEL_SCALE = 3;
const LABEL_PAD = 2;
// 3x5 bitmap digits, one row per string, '#' = lit.
const DIGITS: string[][] = [
  ['###', '#.#', '#.#', '#.#', '###'],
  ['.#.', '##.', '.#.', '.#.', '###'],
  ['###', '..#', '###', '#..', '###'],
  ['###', '..#', '###', '..#', '###'],
  ['#.#', '#.#', '###', '..#', '..#'],
  ['###', '#..', '###', '..#', '###'],
  ['###', '#..', '###', '#.#', '###'],
  ['###', '..#', '..#', '..#', '..#'],
  ['###', '#.#', '###', '#.#', '###'],
  ['###', '#.#', '###', '..#', '###'],
];

// Area-average downscale (upscaling never happens: tiles only shrink).
function scaleFrame(frame: RgbaFrame, width: number, height: number): Buffer {
  if (width === frame.width && height === frame.height) return frame.rgba;
  const out = Buffer.alloc(width * height * 4);
  const xRatio = frame.width / width;
  const yRatio = frame.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * yRatio));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * xRatio));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = y0; sy < y1; sy++) {
        let offset = (sy * frame.width + x0) * 4;
        for (let sx = x0; sx < x1; sx++) {
          r += frame.rgba[offset];
          g += frame.rgba[offset + 1];
          b += frame.rgba[offset + 2];
          offset += 4;
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const dst = (y * width + x) * 4;
      out[dst] = Math.round(r / count);
      out[dst + 1] = Math.round(g / count);
      out[dst + 2] = Math.round(b / count);
      out[dst + 3] = 255;
    }
  }
  return out;
}

type Tile = { sheetWidth: number; right: number; bottom: number };

// Fills an opaque grey rectangle (value for R, G and B), clipped to the tile.
function fillRect(sheet: Buffer, tile: Tile, x: number, y: number, width: number, height: number, value: number) {
  const color = (((value << 24) | (value << 16) | (value << 8) | 255) >>> 0);
  const right = Math.min(x + width, tile.right);
  for (let row = y; row < Math.min(y + height, tile.bottom); row++) {
    for (let offset = (row * tile.sheetWidth + x) * 4, end = (row * tile.sheetWidth + right) * 4; offset < end; offset += 4) sheet.writeUInt32BE(color, offset);
  }
}

function drawLabel(sheet: Buffer, tile: Tile, x: number, y: number, label: string) {
  const glyphWidth = 3 * LABEL_SCALE;
  const width = label.length * (glyphWidth + LABEL_SCALE) - LABEL_SCALE + LABEL_PAD * 2;
  const height = 5 * LABEL_SCALE + LABEL_PAD * 2;
  fillRect(sheet, tile, x, y, width, height, 0);
  for (let i = 0; i < label.length; i++) {
    const glyph = DIGITS[label.charCodeAt(i) - 48];
    const gx = x + LABEL_PAD + i * (glyphWidth + LABEL_SCALE);
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (glyph[row][col] === '#') {
          fillRect(sheet, tile, gx + col * LABEL_SCALE, y + LABEL_PAD + row * LABEL_SCALE, LABEL_SCALE, LABEL_SCALE, 255);
        }
      }
    }
  }
}

// Every tile shares the first frame's aspect ratio; other sizes are stretched
// into it (a viewport resized mid-sequence is the only way that happens).
export function composeContactSheet(frames: RgbaFrame[]): ContactSheet {
  if (frames.length === 0) throw new Error('A contact sheet needs at least one frame.');
  const columns = Math.ceil(Math.sqrt(frames.length));
  const rows = Math.ceil(frames.length / columns);
  const tileWidth = Math.max(1, Math.min(frames[0].width, Math.floor((MAX_SHEET_WIDTH - GAP * (columns + 1)) / columns)));
  const tileHeight = Math.max(1, Math.round((frames[0].height * tileWidth) / frames[0].width));
  const width = columns * tileWidth + GAP * (columns + 1);
  const height = rows * tileHeight + GAP * (rows + 1);
  const rgba = Buffer.alloc(width * height * 4, BACKGROUND);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  frames.forEach((frame, index) => {
    const tile = scaleFrame(frame, tileWidth, tileHeight);
    const left = GAP + (index % columns) * (tileWidth + GAP);
    const top = GAP + Math.floor(index / columns) * (tileHeight + GAP);
    for (let row = 0; row < tileHeight; row++) {
      tile.copy(rgba, ((top + row) * width + left) * 4, row * tileWidth * 4, (row + 1) * tileWidth * 4);
    }
    drawLabel(rgba, { sheetWidth: width, right: left + tileWidth, bottom: top + tileHeight }, left, top, String(index + 1));
  });
  return { width, height, rgba, columns, rows, tileWidth, tileHeight };
}

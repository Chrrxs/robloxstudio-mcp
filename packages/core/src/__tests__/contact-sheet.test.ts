import { composeContactSheet } from '../contact-sheet.js';
import type { RgbaFrame } from '../contact-sheet.js';

function frame(width: number, height: number, value: number): RgbaFrame {
  const rgba = Buffer.alloc(width * height * 4, value);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return { width, height, rgba };
}

const pixel = (sheet: RgbaFrame, x: number, y: number) => [...sheet.rgba.subarray((y * sheet.width + x) * 4, (y * sheet.width + x) * 4 + 4)];

describe('composeContactSheet', () => {
  test('lays frames out row-major in a near-square grid', () => {
    const sheet = composeContactSheet([frame(100, 50, 10), frame(100, 50, 20), frame(100, 50, 30), frame(100, 50, 40), frame(100, 50, 50)]);
    expect(sheet).toMatchObject({ columns: 3, rows: 2, tileWidth: 100, tileHeight: 50, width: 3 * 100 + 4 * 4, height: 2 * 50 + 3 * 4 });
    expect(sheet.rgba.length).toBe(sheet.width * sheet.height * 4);
    // Bottom-right corner of each tile (clear of its number label).
    expect(pixel(sheet, 4 + 99, 4 + 49)).toEqual([10, 10, 10, 255]);
    expect(pixel(sheet, 4 + 2 * 104 + 99, 4 + 49)).toEqual([30, 30, 30, 255]);
    expect(pixel(sheet, 4 + 104 + 99, 4 + 54 + 49)).toEqual([50, 50, 50, 255]);
    // The sixth slot stays background.
    expect(pixel(sheet, 4 + 2 * 104 + 99, 4 + 54 + 49)).toEqual([32, 32, 32, 255]);
  });

  test('labels each tile with its white-on-black frame number', () => {
    const sheet = composeContactSheet([frame(60, 60, 128), frame(60, 60, 128)]);
    // Label box: 2px padding, then the digit "1" (3x5 cells of 3px): its top row is ".#.".
    expect(pixel(sheet, 4, 4)).toEqual([0, 0, 0, 255]);
    expect(pixel(sheet, 4 + 2 + 4, 4 + 2 + 1)).toEqual([255, 255, 255, 255]);
    expect(pixel(sheet, 4 + 2 + 1, 4 + 2 + 1)).toEqual([0, 0, 0, 255]);
  });

  test('shrinks wide frames to fit the sheet width and averages pixels', () => {
    const wide = frame(1920, 1080, 200);
    const sheet = composeContactSheet([wide, wide, wide, wide]);
    expect(sheet.width).toBeLessThanOrEqual(2048);
    expect(sheet.tileWidth).toBe(Math.floor((2048 - 4 * 3) / 2));
    expect(sheet.tileHeight).toBe(Math.round((1080 * sheet.tileWidth) / 1920));
    expect(pixel(sheet, 4 + sheet.tileWidth - 1, 4 + sheet.tileHeight - 1)).toEqual([200, 200, 200, 255]);
  });

  test('clips labels to tiles smaller than the label', () => {
    const sheet = composeContactSheet([frame(2, 1, 90), frame(2, 1, 90), frame(2, 1, 90), frame(2, 1, 90)]);
    expect(sheet).toMatchObject({ columns: 2, rows: 2, width: 2 * 2 + 3 * 4, height: 2 * 1 + 3 * 4 });
    // Gaps between tiles stay background.
    expect(pixel(sheet, 4 + 2, 4)).toEqual([32, 32, 32, 255]);
  });

  test('rejects an empty sequence', () => {
    expect(() => composeContactSheet([])).toThrow(/at least one frame/);
  });
});

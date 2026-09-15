// Field report #1: under device emulation the marker box (1326x662) has a different aspect than the reported viewport (1608x661); the old aspect check rejected it.
// Also covers single-colour frame detection for the black play-mode frame.
import { findViewportRect, isUniformFrame } from '../host-capture.js';

function solid(width: number, height: number, rgb: [number, number, number]): Buffer {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = rgb[0];
    rgba[i * 4 + 1] = rgb[1];
    rgba[i * 4 + 2] = rgb[2];
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

function fill(rgba: Buffer, width: number, x0: number, y0: number, w: number, h: number, rgb: [number, number, number]): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const o = (y * width + x) * 4;
      rgba[o] = rgb[0];
      rgba[o + 1] = rgb[1];
      rgba[o + 2] = rgb[2];
      rgba[o + 3] = 255;
    }
  }
}

function windowWithPane(width: number, height: number, pane: { x: number; y: number; width: number; height: number }, markerSize: number): Buffer {
  const rgba = solid(width, height, [60, 60, 60]);
  for (let y = 0; y < pane.height; y++) {
    for (let x = 0; x < pane.width; x++) {
      const o = ((pane.y + y) * width + pane.x + x) * 4;
      rgba[o] = x % 256;
      rgba[o + 1] = y % 256;
      rgba[o + 2] = 128;
    }
  }
  const magenta: [number, number, number] = [255, 0, 255];
  fill(rgba, width, pane.x, pane.y, markerSize, markerSize, magenta);
  fill(rgba, width, pane.x + pane.width - markerSize, pane.y, markerSize, markerSize, magenta);
  fill(rgba, width, pane.x, pane.y + pane.height - markerSize, markerSize, markerSize, magenta);
  fill(rgba, width, pane.x + pane.width - markerSize, pane.y + pane.height - markerSize, markerSize, markerSize, magenta);
  return rgba;
}

describe('field #1 viewport markers under device emulation', () => {
  test('a 1326x662 on-screen pane is accepted when the client reports a 1608x661 viewport', () => {
    const rgba = windowWithPane(1920, 1009, { x: 293, y: 195, width: 1326, height: 662 }, 12);
    const located = findViewportRect(rgba, 1920, 1009, { viewportWidth: 1608, viewportHeight: 661, markerSize: 12 });
    expect(located).toMatchObject({ rect: { x: 293, y: 195, width: 1326, height: 662 } });
  });

  test('a 1177x662 letterboxed pane (16:9 emulation inside a wider dock) is accepted for a 1280x720 viewport', () => {
    const rgba = windowWithPane(1920, 1009, { x: 508, y: 195, width: 1177, height: 662 }, 12);
    const located = findViewportRect(rgba, 1920, 1009, { viewportWidth: 1280, viewportHeight: 720, markerSize: 12 });
    expect(located).toMatchObject({ rect: { x: 508, y: 195, width: 1177, height: 662 } });
  });

  test('a marker miss reports the pixel count and the branch that failed', () => {
    const rgba = solid(64, 32, [0, 0, 0]);
    expect(findViewportRect(rgba, 64, 32, { viewportWidth: 64, viewportHeight: 32, markerSize: 12 })).toMatchObject({
      error: expect.stringContaining('no viewport markers'),
      branch: 'none',
      markerPixels: 0,
    });
  });
});

describe('field #1 single-colour frame detection', () => {
  test('the 1608x772 black frame CaptureService hands back in play mode is flagged as blank', () => {
    const frame = solid(1608, 772, [0, 0, 0]);
    expect(isUniformFrame(frame, 1608, 772)).toBe(true);
  });

  test('a frame with a single lit pixel is not blank', () => {
    const frame = solid(1608, 772, [0, 0, 0]);
    frame[(400 * 1608 + 800) * 4 + 1] = 7;
    expect(isUniformFrame(frame, 1608, 772)).toBe(false);
  });
});

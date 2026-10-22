import { captureScreenshotWithBudget } from '../fork/capture.js';
import {
  applyCaptureBudget,
  downscaleRgba,
  imageSize,
  parseRect,
  pluginFrameMaxPx,
  shrinkImageBlocks,
} from '../fork/image-budget.js';
import { readForkLimits, setForkLimits } from '../fork/limits.js';
import { rgbaToJpeg } from '../jpeg-encoder.js';
import { rgbaToPng } from '../png-encoder.js';
import type { RobloxStudioTools } from '../tools/index.js';

function solid(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < out.length; i += 4) out.set(rgba, i);
  return out;
}

/** Left half red, right half blue. */
function halves(width: number, height: number): Buffer {
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out.set(x < width / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * width + x) * 4);
  }
  return out;
}

describe('image budget', () => {
  test('downscale keeps aspect, fits max px, and averages pixels', () => {
    const scaled = downscaleRgba(solid(1920, 1080, [10, 20, 30, 255]), 1920, 1080, 512);
    expect(scaled.width).toBe(512);
    expect(scaled.height).toBe(288);
    expect([...scaled.rgba.subarray(0, 4)]).toEqual([10, 20, 30, 255]);
    const small = solid(100, 50, [1, 2, 3, 4]);
    expect(downscaleRgba(small, 100, 50, 512).rgba).toBe(small);
  });

  test('capture budget crops in viewport px even when the frame arrived downscaled', () => {
    // Plugin sent a half-size frame of a 1600x800 viewport.
    const response = {
      encoding: 'rgba8' as const,
      width: 800,
      height: 400,
      nativeWidth: 1600,
      nativeHeight: 800,
      data: halves(800, 400).toString('base64'),
    };
    const out = applyCaptureBudget(response, { maxPx: 512, crop: { x: 800, y: 0, w: 800, h: 800 } });
    expect(out.crop).toEqual({ x: 800, y: 0, w: 800, h: 800 });
    expect(out.width).toBe(400);
    expect(out.height).toBe(400);
    // The right half of the viewport is all blue.
    expect([...Buffer.from(out.data!, 'base64').subarray(0, 4)]).toEqual([0, 0, 255, 255]);
  });

  test('a crop outside the viewport is an error, not an empty image', () => {
    const response = { encoding: 'rgba8' as const, width: 10, height: 10, data: solid(10, 10, [0, 0, 0, 255]).toString('base64') };
    const out = applyCaptureBudget(response, { maxPx: 512, crop: { x: 50, y: 50, w: 5, h: 5 } });
    expect(out.error).toMatch(/outside the 10x10 viewport/);
  });

  test('the plugin frame limit leaves enough pixels for the crop', () => {
    expect(pluginFrameMaxPx({ maxPx: 512 })).toBe(512);
    expect(pluginFrameMaxPx({ maxPx: 0 })).toBeUndefined();
    expect(pluginFrameMaxPx({ maxPx: 512, crop: { x: 0, y: 0, w: 400, h: 200 }, viewport: { width: 1600, height: 900 } })).toBe(2048);
    expect(pluginFrameMaxPx({ maxPx: 512, crop: { x: 0, y: 0, w: 10, h: 10 } })).toBeUndefined();
  });

  test('oversized PNG blocks are downscaled; JPEG blocks are only measured', () => {
    const png = rgbaToPng(solid(1200, 600, [200, 100, 50, 255]), 1200, 600);
    const jpeg = rgbaToJpeg(solid(900, 300, [0, 0, 0, 255]), 900, 300, 70);
    const content = [
      { type: 'text', text: 'hi' },
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
      { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' },
    ];
    const { content: out, images } = shrinkImageBlocks(content, 512);
    expect(out[0]).toBe(content[0]);
    expect(imageSize(Buffer.from((out[1] as { data: string }).data, 'base64'))).toEqual({ w: 512, h: 256 });
    expect(out[2]).toBe(content[2]);
    expect(images.map(({ w, h }) => [w, h])).toEqual([[512, 256], [900, 300]]);
    expect(images[1].bytes).toBe(jpeg.length);
  });

  test('parseRect accepts x,y,w,h only', () => {
    expect(parseRect('10, 20,300,40')).toEqual({ x: 10, y: 20, w: 300, h: 40 });
    expect(parseRect('Workspace.Door')).toBeUndefined();
    expect(parseRect('1,2,0,4')).toBeUndefined();
  });
});

describe('capture_screenshot with crop and max_px', () => {
  afterEach(() => setForkLimits());

  function fakeTools(rect: Record<string, unknown>) {
    const calls: Array<{ endpoint: string; data: unknown; role: string }> = [];
    const budgets: unknown[] = [];
    const tools = {
      forkBridge: () => ({
        refreshTopology: () => undefined,
        resolveRuntime: () => ({ instanceId: 'inst', clientRole: 'client-1' }),
        callSingle: async (endpoint: string, data: unknown, role: string) => {
          calls.push({ endpoint, data, role });
          return rect;
        },
        captureViewportImage: async (_id: string, _role: string, format: string | undefined, quality: number | undefined, _max: unknown, budget: { crop?: unknown }) => {
          budgets.push(budget);
          return {
            success: true, width: 300, height: 100, format: format ?? 'jpeg', quality: quality ?? 70, note: '',
            data: 'AAAA', mimeType: 'image/jpeg', message: 'upstream message', crop: budget.crop,
            viewport: { width: 1600, height: 900 },
          };
        },
      }),
    } as unknown as RobloxStudioTools;
    return { tools, calls, budgets };
  }

  test('an instance crop is resolved in the rendering peer and reported as scale and origin', async () => {
    setForkLimits(readForkLimits([], {}));
    const { tools, calls, budgets } = fakeTools({ x: 100, y: 50, w: 600, h: 200, viewportWidth: 1600, viewportHeight: 900 });
    const result = await captureScreenshotWithBudget(tools, undefined, { crop: 'StarterGui.Shop.Frame', max_px: 300 });
    expect(calls).toEqual([{ endpoint: '/api/fork/capture-rect', data: { path: 'StarterGui.Shop.Frame' }, role: 'client-1' }]);
    expect(budgets[0]).toEqual({ maxPx: 300, crop: { x: 100, y: 50, w: 600, h: 200 }, viewport: { width: 1600, height: 900 } });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.scale).toBe(0.5);
    expect(body.origin).toBe('100,50');
    expect(body.message).toContain('viewport x = 100 + image x / 0.5');
    expect(result.content[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' });
    expect(Buffer.byteLength(JSON.stringify(result.content[0]))).toBeLessThan(600);
  });

  test('a literal rect still works against a plugin without the fork endpoint', async () => {
    setForkLimits(readForkLimits([], {}));
    const { tools, budgets } = fakeTools({ error: 'Unknown endpoint: /api/fork/capture-rect' });
    await captureScreenshotWithBudget(tools, undefined, { crop: '0,0,800,450' });
    expect(budgets[0]).toEqual({ maxPx: 512, crop: { x: 0, y: 0, w: 800, h: 450 } });
  });

  test('bad arguments fail with one line', async () => {
    const { tools } = fakeTools({ error: 'no instance at Workspace.Nope' });
    const bad = await captureScreenshotWithBudget(tools, undefined, { max_px: 5 });
    expect(JSON.parse((bad.content[0] as { text: string }).text).error).toMatch(/max_px must be/);
    const missing = await captureScreenshotWithBudget(tools, undefined, { crop: 'Workspace.Nope' });
    expect(JSON.parse((missing.content[0] as { text: string }).text).error).toBe('crop: no instance at Workspace.Nope');
  });
});

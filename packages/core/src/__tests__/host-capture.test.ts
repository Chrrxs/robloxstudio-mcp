import {
  cropToViewport,
  findViewportRect,
  isHostCaptureDisabled,
  isUniformFrame,
  pickStudioWindow,
  studioWindowMatchesHint,
} from '../host-capture.js';
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import type { HostWindowCaptureFn } from '../tools/index.js';
import type { HostCaptureResult, HostWindowCapture } from '../host-capture.js';
import { StudioHttpClient } from '../tools/studio-client.js';
import { rgbaToPng } from '../png-encoder.js';
import { decodePngToRgba } from '../image-decode.js';

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

// A fake Studio window: grey chrome with a gradient "viewport" at (x, y) of
// the given size, optionally decorated with the plugin's corner markers.
function studioWindow(
  width: number,
  height: number,
  viewport: { x: number; y: number; width: number; height: number },
  markers: boolean,
  markerSize = 12,
): Buffer {
  const rgba = solid(width, height, [60, 60, 60]);
  for (let y = 0; y < viewport.height; y++) {
    if (viewport.y + y < 0) continue;
    if (viewport.y + y >= height) break;
    for (let x = 0; x < viewport.width; x++) {
      const o = ((viewport.y + y) * width + viewport.x + x) * 4;
      rgba[o] = x % 256;
      rgba[o + 1] = y % 256;
      rgba[o + 2] = 128;
      rgba[o + 3] = 255;
    }
  }
  if (markers) {
    const magenta: [number, number, number] = [255, 0, 255];
    const right = viewport.x + viewport.width - markerSize;
    const bottom = viewport.y + viewport.height - markerSize;
    if (viewport.y >= 0) {
      fill(rgba, width, viewport.x, viewport.y, markerSize, markerSize, magenta);
      fill(rgba, width, right, viewport.y, markerSize, markerSize, magenta);
    }
    if (bottom + markerSize <= height) {
      fill(rgba, width, viewport.x, bottom, markerSize, markerSize, magenta);
      fill(rgba, width, right, bottom, markerSize, markerSize, magenta);
    }
  }
  return rgba;
}

describe('isUniformFrame', () => {
  test('detects a fully black frame', () => {
    expect(isUniformFrame(solid(8, 4, [0, 0, 0]), 8, 4)).toBe(true);
  });

  test('detects any flat colour, not just black', () => {
    expect(isUniformFrame(solid(8, 4, [17, 200, 3]), 8, 4)).toBe(true);
  });

  test('rejects a frame with a single differing pixel', () => {
    const rgba = solid(8, 4, [0, 0, 0]);
    rgba[(3 * 8 + 5) * 4 + 1] = 1;
    expect(isUniformFrame(rgba, 8, 4)).toBe(false);
  });

  test('rejects malformed input instead of guessing', () => {
    expect(isUniformFrame(Buffer.alloc(3), 2, 2)).toBe(false);
    expect(isUniformFrame(Buffer.alloc(0), 0, 0)).toBe(false);
  });
});

describe('findViewportRect', () => {
  const hint = { viewportWidth: 300, viewportHeight: 120, markerSize: 12 };

  test('locates the viewport from the four corner markers', () => {
    const rgba = studioWindow(400, 200, { x: 50, y: 30, width: 300, height: 120 }, true);
    expect(findViewportRect(rgba, 400, 200, hint)).toMatchObject({ rect: { x: 50, y: 30, width: 300, height: 120 } });
  });

  test('ignores magenta inside the viewport (game UI can be any colour)', () => {
    const rgba = studioWindow(400, 200, { x: 50, y: 30, width: 300, height: 120 }, true);
    fill(rgba, 400, 120, 60, 40, 20, [255, 0, 255]);
    expect(findViewportRect(rgba, 400, 200, hint)).toMatchObject({ rect: { x: 50, y: 30, width: 300, height: 120 } });
  });

  test('accepts a DPI-scaled viewport whose box is a uniform multiple of the logical size', () => {
    const rgba = studioWindow(800, 400, { x: 100, y: 60, width: 600, height: 240 }, true, 24);
    expect(findViewportRect(rgba, 800, 400, { ...hint, markerSize: 24 })).toMatchObject({ rect: { x: 100, y: 60, width: 600, height: 240 }, scaleX: 2, scaleY: 2 });
  });

  test('fails clearly when no markers are visible', () => {
    const rgba = studioWindow(400, 200, { x: 50, y: 30, width: 300, height: 120 }, false);
    expect(findViewportRect(rgba, 400, 200, hint)).toMatchObject({ error: expect.stringContaining('no viewport markers') });
  });

  test('rejects a box stretched by stray magenta in Studio chrome', () => {
    const rgba = studioWindow(400, 200, { x: 50, y: 30, width: 300, height: 120 }, true);
    fill(rgba, 400, 5, 180, 3, 3, [255, 0, 255]);
    expect(findViewportRect(rgba, 400, 200, hint)).toMatchObject({ error: expect.stringContaining('do not form a rectangle') });
  });

  test('accepts a device-emulation viewport whose on-screen pane has a different aspect than the reported size', () => {
    const rgba = studioWindow(1920, 1009, { x: 293, y: 195, width: 1326, height: 662 }, true);
    const located = findViewportRect(rgba, 1920, 1009, { viewportWidth: 1608, viewportHeight: 661, markerSize: 12 });
    expect(located).toMatchObject({ rect: { x: 293, y: 195, width: 1326, height: 662 } });
    expect((located as { scaleX: number }).scaleX).toBeCloseTo(1326 / 1608, 3);
    expect((located as { scaleY: number }).scaleY).toBeCloseTo(662 / 661, 3);
  });

  test('infers a viewport clipped by the pane from the top markers alone (physical-size emulation)', () => {
    const rgba = studioWindow(1920, 935, { x: 67, y: 177, width: 1466, height: 825 }, true);
    const located = findViewportRect(rgba, 1920, 935, { viewportWidth: 1279, viewportHeight: 720, markerSize: 12 });
    expect(located).toMatchObject({ rect: { x: 67, y: 177, width: 1466, height: 825 }, clipped: { edge: 'bottom', pixels: 177 + 825 - 935 } });
    const cropped = cropToViewport(rgba, 1920, 935, (located as { rect: { x: number; y: number; width: number; height: number } }).rect, 1279, 720);
    expect(cropped.width).toBe(1279);
    expect(cropped.height).toBe(720);
    const lastRow = (719 * 1279) * 4;
    expect([cropped.rgba[lastRow], cropped.rgba[lastRow + 1], cropped.rgba[lastRow + 2], cropped.rgba[lastRow + 3]]).toEqual([0, 0, 0, 255]);
    const midRow = (300 * 1279 + 600) * 4;
    expect(cropped.rgba[midRow + 2]).toBe(128);
  });

  test('infers the viewport from the bottom markers alone when the pane is scrolled down', () => {
    const rgba = studioWindow(1920, 935, { x: 67, y: -100, width: 1466, height: 825 }, true);
    const located = findViewportRect(rgba, 1920, 935, { viewportWidth: 1279, viewportHeight: 720, markerSize: 12 });
    expect(located).toMatchObject({ rect: { x: 67, y: -100, width: 1466, height: 825 }, clipped: { edge: 'top', pixels: 100 } });
  });

  test('reports the marker pixel count and the failing branch when no markers are visible', () => {
    const rgba = studioWindow(400, 200, { x: 50, y: 30, width: 300, height: 120 }, false);
    expect(findViewportRect(rgba, 400, 200, hint)).toEqual({
      error: expect.stringContaining('no viewport markers'),
      branch: 'none',
      markerPixels: 0,
    });
    const stray = studioWindow(400, 200, { x: 50, y: 30, width: 300, height: 120 }, true);
    fill(stray, 400, 5, 180, 3, 3, [255, 0, 255]);
    expect(findViewportRect(stray, 400, 200, hint)).toEqual({
      error: expect.stringContaining('do not form a rectangle'),
      branch: 'rectangle',
      markerPixels: 4 * 12 * 12 + 9,
    });
  });
});

describe('studioWindowMatchesHint', () => {
  test('matches published place titles, file-path titles and untitled windows', () => {
    expect(studioWindowMatchesHint('My Place - Roblox Studio', 'My Place')).toBe(true);
    const fileTitle = String.raw`C:\Users\x\Desktop\baseplate-abc.rbxl - Roblox Studio`;
    expect(studioWindowMatchesHint(fileTitle, 'baseplate-abc')).toBe(true);
    expect(studioWindowMatchesHint(fileTitle, 'baseplate-abc.rbxl')).toBe(true);
    expect(studioWindowMatchesHint(fileTitle, 'baseplate')).toBe(false);
    expect(studioWindowMatchesHint('Other Place - Roblox Studio', 'My Place')).toBe(false);
    expect(studioWindowMatchesHint('Roblox Studio', 'My Place')).toBe(false);
    expect(studioWindowMatchesHint('RunnerBaseplate.rbxl - Roblox Studio', 'RunnerBaseplate.rbxl')).toBe(true);
  });
});

describe('pickStudioWindow', () => {
  const windows = [
    { handle: 1, pid: 100, title: String.raw`C:	mpsmcp-runner-a\RunnerBaseplate.rbxl - Roblox Studio`, placeName: 'a', isIconic: false },
    { handle: 2, pid: 200, title: String.raw`C:	mpsmcp-runner-b\RunnerBaseplate.rbxl - Roblox Studio`, placeName: 'b', isIconic: false },
    { handle: 3, pid: 300, title: 'My Place - Roblox Studio', placeName: 'My Place', isIconic: true },
  ];

  test('prefers the managed process id over the title', () => {
    expect(pickStudioWindow(windows, 'RunnerBaseplate.rbxl', 200)).toEqual({ ok: true, window: windows[1] });
  });

  test('falls back to a unique title match and refuses ambiguous titles', () => {
    expect(pickStudioWindow(windows, 'My Place')).toEqual({ ok: true, window: windows[2] });
    expect(pickStudioWindow(windows, 'RunnerBaseplate.rbxl')).toMatchObject({ ok: false, error: expect.stringContaining('several Studio windows match') });
    expect(pickStudioWindow(windows, 'Unknown')).toMatchObject({ ok: false, error: expect.stringContaining('could not pick a Studio window') });
    expect(pickStudioWindow([windows[0]], 'Unknown')).toEqual({ ok: true, window: windows[0] });
    expect(pickStudioWindow([], 'x')).toMatchObject({ ok: false });
  });
});

describe('cropToViewport', () => {
  test('copies an exactly matching rect without resampling', () => {
    const rgba = studioWindow(400, 200, { x: 50, y: 30, width: 300, height: 120 }, false);
    const cropped = cropToViewport(rgba, 400, 200, { x: 50, y: 30, width: 300, height: 120 }, 300, 120);
    expect(cropped.width).toBe(300);
    expect(cropped.height).toBe(120);
    expect([cropped.rgba[0], cropped.rgba[1], cropped.rgba[2]]).toEqual([0, 0, 128]);
    const last = (119 * 300 + 299) * 4;
    expect([cropped.rgba[last], cropped.rgba[last + 1]]).toEqual([299 % 256, 119]);
  });

  test('resamples a DPI-scaled rect down to the logical viewport size', () => {
    const rgba = studioWindow(800, 400, { x: 100, y: 60, width: 600, height: 240 }, false);
    const cropped = cropToViewport(rgba, 800, 400, { x: 100, y: 60, width: 600, height: 240 }, 300, 120);
    expect(cropped.width).toBe(300);
    expect(cropped.height).toBe(120);
    expect(cropped.rgba.length).toBe(300 * 120 * 4);
    // Logical pixel (150, 60) samples source pixel ~ (300, 120): red follows x, green follows y.
    const mid = (60 * 300 + 150) * 4;
    expect(Math.abs(cropped.rgba[mid] - (300 % 256))).toBeLessThanOrEqual(2);
    expect(Math.abs(cropped.rgba[mid + 1] - 120)).toBeLessThanOrEqual(2);
    expect(cropped.rgba[mid + 2]).toBe(128);
  });

  test.each([298, 299, 301, 302])('preserves logical dimensions when fitting rounds the physical width to %i', (physicalWidth) => {
    const rgba = solid(400, 200, [20, 40, 60]);
    const cropped = cropToViewport(rgba, 400, 200, { x: 20, y: 20, width: physicalWidth, height: 119 }, 300, 120);
    expect([cropped.width, cropped.height]).toEqual([300, 120]);
    expect(cropped.rgba.length).toBe(300 * 120 * 4);
  });

  test('clamps a rect that runs past the window edge', () => {
    const rgba = solid(20, 10, [1, 2, 3]);
    const cropped = cropToViewport(rgba, 20, 10, { x: 15, y: 5, width: 10, height: 10 }, 5, 5);
    expect(cropped.width).toBe(5);
    expect(cropped.height).toBe(5);
  });
});

describe('isHostCaptureDisabled', () => {
  test('is off by default and honours the opt-out values', () => {
    expect(isHostCaptureDisabled({})).toBe(false);
    expect(isHostCaptureDisabled({ ROBLOX_STUDIO_HOST_CAPTURE: '1' })).toBe(false);
    expect(isHostCaptureDisabled({ ROBLOX_STUDIO_HOST_CAPTURE: '0' })).toBe(true);
    expect(isHostCaptureDisabled({ ROBLOX_STUDIO_HOST_CAPTURE: 'false' })).toBe(true);
    expect(isHostCaptureDisabled({ ROBLOX_STUDIO_HOST_CAPTURE: 'OFF' })).toBe(true);
  });
});

describe('capture_screenshot host window fallback', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function registerRole(bridge: BridgeService, peerId: string, role: string, isRunning: boolean, transportPeerId = peerId) {
    const result = bridge.registerPeer({
      peerId,
      transportPeerId,
      instanceId: 'instance:test',
      role,
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning,
    });
    if (!result.ok) throw new Error(`registerPeer failed: ${result.error.code}`);
  }

  const viewport = { x: 50, y: 30, width: 300, height: 120 };
  const blackFrame = solid(300, 120, [0, 0, 0]).toString('base64');

  function studioThatReturnsBlackPlayFrames(markerState: { shown: boolean }) {
    return async (endpoint: string, data: unknown) => {
      if (endpoint === '/api/capture-studio') return { unavailable: 'StudioCaptureService cannot capture this DataModel right now' };
      if (endpoint === '/api/capture-begin') return { contentId: 'rbxtemp://1' };
      if (endpoint === '/api/capture-read' || endpoint === '/api/capture-screenshot') {
        return { success: true, encoding: 'rgba8', width: 300, height: 120, nativeWidth: 300, nativeHeight: 120, data: blackFrame };
      }
      if (endpoint === '/api/capture-markers') {
        if (data === null || typeof data !== 'object' || !('action' in data)) throw new Error('Missing marker action');
        const action = data.action;
        if (action === 'show') markerState.shown = true;
        if (action === 'hide') markerState.shown = false;
        return { success: true, captureId: 'capture:test', viewportWidth: 300, viewportHeight: 120, markerSize: 12 };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    };
  }

  function hostWindow(rgba: Buffer, width: number, height: number, extra: Partial<HostWindowCapture> = {}): HostCaptureResult {
    return {
      ok: true,
      capture: {
        width,
        height,
        rgba,
        title: 'TestPlace - Roblox Studio',
        handle: 4242,
        method: 'printwindow',
        clientOrigin: { x: 10, y: 20 },
        restored: false,
        foreground: false,
        magentaPixels: {},
        ...extra,
      },
    };
  }

  function makeTools(hostCapture: HostWindowCaptureFn, requestImpl: (endpoint: string, data: unknown, ...rest: unknown[]) => Promise<unknown>) {
    const bridge = new BridgeService();
    registerRole(bridge, 'edit-session', 'edit', false);
    registerRole(bridge, 'server-session', 'server', true);
    registerRole(bridge, 'client-session', 'client-1', true, 'server-session');
    const request = jest.spyOn(StudioHttpClient.prototype, 'request').mockImplementation(requestImpl as never);
    const tools = new RobloxStudioTools(bridge);
    (tools as unknown as { hostWindowCapture: HostWindowCaptureFn }).hostWindowCapture = hostCapture;
    return { tools, request };
  }

  test('replaces a blank play-client frame with the viewport cropped from the Studio window', async () => {
    const markerState = { shown: false };
    const hostCalls: string[] = [];
    const hostCapture: HostWindowCaptureFn = async (titleHint, options) => {
      hostCalls.push(`${titleHint}|markers=${markerState.shown}|method=${options?.method}`);
      return hostWindow(studioWindow(400, 200, viewport, markerState.shown), 400, 200);
    };
    const { tools, request } = makeTools(hostCapture, studioThatReturnsBlackPlayFrames(markerState));

    const result = await tools.captureScreenshot('instance:test', 'png');
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.width).toBe(300);
    expect(text.height).toBe(120);
    expect(text.message).toContain('Captured from the Studio window through the host OS');
    expect(text.message).toContain('blank (single-colour) frame');
    expect(text.message).toContain('use coordinates as you read them off the image');
    expect((result.content[1] as { mimeType: string }).mimeType).toBe('image/png');
    expect(text.peer).toBe('client-1');
    expect(text.target).toBe('auto');
    expect(text.source).toBe('host-window');
    expect(text.cropped).toBe(true);
    expect(text.viewportRect).toEqual({ x: 60, y: 50, width: 300, height: 120 });
    expect(text.window).toMatchObject({ title: 'TestPlace - Roblox Studio', handle: 4242, width: 400, height: 200, method: 'printwindow' });

    // Markers on for the locating grab (auto method), off for the clean grab, and hidden afterwards.
    expect(hostCalls).toEqual(['TestPlace|markers=true|method=auto', 'TestPlace|markers=false|method=printwindow']);
    expect(markerState.shown).toBe(false);
    const markerActions = request.mock.calls
      .filter(([endpoint]) => endpoint === '/api/capture-markers')
      .map(([, data]) => (data as { action: string }).action);
    expect(markerActions).toEqual(['prepare', 'query', 'show', 'hide', 'finish']);
    // Marker calls follow the rendering peer (the play client), never the edit DM.
    for (const call of request.mock.calls.filter(([endpoint]) => endpoint === '/api/capture-markers')) {
      expect(call[2]).toBe('client-session');
    }
  });

  test('passes the managed process id to the window pick, reading the shared registry when this server did not launch Studio', async () => {
    const markerState = { shown: false };
    const pids: Array<number | undefined> = [];
    const hostCapture: HostWindowCaptureFn = async (_titleHint, options) => {
      pids.push(options?.pid);
      return hostWindow(studioWindow(400, 200, viewport, markerState.shown), 400, 200);
    };
    const { tools } = makeTools(hostCapture, studioThatReturnsBlackPlayFrames(markerState));
    const manager = (tools as unknown as { instanceManager: { peekProcessIdByInstanceId: (id: string) => number | undefined; registry: { peekAnyByInstanceId: (id: string) => Promise<unknown> } } }).instanceManager;
    expect(manager.peekProcessIdByInstanceId('instance:test')).toBeUndefined();
    jest.spyOn(manager.registry, 'peekAnyByInstanceId').mockResolvedValue({ instanceId: 'instance:test', nativeProcessId: 4321, spawnPid: 4000 });

    const result = await tools.captureScreenshot('instance:test', 'png');
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.source).toBe('host-window');
    expect(pids).toEqual([4321, 4321]);
  });

  test('replaces a successful but black StudioCaptureService PNG with the host viewport', async () => {
    const markerState = { shown: false };
    const hostCapture: HostWindowCaptureFn = async () => hostWindow(studioWindow(400, 200, viewport, markerState.shown), 400, 200);
    const studio = studioThatReturnsBlackPlayFrames(markerState);
    const { tools } = makeTools(hostCapture, async (endpoint, data) => {
      if (endpoint === '/api/capture-studio') {
        return {
          success: true, encoding: 'png', source: 'StudioCaptureService', width: 300, height: 120,
          data: rgbaToPng(solid(300, 120, [0, 0, 0]), 300, 120).toString('base64'),
        };
      }
      return studio(endpoint, data);
    });

    const result = await tools.captureScreenshot('instance:test', 'png');
    const text = result.content.find((item) => 'text' in item);
    expect(text && 'text' in text && text.text).toContain('Captured from the Studio window through the host OS');
    const image = result.content.find((item) => 'data' in item);
    if (!image || !('data' in image) || typeof image.data !== 'string') throw new Error('Screenshot did not include an image');
    const decoded = decodePngToRgba(Buffer.from(image.data, 'base64'));
    expect([decoded.width, decoded.height]).toEqual([300, 120]);
    expect(isUniformFrame(decoded.rgba, decoded.width, decoded.height)).toBe(false);
    expect(markerState.shown).toBe(false);
  });

  test('preserves a nonblank PNG without sampling away a small detail above 1024 pixels', async () => {
    const rgba = solid(2048, 2, [0, 0, 0]);
    fill(rgba, 2048, 2047, 1, 1, 1, [255, 255, 255]);
    const png = rgbaToPng(rgba, 2048, 2).toString('base64');
    const hostCapture = jest.fn(async (): Promise<HostCaptureResult> => ({ ok: false, error: 'should not be called' }));
    const { tools } = makeTools(hostCapture, async () => ({
      success: true, encoding: 'png', width: 2048, height: 2, data: png,
    }));

    const result = await tools.captureScreenshot('instance:test', 'png');
    const image = result.content.find((item) => 'data' in item);
    expect(image && 'data' in image && image.data).toBe(png);
    expect(hostCapture).not.toHaveBeenCalled();
  });

  test('preserves a healthy 5K PNG above the asset decoder pixel limit', async () => {
    const width = 5120, height = 2880;
    const rgba = Buffer.alloc(width * height * 4, 255);
    rgba[0] = 0;
    const png = rgbaToPng(rgba, width, height).toString('base64');
    const hostCapture = jest.fn(async (): Promise<HostCaptureResult> => ({ ok: false, error: 'host capture disabled' }));
    const { tools } = makeTools(hostCapture, async (endpoint) => {
      if (endpoint !== '/api/capture-studio') throw new Error(`Unexpected fallback request ${endpoint}`);
      return { success: true, encoding: 'png', width, height, data: png };
    });

    const result = await tools.captureScreenshot('instance:test', 'png');
    const image = result.content.find((item) => 'data' in item);
    expect(image && 'data' in image && image.data).toBe(png);
    expect(hostCapture).not.toHaveBeenCalled();
  });

  test.each(['hide', 'finish'] as const)('discards the host image when its %s operation loses transaction ownership', async (failureAction) => {
    const markerState = { shown: false };
    const studio = studioThatReturnsBlackPlayFrames(markerState);
    const hostCapture = jest.fn(async (): Promise<HostCaptureResult> => hostWindow(studioWindow(400, 200, viewport, markerState.shown), 400, 200));
    const { tools } = makeTools(hostCapture, async (endpoint, data) => {
      const action = typeof data === 'object' && data !== null && 'action' in data ? data.action : undefined;
      if (endpoint === '/api/capture-markers') {
        if (action === 'finish') markerState.shown = false;
        if (action === failureAction) {
          return action === 'hide' ? { error: 'host capture token expired' } : { success: true, stale: true, captureId: 'capture:test' };
        }
      }
      return studio(endpoint, data);
    });

    const result = await tools.captureScreenshot('instance:test', 'png');
    const text = result.content.find((item) => 'text' in item);
    expect(text && 'text' in text && text.text).toContain('expired');
    expect(text && 'text' in text && text.text).not.toContain('Captured from the Studio window through the host OS');
    expect(hostCapture).toHaveBeenCalledTimes(failureAction === 'hide' ? 1 : 2);
    expect(markerState.shown).toBe(false);
  });

  test('keeps a blank PNG with a warning when host capture is unavailable', async () => {
    const png = rgbaToPng(solid(300, 120, [0, 0, 0]), 300, 120).toString('base64');
    const studio = studioThatReturnsBlackPlayFrames({ shown: false });
    const { tools } = makeTools(async () => ({ ok: false, error: 'the Studio window is minimized' }), async (endpoint, data) => {
      if (endpoint === '/api/capture-studio') return { encoding: 'png', width: 300, height: 120, data: png };
      return studio(endpoint, data);
    });

    const result = await tools.captureScreenshot('instance:test', 'png');
    const text = result.content.find((item) => 'text' in item);
    expect(text && 'text' in text && text.text).toContain('may be blank');
    const image = result.content.find((item) => 'data' in item);
    expect(image && 'data' in image && image.data).toBe(png);
  });

  test('fits the host viewport only during capture and restores it on success', async () => {
    const markerState = { shown: false };
    let fitted = false;
    const actions: string[] = [];
    const studio = studioThatReturnsBlackPlayFrames(markerState);
    const { tools } = makeTools(async () => {
      expect(fitted).toBe(true);
      return hostWindow(studioWindow(400, 200, viewport, markerState.shown), 400, 200);
    }, async (endpoint, data) => {
      if (endpoint === '/api/capture-markers' && data !== null && typeof data === 'object' && 'action' in data) {
        actions.push(String(data.action));
        if (data.action === 'prepare') {
          fitted = true;
          return { success: true, captureId: 'capture:1', viewportWidth: 300, viewportHeight: 120 };
        }
        if (data.action === 'finish') {
          expect('captureId' in data && data.captureId).toBe('capture:1');
          fitted = false;
          return { success: true };
        }
        const response = await studio(endpoint, data);
        // Fitting may round the camera's logical width by one pixel. The
        // screenshot must still use the pre-capture input coordinate space.
        return { ...response, viewportWidth: 299 };
      }
      return studio(endpoint, data);
    });

    const result = await tools.captureScreenshot('instance:test', 'png');
    const image = result.content.find((item) => 'data' in item);
    if (!image || !('data' in image) || typeof image.data !== 'string') throw new Error('Expected an image');
    const decoded = decodePngToRgba(Buffer.from(image.data, 'base64'));
    expect([decoded.width, decoded.height]).toEqual([300, 120]);
    expect(fitted).toBe(false);
    expect(actions).toEqual(['prepare', 'query', 'show', 'hide', 'finish']);
  });

  test('restores the viewport even when grabbing the window throws', async () => {
    const actions: string[] = [];
    const studio = studioThatReturnsBlackPlayFrames({ shown: false });
    const { tools } = makeTools(async () => { throw new Error('window grab failed'); }, async (endpoint, data) => {
      if (endpoint === '/api/capture-markers' && data !== null && typeof data === 'object' && 'action' in data) {
        actions.push(String(data.action));
      }
      return studio(endpoint, data);
    });
    const result = await tools.captureScreenshot('instance:test', 'png');
    const text = result.content.find((item) => 'text' in item);
    expect(text && 'text' in text && text.text).toContain('window grab failed');
    expect(actions).toEqual(['prepare', 'query', 'show', 'hide', 'finish']);
  });

  test('serializes concurrent host captures until each viewport restoration completes', async () => {
    const markerState = { shown: false };
    const studio = studioThatReturnsBlackPlayFrames(markerState);
    let active = 0;
    let generation = 0;
    const { tools } = makeTools(async () => {
      expect(active).toBe(1);
      await Promise.resolve();
      return hostWindow(studioWindow(400, 200, viewport, markerState.shown), 400, 200);
    }, async (endpoint, data) => {
      if (endpoint === '/api/capture-markers' && data !== null && typeof data === 'object' && 'action' in data) {
        if (data.action === 'prepare') {
          expect(active).toBe(0);
          active++;
          generation++;
          return { success: true, captureId: `capture:${generation}`, viewportWidth: 300, viewportHeight: 120 };
        }
        if (data.action === 'finish') {
          expect('captureId' in data && data.captureId).toBe(`capture:${generation}`);
          await Promise.resolve();
          active--;
          return { success: true };
        }
      }
      return studio(endpoint, data);
    });

    const results = await Promise.all([
      tools.captureScreenshot('instance:test', 'png'),
      tools.captureScreenshot('instance:test', 'png'),
    ]);
    for (const result of results) {
      const text = result.content.find((item) => 'text' in item);
      expect(text && 'text' in text && text.text).toContain('Captured from the Studio window through the host OS');
    }
    expect(generation).toBe(2);
    expect(active).toBe(0);
  });

  test('re-locates a fitted viewport when its presentation changed without a window resize', async () => {
    const markerState = { shown: false };
    const studio = studioThatReturnsBlackPlayFrames(markerState);
    let rect = viewport;
    const { tools } = makeTools(async () => hostWindow(studioWindow(400, 200, rect, markerState.shown), 400, 200), async (endpoint, data) => {
      const response = await studio(endpoint, data);
      return endpoint === '/api/capture-markers' ? { ...response, viewportChanged: true } : response;
    });
    await tools.captureScreenshot('instance:test', 'png');
    rect = { ...viewport, x: 70 };
    const result = await tools.captureScreenshot('instance:test', 'png');
    const image = result.content.find((item) => 'data' in item);
    if (!image || !('data' in image) || typeof image.data !== 'string') throw new Error('Expected an image');
    const decoded = decodePngToRgba(Buffer.from(image.data, 'base64'));
    expect(decoded.rgba).toEqual(studioWindow(300, 120, { x: 0, y: 0, width: 300, height: 120 }, false));
  });

  test('reuses the located viewport rect for the next capture (one window grab, no markers)', async () => {
    const markerState = { shown: false };
    let grabs = 0;
    const hostCapture: HostWindowCaptureFn = async () => {
      grabs++;
      return hostWindow(studioWindow(400, 200, viewport, markerState.shown), 400, 200);
    };
    const { tools, request } = makeTools(hostCapture, studioThatReturnsBlackPlayFrames(markerState));

    await tools.captureScreenshot('instance:test', 'png');
    expect(grabs).toBe(2);
    request.mockClear();
    await tools.captureScreenshot('instance:test', 'png');
    expect(grabs).toBe(3);
    const markerActions = request.mock.calls
      .filter(([endpoint]) => endpoint === '/api/capture-markers')
      .map(([, data]) => (data as { action: string }).action);
    expect(markerActions).toEqual(['prepare', 'query', 'finish']);
  });

  test('re-locates the viewport when the Studio window size changes', async () => {
    const markerState = { shown: false };
    let windowWidth = 400;
    const hostCapture: HostWindowCaptureFn = async () => hostWindow(studioWindow(windowWidth, 200, viewport, markerState.shown), windowWidth, 200);
    const { tools, request } = makeTools(hostCapture, studioThatReturnsBlackPlayFrames(markerState));

    await tools.captureScreenshot('instance:test', 'png');
    windowWidth = 500;
    request.mockClear();
    const result = await tools.captureScreenshot('instance:test', 'png');
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.width).toBe(300);
    const markerActions = request.mock.calls
      .filter(([endpoint]) => endpoint === '/api/capture-markers')
      .map(([, data]) => (data as { action: string }).action);
    expect(markerActions).toEqual(['prepare', 'query', 'show', 'hide', 'finish']);
  });

  test('falls back to the host window when Studio-side capture fails outright', async () => {
    const markerState = { shown: false };
    const hostCapture: HostWindowCaptureFn = async () => hostWindow(studioWindow(400, 200, viewport, markerState.shown), 400, 200);
    const studio = studioThatReturnsBlackPlayFrames(markerState);
    const { tools } = makeTools(hostCapture, async (endpoint, data) => {
      if (endpoint === '/api/capture-read') {
        return { error: 'Failed to create EditableImage from screenshot. (cannot currently create editable image from temporary texture id)' };
      }
      return studio(endpoint, data);
    });

    const result = await tools.captureScreenshot('instance:test', 'jpeg');
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.error).toBeUndefined();
    expect(text.message).toContain("Studio's capture failed (Failed to create EditableImage");
    expect((result.content[1] as { mimeType: string }).mimeType).toBe('image/jpeg');
  });

  test('falls back to the host window when the play client cannot even begin a capture (occluded window)', async () => {
    const markerState = { shown: false };
    const studio = studioThatReturnsBlackPlayFrames(markerState);
    const hostCapture: HostWindowCaptureFn = async () => hostWindow(studioWindow(400, 200, viewport, markerState.shown), 400, 200);
    const { tools, request } = makeTools(hostCapture, async (endpoint, data) => {
      if (endpoint === '/api/capture-begin') return { error: 'Screenshot capture timed out (CaptureScreenshot callback never fired).' };
      return studio(endpoint, data);
    });

    const result = await tools.captureScreenshot('instance:test', 'png');
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.source).toBe('host-window');
    expect(text.message).toContain("Studio's capture failed (Screenshot capture timed out (CaptureScreenshot callback never fired).)");
    expect(request.mock.calls.some(([endpoint]) => endpoint === '/api/capture-read')).toBe(false);
  });

  test('keeps the Studio error and explains why the host fallback could not help', async () => {
    const markerState = { shown: false };
    const hostCapture: HostWindowCaptureFn = async () => ({ ok: false, error: 'host window capture is only implemented on Windows (this is darwin)' });
    const studio = studioThatReturnsBlackPlayFrames(markerState);
    const { tools } = makeTools(hostCapture, async (endpoint, data) => {
      if (endpoint === '/api/capture-read') return { error: 'Screenshot capture timed out' };
      return studio(endpoint, data);
    });

    const result = await tools.captureScreenshot('instance:test');
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.error).toContain('Screenshot capture timed out');
    expect(text.error).toContain('Host window capture also failed: host window capture is only implemented on Windows');
    expect(text.error).toContain('peer tried: client-1');
    expect(text.peer).toBe('client-1');
  });

  test('explains a marker miss with marker counts, capture method, emulation state and the peer tried', async () => {
    const markerState = { shown: false };
    const hostCapture: HostWindowCaptureFn = async () =>
      hostWindow(studioWindow(400, 200, viewport, false), 400, 200, { method: 'screen', foreground: true, magentaPixels: { printwindow: 0, screen: 0 } });
    const studio = studioThatReturnsBlackPlayFrames(markerState);
    const { tools } = makeTools(hostCapture, async (endpoint, data) => {
      if (endpoint === '/api/capture-read') return { error: 'Screenshot capture timed out' };
      if (endpoint === '/api/capture-markers') {
        const base = await studio(endpoint, data) as Record<string, unknown>;
        return { ...base, framesRendered: 3, emulation: { active: true, deviceId: 'hd_720', resolution: { width: 1280, height: 720 } } };
      }
      return studio(endpoint, data);
    });

    const result = await tools.captureScreenshot('instance:test');
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.error).toContain('no viewport markers were visible');
    expect(text.error).toContain('branch: none');
    expect(text.error).toContain('marker pixels in the analysed grab: 0');
    expect(text.error).toContain('magenta pixels per method: printwindow=0, screen=0');
    expect(text.error).toContain('via screen, foreground=true');
    expect(text.error).toContain('device emulation: on (hd_720 1280x720)');
    expect(text.error).toContain('peer: client-1');
    expect(text.error).toContain('peer tried: client-1');
  });

  test('fallback:"window" returns the uncropped Studio window plus the viewport rect', async () => {
    const markerState = { shown: false };
    let studioCaptureCalls = 0;
    const hostCapture: HostWindowCaptureFn = async () => hostWindow(studioWindow(400, 200, viewport, markerState.shown), 400, 200);
    const studio = studioThatReturnsBlackPlayFrames(markerState);
    const { tools } = makeTools(hostCapture, async (endpoint, data) => {
      if (endpoint === '/api/capture-studio' || endpoint === '/api/capture-begin' || endpoint === '/api/capture-read') studioCaptureCalls++;
      return studio(endpoint, data);
    });

    const result = await tools.captureScreenshot('instance:test', 'png', undefined, undefined, 'window');
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.error).toBeUndefined();
    expect(text.width).toBe(400);
    expect(text.height).toBe(200);
    expect(text.cropped).toBe(false);
    expect(text.source).toBe('host-window');
    expect(text.viewportRect).toEqual({ x: 60, y: 50, width: 300, height: 120 });
    expect(text.message).toContain('fallback: "window"');
    expect(studioCaptureCalls).toBe(0);
  });

  test('fallback:"window" still returns the window when the markers cannot be located', async () => {
    const markerState = { shown: false };
    const hostCapture: HostWindowCaptureFn = async () => hostWindow(studioWindow(400, 200, viewport, false), 400, 200);
    const { tools } = makeTools(hostCapture, studioThatReturnsBlackPlayFrames(markerState));

    const result = await tools.captureScreenshot('instance:test', 'png', undefined, undefined, 'window');
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.error).toBeUndefined();
    expect(text.width).toBe(400);
    expect(text.cropped).toBe(false);
    expect(text.viewportRect).toBeUndefined();
    expect(text.message).toContain('The viewport could not be located: no viewport markers');
  });

  test('target selects the peer explicitly and rejects peers that cannot render', async () => {
    const markerState = { shown: false };
    const hostCapture: HostWindowCaptureFn = async () => hostWindow(studioWindow(400, 200, viewport, markerState.shown), 400, 200);
    const captureRoles: string[] = [];
    const studio = studioThatReturnsBlackPlayFrames(markerState);
    const { tools } = makeTools(hostCapture, async (endpoint, data, ...rest) => {
      if (endpoint === '/api/capture-studio') captureRoles.push(String(rest[0]));
      return studio(endpoint, data);
    });

    const explicit = await tools.captureScreenshot('instance:test', 'png', undefined, 'client-1');
    const explicitText = JSON.parse((explicit.content[0] as { text: string }).text);
    expect(explicitText.peer).toBe('client-1');
    expect(explicitText.target).toBe('client-1');

    const edit = await tools.captureScreenshot('instance:test', 'png', undefined, 'edit');
    const editText = JSON.parse((edit.content[0] as { text: string }).text);
    expect(editText.peer).toBe('edit');
    expect(captureRoles).toEqual(['client-session', 'edit-session']);

    await expect(tools.captureScreenshot('instance:test', 'png', undefined, 'server')).rejects.toThrow(/target "server".*does not render a viewport.*client-1/);
    await expect(tools.captureScreenshot('instance:test', 'png', undefined, 'client-7')).rejects.toThrow(/client-7.*not connected.*client-1/);
    await expect(tools.captureScreenshot('instance:test', 'png', undefined, undefined, 'screen')).rejects.toThrow(/fallback must be/);
  });

  test('returns the blank frame with a warning when the host fallback is unavailable', async () => {
    const markerState = { shown: false };
    const hostCapture: HostWindowCaptureFn = async () => ({ ok: false, error: 'the Studio window is minimized' });
    const { tools } = makeTools(hostCapture, studioThatReturnsBlackPlayFrames(markerState));

    const result = await tools.captureScreenshot('instance:test');
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.error).toBeUndefined();
    expect(text.message).toContain('host window capture also failed (the Studio window is minimized)');
    expect(text.message).toContain('may be blank');
  });

  test('does not touch the host when Studio returns a real frame', async () => {
    let grabs = 0;
    const hostCapture: HostWindowCaptureFn = async () => {
      grabs++;
      return { ok: false, error: 'should not be called' };
    };
    const realFrame = studioWindow(300, 120, { x: 0, y: 0, width: 300, height: 120 }, false).toString('base64');
    const { tools, request } = makeTools(hostCapture, async (endpoint) => {
      if (endpoint === '/api/capture-studio') return { unavailable: 'no' };
      if (endpoint === '/api/capture-begin') return { contentId: 'rbxtemp://1' };
      if (endpoint === '/api/capture-read') {
        return { success: true, encoding: 'rgba8', width: 300, height: 120, nativeWidth: 300, nativeHeight: 120, data: realFrame };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    });

    const result = await tools.captureScreenshot('instance:test', 'png');
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.message).not.toContain('host OS');
    expect(grabs).toBe(0);
    expect(request.mock.calls.some(([endpoint]) => endpoint === '/api/capture-markers')).toBe(false);
  });
});

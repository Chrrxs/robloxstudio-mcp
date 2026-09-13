import {
  cropToViewport,
  findViewportRect,
  isHostCaptureDisabled,
  isUniformFrame,
} from '../host-capture.js';
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import type { HostWindowCaptureFn } from '../tools/index.js';
import { StudioHttpClient } from '../tools/studio-client.js';

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
    fill(rgba, width, viewport.x, viewport.y, markerSize, markerSize, magenta);
    fill(rgba, width, right, viewport.y, markerSize, markerSize, magenta);
    fill(rgba, width, viewport.x, bottom, markerSize, markerSize, magenta);
    fill(rgba, width, right, bottom, markerSize, markerSize, magenta);
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
    expect(findViewportRect(rgba, 400, 200, hint)).toEqual({ rect: { x: 50, y: 30, width: 300, height: 120 } });
  });

  test('ignores magenta inside the viewport (game UI can be any colour)', () => {
    const rgba = studioWindow(400, 200, { x: 50, y: 30, width: 300, height: 120 }, true);
    fill(rgba, 400, 120, 60, 40, 20, [255, 0, 255]);
    expect(findViewportRect(rgba, 400, 200, hint)).toEqual({ rect: { x: 50, y: 30, width: 300, height: 120 } });
  });

  test('accepts a DPI-scaled viewport whose box is a uniform multiple of the logical size', () => {
    const rgba = studioWindow(800, 400, { x: 100, y: 60, width: 600, height: 240 }, true, 24);
    expect(findViewportRect(rgba, 800, 400, { ...hint, markerSize: 24 })).toEqual({ rect: { x: 100, y: 60, width: 600, height: 240 } });
  });

  test('fails clearly when no markers are visible', () => {
    const rgba = studioWindow(400, 200, { x: 50, y: 30, width: 300, height: 120 }, false);
    expect(findViewportRect(rgba, 400, 200, hint)).toEqual({ error: expect.stringContaining('no viewport markers') });
  });

  test('rejects a box stretched by stray magenta in Studio chrome', () => {
    const rgba = studioWindow(400, 200, { x: 50, y: 30, width: 300, height: 120 }, true);
    fill(rgba, 400, 5, 180, 3, 3, [255, 0, 255]);
    expect(findViewportRect(rgba, 400, 200, hint)).toEqual({ error: expect.stringContaining('do not form a rectangle') });
  });

  test('rejects a box whose aspect does not match the reported viewport', () => {
    const rgba = studioWindow(400, 200, { x: 50, y: 30, width: 300, height: 120 }, true);
    expect(findViewportRect(rgba, 400, 200, { ...hint, viewportHeight: 60 })).toEqual({ error: expect.stringContaining('aspect') });
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
      if (endpoint === '/api/capture-read') {
        return { success: true, encoding: 'rgba8', width: 300, height: 120, nativeWidth: 300, nativeHeight: 120, data: blackFrame };
      }
      if (endpoint === '/api/capture-markers') {
        const action = (data as { action: string }).action;
        if (action === 'show') markerState.shown = true;
        if (action === 'hide') markerState.shown = false;
        return { success: true, viewportWidth: 300, viewportHeight: 120, markerSize: 12 };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
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
    const hostCapture: HostWindowCaptureFn = async (titleHint) => {
      hostCalls.push(`${titleHint}|markers=${markerState.shown}`);
      return { ok: true, capture: { width: 400, height: 200, title: 'TestPlace - Roblox Studio', rgba: studioWindow(400, 200, viewport, markerState.shown) } };
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

    // Markers on for the locating grab, off for the clean grab, and hidden afterwards.
    expect(hostCalls).toEqual(['TestPlace|markers=true', 'TestPlace|markers=false']);
    expect(markerState.shown).toBe(false);
    const markerActions = request.mock.calls
      .filter(([endpoint]) => endpoint === '/api/capture-markers')
      .map(([, data]) => (data as { action: string }).action);
    expect(markerActions).toEqual(['query', 'show', 'hide']);
    // Marker calls follow the rendering peer (the play client), never the edit DM.
    for (const call of request.mock.calls.filter(([endpoint]) => endpoint === '/api/capture-markers')) {
      expect(call[2]).toBe('client-session');
    }
  });

  test('reuses the located viewport rect for the next capture (one window grab, no markers)', async () => {
    const markerState = { shown: false };
    let grabs = 0;
    const hostCapture: HostWindowCaptureFn = async () => {
      grabs++;
      return { ok: true, capture: { width: 400, height: 200, title: 't', rgba: studioWindow(400, 200, viewport, markerState.shown) } };
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
    expect(markerActions).toEqual(['query']);
  });

  test('re-locates the viewport when the Studio window size changes', async () => {
    const markerState = { shown: false };
    let windowWidth = 400;
    const hostCapture: HostWindowCaptureFn = async () => ({
      ok: true,
      capture: { width: windowWidth, height: 200, title: 't', rgba: studioWindow(windowWidth, 200, viewport, markerState.shown) },
    });
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
    expect(markerActions).toEqual(['query', 'show', 'hide']);
  });

  test('falls back to the host window when Studio-side capture fails outright', async () => {
    const markerState = { shown: false };
    const hostCapture: HostWindowCaptureFn = async () => ({
      ok: true,
      capture: { width: 400, height: 200, title: 't', rgba: studioWindow(400, 200, viewport, markerState.shown) },
    });
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

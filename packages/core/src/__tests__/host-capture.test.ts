import {
  cropToViewport,
  findViewportRect,
  hostEnvironment,
  isHostCaptureDisabled,
  isHostCapturePreferred,
  isHostCaptureSupported,
  hostCaptureUnsupportedReason,
  isUniformFrame,
  saveViewportMarkerFrame,
  windowsCaptureEnvironment,
} from '../host-capture.js';
import type { HostCaptureResult } from '../host-capture.js';
import { LINUX_NO_STUDIO_DISPLAY_ERROR } from '../host-capture-linux.js';
import * as hostCaptureModule from '../host-capture.js';
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import type { HostWindowCaptureFn } from '../tools/index.js';
import { StudioHttpClient } from '../tools/studio-client.js';
import { StudioInstanceManager } from '../studio-instance-manager.js';
import { rgbaToPng } from '../png-encoder.js';
import { decodePngToRgba } from '../image-decode.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

function errorOf(result: { rect: unknown } | { error: string }): string {
  if (!('error' in result)) throw new Error(`expected an error, got ${JSON.stringify(result)}`);
  return result.error;
}

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

  test('ignores stray magenta in Studio chrome outside the viewport', () => {
    const rgba = studioWindow(400, 200, { x: 50, y: 30, width: 300, height: 120 }, true);
    fill(rgba, 400, 5, 180, 3, 3, [255, 0, 255]);
    expect(findViewportRect(rgba, 400, 200, hint)).toEqual({ rect: { x: 50, y: 30, width: 300, height: 120 } });
  });

  test('ignores a thin marker-coloured strip next to the four markers (iPad Fit to Window)', () => {
    const viewport = { x: 20, y: 40, width: 1180, height: 820 };
    const rgba = studioWindow(1220, 1030, viewport, true);
    fill(rgba, 1220, 604, 264, 3, 756, [255, 0, 255]);
    expect(findViewportRect(rgba, 1220, 1030, { viewportWidth: 1180, viewportHeight: 820, markerSize: 12 })).toEqual({ rect: viewport });
  });

  test('accepts markers merged with magenta game UI at a corner, as before', () => {
    const rgba = studioWindow(400, 200, { x: 50, y: 30, width: 300, height: 120 }, true);
    fill(rgba, 400, 50, 30, 80, 12, [255, 0, 255]);
    expect(findViewportRect(rgba, 400, 200, hint)).toEqual({ rect: { x: 50, y: 30, width: 300, height: 120 } });
  });

  test('reports what it saw when only a strip of marker colour is in the frame', () => {
    const rgba = studioWindow(1220, 1030, { x: 20, y: 40, width: 1180, height: 820 }, false);
    fill(rgba, 1220, 604, 264, 3, 756, [255, 0, 255]);
    const error = errorOf(findViewportRect(rgba, 1220, 1030, { viewportWidth: 1180, viewportHeight: 820, markerSize: 12 }));
    expect(error).toContain('do not form a rectangle');
    expect(error).toContain('2268 marker pixels in 1 blob (3x756 at 604,264), 0 marker-shaped');
    expect(error).toContain('expected four 12 px squares at the corners of the 1180x820 viewport');
  });

  test('lists a bounded number of blobs in the failure', () => {
    const rgba = solid(400, 200, [60, 60, 60]);
    for (let i = 0; i < 12; i++) fill(rgba, 400, 10 + i * 30, 10, 1, 20, [255, 0, 255]);
    const error = errorOf(findViewportRect(rgba, 400, 200, hint));
    expect(error).toContain('240 marker pixels in 12 blobs (');
    expect(error.match(/1x20 at/g)).toHaveLength(8);
    expect(error).toContain(', ...)');
  });

  test('rejects a box whose aspect does not match the reported viewport', () => {
    const rgba = studioWindow(400, 200, { x: 50, y: 30, width: 300, height: 120 }, true);
    expect(findViewportRect(rgba, 400, 200, { ...hint, viewportHeight: 60 })).toEqual({ error: expect.stringContaining('aspect') });
  });
});

// The plugin's current layout: squares centred on each viewport edge.
function edgeMarkers(rgba: Buffer, width: number, viewport: { x: number; y: number; width: number; height: number }, size: number): void {
  const magenta: [number, number, number] = [255, 0, 255];
  const midX = viewport.x + Math.round((viewport.width - size) / 2);
  const midY = viewport.y + Math.round((viewport.height - size) / 2);
  fill(rgba, width, viewport.x, midY, size, size, magenta);
  fill(rgba, width, viewport.x + viewport.width - size, midY, size, size, magenta);
  fill(rgba, width, midX, viewport.y, size, size, magenta);
  fill(rgba, width, midX, viewport.y + viewport.height - size, size, size, magenta);
}

describe('findViewportRect with edge markers', () => {
  test('locates the viewport from markers centred on its edges', () => {
    const viewport = { x: 50, y: 30, width: 301, height: 121 };
    const rgba = studioWindow(400, 200, viewport, false);
    edgeMarkers(rgba, 400, viewport, 12);
    expect(findViewportRect(rgba, 400, 200, { viewportWidth: 301, viewportHeight: 121, markerSize: 12, markerLayout: 'edges' }))
      .toEqual({ rect: viewport });
  });

  test('finds a Fit to Window iPad viewport whose rounded screen hides the corners (#183)', () => {
    // Live frame: 1179x819 viewport drawn at about 0.64 scale inside a device
    // frame whose rounded screen corners leave only 3x3 slivers of corner colour.
    const viewport = { x: 162, y: 238, width: 760, height: 528 };
    const rgba = studioWindow(1280, 891, viewport, false);
    edgeMarkers(rgba, 1280, viewport, 8);
    fill(rgba, 1280, 167, 243, 3, 3, [255, 0, 255]);
    fill(rgba, 1280, 167, 761, 3, 3, [255, 0, 255]);
    expect(findViewportRect(rgba, 1280, 891, { viewportWidth: 1179, viewportHeight: 819, markerSize: 12, markerLayout: 'edges' }))
      .toEqual({ rect: viewport });
  });

  test('ignores magenta game UI that lines up with one pair of markers', () => {
    const viewport = { x: 50, y: 30, width: 300, height: 120 };
    const rgba = studioWindow(400, 200, viewport, false);
    edgeMarkers(rgba, 400, viewport, 12);
    fill(rgba, 400, 120, 84, 12, 12, [255, 0, 255]);
    expect(findViewportRect(rgba, 400, 200, { viewportWidth: 300, viewportHeight: 120, markerSize: 12, markerLayout: 'edges' }))
      .toEqual({ rect: viewport });
  });

  test('says where it expected the markers when only corner squares are visible', () => {
    const rgba = studioWindow(400, 200, { x: 50, y: 30, width: 300, height: 120 }, true);
    const error = errorOf(findViewportRect(rgba, 400, 200, { viewportWidth: 300, viewportHeight: 120, markerSize: 12, markerLayout: 'edges' }));
    expect(error).toContain('expected four 12 px squares at the middle of the edges of the 300x120 viewport');
  });
});

describe('saveViewportMarkerFrame', () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'viewport-markers-test-'));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('saves an opaque PNG of the frame and keeps only the newest few', () => {
    const rgba = solid(4, 2, [255, 0, 255]);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 0;
    const saved: string[] = [];
    for (let i = 0; i < 4; i++) saved.push(saveViewportMarkerFrame(rgba, 4, 2, 'gfx:capture', directory, 2)!);
    expect(path.dirname(saved[3])).toBe(directory);
    expect(path.basename(saved[3])).toMatch(/^viewport-markers-.*-gfxcapture-[a-z0-9]+\.png$/);
    expect(fs.readdirSync(directory)).toHaveLength(2);
    expect(fs.existsSync(saved[3])).toBe(true);
    const decoded = decodePngToRgba(fs.readFileSync(saved[3]));
    expect(decoded.width).toBe(4);
    expect(decoded.rgba[3]).toBe(255);
    expect(decoded.rgba[0]).toBe(255);
  });

  test('returns undefined instead of throwing when the directory is unusable', () => {
    const blocker = path.join(directory, 'file');
    fs.writeFileSync(blocker, '');
    expect(saveViewportMarkerFrame(solid(2, 2, [0, 0, 0]), 2, 2, 'window', blocker)).toBeUndefined();
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

describe('host capture on WSL', () => {
  afterEach(() => jest.restoreAllMocks());

  test('is supported on WSL with Windows interop and on native Linux (X11), where only native Linux prefers it', () => {
    jest.spyOn(hostEnvironment, 'detectWslWindowsHost').mockReturnValue(true);
    expect(isHostCaptureSupported('linux')).toBe(true);
    expect(isHostCapturePreferred('linux', {})).toBe(false);
    jest.spyOn(hostEnvironment, 'detectWslWindowsHost').mockReturnValue(false);
    const studioDisplay = jest.spyOn(hostEnvironment, 'hasLinuxStudioDisplay').mockReturnValue(true);
    expect(isHostCaptureSupported('linux')).toBe(true);
    expect(isHostCapturePreferred('linux', {})).toBe(true);
    // Without a Studio on an X display, Studio's own capture stays first.
    studioDisplay.mockReturnValue(false);
    expect(isHostCapturePreferred('linux', {})).toBe(false);
    expect(isHostCaptureSupported('win32')).toBe(true);
  });

  test('forwards the helper inputs to powershell.exe through WSLENV', () => {
    const identity = { windowId: 5, processId: 6, bundleIdentifier: 'RobloxStudioBeta' };
    const env = windowsCaptureEnvironment('Place', '/tmp/frame.bgra', identity, true, { WSLENV: 'ORCA_X/u', PATH: '/usr/bin' });
    expect(env.WSLENV).toBe('ORCA_X/u:MCP_CAPTURE_TITLE_HINT/w:MCP_CAPTURE_OUT/pw:MCP_CAPTURE_EXPECTED_IDENTITY/w');
    expect(env).toMatchObject({ MCP_CAPTURE_TITLE_HINT: 'Place', MCP_CAPTURE_OUT: '/tmp/frame.bgra', PATH: '/usr/bin' });
    expect(windowsCaptureEnvironment('Place', 'C:\\t.bgra', undefined, false, {}).WSLENV).toBeUndefined();
  });
});

describe('capture_screenshot host window fallback', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(() => {
    // Exercise the supported fallback independently of the test runner's OS.
    Object.defineProperty(process, 'platform', { value: 'win32' });
    // A 'linux' platform means native Linux here, even when the runner is WSL.
    jest.spyOn(hostEnvironment, 'detectWslWindowsHost').mockReturnValue(false);
    jest.spyOn(hostEnvironment, 'hasLinuxStudioDisplay').mockReturnValue(true);
    jest.replaceProperty(process, 'env', { ...process.env, ROBLOX_STUDIO_HOST_CAPTURE: '1' });
    // Capture tests use synthetic peers, never the user's managed Studio state.
    jest.spyOn(StudioInstanceManager.prototype, 'pendingLaunches').mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(process, 'platform', platformDescriptor);
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
  const windowIdentity = { windowId: 456, processId: 123, bundleIdentifier: 'com.roblox.RobloxStudio' };
  const blackFrame = solid(300, 120, [0, 0, 0]).toString('base64');

  function studioThatReturnsBlackPlayFrames(markerState: { shown: boolean }) {
    return async (endpoint: string, data: unknown) => {
      if (endpoint === '/api/capture-studio') return { unavailable: 'StudioCaptureService cannot capture this DataModel right now' };
      if (endpoint === '/api/capture-begin') return { contentId: 'rbxtemp://1' };
      if (endpoint === '/api/capture-read') {
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

  // 'linux' is native Linux with no Studio on an X display (a container, a
  // remote server, WSL whose interop detection failed).
  test.each(['linux', 'freebsd', 'disabled'] as const)('does not prepare markers or scaling when host capture is %s', async (mode) => {
    if (mode === 'disabled') process.env.ROBLOX_STUDIO_HOST_CAPTURE = '0';
    else Object.defineProperty(process, 'platform', { value: mode });
    if (mode === 'linux') jest.spyOn(hostEnvironment, 'hasLinuxStudioDisplay').mockReturnValue(false);
    const hostCapture = jest.fn(async (): Promise<HostCaptureResult> => ({ ok: false, error: 'must not run' }));
    const { tools, request } = makeTools(hostCapture, studioThatReturnsBlackPlayFrames({ shown: false }));

    const result = await tools.captureScreenshot('instance:test', 'png');
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.message).toContain({
      linux: LINUX_NO_STUDIO_DISPLAY_ERROR,
      freebsd: hostCaptureUnsupportedReason('freebsd'),
      disabled: 'disabled by ROBLOX_STUDIO_HOST_CAPTURE',
    }[mode]);
    expect(text.message).toContain('may be blank');
    expect(text.source).toBe('CaptureService');
    expect(text.studioFastPathUnavailable).toBe('StudioCaptureService cannot capture this DataModel right now');
    expect(hostCapture).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([endpoint]) => endpoint === '/api/capture-markers')).toBe(false);
    const image = result.content.find((item) => 'data' in item);
    if (!image || !('data' in image) || typeof image.data !== 'string') throw new Error('Expected original blank frame');
    const decoded = decodePngToRgba(Buffer.from(image.data, 'base64'));
    expect(isUniformFrame(decoded.rgba, decoded.width, decoded.height)).toBe(true);
  });

  test('prepares the default host helper before opening the marker transaction', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const markerState = { shown: false };
    const events: string[] = [];
    const prepare = jest.spyOn(hostCaptureModule, 'prepareHostWindowCapture').mockImplementation(async () => {
      events.push('helper-ready');
    });
    const capture = jest.spyOn(hostCaptureModule, 'captureStudioWindow').mockImplementation(async () => ({
      ok: true,
      capture: { identity: { ...windowIdentity }, width: 400, height: 200, title: 't', rgba: studioWindow(400, 200, viewport, markerState.shown) },
    }));
    const studio = studioThatReturnsBlackPlayFrames(markerState);
    const { tools } = makeTools(hostCaptureModule.captureStudioWindow, async (endpoint, data) => {
      if (endpoint === '/api/capture-markers') events.push((data as { action: string }).action);
      return studio(endpoint, data);
    });
    const result = await tools.captureScreenshot('instance:test', 'png');
    expect(JSON.parse((result.content[0] as { text: string }).text).source).toBe('host-window');
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['helper-ready', 'prepare', 'query', 'show', 'hide', 'finish']);
  });

  test('does not mutate the viewport when default host helper preparation fails', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    jest.spyOn(hostCaptureModule, 'prepareHostWindowCapture').mockRejectedValue(new Error('Swift compiler failed'));
    const capture = jest.spyOn(hostCaptureModule, 'captureStudioWindow').mockRejectedValue(new Error('must not capture'));
    const { tools, request } = makeTools(hostCaptureModule.captureStudioWindow, studioThatReturnsBlackPlayFrames({ shown: false }));
    const result = await tools.captureScreenshot('instance:test', 'png');
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.message).toContain('could not prepare host capture: Swift compiler failed');
    expect(text.source).toBe('CaptureService');
    expect(capture).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([endpoint]) => endpoint === '/api/capture-markers')).toBe(false);
  });

  test('does not prepare a native helper for an injected host capture backend', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const prepare = jest.spyOn(hostCaptureModule, 'prepareHostWindowCapture').mockRejectedValue(new Error('must not compile'));
    const { tools } = makeTools(async () => ({ ok: false, error: 'synthetic capture failure' }), studioThatReturnsBlackPlayFrames({ shown: false }));
    const result = await tools.captureScreenshot('instance:test', 'png');
    expect(JSON.parse((result.content[0] as { text: string }).text).message).toContain('synthetic capture failure');
    expect(prepare).not.toHaveBeenCalled();
  });

  test.each([
    [{ error: 'Screenshot callback timed out' }, 'Screenshot callback timed out'],
    [{}, 'no content id returned from client'],
  ])('uses the common host fallback after capture-begin returns %j', async (begin, reason) => {
    const markerState = { shown: false };
    const studio = studioThatReturnsBlackPlayFrames(markerState);
    const hostCapture = jest.fn(async (): Promise<HostCaptureResult> => ({
      ok: true,
      capture: { width: 400, height: 200, title: 't', rgba: studioWindow(400, 200, viewport, markerState.shown) },
    }));
    const { tools, request } = makeTools(hostCapture, async (endpoint, data) => {
      if (endpoint === '/api/capture-begin') return begin;
      return studio(endpoint, data);
    });

    const result = await tools.captureScreenshot('instance:test', 'png');
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.error).toBeUndefined();
    expect(text.message).toContain(reason);
    expect(text.source).toBe('host-window');
    expect(text.studioFastPathUnavailable).toBe('StudioCaptureService cannot capture this DataModel right now');
    expect([text.width, text.height]).toEqual([300, 120]);
    expect(hostCapture).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.some(([endpoint]) => endpoint === '/api/capture-read')).toBe(false);
    expect(markerState.shown).toBe(false);
  });

  test('preserves a capture-begin error and fast-path reason when host capture is unsupported', async () => {
    Object.defineProperty(process, 'platform', { value: 'freebsd' });
    const hostCapture = jest.fn(async (): Promise<HostCaptureResult> => ({ ok: false, error: 'must not run' }));
    const { tools, request } = makeTools(hostCapture, async (endpoint) => {
      if (endpoint === '/api/capture-studio') return { unavailable: 'Client capture unavailable' };
      if (endpoint === '/api/capture-begin') return { error: 'Screenshot callback timed out' };
      throw new Error(`Unexpected endpoint ${endpoint}`);
    });
    const result = await tools.captureScreenshot('instance:test', 'png');
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.error).toContain('Screenshot callback timed out');
    expect(text.error).toContain(hostCaptureUnsupportedReason('freebsd'));
    expect(text.studioFastPathUnavailable).toBe('Client capture unavailable');
    expect(hostCapture).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([endpoint]) => endpoint === '/api/capture-markers')).toBe(false);
  });

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
    expect(markerActions).toEqual(['prepare', 'query', 'show', 'hide', 'finish']);
    // Marker calls follow the rendering peer (the play client), never the edit DM.
    for (const call of request.mock.calls.filter(([endpoint]) => endpoint === '/api/capture-markers')) {
      expect(call[2]).toBe('client-session');
    }
  });

  test('on Linux grabs the window of a Studio missing from the registry, then goes host-first', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    jest.spyOn(StudioInstanceManager.prototype, 'get').mockResolvedValue(undefined);
    const markerState = { shown: false };
    const hintedProcessIds: Array<number | undefined> = [];
    const hostCapture: HostWindowCaptureFn = async (_titleHint, _identity, options) => {
      hintedProcessIds.push(options?.processId);
      return { ok: true, capture: { width: 400, height: 200, title: 't', identity: windowIdentity, rgba: studioWindow(400, 200, viewport, markerState.shown) } };
    };
    const { tools, request } = makeTools(hostCapture, studioThatReturnsBlackPlayFrames(markerState));
    const capture = async () => {
      const [summary] = (await tools.captureScreenshot('instance:test', 'png')).content;
      if (!('text' in summary) || typeof summary.text !== 'string') throw new Error('Expected a text summary');
      return JSON.parse(summary.text);
    };

    expect(await capture()).toMatchObject({ source: 'host-window', width: 300, height: 120, studioFastPathUnavailable: 'StudioCaptureService cannot capture this DataModel right now' });
    expect(request.mock.calls.map(([endpoint]) => endpoint)).not.toContain('/api/capture-begin');

    request.mockClear();
    expect((await capture()).source).toBe('host-window');
    expect(request.mock.calls.map(([endpoint]) => endpoint)).not.toContain('/api/capture-studio');
    expect(hintedProcessIds.at(-1)).toBe(windowIdentity.processId);
  });

  test('replaces a successful but black StudioCaptureService PNG with the host viewport', async () => {
    const markerState = { shown: false };
    const hostCapture: HostWindowCaptureFn = async () => ({
      ok: true,
      capture: { width: 400, height: 200, title: 't', rgba: studioWindow(400, 200, viewport, markerState.shown) },
    });
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
    expect(text && 'text' in text && text.text).toContain("Studio's StudioCaptureService returned a blank");
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

  describe('Device Simulator screenshots are resampled to the full device screen', () => {
    // iphone_14 LandscapeRight: the 843x388 device screen, a 749x388 safe-area
    // viewport, and a full-screen x of 666 that a click must hit.
    const SCREEN = { screenWidth: 843, screenHeight: 388 };
    const TARGET_X = 666;

    // A 3px white column at the target, drawn into an image whose x axis
    // spans the whole device screen at the given width.
    function frameWithTarget(width: number, height: number): Buffer {
      const rgba = solid(width, height, [0, 0, 0]);
      fill(rgba, width, Math.round(TARGET_X * width / 843) - 1, 0, 3, height, [255, 255, 255]);
      return rgba;
    }

    function brightestColumn(rgba: Buffer, width: number, row: number): number {
      let best = 0;
      for (let x = 1; x < width; x++) {
        if (rgba[(row * width + x) * 4] > rgba[(row * width + best) * 4]) best = x;
      }
      return best;
    }

    async function shoot(requestImpl: (endpoint: string, data: unknown) => Promise<unknown>) {
      const hostCapture = jest.fn(async (): Promise<HostCaptureResult> => ({ ok: false, error: 'should not be called' }));
      const { tools } = makeTools(hostCapture, requestImpl);
      const result = await tools.captureScreenshot('instance:test', 'png');
      const text = JSON.parse((result.content[0] as { text: string }).text);
      const image = result.content.find((item) => 'data' in item);
      if (!image || !('data' in image) || typeof image.data !== 'string') throw new Error(`no image: ${JSON.stringify(text)}`);
      return { text, image: decodePngToRgba(Buffer.from(image.data, 'base64')), hostCapture };
    }

    test.each(['rgba8', 'png'] as const)('StudioCaptureService squeezed %s frame', async (encoding) => {
      const rgba = frameWithTarget(749, 388);
      const data = encoding === 'png' ? rgbaToPng(rgba, 749, 388).toString('base64') : rgba.toString('base64');
      const { text, image } = await shoot(async () => ({
        success: true, encoding, source: 'StudioCaptureService', width: 749, height: 388,
        nativeWidth: 749, nativeHeight: 388, data, ...SCREEN,
      }));

      expect([image.width, image.height, text.width, text.height]).toEqual([843, 388, 843, 388]);
      expect(Math.abs(brightestColumn(image.rgba, 843, 200) - TARGET_X)).toBeLessThanOrEqual(1);
      expect(text.message).toContain('use coordinates as you read them off the image');
      expect(text.message).toContain('covers the full 843x388 device screen');
    });

    test('CaptureService play-client frame takes the screen size from capture-begin', async () => {
      const rgba = frameWithTarget(605, 279);
      const { text, image } = await shoot(async (endpoint) => {
        if (endpoint === '/api/capture-studio') return { unavailable: 'StudioCaptureService cannot capture this DataModel right now' };
        if (endpoint === '/api/capture-begin') return { contentId: 'rbxtemp://1', ...SCREEN };
        if (endpoint === '/api/capture-read') {
          return { success: true, encoding: 'rgba8', width: 605, height: 279, nativeWidth: 605, nativeHeight: 279, data: rgba.toString('base64') };
        }
        throw new Error(`unexpected endpoint ${endpoint}`);
      });

      expect([image.width, image.height]).toEqual([843, 388]);
      expect(Math.abs(brightestColumn(image.rgba, 843, 200) - TARGET_X)).toBeLessThanOrEqual(1);
      expect(text.source).toBe('CaptureService');
      expect(text.message).toContain('covers the full 843x388 device screen');
    });

    test('a plugin-side transport downscale is kept in proportion to the screen', async () => {
      const { text, image } = await shoot(async () => ({
        success: true, encoding: 'rgba8', source: 'StudioCaptureService', width: 600, height: 311,
        nativeWidth: 749, nativeHeight: 388, data: frameWithTarget(600, 311).toString('base64'), ...SCREEN,
      }));

      expect([image.width, image.height]).toEqual([675, 311]);
      expect(text.message).toContain('downscaled from the 843x388');
      expect(text.message).toContain(`multiply x read off this image by ${(843 / 675).toFixed(4)}`);
    });

    test('a capture without screen fields is untouched', async () => {
      const rgba = frameWithTarget(749, 388);
      const { text, image } = await shoot(async () => ({
        success: true, encoding: 'rgba8', source: 'StudioCaptureService', width: 749, height: 388,
        nativeWidth: 749, nativeHeight: 388, data: rgba.toString('base64'),
      }));

      expect([image.width, image.height]).toEqual([749, 388]);
      expect(image.rgba.equals(rgba)).toBe(true);
      expect(text.message).not.toContain('Device Simulator');
    });

    test('a host-window fallback image is untouched', async () => {
      const markerState = { shown: false };
      const studio = studioThatReturnsBlackPlayFrames(markerState);
      const hostCapture: HostWindowCaptureFn = async () => ({
        ok: true, capture: { width: 400, height: 200, title: 'TestPlace - Roblox Studio', rgba: studioWindow(400, 200, viewport, markerState.shown) },
      });
      const { tools } = makeTools(hostCapture, async (endpoint, data) => {
        if (endpoint === '/api/capture-begin') return { contentId: 'rbxtemp://1', ...SCREEN };
        return studio(endpoint, data);
      });

      const result = await tools.captureScreenshot('instance:test', 'png');
      const text = JSON.parse((result.content[0] as { text: string }).text);
      expect([text.width, text.height]).toEqual([300, 120]);
      expect(text.message).toContain('Captured from the Studio window through the host OS');
      expect(text.message).not.toContain('Device Simulator');
    });
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
    const hostCapture = jest.fn(async (): Promise<HostCaptureResult> => ({
      ok: true, capture: { width: 400, height: 200, title: 't', rgba: studioWindow(400, 200, viewport, markerState.shown) },
    }));
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
      return { ok: true, capture: { width: 400, height: 200, title: 't', rgba: studioWindow(400, 200, viewport, markerState.shown) } };
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
      return { ok: true, capture: { width: 400, height: 200, title: 't', rgba: studioWindow(400, 200, viewport, markerState.shown) } };
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
    const { tools } = makeTools(async () => ({
      ok: true, capture: { width: 400, height: 200, title: 't', rgba: studioWindow(400, 200, rect, markerState.shown) },
    }), async (endpoint, data) => {
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
    expect(markerActions).toEqual(['prepare', 'query', 'finish']);
  });

  test.each(['win32', 'darwin'] as const)('pins the clean and cached grabs to the marked window on %s', async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    const markerState = { shown: false };
    const hostCapture = jest.fn<ReturnType<HostWindowCaptureFn>, Parameters<HostWindowCaptureFn>>(async () => ({
      ok: true,
      capture: { identity: { ...windowIdentity }, width: 400, height: 200, title: 't', rgba: studioWindow(400, 200, viewport, markerState.shown) },
    }));
    const { tools, request } = makeTools(hostCapture, studioThatReturnsBlackPlayFrames(markerState));

    const first = await tools.captureScreenshot('instance:test', 'png');
    expect(JSON.parse((first.content[0] as { text: string }).text).source).toBe('host-window');
    request.mockClear();
    const second = await tools.captureScreenshot('instance:test', 'png');
    expect(JSON.parse((second.content[0] as { text: string }).text).source).toBe('host-window');
    expect(hostCapture.mock.calls).toEqual([
      ['TestPlace', undefined, { accept: expect.any(Function) }], ['TestPlace', windowIdentity, {}], ['TestPlace', windowIdentity, {}],
    ]);
    expect(request.mock.calls.filter(([endpoint]) => endpoint === '/api/capture-markers')
      .map(([, data]) => (data as { action: string }).action)).toEqual(['prepare', 'query', 'finish']);
  });

  test.each([
    ['fresh', { ...windowIdentity, windowId: 999 }], ['fresh', undefined],
    ['fresh', { ...windowIdentity, processId: 999 }], ['fresh', { ...windowIdentity, bundleIdentifier: 'another.app' }],
    ['cached', { ...windowIdentity, windowId: 999 }], ['cached', undefined],
    ['cached', { ...windowIdentity, processId: 999 }], ['cached', { ...windowIdentity, bundleIdentifier: 'another.app' }],
  ] as const)('rejects a same-size %s grab with changed or missing window identity %j', async (phase, returnedIdentity) => {
    const markerState = { shown: false };
    const mismatchAt = phase === 'fresh' ? 2 : 3;
    let calls = 0;
    const hostCapture = jest.fn<ReturnType<HostWindowCaptureFn>, Parameters<HostWindowCaptureFn>>(async () => ({
      ok: true,
      capture: {
        identity: ++calls === mismatchAt ? returnedIdentity : { ...windowIdentity }, width: 400, height: 200,
        title: 't', rgba: studioWindow(400, 200, viewport, markerState.shown),
      },
    }));
    const { tools, request } = makeTools(hostCapture, studioThatReturnsBlackPlayFrames(markerState));
    if (phase === 'cached') await tools.captureScreenshot('instance:test', 'png');
    const result = await tools.captureScreenshot('instance:test', 'png');
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.source).toBe('CaptureService');
    expect(text.message).toContain('window identity changed');
    expect(text.message).toContain('may be blank');
    expect(hostCapture.mock.calls[mismatchAt - 1]).toEqual(['TestPlace', windowIdentity, {}]);
    expect(markerState.shown).toBe(false);
    const image = result.content.find((item) => 'data' in item);
    if (!image || !('data' in image) || typeof image.data !== 'string') throw new Error('Expected original blank frame');
    const decoded = decodePngToRgba(Buffer.from(image.data, 'base64'));
    expect(isUniformFrame(decoded.rgba, decoded.width, decoded.height)).toBe(true);
    // Rejected identity invalidates the cache: a retry must locate markers anew.
    request.mockClear();
    const retry = await tools.captureScreenshot('instance:test', 'png');
    expect(JSON.parse((retry.content[0] as { text: string }).text).source).toBe('host-window');
    expect(hostCapture.mock.calls[mismatchAt]).toEqual(['TestPlace', undefined, { accept: expect.any(Function) }]);
    expect(request.mock.calls.filter(([endpoint]) => endpoint === '/api/capture-markers')
      .map(([, data]) => (data as { action: string }).action)).toEqual(['prepare', 'query', 'show', 'hide', 'finish']);
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
    expect(markerActions).toEqual(['prepare', 'query', 'show', 'hide', 'finish']);
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
    const hostCapture: HostWindowCaptureFn = async () => ({ ok: false, error: 'screen recording permission is unavailable' });
    const studio = studioThatReturnsBlackPlayFrames(markerState);
    const { tools } = makeTools(hostCapture, async (endpoint, data) => {
      if (endpoint === '/api/capture-read') return { error: 'Screenshot capture timed out' };
      return studio(endpoint, data);
    });

    const result = await tools.captureScreenshot('instance:test');
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.error).toContain('Screenshot capture timed out');
    expect(text.error).toContain('Host window capture also failed: screen recording permission is unavailable');
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

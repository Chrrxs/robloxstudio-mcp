import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import { StudioHttpClient } from '../tools/studio-client.js';
import { StudioInstanceManager } from '../studio-instance-manager.js';
import { decodePngBase64ToRgba } from '../image-decode.js';

type Reply = Record<string, unknown>;

const parse = (result: { content: Array<{ type: string; text?: string }> }) => JSON.parse(result.content[0].text ?? '{}');

// A solo playtest: edit, server and client-1 peers of one Studio process.
function setup(handler: (endpoint: string) => Reply) {
  const bridge = new BridgeService();
  for (const role of ['edit', 'server', 'client-1']) {
    const peerId = `peer:${role}`;
    const registered = bridge.registerPeer({
      peerId, transportPeerId: peerId, instanceId: 'instance:solo', role,
      placeId: 1, placeName: 'Place', dataModelName: 'Place', isRunning: role !== 'edit',
    });
    if (!registered.ok) throw new Error(registered.error.message);
  }
  const request = jest.spyOn(StudioHttpClient.prototype, 'request')
    .mockImplementation((async (endpoint: string) => handler(endpoint)) as never);
  return { request, tools: new RobloxStudioTools(bridge) };
}

describe('capture_screenshot sequences', () => {
  let shade = 0;
  // Each capture returns a distinct 2x1 frame from Studio's fast path.
  const frameReply = (): Reply => {
    shade += 40;
    return {
      success: true, source: 'StudioCaptureService', encoding: 'rgba8', width: 2, height: 1,
      data: Buffer.from([shade, 0, 0, 255, 0, shade, 0, 255]).toString('base64'),
    };
  };
  const requestedEncodings = (request: jest.SpyInstance) =>
    request.mock.calls.map(([, data]) => (data as { encoding?: string }).encoding);

  beforeEach(() => {
    jest.spyOn(StudioInstanceManager.prototype, 'pendingLaunches').mockResolvedValue([]);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('frames return every client frame in order', async () => {
    const { tools, request } = setup(frameReply);
    const result = await tools.captureScreenshot('instance:solo', 'png', undefined, { frames: 3, interval_ms: 0 });
    const body = parse(result);
    expect(body.frames.map((frame: { frame: number }) => frame.frame)).toEqual([1, 2, 3]);
    expect(result.content.filter((item) => item.type === 'image')).toHaveLength(3);
    expect(request.mock.calls.map(([endpoint, , peer]) => [endpoint, peer])).toEqual(Array(3).fill(['/api/capture-studio', 'peer:client-1']));
    expect(requestedEncodings(request)).toEqual(['png', 'png', 'png']);
  });

  test('grid builds one numbered contact sheet from raw RGBA frames', async () => {
    const { tools, request } = setup(frameReply);
    const result = await tools.captureScreenshot('instance:solo', 'png', undefined, { frames: 4, interval_ms: 0, grid: true });
    const body = parse(result);
    expect(body).toMatchObject({ format: 'png', grid: { columns: 2, rows: 2, tileWidth: 2, tileHeight: 1 } });
    // Studio-encoded PNGs would be decoded at reduced resolution, so a sheet
    // always asks for raw frames and encodes the sheet itself.
    expect(requestedEncodings(request)).toEqual(Array(4).fill('rgba8'));
    const images = result.content.filter((item) => item.type === 'image');
    expect(images).toHaveLength(1);
    const sheet = decodePngBase64ToRgba(images[0].data ?? '');
    expect([sheet.width, sheet.height]).toEqual([body.grid.width, body.grid.height]);
  });

  test('a sequence reports a shared capture note once and the missing fast path', async () => {
    const previous = process.env.ROBLOX_STUDIO_HOST_CAPTURE;
    process.env.ROBLOX_STUDIO_HOST_CAPTURE = '0';
    try {
      // The fast path is unavailable and the fallback returns blank frames, so
      // every frame carries the same "may be blank" warning.
      const { tools } = setup((endpoint) => {
        if (endpoint === '/api/capture-studio') return { unavailable: 'StudioCaptureService cannot capture this DataModel right now' };
        if (endpoint === '/api/capture-begin') return { contentId: 'rbxtemp://1' };
        return { success: true, encoding: 'rgba8', width: 2, height: 1, data: Buffer.alloc(8).toString('base64') };
      });
      for (const grid of [false, true]) {
        const body = parse(await tools.captureScreenshot('instance:solo', 'png', undefined, { frames: 2, interval_ms: 0, grid }));
        expect(body.message.split('may be blank')).toHaveLength(2);
        expect(body.studioFastPathUnavailable).toBe('StudioCaptureService cannot capture this DataModel right now');
      }
    } finally {
      if (previous === undefined) delete process.env.ROBLOX_STUDIO_HOST_CAPTURE;
      else process.env.ROBLOX_STUDIO_HOST_CAPTURE = previous;
    }
  });

  test('frames are spaced by interval_ms', async () => {
    jest.useFakeTimers();
    try {
      const { tools } = setup(frameReply);
      const pending = tools.captureScreenshot('instance:solo', 'png', undefined, { frames: 3, interval_ms: 200 });
      await jest.advanceTimersByTimeAsync(500);
      const body = parse(await pending);
      expect(body.frames.map((frame: { atMs: number }) => frame.atMs)).toEqual([0, 200, 400]);
    } finally {
      jest.useRealTimers();
    }
  });

  test('reports which frame failed', async () => {
    let calls = 0;
    const { tools } = setup(() => (++calls === 2 ? { success: false, error: 'viewport is gone' } : frameReply()));
    const body = parse(await tools.captureScreenshot('instance:solo', 'png', undefined, { frames: 3, interval_ms: 0 }));
    expect(body.error).toContain('frame 2 of 3');
  });

  test.each([
    [{ frames: 0 }, /frames must be an integer from 1 to 16/],
    [{ frames: 17 }, /frames must be an integer from 1 to 16/],
    [{ interval_ms: 6000 }, /interval_ms must be an integer from 0 to 5000/],
    [{ frames: 16, interval_ms: 5000 }, /keep \(frames - 1\) \* interval_ms within/],
  ])('rejects %j before capturing', async (sequence, error) => {
    const { tools, request } = setup(frameReply);
    await expect(tools.captureScreenshot('instance:solo', 'png', undefined, sequence)).rejects.toThrow(error);
    expect(request).not.toHaveBeenCalled();
  });
});

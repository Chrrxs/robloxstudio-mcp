import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BridgeService } from '../bridge-service.js';
import type { HostCaptureResult } from '../host-capture.js';
import { StudioInstanceManager } from '../studio-instance-manager.js';
import { RobloxStudioTools } from '../tools/index.js';
import type { HostWindowCaptureFn } from '../tools/index.js';
import { StudioHttpClient } from '../tools/studio-client.js';
import {
  gfxcaptureCrop,
  parseMediaInfo,
  pruneDefaultVideos,
  recordingArgs,
  stderrSummary,
  storyboardArgs,
  storyboardGrid,
  storyboardTimes,
} from '../video-recorder.js';
import type {
  MediaInfo,
  StartVideoOptions,
  Storyboard,
  StoryboardOptions,
  VideoRecorderBackend,
  VideoRecorderProbe,
  VideoRecordingExit,
  VideoRecordingProcess,
} from '../video-recorder.js';

describe('video recorder helpers', () => {
  test('crops to even dimensions expressed per edge', () => {
    expect(gfxcaptureCrop({ x: 401, y: 170, width: 1357, height: 889 }, 2138, 1360)).toEqual({
      left: 401, top: 170, right: 381, bottom: 302, width: 1356, height: 888,
    });
  });

  test('records the cropped window at a constant frame rate with a duration backstop', () => {
    const args = recordingArgs({
      ffmpegPath: 'ffmpeg', encoder: 'libx264', windowId: 1184600,
      crop: { x: 10, y: 20, width: 300, height: 200 }, frameWidth: 400, frameHeight: 260,
      fps: 30, maxDurationMs: 120_000, outputPath: 'out.mp4',
    });
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toBe(
      'gfxcapture=hwnd=1184600:capture_cursor=0:max_framerate=30:crop_left=10:crop_top=20:crop_right=90:crop_bottom=40,hwdownload,format=bgra[v]',
    );
    expect(args.slice(args.indexOf('-t'), args.indexOf('-t') + 2)).toEqual(['-t', '120.000']);
    expect(args.slice(args.indexOf('-fps_mode'), args.indexOf('-fps_mode') + 4)).toEqual(['-fps_mode', 'cfr', '-r', '30']);
    expect(args).toContain('libx264');
    expect(args[args.length - 1]).toBe('out.mp4');
  });

  test('samples the middle of equal slices and stays inside the video', () => {
    expect(storyboardTimes(0, 3, 5, 3)).toEqual([0.3, 0.9, 1.5, 2.1, 2.7]);
    expect(storyboardTimes(1, 2, 2, 10)).toEqual([1.25, 1.75]);
    expect(storyboardTimes(0, 1, 1, 0.02)).toEqual([0]);
  });

  test('lays frames out in a near-square grid', () => {
    expect(storyboardGrid(1)).toEqual({ columns: 1, rows: 1 });
    expect(storyboardGrid(5)).toEqual({ columns: 3, rows: 2 });
    expect(storyboardGrid(9)).toEqual({ columns: 3, rows: 3 });
    expect(storyboardGrid(10)).toEqual({ columns: 4, rows: 3 });
  });

  test('builds one seeked input per storyboard frame', () => {
    const options: StoryboardOptions = {
      ffmpegPath: 'ffmpeg', inputPath: 'clip.mp4', info: { durationSeconds: 3, width: 1356, height: 888 },
      startSeconds: 0, endSeconds: 3, frames: 2, maxWidth: 1536,
    };
    const args = storyboardArgs(options, 400, 262, [0.75, 2.25]);
    expect(args.filter((arg) => arg === '-ss')).toHaveLength(2);
    expect(args).toContain('0.750');
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('concat=n=2:v=1:a=0,tile=2x1');
  });

  test('reads duration and size from ffmpeg header output', () => {
    const stderr = [
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'crop.mp4':",
      '  Duration: 00:01:02.93, start: 0.000000, bitrate: 147 kb/s',
      '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, unknown/bt709/iec61966-2-1, progressive), 1356x888 [SAR 1:1 DAR 113:74], 142 kb/s, 30 fps',
    ].join('\n');
    expect(parseMediaInfo(stderr)).toEqual({ durationSeconds: 62.93, width: 1356, height: 888 });
    expect(parseMediaInfo('clip.mp4: No such file or directory')).toBeUndefined();
  });

  test('summarizes the root cause of an ffmpeg failure', () => {
    const stderr = [
      '[Parsed_gfxcapture_0 @ 000001e3158d0a80] Failed to setup graphics capture for window (0x80070057)',
      '[Parsed_gfxcapture_0 @ 000001e3158d0a80] Failed to setup graphics capture',
      '[Parsed_gfxcapture_0 @ 000001e3158d0a80] Failed to setup graphics capture',
      '[fc#0 @ 000001e315814380] Error configuring filter graph: Generic error in an external library',
      '[vost#0:0/libx264 @ 000001e3158b9880] [enc:libx264 @ 000001e3158d3600] Could not open encoder before EOF',
    ].join('\r\n');
    expect(stderrSummary(stderr)).toBe(
      'Failed to setup graphics capture for window (0x80070057) | Failed to setup graphics capture | ' +
      'Error configuring filter graph: Generic error in an external library',
    );
  });

  test('prunes only old default recordings beyond the kept count', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-prune-'));
    try {
      const now = Date.now();
      const names = ['studio-video-1.mp4', 'studio-video-2.mp4', 'studio-video-3.mp4', 'studio-video-4.mp4', 'mine.mp4'];
      for (const name of names) fs.writeFileSync(path.join(directory, name), 'x');
      const old = new Date(now - 60 * 60_000);
      for (const name of names.slice(0, 3).concat('mine.mp4')) fs.utimesSync(path.join(directory, name), old, old);
      await pruneDefaultVideos(directory, 2, now);
      // Kept: the young file plus the newest old one; caller-named files are never touched.
      expect(fs.readdirSync(directory).sort()).toEqual(['mine.mp4', 'studio-video-3.mp4', 'studio-video-4.mp4']);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

const MAGENTA: [number, number, number] = [255, 0, 255];

// A fake WGC frame: grey chrome, a viewport at `viewport`, and corner markers when shown.
function windowFrame(width: number, height: number, viewport: { x: number; y: number; width: number; height: number }, markers: boolean) {
  const rgba = Buffer.alloc(width * height * 4, 60);
  const paint = (x0: number, y0: number, w: number, h: number, rgb: [number, number, number]) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const o = (y * width + x) * 4;
        rgba[o] = rgb[0]; rgba[o + 1] = rgb[1]; rgba[o + 2] = rgb[2]; rgba[o + 3] = 255;
      }
    }
  };
  paint(viewport.x, viewport.y, viewport.width, viewport.height, [20, 120, 40]);
  if (markers) {
    const size = 12;
    paint(viewport.x, viewport.y, size, size, MAGENTA);
    paint(viewport.x + viewport.width - size, viewport.y, size, size, MAGENTA);
    paint(viewport.x, viewport.y + viewport.height - size, size, size, MAGENTA);
    paint(viewport.x + viewport.width - size, viewport.y + viewport.height - size, size, size, MAGENTA);
  }
  return { width, height, rgba };
}

class FakeRecording implements VideoRecordingProcess {
  readonly done: Promise<VideoRecordingExit>;
  readonly settle: (exit: VideoRecordingExit) => void;
  stopCalls = 0;

  constructor() {
    const { promise, resolve } = Promise.withResolvers<VideoRecordingExit>();
    this.done = promise;
    this.settle = resolve;
  }

  async stop(): Promise<VideoRecordingExit> {
    this.stopCalls++;
    this.settle({ ok: true, reason: 'stopped' });
    return this.done;
  }
}

class FakeBackend implements VideoRecorderBackend {
  probeResult: VideoRecorderProbe = { ok: true, ffmpegPath: 'ffmpeg-test', encoder: 'libx264' };
  markersShown: () => boolean = () => false;
  started: StartVideoOptions[] = [];
  recordings: FakeRecording[] = [];
  storyboards: StoryboardOptions[] = [];
  grabbedWindows: number[] = [];
  info: MediaInfo = { durationSeconds: 3, width: 300, height: 120 };
  failOnStart?: VideoRecordingExit;

  async probe() { return this.probeResult; }

  async grabWindowFrame(_ffmpegPath: string, windowId: number) {
    this.grabbedWindows.push(windowId);
    return windowFrame(400, 200, { x: 50, y: 30, width: 300, height: 120 }, this.markersShown());
  }

  start(options: StartVideoOptions) {
    this.started.push(options);
    const recording = new FakeRecording();
    if (this.failOnStart) recording.settle(this.failOnStart);
    this.recordings.push(recording);
    return recording;
  }

  async mediaInfo() { return this.info; }

  async storyboard(options: StoryboardOptions): Promise<Storyboard> {
    this.storyboards.push(options);
    const times = storyboardTimes(options.startSeconds, options.endSeconds, options.frames, options.info.durationSeconds);
    const { columns, rows } = storyboardGrid(options.frames);
    return { jpeg: Buffer.from('jpeg-bytes'), width: 900, height: 360, columns, rows, timesSeconds: times };
  }
}

describe('capture_video tool', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let outputDirectory: string;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    jest.replaceProperty(process, 'env', { ...process.env, ROBLOX_STUDIO_HOST_CAPTURE: '1' });
    jest.spyOn(StudioInstanceManager.prototype, 'pendingLaunches').mockResolvedValue([]);
    outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-video-'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    Object.defineProperty(process, 'platform', platformDescriptor);
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  });

  function registerRole(bridge: BridgeService, peerId: string, role: string, isRunning: boolean, transportPeerId = peerId) {
    const result = bridge.registerPeer({
      peerId, transportPeerId, instanceId: 'instance:test', role, placeId: 0,
      placeName: 'TestPlace', dataModelName: 'TestPlace', isRunning,
    });
    if (!result.ok) throw new Error(`registerPeer failed: ${result.error.code}`);
  }

  function makeTools(options: { playtest?: boolean; prepare?: Record<string, unknown> } = {}) {
    const bridge = new BridgeService();
    registerRole(bridge, 'edit-session', 'edit', false);
    if (options.playtest) {
      registerRole(bridge, 'server-session', 'server', true);
      registerRole(bridge, 'client-session', 'client-1', true, 'server-session');
    }
    const markers = { shown: false };
    const events: string[] = [];
    const peers: string[] = [];
    const request = jest.spyOn(StudioHttpClient.prototype, 'request').mockImplementation((async (endpoint: string, data: unknown, peerId: string) => {
      if (endpoint !== '/api/capture-markers') throw new Error(`unexpected endpoint ${endpoint}`);
      const action = (data as { action: string }).action;
      events.push(action);
      peers.push(peerId);
      if (action === 'prepare') return { success: true, captureId: 'capture:video', viewportWidth: 300, viewportHeight: 120, ...options.prepare };
      if (action === 'show') markers.shown = true;
      if (action === 'hide') markers.shown = false;
      return { success: true, captureId: 'capture:video', viewportWidth: 300, viewportHeight: 120, markerSize: 12 };
    }) as never);
    const backend = new FakeBackend();
    backend.markersShown = () => markers.shown;
    const hostCapture = jest.fn<Promise<HostCaptureResult>, Parameters<HostWindowCaptureFn>>(async () => ({
      ok: true,
      capture: {
        width: 400, height: 200, title: 'TestPlace - Roblox Studio', rgba: Buffer.alloc(400 * 200 * 4),
        identity: { windowId: 777, processId: 42, bundleIdentifier: 'RobloxStudioBeta' },
      },
    }));
    const tools = new RobloxStudioTools(bridge);
    const internals = tools as unknown as {
      hostWindowCapture: HostWindowCaptureFn;
      videoRecorder: VideoRecorderBackend;
      videoStartGraceMs: number;
    };
    internals.hostWindowCapture = hostCapture;
    internals.videoRecorder = backend;
    internals.videoStartGraceMs = 0;
    return { tools, backend, events, peers, markers, request, hostCapture };
  }

  function textOf(result: { content: Array<{ type: string; text?: string }> }) {
    return JSON.parse(result.content[0].text ?? '{}');
  }

  test('start locates the client viewport through markers, then stop returns the video and a storyboard', async () => {
    const { tools, backend, events, peers, markers } = makeTools({ playtest: true });
    const outputPath = path.join(outputDirectory, 'cutscene.mp4');

    const started = textOf(await tools.captureVideo({ action: 'start', fps: 60, output_path: outputPath }, 'instance:test'));
    expect(started).toMatchObject({ action: 'start', recording: true, target: 'client-1', video: { path: outputPath, fps: 60, width: 300, height: 120 } });
    expect(events).toEqual(['prepare', 'show', 'hide', 'finish']);
    expect(new Set(peers)).toEqual(new Set(['client-session']));
    expect(markers.shown).toBe(false);
    expect(backend.grabbedWindows).toEqual([777]);
    expect(backend.started).toHaveLength(1);
    expect(backend.started[0]).toMatchObject({
      windowId: 777, crop: { x: 50, y: 30, width: 300, height: 120 }, frameWidth: 400, frameHeight: 200, fps: 60, outputPath,
    });

    const stopped = await tools.captureVideo({ action: 'stop' });
    const body = textOf(stopped);
    expect(backend.recordings[0].stopCalls).toBe(1);
    expect(body).toMatchObject({
      action: 'stop', target: 'client-1',
      video: { path: outputPath, duration_ms: 3000, width: 300, height: 120 },
      storyboard: { frames: 9, columns: 3, rows: 3 },
    });
    expect(body.storyboard.times_ms[0]).toBe(167);
    expect(stopped.content[1]).toEqual({ type: 'image', data: Buffer.from('jpeg-bytes').toString('base64'), mimeType: 'image/jpeg' });
    await expect(tools.captureVideo({ action: 'stop' })).rejects.toThrow(/No capture_video recording is active/);
  });

  test('refuses a second start while recording', async () => {
    const { tools, backend } = makeTools();
    await tools.captureVideo({ action: 'start', output_path: path.join(outputDirectory, 'a.mp4') });
    const second = textOf(await tools.captureVideo({ action: 'start', output_path: path.join(outputDirectory, 'b.mp4') }));
    expect(second.error).toMatch(/already running.*a\.mp4/);
    expect(backend.started).toHaveLength(1);
  });

  test('reports an encoder that fails at once instead of claiming to record', async () => {
    const { tools, backend } = makeTools();
    backend.failOnStart = { ok: false, error: 'window not found' };
    const result = textOf(await tools.captureVideo({ action: 'start', output_path: path.join(outputDirectory, 'a.mp4') }));
    expect(result.error).toBe('Could not record the Studio window: window not found');
    await expect(tools.captureVideo({ action: 'stop' })).rejects.toThrow(/No capture_video recording is active/);
  });

  test('stop reports a recording that already hit its limit', async () => {
    const { tools, backend } = makeTools();
    await tools.captureVideo({ action: 'start', frames: 0, output_path: path.join(outputDirectory, 'a.mp4') });
    backend.recordings[0].settle({ ok: true, reason: 'duration_limit' });
    await backend.recordings[0].done;
    const result = await tools.captureVideo({ action: 'stop' });
    expect(result.content).toHaveLength(1);
    expect(textOf(result)).toMatchObject({ stopped_by: 'max_duration', message: expect.stringContaining('300000 ms limit') });
    expect(backend.recordings[0].stopCalls).toBe(0);
  });

  test('does not record when markers had to refit a scaled simulated device', async () => {
    const { tools, backend, events } = makeTools({ prepare: { viewportChanged: true } });
    const result = textOf(await tools.captureVideo({ action: 'start', output_path: path.join(outputDirectory, 'a.mp4') }));
    expect(result.error).toMatch(/Fit to Window/);
    expect(events).toEqual(['prepare', 'finish']);
    expect(backend.started).toHaveLength(0);
  });

  test('fails before touching Studio when FFmpeg is unusable or the platform is unsupported', async () => {
    const { tools, backend, request, hostCapture } = makeTools();
    backend.probeResult = { ok: false, error: 'ffmpeg was not found' };
    expect(textOf(await tools.captureVideo({ action: 'start' })).error).toBe('ffmpeg was not found');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(textOf(await tools.captureVideo({ action: 'record' })).error).toMatch(/only implemented on Windows/);
    expect(request).not.toHaveBeenCalled();
    expect(hostCapture).not.toHaveBeenCalled();
  });

  test('record stops after duration_ms', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const { tools, backend } = makeTools();
    const pending = tools.captureVideo({ action: 'record', duration_ms: 2000, output_path: path.join(outputDirectory, 'a.mp4') });
    while (backend.recordings.length === 0) await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(1999);
    expect(backend.recordings[0].stopCalls).toBe(0);
    await jest.advanceTimersByTimeAsync(1);
    const body = textOf(await pending);
    expect(backend.recordings[0].stopCalls).toBe(1);
    expect(backend.started[0].maxDurationMs).toBe(12_000);
    expect(body).toMatchObject({ action: 'record', video: { duration_ms: 3000 }, storyboard: { frames: 9 } });
  });

  test('storyboard re-samples a window of a saved video', async () => {
    const { tools, backend } = makeTools();
    backend.info = { durationSeconds: 10, width: 640, height: 360 };
    const result = await tools.captureVideo({ action: 'storyboard', input_path: 'clip.mp4', start_ms: 2000, end_ms: 4000, frames: 4 });
    const body = textOf(result);
    expect(body).toMatchObject({ window_ms: { start: 2000, end: 4000 }, storyboard: { frames: 4, columns: 2, rows: 2, times_ms: [2250, 2750, 3250, 3750] } });
    expect(backend.storyboards[0]).toMatchObject({ inputPath: path.resolve('clip.mp4'), startSeconds: 2, endSeconds: 4, frames: 4 });
    await expect(tools.captureVideo({ action: 'storyboard', input_path: 'clip.mp4', start_ms: 5000, end_ms: 5000 })).rejects.toThrow(/end_ms must be after start_ms/);
    await expect(tools.captureVideo({ action: 'storyboard' })).rejects.toThrow(/input_path is required/);
  });

  test('rejects arguments that belong to another action', async () => {
    const { tools } = makeTools();
    await expect(tools.captureVideo({ action: 'start', duration_ms: 1000 })).rejects.toThrow(/duration_ms is only used with action="record"/);
    await expect(tools.captureVideo({ action: 'record', input_path: 'x.mp4' })).rejects.toThrow(/input_path is only used with action="storyboard"/);
    await expect(tools.captureVideo({ action: 'start', output_path: 'clip.avi' })).rejects.toThrow(/ending in \.mp4/);
  });
});

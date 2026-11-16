import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BridgeService } from '../bridge-service.js';
import type { HostCaptureResult, HostWindowIdentity } from '../host-capture.js';
import type { X11Session } from '../host-capture-linux.js';
import { StudioInstanceManager } from '../studio-instance-manager.js';
import { RobloxStudioTools } from '../tools/index.js';
import type { HostWindowCaptureFn } from '../tools/index.js';
import { StudioHttpClient } from '../tools/studio-client.js';
import { hostEnvironment } from '../host-capture.js';
import {
  createFfmpegVideoBackend,
  ffmpegCommand,
  ffmpegPathArgument,
  gfxcaptureCrop,
  grabFrameArgs,
  parseMediaInfo,
  pruneDefaultVideos,
  recordingArgs,
  stderrSummary,
  videoRecordingUnsupportedReason,
  storyboardArgs,
  storyboardGrid,
  storyboardTimes,
  x11grabEnv,
} from '../video-recorder.js';
import type {
  CaptureSource,
  MediaInfo,
  StartVideoOptions,
  Storyboard,
  StoryboardOptions,
  VideoRecorderBackend,
  VideoRecorderProbe,
  VideoRecordingExit,
  VideoRecordingProcess,
} from '../video-recorder.js';

// Real platform, before tests override process.platform: the fake ffmpeg is a shell script.
const linuxOnly = process.platform === 'linux' ? test : test.skip;

describe('video recorder helpers', () => {
  test('crops to even dimensions expressed per edge', () => {
    expect(gfxcaptureCrop({ x: 401, y: 170, width: 1357, height: 889 }, 2138, 1360)).toEqual({
      left: 401, top: 170, right: 381, bottom: 302, width: 1356, height: 888,
    });
  });

  test('records the cropped window at a constant frame rate with a duration backstop', () => {
    const args = recordingArgs({
      ffmpegPath: 'ffmpeg', encoder: 'libx264', source: 'gfxcapture', windowId: 1184600,
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

  test('gdigrab reads the window through GDI and crops with a filter', () => {
    const args = recordingArgs({
      ffmpegPath: 'ffmpeg', encoder: 'libx264', source: 'gdigrab', windowId: 77,
      crop: { x: 10, y: 20, width: 301, height: 200 }, frameWidth: 400, frameHeight: 260,
      fps: 30, maxDurationMs: 5_000, outputPath: 'out.mp4',
    });
    expect(args.slice(0, args.indexOf('-map'))).toEqual([
      '-hide_banner', '-nostats', '-loglevel', 'error', '-y',
      '-f', 'gdigrab', '-framerate', '30', '-draw_mouse', '0', '-i', 'hwnd=77',
      '-filter_complex', '[0:v]crop=300:200:10:20,format=bgra[v]',
    ]);
    expect(grabFrameArgs('gdigrab', 77)).toContain('[0:v]format=rgba[v]');
    expect(grabFrameArgs('gfxcapture', 77)).toContain('gfxcapture=hwnd=77:capture_cursor=0:max_framerate=30,hwdownload,format=bgra,format=rgba[v]');
  });

  test('x11grab reads the window on the Studio X display and crops with a filter', () => {
    const x11Session = { display: ':118', xauthority: '/run/user/1000/xauth_x' };
    const args = recordingArgs({
      ffmpegPath: 'ffmpeg', encoder: 'libx264', source: 'x11grab', windowId: 0x1200007, x11Session,
      crop: { x: 10, y: 20, width: 301, height: 200 }, frameWidth: 400, frameHeight: 260,
      fps: 30, maxDurationMs: 5_000, outputPath: 'out.mp4',
    });
    expect(args.slice(0, args.indexOf('-map'))).toEqual([
      '-hide_banner', '-nostats', '-loglevel', 'error', '-y',
      '-f', 'x11grab', '-window_id', String(0x1200007), '-draw_mouse', '0', '-framerate', '30', '-i', ':118',
      '-filter_complex', '[0:v]crop=300:200:10:20,format=bgra[v]',
    ]);
    expect(grabFrameArgs('x11grab', 77, x11Session)).toEqual([
      '-hide_banner', '-nostats', '-loglevel', 'info',
      '-f', 'x11grab', '-window_id', '77', '-draw_mouse', '0', '-framerate', '30', '-i', ':118',
      '-filter_complex', '[0:v]format=rgba[v]',
      '-map', '[v]', '-frames:v', '1', '-f', 'rawvideo', '-',
    ]);
    expect(() => grabFrameArgs('x11grab', 77)).toThrow(/X display/);
  });

  test('runs x11grab with the Studio display and cookie, never an inherited cookie', () => {
    const base = { PATH: '/usr/bin', DISPLAY: ':0', XAUTHORITY: '/home/u/.Xauthority' };
    expect(x11grabEnv({ display: ':118', xauthority: '/tmp/xauth_118' }, base)).toEqual({ PATH: '/usr/bin', DISPLAY: ':118', XAUTHORITY: '/tmp/xauth_118' });
    expect(x11grabEnv({ display: ':119' }, base)).toEqual({ PATH: '/usr/bin', DISPLAY: ':119' });
    expect(base.DISPLAY).toBe(':0');
  });

  describe('probe', () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    let directory: string;

    beforeEach(() => {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-probe-'));
    });

    afterEach(() => {
      jest.restoreAllMocks();
      Object.defineProperty(process, 'platform', platformDescriptor);
      fs.rmSync(directory, { recursive: true, force: true });
    });

    // A stand-in ffmpeg that logs its arguments and answers the probe's queries.
    function fakeFfmpeg(x11grab: boolean): { ffmpegPath: string; calls: () => string[] } {
      const ffmpegPath = path.join(directory, x11grab ? 'ffmpeg' : 'ffmpeg-no-x11grab');
      const log = path.join(directory, 'calls.log');
      fs.writeFileSync(ffmpegPath, [
        '#!/bin/sh',
        `echo "$*" >> '${log}'`,
        'case "$*" in',
        x11grab ? '  *demuxer=x11grab*) echo "Demuxer x11grab [X11 screen capture, using XCB]:" ;;' : '  *demuxer=x11grab*) echo "Unknown format \'x11grab\'." ;;',
        "  *-encoders*) printf ' V....D libx264              libx264 H.264 / AVC\\n V....D mpeg4                MPEG-4 part 2\\n' ;;",
        'esac',
        '',
      ].join('\n'), { mode: 0o755 });
      return { ffmpegPath, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n') };
    }

    linuxOnly('finds x11grab and libx264 on native Linux without probing the Windows sources', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      jest.spyOn(hostEnvironment, 'detectWslWindowsHost').mockReturnValue(false);
      const { ffmpegPath, calls } = fakeFfmpeg(true);
      const probe = await createFfmpegVideoBackend({ ROBLOX_STUDIO_FFMPEG: ffmpegPath }).probe();
      expect(probe).toEqual({ ok: true, ffmpegPath, encoder: 'libx264', sources: ['x11grab'] });
      expect(calls()).toEqual(['-hide_banner -h demuxer=x11grab', '-hide_banner -encoders']);
    });

    linuxOnly('explains an ffmpeg without x11grab on native Linux', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      jest.spyOn(hostEnvironment, 'detectWslWindowsHost').mockReturnValue(false);
      const { ffmpegPath } = fakeFfmpeg(false);
      const probe = await createFfmpegVideoBackend({ ROBLOX_STUDIO_FFMPEG: ffmpegPath }).probe();
      expect(probe).toEqual({ ok: false, error: expect.stringMatching(/has no x11grab input device\. Install FFmpeg with the x11grab device/) });
    });

    linuxOnly('keeps probing the Windows sources on WSL', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      jest.spyOn(hostEnvironment, 'detectWslWindowsHost').mockReturnValue(true);
      const { ffmpegPath, calls } = fakeFfmpeg(true);
      const probe = await createFfmpegVideoBackend({ ROBLOX_STUDIO_FFMPEG: ffmpegPath }).probe();
      expect(probe).toEqual({ ok: false, error: expect.stringContaining('neither through gfxcapture') });
      expect(calls()).toEqual(['-hide_banner -h filter=gfxcapture', '-hide_banner -h demuxer=gdigrab']);
    });
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

  test('uses the Windows ffmpeg.exe through interop on WSL', () => {
    expect(ffmpegCommand({}, true)).toBe('ffmpeg.exe');
    expect(ffmpegCommand({}, false)).toBe('ffmpeg');
    expect(ffmpegCommand({ ROBLOX_STUDIO_FFMPEG: '/opt/ffmpeg.exe' }, true)).toBe('/opt/ffmpeg.exe');
    expect(ffmpegPathArgument('/tmp/clip.mp4', false)).toBe('/tmp/clip.mp4');
    expect(ffmpegPathArgument('clip.mp4', true)).toBe('clip.mp4');
  });

  test('supports Windows, WSL with Windows interop and native Linux, not macOS', () => {
    const wsl = jest.spyOn(hostEnvironment, 'detectWslWindowsHost').mockReturnValue(true);
    expect(videoRecordingUnsupportedReason('win32')).toBeUndefined();
    expect(videoRecordingUnsupportedReason('linux')).toBeUndefined();
    expect(videoRecordingUnsupportedReason('darwin')).toMatch(/only implemented on Windows, WSL with Windows interop and Linux\/X11 \(this is darwin\)/);
    wsl.mockReturnValue(false);
    expect(videoRecordingUnsupportedReason('linux')).toBeUndefined();
    expect(videoRecordingUnsupportedReason('freebsd')).toMatch(/this is freebsd/);
    jest.restoreAllMocks();
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
  probeResult: VideoRecorderProbe = { ok: true, ffmpegPath: 'ffmpeg-test', encoder: 'libx264', sources: ['gfxcapture', 'gdigrab'] };
  failingSources = new Set<CaptureSource>();
  markersShown: () => boolean = () => false;
  started: StartVideoOptions[] = [];
  recordings: FakeRecording[] = [];
  storyboards: StoryboardOptions[] = [];
  grabbedWindows: Array<[number, CaptureSource]> = [];
  grabbedSessions: Array<X11Session | undefined> = [];
  info: MediaInfo = { durationSeconds: 3, width: 300, height: 120 };
  failOnStart?: VideoRecordingExit;

  async probe() { return this.probeResult; }

  async grabWindowFrame(_ffmpegPath: string, windowId: number, source: CaptureSource, x11Session?: X11Session) {
    this.grabbedWindows.push([windowId, source]);
    this.grabbedSessions.push(x11Session);
    if (this.failingSources.has(source)) throw new Error(`${source} cannot read the window`);
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

  function makeTools(options: { playtest?: boolean; prepare?: Record<string, unknown>; identity?: HostWindowIdentity } = {}) {
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
        identity: options.identity ?? { windowId: 777, processId: 42, bundleIdentifier: 'RobloxStudioBeta' },
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
    expect(backend.grabbedWindows).toEqual([[777, 'gfxcapture']]);
    expect(backend.started).toHaveLength(1);
    expect(backend.started[0]).toMatchObject({
      source: 'gfxcapture', windowId: 777, crop: { x: 50, y: 30, width: 300, height: 120 }, frameWidth: 400, frameHeight: 200, fps: 60, outputPath,
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

  test('falls back to gdigrab when Windows Graphics Capture cannot read the window', async () => {
    const { tools, backend, markers } = makeTools();
    backend.failingSources.add('gfxcapture');
    const started = textOf(await tools.captureVideo({ action: 'start', output_path: path.join(outputDirectory, 'a.mp4') }));
    expect(started.video.source).toBe('gdigrab');
    expect(backend.grabbedWindows).toEqual([[777, 'gfxcapture'], [777, 'gdigrab']]);
    expect(backend.started[0]).toMatchObject({ source: 'gdigrab', crop: { x: 50, y: 30, width: 300, height: 120 } });
    expect(markers.shown).toBe(false);

    backend.failingSources.add('gdigrab');
    await tools.captureVideo({ action: 'stop' });
    const failed = textOf(await tools.captureVideo({ action: 'start', output_path: path.join(outputDirectory, 'b.mp4') }));
    expect(failed.error).toBe(
      'Could not locate the Studio viewport: gfxcapture cannot read the window; gdigrab cannot read the window',
    );
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

  test('records from WSL like from Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    jest.spyOn(hostEnvironment, 'detectWslWindowsHost').mockReturnValue(true);
    const { tools, backend } = makeTools();
    const started = textOf(await tools.captureVideo({ action: 'start', output_path: path.join(outputDirectory, 'a.mp4') }));
    expect(started).toMatchObject({ recording: true, target: 'edit' });
    expect(backend.started).toHaveLength(1);
  });

  test('records native Linux through x11grab on the X display of the registered Studio', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    jest.spyOn(hostEnvironment, 'detectWslWindowsHost').mockReturnValue(false);
    jest.spyOn(StudioInstanceManager.prototype, 'get').mockResolvedValue({ nativeProcessId: 4242 } as never);
    const x11Session = { display: ':118', xauthority: '/tmp/xauth_118' };
    const { tools, backend, hostCapture } = makeTools({
      identity: { windowId: 0x1200007, processId: 4242, bundleIdentifier: 'x11:118', x11Session },
    });
    backend.probeResult = { ok: true, ffmpegPath: 'ffmpeg', encoder: 'libx264', sources: ['x11grab'] };
    const started = textOf(await tools.captureVideo({ action: 'start', output_path: path.join(outputDirectory, 'a.mp4') }));
    expect(started).toMatchObject({ recording: true, target: 'edit', video: { source: 'x11grab', width: 300, height: 120 } });
    expect(hostCapture).toHaveBeenCalledWith('TestPlace', undefined, { processId: 4242 });
    expect(backend.grabbedWindows).toEqual([[0x1200007, 'x11grab']]);
    expect(backend.grabbedSessions).toEqual([x11Session]);
    expect(backend.started[0]).toMatchObject({
      source: 'x11grab', windowId: 0x1200007, x11Session, crop: { x: 50, y: 30, width: 300, height: 120 }, frameWidth: 400, frameHeight: 200,
    });
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

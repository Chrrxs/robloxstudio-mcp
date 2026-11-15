// Host-side Studio viewport video recording.
//
// Roblox has no engine API that hands a plugin the bytes of a video:
// CaptureService:StartVideoCaptureAsync produces a gallery/share VideoCapture
// object, not a file. Repeated screenshots through the plugin are far too slow
// for motion (each one round-trips the framebuffer through Luau), and during a
// playtest Studio's own capture paths can return black frames.
//
// So the MCP server records the Studio window itself with FFmpeg's gfxcapture
// source (Windows Graphics Capture, FFmpeg 8.0+). WGC reads the window's
// composited surface on the GPU, so it keeps recording at the window's real
// frame rate while Studio sits behind other windows, and the crop to the 3D
// viewport happens before the frames leave the GPU. The viewport rect is
// located once from the plugin's corner markers in a frame grabbed by the very
// same source, so the crop and the recording share one coordinate space
// whatever the DPI scale.
//
// WGC is not available everywhere: FFmpeg builds older than 8.0 lack
// gfxcapture, and a process without the user's per-session capture service
// (for example one started through secondary logon) fails to set it up with
// 0x80070424. gdigrab, which copies the window through GDI, is the fallback;
// it reads the same client area and is tried with the same markers.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ViewportRect } from './host-capture.js';

export type VideoEncoder = 'libx264' | 'h264_mf' | 'mpeg4';

// Preferred first.
export type CaptureSource = 'gfxcapture' | 'gdigrab';

export type VideoRecorderProbe =
  | { ok: true; ffmpegPath: string; encoder: VideoEncoder; sources: CaptureSource[] }
  | { ok: false; error: string };

export type VideoFrame = { width: number; height: number; rgba: Buffer };

export type MediaInfo = { durationSeconds: number; width: number; height: number };

export type StartVideoOptions = {
  ffmpegPath: string;
  encoder: VideoEncoder;
  source: CaptureSource;
  windowId: number;
  // Viewport rect inside the captured window frame, and that frame's size.
  crop: ViewportRect;
  frameWidth: number;
  frameHeight: number;
  fps: number;
  maxDurationMs: number;
  outputPath: string;
};

export type VideoRecordingExit =
  | { ok: true; reason: 'stopped' | 'duration_limit' }
  | { ok: false; error: string };

export interface VideoRecordingProcess {
  // Settles when the encoder exits, whether stopped or at the duration limit.
  readonly done: Promise<VideoRecordingExit>;
  // Asks the encoder to finish the file and waits for it to exit.
  stop(): Promise<VideoRecordingExit>;
}

export type StoryboardOptions = {
  ffmpegPath: string;
  inputPath: string;
  info: MediaInfo;
  startSeconds: number;
  endSeconds: number;
  frames: number;
  maxWidth: number;
};

export type Storyboard = {
  jpeg: Buffer;
  width: number;
  height: number;
  columns: number;
  rows: number;
  timesSeconds: number[];
};

// Injection seam: tests stand in for FFmpeg and the host OS.
export interface VideoRecorderBackend {
  probe(): Promise<VideoRecorderProbe>;
  grabWindowFrame(ffmpegPath: string, windowId: number, source: CaptureSource): Promise<VideoFrame>;
  start(options: StartVideoOptions): VideoRecordingProcess;
  mediaInfo(ffmpegPath: string, inputPath: string): Promise<MediaInfo>;
  storyboard(options: StoryboardOptions): Promise<Storyboard>;
}

const PROBE_TIMEOUT_MS = 15_000;
const GRAB_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 15_000;
const STORYBOARD_TIMEOUT_MS = 60_000;
const MAX_GRAB_BYTES = 16384 * 16384 * 4;
const STORYBOARD_PADDING = 4;
const ENCODER_PREFERENCE: readonly VideoEncoder[] = ['libx264', 'h264_mf', 'mpeg4'];

export function ffmpegCommand(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ROBLOX_STUDIO_FFMPEG?.trim();
  return configured ? configured : 'ffmpeg';
}

export function videoRecordingUnsupportedReason(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === 'win32') return undefined;
  return `video recording is only implemented on Windows (this is ${platform}); use capture_screenshot instead`;
}

const DEFAULT_VIDEO_PREFIX = 'studio-video-';
const KEPT_DEFAULT_VIDEOS = 20;
// Another server process sharing the directory may still be writing a young file.
const DEFAULT_VIDEO_PRUNE_GRACE_MS = 10 * 60_000;

export function defaultVideoDirectory(): string {
  return path.join(os.tmpdir(), 'robloxstudio-mcp', 'videos');
}

export function defaultVideoPath(date = new Date()): string {
  const stamp = date.toISOString().replace(/[:.]/g, '-');
  return path.join(defaultVideoDirectory(), `${DEFAULT_VIDEO_PREFIX}${stamp}-${Math.random().toString(36).slice(2, 8)}.mp4`);
}

// Keeps the newest recordings in the default directory so repeated recording
// does not fill the disk. Only files this tool names, older than the grace
// period, are removed; caller-chosen output paths are never touched.
export async function pruneDefaultVideos(
  directory = defaultVideoDirectory(),
  keep = KEPT_DEFAULT_VIDEOS,
  now = Date.now(),
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(directory);
  } catch {
    return;
  }
  // Names start with the timestamp, so name order is age order.
  const videos = entries.filter((name) => name.startsWith(DEFAULT_VIDEO_PREFIX) && name.endsWith('.mp4')).sort();
  const settled: string[] = [];
  for (const name of videos) {
    try {
      const stats = await fs.promises.stat(path.join(directory, name));
      if (now - stats.mtimeMs >= DEFAULT_VIDEO_PRUNE_GRACE_MS) settled.push(name);
    } catch {
      // Removed meanwhile, e.g. by another process pruning.
    }
  }
  const young = videos.length - settled.length;
  const excess = settled.length - Math.max(0, keep - young);
  for (const name of settled.slice(0, Math.max(0, excess))) {
    await fs.promises.rm(path.join(directory, name), { force: true }).catch(() => undefined);
  }
}

const FFMPEG_INSTALL_HINT =
  'Install FFmpeg 8.0 or newer (for example `winget install Gyan.FFmpeg`) and restart the MCP server, ' +
  'or point ROBLOX_STUDIO_FFMPEG at ffmpeg.exe.';

type RunResult = { code: number | null; stdout: Buffer; stderr: string };

function runFfmpeg(ffmpegPath: string, args: string[], timeoutMs: number, maxStdoutBytes = 64 * 1024 * 1024): Promise<RunResult> {
  const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const chunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderr = '';
  let settled = false;
  const finish = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    fn();
  };
  const timer = setTimeout(() => {
    child.kill();
    finish(() => reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`)));
  }, timeoutMs);
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxStdoutBytes) {
      child.kill();
      finish(() => reject(new Error(`ffmpeg output exceeded ${maxStdoutBytes} bytes`)));
      return;
    }
    chunks.push(chunk);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < 64 * 1024) stderr += chunk;
  });
  child.on('error', (error: NodeJS.ErrnoException) => {
    finish(() => reject(error.code === 'ENOENT'
      ? new Error(`ffmpeg was not found (${ffmpegPath}). ${FFMPEG_INSTALL_HINT}`)
      : new Error(`could not start ffmpeg (${ffmpegPath}): ${error.message}`)));
  });
  child.on('close', (code) => {
    finish(() => resolve({ code, stdout: Buffer.concat(chunks), stderr }));
  });
  return promise;
}

// ffmpeg reports the root cause first and the cascade of shutdown errors
// after it, so keep the first few distinct messages without their
// "[component @ 0x...]" prefixes.
export function stderrSummary(stderr: string): string {
  const seen = new Set<string>();
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.replace(/^(?:\[[^\]]*@\s*[0-9a-fA-Fx]+\]\s*)+/, '').trim();
    if (line.length > 0) seen.add(line);
    if (seen.size >= 3) break;
  }
  return [...seen].join(' | ').slice(0, 600);
}

function evenFloor(value: number): number {
  return Math.max(2, value - (value % 2));
}

export type SourceCrop = { left: number; top: number; right: number; bottom: number; width: number; height: number };

// Rounds the crop down to even dimensions (yuv420p needs them) and expresses
// it both per edge (gfxcapture) and as a rect (gdigrab's crop filter).
export function gfxcaptureCrop(crop: ViewportRect, frameWidth: number, frameHeight: number): SourceCrop {
  const left = Math.max(0, Math.min(frameWidth - 2, Math.floor(crop.x)));
  const top = Math.max(0, Math.min(frameHeight - 2, Math.floor(crop.y)));
  const width = evenFloor(Math.min(Math.floor(crop.width), frameWidth - left));
  const height = evenFloor(Math.min(Math.floor(crop.height), frameHeight - top));
  return {
    left,
    top,
    right: Math.max(0, frameWidth - left - width),
    bottom: Math.max(0, frameHeight - top - height),
    width,
    height,
  };
}

function encoderArgs(encoder: VideoEncoder): string[] {
  if (encoder === 'libx264') return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'];
  if (encoder === 'h264_mf') return ['-c:v', 'h264_mf', '-b:v', '12M', '-pix_fmt', 'nv12'];
  return ['-c:v', 'mpeg4', '-q:v', '3', '-pix_fmt', 'yuv420p'];
}

// The input half of an ffmpeg command that reads the window's client area,
// optionally cropped, as frames of pixelFormat labelled [v].
function sourceGraph(source: CaptureSource, windowId: number, fps: number, pixelFormat: string, crop?: SourceCrop): string[] {
  if (source === 'gdigrab') {
    const cropFilter = crop ? `crop=${crop.width}:${crop.height}:${crop.left}:${crop.top},` : '';
    const filter = `${cropFilter}format=${pixelFormat}[v]`;
    return [
      '-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', '0', '-i', `hwnd=${windowId}`,
      '-filter_complex', `[0:v]${filter}`,
    ];
  }
  const options = [`gfxcapture=hwnd=${windowId}`, 'capture_cursor=0', `max_framerate=${fps}`];
  if (crop) {
    options.push(`crop_left=${crop.left}`, `crop_top=${crop.top}`, `crop_right=${crop.right}`, `crop_bottom=${crop.bottom}`);
  }
  // hwdownload yields bgra; a second format converts when another is asked for.
  const convert = pixelFormat === 'bgra' ? '' : `,format=${pixelFormat}`;
  return ['-filter_complex', `${options.join(':')},hwdownload,format=bgra${convert}[v]`];
}

export function recordingArgs(options: StartVideoOptions): string[] {
  const crop = gfxcaptureCrop(options.crop, options.frameWidth, options.frameHeight);
  return [
    '-hide_banner', '-nostats', '-loglevel', 'error', '-y',
    ...sourceGraph(options.source, options.windowId, options.fps, 'bgra', crop),
    '-map', '[v]',
    '-t', (options.maxDurationMs / 1000).toFixed(3),
    // WGC delivers a frame only when the window changes; constant frame rate
    // repeats the last one so playback timing matches wall time.
    '-fps_mode', 'cfr', '-r', String(options.fps),
    ...encoderArgs(options.encoder),
    '-movflags', '+faststart',
    options.outputPath,
  ];
}

export function grabFrameArgs(source: CaptureSource, windowId: number): string[] {
  return [
    // Info level prints the output frame size; errors are filtered from it on failure.
    '-hide_banner', '-nostats', '-loglevel', 'info',
    ...sourceGraph(source, windowId, 30, 'rgba'),
    '-map', '[v]', '-frames:v', '1', '-f', 'rawvideo', '-',
  ];
}

// The tile grid is as square as possible, filled row by row.
export function storyboardGrid(frames: number): { columns: number; rows: number } {
  const columns = Math.max(1, Math.ceil(Math.sqrt(frames)));
  return { columns, rows: Math.max(1, Math.ceil(frames / columns)) };
}

// Frame i samples the middle of the i-th equal slice of the window, so the
// sheet covers the whole span without landing on the very first or last frame.
export function storyboardTimes(startSeconds: number, endSeconds: number, frames: number, durationSeconds: number): number[] {
  const span = Math.max(0, endSeconds - startSeconds);
  const latest = Math.max(0, durationSeconds - 0.05);
  const times: number[] = [];
  for (let i = 0; i < frames; i++) {
    const t = startSeconds + ((i + 0.5) * span) / frames;
    times.push(Math.round(Math.min(latest, Math.max(0, t)) * 1000) / 1000);
  }
  return times;
}

export function storyboardArgs(options: StoryboardOptions, tileWidth: number, tileHeight: number, times: number[]): string[] {
  const { columns, rows } = storyboardGrid(times.length);
  const inputs: string[] = [];
  let graph = '';
  times.forEach((t, i) => {
    inputs.push('-ss', t.toFixed(3), '-i', options.inputPath);
    graph += `[${i}:v]trim=end_frame=1,setpts=PTS-STARTPTS,scale=${tileWidth}:${tileHeight},setsar=1[f${i}];`;
  });
  graph += times.map((_, i) => `[f${i}]`).join('');
  graph += `concat=n=${times.length}:v=1:a=0,tile=${columns}x${rows}:padding=${STORYBOARD_PADDING}:color=black`;
  return [
    '-hide_banner', '-nostats', '-loglevel', 'error',
    ...inputs,
    '-filter_complex', graph,
    '-frames:v', '1', '-q:v', '4', '-f', 'image2pipe', '-c:v', 'mjpeg', '-',
  ];
}

export function parseMediaInfo(stderr: string): MediaInfo | undefined {
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const size = /Stream #\d+:\d+[^\n]*Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})/.exec(stderr);
  if (!duration || !size) return undefined;
  const durationSeconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
  return { durationSeconds, width: Number(size[1]), height: Number(size[2]) };
}

class FfmpegRecording implements VideoRecordingProcess {
  readonly done: Promise<VideoRecordingExit>;
  private stopRequested = false;
  private readonly child: ReturnType<typeof spawn>;

  constructor(options: StartVideoOptions, live: Set<FfmpegRecording>) {
    const { promise, resolve } = Promise.withResolvers<VideoRecordingExit>();
    this.done = promise;
    this.child = spawn(options.ffmpegPath, recordingArgs(options), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    live.add(this);
    let stderr = '';
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    // A closed stdin pipe must not crash the server when ffmpeg exits first.
    this.child.stdin?.on('error', () => undefined);
    this.child.on('error', (error: NodeJS.ErrnoException) => {
      live.delete(this);
      resolve({
        ok: false,
        error: error.code === 'ENOENT'
          ? `ffmpeg was not found (${options.ffmpegPath}). ${FFMPEG_INSTALL_HINT}`
          : `could not start ffmpeg: ${error.message}`,
      });
    });
    this.child.on('close', (code) => {
      live.delete(this);
      if (code === 0) {
        resolve({ ok: true, reason: this.stopRequested ? 'stopped' : 'duration_limit' });
        return;
      }
      const detail = stderrSummary(stderr);
      resolve({ ok: false, error: `ffmpeg exited with code ${code}${detail ? `: ${detail}` : ''}` });
    });
  }

  async stop(): Promise<VideoRecordingExit> {
    if (!this.stopRequested) {
      this.stopRequested = true;
      // "q" makes ffmpeg flush the encoder and write the MP4 index.
      this.child.stdin?.end('q');
    }
    const timer = setTimeout(() => this.child.kill(), STOP_TIMEOUT_MS);
    try {
      const exit = await this.done;
      return exit;
    } finally {
      clearTimeout(timer);
    }
  }

  kill(): void {
    this.child.kill();
  }
}

export function createFfmpegVideoBackend(env: NodeJS.ProcessEnv = process.env): VideoRecorderBackend {
  let probed: { ffmpegPath: string; encoder: VideoEncoder; sources: CaptureSource[] } | undefined;
  const live = new Set<FfmpegRecording>();
  let exitHookInstalled = false;
  const installExitHook = () => {
    if (exitHookInstalled) return;
    exitHookInstalled = true;
    // An orphaned encoder would otherwise keep recording until its limit.
    process.once('exit', () => {
      for (const recording of live) recording.kill();
    });
  };

  return {
    async probe() {
      if (probed) return { ok: true, ...probed };
      const ffmpegPath = ffmpegCommand(env);
      try {
        const sources: CaptureSource[] = [];
        const filter = await runFfmpeg(ffmpegPath, ['-hide_banner', '-h', 'filter=gfxcapture'], PROBE_TIMEOUT_MS);
        if (filter.stdout.toString('utf8').includes('Filter gfxcapture')) sources.push('gfxcapture');
        const demuxer = await runFfmpeg(ffmpegPath, ['-hide_banner', '-h', 'demuxer=gdigrab'], PROBE_TIMEOUT_MS);
        if (demuxer.stdout.toString('utf8').includes('Demuxer gdigrab')) sources.push('gdigrab');
        if (sources.length === 0) {
          return {
            ok: false,
            error: `ffmpeg (${ffmpegPath}) can capture neither through gfxcapture (Windows Graphics Capture) nor gdigrab. ${FFMPEG_INSTALL_HINT}`,
          };
        }
        const encoders = (await runFfmpeg(ffmpegPath, ['-hide_banner', '-encoders'], PROBE_TIMEOUT_MS)).stdout.toString('utf8');
        const encoder = ENCODER_PREFERENCE.find((name) => new RegExp(`^\\s*V\\S*\\s+${name}\\s`, 'm').test(encoders));
        if (!encoder) {
          return { ok: false, error: `ffmpeg (${ffmpegPath}) has none of the ${ENCODER_PREFERENCE.join(', ')} video encoders. ${FFMPEG_INSTALL_HINT}` };
        }
        probed = { ffmpegPath, encoder, sources };
        return { ok: true, ...probed };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },

    async grabWindowFrame(ffmpegPath, windowId, source) {
      const result = await runFfmpeg(ffmpegPath, grabFrameArgs(source, windowId), GRAB_TIMEOUT_MS, MAX_GRAB_BYTES);
      const output = /Output #0[\s\S]*?Video:\s*rawvideo[^\n]*?,\s*(\d+)x(\d+)/.exec(result.stderr);
      if (result.code !== 0 || !output) {
        // This run logs at info level for the frame size; report only its errors.
        const errors = result.stderr.split(/\r?\n/).filter((line) => /fail|error|invalid|cannot|unable/i.test(line)).join('\n');
        throw new Error(`could not capture the Studio window with ffmpeg ${source}: ${stderrSummary(errors) || `exit code ${result.code}`}`);
      }
      const width = Number(output[1]);
      const height = Number(output[2]);
      if (result.stdout.length !== width * height * 4) {
        throw new Error(`ffmpeg returned ${result.stdout.length} bytes for a ${width}x${height} frame`);
      }
      return { width, height, rgba: result.stdout };
    },

    start(options) {
      installExitHook();
      return new FfmpegRecording(options, live);
    },

    async mediaInfo(ffmpegPath, inputPath) {
      // ffmpeg exits non-zero without an output file but still prints the header.
      const result = await runFfmpeg(ffmpegPath, ['-hide_banner', '-i', inputPath], PROBE_TIMEOUT_MS);
      const info = parseMediaInfo(result.stderr);
      if (!info) throw new Error(`could not read video ${inputPath}: ${stderrSummary(result.stderr) || 'no video stream'}`);
      return info;
    },

    async storyboard(options) {
      const { info } = options;
      const { columns, rows } = storyboardGrid(options.frames);
      const available = Math.floor((options.maxWidth - STORYBOARD_PADDING * (columns - 1)) / columns);
      const tileWidth = evenFloor(Math.min(info.width, available));
      const tileHeight = evenFloor(Math.round((info.height * tileWidth) / info.width));
      const times = storyboardTimes(options.startSeconds, options.endSeconds, options.frames, info.durationSeconds);
      const result = await runFfmpeg(options.ffmpegPath, storyboardArgs(options, tileWidth, tileHeight, times), STORYBOARD_TIMEOUT_MS);
      if (result.code !== 0 || result.stdout.length === 0) {
        throw new Error(`could not build the storyboard: ${stderrSummary(result.stderr) || `exit code ${result.code}`}`);
      }
      return {
        jpeg: result.stdout,
        width: columns * tileWidth + (columns - 1) * STORYBOARD_PADDING,
        height: rows * tileHeight + (rows - 1) * STORYBOARD_PADDING,
        columns,
        rows,
        timesSeconds: times,
      };
    },
  };
}

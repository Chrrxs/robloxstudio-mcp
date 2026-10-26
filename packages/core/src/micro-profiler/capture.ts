// Host-side pieces of capture_micro_profiler that do not touch Studio routing:
// request parsing, capture files, and pulling a capture from the plugin.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setTimeout as sleep } from 'timers/promises';
import type { MicroProfilerAnalysisOptions, MicroProfilerCaptureWindow } from './analysis.js';

export const MICRO_PROFILER_ACTIONS = ['capture', 'start', 'stop', 'analyze'] as const;
export type MicroProfilerAction = typeof MICRO_PROFILER_ACTIONS[number];

// One-shot capture length; action="start"/"stop" records longer.
export const MICRO_PROFILER_DEFAULT_DURATION_MS = 1000;
export const MICRO_PROFILER_MIN_DURATION_MS = 100;
export const MICRO_PROFILER_MAX_DURATION_MS = 30000;
// Time beyond the recording for the recording check, stream finalization, and
// each transfer request.
export const MICRO_PROFILER_REQUEST_MARGIN_MS = 45_000;

// Raw bytes per chunk the host asks for. The plugin base64-encodes each chunk;
// client peers answer through InvokeClient, so their chunks stay near 1 MiB.
export const SERVER_CHUNK_BYTES = 8 * 1024 * 1024;
export const CLIENT_CHUNK_BYTES = 768 * 1024;
// Largest capture the host accepts: a stream stops at 128 MiB.
export const MAX_CAPTURE_BYTES = 160 * 1024 * 1024;
// Captures saved without output_path; older ones are pruned.
export const KEPT_DEFAULT_CAPTURES = 10;
export const CAPTURE_EXTENSION = '.gprx';
// Written next to each saved capture: the frames it was recorded for. A stream
// also holds frames from before the capture and a few after it.
export const WINDOW_SIDECAR_SUFFIX = '.window.json';

export function isMicroProfilerAction(value: unknown): value is MicroProfilerAction {
  return typeof value === 'string' && (MICRO_PROFILER_ACTIONS as readonly string[]).includes(value);
}

function optionalNumber(request: Record<string, unknown>, key: string): number | undefined {
  const value = request[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a number when provided`);
  return value;
}

function optionalString(request: Record<string, unknown>, key: string): string | undefined {
  const value = request[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string when provided`);
  return value;
}

export function microProfilerAnalysisOptions(request: Record<string, unknown>): MicroProfilerAnalysisOptions {
  const startFrame = optionalNumber(request, 'start_frame');
  const endFrame = optionalNumber(request, 'end_frame');
  if (startFrame !== undefined && endFrame !== undefined && endFrame < startFrame) {
    throw new Error('end_frame must not be less than start_frame');
  }
  return {
    focus: optionalString(request, 'focus'),
    filter: optionalString(request, 'filter'),
    maxTimers: optionalNumber(request, 'max_timers'),
    maxGroups: optionalNumber(request, 'max_groups'),
    maxTimersPerGroup: optionalNumber(request, 'max_timers_per_group'),
    maxRelatedTimers: optionalNumber(request, 'max_related_timers'),
    minTotalUs: optionalNumber(request, 'min_total_us'),
    includeIdle: request.include_idle === true,
    includeGpu: request.include_gpu === true,
    spikeFrames: optionalNumber(request, 'spike_frames'),
    startFrame: startFrame !== undefined ? Math.floor(startFrame) : undefined,
    endFrame: endFrame !== undefined ? Math.floor(endFrame) : undefined,
  };
}

export function defaultCaptureDirectory(): string {
  return path.join(os.tmpdir(), 'robloxstudio-mcp', 'micro-profiler');
}

function captureFileStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

// Keeps the newest captures in the default directory so repeated profiling
// does not fill the disk. Only files this tool names are removed.
export async function pruneDefaultCaptures(directory: string, keep = KEPT_DEFAULT_CAPTURES): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(directory);
  } catch {
    return;
  }
  const captures = entries.filter((name) => name.startsWith('micro-profiler-') && name.endsWith(CAPTURE_EXTENSION)).sort();
  for (const name of captures.slice(0, Math.max(0, captures.length - keep))) {
    await fs.promises.rm(path.join(directory, name), { force: true });
    await fs.promises.rm(path.join(directory, `${name}${WINDOW_SIDECAR_SUFFIX}`), { force: true });
  }
}

export async function resolveCapturePath(outputPath: string | undefined, role: string, now = new Date()): Promise<string> {
  if (outputPath !== undefined && outputPath !== '') return path.resolve(outputPath);
  const directory = defaultCaptureDirectory();
  await fs.promises.mkdir(directory, { recursive: true });
  // Leave room for the capture about to be written.
  await pruneDefaultCaptures(directory, KEPT_DEFAULT_CAPTURES - 1);
  const safeRole = role.replace(/[^A-Za-z0-9-]/g, '_');
  return path.join(directory, `micro-profiler-${captureFileStamp(now)}-${safeRole}${CAPTURE_EXTENSION}`);
}

export interface CaptureTransferInfo {
  transferId: string;
  totalBytes: number;
  maxChunkBytes: number;
}

export function parseCaptureTransfer(value: unknown): CaptureTransferInfo | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const transfer = value as Record<string, unknown>;
  const transferId = transfer.transfer_id;
  const totalBytes = transfer.total_bytes;
  const maxChunkBytes = transfer.max_chunk_bytes;
  if (typeof transferId !== 'string' || transferId === '') return undefined;
  if (typeof totalBytes !== 'number' || !Number.isInteger(totalBytes) || totalBytes <= 0) return undefined;
  if (typeof maxChunkBytes !== 'number' || !Number.isInteger(maxChunkBytes) || maxChunkBytes <= 0) return undefined;
  return { transferId, totalBytes, maxChunkBytes };
}

export type ReadCaptureChunk = (request: { transfer_id: string; offset: number; length: number }) => Promise<unknown>;
// Called between chunk reads with how long the last read took.
export type PaceCaptureChunk = (readMs: number) => Promise<void>;

// A client capture crosses the playtest's server-client connection. In a busy
// game, copying it back to back dropped the client after about 40 s (Studio
// logged "QUIC: 1 (Internal Error)"); leaving the connection idle as long as
// each chunk took kept the client connected (tests/client-broker-transfer-repro.mjs).
export const idleAsLongAsRead: PaceCaptureChunk = (readMs) => sleep(readMs);

export class CaptureTransferError extends Error {
  constructor(message: string, readonly detail?: Record<string, unknown>) {
    super(message);
  }
}

// Pulls a staged capture in order. Each chunk is checked for its offset and
// length so a dropped or reordered response cannot corrupt the capture.
export async function pullCapture(
  transfer: CaptureTransferInfo,
  chunkBytes: number,
  read: ReadCaptureChunk,
  pace?: PaceCaptureChunk,
): Promise<Buffer> {
  if (transfer.totalBytes > MAX_CAPTURE_BYTES) {
    throw new CaptureTransferError(`The capture is ${transfer.totalBytes} bytes, more than the ${MAX_CAPTURE_BYTES}-byte limit.`);
  }
  const length = Math.max(1, Math.min(chunkBytes, transfer.maxChunkBytes));
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < transfer.totalBytes) {
    const wanted = Math.min(length, transfer.totalBytes - offset);
    const readStartedAt = performance.now();
    const response = await read({ transfer_id: transfer.transferId, offset, length: wanted });
    const readMs = performance.now() - readStartedAt;
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw new CaptureTransferError(`The plugin returned no data for capture bytes ${offset}-${offset + wanted}.`);
    }
    const fields = response as Record<string, unknown>;
    if (typeof fields.error === 'string') {
      throw new CaptureTransferError(typeof fields.message === 'string' ? fields.message : fields.error, fields);
    }
    if (fields.transfer_id !== transfer.transferId || fields.offset !== offset || typeof fields.data !== 'string') {
      throw new CaptureTransferError(`The plugin answered a different capture chunk than bytes ${offset}-${offset + wanted}.`);
    }
    const chunk = Buffer.from(fields.data, 'base64');
    if (chunk.length !== wanted) {
      throw new CaptureTransferError(`Capture chunk at ${offset} decoded to ${chunk.length} bytes, expected ${wanted}.`);
    }
    chunks.push(chunk);
    offset += wanted;
    if (pace && offset < transfer.totalBytes) await pace(readMs);
  }
  return Buffer.concat(chunks, transfer.totalBytes);
}

interface WindowSidecar {
  schema: 1;
  target?: string;
  method?: unknown;
  start_absolute_frame?: number;
  start_frame_estimated?: boolean;
  stop_absolute_frame?: number;
  requested_duration_ms?: number;
  capture_wall_ms?: number;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export async function writeWindowSidecar(capturePath: string, target: string, recording: Record<string, unknown>): Promise<void> {
  const sidecar: WindowSidecar = {
    schema: 1,
    target,
    method: recording.method,
    start_absolute_frame: finiteNumber(recording.start_absolute_frame),
    start_frame_estimated: recording.start_frame_estimated === true || undefined,
    stop_absolute_frame: finiteNumber(recording.stop_absolute_frame),
    requested_duration_ms: finiteNumber(recording.requested_duration_ms),
    capture_wall_ms: finiteNumber(recording.capture_wall_ms),
  };
  await fs.promises.writeFile(`${capturePath}${WINDOW_SIDECAR_SUFFIX}`, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
}

// The recorded window of a capture this tool saved, so re-analysis covers the
// same frames. Files without a readable sidecar (Studio dumps) have none.
export async function readWindowSidecar(capturePath: string): Promise<MicroProfilerCaptureWindow | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.promises.readFile(`${capturePath}${WINDOW_SIDECAR_SUFFIX}`, 'utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const fields = parsed as Record<string, unknown>;
  if (fields.schema !== 1) return undefined;
  return windowFromRecording(fields);
}

export function windowFromRecording(recording: Record<string, unknown>): MicroProfilerCaptureWindow {
  return {
    startAbsoluteFrame: finiteNumber(recording.start_absolute_frame),
    startFrameEstimated: recording.start_frame_estimated === true || undefined,
    endAbsoluteFrame: finiteNumber(recording.stop_absolute_frame),
    requestedDurationMs: finiteNumber(recording.requested_duration_ms),
    captureWallMs: finiteNumber(recording.capture_wall_ms),
  };
}

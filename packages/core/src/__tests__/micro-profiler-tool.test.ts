import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from './test-tools.js';
import { analyzeMicroProfilerCapture } from '../micro-profiler/analysis.js';
import { pruneDefaultCaptures, pullCapture } from '../micro-profiler/capture.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../micro-profiler/analysis.js', () => ({
  analyzeMicroProfilerCapture: jest.fn(),
}));

const analyze = analyzeMicroProfilerCapture as jest.MockedFunction<typeof analyzeMicroProfilerCapture>;
const CLAIM_OWNER = 'micro-profiler-tool-test';

const EDIT = {
  peerId: 'session-1',
  transportPeerId: 'session-1',
  instanceId: 'instance:test',
  role: 'edit',
  placeId: 0,
  placeName: 'TestPlace',
  dataModelName: 'TestPlace',
  isRunning: false,
  pluginVersion: 'test-version',
  pluginVariant: 'main',
  timestamp: Date.now(),
};

function runtimePeer(role: string) {
  return {
    peerId: `${role}-peer`,
    transportPeerId: `${role}-peer`,
    instanceId: 'instance:test',
    role,
    placeId: 0,
    placeName: 'TestPlace',
    dataModelName: 'Game',
    isRunning: true,
  };
}

interface SeenRequest {
  endpoint: string;
  data: Record<string, unknown>;
}

// Answers the plugin side of one tool call until it settles.
async function servePlugin(
  bridge: BridgeService,
  transportPeerId: string,
  call: Promise<unknown>,
  answer: (request: SeenRequest) => unknown,
): Promise<SeenRequest[]> {
  let settled = false;
  call.then(() => { settled = true; }, () => { settled = true; });
  const seen: SeenRequest[] = [];
  while (!settled) {
    const queued = bridge.claimNextRequestForTransport(transportPeerId, CLAIM_OWNER);
    if (queued) {
      const request = { endpoint: queued.endpoint, data: queued.data as Record<string, unknown> };
      seen.push(request);
      bridge.resolveRequest(queued.requestId, answer(request));
    } else {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return seen;
}

function chunkAnswer(capture: Buffer, transferId: string) {
  return (request: SeenRequest): unknown => {
    const offset = request.data.offset as number;
    const length = request.data.length as number;
    return {
      ok: true,
      transfer_id: transferId,
      offset,
      length,
      data: capture.subarray(offset, offset + length).toString('base64'),
    };
  };
}

const SUMMARY = {
  schema_version: 3,
  ok: true,
  analysis_window: { analysis_duration_us: 250_000 },
  top_groups: [{ group: 'Script', inclusive_us: 300, exclusive_us: 100, count: 3 }],
  top_timers: [{ group: 'Script', name: '$Script', inclusive_us: 280, exclusive_us: 90, count: 3 }],
  data_quality: { partial: false, partial_reasons: [] },
  comparison_index: { timers: [], groups: [], threads: [], call_edges: [] },
};

let tmpDir: string;

beforeEach(() => {
  analyze.mockReset();
  analyze.mockImplementation(async () => structuredClone(SUMMARY));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmcp-micro-profiler-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('capture_micro_profiler', () => {
  test('records on one runtime peer, pulls the capture in order, saves it, and analyzes it on the host', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerPeer(EDIT);
    bridge.registerPeer(runtimePeer('server'));
    const capture = Buffer.from('0123456789');
    const outputPath = path.join(tmpDir, 'capture.gprx');
    const summaryPath = path.join(tmpDir, 'summary.json');

    const call = tools.captureMicroProfiler('server', {
      duration_ms: 250,
      focus: 'script',
      spike_frames: 2,
      output_path: outputPath,
      summary_output_path: summaryPath,
      baseline_label: 'empty_baseplate',
      current_label: 'game',
      baseline: {
        schema_version: 3,
        analysis_window: { analysis_duration_us: 250_000 },
        top_groups: [{ group: 'Script', inclusive_us: 100, exclusive_us: 40, count: 2 }],
      },
    }, 'instance:test');
    const seen = await servePlugin(bridge, 'server-peer', call, (request) => {
      if (request.endpoint === '/api/capture-micro-profiler') {
        return {
          ok: true,
          action: 'capture',
          recording: {
            method: 'stream',
            start_absolute_frame: 42,
            stop_absolute_frame: 57,
            capture_wall_ms: 251.5,
            requested_duration_ms: 250,
            first_frame_wait_ms: 20,
            stream: { recorded_kb: 1, max_kb: 131072, size_limit_reached: false },
          },
          capture_state: { was_recording: false },
          transfer: { transfer_id: 't-1', total_bytes: capture.length, max_chunk_bytes: 4 },
        };
      }
      return chunkAnswer(capture, 't-1')(request);
    });
    const body = JSON.parse((await call).content[0].text);

    expect(seen[0]).toEqual({
      endpoint: '/api/capture-micro-profiler',
      data: { action: 'capture', duration_ms: 250, __mcp_instance_id: 'instance:test', __mcp_target_role: 'server' },
    });
    expect(seen.slice(1).map((request) => [request.endpoint, request.data.offset, request.data.length])).toEqual([
      ['/api/micro-profiler-read', 0, 4],
      ['/api/micro-profiler-read', 4, 4],
      ['/api/micro-profiler-read', 8, 2],
    ]);
    expect(fs.readFileSync(outputPath)).toEqual(capture);
    expect(JSON.parse(fs.readFileSync(`${outputPath}.window.json`, 'utf8'))).toMatchObject({
      schema: 1, target: 'server', start_absolute_frame: 42, stop_absolute_frame: 57, capture_wall_ms: 251.5,
    });
    expect(analyze).toHaveBeenCalledTimes(1);
    const [bytes, options] = analyze.mock.calls[0];
    expect(Buffer.from(bytes)).toEqual(capture);
    expect(options).toMatchObject({
      focus: 'script',
      spikeFrames: 2,
      targetRole: 'server',
      includeComparisonIndex: true,
      window: { startAbsoluteFrame: 42, endAbsoluteFrame: 57, requestedDurationMs: 250, captureWallMs: 251.5 },
    });
    expect(body).toMatchObject({
      ok: true,
      action: 'capture',
      target: 'server',
      capture: { path: path.resolve(outputPath), bytes: 10, source: 'studio', method: 'stream' },
      capture_state: { was_recording: false },
      summary_output_path: path.resolve(summaryPath),
    });
    expect(body.comparison_index).toBeUndefined();
    expect(body.baseline_comparison.groups[0]).toMatchObject({ group: 'Script', delta_inclusive_us: 200, delta_pct: 200 });
    expect(JSON.parse(fs.readFileSync(summaryPath, 'utf8')).capture.path).toBe(path.resolve(outputPath));
  });

  test('pulls client captures in broker-sized chunks', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerPeer(EDIT);
    bridge.registerPeer(runtimePeer('client-1'));
    const capture = Buffer.alloc(1_000_000, 7);
    const call = tools.captureMicroProfiler('client-1', { output_path: path.join(tmpDir, 'client.gprx') }, 'instance:test');
    const seen = await servePlugin(bridge, 'client-1-peer', call, (request) => request.endpoint === '/api/capture-micro-profiler'
      ? { ok: true, recording: { method: 'stream', start_absolute_frame: 1 }, transfer: { transfer_id: 't-2', total_bytes: capture.length, max_chunk_bytes: 8 * 1024 * 1024 } }
      : chunkAnswer(capture, 't-2')(request));
    const body = JSON.parse((await call).content[0].text);
    expect(body.ok).toBe(true);
    expect(seen.slice(1).map((request) => request.data.length)).toEqual([786_432, 213_568]);
  });

  test('reports a failed transfer and releases the staged capture', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerPeer(EDIT);
    bridge.registerPeer(runtimePeer('server'));
    const call = tools.captureMicroProfiler('server', { output_path: path.join(tmpDir, 'never.gprx') }, 'instance:test');
    const seen = await servePlugin(bridge, 'server-peer', call, (request) => {
      if (request.endpoint === '/api/capture-micro-profiler') {
        return { ok: true, recording: { method: 'stream' }, transfer: { transfer_id: 't-3', total_bytes: 100, max_chunk_bytes: 64 } };
      }
      if (request.endpoint === '/api/micro-profiler-read') {
        return { error: 'micro_profiler_transfer_expired', message: 'The capture transfer is unknown or expired; capture again.' };
      }
      return { ok: true };
    });
    const body = JSON.parse((await call).content[0].text);
    expect(body.error).toBe('micro_profiler_transfer_failed');
    expect(body.message).toContain('unknown or expired');
    expect(seen.map((request) => request.endpoint)).toEqual([
      '/api/capture-micro-profiler', '/api/micro-profiler-read', '/api/micro-profiler-release',
    ]);
    expect(fs.existsSync(path.join(tmpDir, 'never.gprx'))).toBe(false);
    expect(analyze).not.toHaveBeenCalled();
  });

  test('start returns the open recording without pulling or analyzing anything', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerPeer(EDIT);
    bridge.registerPeer(runtimePeer('server'));
    const call = tools.captureMicroProfiler('server', { action: 'start', duration_ms: 500 }, 'instance:test');
    const seen = await servePlugin(bridge, 'server-peer', call, () => ({
      ok: true, action: 'start', recording: { method: 'stream', elapsed_ms: 0 }, capture_state: { was_recording: false },
    }));
    const body = JSON.parse((await call).content[0].text);
    expect(seen).toEqual([{
      endpoint: '/api/capture-micro-profiler',
      data: { action: 'start', __mcp_instance_id: 'instance:test', __mcp_target_role: 'server' },
    }]);
    expect(body).toMatchObject({ ok: true, action: 'start', target: 'server', recording: { method: 'stream' } });
    expect(analyze).not.toHaveBeenCalled();
  });

  test('passes a plugin failure through without a baseline comparison warning', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerPeer(EDIT);
    bridge.registerPeer(runtimePeer('server'));
    const call = tools.captureMicroProfiler('server', {
      action: 'stop',
      baseline: { schema_version: 3, top_groups: [{ group: 'Script', inclusive_us: 1 }] },
    }, 'instance:test');
    await servePlugin(bridge, 'server-peer', call, () => ({
      error: 'micro_profiler_no_recording',
      message: 'No MicroProfiler recording is running on this peer.',
    }));
    const body = JSON.parse((await call).content[0].text);
    expect(body).toMatchObject({ error: 'micro_profiler_no_recording', target: 'server' });
    expect(body.baseline_comparison).toBeUndefined();
  });

  test('reports a capture whose staged data is unusable and releases it', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerPeer(EDIT);
    bridge.registerPeer(runtimePeer('server'));
    const call = tools.captureMicroProfiler('server', {}, 'instance:test');
    const seen = await servePlugin(bridge, 'server-peer', call, (request) => request.endpoint === '/api/capture-micro-profiler'
      ? { ok: true, recording: { method: 'snapshot', bytes: 0 }, transfer: { transfer_id: 't-4', total_bytes: 0, max_chunk_bytes: 8 } }
      : { ok: true });
    const body = JSON.parse((await call).content[0].text);
    expect(body).toMatchObject({ error: 'micro_profiler_transfer_invalid', target: 'server' });
    expect(seen.map((request) => request.endpoint)).toEqual(['/api/capture-micro-profiler', '/api/micro-profiler-release']);
    expect(analyze).not.toHaveBeenCalled();
  });

  test('still analyzes a capture that cannot be saved', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerPeer(EDIT);
    bridge.registerPeer(runtimePeer('server'));
    const blocker = path.join(tmpDir, 'not-a-directory');
    fs.writeFileSync(blocker, '');
    const capture = Buffer.from('abc');
    const call = tools.captureMicroProfiler('server', { output_path: path.join(blocker, 'capture.gprx') }, 'instance:test');
    await servePlugin(bridge, 'server-peer', call, (request) => request.endpoint === '/api/capture-micro-profiler'
      ? { ok: true, recording: { method: 'stream', start_absolute_frame: 1 }, transfer: { transfer_id: 't-5', total_bytes: 3, max_chunk_bytes: 8 } }
      : chunkAnswer(capture, 't-5')(request));
    const body = JSON.parse((await call).content[0].text);
    expect(body.ok).toBe(true);
    expect(body.capture.path).toBeUndefined();
    expect(body.capture.save_error).toContain('Could not save the capture');
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  test('re-analyzes a saved capture over its recorded window', async () => {
    const tools = new RobloxStudioTools(new BridgeService());
    const capturePath = path.join(tmpDir, 'saved.gprx');
    fs.writeFileSync(capturePath, Buffer.from('saved'));
    fs.writeFileSync(`${capturePath}.window.json`, JSON.stringify({
      schema: 1, start_absolute_frame: 100, stop_absolute_frame: 160, capture_wall_ms: 1000, requested_duration_ms: 1000,
    }));
    const body = JSON.parse((await tools.captureMicroProfiler(undefined, { action: 'analyze', input_path: capturePath })).content[0].text);
    expect(body.capture).toMatchObject({ source: 'file', recorded_window: true });
    expect(analyze.mock.calls[0][1]).toMatchObject({
      window: { startAbsoluteFrame: 100, endAbsoluteFrame: 160, captureWallMs: 1000, requestedDurationMs: 1000 },
    });
  });

  test('analyze reads a saved capture or dump without Studio', async () => {
    const tools = new RobloxStudioTools(new BridgeService());
    const dumpPath = path.join(tmpDir, 'microprofile-dump.gprx');
    fs.writeFileSync(dumpPath, Buffer.from('dump'));
    const result = await tools.captureMicroProfiler(undefined, {
      action: 'analyze', input_path: dumpPath, start_frame: 10, end_frame: 12, filter: 'Pets',
    });
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({ ok: true, action: 'analyze', capture: { path: path.resolve(dumpPath), bytes: 4, source: 'file' } });
    const [bytes, options] = analyze.mock.calls[0];
    expect(Buffer.from(bytes).toString()).toBe('dump');
    expect(options).toMatchObject({ startFrame: 10, endFrame: 12, filter: 'Pets', includeComparisonIndex: false });
    expect(options?.window).toBeUndefined();
  });

  test('rejects analyze without input_path and input_path outside analyze', async () => {
    const tools = new RobloxStudioTools(new BridgeService());
    await expect(tools.captureMicroProfiler(undefined, { action: 'analyze' })).rejects.toThrow('input_path is required');
    await expect(tools.captureMicroProfiler('server', { input_path: 'x.gprx' })).rejects.toThrow('only used with action="analyze"');
    await expect(tools.captureMicroProfiler('server', { action: 'pause' })).rejects.toThrow('action must be one of');
  });

  test('omits absolute deltas against a pre-clock (schema 1) baseline', async () => {
    const tools = new RobloxStudioTools(new BridgeService());
    const dumpPath = path.join(tmpDir, 'current.gprx');
    fs.writeFileSync(dumpPath, Buffer.from('x'));
    analyze.mockImplementation(async () => ({
      schema_version: 3,
      ok: true,
      analysis_window: { analysis_duration_us: 1_000_000 },
      top_groups: [{ group: 'Script', inclusive_us: 150_000, exclusive_us: 30_000, count: 60 }],
    }));
    // Schema 1 assumed nanosecond ticks: on a 4.7 GHz timer it reported every
    // time 4.7x too long, including analysis_duration_us.
    const result = await tools.captureMicroProfiler(undefined, {
      action: 'analyze',
      input_path: dumpPath,
      baseline: {
        duration_ms: 1000,
        analysis_window: { analysis_duration_us: 4_700_000 },
        top_groups: [{ group: 'Script', inclusive_us: 470_000, exclusive_us: 94_000, count: 60 }],
      },
    });
    const comparison = JSON.parse(result.content[0].text).baseline_comparison;
    expect(comparison.warnings).toEqual([expect.stringContaining('The baseline summary predates schema_version 2')]);
    const [group] = comparison.groups;
    expect(group).toMatchObject({
      current_inclusive_us_per_s: 150_000,
      baseline_inclusive_us_per_s: 100_000,
      delta_pct: 50,
    });
    expect(group).not.toHaveProperty('delta_inclusive_us');
  });
});

describe('capture helpers', () => {
  test('pullCapture refuses a chunk for the wrong offset', async () => {
    await expect(pullCapture({ transferId: 't', totalBytes: 8, maxChunkBytes: 4 }, 4, async (request) => ({
      transfer_id: 't', offset: request.offset + 1, data: Buffer.alloc(4).toString('base64'),
    }))).rejects.toThrow('different capture chunk');
  });

  test('pruneDefaultCaptures keeps the newest tool-named captures only', async () => {
    const names = [
      'micro-profiler-2026-01-01-server.gprx', 'micro-profiler-2026-01-01-server.gprx.window.json',
      'micro-profiler-2026-01-02-server.gprx', 'micro-profiler-2026-01-03-server.gprx', 'mine.gprx',
    ];
    for (const name of names) fs.writeFileSync(path.join(tmpDir, name), '');
    await pruneDefaultCaptures(tmpDir, 2);
    expect(fs.readdirSync(tmpDir).sort()).toEqual(['micro-profiler-2026-01-02-server.gprx', 'micro-profiler-2026-01-03-server.gprx', 'mine.gprx']);
  });
});

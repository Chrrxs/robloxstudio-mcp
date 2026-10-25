import { BridgeService, RequestFailure } from '../bridge-service.js';
import { normalizeToolResult } from '../mcp-runtime.js';
import { RobloxStudioTools } from '../tools/index.js';
import { StudioHttpClient } from '../tools/studio-client.js';

class FanoutTestBridge extends BridgeService {
  protected override notifyPeerRegistered(): void {
    // Synthetic peers must not touch the managed-Studio registry.
  }
}

const INSTANCE = 'instance:fanout';

function registerRole(bridge: BridgeService, peerId: string, role: string): void {
  const result = bridge.registerPeer({
    peerId, transportPeerId: peerId, instanceId: INSTANCE, role,
    placeId: 0, placeName: 'Fanout', dataModelName: 'Fanout', isRunning: role !== 'edit',
  });
  if (!result.ok) throw new Error(`registerPeer failed: ${result.error.code}`);
}

function timeout(peerId: string): RequestFailure {
  return new RequestFailure('specific diagnostic: timed out', 'request_timeout', {
    requestId: `request-${peerId}`, targetPeerId: peerId, stage: 'dispatched', outcome: 'unknown', executionOutcome: 'unknown',
  });
}

type Read = (tools: RobloxStudioTools) => Promise<unknown>;

const READS: Array<[string, string, Read]> = [
  ['get_memory_breakdown', '/api/get-memory-breakdown', (tools) => tools.getMemoryBreakdown('all', undefined, INSTANCE)],
  ['get_scene_analysis', '/api/get-scene-analysis', (tools) => tools.getSceneAnalysis(undefined, 'all', undefined, undefined, INSTANCE)],
];

describe.each(READS)('%s fanout', (_tool, endpoint, read) => {
  let tools: RobloxStudioTools;
  let request: jest.SpiedFunction<StudioHttpClient['request']>;

  beforeEach(() => {
    const bridge = new FanoutTestBridge();
    registerRole(bridge, 'edit-peer', 'edit');
    registerRole(bridge, 'server-peer', 'server');
    tools = new RobloxStudioTools(bridge);
    request = jest.spyOn(StudioHttpClient.prototype, 'request');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('every peer failing is a tool error that keeps each peer\'s reason', async () => {
    request.mockImplementation(async (_endpoint, _data, peerId) => { throw timeout(peerId); });

    const result = normalizeToolResult(await read(tools), 'modern');

    expect(request).toHaveBeenCalledWith(endpoint, expect.anything(), 'edit-peer');
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: 'all_peers_failed',
      summary: { requested: 2, succeeded: 0, failed: 2 },
      edit: { error: 'request_timeout', message: 'specific diagnostic: timed out' },
      server: { error: 'request_timeout', message: 'specific diagnostic: timed out' },
    });
  });

  test('mixed results keep successful data and mark the partial failure', async () => {
    request.mockImplementation(async (_endpoint, _data, peerId) => {
      if (peerId === 'server-peer') throw new Error('Studio peer went away');
      return { categories: { Script: 12 } };
    });

    const result = normalizeToolResult(await read(tools), 'modern');

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      partial: true,
      summary: { requested: 2, succeeded: 1, failed: 1 },
      edit: { categories: { Script: 12 } },
      server: { error: 'request_failed', message: 'Studio peer went away' },
    });
  });

  test('a Studio handler failure counts as failed and keeps the handler\'s own explanation', async () => {
    const unavailable = { error: 'scene_analysis_unavailable', message: 'service missing', betaFeatureRequired: true };
    request.mockImplementation(async (_endpoint, _data, peerId) =>
      peerId === 'server-peer' ? unavailable : { categories: { Script: 12 } });

    const result = normalizeToolResult(await read(tools), 'modern');

    expect(result.structuredContent).toMatchObject({
      partial: true,
      summary: { requested: 2, succeeded: 1, failed: 1 },
      server: unavailable,
    });
  });

  test('successful data whose nested values mention errors is not a failure', async () => {
    const data = { categories: { error: 3 }, notes: [{ error: 'not a transport failure' }] };
    request.mockResolvedValue(data);

    const result = normalizeToolResult(await read(tools), 'modern');

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      summary: { requested: 2, succeeded: 2, failed: 0 },
      edit: data,
      server: data,
    });
  });

  test('long transport messages are bounded', async () => {
    request.mockRejectedValue(new Error('x'.repeat(5_000)));

    const result = normalizeToolResult(await read(tools), 'modern');
    const structured = result.structuredContent as Record<string, { message: string }>;

    expect(structured.edit.message.length).toBeLessThanOrEqual(500);
  });
});

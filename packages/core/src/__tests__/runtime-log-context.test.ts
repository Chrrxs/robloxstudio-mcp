import * as fs from 'fs';
import * as path from 'path';
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';

const RUNTIME_LOG_TEST_CLAIM_OWNER = 'runtime-log-context-test';

function repositoryRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
}

async function nextPendingRequest(bridge: BridgeService, transportPeerId = 'edit-session') {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const queued = bridge.claimNextRequestForTransport(
      transportPeerId,
      RUNTIME_LOG_TEST_CLAIM_OWNER,
    );
    if (queued) {
      return {
        requestId: queued.requestId,
        request: {
          endpoint: queued.endpoint,
          data: queued.data as Record<string, unknown>,
        },
      };
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('timed out waiting for the plugin request');
}

function runtimeLogCursor(instanceId: string, peers: Record<string, number>): string {
  return Buffer.from(JSON.stringify({ version: 1, instanceId, peers })).toString('base64url');
}

function decodeRuntimeLogCursor(cursor: string) {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
    version: number;
    instanceId: string;
    peers: Record<string, number>;
  };
}

describe('runtime log structured context', () => {
  test('the Studio MessageOut callback stores structured context as optional entry data', () => {
    const source = fs.readFileSync(
      path.join(repositoryRoot(), 'studio-plugin/src/modules/RuntimeLogBuffer.ts'),
      'utf8',
    );

    expect(source).toContain('data?: Record<string, unknown>;');
    expect(source).toMatch(/MessageOut\.Connect\(\(msg, t, context\??:/);
    expect(source).toContain('pushEntry(msg, t, undefined, context);');
    expect(source).toMatch(/entries\.push\(\{[\s\S]*message: safeMessage,\s+data,[\s\S]*\}\);/);
  });

  test('the MCP response preserves optional structured entry data', async () => {
    const bridge = new BridgeService();
    bridge.registerPeer({
      peerId: 'edit-session',
      transportPeerId: 'edit-session',
      instanceId: 'instance:test',
      role: 'edit',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: false,
    });
    const tools = new RobloxStudioTools(bridge);

    const resultPromise = tools.getRuntimeLogs(
      'instance:test',
      undefined,
      undefined,
      undefined,
      10,
    );
    resultPromise.catch(() => {});

    const logsRequest = await nextPendingRequest(bridge);
    expect(logsRequest.request).toEqual({
      endpoint: '/api/get-runtime-logs',
      data: { tail: 10 },
    });
    bridge.resolveRequest(logsRequest.requestId, {
      entries: [{
        seq: 1,
        ts: 1_721_000_000,
        level: 'INFO',
        message: '[Init] required MenuController',
        data: {
          durationMilliseconds: 0.0037,
          moduleName: 'MenuController',
          rank: 13,
        },
      }],
      totalDropped: 0,
      nextSince: 1,
    });

    const result = await resultPromise;
    const first = result.content[0];
    if (first.type !== 'text') throw new Error('expected a text response');
    const response = JSON.parse(first.text);
    expect(response.instanceId).toBe('instance:test');
    expect(Object.keys(response).sort()).toEqual(['entries', 'instanceId', 'nextCursor', 'totalDropped']);
    expect(decodeRuntimeLogCursor(response.nextCursor)).toEqual({
      version: 1,
      instanceId: 'instance:test',
      peers: { 'edit-session': 1 },
    });
    expect(response.entries[0]).not.toHaveProperty('seq');
    expect(response.entries[0].data).toEqual({
      durationMilliseconds: 0.0037,
      moduleName: 'MenuController',
      rank: 13,
    });
  });

  test('accepts a role-suffixed grouped runtime Instance ID', async () => {
    const bridge = new BridgeService();
    bridge.registerPeer({
      peerId: 'server-session',
      transportPeerId: 'server-session',
      instanceId: 'instance:abc-123',
      multiplayerGroupId: 'group-1',
      role: 'server',
      placeId: 1,
      placeName: 'TestPlace',
      dataModelName: 'TestPlaceServer',
      isRunning: true,
    });
    const tools = new RobloxStudioTools(bridge);

    const resultPromise = tools.getRuntimeLogs('instance:abc-123-server');
    const logsRequest = await nextPendingRequest(bridge, 'server-session');
    bridge.resolveRequest(logsRequest.requestId, {
      entries: [{ seq: 1, ts: 10, level: 'INFO', message: 'server entry' }],
      totalDropped: 0,
      nextSince: 1,
    });

    const result = await resultPromise;
    const first = result.content[0];
    if (first.type !== 'text') throw new Error('expected a text response');
    expect(JSON.parse(first.text)).toMatchObject({
      instanceId: 'instance:abc-123',
      entries: [{ ts: 10, level: 'INFO', message: 'server entry' }],
    });
  });

  test('merges every Peer buffer in each Instance and preserves isolated cursors and failures', async () => {
    const bridge = new BridgeService();
    bridge.createMultiplayerGroup('group-1', 'instance:edit');
    for (const peer of [
      {
        peerId: 'edit-session',
        transportPeerId: 'edit-session',
        instanceId: 'instance:edit',
        role: 'edit',
        multiplayerGroupId: 'group-1',
      },
      {
        peerId: 'server-session',
        transportPeerId: 'server-session',
        instanceId: 'instance:edit',
        role: 'server',
        multiplayerGroupId: 'group-1',
      },
      {
        peerId: 'client-session',
        transportPeerId: 'client-session',
        instanceId: 'instance:client',
        role: 'client-1',
        multiplayerGroupId: 'group-1',
      },
    ]) {
      bridge.registerPeer({
        ...peer,
        placeId: 1,
        placeName: 'TestPlace',
        dataModelName: peer.role,
        isRunning: peer.role !== 'edit',
      });
    }
    const tools = new RobloxStudioTools(bridge);
    const inputCursors = {
      'instance:edit': runtimeLogCursor('instance:edit', {
        'edit-session': 5,
        'server-session': 7,
      }),
      'instance:client': runtimeLogCursor('instance:client', {
        'client-session': 9,
      }),
    };

    const resultPromise = tools.getRuntimeLogs(
      undefined,
      'group-1',
      undefined,
      inputCursors,
      20,
      'needle',
    );
    const editRequest = await nextPendingRequest(bridge, 'edit-session');
    const serverRequest = await nextPendingRequest(bridge, 'server-session');
    const clientRequest = await nextPendingRequest(bridge, 'client-session');
    expect(editRequest.request.data).toEqual({ since: 5, tail: 20, filter: 'needle' });
    expect(serverRequest.request.data).toEqual({ since: 7, tail: 20, filter: 'needle' });
    expect(clientRequest.request.data).toEqual({ since: 9, tail: 20, filter: 'needle' });
    bridge.resolveRequest(editRequest.requestId, {
      entries: [{ seq: 8, ts: 20, level: 'INFO', message: 'edit needle' }],
      totalDropped: 2,
      nextSince: 8,
    });
    bridge.resolveRequest(serverRequest.requestId, {
      entries: [{ seq: 12, ts: 10, level: 'INFO', message: 'server needle' }],
      totalDropped: 3,
      nextSince: 12,
    });
    bridge.rejectRequest(clientRequest.requestId, new Error('client disconnected'));

    const result = await resultPromise;
    const first = result.content[0];
    if (first.type !== 'text') throw new Error('expected a text response');
    const body = JSON.parse(first.text);
    expect(body.multiplayerGroupId).toBe('group-1');
    expect(body.instances).toHaveLength(2);
    expect(body.instances[0]).toMatchObject({
      instanceId: 'instance:edit',
      entries: [
        { ts: 10, level: 'INFO', message: 'server needle' },
        { ts: 20, level: 'INFO', message: 'edit needle' },
      ],
      totalDropped: 5,
    });
    expect(body.instances[0].entries.every((entry: Record<string, unknown>) => !('seq' in entry))).toBe(true);
    expect(decodeRuntimeLogCursor(body.instances[0].nextCursor)).toEqual({
      version: 1,
      instanceId: 'instance:edit',
      peers: { 'edit-session': 8, 'server-session': 12 },
    });
    expect(body.instances[1]).toMatchObject({
      instanceId: 'instance:client',
      error: 'Every connected Peer failed to read its runtime log buffer.',
      peerErrors: [{
        peerId: 'client-session',
        role: 'client-1',
        error: 'client disconnected',
      }],
    });
    expect(decodeRuntimeLogCursor(body.instances[1].nextCursor)).toEqual({
      version: 1,
      instanceId: 'instance:client',
      peers: { 'client-session': 9 },
    });
    expect(body.nextCursorByInstance).toEqual({
      'instance:edit': body.instances[0].nextCursor,
      'instance:client': body.instances[1].nextCursor,
    });
  });
});

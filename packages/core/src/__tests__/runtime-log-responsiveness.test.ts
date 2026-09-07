import { BridgeService } from '../bridge-service.js';
import { TOOL_HANDLERS } from '../http-server.js';
import { RobloxStudioTools } from '../tools/index.js';

interface RuntimeLogResult {
  instanceId: string;
  entries?: Array<{ ts: number; level: string; message: string }>;
  totalDropped?: number;
  nextCursor: string;
  error?: string;
  peerErrors?: Array<{ peerId: string; role: string; error: string }>;
}

interface RuntimeLogGroupResult {
  multiplayerGroupId: string;
  instances: RuntimeLogResult[];
  nextCursorByInstance: Record<string, string>;
}

type Settlement = { value: unknown } | { error: unknown };

function observe(promise: Promise<unknown>): Settlement[] {
  const settlements: Settlement[] = [];
  void promise.then(
    (value) => { settlements.push({ value }); },
    (error: unknown) => { settlements.push({ error }); },
  );
  return settlements;
}

function responseText(settlements: Settlement[]): string {
  expect(settlements).toHaveLength(1);
  const settlement = settlements[0];
  if (!settlement || !('value' in settlement)) throw new Error('expected a successful tool response');
  const value = settlement.value;
  if (typeof value !== 'object' || value === null || !('content' in value) || !Array.isArray(value.content)) {
    throw new Error('expected tool content');
  }
  const first: unknown = value.content[0];
  if (typeof first !== 'object' || first === null || !('text' in first) || typeof first.text !== 'string') {
    throw new Error('expected text content');
  }
  return first.text;
}

function result(settlements: Settlement[]): RuntimeLogResult {
  return JSON.parse(responseText(settlements)) as RuntimeLogResult;
}

function groupResult(settlements: Settlement[]): RuntimeLogGroupResult {
  return JSON.parse(responseText(settlements)) as RuntimeLogGroupResult;
}

function cursor(instanceId: string, peers: Record<string, number>): string {
  return Buffer.from(JSON.stringify({ version: 1, instanceId, peers })).toString('base64url');
}

function expectCursor(value: string, instanceId: string, peers: Record<string, number>): void {
  expect(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))).toEqual({ version: 1, instanceId, peers });
}

function logResponse(message: string, nextSince: number, ts = nextSince) {
  return { entries: [{ seq: nextSince, ts, level: 'INFO', message }], totalDropped: 0, nextSince };
}

describe('runtime log responsiveness', () => {
  const bridges: BridgeService[] = [];

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    for (const bridge of bridges) bridge.clearAllPendingRequests();
    bridges.length = 0;
    jest.useRealTimers();
  });

  function fixture(groupId?: string) {
    const bridge = new BridgeService();
    bridges.push(bridge);
    const tools = new RobloxStudioTools(bridge);
    if (groupId) bridge.createMultiplayerGroup(groupId, 'instance:test');
    const peerId = (role: string, instanceId = 'instance:test') => `${instanceId}/${role}`;
    const register = (role: string, instanceId = 'instance:test') => bridge.registerPeer({
      peerId: peerId(role, instanceId),
      transportPeerId: peerId(role, instanceId),
      instanceId,
      role,
      multiplayerGroupId: groupId,
      placeId: 1,
      placeName: 'TestPlace',
      dataModelName: role,
      isRunning: role !== 'edit',
    });
    register('edit');
    const query = (body: Record<string, unknown> = {}, signal?: AbortSignal) => observe(
      TOOL_HANDLERS.get_runtime_logs(tools, {
        ...(groupId ? { multiplayer_group_id: groupId } : { instance_id: 'instance:test' }),
        tail: 10,
        filter: 'needle',
        ...body,
      }, signal ? { signal } : undefined),
    );
    const claim = (role: string, instanceId = 'instance:test') => {
      const request = bridge.claimNextRequestForTransport(peerId(role, instanceId), peerId(role, instanceId));
      expect(request?.endpoint).toBe('/api/get-runtime-logs');
      if (!request) throw new Error('expected a runtime log request');
      return request;
    };
    const answer = (role: string, nextSince: number, instanceId = 'instance:test', ts = nextSince) => {
      const request = claim(role, instanceId);
      expect(bridge.resolveRequest(request.requestId, logResponse(`${role} needle`, nextSince, ts))).toBe('accepted');
      return request;
    };
    return { bridge, register, peerId, query, claim, answer };
  }

  test('healthy edit/play/edit reads remain immediate over repeated cycles and isolate another Instance', async () => {
    const { bridge, register, peerId, query, answer } = fixture();
    register('edit', 'instance:other');
    let nextCursor: string | undefined;
    for (let cycle = 0; cycle < 3; cycle++) {
      const edit = query(nextCursor ? { cursor: nextCursor } : {});
      answer('edit', cycle * 2 + 1);
      await jest.advanceTimersByTimeAsync(0);
      expect(result(edit).entries).toEqual([{ ts: cycle * 2 + 1, level: 'INFO', message: 'edit needle' }]);

      register('server');
      register('client-1');
      const play = query({ cursor: result(edit).nextCursor });
      answer('edit', cycle * 2 + 2, 'instance:test', 30);
      answer('server', 1, 'instance:test', 10);
      answer('client-1', 1, 'instance:test', 20);
      await jest.advanceTimersByTimeAsync(0);
      expect(result(play).entries).toEqual([
        { ts: 10, level: 'INFO', message: 'server needle' },
        { ts: 20, level: 'INFO', message: 'client-1 needle' },
        { ts: 30, level: 'INFO', message: 'edit needle' },
      ]);
      expect(result(play).peerErrors).toBeUndefined();
      bridge.unregisterPeer(peerId('server'));
      bridge.unregisterPeer(peerId('client-1'));
      const stopped = query({ cursor: result(play).nextCursor });
      answer('edit', cycle * 2 + 2);
      await jest.advanceTimersByTimeAsync(0);
      nextCursor = result(stopped).nextCursor;
      expectCursor(nextCursor, 'instance:test', { [peerId('edit')]: cycle * 2 + 2 });
      expect(bridge.claimNextRequestForTransport(peerId('edit', 'instance:other'), 'other')).toBeNull();
      expect(bridge.getPendingRequestCount()).toBe(0);
    }
  });

  test.each([false, true])('a stalled peer expires at 5s, preserves its cursor, and permits recovery (claimed=%s)', async (claimed) => {
    const { bridge, register, peerId, query, claim, answer } = fixture();
    register('server');
    register('client-1');
    const pending = query({ cursor: cursor('instance:test', {
      [peerId('edit')]: 4,
      [peerId('server')]: 6,
      [peerId('client-1')]: 8,
    }) });
    expect(answer('edit', 5).data).toEqual({ since: 4, tail: 10, filter: 'needle' });
    expect(answer('server', 7).data).toEqual({ since: 6, tail: 10, filter: 'needle' });
    const stalled = claimed ? claim('client-1') : undefined;
    await jest.advanceTimersByTimeAsync(4_999);
    expect(pending).toEqual([]);
    expect(bridge.getPendingRequestCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    const partial = result(pending);
    expect(partial.entries).toEqual([
      { ts: 5, level: 'INFO', message: 'edit needle' },
      { ts: 7, level: 'INFO', message: 'server needle' },
    ]);
    expect(partial.peerErrors).toEqual([{
      peerId: peerId('client-1'), role: 'client-1', error: expect.stringMatching(/timeout|timed out/i),
    }]);
    expectCursor(partial.nextCursor, 'instance:test', {
      [peerId('edit')]: 5, [peerId('server')]: 7, [peerId('client-1')]: 8,
    });
    expect(bridge.getPendingRequestCount()).toBe(0);
    expect(bridge.claimNextRequestForTransport(peerId('client-1'), 'next')).toBeNull();
    if (stalled) {
      expect(bridge.claimNextCancellationForTransport(peerId('client-1'), 'cancel')).toEqual({
        requestId: stalled.requestId, reason: 'timeout',
      });
      expect(bridge.resolveRequest(stalled.requestId, logResponse('late needle', 999))).toBe('unknown');
    }

    const recovered = query({ cursor: partial.nextCursor });
    answer('edit', 6);
    answer('server', 8);
    expect(answer('client-1', 9).data).toEqual({ since: 8, tail: 10, filter: 'needle' });
    await jest.advanceTimersByTimeAsync(0);
    expect(result(recovered).entries).toEqual([
      { ts: 6, level: 'INFO', message: 'edit needle' },
      { ts: 8, level: 'INFO', message: 'server needle' },
      { ts: 9, level: 'INFO', message: 'client-1 needle' },
    ]);
    expect(result(recovered).peerErrors).toBeUndefined();
    bridge.unregisterPeer(peerId('server'));
    bridge.unregisterPeer(peerId('client-1'));
    const stopped = query({ cursor: result(recovered).nextCursor });
    answer('edit', 6);
    await jest.advanceTimersByTimeAsync(0);
    expectCursor(result(stopped).nextCursor, 'instance:test', { [peerId('edit')]: 6 });
    expect(bridge.getPendingRequestCount()).toBe(0);
  });

  test('all peers timing out still reject a single-Instance read', async () => {
    const { bridge, register, query } = fixture();
    register('server');
    const pending = query();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(pending).toEqual([{ error: expect.objectContaining({
      message: expect.stringMatching(/get_runtime_logs failed for Instance .*Every connected Peer failed/),
    }) }]);
    expect(bridge.getPendingRequestCount()).toBe(0);
  });

  test('multiplayer reads retain a failed Instance and its cursor alongside healthy results', async () => {
    const { bridge, register, peerId, query, answer } = fixture('group:test');
    register('client-1', 'instance:client');
    const pending = query({ cursor_by_instance: {
      'instance:test': cursor('instance:test', { [peerId('edit')]: 4 }),
      'instance:client': cursor('instance:client', { [peerId('client-1', 'instance:client')]: 8 }),
    } });
    answer('edit', 5);
    await jest.advanceTimersByTimeAsync(5_000);
    const body = groupResult(pending);
    expect(body.multiplayerGroupId).toBe('group:test');
    expect(body.instances).toEqual([
      expect.objectContaining({ instanceId: 'instance:test', entries: [{ ts: 5, level: 'INFO', message: 'edit needle' }] }),
      expect.objectContaining({
        instanceId: 'instance:client', error: expect.stringContaining('Every connected Peer failed'),
        peerErrors: [{ peerId: peerId('client-1', 'instance:client'), role: 'client-1', error: expect.stringMatching(/timeout|timed out/i) }],
      }),
    ]);
    expectCursor(body.nextCursorByInstance['instance:test'], 'instance:test', { [peerId('edit')]: 5 });
    expectCursor(body.nextCursorByInstance['instance:client'], 'instance:client', { [peerId('client-1', 'instance:client')]: 8 });
    expect(bridge.getPendingRequestCount()).toBe(0);
  });

  test.each([false, true])('caller abort rejects promptly and cancels queued and claimed fanout (multiplayer=%s)', async (multiplayer) => {
    const { bridge, register, peerId, query, claim, answer } = fixture(multiplayer ? 'group:test' : undefined);
    const clientInstance = multiplayer ? 'instance:client' : 'instance:test';
    register('server');
    register('client-1', clientInstance);
    const controller = new AbortController();
    const pending = query({}, controller.signal);
    answer('edit', 1);
    const claimed = claim('server');
    controller.abort();
    await jest.advanceTimersByTimeAsync(0);
    expect(pending).toEqual([{ error: expect.objectContaining({ message: 'Request aborted' }) }]);
    expect(bridge.getPendingRequestCount()).toBe(0);
    expect(bridge.claimNextRequestForTransport(peerId('client-1', clientInstance), 'next')).toBeNull();
    expect(bridge.claimNextCancellationForTransport(peerId('server'), 'cancel')).toEqual({
      requestId: claimed.requestId, reason: 'aborted',
    });
    expect(bridge.resolveRequest(claimed.requestId, logResponse('late needle', 999))).toBe('unknown');
    const recovered = query();
    answer('edit', 2);
    answer('server', 2);
    answer('client-1', 2, clientInstance);
    await jest.advanceTimersByTimeAsync(0);
    const recoveredInstances = multiplayer ? groupResult(recovered).instances : [result(recovered)];
    expect(recoveredInstances.flatMap((instance) => instance.entries ?? [])).toEqual([
      { ts: 2, level: 'INFO', message: 'edit needle' },
      { ts: 2, level: 'INFO', message: 'server needle' },
      { ts: 2, level: 'INFO', message: 'client-1 needle' },
    ]);
    expect(bridge.getPendingRequestCount()).toBe(0);
  });

  test('an already-aborted caller never queues runtime log work', async () => {
    const { bridge, register, peerId, query } = fixture();
    register('server');
    const controller = new AbortController();
    controller.abort();
    const pending = query({}, controller.signal);
    expect(bridge.getPendingRequestCount()).toBe(0);
    expect(bridge.claimNextRequestForTransport(peerId('edit'), 'next')).toBeNull();
    expect(bridge.claimNextRequestForTransport(peerId('server'), 'next')).toBeNull();
    await jest.advanceTimersByTimeAsync(0);
    expect(pending).toEqual([{ error: expect.objectContaining({ message: 'Request aborted' }) }]);
  });
});

import { BridgeService, MultiplayerGroupInUseError, RequestFailure } from '../bridge-service.js';
import { ProxyBridgeService } from '../proxy-bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';

interface RuntimeLogResult {
  instanceId: string;
  entries: Array<{ ts: number; level: string; message: string }>;
  nextCursor: string;
  peerErrors?: Array<{ peerId: string; role: string; error: string }>;
}

function expectCursor(value: string, instanceId: string, peers: Record<string, number>): void {
  expect(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))).toEqual({ version: 1, instanceId, peers });
}

function hangingResponse(init?: RequestInit) {
  const pending = Promise.withResolvers<Response>();
  const signal = init?.signal;
  if (!signal) throw new Error('Topology refresh must provide an AbortSignal');
  if (signal.aborted) pending.reject(signal.reason);
  else signal.addEventListener('abort', () => pending.reject(signal.reason), { once: true });
  return { promise: pending.promise, signal };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Exercise real routing/aggregation on both sides; replace only the HTTP transport.
async function fixture(authToken?: string) {
  const primary = new BridgeService();
  const forwarded: string[] = [];
  const requests: Array<{ peerId: string; data: unknown }> = [];
  const stalled = new Set<string>();
  const sequences = new Map<string, number>();
  const endpointResponses = new Map<string, unknown>();
  const register = (
    role: string,
    instanceId = 'instance:test',
    peerId = `${instanceId}/${role}`,
    multiplayerGroupId?: string,
  ) => primary.registerPeer({
    peerId, transportPeerId: peerId,
    instanceId, role, multiplayerGroupId, placeId: 0, placeName: 'TestPlace', dataModelName: role,
    isRunning: role !== 'edit',
  });
  register('edit');
  register('server');
  register('client-1');
  register('edit', 'instance:other');
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input) === 'http://primary/topology') return jsonResponse(primary.getTopologySnapshot());
    if (String(input) === 'http://primary/remove-multiplayer-group') {
      const removal: unknown = JSON.parse(String(init?.body));
      if (!removal || typeof removal !== 'object' || !('groupId' in removal) || typeof removal.groupId !== 'string') {
        throw new Error('Invalid group removal request');
      }
      try {
        return jsonResponse({ removed: primary.removeMultiplayerGroup(removal.groupId) });
      } catch (error) {
        if (!(error instanceof MultiplayerGroupInUseError)) throw error;
        return jsonResponse({
          success: false, error: error.code, message: error.message, groupId: error.groupId,
        }, 409);
      }
    }
    expect(String(input)).toBe('http://primary/proxy');
    const body: unknown = JSON.parse(String(init?.body));
    if (!body || typeof body !== 'object'
      || !('endpoint' in body) || typeof body.endpoint !== 'string'
      || !('targetPeerId' in body) || typeof body.targetPeerId !== 'string'
      || !('data' in body)
      || !('timeoutMs' in body) || typeof body.timeoutMs !== 'number') {
      throw new Error('Invalid proxy request');
    }
    forwarded.push(body.targetPeerId);
    requests.push({ peerId: body.targetPeerId, data: body.data });
    const pending = primary.sendRequest(body.endpoint, body.data, body.targetPeerId, body.timeoutMs);
    const queued = primary.claimNextRequestForTransport(body.targetPeerId, 'test');
    if (queued && !stalled.has(body.targetPeerId)) {
      const seq = (sequences.get(body.targetPeerId) ?? 0) + 1;
      sequences.set(body.targetPeerId, seq);
      primary.resolveRequest(queued.requestId, endpointResponses.get(body.endpoint) ?? {
        entries: [{ seq, ts: seq, level: 'INFO', message: body.targetPeerId }], totalDropped: 0, nextSince: seq,
      });
    }
    try {
      return jsonResponse({ response: await pending });
    } catch (error) {
      return jsonResponse({
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof RequestFailure ? { code: error.code, details: error.details } : {}),
      }, 500);
    }
  });
  const proxy = new ProxyBridgeService('http://primary', authToken);
  await proxy.waitForInitialRefresh();
  return {
    primary, proxy, forwarded, requests, stalled, register, fetchMock, endpointResponses,
    tools: new RobloxStudioTools(proxy),
    close() {
      proxy.stop();
      primary.clearAllPendingRequests();
      fetchMock.mockRestore();
    },
  };
}

describe('proxy runtime logs across lifecycle transitions', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('post-stop reads do not enqueue dead runtime peers from the proxy cache', async () => {
    const harness = await fixture();
    try {
      harness.primary.unregisterPeer('instance:test/server');
      harness.primary.unregisterPeer('instance:test/client-1');
      expect(harness.proxy.getPeers().some((peer) => peer.role === 'server')).toBe(true);
      const settled: unknown[] = [];
      const query = harness.tools.getRuntimeLogs('instance:test', undefined, undefined, undefined, 10);
      void query.then((value) => settled.push(value));
      // Drain promises without reaching the one-second periodic topology poll.
      await jest.advanceTimersByTimeAsync(0);
      expect(harness.forwarded).toEqual(['instance:test/edit']);
      expect(settled).toHaveLength(1);
      const body: unknown = JSON.parse((await query).content[0].text);
      expect(body).toMatchObject({ instanceId: 'instance:test', entries: [{ message: 'instance:test/edit' }] });
      expect(body).not.toHaveProperty('peerErrors');
      expect(harness.primary.getPendingRequestCount()).toBe(0);
    } finally {
      harness.close();
      await jest.advanceTimersByTimeAsync(0);
    }
  });

  test('repeated restarts prune old peer cursors without reading another Instance', async () => {
    const harness = await fixture();
    try {
      const initial: RuntimeLogResult = JSON.parse((await harness.tools.getRuntimeLogs('instance:test')).content[0].text);
      let cursor = initial.nextCursor;
      let runtimeIds = ['instance:test/server', 'instance:test/client-1'];
      for (let cycle = 1; cycle <= 3; cycle++) {
        for (const peerId of runtimeIds) harness.primary.unregisterPeer(peerId);
        harness.forwarded.length = 0;
        const stopped: RuntimeLogResult = JSON.parse(
          (await harness.tools.getRuntimeLogs('instance:test', undefined, cursor)).content[0].text,
        );
        expect(harness.forwarded).toEqual(['instance:test/edit']);
        expect(stopped.peerErrors).toBeUndefined();
        expectCursor(stopped.nextCursor, 'instance:test', { 'instance:test/edit': cycle * 2 });

        runtimeIds = [`server-session-${cycle}`, `client-session-${cycle}`];
        harness.register('server', 'instance:test', runtimeIds[0]);
        harness.register('client-1', 'instance:test', runtimeIds[1]);
        harness.forwarded.length = 0;
        harness.requests.length = 0;
        const playing: RuntimeLogResult = JSON.parse(
          (await harness.tools.getRuntimeLogs('instance:test', undefined, stopped.nextCursor)).content[0].text,
        );
        expect(harness.forwarded).toEqual(['instance:test/edit', ...runtimeIds]);
        expect(harness.requests).toEqual([
          { peerId: 'instance:test/edit', data: { since: cycle * 2 } },
          ...runtimeIds.map((peerId) => ({ peerId, data: {} })),
        ]);
        expect(playing.entries.map((entry) => entry.message)).toEqual([
          ...runtimeIds, 'instance:test/edit',
        ]);
        expect(playing.peerErrors).toBeUndefined();
        expectCursor(playing.nextCursor, 'instance:test', {
          'instance:test/edit': cycle * 2 + 1, [runtimeIds[0]]: 1, [runtimeIds[1]]: 1,
        });
        cursor = playing.nextCursor;
        expect(harness.primary.getPendingRequestCount()).toBe(0);
      }
      expect(harness.primary.claimNextRequestForTransport('instance:other/edit', 'other')).toBeNull();
    } finally {
      harness.close();
      await jest.advanceTimersByTimeAsync(0);
    }
  });

  test('fresh topology selects new multiplayer groups and role-suffixed Instances', async () => {
    const harness = await fixture();
    try {
      harness.primary.createMultiplayerGroup('group:new', 'instance:controller');
      harness.register('edit', 'instance:controller', 'controller-session', 'group:new');
      harness.register('server', 'instance:runtime', 'server-session', 'group:new');
      expect(harness.proxy.getMultiplayerGroups()).toEqual([]);
      const grouped: {
        multiplayerGroupId: string;
        instances: RuntimeLogResult[];
      } = JSON.parse((await harness.tools.getRuntimeLogs(undefined, 'group:new')).content[0].text);
      expect(grouped.multiplayerGroupId).toBe('group:new');
      expect(grouped.instances.map((instance) => instance.instanceId).sort()).toEqual([
        'instance:controller', 'instance:runtime',
      ]);
      expect(harness.forwarded.sort()).toEqual(['controller-session', 'server-session']);

      harness.primary.unregisterPeer('server-session');
      harness.register('server', 'instance:replacement', 'replacement-session', 'group:new');
      harness.forwarded.length = 0;
      const selected: RuntimeLogResult = JSON.parse(
        (await harness.tools.getRuntimeLogs('instance:replacement-server')).content[0].text,
      );
      expect(selected.instanceId).toBe('instance:replacement');
      expect(selected.entries.map((entry) => entry.message)).toEqual(['replacement-session']);
      expect(harness.forwarded).toEqual(['replacement-session']);
    } finally {
      harness.close();
      await jest.advanceTimersByTimeAsync(0);
    }
  });

  test('routing topology GET carries the primary authentication token', async () => {
    const harness = await fixture('test-primary-token');
    try {
      harness.fetchMock.mockImplementationOnce(async (input, init) => {
        expect(String(input)).toBe('http://primary/topology');
        expect(init?.method ?? 'GET').toBe('GET');
        if (new Headers(init?.headers).get('X-MCP-Auth') !== 'test-primary-token') {
          return jsonResponse({ error: 'Unauthorized' }, 401);
        }
        return jsonResponse(harness.primary.getTopologySnapshot());
      });
      await harness.tools.getRuntimeLogs('instance:test');
      expect(harness.forwarded).toEqual(['instance:test/edit', 'instance:test/server', 'instance:test/client-1']);
    } finally {
      harness.close();
      await jest.advanceTimersByTimeAsync(0);
    }
  });

  test.each([
    { name: 'HTTP', respond: async () => jsonResponse({ error: 'Unavailable' }, 503), error: /503/ },
    { name: 'invalid topology', respond: async () => jsonResponse({ peers: [] }), error: /invalid.*topology/i },
    { name: 'invalid JSON', respond: async () => new Response('{'), error: /JSON/i },
    { name: 'network', respond: async () => { throw new Error('primary unreachable'); }, error: /primary unreachable/ },
  ])('$name refresh failure rejects rather than forwarding cached peers', async ({ respond, error }) => {
    const harness = await fixture();
    try {
      harness.primary.unregisterPeer('instance:test/server');
      harness.primary.unregisterPeer('instance:test/client-1');
      harness.fetchMock.mockImplementationOnce(respond);
      await expect(harness.tools.getRuntimeLogs('instance:test')).rejects.toThrow(error);
      expect(harness.forwarded).toEqual([]);
      expect(harness.primary.getPendingRequestCount()).toBe(0);
    } finally {
      harness.close();
      await jest.advanceTimersByTimeAsync(0);
    }
  });

  test('a hanging routing fetch is aborted at two seconds without fanout', async () => {
    const harness = await fixture();
    try {
      const started = Promise.withResolvers<AbortSignal>();
      harness.fetchMock.mockImplementationOnce((_input, init) => {
        const pending = hangingResponse(init);
        started.resolve(pending.signal);
        return pending.promise;
      });
      const query = harness.tools.getRuntimeLogs('instance:test');
      const rejected = expect(query).rejects.toThrow(/topology.*timed out/i);
      const signal = await started.promise;
      await jest.advanceTimersByTimeAsync(1_999);
      expect(signal.aborted).toBe(false);
      expect(harness.forwarded).toEqual([]);
      await jest.advanceTimersByTimeAsync(1);
      await rejected;
      expect(signal.aborted).toBe(true);
      expect(harness.forwarded).toEqual([]);
      expect(harness.primary.getPendingRequestCount()).toBe(0);
    } finally {
      harness.close();
      await jest.advanceTimersByTimeAsync(0);
    }
  });

  test('caller cancellation aborts a routing refresh before its deadline without fanout', async () => {
    const harness = await fixture();
    try {
      const started = Promise.withResolvers<AbortSignal>();
      harness.fetchMock.mockImplementationOnce((_input, init) => {
        const pending = hangingResponse(init);
        started.resolve(pending.signal);
        return pending.promise;
      });
      const controller = new AbortController();
      const query = harness.tools.getRuntimeLogs(
        'instance:test', undefined, undefined, undefined, undefined, undefined, controller.signal,
      );
      const reason = new Error('caller cancelled logs');
      const rejected = expect(query).rejects.toBe(reason);
      const signal = await started.promise;
      controller.abort(reason);
      await jest.advanceTimersByTimeAsync(0);
      await rejected;
      expect(signal.aborted).toBe(true);
      expect(harness.forwarded).toEqual([]);
      expect(harness.primary.getPendingRequestCount()).toBe(0);
    } finally {
      harness.close();
      await jest.advanceTimersByTimeAsync(0);
    }
  });

  test('an older periodic response cannot resurrect runtime peers removed by a routing refresh', async () => {
    const harness = await fixture();
    const oldPoll = Promise.withResolvers<Response>();
    try {
      const oldSnapshot = harness.primary.getTopologySnapshot();
      harness.fetchMock.mockImplementationOnce(() => oldPoll.promise);
      await jest.advanceTimersByTimeAsync(1_000);
      harness.primary.unregisterPeer('instance:test/server');
      harness.primary.unregisterPeer('instance:test/client-1');
      await harness.tools.getRuntimeLogs('instance:test');
      expect(harness.forwarded).toEqual(['instance:test/edit']);
      oldPoll.resolve(jsonResponse(oldSnapshot));
      await jest.advanceTimersByTimeAsync(0);
      expect(harness.proxy.getPeers().map((peer) => peer.peerId).sort()).toEqual([
        'instance:other/edit', 'instance:test/edit',
      ]);
      expect(harness.proxy.getInstances().find((instance) => instance.id === 'instance:test')?.peers)
        .toEqual([expect.objectContaining({ peerId: 'instance:test/edit' })]);
    } finally {
      oldPoll.resolve(jsonResponse(harness.primary.getTopologySnapshot()));
      await jest.advanceTimersByTimeAsync(0);
      harness.close();
    }
  });

  test('a still-registered stalled peer remains a visible error after refreshing topology', async () => {
    const harness = await fixture();
    try {
      harness.stalled.add('instance:test/client-1');
      const query = harness.tools.getRuntimeLogs('instance:test');
      await jest.advanceTimersByTimeAsync(5_000);
      const body: RuntimeLogResult = JSON.parse((await query).content[0].text);
      expect(body.entries.map((entry) => entry.message)).toEqual(['instance:test/edit', 'instance:test/server']);
      expect(body.peerErrors).toEqual([{
        peerId: 'instance:test/client-1', role: 'client-1', error: expect.stringMatching(/timeout|timed out/i),
      }]);
      expect(harness.primary.getPendingRequestCount()).toBe(0);
    } finally {
      harness.close();
      await jest.advanceTimersByTimeAsync(0);
    }
  });
});

describe('proxy discovery and tool routing before the next topology poll', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('discovery includes a newly connected process without advancing the polling clock', async () => {
    const harness = await fixture();
    try {
      harness.register('edit', 'instance:new');
      const primaryTools = new RobloxStudioTools(harness.primary);
      expect(await harness.tools.getConnectedInstances()).toEqual(await primaryTools.getConnectedInstances());
      expect(harness.forwarded).toEqual([]);
    } finally {
      harness.close();
    }
  });

  test('a primary-discovered ID routes through the proxy without prior proxy discovery', async () => {
    const harness = await fixture();
    try {
      harness.register('edit', 'instance:new');
      await harness.tools.getPlaceInfo('instance:new');
      expect(harness.forwarded).toEqual(['instance:new/edit']);
    } finally {
      harness.close();
    }
  });

  test('a disconnected discovered ID is rejected without substituting a remaining process', async () => {
    const harness = await fixture();
    try {
      await harness.tools.getConnectedInstances();
      harness.primary.unregisterPeer('instance:other/edit');
      await expect(harness.tools.getPlaceInfo('instance:other')).rejects.toMatchObject({
        routingError: { code: 'unrecognized_instance_id' },
      });
      expect(harness.forwarded).toEqual([]);
      expect(harness.primary.getPendingRequestCount()).toBe(0);
    } finally {
      harness.close();
    }
  });

  test('an omitted instance cannot silently select the sole cached process when another has connected', async () => {
    const harness = await fixture();
    try {
      harness.primary.unregisterPeer('instance:other/edit');
      await harness.proxy.refreshTopologyForRouting();
      harness.register('edit', 'instance:new');
      await expect(harness.tools.getPlaceInfo()).rejects.toMatchObject({
        routingError: { code: 'multiple_instances_connected' },
      });
      expect(harness.forwarded).toEqual([]);
    } finally {
      harness.close();
    }
  });

  test('fanout includes a newly connected role in the selected process only', async () => {
    const harness = await fixture();
    try {
      harness.register('client-2');
      await harness.tools.getMemoryBreakdown('all', undefined, 'instance:test');
      expect(harness.forwarded.sort()).toEqual([
        'instance:test/client-1', 'instance:test/client-2', 'instance:test/edit', 'instance:test/server',
      ]);
    } finally {
      harness.close();
    }
  });

  test('runtime target resolution sees a new process before choosing its peer', async () => {
    const harness = await fixture();
    try {
      harness.register('edit', 'instance:new');
      await harness.tools.simulateMouseInput('click', 10, 20, undefined, undefined, undefined, 'instance:new');
      expect(harness.forwarded).toEqual(['instance:new/edit']);
    } finally {
      harness.close();
    }
  });

  test('discovery and inspection fail explicitly when the primary topology is unavailable', async () => {
    const harness = await fixture();
    try {
      harness.fetchMock.mockRejectedValue(new Error('primary unavailable'));
      await expect(harness.tools.getConnectedInstances()).rejects.toThrow('primary unavailable');
      await expect(harness.tools.getPlaceInfo('instance:other')).rejects.toThrow('primary unavailable');
      expect(harness.forwarded).toEqual([]);
      expect(harness.primary.getPendingRequestCount()).toBe(0);
    } finally {
      harness.close();
    }
  });

  test('a stale controller cannot erase a live group and invalidate another session’s discovered runtime ID', async () => {
    const harness = await fixture();
    let observer: ProxyBridgeService | undefined;
    try {
      harness.primary.unregisterInstanceId('instance:test');
      harness.primary.createMultiplayerGroup('test:live', 'instance:other');
      await harness.proxy.refreshTopologyForRouting();
      // The controller caches only the edit process. The runtime connects before
      // its next background poll, while an observer session sees the live group.
      harness.register('server', 'instance:runtime', 'runtime-peer', 'test:live');
      observer = new ProxyBridgeService('http://primary');
      await observer.waitForInitialRefresh();
      const observerTools = new RobloxStudioTools(observer);
      const before = await observerTools.getConnectedInstances();
      expect(JSON.parse(before.content[0].text)).toMatchObject({
        multiplayerGroups: [{ instances: { 'instance:runtime-server': 'runtime-peer' } }],
      });
      await observerTools.getMemoryBreakdown('server', undefined, 'instance:runtime-server');

      harness.endpointResponses.set('/api/multiplayer-test-end', { error: 'runtime refuses teardown' });
      const ended = await harness.tools.multiplayerTestEnd(undefined, 1, 'instance:other');
      expect(JSON.parse(ended.content[0].text)).toMatchObject({ error: 'runtime refuses teardown' });
      // Same observer and exact same discovered alias must still route. Before
      // the fix, the controller silently removed the group as "already ended".
      expect(await observerTools.getConnectedInstances()).toEqual(before);
      await observerTools.getMemoryBreakdown('server', undefined, 'instance:runtime-server');
      expect(harness.forwarded).toEqual(['runtime-peer', 'runtime-peer', 'runtime-peer']);
      expect(harness.primary.getInstances()).toHaveLength(2);
      expect(harness.primary.getMultiplayerGroups()).toHaveLength(1);
    } finally {
      observer?.stop();
      harness.close();
    }
  });

  test('runtime registration between a fresh topology read and removal cannot invalidate another session’s alias', async () => {
    const harness = await fixture();
    const readStarted = Promise.withResolvers<void>();
    const heldTopology = Promise.withResolvers<Response>();
    let observer: ProxyBridgeService | undefined;
    try {
      harness.primary.unregisterInstanceId('instance:test');
      harness.primary.createMultiplayerGroup('test:race', 'instance:other');
      const beforeRuntime = jsonResponse(harness.primary.getTopologySnapshot());
      harness.fetchMock.mockImplementationOnce((input) => {
        expect(String(input)).toBe('http://primary/topology');
        readStarted.resolve();
        return heldTopology.promise;
      });
      const end = harness.tools.multiplayerTestEnd(undefined, 1, 'instance:other');
      const refused = expect(end).rejects.toMatchObject({
        code: 'multiplayer_group_in_use', groupId: 'test:race',
      });
      await readStarted.promise;
      harness.register('server', 'instance:runtime', 'runtime-peer', 'test:race');
      observer = new ProxyBridgeService('http://primary');
      await observer.waitForInitialRefresh();
      const observerTools = new RobloxStudioTools(observer);
      const discovered = await observerTools.getConnectedInstances();
      await observerTools.getMemoryBreakdown('server', undefined, 'instance:runtime-server');
      heldTopology.resolve(beforeRuntime);
      await refused;

      expect(await observerTools.getConnectedInstances()).toEqual(discovered);
      await observerTools.getMemoryBreakdown('server', undefined, 'instance:runtime-server');
      expect(harness.forwarded).toEqual(['runtime-peer', 'runtime-peer']);
      expect(harness.primary.getInstances()).toHaveLength(2);
      expect(harness.primary.getMultiplayerGroups()).toHaveLength(1);
      expect(harness.proxy.getMultiplayerGroups()).toHaveLength(1);
      expect(harness.proxy.getPeerById('instance:other/edit')?.multiplayerGroupId).toBe('test:race');
    } finally {
      heldTopology.resolve(jsonResponse(harness.primary.getTopologySnapshot()));
      observer?.stop();
      harness.close();
    }
  });
});

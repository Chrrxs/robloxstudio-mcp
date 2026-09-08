import { EventEmitter, once } from 'node:events';
import { ProxyBridgeService } from '../proxy-bridge-service.js';
import { BridgeService, RequestFailure, toPublicPeer } from '../bridge-service.js';
import type {
  MultiplayerGroup,
  StudioInstance,
  StudioPeer,
  TopologySnapshot,
} from '../bridge-service.js';

const now = 1_700_000_000_000;

function peer(
  peerId: string,
  instanceId: string,
  role: string,
  transportPeerId = peerId,
): StudioPeer {
  return {
    peerId,
    transportPeerId,
    instanceId,
    multiplayerGroupId: 'group-1',
    role,
    placeId: 42,
    placeName: 'Same Place',
    placeKey: 'same-place',
    dataModelName: role,
    isRunning: role !== 'edit',
    pluginVersion: '3.0.2',
    pluginVariant: 'main',
    serverVersion: '3.0.2',
    lastActivity: now,
    connectedAt: now,
  };
}

function topology(): TopologySnapshot {
  const server = peer('server-peer', 'instance:server', 'server');
  const client = peer('client-peer', 'instance:client', 'client-1', server.peerId);
  const instances: StudioInstance[] = [
    {
      id: server.instanceId,
      multiplayerGroupId: 'group-1',
      placeId: 42,
      placeName: 'Same Place',
      peers: [server],
    },
    {
      id: client.instanceId,
      multiplayerGroupId: 'group-1',
      placeId: 42,
      placeName: 'Same Place',
      peers: [client],
    },
  ];
  const multiplayerGroups: MultiplayerGroup[] = [{
    id: 'group-1',
    controllerInstanceId: server.instanceId,
    instanceIds: [server.instanceId, client.instanceId],
    createdAt: now,
  }];
  return { peers: [server, client], instances, multiplayerGroups };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ProxyBridgeService', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('mirrors explicit Peers, Instances, and MultiplayerGroups without collapsing same-place processes', async () => {
    const snapshot = topology();
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) === 'http://primary/topology') return jsonResponse(snapshot);
      throw new Error(`unexpected fetch ${String(input)}`);
    });

    const proxy = new ProxyBridgeService('http://primary');
    try {
      await proxy.waitForInitialRefresh();

      expect(proxy.getPeers().map((value) => value.peerId)).toEqual(['server-peer', 'client-peer']);
      expect(proxy.getInstances().map((value) => value.id)).toEqual([
        'instance:server',
        'instance:client',
      ]);
      expect(proxy.getMultiplayerGroups()).toEqual(snapshot.multiplayerGroups);
      expect(proxy.getPublicInstances()).toHaveLength(2);
      expect(proxy.getConnectedInstances()).toEqual([]);
      expect(proxy.getConnectedMultiplayerGroups()).toEqual([{
        id: 'group-1',
        controllerInstanceId: 'instance:server',
        instances: {
          'instance:server-server': 'server-peer',
          'instance:client-client-1': 'client-peer',
        },
      }]);
    } finally {
      proxy.stop();
      fetchMock.mockRestore();
    }
  });

  test('unregisterInstanceIdEverywhere prunes cascaded transport-client processes', async () => {
    const snapshot = topology();
    const removed = snapshot.peers.map(toPublicPeer);
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'http://primary/topology') return jsonResponse(snapshot);
      if (url === 'http://primary/unregister-instance-id') {
        expect(init).toMatchObject({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        expect(JSON.parse(String(init?.body))).toEqual({ instanceId: 'instance:server' });
        return jsonResponse({ success: true, removed });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const proxy = new ProxyBridgeService('http://primary');
    try {
      await proxy.waitForInitialRefresh();

      await expect(proxy.unregisterInstanceIdEverywhere('instance:server')).resolves.toEqual(removed);
      expect(proxy.getPeers()).toEqual([]);
      expect(proxy.getInstances()).toEqual([]);
      expect(proxy.getMultiplayerGroups()).toEqual([]);
    } finally {
      proxy.stop();
      fetchMock.mockRestore();
    }
  });

  test('createMultiplayerGroupEverywhere attaches the controller on the primary and cache', async () => {
    const editPeer = {
      ...peer('edit-peer', 'instance:edit', 'edit'),
      multiplayerGroupId: undefined,
      isRunning: false,
    };
    const snapshot: TopologySnapshot = {
      peers: [editPeer],
      instances: [{
        id: editPeer.instanceId,
        placeId: editPeer.placeId,
        placeName: editPeer.placeName,
        peers: [editPeer],
      }],
      multiplayerGroups: [],
    };
    const group: MultiplayerGroup = {
      id: 'group-new',
      controllerInstanceId: editPeer.instanceId,
      instanceIds: [editPeer.instanceId],
      createdAt: now,
    };
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'http://primary/topology') return jsonResponse(snapshot);
      if (url === 'http://primary/create-multiplayer-group') {
        expect(init).toMatchObject({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          groupId: group.id,
          controllerInstanceId: editPeer.instanceId,
        });
        return jsonResponse({ success: true, group });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const proxy = new ProxyBridgeService('http://primary');
    try {
      await proxy.waitForInitialRefresh();

      await expect(proxy.createMultiplayerGroupEverywhere(
        group.id,
        editPeer.instanceId,
      )).resolves.toEqual(group);
      expect(proxy.getMultiplayerGroups()).toEqual([group]);
      expect(proxy.getPeerById(editPeer.peerId)?.multiplayerGroupId).toBe(group.id);
      expect(proxy.getInstances()[0]?.multiplayerGroupId).toBe(group.id);
    } finally {
      proxy.stop();
      fetchMock.mockRestore();
    }
  });

  test('removeMultiplayerGroupEverywhere detaches the controller on the primary and cache', async () => {
    const editPeer = {
      ...peer('edit-peer', 'instance:edit', 'edit'),
      multiplayerGroupId: 'group-old',
      isRunning: false,
    };
    const group: MultiplayerGroup = {
      id: 'group-old',
      controllerInstanceId: editPeer.instanceId,
      instanceIds: [editPeer.instanceId],
      createdAt: now,
    };
    const snapshot: TopologySnapshot = {
      peers: [editPeer],
      instances: [{
        id: editPeer.instanceId,
        placeId: editPeer.placeId,
        placeName: editPeer.placeName,
        multiplayerGroupId: group.id,
        peers: [editPeer],
      }],
      multiplayerGroups: [group],
    };
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'http://primary/topology') return jsonResponse(snapshot);
      if (url === 'http://primary/remove-multiplayer-group') {
        expect(init).toMatchObject({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        expect(JSON.parse(String(init?.body))).toEqual({ groupId: group.id });
        return jsonResponse({ success: true, removed: group });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const proxy = new ProxyBridgeService('http://primary');
    try {
      await proxy.waitForInitialRefresh();

      await expect(proxy.removeMultiplayerGroupEverywhere(group.id)).resolves.toEqual(group);
      expect(proxy.getMultiplayerGroups()).toEqual([]);
      expect(proxy.getPeerById(editPeer.peerId)?.multiplayerGroupId).toBeUndefined();
      expect(proxy.getInstances()[0]?.multiplayerGroupId).toBeUndefined();
    } finally {
      proxy.stop();
      fetchMock.mockRestore();
    }
  });

  test('preserves generated recovery identity on a non-abort network failure', async () => {
    let requestId: unknown;
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) === 'http://primary/topology') return jsonResponse(topology());
      const body: unknown = JSON.parse(String(init?.body));
      if (body && typeof body === 'object' && 'operationId' in body) requestId = body.operationId;
      throw new TypeError('fetch failed: connection reset');
    });
    const proxy = new ProxyBridgeService('http://primary');
    try {
      await proxy.waitForInitialRefresh();
      const result = await proxy.sendRequest('/api/mutate', {}, 'edit-peer').catch((error: unknown) => error);
      expect(result).toMatchObject({
        code: 'proxy_connection_lost',
        details: {
          requestId, targetPeerId: 'edit-peer', stage: 'dispatched', outcome: 'unknown', executionOutcome: 'unknown',
        },
      });
      expect(requestId).toEqual(expect.any(String));
    } finally {
      proxy.stop();
      fetchMock.mockRestore();
    }
  });

  test('preserves observed completion through proxy failures and request status parsing', async () => {
    const observations = { executionStartedAt: 10, executionCompletedAt: 20, executionOutcome: 'error' };
    const details = { requestId: 'completed', targetPeerId: 'edit-peer', stage: 'response_delivery', outcome: 'unknown', ...observations };
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) === 'http://primary/topology') return jsonResponse(topology());
      if (String(input).includes('/request-status?')) return jsonResponse({ status: { ...details, queuedAt: 1, state: 'timed_out' } });
      return new Response(JSON.stringify({ error: 'Request timeout', code: 'request_timeout', details }), { status: 500 });
    });
    const proxy = new ProxyBridgeService('http://primary');
    try {
      await proxy.waitForInitialRefresh();
      await expect(proxy.sendRequest('/api/mutate', {}, 'edit-peer', 1000, undefined, 'completed'))
        .rejects.toMatchObject({ code: 'request_timeout', details });
      await expect(proxy.getRequestStatusEverywhere('completed')).resolves.toMatchObject({ ...details, state: 'timed_out' });
    } finally {
      proxy.stop();
      fetchMock.mockRestore();
    }
  });

  test('preserves primary timeout details and recovers its late result by operation ID', async () => {
    const primary = new BridgeService();
    primary.registerPeer({ peerId: 'edit-peer', transportPeerId: 'edit-peer', instanceId: 'instance:edit', role: 'edit' });
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'http://primary/topology') return jsonResponse(primary.getTopologySnapshot());
      if (url === 'http://primary/proxy') {
        const request: unknown = JSON.parse(String(init?.body));
        if (!request || typeof request !== 'object'
          || !('operationId' in request) || typeof request.operationId !== 'string'
        ) throw new Error('expected operation ID');
        try {
          const response = await primary.sendRequest('/api/mutate', {}, 'edit-peer', 1000, undefined, request.operationId);
          return jsonResponse({ response });
        } catch (error) {
          if (!(error instanceof RequestFailure)) throw error;
          return new Response(JSON.stringify({ error: error.message, code: error.code, details: error.details }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
          });
        }
      }
      if (url.startsWith('http://primary/request-status?')) {
        if (new Headers(init?.headers).get('X-MCP-Auth') !== 'test-secret') {
          return new Response('Unauthorized', { status: 401 });
        }
        return jsonResponse({ status: primary.getRequestStatus(new URL(url).searchParams.get('requestId') ?? '') ?? null });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const proxy = new ProxyBridgeService('http://primary', 'test-secret');
    try {
      await proxy.waitForInitialRefresh();
      const response = proxy.sendRequest('/api/mutate', {}, 'edit-peer', 1000, undefined, 'proxy-mutation');
      const failed = expect(response).rejects.toMatchObject({
        code: 'request_timeout',
        details: { requestId: 'proxy-mutation', targetPeerId: 'edit-peer', stage: 'dispatched', outcome: 'unknown' },
      });
      primary.claimNextRequestForTransport('edit-peer', 'socket');
      await jest.advanceTimersByTimeAsync(1000);
      await failed;
      expect(primary.settleTransportResponse('edit-peer', 'proxy-mutation', { mutationCount: 1 })).toBe('accepted');
      await expect(proxy.getRequestStatusEverywhere('proxy-mutation')).resolves.toMatchObject({
        requestId: 'proxy-mutation', outcome: 'success', response: { mutationCount: 1 },
      });
      await expect(proxy.getRequestStatusEverywhere('expired')).resolves.toBeUndefined();
    } finally {
      primary.clearAllPendingRequests();
      proxy.stop();
      fetchMock.mockRestore();
    }
  });

  test('proxy deadline reports unknown execution and the recovery ID when the primary hop disappears', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) === 'http://primary/topology') return jsonResponse({ peers: [], instances: [], multiplayerGroups: [] });
      const stalled = Promise.withResolvers<Response>();
      init?.signal?.addEventListener('abort', () => stalled.reject(new DOMException('aborted', 'AbortError')), { once: true });
      return stalled.promise;
    });
    const proxy = new ProxyBridgeService('http://primary');
    try {
      await proxy.waitForInitialRefresh();
      const response = proxy.sendRequest('/api/mutate', {}, 'edit-peer', 1000, undefined, 'lost-hop');
      const failed = expect(response).rejects.toMatchObject({
        code: 'proxy_request_timeout',
        details: { requestId: 'lost-hop', stage: 'dispatched', outcome: 'unknown' },
      });
      await jest.advanceTimersByTimeAsync(6000);
      await failed;
    } finally {
      proxy.stop();
      fetchMock.mockRestore();
    }
  });

  test('aborts the primary request when the proxy caller aborts', async () => {
    const lifecycle = new EventEmitter();
    const proxyStarted = once(lifecycle, 'proxy-started');
    const fetchAborted = once(lifecycle, 'fetch-aborted');
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'http://primary/topology') {
        return jsonResponse({ peers: [], instances: [], multiplayerGroups: [] });
      }
      if (url === 'http://primary/proxy') {
        const requestSignal = init?.signal;
        if (!requestSignal) throw new Error('expected proxy fetch signal');
        requestSignal.addEventListener('abort', () => lifecycle.emit('fetch-aborted'), { once: true });
        lifecycle.emit('proxy-started');
        await once(lifecycle, 'release');
        if (requestSignal.aborted) throw new DOMException('aborted', 'AbortError');
        return jsonResponse({ response: { results: [] } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const proxy = new ProxyBridgeService('http://primary');
    const controller = new AbortController();

    try {
      await proxy.waitForInitialRefresh();
      const response = proxy.sendRequest(
        '/api/grep-scripts',
        { pattern: 'needle' },
        'edit-peer',
        120_000,
        controller.signal,
      );
      response.catch(() => {});
      await proxyStarted;

      controller.abort();

      await fetchAborted;
      lifecycle.emit('release');
      await expect(response).rejects.toThrow('Request aborted');
    } finally {
      lifecycle.emit('release');
      proxy.stop();
      fetchMock.mockRestore();
    }
  });
});

import { EventEmitter } from 'node:events';
import { BridgeService } from '../bridge-service.js';
import {
  SseStudioTransport,
  type EventStreamSink,
  type StudioServerEvent,
  type StudioStatusEvent,
} from '../studio-transport.js';

class FakeEventStreamSink extends EventEmitter implements EventStreamSink {
  readonly chunks: string[] = [];
  ended = false;
  private readonly writeResults: boolean[] = [];

  enqueueWriteResult(result: boolean): void {
    this.writeResults.push(result);
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.writeResults.shift() ?? true;
  }

  end(): void {
    this.ended = true;
  }

  events(): StudioServerEvent[] {
    return this.chunks.map((chunk) => {
      expect(chunk.startsWith('data: ')).toBe(true);
      expect(chunk.endsWith('\n\n')).toBe(true);
      expect(chunk.slice(6, -2)).not.toContain('\n');
      return JSON.parse(chunk.slice(6, -2)) as StudioServerEvent;
    });
  }
}

const STATUS: StudioStatusEvent = {
  kind: 'status',
  knownPeer: true,
  mcpConnected: true,
  serverVersion: '3.0.2',
  pluginVersion: '3.0.2',
  pluginVariant: 'main',
};

function register(
  bridge: BridgeService,
  peerId: string,
  instanceId: string,
  role: string,
  transportPeerId = peerId,
  multiplayerGroupId?: string,
): string {
  const result = bridge.registerPeer({
    peerId,
    transportPeerId,
    instanceId,
    multiplayerGroupId,
    role,
    placeId: 1,
    placeName: 'Place',
    dataModelName: role,
    isRunning: role !== 'edit',
    pluginVersion: '3.0.2',
    pluginVariant: 'main',
    serverVersion: '3.0.2',
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.assignedRole;
}

describe('SseStudioTransport', () => {
  let bridge: BridgeService;
  let transport: SseStudioTransport;

  beforeEach(() => {
    jest.useFakeTimers();
    bridge = new BridgeService();
    transport = new SseStudioTransport(bridge);
  });

  afterEach(() => {
    transport.close();
    bridge.clearAllPendingRequests();
    jest.useRealTimers();
  });

  test('multiplexes exact server and client Peer requests over one transport stream', async () => {
    register(bridge, 'server-peer', 'instance:server', 'server', 'server-peer', 'group-1');
    expect(register(
      bridge,
      'client-peer',
      'instance:client',
      'client',
      'server-peer',
      'group-1',
    )).toBe('client-1');
    const sink = new FakeEventStreamSink();
    transport.open('server-peer', sink, () => STATUS);

    const serverResponse = bridge.sendRequest('/api/server', { scope: 'server' }, 'server-peer');
    const clientResponse = bridge.sendRequest('/api/client', { scope: 'client' }, 'client-peer');
    serverResponse.catch(() => {});
    clientResponse.catch(() => {});
    const events = sink.events();
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual(STATUS);
    expect(events[1]).toEqual({
      kind: 'request',
      requestId: expect.any(String),
      peerId: 'server-peer',
      target: 'server',
      endpoint: '/api/server',
      data: { scope: 'server' },
      remainingMs: 30_000,
    });
    expect(events[2]).toEqual({
      kind: 'request',
      requestId: expect.any(String),
      peerId: 'client-peer',
      target: 'client-1',
      endpoint: '/api/client',
      data: { scope: 'client' },
      remainingMs: 30_000,
    });

    if (events[1].kind !== 'request' || events[2].kind !== 'request') {
      throw new Error('expected request events');
    }
    bridge.resolveRequest(events[1].requestId, { ok: 'server' });
    bridge.resolveRequest(events[2].requestId, { ok: 'client' });
    await expect(serverResponse).resolves.toEqual({ ok: 'server' });
    await expect(clientResponse).resolves.toEqual({ ok: 'client' });
  });

  test('unregistering a transport Peer closes its stream', () => {
    register(bridge, 'server-peer', 'instance:server', 'server');
    const sink = new FakeEventStreamSink();
    transport.open('server-peer', sink, () => STATUS);

    bridge.unregisterPeer('server-peer');
    expect(sink.ended).toBe(true);
    expect(transport.activeStreamCount).toBe(0);
    expect(bridge.getPeerById('server-peer')).toBeUndefined();
  });

  test('replaces one transport stream and redelivers each unacknowledged request once', async () => {
    register(bridge, 'edit-peer', 'instance:edit', 'edit');
    const staleSink = new FakeEventStreamSink();
    transport.open('edit-peer', staleSink, () => STATUS);
    const response = bridge.sendRequest('/api/mutate', { value: 1 }, 'edit-peer');
    const firstRequest = staleSink.events().find((event) => event.kind === 'request');
    if (!firstRequest || firstRequest.kind !== 'request') throw new Error('expected initial request');

    const replacementSink = new FakeEventStreamSink();
    transport.open('edit-peer', replacementSink, () => STATUS);
    const replacementRequests = replacementSink.events().filter((event) => event.kind === 'request');
    expect(staleSink.ended).toBe(true);
    expect(transport.activeStreamCount).toBe(1);
    expect(replacementRequests).toEqual([firstRequest]);

    transport.refreshStatus('edit-peer');
    expect(replacementSink.events().filter((event) => event.kind === 'request')).toEqual([firstRequest]);
    bridge.resolveRequest(firstRequest.requestId, { ok: true });
    await expect(response).resolves.toEqual({ ok: true });
    transport.closeTransport('edit-peer');
    expect(bridge.getPendingRequestCount()).toBe(0);
  });

  test('keeps an unacknowledged request pending when a stream closes', async () => {
    register(bridge, 'edit-peer', 'instance:edit', 'edit');
    const sink = new FakeEventStreamSink();
    const handle = transport.open('edit-peer', sink, () => STATUS);
    const response = bridge.sendRequest('/api/slow', {}, 'edit-peer');
    const timedOut = expect(response).rejects.toThrow('Request timeout');
    const requestEvent = sink.events().find((event) => event.kind === 'request');
    if (!requestEvent || requestEvent.kind !== 'request') throw new Error('expected request event');

    handle?.close();
    expect(sink.ended).toBe(true);
    expect(bridge.getPeerById('edit-peer')).toBeDefined();
    expect(bridge.getPendingRequestCount()).toBe(1);
    const replacementSink = new FakeEventStreamSink();
    transport.open('edit-peer', replacementSink, () => STATUS);
    expect(replacementSink.events().filter((event) => event.kind === 'request')).toEqual([requestEvent]);
    transport.closeTransport('edit-peer');
    jest.advanceTimersByTime(30_000);
    await timedOut;
    expect(bridge.getPendingRequestCount()).toBe(0);
  });

  test('notifies Studio when a claimed request times out and redelivers cancellation after reconnect', async () => {
    register(bridge, 'edit-peer', 'instance:edit', 'edit');
    const sink = new FakeEventStreamSink();
    transport.open('edit-peer', sink, () => STATUS);
    const response = bridge.sendRequest('/api/slow', {}, 'edit-peer', 1000);
    const timedOut = expect(response).rejects.toThrow('Request timeout');
    const requestEvent = sink.events().find((event) => event.kind === 'request');
    if (!requestEvent || requestEvent.kind !== 'request') throw new Error('expected request event');

    jest.advanceTimersByTime(1000);

    const cancellation = {
      kind: 'cancel',
      requestId: requestEvent.requestId,
      reason: 'timeout',
    };
    expect(sink.events()).toContainEqual(cancellation);
    await timedOut;

    const replacementSink = new FakeEventStreamSink();
    transport.open('edit-peer', replacementSink, () => STATUS);
    expect(replacementSink.events().filter((event) => event.kind === 'cancel')).toEqual([cancellation]);
  });

  test('does not claim additional requests while the response is backpressured', () => {
    register(bridge, 'edit-peer', 'instance:edit', 'edit');
    const sink = new FakeEventStreamSink();
    sink.enqueueWriteResult(true);
    sink.enqueueWriteResult(false);
    transport.open('edit-peer', sink, () => STATUS);

    const first = bridge.sendRequest('/api/first', {}, 'edit-peer');
    const second = bridge.sendRequest('/api/second', {}, 'edit-peer');
    first.catch(() => {});
    second.catch(() => {});
    expect(sink.events().filter((event) => event.kind === 'request')).toHaveLength(1);

    sink.emit('drain');
    expect(sink.events().filter((event) => event.kind === 'request').map((event) =>
      event.kind === 'request' ? event.endpoint : '')).toEqual(['/api/first', '/api/second']);
  });

  test('allows sixty-four transport streams and bounds the sixty-fifth', () => {
    for (let index = 0; index < 64; index += 1) {
      const peerId = `peer-${index}`;
      register(bridge, peerId, `instance:${index}`, 'edit');
      const sink = new FakeEventStreamSink();
      expect(transport.open(peerId, sink, () => STATUS)).toBeDefined();
    }
    register(bridge, 'peer-overflow', 'instance:overflow', 'edit');
    expect(transport.activeStreamCount).toBe(64);
    expect(transport.canOpen('peer-overflow')).toBe(false);
    expect(transport.open('peer-overflow', new FakeEventStreamSink(), () => STATUS)).toBeUndefined();
  });

  test('emits exact status transitions and ten-second heartbeats', () => {
    register(bridge, 'edit-peer', 'instance:edit', 'edit');
    let status = STATUS;
    const sink = new FakeEventStreamSink();
    transport.open('edit-peer', sink, () => status);
    expect(sink.events()).toEqual([STATUS]);

    const heartbeatTimestamp = Date.now() + 10_000;
    jest.advanceTimersByTime(10_000);
    expect(sink.events()[1]).toEqual({
      kind: 'heartbeat',
      timestamp: heartbeatTimestamp,
    });

    status = { ...STATUS, mcpConnected: false };
    transport.refreshStatus();
    expect(sink.events()[2]).toEqual({ ...STATUS, mcpConnected: false });
  });
});

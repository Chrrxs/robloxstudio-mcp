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
  knownInstance: true,
  mcpConnected: true,
  serverVersion: '3.0.2',
  pluginVersion: '3.0.2',
  pluginVariant: 'main',
};

function register(
  bridge: BridgeService,
  pluginSessionId: string,
  instanceId: string,
  role: string,
  physicalSessionId = pluginSessionId,
): string {
  const result = bridge.registerInstance({
    pluginSessionId,
    physicalSessionId,
    instanceId,
    role,
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

  test('multiplexes play-server and logical client requests over one physical stream', async () => {
    register(bridge, 'server-session', 'place:1', 'server');
    expect(register(bridge, 'client-a', 'place:1', 'client', 'server-session')).toBe('client-1');
    expect(register(bridge, 'client-b', 'place:1', 'client', 'server-session')).toBe('client-2');
    const sink = new FakeEventStreamSink();
    transport.open('server-session', sink, () => STATUS);

    const serverResponse = bridge.sendRequest('/api/server', { scope: 'server' }, 'place:1', 'server');
    const clientResponse = bridge.sendRequest('/api/client', { scope: 'client' }, 'place:1', 'client-2');
    const events = sink.events();
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual(STATUS);
    expect(events[1]).toEqual({
      kind: 'request',
      requestId: expect.any(String),
      logicalSessionId: 'server-session',
      target: 'server',
      endpoint: '/api/server',
      data: { scope: 'server' },
    });
    expect(events[2]).toEqual({
      kind: 'request',
      requestId: expect.any(String),
      logicalSessionId: 'client-b',
      target: 'client-2',
      endpoint: '/api/client',
      data: { scope: 'client' },
    });

    if (events[1].kind !== 'request' || events[2].kind !== 'request') {
      throw new Error('expected request events');
    }
    bridge.resolveRequest(events[1].requestId, { ok: 'server' });
    bridge.resolveRequest(events[2].requestId, { ok: 'client' });
    await expect(serverResponse).resolves.toEqual({ ok: 'server' });
    await expect(clientResponse).resolves.toEqual({ ok: 'client' });
  });

  test('an active physical stream prevents takeover of its logical client registrations', () => {
    register(bridge, 'server-session', 'place:1', 'server');
    register(bridge, 'client-session', 'place:1', 'client', 'server-session');
    transport.open('server-session', new FakeEventStreamSink(), () => STATUS);
    jest.advanceTimersByTime(4_000);

    const duplicate = bridge.registerInstance({
      pluginSessionId: 'replacement-client',
      physicalSessionId: 'replacement-server',
      instanceId: 'place:1',
      role: 'client-1',
    });
    expect(duplicate.ok).toBe(false);
    expect(bridge.getInstanceBySessionId('client-session')).toBeDefined();
  });

  test('physical registration disconnect closes its stream and logical proxies', () => {
    register(bridge, 'server-session', 'place:1', 'server');
    register(bridge, 'client-session', 'place:1', 'client', 'server-session');
    const sink = new FakeEventStreamSink();
    transport.open('server-session', sink, () => STATUS);

    bridge.unregisterInstance('server-session');
    expect(sink.ended).toBe(true);
    expect(transport.activeStreamCount).toBe(0);
    expect(bridge.getInstanceBySessionId('server-session')).toBeUndefined();
    expect(bridge.getInstanceBySessionId('client-session')).toBeUndefined();
  });

  test('replaces one physical stream and redelivers each unacknowledged request once', async () => {
    register(bridge, 'edit-session', 'place:1', 'edit');
    const staleSink = new FakeEventStreamSink();
    transport.open('edit-session', staleSink, () => STATUS);
    const response = bridge.sendRequest('/api/mutate', { value: 1 }, 'place:1', 'edit');
    const firstRequest = staleSink.events().find((event) => event.kind === 'request');
    if (!firstRequest || firstRequest.kind !== 'request') throw new Error('expected initial request');

    const replacementSink = new FakeEventStreamSink();
    transport.open('edit-session', replacementSink, () => STATUS);
    const replacementRequests = replacementSink.events().filter((event) => event.kind === 'request');
    expect(staleSink.ended).toBe(true);
    expect(transport.activeStreamCount).toBe(1);
    expect(replacementRequests).toEqual([firstRequest]);

    transport.refreshStatus('edit-session');
    expect(replacementSink.events().filter((event) => event.kind === 'request')).toEqual([firstRequest]);
    bridge.resolveRequest(firstRequest.requestId, { ok: true });
    await expect(response).resolves.toEqual({ ok: true });
    transport.closePhysical('edit-session');
    expect(bridge.getPendingRequestCount()).toBe(0);
  });

  test('keeps an unacknowledged request pending when a stream closes', async () => {
    register(bridge, 'edit-session', 'place:1', 'edit');
    const sink = new FakeEventStreamSink();
    const handle = transport.open('edit-session', sink, () => STATUS);
    const response = bridge.sendRequest('/api/slow', {}, 'place:1', 'edit');
    const timedOut = expect(response).rejects.toThrow('Request timeout');
    const requestEvent = sink.events().find((event) => event.kind === 'request');
    if (!requestEvent || requestEvent.kind !== 'request') throw new Error('expected request event');

    handle?.close();
    expect(sink.ended).toBe(true);
    expect(bridge.getInstanceBySessionId('edit-session')).toBeDefined();
    expect(bridge.getPendingRequestCount()).toBe(1);
    const replacementSink = new FakeEventStreamSink();
    transport.open('edit-session', replacementSink, () => STATUS);
    expect(replacementSink.events().filter((event) => event.kind === 'request')).toEqual([requestEvent]);
    transport.closePhysical('edit-session');
    jest.advanceTimersByTime(30_000);
    await timedOut;
    expect(bridge.getPendingRequestCount()).toBe(0);
  });

  test('does not claim additional requests while the response is backpressured', () => {
    register(bridge, 'edit-session', 'place:1', 'edit');
    const sink = new FakeEventStreamSink();
    sink.enqueueWriteResult(true);
    sink.enqueueWriteResult(false);
    transport.open('edit-session', sink, () => STATUS);

    const first = bridge.sendRequest('/api/first', {}, 'place:1', 'edit');
    const second = bridge.sendRequest('/api/second', {}, 'place:1', 'edit');
    first.catch(() => {});
    second.catch(() => {});
    expect(sink.events().filter((event) => event.kind === 'request')).toHaveLength(1);

    sink.emit('drain');
    expect(sink.events().filter((event) => event.kind === 'request').map((event) =>
      event.kind === 'request' ? event.endpoint : '')).toEqual(['/api/first', '/api/second']);
  });

  test('allows more than six physical streams and bounds the sixty-fifth', () => {
    for (let index = 0; index < 64; index += 1) {
      const sessionId = `physical-${index}`;
      register(bridge, sessionId, `place:${index}`, 'edit');
      const sink = new FakeEventStreamSink();
      expect(transport.open(sessionId, sink, () => STATUS)).toBeDefined();
    }
    register(bridge, 'physical-overflow', 'place:overflow', 'edit');
    expect(transport.activeStreamCount).toBe(64);
    expect(transport.activeStreamCount).toBeGreaterThan(6);
    expect(transport.canOpen('physical-overflow')).toBe(false);
    expect(transport.open('physical-overflow', new FakeEventStreamSink(), () => STATUS)).toBeUndefined();
  });

  test('emits exact status transitions and ten-second heartbeats', () => {
    register(bridge, 'edit-session', 'place:1', 'edit');
    let status = STATUS;
    const sink = new FakeEventStreamSink();
    transport.open('edit-session', sink, () => status);
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

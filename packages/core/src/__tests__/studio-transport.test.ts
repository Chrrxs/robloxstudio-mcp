import { EventEmitter } from 'node:events';
import { BridgeService, RequestFailure } from '../bridge-service.js';
import {
  WebSocketStudioTransport,
  MAX_STUDIO_FRAME_BYTES,
  MAX_STUDIO_BUFFERED_BYTES,
  type StudioSocket,
  type StudioServerEvent,
  type StudioStatusEvent,
} from '../studio-transport.js';

class FakeStudioSocket extends EventEmitter implements StudioSocket {
  readonly chunks: string[] = [];
  readyState = 1;
  bufferedAmount = 0;
  ended = false;
  closeCode?: number;
  closeReason?: string;
  autoComplete = true;
  private completion?: (error?: Error) => void;

  send(chunk: string, callback: (error?: Error) => void): void {
    this.chunks.push(chunk);
    this.bufferedAmount += Buffer.byteLength(chunk);
    this.completion = callback;
    if (this.autoComplete) this.completeSend();
  }

  completeSend(error?: Error): void {
    const completion = this.completion;
    this.completion = undefined;
    this.bufferedAmount = 0;
    completion?.(error);
  }

  close(code?: number, reason?: string): void {
    this.ended = true;
    this.readyState = 3;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit('close');
  }

  terminate(): void {
    this.readyState = 3;
    this.emit('close');
  }

  respond(requestId: string, response?: unknown, error?: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify({ kind: 'response', requestId, response, error })), false);
  }

  progress(requestId: string, phase: 'executing' | 'response_delivery', outcome?: 'success' | 'error' | 'not_executed' | 'unknown'): void {
    this.emit('message', Buffer.from(JSON.stringify({ kind: 'progress', requestId, phase, outcome })), false);
  }

  events(): StudioServerEvent[] {
    return this.chunks.map((chunk) => JSON.parse(chunk) as StudioServerEvent);
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

describe('WebSocketStudioTransport', () => {
  let bridge: BridgeService;
  let transport: WebSocketStudioTransport;

  beforeEach(() => {
    jest.useFakeTimers();
    bridge = new BridgeService();
    transport = new WebSocketStudioTransport(bridge);
  });

  afterEach(() => {
    transport.close();
    bridge.clearAllPendingRequests();
    jest.useRealTimers();
  });

  test('distinguishes executing from completed response delivery and preserves proof through timeout', async () => {
    register(bridge, 'peer', 'instance:edit', 'edit');
    const socket = new FakeStudioSocket();
    transport.open('peer', socket, () => STATUS);
    const startedAt = Date.now();
    const pending = bridge.sendRequest('/api/mutate', {}, 'peer', 1000, undefined, 'observed');
    const failure = expect(pending).rejects.toMatchObject({
      code: 'request_timeout',
      details: {
        requestId: 'observed', stage: 'response_delivery', outcome: 'unknown',
        executionStartedAt: startedAt, executionCompletedAt: startedAt + 100, executionOutcome: 'success',
      },
    });
    socket.progress('observed', 'executing');
    expect(bridge.getRequestStatus('observed')).toMatchObject({
      stage: 'executing', state: 'pending', executionStartedAt: startedAt, executionOutcome: 'unknown',
    });
    expect(bridge.getRequestStatus('observed')).not.toHaveProperty('executionCompletedAt');
    jest.advanceTimersByTime(100);
    socket.progress('observed', 'response_delivery', 'success');
    expect(bridge.getRequestStatus('observed')).toMatchObject({
      stage: 'response_delivery', state: 'pending', outcome: 'pending',
      executionCompletedAt: startedAt + 100, executionOutcome: 'success',
    });
    expect(bridge.getRequestStatus('observed')).not.toHaveProperty('response');
    jest.advanceTimersByTime(900);
    await failure;
    socket.respond('observed', { mutationCount: 1 });
    expect(bridge.getRequestStatus('observed')).toMatchObject({
      state: 'settled', outcome: 'success', executionOutcome: 'success', response: { mutationCount: 1 },
    });
  });

  test('ignores forged, stale, repeated and regressive progress while accepting reconnect observations without replay', async () => {
    register(bridge, 'owner', 'instance:owner', 'edit');
    register(bridge, 'forger', 'instance:forger', 'edit');
    const owner = new FakeStudioSocket();
    const forger = new FakeStudioSocket();
    transport.open('owner', owner, () => STATUS);
    transport.open('forger', forger, () => STATUS);
    const pending = bridge.sendRequest('/api/mutate', {}, 'owner', 1000, undefined, 'ownership');
    void pending.catch(() => {});
    forger.progress('ownership', 'response_delivery', 'success');
    expect(bridge.getRequestStatus('ownership')).toMatchObject({ stage: 'dispatched' });
    const staleReceive = owner.listeners('message')[0];
    const replacement = new FakeStudioSocket();
    transport.open('owner', replacement, () => STATUS);
    staleReceive(Buffer.from(JSON.stringify({ kind: 'progress', requestId: 'ownership', phase: 'executing' })), false);
    expect(bridge.getRequestStatus('ownership')).toMatchObject({ stage: 'dispatched' });
    expect(replacement.events().filter((event) => event.kind === 'request')).toEqual([]);
    replacement.progress('ownership', 'response_delivery', 'error');
    const completed = bridge.getRequestStatus('ownership');
    jest.advanceTimersByTime(10);
    replacement.progress('ownership', 'response_delivery', 'success');
    replacement.progress('ownership', 'executing');
    expect(bridge.getRequestStatus('ownership')).toEqual(completed);
    expect(completed).not.toHaveProperty('executionStartedAt');
    replacement.respond('ownership', { success: false, error: 'runtime failure' });
    await expect(pending).resolves.toMatchObject({ success: false });
    expect(bridge.getRequestStatus('ownership')).toMatchObject({ outcome: 'error', executionOutcome: 'error' });
    replacement.progress('ownership', 'executing');
    expect(bridge.getRequestStatus('ownership')).toMatchObject({ stage: 'response_delivery', outcome: 'error' });
  });

  test('classifies a deadline during connection loss without inventing execution completion', async () => {
    register(bridge, 'peer', 'instance:edit', 'edit');
    const socket = new FakeStudioSocket();
    transport.open('peer', socket, () => STATUS);
    const pending = bridge.sendRequest('/api/mutate', {}, 'peer', 1000, undefined, 'connection-lost');
    const failure = expect(pending).rejects.toMatchObject({
      code: 'request_connection_lost',
      details: { stage: 'executing', outcome: 'unknown', executionOutcome: 'unknown', connectionLostAt: Date.now() },
    });
    socket.progress('connection-lost', 'executing');
    socket.close();
    jest.advanceTimersByTime(1000);
    await failure;
    expect(bridge.getRequestStatus('connection-lost')).toMatchObject({ state: 'timed_out', stage: 'executing' });
    expect(bridge.getRequestStatus('connection-lost')).not.toHaveProperty('executionCompletedAt');
    const replacement = new FakeStudioSocket();
    transport.open('peer', replacement, () => STATUS);
    replacement.progress('connection-lost', 'response_delivery', 'success');
    replacement.respond('connection-lost', { completed: true });
    expect(bridge.getRequestStatus('connection-lost')).toMatchObject({ state: 'settled', outcome: 'success' });
  });

  test('reconciles final response proof when progress was lost and keeps delivery failure separate from execution success', async () => {
    register(bridge, 'peer', 'instance:edit', 'edit');
    const socket = new FakeStudioSocket();
    transport.open('peer', socket, () => STATUS);
    const pending = bridge.sendRequest('/api/mutate', {}, 'peer', 1000, undefined, 'encoding-failure');
    const failure = expect(pending).rejects.toMatchObject({
      details: { requestId: 'encoding-failure', stage: 'response_delivery', executionOutcome: 'success' },
    });
    socket.emit('message', Buffer.from(JSON.stringify({
      kind: 'response', requestId: 'encoding-failure', executionOutcome: 'success',
      error: 'Plugin response exceeds WebSocket frame limit (stage=response_encode, bytes=67108865, maxBytes=67108864)',
    })), false);
    await failure;
    expect(bridge.getRequestStatus('encoding-failure')).toMatchObject({
      state: 'settled', outcome: 'error', stage: 'response_delivery', executionOutcome: 'success',
    });
    expect(bridge.getRequestStatus('encoding-failure')).not.toHaveProperty('executionStartedAt');
  });

  test('records a plugin admission rejection as not executed, never as a successful handler', async () => {
    register(bridge, 'peer', 'instance:edit', 'edit');
    const socket = new FakeStudioSocket();
    transport.open('peer', socket, () => STATUS);
    const pending = bridge.sendRequest('/api/mutate', {}, 'peer', 1000, undefined, 'not-executed');
    const failure = expect(pending).rejects.toMatchObject({
      details: { stage: 'response_delivery', outcome: 'not_executed', executionOutcome: 'not_executed' },
    });
    socket.progress('not-executed', 'response_delivery', 'not_executed');
    socket.emit('message', Buffer.from(JSON.stringify({
      kind: 'response', requestId: 'not-executed', executionOutcome: 'not_executed', error: 'Admission capacity exceeded',
    })), false);
    await failure;
    expect(bridge.getRequestStatus('not-executed')).toMatchObject({ outcome: 'error', executionOutcome: 'not_executed' });
    expect(bridge.getRequestStatus('not-executed')).not.toHaveProperty('executionStartedAt');
    expect(bridge.getRequestStatus('not-executed')).not.toHaveProperty('executionCompletedAt');
  });

  test('a final handler failure overrides success progress and reuses its response without replay', async () => {
    register(bridge, 'peer', 'instance:edit', 'edit');
    const socket = new FakeStudioSocket();
    transport.open('peer', socket, () => STATUS);
    const invoke = () => bridge.sendRequest('/api/set-properties', {}, 'peer', 1000, undefined, 'partial-failure');
    const pending = invoke();
    void pending.catch(() => {});
    socket.progress('partial-failure', 'response_delivery', 'success');
    const response = { summary: { total: 2, succeeded: 1, failed: 1 }, results: [{ property: 'Locked', success: false }] };
    socket.respond('partial-failure', response);
    await expect(pending).resolves.toEqual(response);
    expect(bridge.getRequestStatus('partial-failure')).toMatchObject({ outcome: 'error', executionOutcome: 'error', response });
    await expect(invoke()).resolves.toEqual(response);
    expect(socket.events().filter((event) => event.kind === 'request')).toHaveLength(1);
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
    const sink = new FakeStudioSocket();
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
    const sink = new FakeStudioSocket();
    transport.open('server-peer', sink, () => STATUS);

    bridge.unregisterPeer('server-peer');
    expect(sink.ended).toBe(true);
    expect(transport.activeSocketCount).toBe(0);
    expect(bridge.getPeerById('server-peer')).toBeUndefined();
  });

  test('replaces a transport without replaying its mutation and accepts the cached result on the new socket', async () => {
    register(bridge, 'edit-peer', 'instance:edit', 'edit');
    const staleSink = new FakeStudioSocket();
    transport.open('edit-peer', staleSink, () => STATUS);
    const response = bridge.sendRequest('/api/mutate', { value: 1 }, 'edit-peer');
    response.catch(() => {});
    const firstRequest = staleSink.events().find((event) => event.kind === 'request');
    if (!firstRequest || firstRequest.kind !== 'request') throw new Error('expected initial request');

    const replacementSink = new FakeStudioSocket();
    transport.open('edit-peer', replacementSink, () => STATUS);
    const replacementRequests = replacementSink.events().filter((event) => event.kind === 'request');
    expect(staleSink.ended).toBe(true);
    expect(transport.activeSocketCount).toBe(1);
    expect(replacementRequests).toEqual([]);

    transport.refreshStatus('edit-peer');
    expect(replacementSink.events().filter((event) => event.kind === 'request')).toEqual([]);
    replacementSink.respond(firstRequest.requestId, { ok: true });
    await expect(response).resolves.toEqual({ ok: true });
    transport.closeTransport('edit-peer');
    expect(bridge.getPendingRequestCount()).toBe(0);
  });

  test('keeps an unacknowledged request pending without replay after socket closure', async () => {
    register(bridge, 'edit-peer', 'instance:edit', 'edit');
    const sink = new FakeStudioSocket();
    const handle = transport.open('edit-peer', sink, () => STATUS);
    const response = bridge.sendRequest('/api/slow', {}, 'edit-peer');
    const timedOut = expect(response).rejects.toThrow('Request timeout');
    const requestEvent = sink.events().find((event) => event.kind === 'request');
    if (!requestEvent || requestEvent.kind !== 'request') throw new Error('expected request event');

    handle?.close();
    expect(sink.ended).toBe(true);
    expect(bridge.getPeerById('edit-peer')).toBeDefined();
    expect(bridge.getPendingRequestCount()).toBe(1);
    const replacementSink = new FakeStudioSocket();
    transport.open('edit-peer', replacementSink, () => STATUS);
    expect(replacementSink.events().filter((event) => event.kind === 'request')).toEqual([]);
    transport.closeTransport('edit-peer');
    jest.advanceTimersByTime(30_000);
    await timedOut;
    expect(bridge.getPendingRequestCount()).toBe(0);
  });

  test('notifies Studio when a claimed request times out and redelivers cancellation after reconnect', async () => {
    register(bridge, 'edit-peer', 'instance:edit', 'edit');
    const sink = new FakeStudioSocket();
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

    const replacementSink = new FakeStudioSocket();
    transport.open('edit-peer', replacementSink, () => STATUS);
    expect(replacementSink.events().filter((event) => event.kind === 'cancel')).toEqual([cancellation]);
  });

  test('limits each Studio transport stream to four outstanding requests and refills on settlement', async () => {
    register(bridge, 'edit-peer', 'instance:edit', 'edit');
    const sink = new FakeStudioSocket();
    transport.open('edit-peer', sink, () => STATUS);

    const responses = Array.from({ length: 6 }, (_, index) =>
      bridge.sendRequest(`/api/request-${index}`, {}, 'edit-peer'));
    for (const response of responses) response.catch(() => {});

    let requests = sink.events().filter((event) => event.kind === 'request');
    expect(requests).toHaveLength(4);
    const first = requests[0];
    const second = requests[1];
    if (first.kind !== 'request' || second.kind !== 'request') {
      throw new Error('expected request events');
    }

    bridge.resolveRequest(first.requestId, { ok: 0 });
    requests = sink.events().filter((event) => event.kind === 'request');
    expect(requests).toHaveLength(5);

    bridge.resolveRequest(second.requestId, { ok: 1 });
    requests = sink.events().filter((event) => event.kind === 'request');
    expect(requests).toHaveLength(6);

    for (const request of requests.slice(2)) {
      if (request.kind === 'request') bridge.resolveRequest(request.requestId, { ok: true });
    }
    await expect(Promise.all(responses)).resolves.toHaveLength(6);
  });

  test('applies the outstanding-request window independently to each transport stream', async () => {
    register(bridge, 'edit-a', 'instance:a', 'edit');
    register(bridge, 'edit-b', 'instance:b', 'edit');
    const sinkA = new FakeStudioSocket();
    const sinkB = new FakeStudioSocket();
    transport.open('edit-a', sinkA, () => STATUS);
    transport.open('edit-b', sinkB, () => STATUS);

    const responses = [
      ...Array.from({ length: 5 }, (_, index) =>
        bridge.sendRequest(`/api/a-${index}`, {}, 'edit-a')),
      ...Array.from({ length: 5 }, (_, index) =>
        bridge.sendRequest(`/api/b-${index}`, {}, 'edit-b')),
    ];
    for (const response of responses) response.catch(() => {});

    expect(sinkA.events().filter((event) => event.kind === 'request')).toHaveLength(4);
    expect(sinkB.events().filter((event) => event.kind === 'request')).toHaveLength(4);
    for (const event of [...sinkA.events(), ...sinkB.events()]) {
      if (event.kind === 'request') bridge.resolveRequest(event.requestId, { ok: true });
    }

    const requestsA = sinkA.events().filter((event) => event.kind === 'request');
    const requestsB = sinkB.events().filter((event) => event.kind === 'request');
    expect(requestsA).toHaveLength(5);
    expect(requestsB).toHaveLength(5);
    const finalA = requestsA[4];
    const finalB = requestsB[4];
    if (finalA.kind !== 'request' || finalB.kind !== 'request') {
      throw new Error('expected final request events');
    }
    bridge.resolveRequest(finalA.requestId, { ok: true });
    bridge.resolveRequest(finalB.requestId, { ok: true });
    await expect(Promise.all(responses)).resolves.toHaveLength(10);
  });

  test('releases a delivery credit after timeout before sending queued work', async () => {
    register(bridge, 'edit-peer', 'instance:edit', 'edit');
    const sink = new FakeStudioSocket();
    transport.open('edit-peer', sink, () => STATUS);

    const first = bridge.sendRequest('/api/request-0', {}, 'edit-peer', 1000);
    const timedOut = expect(first).rejects.toThrow('Request timeout');
    const remaining = Array.from({ length: 4 }, (_, index) =>
      bridge.sendRequest(`/api/request-${index + 1}`, {}, 'edit-peer'));
    for (const response of remaining) response.catch(() => {});
    expect(sink.events().filter((event) => event.kind === 'request')).toHaveLength(4);

    jest.advanceTimersByTime(1000);
    await timedOut;

    const events = sink.events();
    const cancellationIndex = events.findIndex(
      (event) => event.kind === 'cancel' && event.reason === 'timeout',
    );
    const queuedRequestIndex = events.findIndex(
      (event) => event.kind === 'request' && event.endpoint === '/api/request-4',
    );
    expect(cancellationIndex).toBeGreaterThan(-1);
    expect(queuedRequestIndex).toBeGreaterThan(cancellationIndex);

    for (const event of events) {
      if (event.kind === 'request' && event.endpoint !== '/api/request-0') {
        bridge.resolveRequest(event.requestId, { ok: true });
      }
    }
    await expect(Promise.all(remaining)).resolves.toHaveLength(4);
  });

  test('does not claim additional requests until the socket send completes', () => {
    register(bridge, 'edit-peer', 'instance:edit', 'edit');
    const sink = new FakeStudioSocket();
    transport.open('edit-peer', sink, () => STATUS);
    sink.autoComplete = false;

    const first = bridge.sendRequest('/api/first', {}, 'edit-peer');
    const second = bridge.sendRequest('/api/second', {}, 'edit-peer');
    first.catch(() => {});
    second.catch(() => {});
    expect(sink.events().filter((event) => event.kind === 'request')).toHaveLength(1);

    sink.completeSend();
    expect(sink.events().filter((event) => event.kind === 'request').map((event) =>
      event.kind === 'request' ? event.endpoint : '')).toEqual(['/api/first', '/api/second']);
  });

  test('allows sixty-four transport streams and bounds the sixty-fifth', () => {
    for (let index = 0; index < 64; index += 1) {
      const peerId = `peer-${index}`;
      register(bridge, peerId, `instance:${index}`, 'edit');
      const sink = new FakeStudioSocket();
      expect(transport.open(peerId, sink, () => STATUS)).toBeDefined();
    }
    register(bridge, 'peer-overflow', 'instance:overflow', 'edit');
    expect(transport.activeSocketCount).toBe(64);
    expect(transport.canOpen('peer-overflow')).toBe(false);
    expect(transport.open('peer-overflow', new FakeStudioSocket(), () => STATUS)).toBeUndefined();
  });

  test('emits exact status transitions and ten-second heartbeats', () => {
    register(bridge, 'edit-peer', 'instance:edit', 'edit');
    let status = STATUS;
    const sink = new FakeStudioSocket();
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

  test('records a result before its ack and safely acknowledges duplicate responses', async () => {
    register(bridge, 'peer', 'instance:edit', 'edit');
    const socket = new FakeStudioSocket();
    transport.open('peer', socket, () => STATUS);
    const result = bridge.sendRequest('/api/mutate', {}, 'peer');
    const request = socket.events().find((event) => event.kind === 'request');
    if (!request || request.kind !== 'request') throw new Error('expected request');
    socket.respond(request.requestId, { value: 'first' });
    expect(socket.events()).toContainEqual({ kind: 'ack', requestId: request.requestId, disposition: 'accepted' });
    socket.respond(request.requestId, { value: 'duplicate' });
    expect(socket.events()).toContainEqual({ kind: 'ack', requestId: request.requestId, disposition: 'already_settled' });
    await expect(result).resolves.toEqual({ value: 'first' });
  });

  test('rejects another authenticated transport forging a result without consuming its owner request', async () => {
    register(bridge, 'owner', 'instance:owner', 'edit');
    register(bridge, 'forger', 'instance:forger', 'edit');
    const owner = new FakeStudioSocket();
    const forger = new FakeStudioSocket();
    transport.open('owner', owner, () => STATUS);
    transport.open('forger', forger, () => STATUS);
    const result = bridge.sendRequest('/api/mutate', {}, 'owner');
    const request = owner.events().find((event) => event.kind === 'request');
    if (!request || request.kind !== 'request') throw new Error('expected request');
    forger.respond(request.requestId, { forged: true });
    expect(forger.events()).toContainEqual({ kind: 'ack', requestId: request.requestId, disposition: 'unknown' });
    expect(bridge.getPendingRequestCount()).toBe(1);
    owner.respond(request.requestId, { genuine: true });
    await expect(result).resolves.toEqual({ genuine: true });
    forger.respond(request.requestId, { forged: true });
    expect(forger.events().at(-1)).toEqual({ kind: 'ack', requestId: request.requestId, disposition: 'unknown' });
  });

  test('stale socket callbacks cannot settle or consume commands after replacement', async () => {
    register(bridge, 'peer', 'instance:edit', 'edit');
    const stale = new FakeStudioSocket();
    transport.open('peer', stale, () => STATUS);
    stale.autoComplete = false;
    const result = bridge.sendRequest('/api/mutate', {}, 'peer');
    const request = stale.events().find((event) => event.kind === 'request');
    if (!request || request.kind !== 'request') throw new Error('expected request');
    const staleReceive = stale.listeners('message')[0];
    const current = new FakeStudioSocket();
    transport.open('peer', current, () => STATUS);
    staleReceive(Buffer.from(JSON.stringify({ kind: 'response', requestId: request.requestId, response: 'forged' })), false);
    stale.completeSend();
    expect(bridge.getPendingRequestCount()).toBe(1);
    current.respond(request.requestId, 'genuine');
    await expect(result).resolves.toBe('genuine');
    const nextResult = bridge.sendRequest('/api/next', {}, 'peer');
    const nextRequest = current.events().find((event) => event.kind === 'request' && event.endpoint === '/api/next');
    if (!nextRequest || nextRequest.kind !== 'request') throw new Error('expected next request');
    expect(stale.events().filter((event) => event.kind === 'request')).toHaveLength(1);
    current.respond(nextRequest.requestId, 'next');
    await expect(nextResult).resolves.toBe('next');
  });

  test('accepts a transport-scoped late result after the waiter timed out', async () => {
    register(bridge, 'peer', 'instance:edit', 'edit');
    const socket = new FakeStudioSocket();
    transport.open('peer', socket, () => STATUS);
    const result = bridge.sendRequest('/api/slow', {}, 'peer', 1000);
    const timedOut = expect(result).rejects.toThrow('Request timeout');
    const request = socket.events().find((event) => event.kind === 'request');
    if (!request || request.kind !== 'request') throw new Error('expected request');
    jest.advanceTimersByTime(1000);
    await timedOut;
    socket.respond(request.requestId, { late: true });
    expect(socket.events().at(-1)).toEqual({ kind: 'ack', requestId: request.requestId, disposition: 'accepted' });
    expect(bridge.getRequestStatus(request.requestId)).toMatchObject({ response: { late: true } });
  });

  test('treats an empty error as a recorded rejection', async () => {
    register(bridge, 'peer', 'instance:edit', 'edit');
    const socket = new FakeStudioSocket();
    transport.open('peer', socket, () => STATUS);
    const result = bridge.sendRequest('/api/error', {}, 'peer');
    const rejected = expect(result).rejects.toBe('');
    const request = socket.events().find((event) => event.kind === 'request');
    if (!request || request.kind !== 'request') throw new Error('expected request');
    socket.respond(request.requestId, undefined, '');
    expect(socket.events().at(-1)).toEqual({ kind: 'ack', requestId: request.requestId, disposition: 'accepted' });
    await rejected;
  });

  test.each<[string, string, boolean, number]>([
    ['invalid JSON', '{', false, 1007],
    ['binary', '{}', true, 1003],
    ['wrong message kind', '{"kind":"request","requestId":"x"}', false, 1008],
    ['missing request ID', '{"kind":"response"}', false, 1008],
  ])('closes %s without recording or acknowledging it', (_name, data, binary, code) => {
    register(bridge, 'peer', 'instance:edit', 'edit');
    const socket = new FakeStudioSocket();
    transport.open('peer', socket, () => STATUS);
    socket.emit('message', Buffer.from(data), binary);
    expect(socket.closeCode).toBe(code);
    expect(socket.events()).toEqual([STATUS]);
    expect(transport.activeSocketCount).toBe(0);
  });

  test('rejects an oversized frame before parsing and reports its measured size', () => {
    register(bridge, 'peer', 'instance:edit', 'edit');
    const socket = new FakeStudioSocket();
    transport.open('peer', socket, () => STATUS);
    socket.emit('message', Buffer.alloc(MAX_STUDIO_FRAME_BYTES + 1), false);
    expect(socket.closeCode).toBe(1009);
    expect(socket.closeReason).toContain(`bytes=${MAX_STUDIO_FRAME_BYTES + 1}`);
    expect(socket.events()).toEqual([STATUS]);
  });

  test('bounds buffered bytes rather than enqueueing another command', () => {
    register(bridge, 'peer', 'instance:edit', 'edit');
    const socket = new FakeStudioSocket();
    transport.open('peer', socket, () => STATUS);
    socket.bufferedAmount = MAX_STUDIO_BUFFERED_BYTES;
    void bridge.sendRequest('/api/blocked', {}, 'peer').catch(() => {});
    expect(socket.closeCode).toBe(1013);
    expect(socket.events()).toEqual([STATUS]);
  });

  test('bounds acknowledgements while the socket cannot finish a send', () => {
    register(bridge, 'peer', 'instance:edit', 'edit');
    const socket = new FakeStudioSocket();
    socket.autoComplete = false;
    transport.open('peer', socket, () => STATUS);
    for (let index = 0; index < 129; index += 1) socket.respond(`unknown-${index}`, null);
    expect(socket.closeCode).toBe(1013);
    expect(socket.events()).toEqual([STATUS]);
  });

  test('does not acknowledge a response whose bridge recording failed', () => {
    register(bridge, 'peer', 'instance:edit', 'edit');
    const socket = new FakeStudioSocket();
    transport.open('peer', socket, () => STATUS);
    jest.spyOn(bridge, 'settleTransportResponse').mockImplementation(() => { throw new Error('recording failed'); });
    socket.respond('unknown', null);
    expect(socket.closeCode).toBe(1011);
    expect(socket.events()).toEqual([STATUS]);
  });

  test('settles an oversized queued command with measured bytes before socket delivery', async () => {
    register(bridge, 'peer', 'instance:edit', 'edit');
    const data = { payload: '' };
    const result = bridge.sendRequest('/api/mutate', data, 'peer', 30_000, undefined, 'oversized');
    const expectedBytes = MAX_STUDIO_FRAME_BYTES + Buffer.byteLength(JSON.stringify({
      kind: 'request', requestId: 'oversized', peerId: 'peer', target: 'edit',
      endpoint: '/api/mutate', data, remainingMs: 30_000,
    }));
    const rejected = expect(result).rejects.toMatchObject({
      code: 'studio_frame_too_large',
      details: {
        requestId: 'oversized', targetPeerId: 'peer', stage: 'dispatched',
        outcome: 'not_executed', transportStage: 'server_send',
        bytes: expectedBytes, limitBytes: MAX_STUDIO_FRAME_BYTES,
      },
    });
    data.payload = 'x'.repeat(MAX_STUDIO_FRAME_BYTES);
    const socket = new FakeStudioSocket();
    transport.open('peer', socket, () => STATUS);
    await rejected;
    await expect(result).rejects.toBeInstanceOf(RequestFailure);
    expect(socket.events()).toEqual([STATUS]);
    expect(socket.ended).toBe(false);
    expect(bridge.getPendingRequestCount()).toBe(0);
  });

  test('settles a queued command whose data becomes unserializable before socket delivery', async () => {
    register(bridge, 'peer', 'instance:edit', 'edit');
    const data: { circular?: unknown } = {};
    const result = bridge.sendRequest('/api/mutate', data, 'peer');
    const rejected = expect(result).rejects.toMatchObject({
      code: 'studio_frame_serialization_failed',
      details: {
        targetPeerId: 'peer', stage: 'dispatched', outcome: 'not_executed', transportStage: 'server_send',
      },
    });
    data.circular = data;
    const socket = new FakeStudioSocket();
    transport.open('peer', socket, () => STATUS);
    await rejected;
    await expect(result).rejects.toBeInstanceOf(RequestFailure);
    expect(socket.events()).toEqual([STATUS]);
    expect(bridge.getPendingRequestCount()).toBe(0);
  });

  test('cleanup prevents future delivery and removes socket listeners and timers', () => {
    register(bridge, 'peer', 'instance:edit', 'edit');
    const socket = new FakeStudioSocket();
    transport.open('peer', socket, () => STATUS);
    transport.close();
    expect(socket.closeCode).toBe(1001);
    expect(socket.listenerCount('message')).toBe(0);
    expect(socket.listenerCount('close')).toBe(0);
    expect(socket.listenerCount('error')).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    expect(transport.open('peer', new FakeStudioSocket(), () => STATUS)).toBeUndefined();
  });
});

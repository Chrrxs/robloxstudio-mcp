import request from 'supertest';
import { createHttpServer, listenWithRetry, type RobloxStudioHttpApp } from '../http-server.js';
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import { once } from 'node:events';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { StudioServerEvent } from '../studio-transport.js';
import { getAllTools, getReadOnlyTools } from '../tools/definitions.js';

class HttpTestBridgeService extends BridgeService {
  protected override notifyPeerRegistered(): void {
    // Transport security tests do not associate Peers with managed Studio processes.
  }
}

describe('HTTP security', () => {
  let bridge: BridgeService;
  let tools: RobloxStudioTools;

  beforeEach(() => {
    bridge = new HttpTestBridgeService();
    tools = new RobloxStudioTools(bridge);
  });

  afterEach(() => {
    bridge.clearAllPendingRequests();
  });

  describe('proxy tool permissions', () => {
    const token = 'proxy-test-token';

    it.each([
      { label: 'unrestricted', allowed: undefined, endpoint: '/api/execute-luau', status: 200 },
      { label: 'main', allowed: new Set(getAllTools().map(tool => tool.name)),
        endpoint: '/api/execute-luau', status: 200 },
      { label: 'empty', allowed: new Set<string>(), endpoint: '/api/place-info', status: 403 },
      { label: 'narrow', allowed: new Set(['get_script_source']), endpoint: '/api/place-info', status: 403 },
      { label: 'narrow read', allowed: new Set(['get_script_source']),
        endpoint: '/api/get-script-source', status: 200 },
      { label: 'simulation read', allowed: new Set(['get_simulation_state', 'get_device_simulator_state']),
        endpoint: '/api/execute-luau', status: 403 },
    ])('enforces $label configuration', async ({ allowed, endpoint, status }) => {
      const app = createHttpServer(tools, bridge, allowed, undefined, { authToken: token });
      const dispatch = jest.spyOn(bridge, 'sendRequest').mockResolvedValue({ success: true });
      try {
        await request(app).post('/proxy').set('X-MCP-Auth', token)
          .send({ endpoint, targetPeerId: 'studio-peer' }).expect(status);
        expect(dispatch).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
      } finally {
        dispatch.mockRestore();
        await app.cleanup();
      }
    });

    it.each([
      '/api/execute-luau',
      '/api/eval-runtime',
      '/api/set-properties',
      '/api/set-script-source',
      '/api/import-rbxm',
      '/api/unknown-operation',
    ])('rejects Inspector endpoint %s before dispatch', async (endpoint) => {
      const app = createHttpServer(tools, bridge, new Set(getReadOnlyTools().map(tool => tool.name)),
        undefined, { authToken: token });
      const dispatch = jest.spyOn(bridge, 'sendRequest').mockResolvedValue({ success: true });
      try {
        const response = await request(app).post('/proxy').set('X-MCP-Auth', token)
          .send({ endpoint, data: { code: 'return true' }, targetPeerId: 'studio-peer' });
        expect(response.status).toBe(403);
        expect(response.body.error).toBe('forbidden_endpoint');
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        dispatch.mockRestore();
        await app.cleanup();
      }
    });

    it.each(['/api/place-info', '/api/instance-properties', '/api/get-script-source',
      '/api/get-selection', '/api/set-selection', '/api/focus-viewport',
      '/api/capture-begin', '/api/capture-read', '/api/get-runtime-logs'])(
      'forwards permitted Inspector endpoint %s', async (endpoint) => {
        const app = createHttpServer(tools, bridge, new Set(getReadOnlyTools().map(tool => tool.name)),
          undefined, { authToken: token });
        const result = { value: 'read-result' };
        const dispatch = jest.spyOn(bridge, 'sendRequest').mockResolvedValue(result);
        try {
          const response = await request(app).post('/proxy').set('Authorization', `Bearer ${token}`)
            .send({ endpoint, data: { instancePath: 'game.Workspace' }, targetPeerId: 'studio-peer',
              timeoutMs: 1000, operationId: 'read-operation' });
          expect(response.status).toBe(200);
          expect(response.body).toEqual({ response: result });
          expect(dispatch).toHaveBeenCalledWith(endpoint, { instancePath: 'game.Workspace' },
            'studio-peer', 1000, expect.any(AbortSignal), 'read-operation');
        } finally {
          dispatch.mockRestore();
          await app.cleanup();
        }
      });

    it('forwards Studio captures when capture_screenshot is enabled', async () => {
      const app = createHttpServer(tools, bridge, new Set(['capture_screenshot']),
        undefined, { authToken: token });
      const capture = {
        success: true, encoding: 'png', source: 'StudioCaptureService',
        width: 1, height: 1, nativeWidth: 1, nativeHeight: 1,
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=',
      };
      const dispatch = jest.spyOn(bridge, 'sendRequest').mockResolvedValue(capture);
      try {
        const response = await request(app).post('/proxy').set('Authorization', `Bearer ${token}`)
          .send({ endpoint: '/api/capture-studio', data: { encoding: 'png' },
            targetPeerId: 'studio-peer', timeoutMs: 1000, operationId: 'capture-operation' });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ response: capture });
        expect(dispatch).toHaveBeenCalledWith('/api/capture-studio', { encoding: 'png' },
          'studio-peer', 1000, expect.any(AbortSignal), 'capture-operation');
      } finally {
        dispatch.mockRestore();
        await app.cleanup();
      }
    });

    it('rejects Studio captures when capture_screenshot is disabled', async () => {
      const allowed = new Set(getReadOnlyTools().map(tool => tool.name));
      allowed.delete('capture_screenshot');
      const app = createHttpServer(tools, bridge, allowed, undefined, { authToken: token });
      const dispatch = jest.spyOn(bridge, 'sendRequest').mockResolvedValue({ success: true });
      try {
        const response = await request(app).post('/proxy').set('Authorization', `Bearer ${token}`)
          .send({ endpoint: '/api/capture-studio', data: { encoding: 'png' },
            targetPeerId: 'studio-peer' });
        expect(response.status).toBe(403);
        expect(response.body.error).toBe('forbidden_endpoint');
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        dispatch.mockRestore();
        await app.cleanup();
      }
    });
  });

  describe('origin policy', () => {
    it('rejects browser requests with a non-allowlisted Origin', async () => {
      const app = createHttpServer(tools, bridge);
      const res = await request(app).get('/health').set('Origin', 'https://evil.example');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden_origin');
    });

    it('allows requests without an Origin header (native clients / Studio plugin)', async () => {
      const app = createHttpServer(tools, bridge);
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
    });

    it('allows and echoes an allowlisted Origin', async () => {
      const app = createHttpServer(tools, bridge, undefined, undefined, {
        allowedOrigins: ['http://localhost:5173'],
      });
      const res = await request(app).get('/health').set('Origin', 'http://localhost:5173');
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    });

    it('answers preflight for allowlisted origins only', async () => {
      const app = createHttpServer(tools, bridge, undefined, undefined, {
        allowedOrigins: ['http://localhost:5173'],
      });
      const ok = await request(app).options('/mcp/selection').set('Origin', 'http://localhost:5173');
      expect(ok.status).toBe(204);
      const bad = await request(app).options('/mcp/selection').set('Origin', 'https://evil.example');
      expect(bad.status).toBe(403);
    });
  });

  describe('auth token', () => {
    const TOKEN = 'test-token-123';

    function authedApp() {
      return createHttpServer(tools, bridge, undefined, undefined, { authToken: TOKEN });
    }

    it('rejects tool endpoints without a token', async () => {
      const app = authedApp();
      for (const path of [
        '/proxy',
        '/unregister-instance-id',
        '/create-multiplayer-group',
        '/remove-multiplayer-group',
      ]) {
        const res = await request(app).post(path).send({});
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('unauthorized');
      }
      const topology = await request(app).get('/topology');
      expect(topology.status).toBe(401);
      const tool = await request(app).post('/mcp/selection').send({});
      expect(tool.status).toBe(401);
    });

    it('rejects a wrong token', async () => {
      const app = authedApp();
      const res = await request(app).get('/topology').set('X-MCP-Auth', 'wrong');
      expect(res.status).toBe(401);
    });

    it('accepts X-MCP-Auth and Authorization: Bearer', async () => {
      const app = authedApp();
      const viaHeader = await request(app).get('/topology').set('X-MCP-Auth', TOKEN);
      expect(viaHeader.status).toBe(200);
      const viaBearer = await request(app).get('/topology').set('Authorization', `Bearer ${TOKEN}`);
      expect(viaBearer.status).toBe(200);
      const recovery = await request(app).get('/request-status?requestId=unknown');
      expect(recovery.status).toBe(401);
      await request(app).get('/request-status?requestId=unknown').set('X-MCP-Auth', TOKEN)
        .expect(200, { status: null });
    });

    it('protects retained results through case-insensitive and trailing-slash route aliases', async () => {
      const app = authedApp();
      bridge.registerPeer({
        peerId: 'recovery-peer', transportPeerId: 'recovery-peer',
        instanceId: 'instance:recovery', role: 'edit',
      });
      const result = bridge.sendRequest('/api/private-result', {}, 'recovery-peer');
      const pending = bridge.claimNextRequestForTransport('recovery-peer', 'recovery-owner');
      if (!pending) throw new Error('expected dispatched request');
      bridge.settleTransportResponse('recovery-peer', pending.requestId, { privateValue: 'retained-result' });
      await result;

      try {
        for (const path of ['/request-status', '/REQUEST-STATUS', '/request-status/', '/REQUEST-STATUS/']) {
          await request(app).get(path).query({ requestId: pending.requestId }).expect(401);
          const authenticated = await request(app).get(path).query({ requestId: pending.requestId })
            .set('X-MCP-Auth', TOKEN).expect(200);
          expect(authenticated.body.status).toMatchObject({
            requestId: pending.requestId, state: 'settled', response: { privateValue: 'retained-result' },
          });
        }
      } finally {
        await app.cleanup();
      }
    });

    it('leaves plugin-facing endpoints tokenless', async () => {
      const app = authedApp();
      const health = await request(app).get('/health');
      expect(health.status).toBe(200);
      const status = await request(app).get('/status');
      expect(status.status).toBe(200);
      const events = await request(app).get('/events?peerId=unknown-peer');
      expect(events.status).toBe(426);
      const disconnect = await request(app).post('/disconnect').send({});
      expect(disconnect.status).toBe(200);
    });

    it('does not require a token when auth is disabled', async () => {
      const app = createHttpServer(tools, bridge);
      const res = await request(app).get('/topology');
      expect(res.status).toBe(200);
    });
  });
});

const STUDIO_READY = {
  peerId: 'studio-peer',
  transportPeerId: 'studio-peer',
  instanceId: 'instance:studio',
  role: 'edit',
  placeId: 1,
  placeName: 'Place',
  dataModelName: 'Place',
  isRunning: false,
  pluginVersion: 'test-version',
  pluginVariant: 'main',
  timestamp: 1_700_000_000_000,
};

class SocketInbox {
  private readonly frames: StudioServerEvent[] = [];
  private readonly waiting: Array<(event: StudioServerEvent) => void> = [];

  constructor(socket: WebSocket) {
    socket.on('message', (data: RawData, isBinary: boolean) => {
      expect(isBinary).toBe(false);
      const frame = JSON.parse(data.toString()) as StudioServerEvent;
      const waiter = this.waiting.shift();
      if (waiter) waiter(frame);
      else this.frames.push(frame);
    });
  }

  next(): Promise<StudioServerEvent> {
    const frame = this.frames.shift();
    if (frame) return Promise.resolve(frame);
    const { promise, resolve } = Promise.withResolvers<StudioServerEvent>();
    this.waiting.push(resolve);
    return promise;
  }
}

describe('Studio WebSocket authentication and upgrade', () => {
  let bridge: BridgeService;
  let app: RobloxStudioHttpApp;
  let server: Server;
  let baseUrl: string;
  const sockets = new Set<WebSocket>();

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    bridge = new HttpTestBridgeService();
    app = createHttpServer(new RobloxStudioTools(bridge), bridge, new Set(), {
      name: 'test-server', version: STUDIO_READY.pluginVersion, tools: [],
    }, { authToken: 'local-tool-secret', allowedOrigins: ['https://allowed.example'] });
    ({ server } = await listenWithRetry(app, '127.0.0.1', 0, 1));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    baseUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }
    sockets.clear();
    bridge.clearAllPendingRequests();
    await app.cleanup();
    const closed = once(server, 'close');
    server.close();
    await closed;
    jest.useRealTimers();
  });

  async function ready(peerId = STUDIO_READY.peerId): Promise<string> {
    const response = await request(server).post('/ready').send({
      ...STUDIO_READY, peerId, transportPeerId: peerId, instanceId: `instance:${peerId}`,
    }).expect(200);
    const token: unknown = response.body.transportToken;
    if (typeof token !== 'string') throw new Error('expected transport token');
    return token;
  }

  function connect(peerId: string, token?: string, options?: { origin?: string; version?: string }) {
    const query = new URLSearchParams({ peerId, protocolVersion: options?.version ?? '1' });
    const socket = new WebSocket(`${baseUrl}/studio?${query}`, {
      headers: {
        ...(token === undefined ? {} : { 'X-Studio-Token': token }),
        ...(options?.origin === undefined ? {} : { Origin: options.origin }),
      },
    });
    socket.on('error', () => {});
    sockets.add(socket);
    const inbox = new SocketInbox(socket);
    return { socket, inbox };
  }

  async function rejected(peerId: string, token?: string, options?: { origin?: string; version?: string }): Promise<number> {
    const { socket } = connect(peerId, token, options);
    const response = Promise.withResolvers<number>();
    socket.once('unexpected-response', (_req, res) => {
      res.resume();
      response.resolve(res.statusCode ?? 0);
      socket.terminate();
    });
    socket.once('open', () => response.reject(new Error('Unexpected authenticated upgrade')));
    return response.promise;
  }

  test('requires a peer-bound token and rejects browser origins before upgrading', async () => {
    const ownerToken = await ready();
    const otherToken = await ready('other-peer');
    expect(await rejected(STUDIO_READY.peerId)).toBe(401);
    expect(await rejected(STUDIO_READY.peerId, 'incorrect')).toBe(401);
    expect(await rejected(STUDIO_READY.peerId, otherToken)).toBe(401);
    expect(await rejected(STUDIO_READY.peerId, ownerToken, { origin: 'https://evil.example' })).toBe(403);
    expect(await rejected('unknown-peer', ownerToken)).toBe(404);
    expect(await rejected(STUDIO_READY.peerId, ownerToken, { version: '2' })).toBe(426);
    const { socket, inbox } = connect(STUDIO_READY.peerId, ownerToken, { origin: 'https://allowed.example' });
    await once(socket, 'open');
    expect(await inbox.next()).toMatchObject({ kind: 'status', knownPeer: true });
  });

  test('does not give a proxied client its own transport or token', async () => {
    const owner = await request(server).post('/ready').send({
      ...STUDIO_READY, role: 'server', isRunning: true,
    }).expect(200);
    const client = await request(server).post('/ready').send({
      ...STUDIO_READY, peerId: 'client-peer', role: 'client', isRunning: true,
    }).expect(200);
    expect(client.body.transportToken).toBeUndefined();
    expect(await rejected('client-peer', owner.body.transportToken)).toBe(403);
  });

  test('preserves refresh tokens, revokes on unregister, and issues a fresh secret on re-registration', async () => {
    const first = await ready();
    expect(await ready()).toBe(first);
    await request(server).post('/disconnect').send({ peerId: STUDIO_READY.peerId }).expect(200);
    expect(await rejected(STUDIO_READY.peerId, first)).toBe(404);
    const replacement = await ready();
    expect(replacement).not.toBe(first);
    expect(await rejected(STUDIO_READY.peerId, first)).toBe(401);
    const { socket, inbox } = connect(STUDIO_READY.peerId, replacement);
    await once(socket, 'open');
    expect(await inbox.next()).toMatchObject({ kind: 'status', knownPeer: true });
    const closed = once(socket, 'close');
    await request(server).post('/disconnect').send({ peerId: STUDIO_READY.peerId }).expect(200);
    expect((await closed)[0]).toBe(1000);
  });

  test('records results and sends healthy duplicate-safe acknowledgements without HTTP responses', async () => {
    const token = await ready();
    const { socket, inbox } = connect(STUDIO_READY.peerId, token);
    await once(socket, 'open');
    await inbox.next();
    const result = bridge.sendRequest('/api/mutate', { value: 1 }, STUDIO_READY.peerId);
    const command = await inbox.next();
    if (command.kind !== 'request') throw new Error('expected request');
    expect(command).toMatchObject({ peerId: STUDIO_READY.peerId, endpoint: '/api/mutate', data: { value: 1 } });
    socket.send(JSON.stringify({ kind: 'response', requestId: command.requestId, response: { value: 2 } }));
    expect(await inbox.next()).toEqual({ kind: 'ack', requestId: command.requestId, disposition: 'accepted' });
    await expect(result).resolves.toEqual({ value: 2 });
    const recovery = await request(server).get(`/request-status?requestId=${command.requestId}`)
      .set('X-MCP-Auth', 'local-tool-secret').expect(200);
    expect(recovery.body.status).toMatchObject({ state: 'settled', response: { value: 2 } });
    socket.send(JSON.stringify({ kind: 'response', requestId: command.requestId, response: { value: 3 } }));
    expect(await inbox.next()).toEqual({ kind: 'ack', requestId: command.requestId, disposition: 'already_settled' });
  });

  test.each<[string, string, boolean, number]>([
    ['malformed JSON', '{', false, 1007],
    ['binary frame', '{}', true, 1003],
    ['invalid response shape', '{"kind":"request","requestId":"x"}', false, 1008],
  ])('closes %s at the live protocol seam', async (_name, data, binary, expectedCode) => {
    const token = await ready();
    const { socket, inbox } = connect(STUDIO_READY.peerId, token);
    await once(socket, 'open');
    await inbox.next();
    const closed = once(socket, 'close');
    socket.send(data, { binary });
    expect((await closed)[0]).toBe(expectedCode);
  });

  test('replaces an authenticated socket and closes it on app cleanup', async () => {
    const token = await ready();
    const stale = connect(STUDIO_READY.peerId, token);
    await once(stale.socket, 'open');
    await stale.inbox.next();
    const staleClosed = once(stale.socket, 'close');
    const replacement = connect(STUDIO_READY.peerId, token);
    await once(replacement.socket, 'open');
    expect((await staleClosed)[0]).toBe(1012);
    expect(await replacement.inbox.next()).toMatchObject({ kind: 'status', knownPeer: true });
    const replacementClosed = once(replacement.socket, 'close');
    await app.cleanup();
    expect((await replacementClosed)[0]).toBe(1001);
  });

  test('rejects socket capacity overflow while preserving an existing peer replacement slot', async () => {
    let firstToken = '';
    let firstSocket: WebSocket | undefined;
    for (let index = 0; index < 64; index += 1) {
      const peerId = `capacity-${index}`;
      const token = await ready(peerId);
      const { socket, inbox } = connect(peerId, token);
      await once(socket, 'open');
      await inbox.next();
      if (index === 0) {
        firstToken = token;
        firstSocket = socket;
      }
    }
    const overflowToken = await ready('overflow');
    expect(await rejected('overflow', overflowToken)).toBe(503);
    if (!firstSocket) throw new Error('expected first socket');
    const replaced = once(firstSocket, 'close');
    const replacement = connect('capacity-0', firstToken);
    await once(replacement.socket, 'open');
    expect((await replaced)[0]).toBe(1012);
    expect(await replacement.inbox.next()).toMatchObject({ kind: 'status', knownPeer: true });
  });

  test('bounds session secrets while allowing same-peer refresh and reclaim after unregister', async () => {
    const first = await ready('session-0');
    for (let index = 1; index < 256; index += 1) await ready(`session-${index}`);
    await request(server).post('/ready').send({
      ...STUDIO_READY, peerId: 'overflow', transportPeerId: 'overflow', instanceId: 'instance:overflow',
    }).expect(503);
    expect(await ready('session-0')).toBe(first);
    await request(server).post('/disconnect').send({ peerId: 'session-1' }).expect(200);
    const replacement = await ready('overflow');
    expect(replacement).not.toBe(first);
  });
});

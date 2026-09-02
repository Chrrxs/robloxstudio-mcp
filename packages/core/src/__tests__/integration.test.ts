import request from 'supertest';
import { createHttpServer, type RobloxStudioHttpApp } from '../http-server.js';
import { RobloxStudioTools } from '../tools/index.js';
import { BridgeService } from '../bridge-service.js';

interface ReadyOverrides {
  peerId?: string;
  transportPeerId?: string;
  instanceId?: string;
  role?: string;
}

function ready(overrides: ReadyOverrides = {}) {
  const peerId = overrides.peerId ?? 'peer-1';
  return {
    peerId,
    transportPeerId: overrides.transportPeerId ?? peerId,
    instanceId: 'instance:test',
    role: 'edit',
    placeId: 0,
    placeName: 'TestPlace',
    dataModelName: 'TestPlace',
    isRunning: false,
    pluginVersion: 'test-version',
    pluginVariant: 'main',
    timestamp: Date.now(),
    ...overrides,
  };
}

const TEST_SERVER_CONFIG = {
  name: 'robloxstudio-mcp',
  version: 'test-version',
  tools: [],
};

describe('Integration', () => {
  let app: RobloxStudioHttpApp;
  let bridge: BridgeService;
  let tools: RobloxStudioTools;

  beforeEach(() => {
    bridge = new BridgeService();
    tools = new RobloxStudioTools(bridge);
    app = createHttpServer(tools, bridge, undefined, TEST_SERVER_CONFIG);
  });

  afterEach(async () => {
    bridge.clearAllPendingRequests();
    await app.cleanup();
  });

  describe('Full Connection Flow', () => {
    test('complete connection lifecycle', async () => {
      let status = await request(app).get('/status').expect(200);
      expect(status.body.pluginConnected).toBe(false);
      expect(status.body.mcpServerActive).toBe(false);

      await request(app).post('/ready').send(ready()).expect(200);
      status = await request(app).get('/status').expect(200);
      expect(status.body.pluginConnected).toBe(true);

      app.setMCPServerActive(true);
      status = await request(app).get('/status').expect(200);
      expect(status.body.mcpServerActive).toBe(true);

      await request(app).post('/disconnect').send({ peerId: 'peer-1' }).expect(200);
      status = await request(app).get('/status').expect(200);
      expect(status.body.pluginConnected).toBe(false);
    });
  });

  describe('Request/Response Flow', () => {
    test('complete request/response cycle', async () => {
      await request(app).post('/ready').send(ready()).expect(200);
      app.setMCPServerActive(true);

      const responsePromise = bridge.sendRequest(
        '/api/test-endpoint',
        { testData: 'hello', value: 123 },
        'peer-1',
      );
      const delivery = bridge.claimNextRequestForTransport('peer-1', 'integration-stream');
      expect(delivery).toMatchObject({
        endpoint: '/api/test-endpoint',
        data: { testData: 'hello', value: 123 },
      });

      await request(app)
        .post('/response')
        .send({
          requestId: delivery!.requestId,
          response: { success: true, result: 'processed', echo: 'hello' },
        })
        .expect(200);

      await expect(responsePromise).resolves.toEqual({
        success: true,
        result: 'processed',
        echo: 'hello',
      });
    });

    test('error responses propagate', async () => {
      await request(app).post('/ready').send(ready()).expect(200);
      const responsePromise = bridge.sendRequest('/api/failing', {}, 'peer-1');
      responsePromise.catch(() => {});
      const delivery = bridge.claimNextRequestForTransport('peer-1', 'integration-stream');

      await request(app)
        .post('/response')
        .send({ requestId: delivery!.requestId, error: 'Operation failed: Invalid input' })
        .expect(200);

      await expect(responsePromise).rejects.toEqual('Operation failed: Invalid input');
    });
  });

  describe('Disconnect Recovery', () => {
    test('disconnect rejects pending requests and a new transport Peer resumes', async () => {
      await request(app).post('/ready').send(ready()).expect(200);
      const first = bridge.sendRequest('/api/test1', {}, 'peer-1');
      const second = bridge.sendRequest('/api/test2', {}, 'peer-1');
      first.catch(() => {});
      second.catch(() => {});
      bridge.claimNextRequestForTransport('peer-1', 'old-stream');

      await request(app).post('/disconnect').send({ peerId: 'peer-1' }).expect(200);
      await expect(first).rejects.toThrow(/disconnected/);
      await expect(second).rejects.toThrow(/disconnected/);

      await request(app).post('/ready').send(ready({ peerId: 'peer-2' })).expect(200);
      const resumed = bridge.sendRequest('/api/test3', {}, 'peer-2');
      const delivery = bridge.claimNextRequestForTransport('peer-2', 'new-stream');
      expect(delivery?.endpoint).toBe('/api/test3');

      await request(app)
        .post('/response')
        .send({ requestId: delivery!.requestId, response: { success: true } })
        .expect(200);
      await expect(resumed).resolves.toEqual({ success: true });
    });
  });

  describe('Timeout Handling', () => {
    test('request times out after 30s', async () => {
      jest.useFakeTimers();
      await request(app).post('/ready').send(ready()).expect(200);
      const responsePromise = bridge.sendRequest('/api/slow', {}, 'peer-1');
      bridge.claimNextRequestForTransport('peer-1', 'integration-stream');

      jest.advanceTimersByTime(31_000);
      await expect(responsePromise).rejects.toThrow('Request timeout');
      jest.useRealTimers();
    });
  });

  describe('Multi-Instance routing', () => {
    test('two distinct transport Peers receive only their own exact-target requests', async () => {
      await request(app).post('/ready').send(ready({
        peerId: 'peer-a',
        instanceId: 'instance:A',
      })).expect(200);
      await request(app).post('/ready').send(ready({
        peerId: 'peer-b',
        instanceId: 'instance:B',
      })).expect(200);

      const responseA = bridge.sendRequest('/api/test', { who: 'A' }, 'peer-a');
      const responseB = bridge.sendRequest('/api/test', { who: 'B' }, 'peer-b');
      const deliveryA = bridge.claimNextRequestForTransport('peer-a', 'stream-a');
      const deliveryB = bridge.claimNextRequestForTransport('peer-b', 'stream-b');
      expect(deliveryA?.data).toEqual({ who: 'A' });
      expect(deliveryB?.data).toEqual({ who: 'B' });

      await request(app).post('/response')
        .send({ requestId: deliveryA!.requestId, response: { ok: 'A' } })
        .expect(200);
      await request(app).post('/response')
        .send({ requestId: deliveryB!.requestId, response: { ok: 'B' } })
        .expect(200);
      await expect(responseA).resolves.toEqual({ ok: 'A' });
      await expect(responseB).resolves.toEqual({ ok: 'B' });
    });
  });
});
